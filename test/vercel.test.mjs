// The Sphere as Vercel runs it: api/sphere.mjs's handler (imported, not run),
// the ?__path= rewrite, the Redis store with the deploy button's KV_* names,
// trusted forwarded headers, HSTS, streams that end before the function's time
// limit, and presence that doesn't flap when they reconnect. `npm test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFakeUpstash } from './fake-upstash.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEY = 'join-key-vercel-0123456789ab';
const ADMIN = 'admin-key-vercel-0123456789ab';
let fake, fn, base;
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const at = (p, q = '') => `${base}/api/sphere?__path=${encodeURIComponent(p)}${q}`;

before(async () => {
  fake = await startFakeUpstash();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // what Vercel does: import the function and call its default export per request
  const harness = `import http from 'node:http'; const { default: handler } = await import(${JSON.stringify(pathToFileURL(path.join(HERE, '..', 'api', 'sphere.mjs')).href)}); http.createServer((q, s) => handler(q, s)).listen(${port}, '127.0.0.1');`;
  fn = spawn(process.execPath, ['--input-type=module', '-e', harness], {
    env: { ...process.env, VERCEL: '1', VERCEL_URL: 'sphere-test.vercel.app', KV_REST_API_URL: fake.url, KV_REST_API_TOKEN: fake.token, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_STREAM_MAX_MS: '1200', SPHERE_POLL_MS: '150' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(at('/healthz'))).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error('the function did not start');
});
after(async () => { fn?.kill(); await fake?.close(); });

test('on Vercel: the Redis store, sealed by default, the page and the docs', async () => {
  const h = await (await fetch(at('/healthz'))).json();
  assert.equal(h.store, 'redis');
  assert.equal(h.sealed, true);
  const page = await fetch(at('/'));
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(at('/rep.mjs'))).status, 200);
  assert.equal((await fetch(at('/api.md'))).status, 200);
});

test('forwarded headers are trusted: HSTS over https, the public URL, rate limits by client address', async () => {
  const r = await fetch(at('/api/info'), { headers: { 'x-forwarded-proto': 'https', 'x-sphere-key': KEY } });
  assert.match(r.headers.get('strict-transport-security') || '', /max-age=/);
  assert.equal((await r.json()).sphere.publicUrl, 'https://sphere-test.vercel.app');
  assert.equal((await fetch(at('/healthz'))).headers.get('strict-transport-security'), null, 'no HSTS over plain http');
  const join = (ip, name) => fetch(at('/api/join'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${ip}, 10.0.0.1` }, body: JSON.stringify({ key: 'wrong', name }) });
  const statuses = [];
  for (let i = 0; i < 21; i++) statuses.push((await join('203.0.113.7', `x${i}`)).status);
  assert.equal(statuses.at(-1), 429, 'the 21st join from one address is refused');
  assert.equal((await join('198.51.100.9', 'y')).status, 401, 'another address is not');
});

test('streams end before the time limit; presence holds across the reconnect', async () => {
  const j = await (await fetch(at('/api/join'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: KEY, name: 'rep-one', owner: 'One' }) })).json();
  const open = async () => {
    const t0 = Date.now();
    const r = await fetch(at('/api/stream'), { headers: { authorization: `Bearer ${j.token}` } });
    for await (const _ of r.body); // until the function ends it
    return Date.now() - t0;
  };
  const lasted = await open();
  assert.ok(lasted >= 1000 && lasted < 3000, `ended on time (${lasted} ms)`);
  await open(); // the client reconnects at once, as EventSource and rep.mjs do
  const agents = (await (await fetch(at('/api/agents'), { headers: { 'x-sphere-key': KEY } })).json()).agents;
  const au = (await (await fetch(at('/api/audit', '&limit=1000'), { headers: { 'x-sphere-key': KEY } })).json()).events.filter((e) => e.actor === j.agent.id);
  assert.equal(au.filter((e) => e.type === 'online').length, 1, 'online once');
  assert.equal(au.filter((e) => e.type === 'offline').length, 0, 'no offline between reconnects');
  assert.ok(agents.find((a) => a.id === j.agent.id), 'listed');
});
