// The stores: the Redis log's compaction (#126), and backing a Sphere up and
// moving it between the file store and Redis (#142). Two and more relay
// processes on one fake Upstash; exports and imports as `node server.mjs
// --export | --import`. `npm test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startFakeUpstash } from './fake-upstash.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const KEY = 'join-key-store-0123456789abc';
const ADMIN = 'admin-key-store-0123456789abc';
const RETAIN = 10;
const sha = (x) => createHash('sha256').update(x).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

let fake;
let tmp;
const procs = new Set();

before(async () => {
  tmp = fs.mkdtempSync(path.join(tmpdir(), 'sphere-store-'));
  fake = await startFakeUpstash({ latencyMs: 2 });
});

after(async () => {
  for (const p of procs) p.kill();
  await fake?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const redisEnv = (prefix) => ({ SPHERE_STORE: 'redis', UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, SPHERE_REDIS_PREFIX: prefix });
const fsEnv = (dir) => ({ SPHERE_STORE: 'fs', SPHERE_DATA: dir });
const baseEnv = () => ({ ...process.env, OBYSPHERE_HOME: path.join(tmp, 'home'), SPHERE_SEALED: '0', SPHERE_POLL_MS: '150', SPHERE_WRITES_PER_MIN: '100000', SPHERE_ASKS_PER_MIN: '100000' });

// a relay process; resolves with its base URL once it answers, and a stop()
async function relay(env) {
  const port = await freePort();
  const p = spawn(process.execPath, [SERVER, '--port', String(port), '--host', '127.0.0.1'], { env: { ...baseEnv(), ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  procs.add(p);
  let errs = '';
  p.stderr.on('data', (d) => (errs += d));
  const exited = new Promise((r) => p.on('exit', r));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + '/healthz')).ok) {
        const stop = async () => {
          p.kill();
          await exited;
          procs.delete(p);
        };
        return { base, stop, errs: () => errs };
      }
    } catch {}
    if (p.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error(`a relay did not start: ${errs}`);
}

// `node server.mjs <args>`: an export or import, run to its end
function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SERVER, ...args], { env: { ...baseEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let errs = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (errs += d));
    p.on('exit', (code) => resolve({ code, out, errs }));
  });
}

const call = async (base, method, url, { token, key, admin, body } = {}) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['x-sphere-key'] = key;
  if (admin) headers['x-admin-key'] = admin;
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
};

async function until(fn, ms = 8000) {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t > ms) return v;
    await sleep(100);
  }
}

// what the console shows, to compare two Spheres by
async function numbers(base) {
  const [st, ag, au] = await Promise.all([call(base, 'GET', '/api/stats', { key: KEY }), call(base, 'GET', '/api/agents', { key: KEY }), call(base, 'GET', '/api/audit?limit=1', { key: KEY })]);
  const { online, working, ...counts } = st.counts;
  const agents = Object.fromEntries(ag.agents.map((a) => [a.name, { ...a.stats, removed: !!a.removed, suspended: a.suspended }]));
  return { counts, agents, head: au.head, total: au.total };
}

async function chainOk(base) {
  const au = await call(base, 'GET', '/api/audit?limit=1000', { key: KEY });
  assert.equal(au.verified, true, 'the audit chain verifies');
  const seqs = au.events.map((e) => e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => seqs[0] + i), 'no gaps, no forks');
  assert.equal(au.head.seq, au.total, 'every event, once');
  return au;
}

const snapshotOf = (prefix) => {
  const ptr = JSON.parse(fake.kv.get(prefix + 'snap').v);
  return { ptr, entries: fake.kv.get(prefix + 'snap:' + ptr.id).v.map((s) => JSON.parse(s)) };
};

// ---------------------------------------------------------------- #126: compaction

const C = 'c:'; // the compaction Sphere's prefix
let A, B, behind; // two writers, and an instance that sleeps through compactions
let alice, bob;
const allIds = [];

