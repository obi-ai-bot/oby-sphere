// Compaction (#126): the Redis log's head folded into a snapshot, so cold starts
// stay fast, with every instance applying each operation once and the audit chain
// whole; 0.3's state (admins, private channels and their members, direct
// conversations) through a snapshot; the guard against relays that don't know
// about compaction; and the file store's tally across a restart. Several relay
// processes on one fake Upstash. `npm test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startFakeUpstash } from './fake-upstash.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const KEY = 'join-key-compact-0123456789ab';
const ADMIN = 'admin-key-compact-0123456789ab';
const RETAIN = 10;
const sha = (x) => createHash('sha256').update(x).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

let fake;
let tmp;
const procs = new Set();

before(async () => {
  tmp = fs.mkdtempSync(path.join(tmpdir(), 'sphere-compact-'));
  fake = await startFakeUpstash({ latencyMs: 2 });
});

after(async () => {
  for (const p of procs) p.kill();
  await fake?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// (SPHERE_COMPACT_WAIT_MS=0: compaction may start at once, not an hour after the first start)
const redisEnv = (prefix, every = '40', wait = '0') => ({ SPHERE_STORE: 'redis', UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, SPHERE_REDIS_PREFIX: prefix, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_COMPACT_EVERY: every, SPHERE_COMPACT_WAIT_MS: wait });
const baseEnv = () => ({
  ...process.env,
  HOME: path.join(tmp, 'home'),
  OBYSPHERE_HOME: path.join(tmp, 'oby'),
  OBYSPHERE_APP_HOME: path.join(tmp, 'app'),
  SPHERE_SEALED: '0',
  SPHERE_POLL_MS: '150',
  SPHERE_WRITES_PER_MIN: '100000',
  SPHERE_ASKS_PER_MIN: '100000',
});

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

// a command straight to the fake, as any Redis client would send it
const redis = async (cmd) => (await fetch(fake.url, { method: 'POST', headers: { authorization: `Bearer ${fake.token}` }, body: JSON.stringify(cmd) })).json();

async function until(fn, ms = 8000) {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t > ms) return v;
    await sleep(100);
  }
}

// what the console shows, to compare two instances by
async function numbers(base) {
  const [st, ag, au] = await Promise.all([call(base, 'GET', '/api/stats', { key: KEY }), call(base, 'GET', '/api/agents', { key: KEY }), call(base, 'GET', '/api/audit?limit=1', { key: KEY })]);
  const { online, working, ...counts } = st.counts;
  const agents = Object.fromEntries(ag.agents.map((a) => [a.name, { ...a.stats, removed: !!a.removed, suspended: a.suspended, admin: a.admin }]));
  return { counts, agents, head: au.head, total: au.total };
}

// the state itself: every member as the relay shows it, every channel (the admin sees them all), the policy.
// (lastSeen is each instance's own: any request it serves moves it, as in 0.3.)
async function state(base) {
  const [ag, ch, info] = await Promise.all([call(base, 'GET', '/api/agents', { admin: ADMIN }), call(base, 'GET', '/api/channels', { admin: ADMIN }), call(base, 'GET', '/api/info', { admin: ADMIN })]);
  const agents = ag.agents.map(({ lastSeen, ...a }) => a);
  return { agents, channels: ch.channels, paused: info.sphere.paused, policy: info.sphere.policy, members: info.sphere.agents };
}

async function chainOk(base) {
  const au = await call(base, 'GET', '/api/audit?limit=1000', { key: KEY });
  assert.equal(au.verified, true, 'the audit chain verifies');
  const seqs = au.events.map((e) => e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => seqs[0] + i), 'no gaps, no forks');
  assert.equal(seqs[0], 1, 'from its first event');
  assert.equal(au.head.seq, au.total, 'every event, once');
  return au;
}

const snapshotOf = (prefix) => {
  const ptr = JSON.parse(fake.kv.get(prefix + 'snap').v);
  return { ptr, entries: fake.kv.get(prefix + 'snap:' + ptr.id).v.map((s) => JSON.parse(s)) };
};
const baseOf = (prefix) => Number(fake.kv.get(prefix + 'base')?.v || 0);

// a Sphere seeded with its init operation, keeping `retain` messages
const seed = (prefix, retain = RETAIN) =>
  fake.kv.set(prefix + 'log', {
    type: 'list',
    exp: 0,
    v: [JSON.stringify({ t: 'init', sphere: { name: 'Compacted', keyHash: sha(KEY), adminKeyHash: sha(ADMIN), createdAt: new Date().toISOString() }, policy: { retainMessages: retain, sealed: false }, paused: false })],
  });

