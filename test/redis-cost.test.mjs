// What a relay on Redis costs on Upstash, which bills each command: an instance holding a stream
// with nothing happening reads only its two change counters (one MGET), and less often once it's
// quiet, instead of the whole log and presence every pollMs; news still reaches its streams.
// Two instances on one fake Upstash. `npm test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeUpstash } from './fake-upstash.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEY = 'join-key-redis-cost-0123456789ab';
const ADMIN = 'admin-key-redis-cost-0123456789ab';
const POLL_MS = 150; // so half a minute of looks after news is 4.5 s here, and a quiet look every 1.2 s
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fake;
const procs = [];
let A, B;

async function instance() {
  const port = await freePort();
  const p = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs'), '--port', String(port), '--host', '127.0.0.1'], {
    env: { ...process.env, SPHERE_STORE: 'redis', UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, SPHERE_REDIS_PREFIX: 'cost:', SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_SEALED: '0', SPHERE_POLL_MS: String(POLL_MS) },
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
const call = async (base, method, url, { token, key, body } = {}) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['x-sphere-key'] = key;
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};

before(async () => {
  fake = await startFakeUpstash();
  A = await instance();
  B = await instance();
});
after(async () => {
  for (const p of procs) p.kill();
  await fake.close?.();
});

test('an instance with a stream open and nothing happening reads only its counters, slower once quiet, and news still arrives', async () => {
  const alice = await call(A, 'POST', '/api/join', { key: KEY, body: { name: 'alice', owner: 'Alice Test' } });
  const bob = await call(A, 'POST', '/api/join', { key: KEY, body: { name: 'bob', owner: 'Bob Test' } });
  assert.equal(alice.status, 200);
  // bob's representative holds a stream on B
  const ac = new AbortController();
  const seen = [];
  const r = await fetch(`${B}/api/stream?role=rep`, { headers: { authorization: `Bearer ${bob.token}` }, signal: ac.signal });
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const c of r.body) {
        buf += dec.decode(c, { stream: true });
        seen.push(buf);
      }
    } catch {}
  })();
  try {
    await sleep(30 * POLL_MS + 1500); // past the half minute of looks after its own news
    const before = fake.commands();
    await sleep(6000);
    const quiet = fake.commands() - before;
    // a quiet look every 1.2 s (about 5 MGETs), and now and then presence: before, every 150 ms
    // the whole log and presence (some 70 commands here)
    assert.ok(quiet <= 12, `${quiet} commands in 6 quiet seconds`);
    // news from the other instance reaches the stream within a quiet look or two
    const t0 = Date.now();
    const posted = await call(A, 'POST', '/api/messages', { token: alice.token, body: { channel: 'general', text: 'news for bob', to: [bob.agent.id] } });
    assert.equal(posted.status, 200);
    for (;;) {
      if (seen.join('').includes(posted.message.id)) break;
      assert.ok(Date.now() - t0 < 5000, 'the ask reached the stream on the other instance');
      await sleep(50);
    }
  } finally {
    ac.abort();
  }
});

test('a write from a relay that keeps no counter (an older version) is read at the next write, which never loops on it', { timeout: 20000 }, async () => {
  const alice = await call(A, 'POST', '/api/join', { key: KEY, body: { name: 'alice2', owner: 'Alice Test' } });
  const depth = async () => (await call(A, 'GET', '/api/instruments', { token: alice.token })).rules.maxDepth;
  const was = await depth();
  // an older relay's append: the log moves, its counter doesn't
  const r = await fetch(fake.url, { method: 'POST', headers: { authorization: `Bearer ${fake.token}`, 'content-type': 'application/json' }, body: JSON.stringify(['RPUSH', 'cost:log', JSON.stringify({ t: 'policy', policy: { maxDepth: was + 1 } })]) });
  assert.equal(r.status, 200);
  // a write here: its first look sees no counter moved, its append finds the log moved, so it reads it all and goes on
  const t0 = Date.now();
  const posted = await call(A, 'POST', '/api/messages', { token: alice.token, body: { channel: 'general', text: 'after an older relay wrote' } });
  assert.equal(posted.status, 200, JSON.stringify(posted));
  assert.ok(Date.now() - t0 < 3000, 'no long retry loop');
  assert.equal(await depth(), was + 1, "the older relay's write is applied");
});
