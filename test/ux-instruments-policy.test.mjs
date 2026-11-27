// Every limit the relay enforces is an admin's to change (POST /api/admin/policy): the hop limit, the
// largest file, files per message, storage per member, messages kept, and the five rates. Each is checked
// against its range (all or nothing), audited with who and what, kept in the stored policy (fs across a
// restart, Redis across instances), and takes effect at once. The console's Policy page offers only
// values the relay takes, and its Instruments page doesn't show the rules. No network: a fake Upstash.
// `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { startFakeUpstash } from './fake-upstash.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const KEY = 'join-key-policy-tests-0123456789';
const ADMIN = 'admin-key-policy-tests-0123456789';
const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;
const RATES = ['asksPerMin', 'writesPerMin', 'joinsPerMinPerIp', 'statusPerMin', 'mePerMin'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a free port, never one of the demos' (4848-4851, 4881-4899)
const freePort = async () => {
  for (;;) {
    const p = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); }); });
    if (!(p >= 4848 && p <= 4851) && !(p >= 4881 && p <= 4899)) return p;
  }
};
const tmp = (name) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sphere-policy-${name}-`)));
const stop = (proc) => new Promise((resolve) => { if (proc.exitCode !== null || proc.signalCode !== null) return resolve(); proc.once('exit', resolve); proc.kill(); });

async function startRelay(env) {
  const port = await freePort();
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1'], {
    env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_SEALED: '0', SPHERE_ASKS_PER_MIN: '', SPHERE_WRITES_PER_MIN: '', SPHERE_MAX_FILE_BYTES: '', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  p.stderr.on('data', (d) => process.env.SPHERE_TEST_DEBUG && process.stderr.write(`[relay ${port}] ${d}`));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + '/healthz')).ok) return { proc: p, base }; } catch {}
    await sleep(100);
  }
  throw new Error('the relay did not start');
}

function caller(baseOf) {
  return async (method, url, { token, key, admin, body, headers = {}, at, raw } = {}) => {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (key) h['x-sphere-key'] = key;
    if (admin) h['x-admin-key'] = admin;
    if (body !== undefined && !raw) h['content-type'] = 'application/json';
    const r = await fetch((at || baseOf()) + url, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ...j };
  };
}

// the console's Policy rows, as its own code builds them, for a Sphere on `store`
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(PAGE)[1];
function pageRows(store) {
  const from = SCRIPT.indexOf('const POL_MB');
  const to = SCRIPT.indexOf('const polRow');
  assert.ok(from > 0 && to > from, "the page's policy rows are where this test looks for them");
  const ctx = { S: { sphere: { store } } };
  vm.runInNewContext(`${SCRIPT.slice(from, to)}\nthis.rows = polSections().flatMap(([, rows]) => rows);`, ctx);
  return ctx.rows;
}
// every value a row offers: a stepper's ends, a dropdown's presets
const offered = (row) => (row.step ? row.step : row.menu);
const bodyFor = (key, v) => (key.startsWith('rate.') ? { rate: { [key.slice(5)]: v } } : { [key]: v });

describe('policy limits on the relay (fs store)', () => {
  let relay, dir;
  const call = caller(() => relay.base);
  const m = {}; // members by handle: { token, agent }
  const policy = async () => (await call('GET', '/api/info', { key: KEY })).sphere.policy;
  const policyEvents = async () => (await call('GET', '/api/audit?limit=1000', { key: KEY })).events.filter((e) => e.type === 'policy');
  const set = (body, as = { admin: ADMIN }) => call('POST', '/api/admin/policy', { ...as, body });

  before(async () => {
    dir = tmp('fs');
    relay = await startRelay({ SPHERE_STORE: 'fs', SPHERE_DATA: dir });
    for (const name of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank']) {
      const r = await call('POST', '/api/join', { body: { key: KEY, name, owner: name[0].toUpperCase() + name.slice(1) } });
      assert.ok(r.token, JSON.stringify(r));
      m[name] = r;
    }
    assert.equal((await call('POST', '/api/admin/claim', { token: m.alice.token, admin: ADMIN })).status, 200);
  });
  after(async () => {
    if (relay) await stop(relay.proc);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('each limit is checked against its range; one bad value changes nothing', async () => {
    const was = await policy();
    const auditWas = (await policyEvents()).length;
    const bad = [
      [{ maxDepth: -1 }, /maxDepth is a whole number from 0 to 10/],
      [{ maxDepth: 11 }, /maxDepth/],
      [{ maxDepth: 2.5 }, /maxDepth/],
      [{ maxDepth: '3' }, /maxDepth/],
      [{ maxDepth: null }, /maxDepth/],
      [{ maxFileBytes: KB - 1 }, /maxFileBytes is a whole number from 1\.0 KB to 50\.0 MB \(in bytes\) on this store/],
      [{ maxFileBytes: 50 * MB + 1 }, /maxFileBytes/],
      [{ maxFilesPerMessage: 0 }, /maxFilesPerMessage is a whole number from 1 to 50/],
      [{ maxFilesPerMessage: 51 }, /maxFilesPerMessage/],
      [{ maxAgentBytes: MB - 1 }, /maxAgentBytes is a whole number from 1\.0 MB to 10\.0 GB/],
      [{ maxAgentBytes: 10 * GB + 1 }, /maxAgentBytes/],
      [{ retainMessages: 99 }, /retainMessages is a whole number from 100 to 50,000/],
      [{ retainMessages: 50001 }, /retainMessages/],
      [{ rate: { asksPerMin: 0 } }, /rate\.asksPerMin is a whole number from 1 to 600/],
      [{ rate: { asksPerMin: 601 } }, /rate\.asksPerMin/],
      [{ rate: { writesPerMin: 9 } }, /rate\.writesPerMin is a whole number from 10 to 3,000/],
      [{ rate: { writesPerMin: 3001 } }, /rate\.writesPerMin/],
      [{ rate: { joinsPerMinPerIp: 0 } }, /rate\.joinsPerMinPerIp is a whole number from 1 to 600/],
      [{ rate: { joinsPerMinPerIp: 601 } }, /rate\.joinsPerMinPerIp/],
      [{ rate: { statusPerMin: 9 } }, /rate\.statusPerMin is a whole number from 10 to 1,200/],
      [{ rate: { statusPerMin: 1201 } }, /rate\.statusPerMin/],
      [{ rate: { mePerMin: 0 } }, /rate\.mePerMin is a whole number from 1 to 600/],
      [{ rate: { mePerMin: 601 } }, /rate\.mePerMin/],
      [{ rate: { mePerMin: '5' } }, /rate\.mePerMin/],
      [{ rate: { authFailsPerMin: 5 } }, /rate\.authFailsPerMin isn't a rate this Sphere has/],
      [{ rate: 5 }, /rate is an object/],
      [{ rate: null }, /rate is an object/],
      [{ rate: [30] }, /rate is an object/],
      // all or nothing: the good ones aren't saved either
      [{ maxDepth: 2, retainMessages: 1000, rate: { asksPerMin: 10, writesPerMin: 5 } }, /rate\.writesPerMin/],
      [{ rate: { asksPerMin: 10 }, sealed: 'yes' }, /sealed is true or false/],
    ];
    for (const [body, words] of bad) {
      const r = await set(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.code, 'bad_request');
      assert.match(r.error, words, JSON.stringify(body));
    }
    assert.deepEqual(await policy(), was, 'nothing changed');
    assert.equal((await policyEvents()).length, auditWas, 'nothing audited');
  });

  test("only admins change them, and a member's token is enough for an admin", async () => {
    for (const body of [{ retainMessages: 1000 }, { rate: { asksPerMin: 5 } }, { maxFilesPerMessage: 2 }]) {
      assert.equal((await set(body, { token: m.bob.token })).status, 403, JSON.stringify(body));
      assert.equal((await set(body, { key: KEY })).status, 403, JSON.stringify(body));
    }
    const r = await set({ maxFilesPerMessage: 12 }, { token: m.alice.token });
    assert.equal(r.status, 200);
    assert.equal(r.policy.maxFilesPerMessage, 12);
    await set({ maxFilesPerMessage: 10 });
  });

  test('a change is audited with who, the old and the new value; the other rates stay', async () => {
    const before = (await policyEvents()).length;
    let r = await set({ retainMessages: 4000, maxAgentBytes: 300 * MB, rate: { asksPerMin: 45, statusPerMin: 120 } }, { token: m.alice.token });
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.deepEqual(r.policy.rate, { asksPerMin: 45, writesPerMin: 120, joinsPerMinPerIp: 20, statusPerMin: 120, mePerMin: 30 });
    assert.equal(r.policy.retainMessages, 4000);
    assert.equal(r.policy.maxAgentBytes, 300 * MB);
    let events = (await policyEvents()).slice(before).map((e) => e.detail);
    assert.deepEqual(events.sort(), [
      'asks per minute 30 → 45 · by alice',
      'messages kept 5,000 → 4,000 · by alice',
      'status updates per minute 240 → 120 · by alice',
      'storage per member 200.0 MB → 300.0 MB · by alice',
    ]);
    const au = (await call('GET', '/api/audit?limit=1000', { key: KEY })).events.filter((e) => e.type === 'policy').slice(before);
    assert.ok(au.every((e) => e.actor === m.alice.agent.id), 'the actor is alice');
    // the same values again: nothing to audit
    r = await set({ retainMessages: 4000, rate: { asksPerMin: 45 } }, { token: m.alice.token });
    assert.equal(r.status, 200);
    assert.equal((await policyEvents()).length, before + 4);
    // every one of them, at the ends of its range
    r = await set({ maxDepth: 10, maxFileBytes: 50 * MB, maxFilesPerMessage: 50, maxAgentBytes: 10 * GB, retainMessages: 50000, rate: { asksPerMin: 600, writesPerMin: 3000, joinsPerMinPerIp: 600, statusPerMin: 1200, mePerMin: 600 } });
    assert.equal(r.status, 200, JSON.stringify(r));
    events = (await policyEvents()).slice(before + 4).map((e) => e.detail);
    assert.equal(events.length, 10, events.join('\n'));
    assert.ok(events.includes('hop limit 3 → 10'), events.join('\n'));
    assert.ok(events.includes('joins per minute per address 20 → 600'));
    assert.ok(events.includes('profile changes per minute 30 → 600'));
    r = await set({ maxDepth: 0, maxFileBytes: KB, maxFilesPerMessage: 1, maxAgentBytes: MB, retainMessages: 100, rate: { asksPerMin: 1, writesPerMin: 10, joinsPerMinPerIp: 1, statusPerMin: 10, mePerMin: 1 } });
    assert.equal(r.status, 200, JSON.stringify(r));
    // back to the defaults
    r = await set({ maxDepth: 3, maxFileBytes: 5 * MB, maxFilesPerMessage: 10, maxAgentBytes: 200 * MB, retainMessages: 5000, rate: { asksPerMin: 30, writesPerMin: 120, joinsPerMinPerIp: 20, statusPerMin: 240, mePerMin: 30 } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.policy.rate, { asksPerMin: 30, writesPerMin: 120, joinsPerMinPerIp: 20, statusPerMin: 240, mePerMin: 30 });
    const verified = (await call('GET', '/api/audit?limit=1', { key: KEY })).verified;
    assert.equal(verified, true, 'the chain verifies');
  });

  test('every value the console offers, the relay takes', async () => {
    const rows = pageRows('fs');
    assert.deepEqual(Array.from(rows, (r) => r.key).sort(), ['keepDays', 'maxAgentBytes', 'maxAgents', 'maxDepth', 'maxFileBytes', 'maxFilesPerMessage', 'retainMessages', ...RATES.map((k) => `rate.${k}`)].sort(), 'every limit the relay enforces has a row');
    const was = await policy();
    for (const row of rows)
      for (const v of offered(row)) {
        const r = await set(bodyFor(row.key, v));
        assert.equal(r.status, 200, `${row.key} ${v}: ${r.error}`);
      }
    // the defaults are among the presets, so a fresh Sphere shows them as chosen
    for (const row of rows.filter((x) => x.menu)) {
      const [a, b] = row.key.split('.');
      assert.ok(row.menu.includes(b ? was[a][b] : was[a]), `${row.key}'s default is a preset`);
    }
    await set({ maxDepth: 3, maxFileBytes: 5 * MB, maxFilesPerMessage: 10, maxAgentBytes: 200 * MB, retainMessages: 5000, keepDays: 0, maxAgents: 1000, rate: { asksPerMin: 30, writesPerMin: 120, joinsPerMinPerIp: 20, statusPerMin: 240, mePerMin: 30 } });
    assert.deepEqual(await policy(), was);
  });

  test('they take effect at once', async () => {
    const ask = (from, to, extra = {}) => call('POST', '/api/messages', { token: m[from].token, body: { text: 'a question', to: [to], ...extra } });
    // the hop limit: 0 stops Obys asking Obys
    const first = await ask('alice', 'bob');
    assert.equal(first.status, 200);
    assert.equal((await ask('bob', 'carol', { cause: first.message.id })).status, 200, 'one hop is fine at 3');
    await set({ maxDepth: 0 });
    const hop = await ask('bob', 'carol', { cause: first.message.id });
    assert.equal(hop.status, 429);
    assert.equal(hop.code, 'hop_limit');
    await set({ maxDepth: 3 });
    // asks per minute
    await set({ rate: { asksPerMin: 2 } });
    assert.deepEqual([(await ask('carol', 'alice')).status, (await ask('carol', 'alice')).status, (await ask('carol', 'alice')).code], [200, 200, 'rate_limited']);
    await set({ rate: { asksPerMin: 30 } });
    // writes per minute
    await set({ rate: { writesPerMin: 10 } });
    const posts = [];
    for (let i = 0; i < 11; i++) posts.push((await call('POST', '/api/messages', { token: m.dave.token, body: { text: `post ${i}` } })).status);
    assert.deepEqual(posts, [...Array(10).fill(200), 429]);
    await set({ rate: { writesPerMin: 3000 } });
    // status updates per minute
    await set({ rate: { statusPerMin: 10 } });
    const st = [];
    for (let i = 0; i < 11; i++) st.push((await call('POST', '/api/status', { token: m.erin.token, body: { state: 'idle' } })).status);
    assert.deepEqual(st, [...Array(10).fill(200), 429]);
    await set({ rate: { statusPerMin: 240 } });
    // profile changes per minute
    await set({ rate: { mePerMin: 1 } });
    assert.equal((await call('POST', '/api/me', { token: m.erin.token, body: { runtime: 'claude' } })).status, 200);
    assert.equal((await call('POST', '/api/me', { token: m.erin.token, body: { runtime: 'claude' } })).code, 'rate_limited');
    await set({ rate: { mePerMin: 30 } });
    // files per message
    const file = (name) => ({ name, mime: 'text/plain', data: Buffer.from(name).toString('base64') });
    await set({ maxFilesPerMessage: 1 });
    const two = await call('POST', '/api/messages', { token: m.frank.token, body: { text: 'two files', files: [file('a.txt'), file('b.txt')] } });
    assert.equal(two.status, 400);
    assert.match(two.error, /at most 1 files/);
    assert.equal((await call('POST', '/api/messages', { token: m.frank.token, body: { text: 'one file', files: [file('a.txt')] } })).status, 200);
    await set({ maxFilesPerMessage: 10 });
    // the largest file
    const upload = (bytes) => call('POST', '/api/files', { token: m.frank.token, headers: { 'x-file-name': 'f.bin', 'content-type': 'application/octet-stream' }, raw: Buffer.alloc(bytes, 1) });
    await set({ maxFileBytes: KB });
    assert.equal((await upload(2 * KB)).status, 413);
    // storage per member: frank has stored one small file so far (counted as 1 KB)
    await set({ maxFileBytes: MB, maxAgentBytes: MB });
    assert.equal((await upload(700 * KB)).status, 200);
    const over = await upload(700 * KB);
    assert.equal(over.status, 413);
    assert.match(over.error, /storage quota/);
    await set({ maxFileBytes: 5 * MB, maxAgentBytes: 200 * MB });
    // messages kept: the older ones go at once, from memory and from the log on disk
    for (let i = 0; i < 110; i++) assert.equal((await call('POST', '/api/messages', { token: m.frank.token, body: { text: `filler ${i}` } })).status, 200);
    const all = (await call('GET', '/api/messages?limit=1000', { key: KEY })).messages;
    assert.ok(all.length > 120, String(all.length));
    await set({ retainMessages: 100 });
    const kept = (await call('GET', '/api/messages?limit=1000', { key: KEY })).messages;
    assert.equal(kept.length, 100);
    assert.deepEqual(kept.map((x) => x.id), all.slice(-100).map((x) => x.id), 'the newest are kept');
    const lines = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines.filter((l) => l.id && !l.f).length, 100, 'the log on disk keeps the same 100');
    assert.equal((await call('GET', '/api/audit?limit=1', { key: KEY })).verified, true, 'the chain still verifies');
    // joins per minute per address (last: the bucket takes a while to fill again)
    await set({ rate: { joinsPerMinPerIp: 1 } });
    assert.equal((await call('POST', '/api/join', { body: { key: KEY, name: 'gina', owner: 'Gina' } })).status, 200);
    assert.equal((await call('POST', '/api/join', { body: { key: KEY, name: 'hank', owner: 'Hank' } })).code, 'rate_limited');
  });

  test('they are kept across a restart', async () => {
    await set({ maxDepth: 4, maxFilesPerMessage: 7, rate: { joinsPerMinPerIp: 50, statusPerMin: 90, mePerMin: 12 } });
    const was = await policy();
    await stop(relay.proc);
    relay = await startRelay({ SPHERE_STORE: 'fs', SPHERE_DATA: dir });
    const now = await policy();
    assert.deepEqual(now, was);
    assert.equal(now.retainMessages, 100);
    assert.deepEqual(now.rate, { asksPerMin: 30, writesPerMin: 3000, joinsPerMinPerIp: 50, statusPerMin: 90, mePerMin: 12 });
    // (a store goes a little past retainMessages, 20 here, before a request cuts it back: #139)
    assert.equal((await call('GET', '/api/messages?limit=1000', { key: KEY })).messages.length <= 100 + 20, true);
    assert.equal((await call('GET', '/api/audit?limit=1', { key: KEY })).verified, true);
  });
});