// ---------------------------------------------------------------- the fake, as Redis

test("the fake keeps a list's expiry across pushes, trims lists and renames keys, as Redis does", async () => {
  await redis(['RPUSH', 'ttl:list', 'a']);
  await redis(['EXPIRE', 'ttl:list', '3600']);
  await redis(['RPUSH', 'ttl:list', 'b', 'c']);
  assert.ok(fake.kv.get('ttl:list').exp > 0, 'a push keeps the expiry');
  assert.equal((await redis(['PERSIST', 'ttl:list'])).result, 1);
  assert.equal(fake.kv.get('ttl:list').exp, 0);
  await redis(['LTRIM', 'ttl:list', '1', '-1']);
  assert.deepEqual((await redis(['LRANGE', 'ttl:list', '0', '-1'])).result, ['b', 'c']);
  await redis(['RENAME', 'ttl:list', 'ttl:moved']);
  assert.equal((await redis(['EXISTS', 'ttl:list', 'ttl:moved'])).result, 1);
  await redis(['LTRIM', 'ttl:moved', '5', '-1']);
  assert.equal((await redis(['EXISTS', 'ttl:moved'])).result, 0, 'an emptied list is gone');
});

// ---------------------------------------------------------------- Redis: compaction across instances

const C = 'c:'; // the compaction Sphere's prefix
let A, B, behind; // two writers, and an instance that sleeps through compactions
const ag = {}; // handle -> { token, agent }
const tok = (n) => ag[n].token;
const allIds = [];
let dm; // alice and bob's direct conversation

