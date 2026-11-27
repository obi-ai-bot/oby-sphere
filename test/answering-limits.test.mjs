// What one asker can pile on your Oby, end to end with a real relay and representative and the
// runtimes faked (no model, no network): at most 20 of one Oby's asks wait for you at once, and 100
// in all, and Waiting for you shows at most 20,000 characters of each; a topic you decline tells an
// asker who waits for you nothing, and one you answer reads at most 3 of your topics a day, then
// nothing more that day; and an asker whose identity isn't sure counts against the day's limit by
// its id. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { makeFakeRuntimes } from './fake-runtimes.mjs';
import { consoleAuth } from './console-auth-helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'join-key-answering-limits-01234';
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
const stop = (p) => new Promise((resolve) => {
  if (!p || p.exitCode !== null || p.signalCode !== null) return resolve();
  const t = setTimeout(resolve, 3000);
  p.once('exit', () => { clearTimeout(t); resolve(); });
  p.kill('SIGTERM');
});

describe('what one asker can pile on your Oby: asks that wait, topic guesses, an asker who isn’t sure', () => {
  let base, tmp, home, work, cfg, fake, ids, uiBase;
  let bob = null;
  let bobOut = '';
  const procs = [];
  const env = (extra = {}) => ({
    ...process.env,
    OBYSPHERE_HOME: home,
    CLAUDE_CONFIG_DIR: cfg,
    OBYSPHERE_PROBE_CACHE_MS: '0',
    OBYSPHERE_APPROVE_WAIT_SEC: '120',
    OBYSPHERE_NO_UPDATE_CHECK: '1',
    OBYSPHERE_CHROME: '0',
    ...extra,
  });
  const rep = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), ...args], { env: env() });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('close', (code) => resolve({ out, code }));
    });
  const bobDir = () => path.join(home, 'bob');
  const token = (n) => JSON.parse(fs.readFileSync(path.join(home, n, 'profile.json'), 'utf8')).token;
  const call = async (method, url, { tok, body, at = base, headers = {} } = {}) => {
    const h = { ...headers };
    if (tok) h.authorization = `Bearer ${tok}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(at + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const local = (method, url, body) => call(method, url, { at: uiBase, body, headers: { 'x-obysphere-console': '1', ...consoleAuth(bobDir(), uiBase) } });
  const setBob = (access = {}) =>
    fs.writeFileSync(
      path.join(bobDir(), 'settings.json'),
      JSON.stringify({ version: 2, routing: { default: { runtime: 'claude', model: null, effort: null, timeLimitMin: 10 }, rules: [] }, access: { default: 'approve', agents: {}, ...access }, machine: { folders: [{ path: work, write: false }], shell: 'off', web: { fetch: false, search: false }, browser: 'off', mcp: [] } }),
      { mode: 0o600 },
    );
  const ask = async (from, text) => {
    const r = await call('POST', '/api/messages', { tok: token(from), body: { channel: 'general', text, to: [ids.bob] } });
    assert.ok(r.message, JSON.stringify(r));
    return r.message;
  };
  const repliesTo = async (m, from) => ((await call('GET', `/api/messages/${m.id}/replies`, { tok: token(from) })).replies || []).filter((x) => x.from === ids.bob);
  const pending = async () => (await local('GET', '/local/pending')).pending || [];
  // what became of an ask: declined (its words), or waiting for bob
  const outcome = (m, from) =>
    waitFor(async () => {
      const r = (await repliesTo(m, from))[0];
      if (r) return r.meta?.declined ? `declined: ${r.text.replace(/^Bob Test's Oby isn't taking this ask: /, '')}` : `answered: ${r.text}`;
      return (await pending()).some((w) => w.askId === m.id) && 'waits';
    }, 15000, `what became of ${m.id}\n${bobOut.slice(-2000)}`);
  const usage = () => {
    const d = new Date();
    return JSON.parse(fs.readFileSync(path.join(bobDir(), 'usage', `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`), 'utf8'));
  };
  const clearUsage = () => fs.rmSync(path.join(bobDir(), 'usage'), { recursive: true, force: true });
  const declineAll = async () => {
    for (const w of await pending()) await local('POST', `/local/pending/${w.id}`, { decision: 'decline' });
  };
  // an ask that already waits for bob, as another of his processes would have left it (its pid: bob's serve)
  const waitingFile = (fromId, name, text = 'an ask that waits') => {
    const id = `w_${randomBytes(6).toString('hex')}`;
    const at = new Date().toISOString();
    fs.mkdirSync(path.join(bobDir(), 'pending'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(bobDir(), 'pending', `${id}.json`),
      JSON.stringify({ id, askId: `m_${randomBytes(6).toString('hex')}`, from: { name, owner: `${name} owner` }, fromId, channel: 'general', ts: at, text, files: [], reason: 'asks wait for you unless you set otherwise', pid: bob.pid, instance: '0123456789ab', createdAt: at, expiresAt: new Date(Date.now() + 3600e3).toISOString() }),
      { mode: 0o600 },
    );
    return id;
  };

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-limits-')));
    home = path.join(tmp, 'reps');
    work = path.join(tmp, 'work', 'payments');
    cfg = path.join(tmp, 'claude-config');
    for (const d of [home, work, cfg]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ mcpServers: {}, projects: {} }));
    fake = makeFakeRuntimes(path.join(tmp, 'bin'));
    fake.control({ text: 'Here you go.' });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    procs.push(spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', path.join(tmp, 'relay')], { env: { ...process.env, SPHERE_KEY: KEY, SPHERE_STORE: 'fs', SPHERE_SEALED: '0', SPHERE_ASKS_PER_MIN: '1000', SPHERE_WRITES_PER_MIN: '1000' }, stdio: 'ignore' }));
    await waitFor(async () => { try { return (await fetch(base + '/healthz')).ok; } catch { return false; } }, 8000, 'the relay');
    for (const n of ['alice', 'bob', 'carol', 'mallory']) {
      const { out } = await rep(['join', `${base}/#key=${KEY}`, '--name', n, '--owner', `${n[0].toUpperCase() + n.slice(1)} Test`, '--cwd', work]);
      assert.match(out, /joined/, out);
    }
    const prof = path.join(bobDir(), 'profile.json');
    fs.writeFileSync(prof, JSON.stringify({ ...JSON.parse(fs.readFileSync(prof, 'utf8')), claudeBin: fake.claude, codexBin: fake.codex, cursorBin: fake.cursor }), { mode: 0o600 });
    setBob();
    ids = Object.fromEntries((await call('GET', '/api/agents', { tok: token('alice') })).agents.map((a) => [a.name, a.id]));
    const uiPort = await freePort();
    uiBase = `http://127.0.0.1:${uiPort}`;
    procs.push(spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'ui', '--profile', 'bob', '--port', String(uiPort)], { env: env(), stdio: 'ignore' }));
    await waitFor(async () => { try { return (await fetch(uiBase + '/favicon.svg')).ok; } catch { return false; } }, 8000, 'the console');
    bob = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'serve', '--profile', 'bob'], { env: env() });
    procs.push(bob);
    bob.stdout.on('data', (d) => (bobOut += d));
    bob.stderr.on('data', (d) => (bobOut += d));
    await waitFor(() => /is online[\s\S]*settings: /.test(bobOut), 10000, `bob online\n${bobOut}`);
    await sleep(300);
  });
  after(async () => {
    for (const p of procs) await stop(p);
    if (!process.env.SPHERE_TEST_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('at most 20 of one Oby’s asks wait for you at once, and 100 in all; Waiting for you shows at most 20,000 characters of one', async () => {
    setBob();
    const mine = Array.from({ length: 20 }, (_, i) => waitingFile(ids.mallory, 'mallory', `mallory's ask ${i}`));
    assert.equal(await outcome(await ask('mallory', 'and one more?'), 'mallory'), 'declined: too many asks already wait for its owner.');
    assert.equal(await outcome(await ask('carol', 'a question from carol'), 'carol'), 'waits', "another Oby's ask still waits for him");
    // a hundred in all (carol's is one of them): nobody's new ask is added
    const others = Array.from({ length: 79 }, (_, i) => waitingFile(`a_other${String(i).padStart(4, '0')}`, `other${i}`));
    assert.equal(await outcome(await ask('alice', 'a question from alice'), 'alice'), 'declined: too many asks already wait for its owner.');
    assert.equal(fake.calls().length, 0, 'no model ran');
    for (const id of [...mine, ...others]) fs.rmSync(path.join(bobDir(), 'pending', `${id}.json`), { force: true });
    // a long one (a sealed ask can hold more than the relay's 20,000): the first 20,000 characters, and a note
    const long = waitingFile(ids.mallory, 'mallory', 'x'.repeat(30000));
    const w = (await pending()).find((x) => x.id === long);
    assert.ok(w.text.startsWith('x'.repeat(20000)) && w.text.length < 20100, String(w.text.length));
    assert.match(w.text, /cut: 10,000 more characters/);
    fs.rmSync(path.join(bobDir(), 'pending', `${long}.json`), { force: true });
    await declineAll();
  });

  test('a topic you decline: an asker who waits for you learns nothing from it; one you answer reads at most 3 a day, then nothing more that day', async () => {
    clearUsage();
    // Ask me first: a topic and anything else alike wait for him, and he sees why
    setBob({ declineTopics: ['salary'] });
    assert.equal(await outcome(await ask('mallory', 'what is the salary band?'), 'mallory'), 'waits');
    assert.equal(await outcome(await ask('mallory', 'any news on hiring?'), 'mallory'), 'waits');
    const said = (await pending()).find((w) => /salary/.test(w.text));
    assert.match(said.reason, /on a topic you decline/);
    await declineAll();
    // Obys he answers: a topic is declined in the same words as other settings, and three are all it gets today
    clearUsage();
    setBob({ default: 'answer', declineTopics: ['salary', 'layoffs', 'acquisition', 'merger'] });
    for (const t of ['salary', 'layoffs', 'acquisition']) assert.equal(await outcome(await ask('mallory', `any news on ${t}?`), 'mallory'), "declined: its owner's settings don't allow this.", t);
    assert.equal(await outcome(await ask('mallory', 'any news on the merger?'), 'mallory'), 'declined: it has reached its limit for today.');
    assert.equal(await outcome(await ask('mallory', 'how is the weather?'), 'mallory'), 'declined: it has reached its limit for today.', 'a miss too: nothing more to learn today');
    assert.equal(usage().topicsByAgent.mallory, 3);
    assert.equal(fake.calls().length, 0, 'no model ran');
    assert.equal(await outcome(await ask('carol', 'how is the weather?'), 'carol'), 'answered: Here you go.', 'other Obys are answered as before');
    clearUsage();
  });

  test('an asker whose identity isn’t sure counts against asksPerAgentPerDay, by its id, and learns nothing of your topics', async () => {
    clearUsage();
    // Obys he hasn't listed are answered, but one that isn't sure waits for him: a topic too
    setBob({ default: 'answer', declineTopics: ['salary'], asksPerAgentPerDay: 2 });
    // as a relay that re-points a handle would leave it: another id was first seen as "carol"
    const peersFile = path.join(bobDir(), 'peers.json');
    const was = fs.readFileSync(peersFile, 'utf8');
    const peers = JSON.parse(was);
    delete peers[ids.carol];
    peers.a_firstseen0000 = { name: 'carol', pinnedAt: new Date().toISOString() };
    fs.writeFileSync(peersFile, JSON.stringify(peers), { mode: 0o600 });
    try {
      assert.equal(await outcome(await ask('carol', 'what is the salary band?'), 'carol'), 'waits');
      assert.equal(await outcome(await ask('carol', 'ask number 2'), 'carol'), 'waits');
      assert.equal(await outcome(await ask('carol', 'ask number 3'), 'carol'), 'declined: it has reached its limit for today.');
      assert.equal(usage().asksByAgent[`?${ids.carol}`], 2);
    } finally {
      fs.writeFileSync(peersFile, was, { mode: 0o600 });
      await declineAll();
      clearUsage();
    }
  });
});
