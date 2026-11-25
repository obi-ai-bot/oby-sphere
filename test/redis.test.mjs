// The Redis store (Vercel) against a fake Upstash: two relay instances on one
// store must act as one Sphere. A claim race has one winner, the audit chain
// verifies the same on both, and presence, live events, rate limits, files,
// long-polls and the operator's controls cross instances. `npm test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startFakeUpstash } from './fake-upstash.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEY = 'join-key-redis-0123456789ab';
const ADMIN = 'admin-key-redis-0123456789ab';
let fake;
const procs = [];
let A, B; // the two instances' base URLs

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function instance() {
  const port = await freePort();
  const p = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs'), '--port', String(port), '--host', '127.0.0.1'], {
    env: {
      ...process.env,
      SPHERE_STORE: 'redis',
      UPSTASH_REDIS_REST_URL: fake.url,
      UPSTASH_REDIS_REST_TOKEN: fake.token,
      SPHERE_REDIS_PREFIX: 't:',
      SPHERE_KEY: KEY,
      SPHERE_ADMIN_KEY: ADMIN,
      SPHERE_SEALED: '0',
      SPHERE_POLL_MS: '150',
      SPHERE_ASKS_PER_MIN: '8',
      SPHERE_WRITES_PER_MIN: '100000',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  p.stderr.on('data', (d) => process.stderr.write(`[relay ${port}] ${d}`));
  procs.push(p);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(base + '/healthz')).ok) return base;
    } catch {}
    await sleep(100);
  }
  throw new Error('a relay instance did not start');
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

// an open event stream, collecting its events
function openStream(base, { token, key, role } = {}) {
  const ac = new AbortController();
  const events = [];
  const qs = new URLSearchParams({ ...(role ? { role } : {}) });
  const done = fetch(`${base}/api/stream?${qs}`, { headers: token ? { authorization: `Bearer ${token}` } : { 'x-sphere-key': key }, signal: ac.signal })
    .then(async (r) => {
      const dec = new TextDecoder();
      let buf = '';
      for await (const c of r.body) {
        buf += dec.decode(c, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (\S+)/.exec(block)?.[1];
          const data = block.split('\n').find((l) => l.startsWith('data: '));
          if (ev && data) events.push({ ev, data: JSON.parse(data.slice(6)) });
        }
      }
    })
    .catch(() => {});
  return { events, close: () => ac.abort(), done };
}

async function until(fn, ms = 4000) {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) return v;
    await sleep(100);
  }
}

before(async () => {
  fake = await startFakeUpstash({ latencyMs: 3 });
  [A, B] = await Promise.all([instance(), instance()]); // both start on an empty store at once
});

after(async () => {
  for (const p of procs) p.kill();
  await fake?.close();
});

let alice, bob, ask;

test('two instances start on one empty store as one Sphere', async () => {
  const [ia, ib] = await Promise.all([call(A, 'GET', '/api/info', { key: KEY }), call(B, 'GET', '/api/info', { key: KEY })]);
  assert.equal(ia.sphere.store, 'redis');
  assert.equal(ia.sphere.createdAt, ib.sphere.createdAt);
  alice = await call(A, 'POST', '/api/join', { body: { key: KEY, name: 'alice', owner: 'Alice' } });
  bob = await call(B, 'POST', '/api/join', { body: { key: KEY, name: 'bob', owner: 'Bob' } });
  assert.ok(alice.token && bob.token);
  assert.equal((await call(B, 'POST', '/api/join', { body: { key: KEY, name: 'alice' } })).status, 409, 'a handle is taken across instances');
  const names = (await call(A, 'GET', '/api/agents', { key: KEY })).agents.map((a) => a.name).sort();
  assert.deepEqual(names, ['alice', 'bob']);
  // a token made on one instance works on the other
  assert.equal((await call(A, 'GET', '/api/info', { token: bob.token })).me.name, 'bob');
});

test('a claim race across instances has exactly one winner', async () => {
  ask = (await call(A, 'POST', '/api/messages', { token: alice.token, body: { text: 'race?', to: ['bob'] } })).message;
  const tries = [];
  for (let i = 0; i < 6; i++) tries.push(call(i % 2 ? A : B, 'POST', `/api/messages/${ask.id}/claim`, { token: bob.token, body: { instance: `p${i}` } }));
  const results = await Promise.all(tries);
  assert.equal(results.filter((r) => r.ok === true).length, 1, JSON.stringify(results));
  const m = await call(B, 'GET', `/api/messages/${ask.id}`, { key: KEY });
  assert.ok(m.message.claimedAt);
});

test('concurrent writes on both instances keep one verified audit chain', async () => {
  const writes = [];
  for (let i = 0; i < 20; i++) {
    writes.push(call(A, 'POST', '/api/messages', { token: alice.token, body: { text: `a${i}` } }));
    writes.push(call(B, 'POST', '/api/messages', { token: bob.token, body: { text: `b${i}` } }));
  }
  const rs = await Promise.all(writes);
  assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.filter((r) => r.status !== 200)));
  const [aa, ab] = await Promise.all([call(A, 'GET', '/api/audit?limit=1000', { key: KEY }), call(B, 'GET', '/api/audit?limit=1000', { key: KEY })]);
  assert.equal(aa.verified, true);
  assert.equal(ab.verified, true);
  assert.deepEqual(aa.head, ab.head);
  const seqs = aa.events.map((e) => e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => seqs[0] + i), 'no gaps, no forks');
  const [ma, mb] = await Promise.all([call(A, 'GET', '/api/messages?limit=1000', { key: KEY }), call(B, 'GET', '/api/messages?limit=1000', { key: KEY })]);
  assert.deepEqual(ma.messages.map((m) => m.id), mb.messages.map((m) => m.id));
});