test("0.3's state, then compaction while two relays write to one Redis", async () => {
  seed(C);
  [A, B, behind] = await Promise.all([relay(redisEnv(C)), relay(redisEnv(C)), relay(redisEnv(C))]);
  for (const [n, at] of [['alice', A], ['bob', B], ['carol', A], ['dave', B], ['erin', A]]) {
    ag[n] = await call(at.base, 'POST', '/api/join', { body: { key: KEY, name: n, owner: n[0].toUpperCase() + n.slice(1) } });
    assert.ok(ag[n].token, JSON.stringify(ag[n]));
  }
  assert.equal((await call(behind.base, 'GET', '/api/info', { token: tok('alice') })).me.name, 'alice', 'the third instance is at this position, then sleeps');

  // admins: alice claims it, makes carol one, carol is removed (no admin then); dave is suspended
  assert.equal((await call(A.base, 'POST', '/api/admin/claim', { token: tok('alice'), admin: ADMIN })).status, 200);
  assert.equal((await call(B.base, 'POST', `/api/admin/agents/${ag.carol.agent.id}/role`, { token: tok('alice'), body: { admin: true } })).agent.admin, true);
  assert.equal((await call(A.base, 'DELETE', `/api/admin/agents/${ag.carol.agent.id}`, { admin: ADMIN })).status, 200);
  assert.equal((await call(B.base, 'POST', `/api/admin/agents/${ag.dave.agent.id}/suspend`, { token: tok('alice'), body: { suspended: true } })).status, 200);
  assert.equal((await call(A.base, 'POST', '/api/admin/policy', { token: tok('alice'), body: { maxDepth: 4 } })).status, 200);
  // a private channel whose members change, a public one, and a direct conversation
  assert.equal((await call(A.base, 'POST', '/api/channels', { token: tok('alice'), body: { name: 'design', topic: 'Pixels', private: true, members: ['bob', 'erin'] } })).status, 200);
  assert.deepEqual((await call(B.base, 'POST', '/api/channels/design/members', { token: tok('bob'), body: { remove: ['erin'] } })).channel.members.sort(), [ag.alice.agent.id, ag.bob.agent.id].sort());
  assert.equal((await call(B.base, 'POST', '/api/channels', { token: tok('bob'), body: { name: 'lobby' } })).status, 200);
  dm = (await call(A.base, 'POST', '/api/dm', { token: tok('alice'), body: { with: 'bob' } })).channel;
  assert.equal(dm.kind, 'dm');
  assert.equal((await call(B.base, 'POST', '/api/messages', { token: tok('bob'), body: { text: 'just us', channel: dm.name } })).status, 200);
  assert.equal((await call(A.base, 'POST', '/api/messages', { token: tok('alice'), body: { text: 'members only', channel: 'design' } })).status, 200);

  // asks, claimed and answered across the two instances (one after another: with 10
  // messages kept, an ask could be folded away before it's answered), then posts from both at once
  for (let i = 0; i < 12; i++) {
    const [one, two] = i % 2 ? [A.base, B.base] : [B.base, A.base];
    const where = i % 3 ? {} : { channel: 'design' };
    const q = await call(one, 'POST', '/api/messages', { token: tok('alice'), body: { text: `question ${i}`, to: ['bob'], ...where } });
    assert.equal(q.status, 200, JSON.stringify(q));
    const c = await call(two, 'POST', `/api/messages/${q.message.id}/claim`, { token: tok('bob'), body: { instance: 'p1' } });
    assert.equal(c.ok, true, JSON.stringify(c));
    await call(one, 'POST', '/api/status', { token: tok('bob'), body: { state: 'working', about: q.message.id } });
    const r = await call(two, 'POST', '/api/messages', { token: tok('bob'), body: { text: `answer ${i}`, replyTo: q.message.id, meta: { durationMs: 1000 + i }, ...where } });
    assert.equal(r.status, 200, JSON.stringify(r));
    allIds.push(q.message.id, r.message.id);
  }
  const writes = [];
  for (let i = 0; i < 40; i++) {
    writes.push(call(A.base, 'POST', '/api/messages', { token: tok('alice'), body: { text: `a${i}` } }).then((r) => (assert.equal(r.status, 200), allIds.push(r.message.id))));
    writes.push(call(B.base, 'POST', '/api/messages', { token: tok('bob'), body: { text: `b${i}`, ...(i % 5 ? {} : { channel: dm.name }) } }).then((r) => (assert.equal(r.status, 200), allIds.push(r.message.id))));
  }
  await Promise.all(writes);
  // compaction runs after a sync, in the background; a few more reads let it finish
  const compacted = await until(async () => {
    await Promise.all([call(A.base, 'GET', '/api/info', { key: KEY }), call(B.base, 'GET', '/api/info', { key: KEY })]);
    return baseOf(C) > 0;
  });
  assert.ok(compacted, 'the log was compacted');
  const { ptr, entries } = snapshotOf(C);
  assert.equal(baseOf(C), ptr.pos, 'base is the snapshot position');
  assert.equal(entries.length, ptr.count);
  assert.equal(entries.filter(([, op]) => op.t === 'msg').length, RETAIN, 'the snapshot keeps retainMessages messages');
  const seqs = entries.filter(([, op]) => op.t === 'audit').map(([, op]) => op.e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'every audit event from the first is in the snapshot');
  assert.equal(entries.at(-1)[1].t, 'tally', 'the counts travel with the snapshot');
  assert.ok(!JSON.stringify(entries).includes(KEY) && !JSON.stringify(entries).includes(ADMIN), 'no key in plain text');
  for (const n of Object.keys(ag)) assert.ok(!JSON.stringify(entries).includes(tok(n)), 'no token in plain text');
  // each record once, as it is now
  const ops = entries.map(([, op]) => op);
  assert.deepEqual(ops.filter((o) => o.t === 'role').map((o) => [o.id, o.admin]).sort(), [[ag.alice.agent.id, true], [ag.carol.agent.id, false]].sort());
  const design = ops.filter((o) => o.t === 'channel' && o.ch.name === 'design');
  assert.equal(design.length, 1);
  assert.equal(design[0].ch.kind, 'private');
  assert.deepEqual(design[0].ch.members.sort(), [ag.alice.agent.id, ag.bob.agent.id].sort());
  assert.equal(ops.filter((o) => o.t === 'agent' && o.a.id === ag.carol.agent.id).length, 1);
  // positions: each entry carries the position of the operation it stands for, all before the snapshot's
  assert.ok(entries.every(([p]) => Number.isInteger(p) && p >= 0 && p < ptr.pos));
  // three relays started at once wrote one mark that a relay which compacts is here, and the snapshot keeps it
  assert.equal(ops.filter((o) => o.t === 'compaction').length, 1);
  assert.equal(fake.kv.get(C + 'tail').v.map((s) => JSON.parse(s)).filter((o) => o.t === 'compaction').length, 0);

  const [ca, cb] = await Promise.all([chainOk(A.base), chainOk(B.base)]);
  assert.deepEqual(ca.head, cb.head);
  assert.deepEqual(await numbers(A.base), await numbers(B.base), 'both writers show the same numbers');
  assert.deepEqual(await state(A.base), await state(B.base), 'and the same state');
});