test('compaction while two relays write to one Redis', async () => {
  // a Sphere that keeps 10 messages, so compaction drops some
  fake.kv.set(C + 'log', {
    type: 'list',
    exp: 0,
    v: [JSON.stringify({ t: 'init', sphere: { name: 'Compacted', keyHash: sha(KEY), adminKeyHash: sha(ADMIN), createdAt: new Date().toISOString() }, policy: { retainMessages: RETAIN, sealed: false }, paused: false })],
  });
  const env = { ...redisEnv(C), SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_COMPACT_EVERY: '40' };
  [A, B, behind] = await Promise.all([relay(env), relay(env), relay(env)]);
  alice = await call(A.base, 'POST', '/api/join', { body: { key: KEY, name: 'alice', owner: 'Alice' } });
  bob = await call(B.base, 'POST', '/api/join', { body: { key: KEY, name: 'bob', owner: 'Bob' } });
  assert.ok(alice.token && bob.token);
  assert.equal((await call(behind.base, 'GET', '/api/info', { token: alice.token })).me.name, 'alice', 'the third instance is at this position, then sleeps');

  // asks, claimed and answered across the two instances (one after another: with 10
  // messages kept, an ask could be folded away before it's answered), then posts from both at once
  for (let i = 0; i < 12; i++) {
    const [one, two] = i % 2 ? [A.base, B.base] : [B.base, A.base];
    const q = await call(one, 'POST', '/api/messages', { token: alice.token, body: { text: `question ${i}`, to: ['bob'] } });
    assert.equal(q.status, 200, JSON.stringify(q));
    const c = await call(two, 'POST', `/api/messages/${q.message.id}/claim`, { token: bob.token, body: { instance: 'p1' } });
    assert.equal(c.ok, true, JSON.stringify(c));
    await call(one, 'POST', '/api/status', { token: bob.token, body: { state: 'working', about: q.message.id } });
    const r = await call(two, 'POST', '/api/messages', { token: bob.token, body: { text: `answer ${i}`, replyTo: q.message.id, meta: { durationMs: 1000 + i } } });
    assert.equal(r.status, 200, JSON.stringify(r));
    allIds.push(q.message.id, r.message.id);
  }
  const writes = [];
  for (let i = 0; i < 40; i++) {
    writes.push(call(A.base, 'POST', '/api/messages', { token: alice.token, body: { text: `a${i}` } }).then((r) => (assert.equal(r.status, 200), allIds.push(r.message.id))));
    writes.push(call(B.base, 'POST', '/api/messages', { token: bob.token, body: { text: `b${i}` } }).then((r) => (assert.equal(r.status, 200), allIds.push(r.message.id))));
  }
  await Promise.all(writes);
  // compaction runs after a sync, in the background; a few more reads let it finish
  const compacted = await until(async () => {
    await Promise.all([call(A.base, 'GET', '/api/info', { key: KEY }), call(B.base, 'GET', '/api/info', { key: KEY })]);
    return Number(fake.kv.get(C + 'base')?.v || 0) > 0;
  });
  assert.ok(compacted, 'the log was compacted');
  const { ptr, entries } = snapshotOf(C);
  assert.equal(Number(fake.kv.get(C + 'base').v), ptr.pos, 'base is the snapshot position');
  assert.equal(entries.length, ptr.count);
  assert.equal(entries.filter(([, op]) => op.t === 'msg').length, RETAIN, 'the snapshot keeps retainMessages messages');
  const seqs = entries.filter(([, op]) => op.t === 'audit').map(([, op]) => op.e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'every audit event from the first is in the snapshot');
  assert.equal(entries.at(-1)[1].t, 'tally', 'the counts travel with the snapshot');
  assert.ok(!JSON.stringify(entries).includes(KEY) && !JSON.stringify(entries).includes(ADMIN), 'no key in plain text');

  const [ca, cb] = await Promise.all([chainOk(A.base), chainOk(B.base)]);
  assert.deepEqual(ca.head, cb.head);
  assert.deepEqual(await numbers(A.base), await numbers(B.base), 'both writers show the same numbers');
});