describe('policy limits on the Redis store', () => {
  let fake, A, B;
  const procs = [];
  const call = caller(() => A);
  const set = (at, body) => call('POST', '/api/admin/policy', { at, admin: ADMIN, body });
  const policyAt = async (at) => (await call('GET', '/api/info', { at, key: KEY })).sphere.policy;
  const instance = async () => {
    const r = await startRelay({ SPHERE_STORE: 'redis', UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, SPHERE_REDIS_PREFIX: 'p:', SPHERE_POLL_MS: '150' });
    procs.push(r.proc);
    return r.base;
  };

  before(async () => {
    fake = await startFakeUpstash({ latencyMs: 2 });
    A = await instance();
    B = await instance();
  });
  after(async () => {
    for (const p of procs) await stop(p);
    await fake?.close();
  });

  test("the Redis store's caps: a file at most 1 MB, a member's files at most 100 MB", async () => {
    let r = await set(A, { maxFileBytes: MB + 1 });
    assert.equal(r.status, 400);
    assert.match(r.error, /maxFileBytes is a whole number from 1\.0 KB to 1\.0 MB \(in bytes\) on this store/);
    r = await set(A, { maxAgentBytes: 100 * MB + 1 });
    assert.equal(r.status, 400);
    assert.match(r.error, /maxAgentBytes is a whole number from 1\.0 MB to 100\.0 MB/);
    assert.equal((await set(A, { maxFileBytes: MB, maxAgentBytes: 100 * MB })).status, 200);
    // and every value the console offers on Redis, the relay takes
    for (const row of pageRows('redis'))
      for (const v of offered(row)) assert.equal((await set(B, bodyFor(row.key, v))).status, 200, `${row.key} ${v}`);
  });

  test('a change on one instance is the policy on every instance, audited once', async () => {
    const r = await set(A, { maxDepth: 2, maxFilesPerMessage: 3, maxAgentBytes: 20 * MB, retainMessages: 2000, rate: { asksPerMin: 30, writesPerMin: 3000, joinsPerMinPerIp: 40, statusPerMin: 50, mePerMin: 7 } });
    assert.equal(r.status, 200, JSON.stringify(r));
    const [pa, pb] = [await policyAt(A), await policyAt(B)];
    assert.deepEqual(pa, pb);
    assert.equal(pb.maxFilesPerMessage, 3);
    assert.equal(pb.retainMessages, 2000);
    assert.deepEqual(pb.rate, { asksPerMin: 30, writesPerMin: 3000, joinsPerMinPerIp: 40, statusPerMin: 50, mePerMin: 7 });
    const [aa, ab] = [await call('GET', '/api/audit?limit=1000', { at: A, key: KEY }), await call('GET', '/api/audit?limit=1000', { at: B, key: KEY })];
    assert.deepEqual(aa.head, ab.head);
    assert.equal(ab.verified, true);
    const details = ab.events.filter((e) => e.type === 'policy').map((e) => e.detail);
    assert.equal(details.filter((d) => d === 'profile changes per minute 600 → 7').length, 1, details.join('\n'));
    assert.ok(details.includes('status updates per minute 1,200 → 50'));
  });

  test('the limits apply at once on every instance', async () => {
    const joined = await call('POST', '/api/join', { at: A, body: { key: KEY, name: 'rita', owner: 'Rita' } });
    assert.ok(joined.token);
    await set(B, { rate: { mePerMin: 1 } });
    assert.equal((await call('POST', '/api/me', { at: A, token: joined.token, body: { runtime: 'claude' } })).status, 200);
    assert.equal((await call('POST', '/api/me', { at: B, token: joined.token, body: { runtime: 'claude' } })).code, 'rate_limited', 'counted across instances, at the new limit');
    // messages kept: fewer, and both instances let the older ones go
    for (let i = 0; i < 115; i++) assert.equal((await call('POST', '/api/messages', { at: i % 2 ? A : B, token: joined.token, body: { text: `m${i}` } })).status, 200);
    await set(A, { retainMessages: 100 });
    const [ma, mb] = [(await call('GET', '/api/messages?limit=1000', { at: A, key: KEY })).messages, (await call('GET', '/api/messages?limit=1000', { at: B, key: KEY })).messages];
    assert.equal(ma.length, 100);
    assert.deepEqual(mb.map((x) => x.id), ma.map((x) => x.id));
  });

  test('a new instance replays the log to the same policy', async () => {
    const C = await instance();
    assert.deepEqual(await policyAt(C), await policyAt(A));
    assert.equal((await policyAt(C)).rate.mePerMin, 1);
  });
});

describe('the console', () => {
  const between = (from, to) => {
    const a = SCRIPT.indexOf(from);
    const b = SCRIPT.indexOf(to, a);
    assert.ok(a > 0 && b > a, `${from} … ${to}`);
    return SCRIPT.slice(a, b);
  };

  test("Instruments doesn't show the Sphere's rules: they're in Policy, for admins", () => {
    const inst = between('function pageInstruments()', 'async function loadFiles()');
    assert.doesNotMatch(inst, /policy|rules|Rules of/i);
    assert.doesNotMatch(PAGE, /Rules of this Sphere/);
    assert.match(SCRIPT, /else if \(p === 'policy' && S\.admin\) draw\(pagePolicy\(\)\);/, 'Policy renders for admins only'); // (draw: left as it is when unchanged, #137)
  });

  test("Policy uses the console's own controls: no native select or number field", () => {
    const pol = between('// ===== Policy:', '// Admins: members who govern this Sphere');
    assert.doesNotMatch(pol, /<select|type="number"|<input/);
    assert.match(pol, /role="spinbutton"/);
    assert.match(pol, /role="listbox"/);
  });
});