test('the first compaction moves the log, so a relay that knows nothing of base fails instead of misreading it', async () => {
  // 0.3 and before read and append at <prefix>log, counting positions from the list's head
  assert.equal(fake.kv.get(C + 'log').type, 'string', 'the old key holds a note now');
  assert.match(fake.kv.get(C + 'log').v, /compacted/);
  assert.equal(fake.kv.get(C + 'tail').type, 'list', 'the tail is its own list');
  const old = await redis(['LRANGE', C + 'log', '0', '199']);
  assert.match(old.error, /WRONGTYPE/, "an old relay's read fails");
  const oldAppend = `-- obysphere:append\nlocal n = redis.call('LLEN', KEYS[1])\nif n ~= tonumber(ARGV[1]) then return -1 end\nfor i = 2, #ARGV do redis.call('RPUSH', KEYS[1], ARGV[i]) end\nreturn n + #ARGV - 1`;
  const len = fake.kv.get(C + 'tail').v.length;
  for (const at of [0, len, baseOf(C) + len]) {
    const r = await redis(['EVAL', oldAppend, '1', C + 'log', String(at), JSON.stringify({ t: 'msg', m: { id: 'm_old' } })]);
    assert.match(r.error, /WRONGTYPE/, "an old relay's append fails, at any position");
  }
  assert.equal(fake.kv.get(C + 'tail').v.length, len, 'nothing was appended');
});

test('a behind instance catches up across a compaction, applying nothing twice', async () => {
  // it last applied a position long since folded into the snapshot
  assert.ok(baseOf(C) > 20);
  await chainOk(behind.base);
  assert.deepEqual(await numbers(behind.base), await numbers(A.base));
  assert.deepEqual(await state(behind.base), await state(A.base));
  const [mb, ma] = await Promise.all([call(behind.base, 'GET', `/api/messages?limit=${RETAIN}`, { admin: ADMIN }), call(A.base, 'GET', `/api/messages?limit=${RETAIN}`, { admin: ADMIN })]);
  assert.deepEqual(mb.messages, ma.messages);
  const all = await call(behind.base, 'GET', '/api/messages?limit=1000', { admin: ADMIN });
  assert.equal(new Set(all.messages.map((m) => m.id)).size, all.messages.length, 'no message twice');
});

test("a cold start from the compacted log: 0.3's state exactly, retention, counts, a verified chain, and writes go on", async () => {
  const D = await relay(redisEnv(C));
  await chainOk(D.base); // with "content" checked for every message it holds
  assert.deepEqual(await numbers(D.base), await numbers(A.base), 'the same numbers as an instance that saw it all');
  assert.deepEqual(await state(D.base), await state(A.base), 'the same members, admins, channels and policy');
  const s = await state(D.base);
  const who = (n) => s.agents.find((a) => a.name === n);
  assert.equal(who('alice').admin, true);
  assert.equal(who('carol').removed, true);
  assert.equal(who('carol').admin, false);
  assert.equal(who('dave').suspended, true);
  assert.equal(s.policy.maxDepth, 4);
  assert.deepEqual(s.channels.map((c) => [c.name, c.kind]).sort(), [['design', 'private'], ['general', 'public'], ['lobby', 'public'], [dm.name, 'dm']].sort());

  // retention: messages past retainMessages were folded away, their audit events stay
  const held = (await call(D.base, 'GET', '/api/messages?limit=1000', { admin: ADMIN })).messages;
  assert.ok(held.length < allIds.length, 'messages past retainMessages were folded away');
  assert.ok(held.length >= RETAIN);
  const gone = allIds.find((id) => !held.some((m) => m.id === id));
  assert.equal((await call(D.base, 'GET', `/api/messages/${gone}`, { admin: ADMIN })).status, 404);
  const au = await call(D.base, 'GET', '/api/audit?limit=1000', { key: KEY });
  assert.ok(au.events.some((e) => e.ref === gone && e.content), "a dropped message's audit event stays");

  // the state it rebuilt governs: alice is an admin by her token alone, members only in design and the DM
  assert.equal((await call(D.base, 'GET', '/api/admin/check', { token: tok('alice') })).via, 'member');
  const inDesign = await call(D.base, 'POST', '/api/messages', { token: tok('alice'), body: { text: 'after the cold start', channel: 'design' } });
  assert.equal(inDesign.status, 200);
  assert.equal((await call(D.base, 'POST', '/api/messages', { token: tok('erin'), body: { text: 'let me in', channel: 'design' } })).code, 'not_member', 'erin was taken out of design');
  assert.equal((await call(D.base, 'POST', '/api/messages', { token: tok('erin'), body: { text: 'hi', channel: dm.name } })).code, 'not_member', "the DM is alice and bob's");
  assert.equal((await call(D.base, 'GET', `/api/messages/${inDesign.message.id}`, { token: tok('erin') })).status, 404, "erin can't read design");
  assert.equal((await call(D.base, 'GET', `/api/messages/${inDesign.message.id}`, { token: tok('bob') })).status, 200, 'bob can');
  assert.equal((await call(D.base, 'GET', '/api/messages?limit=1000', { key: KEY })).messages.filter((m) => m.channel === 'design' || m.channel === dm.name).length, 0, 'the join key alone sees no closed channel');
  assert.equal((await call(D.base, 'GET', '/api/info', { token: tok('carol') })).status, 401, "carol's token was dropped");
  assert.equal((await call(D.base, 'POST', '/api/join', { body: { key: KEY, name: 'carol' } })).code, 'name_taken', "a removed member's handle stays taken");

  // the cold instance writes on the same chain, and the others see it
  const r = await call(D.base, 'POST', '/api/messages', { token: tok('alice'), body: { text: 'from the cold one' } });
  assert.equal(r.status, 200);
  assert.ok(await until(async () => (await call(B.base, 'GET', `/api/messages/${r.message.id}`, { key: KEY })).status === 200));
  await Promise.all([chainOk(A.base), chainOk(B.base), chainOk(D.base)]);
  assert.deepEqual(await state(D.base), await state(B.base));
  await D.stop();
});