test('a behind instance catches up across a compaction, applying nothing twice', async () => {
  // it last applied a position long since folded into the snapshot
  assert.ok(Number(fake.kv.get(C + 'base').v) > 10);
  await chainOk(behind.base);
  assert.deepEqual(await numbers(behind.base), await numbers(A.base));
  const [mb, ma] = await Promise.all([call(behind.base, 'GET', `/api/messages?limit=${RETAIN}`, { key: KEY }), call(A.base, 'GET', `/api/messages?limit=${RETAIN}`, { key: KEY })]);
  assert.deepEqual(mb.messages, ma.messages);
  const all = await call(behind.base, 'GET', '/api/messages?limit=1000', { key: KEY });
  assert.equal(new Set(all.messages.map((m) => m.id)).size, all.messages.length, 'no message twice');
});

test('a cold start from the compacted log: retention, counts, a verified chain, and writes go on', async () => {
  const D = await relay({ ...redisEnv(C), SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_COMPACT_EVERY: '40' });
  await chainOk(D.base); // with "content" checked for every message it holds
  assert.deepEqual(await numbers(D.base), await numbers(A.base), 'the same numbers as an instance that saw it all');
  const held = (await call(D.base, 'GET', '/api/messages?limit=1000', { key: KEY })).messages;
  assert.ok(held.length < allIds.length, 'messages past retainMessages were folded away');
  assert.ok(held.length >= RETAIN);
  const gone = allIds.find((id) => !held.some((m) => m.id === id));
  assert.equal((await call(D.base, 'GET', `/api/messages/${gone}`, { key: KEY })).status, 404);
  const au = await call(D.base, 'GET', '/api/audit?limit=1000', { key: KEY });
  assert.ok(au.events.some((e) => e.ref === gone && e.content), "a dropped message's audit event stays");
  // the cold instance writes on the same chain, and the others see it
  const r = await call(D.base, 'POST', '/api/messages', { token: alice.token, body: { text: 'from the cold one' } });
  assert.equal(r.status, 200);
  assert.ok(await until(async () => (await call(B.base, 'GET', `/api/messages/${r.message.id}`, { key: KEY })).status === 200));
  await Promise.all([chainOk(A.base), chainOk(B.base), chainOk(D.base)]);
  await D.stop();
});

test('two instances compacting at once: one wins, nothing is lost or doubled', async () => {
  // both see a tail past the threshold at the same moment
  const writes = [];
  for (let i = 0; i < 30; i++) writes.push(call(i % 2 ? A.base : B.base, 'POST', '/api/messages', { token: i % 2 ? alice.token : bob.token, body: { text: `more ${i}` } }));
  assert.ok((await Promise.all(writes)).every((r) => r.status === 200));
  const before = Number(fake.kv.get(C + 'base').v);
  await until(async () => {
    await Promise.all([call(A.base, 'GET', '/api/info', { key: KEY }), call(B.base, 'GET', '/api/info', { key: KEY })]);
    return Number(fake.kv.get(C + 'base').v) > before;
  });
  // only the current snapshot is kept; the one it replaced expires
  const lists = [...fake.kv.keys()].filter((k) => k.startsWith(C + 'snap:'));
  const { ptr } = snapshotOf(C);
  for (const k of lists) if (k !== C + 'snap:' + ptr.id) assert.ok(fake.kv.get(k).exp > 0, 'an old or losing snapshot list expires');
  const [ca, cb, cc] = await Promise.all([chainOk(A.base), chainOk(B.base), chainOk(behind.base)]);
  assert.deepEqual(ca.head, cb.head);
  assert.deepEqual(ca.head, cc.head);
  assert.deepEqual(await numbers(behind.base), await numbers(A.base));
});

// ---------------------------------------------------------------- #142: back up and move

let src; // the file store Sphere we start from
let srcNumbers;
const fileBytes = Buffer.from('a file that moves with its Sphere\n');
let fileId;

const dirs = {};
const dir = (name) => (dirs[name] ??= fs.mkdtempSync(path.join(tmp, name + '-')));
const file = (name) => path.join(tmp, name + '.jsonl');
const keyEnv = { SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN };

// a Sphere moved here must work as the one it came from
async function sameSphere(base, want) {
  // (a wrong credential would be a denial, counted: these all succeed or refuse without one)
  assert.equal((await call(base, 'GET', '/api/info', { token: alice.token })).me.name, 'alice', "a member's token still works");
  assert.equal((await call(base, 'GET', '/api/admin/check', { admin: ADMIN })).ok, true, 'the admin key works');
  // the join key is accepted (a handle in use answers 409; a wrong key would be 401), and handles stay taken
  assert.equal((await call(base, 'POST', '/api/join', { body: { key: KEY, name: 'alice' } })).code, 'name_taken', 'the join key works');
  assert.equal((await call(base, 'POST', '/api/join', { body: { key: KEY, name: 'carol' } })).code, 'name_taken', "a removed member's handle stays taken");
  await chainOk(base);
  const got = await numbers(base);
  assert.deepEqual(got.counts, want.counts, "the console's numbers match");
  assert.deepEqual(got.agents, want.agents);
  const down = Buffer.from(await (await fetch(`${base}/api/files/${fileId}`, { headers: { 'x-sphere-key': KEY } })).arrayBuffer());
  assert.deepEqual(down, fileBytes, 'files move with it');
  const ask = (await call(base, 'GET', '/api/messages?limit=1000', { key: KEY })).messages.find((m) => m.kind === 'ask');
  assert.ok(ask.claimedAt && ask.startedAt, 'timings move too');
}

test('a file store Sphere exports while it runs, without touching its folder', async () => {
  src = await relay({ ...fsEnv(dir('src')), ...keyEnv });
  alice = await call(src.base, 'POST', '/api/join', { body: { key: KEY, name: 'alice', owner: 'Alice' } });
  bob = await call(src.base, 'POST', '/api/join', { body: { key: KEY, name: 'bob', owner: 'Bob' } });
  const carol = await call(src.base, 'POST', '/api/join', { body: { key: KEY, name: 'carol', owner: 'Carol' } });
  const q = (await call(src.base, 'POST', '/api/messages', { token: alice.token, body: { text: 'what blocks v2?', to: ['bob'] } })).message;
  await call(src.base, 'POST', `/api/messages/${q.id}/claim`, { token: bob.token, body: { instance: 'x' } });
  await call(src.base, 'POST', '/api/status', { token: bob.token, body: { state: 'working', about: q.id } });
  await call(src.base, 'POST', '/api/messages', { token: bob.token, body: { text: 'receipts', replyTo: q.id, meta: { durationMs: 4200 } } });
  const up = await (await fetch(`${src.base}/api/files`, { method: 'POST', headers: { authorization: `Bearer ${alice.token}`, 'x-file-name': 'notes.txt', 'content-type': 'text/plain' }, body: fileBytes })).json();
  fileId = up.file.id;
  await call(src.base, 'POST', '/api/messages', { token: alice.token, body: { text: 'see the notes', files: [{ id: fileId }], channel: 'kite' } });
  await call(src.base, 'POST', `/api/admin/agents/${bob.agent.id}/suspend`, { admin: ADMIN, body: { suspended: true } });
  await call(src.base, 'POST', `/api/admin/agents/${bob.agent.id}/suspend`, { admin: ADMIN, body: { suspended: false } });
  await call(src.base, 'DELETE', `/api/admin/agents/${carol.agent.id}`, { admin: ADMIN });
  await call(src.base, 'GET', '/api/agents', { key: 'a-wrong-key-that-is-long-enough' }); // a denial, counted
  await sleep(1200); // sphere.json is written within a second
  srcNumbers = await numbers(src.base);

  const folder = dir('src');
  const stat = () => fs.readdirSync(folder).map((f) => [f, fs.statSync(path.join(folder, f)).mtimeMs, fs.statSync(path.join(folder, f)).size]);
  const was = stat();
  const r = await run(['--export', file('from-fs')], { ...fsEnv(folder), SPHERE_ADMIN_KEY: ADMIN });
  assert.equal(r.code, 0, r.errs);
  assert.match(r.out, /Exported/);
  assert.match(r.out, /chain verified/);
  assert.deepEqual(stat(), was, 'the running Sphere\'s folder is untouched');
  assert.equal(fs.statSync(file('from-fs')).mode & 0o777, 0o600, 'only its owner can read it');
  const text = fs.readFileSync(file('from-fs'), 'utf8');
  assert.ok(!text.includes(KEY) && !text.includes(ADMIN) && !text.includes(alice.token), 'no key or token in plain text');
  const lines = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].format, 'obysphere-backup');
  assert.equal(lines[0].version, 1);
  assert.equal(lines.at(-1).end, true);
  assert.equal(lines.filter((l) => l.file).length, 1);
  // a second export to the same name is refused, not overwritten
  assert.equal((await run(['--export', file('from-fs')], { ...fsEnv(folder), SPHERE_ADMIN_KEY: ADMIN })).code, 1);
  await src.stop();
});

