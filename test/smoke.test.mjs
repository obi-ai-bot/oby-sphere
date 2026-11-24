// The relay end to end over HTTP, without Claude: join, ask, claim, answer,
// stats, the audit chain, and the operator's controls. `npm test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEY = 'join-key-for-tests-0123456789';
const ADMIN = 'admin-key-for-tests-0123456789';
let base, server, dir;

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'sphere-test-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', dir], {
    env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_SEALED: '0', SPHERE_STORE: 'fs' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + '/healthz')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the relay did not start');
});

after(() => { server?.kill(); rmSync(dir, { recursive: true, force: true }); });

const call = async (method, url, { token, key, admin, body } = {}) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['x-sphere-key'] = key;
  if (admin) headers['x-admin-key'] = admin;
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
};

let a, b, ask;

test('joining needs the key, and a handle is taken once', async () => {
  assert.equal((await call('POST', '/api/join', { body: { key: 'wrong', name: 'eve' } })).status, 401);
  a = await call('POST', '/api/join', { body: { key: KEY, name: 'alice', owner: 'Alice' } });
  b = await call('POST', '/api/join', { body: { key: KEY, name: 'bob', owner: 'Bob' } });
  assert.ok(a.token && b.token);
  assert.equal((await call('POST', '/api/join', { body: { key: KEY, name: 'alice' } })).status, 409);
});

test('nothing without a credential; viewers can only watch', async () => {
  assert.equal((await call('GET', '/api/agents')).status, 401);
  assert.equal((await call('GET', '/api/agents', { key: KEY })).status, 200);
  assert.equal((await call('POST', '/api/messages', { key: KEY, body: { text: 'hi' } })).status, 403);
});

test('an ask is claimed once, worked, answered, and timed', async () => {
  ask = (await call('POST', '/api/messages', { token: a.token, body: { channel: 'general', text: 'What is 2+2?', to: ['bob'] } })).message;
  assert.equal(ask.kind, 'ask');
  assert.deepEqual((await call('POST', `/api/messages/${ask.id}/claim`, { token: b.token, body: { instance: 'one' } })).ok, true);
  assert.equal((await call('POST', `/api/messages/${ask.id}/claim`, { token: b.token, body: { instance: 'two' } })).ok, false);
  await call('POST', '/api/status', { token: b.token, body: { state: 'working', about: ask.id } });
  const reply = (await call('POST', '/api/messages', { token: b.token, body: { channel: 'general', text: '4', replyTo: ask.id } })).message;
  assert.equal(reply.kind, 'reply');
  const got = await call('GET', `/api/messages/${ask.id}`, { key: KEY });
  assert.ok(got.message.claimedAt && got.message.startedAt);
  assert.equal(got.replies[0].text, '4');
});

test('an agent cannot ask itself, and text loses control characters', async () => {
  assert.equal((await call('POST', '/api/messages', { token: a.token, body: { text: 'me?', to: ['alice'] } })).status, 400);
  const m = (await call('POST', '/api/messages', { token: a.token, body: { text: 'a‮b\u0007c' } })).message;
  assert.equal(m.text, 'abc');
});

test('stats, instruments and a verified audit chain', async () => {
  const st = await call('GET', '/api/stats', { key: KEY });
  assert.ok(st.counts.asks >= 1 && st.relay.samples >= 1);
  const inst = await call('GET', '/api/instruments', { key: KEY });
  assert.ok(inst.instruments.some((i) => i.name === 'sphere_ask'));
  const au = await call('GET', '/api/audit?limit=1000', { key: KEY });
  assert.equal(au.verified, true);
  assert.ok(au.events.some((e) => e.type === 'ask') && au.events.some((e) => e.type === 'reply'));
});

test('the operator governs; nobody else can', async () => {
  assert.equal((await call('POST', '/api/admin/policy', { key: KEY, body: { paused: true } })).status, 403);
  assert.equal((await call('POST', '/api/admin/policy', { admin: ADMIN, body: { paused: true } })).status, 200);
  assert.equal((await call('POST', '/api/messages', { token: a.token, body: { text: 'during pause' } })).status, 503);
  await call('POST', '/api/admin/policy', { admin: ADMIN, body: { paused: false } });
  await call('POST', `/api/admin/agents/${b.agent.id}/suspend`, { admin: ADMIN, body: { suspended: true } });
  assert.equal((await call('POST', '/api/messages', { token: a.token, body: { text: 'hello?', to: ['bob'] } })).status, 403);
  await call('POST', `/api/admin/agents/${b.agent.id}/suspend`, { admin: ADMIN, body: { suspended: false } });
  assert.equal((await call('DELETE', `/api/admin/agents/${b.agent.id}`, { admin: ADMIN })).status, 200);
  assert.equal((await call('GET', '/api/agents', { token: b.token })).status, 401);
});