test('two instances compacting at once: one wins, nothing is lost or doubled', async () => {
  // both see a tail past the threshold at the same moment
  const before = baseOf(C);
  const { ptr: was } = snapshotOf(C);
  const writes = [];
  for (let i = 0; i < Math.max(40, was.count); i++) writes.push(call(i % 2 ? A.base : B.base, 'POST', '/api/messages', { token: i % 2 ? tok('alice') : tok('bob'), body: { text: `more ${i}` } }));
  assert.ok((await Promise.all(writes)).every((r) => r.status === 200));
  assert.ok(
    await until(async () => {
      await Promise.all([call(A.base, 'GET', '/api/info', { key: KEY }), call(B.base, 'GET', '/api/info', { key: KEY })]);
      return baseOf(C) > before;
    }),
    'compacted again',
  );
  // only the current snapshot is kept; the one it replaced expires
  const lists = [...fake.kv.keys()].filter((k) => k.startsWith(C + 'snap:'));
  const { ptr } = snapshotOf(C);
  for (const k of lists) if (k !== C + 'snap:' + ptr.id) assert.ok(fake.kv.get(k).exp > 0, 'an old or losing snapshot list expires');
  assert.equal(fake.kv.get(C + 'snap:' + ptr.id).exp, 0, 'the current one stays');
  const [ca, cb, cc] = await Promise.all([chainOk(A.base), chainOk(B.base), chainOk(behind.base)]);
  assert.deepEqual(ca.head, cb.head);
  assert.deepEqual(ca.head, cc.head);
  assert.deepEqual(await numbers(behind.base), await numbers(A.base));
  assert.deepEqual(await state(behind.base), await state(A.base));
  // and a second cold start, from the second snapshot
  const E = await relay(redisEnv(C));
  await chainOk(E.base);
  assert.deepEqual(await numbers(E.base), await numbers(A.base));
  assert.deepEqual(await state(E.base), await state(A.base));
  await E.stop();
  for (const x of [A, B, behind]) await x.stop();
});

