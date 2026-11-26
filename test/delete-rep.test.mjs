// Your Oby forgets a deleted message too (#139): bob gets a direct message and an ask that waits
// for him from alice; alice deletes both; bob's notify/recent.jsonl, pending/ and console no longer
// hold them (Waiting for you says alice took the ask back), and his Oby doesn't answer. A deleted
// ask still in the queue isn't answered either. A real relay and fake runtimes (no model, no
// network); notifications go to a log. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { makeFakeRuntimes } from './fake-runtimes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const KEY = 'join-key-delete-rep-0123456789ab';
const ADMIN = 'admin-key-delete-rep-0123456789a';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p >= 4848 && p <= 4850 ? freePort() : p));
    });
  });
const waitFor = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
const stop = (p) =>
  new Promise((resolve) => {
    if (!p || p.exitCode !== null || p.signalCode !== null) return resolve();
    const t = setTimeout(resolve, 3000);
    p.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    p.kill('SIGTERM');
  });

describe('your Oby forgets a deleted message', () => {
  let tmp, home, work, cfg, fake, base, uiBase, ids;
  let bobOut = '';
  const procs = [];
  const page = new AbortController(); // bob's console page, open: its live stream is what hears his direct messages
  const env = () => ({
    ...process.env,
    HOME: path.join(tmp, 'home'),
    TMPDIR: tmp,
    OBYSPHERE_HOME: home,
    OBYSPHERE_APP_HOME: path.join(tmp, 'app'),
    CLAUDE_CONFIG_DIR: cfg,
    OBYSPHERE_PROBE_CACHE_MS: '0',
    OBYSPHERE_APPROVE_WAIT_SEC: '120',
    OBYSPHERE_NOTIFY_LOG: path.join(tmp, 'notify.jsonl'),
    OBYSPHERE_NOTIFY_COALESCE_MS: '100',
    OBYSPHERE_NO_UPDATE_CHECK: '1',
    OBYSPHERE_CHROME: '0',
  });
  const rep = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), ...args], { env: env() });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('close', (code) => resolve({ out, code }));
    });
  const token = (n) => JSON.parse(fs.readFileSync(path.join(home, n, 'profile.json'), 'utf8')).token;
  const bobDir = () => path.join(home, 'bob');
  const call = async (method, url, { tok, body, at = base, headers = {} } = {}) => {
    const h = { ...headers };
    if (tok) h.authorization = `Bearer ${tok}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(at + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const local = (method, url, body) => call(method, url, { at: uiBase, body, headers: { 'x-obysphere-console': '1' } });
  const recent = () => {
    try {
      return fs.readFileSync(path.join(bobDir(), 'notify', 'recent.jsonl'), 'utf8');
    } catch {
      return '';
    }
  };
  const pendingText = () => {
    const d = path.join(bobDir(), 'pending');
    return fs.existsSync(d) ? fs.readdirSync(d).map((n) => fs.readFileSync(path.join(d, n), 'utf8')).join('\n') : '';
  };
  const setBob = (access) =>
    fs.writeFileSync(
      path.join(bobDir(), 'settings.json'),
      JSON.stringify({
        version: 2,
        routing: { default: { runtime: 'claude', model: null, effort: null, timeLimitMin: 120 }, rules: [] },
        access,
        machine: { folders: [{ path: work, write: false }], shell: 'off', web: { fetch: false, search: false }, browser: 'off', mcp: [] },
      }),
      { mode: 0o600 },
    );

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-delete-rep-')));
    home = path.join(tmp, 'reps');
    work = path.join(tmp, 'work', 'payments');
    cfg = path.join(tmp, 'claude-config');
    for (const d of [home, work, cfg, path.join(tmp, 'home')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ mcpServers: {}, projects: {} }));
    fake = makeFakeRuntimes(path.join(tmp, 'bin'));
    fake.control({ text: 'The fake answer.' });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const relay = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', path.join(tmp, 'relay')], {
      env: { ...process.env, HOME: path.join(tmp, 'home'), SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_STORE: 'fs', SPHERE_SEALED: '0', SPHERE_ASKS_PER_MIN: '1000', SPHERE_WRITES_PER_MIN: '1000' },
      stdio: 'ignore',
    });
    procs.push(relay);
    await waitFor(async () => {
      try {
        return (await fetch(base + '/healthz')).ok;
      } catch {
        return false;
      }
    }, 8000, 'the relay');
    for (const n of ['alice', 'bob']) {
      const { out } = await rep(['join', `${base}/#key=${KEY}`, '--name', n, '--owner', `${n[0].toUpperCase() + n.slice(1)} Test`, '--cwd', work]);
      assert.match(out, /joined/, out);
    }
    const prof = path.join(bobDir(), 'profile.json');
    fs.writeFileSync(prof, JSON.stringify({ ...JSON.parse(fs.readFileSync(prof, 'utf8')), claudeBin: fake.claude, codexBin: fake.codex, cursorBin: fake.cursor }), { mode: 0o600 });
    setBob({ default: 'approve', agents: {} }); // every ask waits for bob
    ids = Object.fromEntries((await call('GET', '/api/agents', { tok: token('alice') })).agents.map((a) => [a.name, a.id]));
    // bob's console, and his Oby in a process of its own (serve)
    const uiPort = await freePort();
    uiBase = `http://127.0.0.1:${uiPort}`;
    procs.push(spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'ui', '--profile', 'bob', '--port', String(uiPort)], { env: env(), stdio: 'ignore' }));
    await waitFor(async () => {
      try {
        return (await fetch(uiBase + '/favicon.svg')).ok;
      } catch {
        return false;
      }
    }, 8000, 'the console');
    fetch(uiBase + '/api/stream', { signal: page.signal }).then(async (r) => { for await (const _ of r.body); }).catch(() => {});
    const bob = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'serve', '--profile', 'bob'], { env: env() });
    procs.push(bob);
    bob.stdout.on('data', (d) => (bobOut += d));
    bob.stderr.on('data', (d) => (bobOut += d));
    await waitFor(() => /is online[\s\S]*settings: /.test(bobOut), 10000, `bob online\n${bobOut}`);
    await sleep(300);
  });
  after(async () => {
    page.abort();
    for (const p of procs) await stop(p);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test("a direct message and an ask that waits for bob: deleted, they leave bob's notifications, Waiting for you and console, and his Oby doesn't answer", async () => {
    const dm = (await call('POST', '/api/dm', { tok: token('alice'), body: { with: 'bob' } })).channel;
    const note = (await call('POST', '/api/messages', { tok: token('alice'), body: { channel: dm.name, text: 'Just for you: the CORMORANT-17 password hint' } })).message;
    const ask = (await call('POST', '/api/messages', { tok: token('alice'), body: { to: [ids.bob], text: 'Could you check PELICAN-23 for me?' } })).message;
    // bob's machine keeps both: a notification of each (with the message's id) and the ask in Waiting for you
    await waitFor(() => recent().includes('CORMORANT-17') && recent().includes('PELICAN-23'), 15000, `both notifications\n${recent()}\n${bobOut.slice(-2000)}`);
    const entries = recent().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(entries.find((e) => e.type === 'direct').messages, [note.id]);
    assert.deepEqual(entries.find((e) => e.type === 'waiting').messages, [ask.id]);
    const w = await waitFor(async () => ((await local('GET', '/local/pending')).pending || []).find((x) => x.askId === ask.id), 10000, 'the ask in Waiting for you');
    assert.match(pendingText(), /PELICAN-23/);
    assert.equal((await call('GET', `/api/messages/${ask.id}`, { tok: token('alice') })).message.waiting?.for, 'owner');

    // alice deletes both
    for (const m of [note, ask]) assert.equal((await call('DELETE', `/api/messages/${m.id}`, { tok: token('alice') })).status, 200);

    // gone from bob's notifications (what the console's bell reads too) and from Waiting for you
    await waitFor(() => !recent().includes('CORMORANT-17') && !recent().includes('PELICAN-23'), 10000, `the notifications to go\n${recent()}`);
    assert.ok(!recent().includes(note.id) && !recent().includes(ask.id));
    const shown = JSON.stringify((await local('GET', '/local/notifications')).notifications);
    assert.ok(!/CORMORANT|PELICAN/.test(shown), shown);
    const after = await waitFor(async () => {
      const r = await local('GET', '/local/pending');
      return !(r.pending || []).some((x) => x.askId === ask.id) && r;
    }, 10000, 'the ask to leave Waiting for you');
    assert.deepEqual(after.withdrawn.map((x) => [x.id, x.from.name, x.from.owner]), [[w.id, 'alice', 'Alice Test']], 'Waiting for you says alice took it back');
    await waitFor(() => /alice took this ask back: not answered/.test(bobOut), 5000, `bob's log\n${bobOut.slice(-2000)}`);
    assert.ok(!pendingText().includes('PELICAN-23'), 'no words kept to say so');
    // bob's console shows the tombstones
    const thread = await call('GET', `/api/messages?channel=${dm.name}`, { at: uiBase });
    assert.ok(thread.messages.find((m) => m.id === note.id).deleted);
    assert.ok(!JSON.stringify(thread).includes('CORMORANT'));
    // and his Oby didn't answer: no reply, no runtime run
    await sleep(500);
    assert.equal((await call('GET', `/api/messages/${ask.id}`, { tok: token('alice') })).replies.length, 0);
    assert.ok(!fake.calls().some((c) => String(c.prompt).includes('PELICAN-23')));
  });

  test("a deleted ask still in the queue isn't answered", async () => {
    setBob({ default: 'answer', agents: {} });
    await sleep(2500); // the settings apply at the next ask
    fake.control({ text: 'The fake answer.', sleepMs: 3000 });
    const first = (await call('POST', '/api/messages', { tok: token('alice'), body: { to: [ids.bob], text: 'First: answer this one, HERON-31' } })).message;
    await waitFor(() => fake.calls().some((c) => String(c.prompt).includes('HERON-31')) || /HERON-31/.test(bobOut), 15000, `the first ask to run\n${bobOut.slice(-2000)}`);
    const second = (await call('POST', '/api/messages', { tok: token('alice'), body: { to: [ids.bob], text: 'Second: never mind, EGRET-32' } })).message;
    await waitFor(() => /EGRET-32/.test(bobOut), 10000, 'the second ask to come in');
    assert.equal((await call('DELETE', `/api/messages/${second.id}`, { tok: token('alice') })).status, 200);
    // the first is answered; the second, taken back while it waited its turn, never runs
    await waitFor(async () => (await call('GET', `/api/messages/${first.id}`, { tok: token('alice') })).replies.length === 1, 20000, `the first answer\n${bobOut.slice(-2000)}`);
    await sleep(1500);
    assert.ok(!fake.calls().some((c) => String(c.prompt).includes('EGRET-32')), 'the runtime never ran it');
    assert.equal((await call('GET', `/api/messages/${second.id}`, { tok: token('alice') })).replies.length, 0);
    fake.control({ text: 'The fake answer.' });
  });
});