test('fs -> fs: the imported Sphere starts and works as the old one', async () => {
  const r = await run(['--import', file('from-fs')], { ...fsEnv(dir('fs2')), SPHERE_ADMIN_KEY: ADMIN });
  assert.equal(r.code, 0, r.errs);
  assert.match(r.out, /Imported/);
  for (const f of ['sphere.json', 'messages.jsonl', 'audit.jsonl']) assert.equal(fs.statSync(path.join(dir('fs2'), f)).mode & 0o777, 0o600);
  const s = await relay({ ...fsEnv(dir('fs2')), SPHERE_ADMIN_KEY: ADMIN }); // the join key is the stored one
  await sameSphere(s.base, srcNumbers);
  await s.stop();
});

test('fs -> redis: the same Sphere on Redis, its file limits brought down on the record', async () => {
  const r = await run(['--import', file('from-fs')], { ...redisEnv('b1:'), SPHERE_ADMIN_KEY: ADMIN });
  assert.equal(r.code, 0, r.errs);
  const s = await relay({ ...redisEnv('b1:'), ...keyEnv });
  await sameSphere(s.base, srcNumbers);
  const info = await call(s.base, 'GET', '/api/info', { key: KEY });
  assert.equal(info.sphere.policy.maxFileBytes, 512 * 1024);
  const au = await call(s.base, 'GET', '/api/audit?limit=1', { key: KEY });
  assert.match(au.events[0].detail, /moved to the Redis store/);
  await s.stop();
});

test('redis -> fs, and the round trip fs -> redis -> fs', async () => {
  const x = await run(['--export', file('from-redis')], { ...redisEnv('b1:'), SPHERE_ADMIN_KEY: ADMIN });
  assert.equal(x.code, 0, x.errs);
  assert.equal(fs.statSync(file('from-redis')).mode & 0o777, 0o600);
  const r = await run(['--import', file('from-redis')], { ...fsEnv(dir('fs3')), SPHERE_ADMIN_KEY: ADMIN });
  assert.equal(r.code, 0, r.errs);
  const s = await relay({ ...fsEnv(dir('fs3')), SPHERE_ADMIN_KEY: ADMIN });
  await sameSphere(s.base, srcNumbers); // back where it started, with one more audit event: the move to Redis
  const au = await call(s.base, 'GET', '/api/audit?limit=1000', { key: KEY });
  assert.equal(au.total, srcNumbers.total + 1);
  await s.stop();
});

test('redis -> redis', async () => {
  const r = await run(['--import', file('from-redis')], { ...redisEnv('b2:'), SPHERE_ADMIN_KEY: ADMIN });
  assert.equal(r.code, 0, r.errs);
  const s = await relay({ ...redisEnv('b2:'), ...keyEnv });
  await sameSphere(s.base, srcNumbers);
  await s.stop();
});