test('a deploy from 0.3: no compaction until an hour after the first start that marks the log', async () => {
  const W = 'wait:';
  seed(W);
  // a log 0.3 wrote: it never marked it
  const r = await relay(redisEnv(W, '10', '3600000'));
  const a = await call(r.base, 'POST', '/api/join', { body: { key: KEY, name: 'alice', owner: 'Alice' } });
  for (let i = 0; i < 40; i++) assert.equal((await call(r.base, 'POST', '/api/messages', { token: a.token, body: { text: `m${i}` } })).status, 200);
  await call(r.base, 'GET', '/api/info', { key: KEY });
  await sleep(300);
  const log = () => fake.kv.get(W + 'log').v.map((s) => JSON.parse(s));
  assert.equal(fake.kv.get(W + 'log').type, 'list', 'not compacted: a 0.3 relay still reads it as it did');
  assert.equal(fake.kv.get(W + 'base'), undefined);
  const marks = log().filter((o) => o.t === 'compaction');
  assert.equal(marks.length, 1, 'one mark, at the first start');
  assert.ok(Date.parse(marks[0].since) <= Date.now());
  await r.stop();
  // a restart doesn't mark it again, or reset the wait
  const again = await relay(redisEnv(W, '10', '3600000'));
  await call(again.base, 'GET', '/api/info', { key: KEY });
  assert.equal(log().filter((o) => o.t === 'compaction').length, 1);
  await again.stop();
  // an hour on (here: a relay told to wait less than the mark's age), it compacts
  await sleep(50);
  const later = await relay(redisEnv(W, '10', '20'));
  await until(async () => (await call(later.base, 'GET', '/api/info', { key: KEY }), baseOf(W) > 0));
  assert.ok(baseOf(W) > 0, 'compacted once the mark is old enough');
  assert.equal(snapshotOf(W).entries.filter(([, op]) => op.t === 'compaction').length, 1, 'the snapshot keeps the mark');
  await chainOk(later.base);
  await later.stop();
});

test('SPHERE_COMPACT_EVERY=0: never compacted, the log stays where 0.3 reads it', async () => {
  const O = 'off:';
  seed(O);
  const r = await relay(redisEnv(O, '0'));
  const a = await call(r.base, 'POST', '/api/join', { body: { key: KEY, name: 'alice', owner: 'Alice' } });
  for (let i = 0; i < 40; i++) assert.equal((await call(r.base, 'POST', '/api/messages', { token: a.token, body: { text: `m${i}` } })).status, 200);
  await call(r.base, 'GET', '/api/info', { key: KEY });
  await sleep(300);
  assert.equal(fake.kv.get(O + 'log').type, 'list');
  assert.ok(fake.kv.get(O + 'log').v.length > 80, 'every operation, from the first');
  assert.equal(fake.kv.get(O + 'base'), undefined);
  assert.equal(fake.kv.get(O + 'snap'), undefined);
  assert.ok(!fake.kv.get(O + 'log').v.some((s) => JSON.parse(s).t === 'compaction'), 'nor marked: the wait starts when it is turned on');
  await chainOk(r.base);
  await r.stop();
});

// ---------------------------------------------------------------- the file store's tally

test("the file store's compacted log keeps the counts across a restart", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'fs-'));
  fs.writeFileSync(path.join(dir, 'sphere.json'), JSON.stringify({ sphere: { name: 'Folder', keyHash: sha(KEY), adminKeyHash: sha(ADMIN), createdAt: new Date().toISOString() }, policy: { retainMessages: RETAIN, sealed: false } }), { mode: 0o600 });
  const env = { SPHERE_STORE: 'fs', SPHERE_DATA: dir, SPHERE_ADMIN_KEY: ADMIN };
  let s = await relay(env);
  const alice = await call(s.base, 'POST', '/api/join', { body: { key: KEY, name: 'alice', owner: 'Alice' } });
  const bob = await call(s.base, 'POST', '/api/join', { body: { key: KEY, name: 'bob', owner: 'Bob' } });
  for (let i = 0; i < 6; i++) {
    const q = (await call(s.base, 'POST', '/api/messages', { token: alice.token, body: { text: `q${i}`, to: ['bob'] } })).message;
    await call(s.base, 'POST', '/api/messages', { token: bob.token, body: { text: `r${i}`, replyTo: q.id, meta: { durationMs: 500 + i } } });
  }
  for (let i = 0; i < 20; i++) await call(s.base, 'POST', '/api/messages', { token: alice.token, body: { text: `p${i}` } });
  const want = await numbers(s.base);
  assert.equal(want.counts.messages, 32);
  await s.stop();
  const lines = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.tally), 'a compaction wrote a tally line');
  assert.ok(lines.filter((l) => l.id).length < 32, 'and dropped messages past retainMessages');
  s = await relay(env);
  assert.deepEqual(await numbers(s.base), want, 'the same counts after a restart');
  await chainOk(s.base);
  await s.stop();
  s = await relay(env); // and again, after the compaction at that start
  assert.deepEqual(await numbers(s.base), want);
  await s.stop();
});