test('presence crosses instances, announced once', async () => {
  const s = openStream(B, { token: bob.token }); // bob's representative connects to B
  const on = await until(async () => (await call(A, 'GET', '/api/agents', { key: KEY })).agents.find((a) => a.name === 'bob')?.online);
  assert.equal(on, true, 'A sees bob online');
  await sleep(600);
  let au = await call(A, 'GET', '/api/audit?limit=1000', { key: KEY });
  assert.equal(au.events.filter((e) => e.type === 'online' && e.actor === bob.agent.id).length, 1);
  s.close();
  const off = await until(async () => (await call(A, 'GET', '/api/agents', { key: KEY })).agents.find((a) => a.name === 'bob')?.online === false);
  assert.equal(off, true, 'A sees bob go offline');
  au = await until(async () => {
    const r = await call(B, 'GET', '/api/audit?limit=1000', { key: KEY });
    return r.events.some((e) => e.type === 'offline' && e.actor === bob.agent.id) && r;
  });
  assert.ok(au, 'the offline event is in the chain');
});

test('a viewer on one instance gets what is written on the other', async () => {
  const v = openStream(A, { key: KEY });
  await sleep(300);
  const sent = (await call(B, 'POST', '/api/messages', { token: bob.token, body: { text: 'across the instances' } })).message;
  const got = await until(() => v.events.find((e) => e.ev === 'message' && e.data.id === sent.id));
  v.close();
  assert.ok(got, 'the message reached the viewer on A');
});

test('a long-poll on one instance wakes on a reply written on the other', async () => {
  const q = (await call(A, 'POST', '/api/messages', { token: alice.token, body: { text: 'wait for me', to: ['bob'] } })).message;
  const t0 = Date.now();
  const waiting = call(A, 'GET', `/api/messages/${q.id}/replies?wait=10`, { token: alice.token });
  await sleep(300);
  await call(B, 'POST', '/api/messages', { token: bob.token, body: { text: 'here', replyTo: q.id } });
  const r = await waiting;
  assert.equal(r.replies.length, 1);
  assert.ok(Date.now() - t0 < 4000, 'woken, not timed out');
});

test('rate limits count across instances', async () => {
  // 8 asks a minute per agent; alice has made 2 so far
  const results = [];
  for (let i = 0; i < 7; i++) results.push((await call(i % 2 ? A : B, 'POST', '/api/messages', { token: alice.token, body: { text: `ask ${i}`, to: ['bob'] } })).status);
  assert.deepEqual(results, [200, 200, 200, 200, 200, 200, 429]);
});

test('files go through the store', async () => {
  const bytes = Buffer.from('hello from instance A, read on instance B');
  const up = await (await fetch(`${A}/api/files`, { method: 'POST', headers: { authorization: `Bearer ${alice.token}`, 'x-file-name': 'note.txt', 'content-type': 'text/plain' }, body: bytes })).json();
  assert.ok(up.file?.id);
  // not sent with a message yet, so its uploader's (and an admin's) only
  const down = Buffer.from(await (await fetch(`${B}/api/files/${up.file.id}`, { headers: { authorization: `Bearer ${alice.token}` } })).arrayBuffer());
  assert.deepEqual(down, bytes);
  const big = await fetch(`${A}/api/files`, { method: 'POST', headers: { authorization: `Bearer ${alice.token}`, 'x-file-name': 'big.bin' }, body: Buffer.alloc(600 * 1024) });
  assert.equal(big.status, 413, 'the Redis store keeps files small (512 KB by default)');
});

test("the operator's controls apply on every instance", async () => {
  assert.equal((await call(B, 'POST', `/api/admin/agents/${bob.agent.id}/suspend`, { admin: ADMIN, body: { suspended: true } })).status, 200);
  const r = await call(A, 'POST', '/api/messages', { token: bob.token, body: { text: 'am I muted?' } });
  assert.equal(r.code, 'suspended');
  await call(A, 'POST', `/api/admin/agents/${bob.agent.id}/suspend`, { admin: ADMIN, body: { suspended: false } });
  assert.equal((await call(B, 'POST', '/api/admin/policy', { admin: ADMIN, body: { sealed: true } })).policy.sealed, true);
  assert.equal((await call(A, 'POST', '/api/messages', { token: alice.token, body: { text: 'plain' } })).code, 'must_seal');
  await call(A, 'POST', '/api/admin/policy', { admin: ADMIN, body: { sealed: false } });
});

test('a new instance replays the log to the same state', async () => {
  const C = await instance();
  const [ac, aa] = await Promise.all([call(C, 'GET', '/api/audit?limit=1', { key: KEY }), call(A, 'GET', '/api/audit?limit=1', { key: KEY })]);
  assert.equal(ac.verified, true);
  assert.deepEqual(ac.head, aa.head);
  const [sc, sa] = await Promise.all([call(C, 'GET', '/api/stats', { key: KEY }), call(A, 'GET', '/api/stats', { key: KEY })]);
  assert.equal(sc.counts.messages, sa.counts.messages);
  assert.equal(sc.counts.asks, sa.counts.asks);
});
