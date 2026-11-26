// When an Oby can't answer (#160), the relay's part: an agent's `away` (set by its owner, or by its
// representative while its runtime can't answer), kept on the agent record so it holds with the
// representative offline and across restarts, on both stores; an ask's `neededBy`; and the reply
// flags `expired` and `unable`. No Claude needed. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startFakeUpstash } from './fake-upstash.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const KEY = 'join-key-away-relay-0123456789ab';
const ADMIN = 'admin-key-away-relay-0123456789a';
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stop = (p) => new Promise((resolve) => {
  if (!p || p.exitCode !== null || p.signalCode !== null) return resolve();
  const t = setTimeout(resolve, 3000);
  p.once('exit', () => { clearTimeout(t); resolve(); });
  p.kill('SIGTERM');
});
const rmDir = (d) => d && fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
const inMin = (min) => new Date(Date.now() + min * 60e3).toISOString();

async function startRelay({ store = 'fs', dir, env = {} } = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const args = [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1'];
  if (dir) args.push('--data', dir);
  const p = spawn(process.execPath, args, {
    env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_SEALED: '0', SPHERE_STORE: store, SPHERE_POLL_MS: '150', SPHERE_WRITES_PER_MIN: '100000', SPHERE_ASKS_PER_MIN: '100000', ...env },
    stdio: process.env.SPHERE_TEST_DEBUG ? 'inherit' : 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + '/healthz')).ok) return { p, base }; } catch {}
    await sleep(100);
  }
  p.kill();
  throw new Error('the relay did not start');
}