test('a compacted Redis Sphere exports one position: snapshot and tail, counts included', async () => {
  const want = await numbers(A.base);
  const x = await run(['--export', file('compacted')], { ...redisEnv(C), SPHERE_ADMIN_KEY: ADMIN });
  assert.equal(x.code, 0, x.errs);
  const r = await run(['--import', file('compacted')], { ...fsEnv(dir('fs4')), SPHERE_ADMIN_KEY: ADMIN });
  assert.equal(r.code, 0, r.errs);
  const s = await relay({ ...fsEnv(dir('fs4')), SPHERE_ADMIN_KEY: ADMIN });
  const au = await chainOk(s.base);
  assert.deepEqual(au.head, want.head, 'the whole chain, to the same head');
  // the file store keeps its newest retainMessages too: the same ones
  const ma = (await call(A.base, 'GET', '/api/messages?limit=1000', { key: KEY })).messages.slice(-RETAIN);
  const ms = (await call(s.base, 'GET', '/api/messages?limit=1000', { key: KEY })).messages;
  assert.deepEqual(ms, ma);
  assert.deepEqual((await numbers(s.base)).counts, want.counts, 'the counts of messages folded away travel too');
  await s.stop();
  for (const x of [A, B, behind]) await x.stop();
});

test('an import refuses a wrong admin key, a changed or cut-short file, and a store that holds a Sphere', async () => {
  const empty = dir('refused');
  const nothing = () => assert.deepEqual(fs.readdirSync(empty), [], 'nothing was written');
  const imp = (f, env = {}) => run(['--import', f], { ...fsEnv(empty), SPHERE_ADMIN_KEY: ADMIN, ...env });

  let r = await imp(file('from-fs'), { SPHERE_ADMIN_KEY: 'another-admin-key-0123456789' });
  assert.equal(r.code, 1);
  assert.match(r.errs, /admin key isn't the one/);
  nothing();

  r = await run(['--import', file('from-fs'), '--admin-key', ADMIN], { ...fsEnv(empty), SPHERE_ADMIN_KEY: '' });
  assert.equal(r.code, 1);
  assert.match(r.errs, /not on the command line/);

  const lines = fs.readFileSync(file('from-fs'), 'utf8').trimEnd().split('\n');
  const write = (name, ls) => (fs.writeFileSync(file(name), ls.join('\n') + '\n'), file(name));
  // the MAC an attacker without the admin key can't make; with it, the chain still catches a change
  const reseal = (ls) => {
    const k = createHmac('sha256', ADMIN).update('obysphere/backup/v1').digest();
    const mac = createHmac('sha256', k);
    for (const l of ls.slice(0, -1)) mac.update(l + '\n');
    return [...ls.slice(0, -1), JSON.stringify({ ...JSON.parse(ls.at(-1)), mac: mac.digest('hex') })];
  };
  const msgAt = lines.findIndex((l) => l.includes('"what blocks v2?"'));
  const changed = lines.map((l, i) => (i === msgAt ? l.replace('what blocks v2?', 'what blocks v3?') : l));
  r = await imp(write('changed', changed));
  assert.equal(r.code, 1);
  assert.match(r.errs, /changed after it was written/);
  nothing();

  r = await imp(write('changed-resealed', reseal(changed)));
  assert.equal(r.code, 1);
  assert.match(r.errs, /doesn't match its audit event/);
  nothing();

  const evAt = lines.findIndex((l) => l.includes('"type":"join"'));
  r = await imp(write('chain', reseal(lines.map((l, i) => (i === evAt ? l.replace('"type":"join"', '"type":"post"') : l)))));
  assert.equal(r.code, 1);
  assert.match(r.errs, /audit chain doesn't verify/);
  nothing();

  r = await imp(write('short', lines.slice(0, -2)));
  assert.equal(r.code, 1);
  assert.match(r.errs, /cut short/);
  nothing();

  r = await run(['--import', file('from-fs')], { ...fsEnv(dir('fs2')), SPHERE_ADMIN_KEY: ADMIN });
  assert.equal(r.code, 1);
  assert.match(r.errs, /already holds a Sphere/);
  const log = fake.kv.get('b1:snap').v;
  r = await run(['--import', file('from-fs')], { ...redisEnv('b1:'), SPHERE_ADMIN_KEY: ADMIN });
  assert.equal(r.code, 1);
  assert.match(r.errs, /already holds a Sphere/);
  assert.equal(fake.kv.get('b1:snap').v, log, 'the Redis Sphere is as it was');

  r = await run(['--export', file('nothing')], { ...fsEnv(empty), SPHERE_ADMIN_KEY: ADMIN });
  assert.equal(r.code, 1);
  assert.match(r.errs, /no Sphere/);
  nothing();
});