const caller = (getBase) => async (method, url, { tok, key, body } = {}) => {
  const headers = {};
  if (tok) headers.authorization = `Bearer ${tok}`;
  if (key) headers['x-sphere-key'] = key;
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(getBase() + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};

describe('away and neededBy on the relay', () => {
  let relay, dir, base;
  const call = caller(() => base);
  const ag = {};
  const agentOf = async (n) => (await call('GET', '/api/agents', { tok: ag.alice.token })).agents.find((a) => a.name === n);

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-away-'));
    relay = await startRelay({ dir });
    base = relay.base;
    for (const n of ['alice', 'bob']) ag[n] = await call('POST', '/api/join', { body: { key: KEY, name: n, owner: n } });
  });
  after(async () => {
    await stop(relay?.p);
    rmDir(dir);
  });

  test('no away at first; an owner sets one with a time and a note, shown with the representative offline', async () => {
    assert.equal((await agentOf('bob')).away, null);
    const until = inMin(90);
    const r = await call('POST', '/api/away', { tok: ag.bob.token, body: { until, note: 'on holiday\u0007 back Monday' } });
    assert.equal(r.status, 200);
    assert.equal(r.agent.away.until, until);
    assert.equal(r.agent.away.note, 'on holiday back Monday', 'a clean line');
    assert.ok(Date.parse(r.agent.away.since) <= Date.now());
    const bob = await agentOf('bob');
    assert.equal(bob.online, false);
    assert.deepEqual(bob.away, r.agent.away, 'others see it, with no representative online');
  });

  test('changing the time keeps when it started; no time means until further notice', async () => {
    const before = (await agentOf('bob')).away;
    const r = await call('POST', '/api/away', { tok: ag.bob.token, body: { until: null, note: '' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.agent.away, { until: null, note: '', since: before.since });
  });

  test('bad values are refused in plain words', async () => {
    const bad = async (body, words) => {
      const r = await call('POST', '/api/away', { tok: ag.bob.token, body });
      assert.equal(r.status, 400, JSON.stringify(r));
      assert.match(r.error?.message || r.message || JSON.stringify(r), words);
    };
    await bad({ until: 'someday' }, /until is a time in the future/);
    await bad({ until: new Date(Date.now() - 60e3).toISOString() }, /until is a time in the future/);
    await bad({ until: inMin(31 * 24 * 60) }, /at most 30 days ahead/);
    await bad({ until: inMin(5), note: 5 }, /note is text/);
    assert.equal((await call('POST', '/api/away', { body: { until: inMin(5) } })).status, 401, 'a member only');
    assert.ok([401, 403].includes((await call('POST', '/api/away', { key: KEY, body: { until: inMin(5) } })).status), 'not a viewer');
  });

  test('off clears it; the audit log says away and back only (not each new time), never the note', async () => {
    const before = (await call('GET', '/api/audit?limit=1000', { key: KEY })).events.filter((e) => e.type === 'away').length;
    for (const m of [30, 40, 50]) await call('POST', '/api/away', { tok: ag.bob.token, body: { until: inMin(m), note: 'secret plans' } });
    const r = await call('POST', '/api/away', { tok: ag.bob.token, body: { off: true } });
    assert.equal(r.agent.away, null);
    assert.equal((await agentOf('bob')).away, null);
    const all = (await call('GET', '/api/audit?limit=1000', { key: KEY })).events.filter((e) => e.type === 'away');
    const au = all.slice(before);
    assert.deepEqual(au.map((e) => e.detail.replace(/until .*/, 'until …')), ['bob is back'], 'bob was away already: three new times, one "back"');
    assert.ok(all.some((e) => /^bob is away until \d{4}-/.test(e.detail)));
    assert.equal(all.at(-1).detail, 'bob is back');
    assert.ok(au.every((e) => !/secret|holiday/.test(JSON.stringify(e))), 'no note in the audit log');
    // off again: nothing to say
    await call('POST', '/api/away', { tok: ag.bob.token, body: { off: true } });
    assert.equal((await call('GET', '/api/audit?limit=1000', { key: KEY })).events.filter((e) => e.type === 'away').length, all.length);
  });

  test('an away ends by itself when its time has passed', async () => {
    const r = await call('POST', '/api/away', { tok: ag.alice.token, body: { until: new Date(Date.now() + 1500).toISOString() } });
    assert.ok(r.agent.away);
    await sleep(1700);
    assert.equal((await agentOf('alice')).away, null);
  });

  test('an ask keeps its neededBy; a reply and a post have none; bad ones are refused', async () => {
    const neededBy = inMin(45);
    const ask = await call('POST', '/api/messages', { tok: ag.alice.token, body: { to: ['bob'], text: 'the plan?', neededBy } });
    assert.equal(ask.status, 200, JSON.stringify(ask));
    assert.equal(ask.message.neededBy, neededBy);
    assert.equal((await call('GET', `/api/messages/${ask.message.id}`, { tok: ag.bob.token })).message.neededBy, neededBy);
    const reply = await call('POST', '/api/messages', { tok: ag.bob.token, body: { replyTo: ask.message.id, text: 'too old', neededBy, meta: { expired: true, unable: false, error: true } } });
    assert.equal(reply.status, 200);
    assert.equal(reply.message.neededBy, undefined);
    assert.deepEqual(reply.message.meta, { error: true, expired: true, unable: false });
    const post = await call('POST', '/api/messages', { tok: ag.alice.token, body: { text: 'hello all', neededBy } });
    assert.equal(post.message.neededBy, undefined);
    // a sender's clock a little off the relay's is forgiven: just past now is now, just past a week is a week
    const nearlyNow = await call('POST', '/api/messages', { tok: ag.alice.token, body: { to: ['bob'], text: 'x', neededBy: new Date(Date.now() - 30e3).toISOString() } });
    assert.ok(Date.parse(nearlyNow.message.neededBy) > Date.now() - 2000, nearlyNow.message.neededBy);
    const aWeek = await call('POST', '/api/messages', { tok: ag.alice.token, body: { to: ['bob'], text: 'x', neededBy: new Date(Date.now() + 7 * 864e5 + 30e3).toISOString() } });
    assert.ok(Date.parse(aWeek.message.neededBy) <= Date.now() + 7 * 864e5, 'clamped to a week');
    // in minutes: on the relay's own clock
    const mins = await call('POST', '/api/messages', { tok: ag.alice.token, body: { to: ['bob'], text: 'x', neededWithinMinutes: 30 } });
    assert.ok(Math.abs(Date.parse(mins.message.neededBy) - (Date.now() + 30 * 60e3)) < 5000, mins.message.neededBy);
    assert.equal((await call('POST', '/api/messages', { tok: ag.alice.token, body: { to: ['bob'], text: 'x', neededWithinMinutes: 0 } })).status, 400);
    for (const [v, words] of [['soon', /neededBy is a time in the future/], [new Date(Date.now() - 5 * 60e3).toISOString(), /neededBy is a time in the future/], [inMin(8 * 24 * 60), /at most 7 days ahead/]]) {
      const r = await call('POST', '/api/messages', { tok: ag.alice.token, body: { to: ['bob'], text: 'x', neededBy: v } });
      assert.equal(r.status, 400);
      assert.match(JSON.stringify(r), words);
    }
  });

  test('away holds across a restart', async () => {
    const until = inMin(120);
    await call('POST', '/api/away', { tok: ag.bob.token, body: { until, note: 'back at noon' } });
    await stop(relay.p);
    relay = await startRelay({ dir });
    base = relay.base;
    const bob = await agentOf('bob');
    assert.equal(bob.away.until, until);
    assert.equal(bob.away.note, 'back at noon');
  });

  test('the tools say so: sphere_ask takes needed_within_minutes; sphere_check and sphere_agents mention away', async () => {
    const { instruments } = await call('GET', '/api/instruments', { tok: ag.alice.token });
    const by = (n) => instruments.find((t) => t.name === n);
    assert.deepEqual(by('sphere_ask').inputSchema.properties.needed_within_minutes, { type: 'integer', minimum: 1, maximum: 10080, description: by('sphere_ask').inputSchema.properties.needed_within_minutes.description });
    assert.match(by('sphere_check').description, /away until when, offline since when, or expired/);
    assert.match(by('sphere_agents').description, /away until when/);
  });
});

describe('away on the Redis store', () => {
  let fake;
  const procs = [];
  let A, B;
  const at = (b) => caller(() => b);
  const ag = {};

  before(async () => {
    fake = await startFakeUpstash({ latencyMs: 2 });
    const env = { UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, SPHERE_REDIS_PREFIX: 'w:' };
    const [a, b] = await Promise.all([startRelay({ store: 'redis', env }), startRelay({ store: 'redis', env })]);
    procs.push(a.p, b.p);
    A = a.base;
    B = b.base;
    for (const n of ['alice', 'bob']) ag[n] = await at(A)('POST', '/api/join', { body: { key: KEY, name: n, owner: n } });
  });
  after(async () => {
    await Promise.all(procs.map((p) => stop(p)));
    await fake?.close();
  });

  test('an away set on one instance is seen on another', async () => {
    const until = inMin(60);
    assert.equal((await at(A)('POST', '/api/away', { tok: ag.bob.token, body: { until, note: 'offsite' } })).status, 200);
    let seen = null;
    for (let i = 0; i < 40 && !seen; i++) {
      seen = (await at(B)('GET', '/api/agents', { tok: ag.alice.token })).agents.find((a) => a.name === 'bob')?.away;
      if (!seen) await sleep(100);
    }
    assert.deepEqual([seen?.until, seen?.note], [until, 'offsite']);
  });
});
