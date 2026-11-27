// Lockdown, end to end with a real relay, the owner's console and representative, and the runtimes
// faked (no model, no network): while it's on, every ask goes to Claude Code with nothing but the
// folders (never Codex or Cursor, never "everything you allow"); a decision made before it began,
// a held ask's included, counts no more, and the ask waits for its owner again; an answer kept for
// a held ask isn't sent; an answer running when it began is stopped, and its words never sent; its
// session's Sphere tools stop asking others and sending files; lockdown.json removed or damaged
// doesn't lift it, and the owner is told; and the Sphere and the route preview show it. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { makeFakeRuntimes } from './fake-runtimes.mjs';
import { consoleAuth } from './console-auth-helpers.mjs';
import { mcpSession } from './mcp-protocol-helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'join-key-lockdown-0123456789abcd';
const RETRY_MS = 100;
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

describe('lockdown, end to end', () => {
  let base, tmp, home, work, cfg, fake, notifyLog, ids, uiBase, proxyBase;
  let bob = null;
  let bobOut = '';
  const procs = [];
  // bob's way to the relay: everything passes, except his posts while failReplies is on
  const proxy = { failReplies: false, refused: 0 };
  const env = (extra = {}) => ({
    ...process.env,
    OBYSPHERE_HOME: home,
    CLAUDE_CONFIG_DIR: cfg,
    OBYSPHERE_PROBE_CACHE_MS: '0',
    OBYSPHERE_APPROVE_WAIT_SEC: '60',
    OBYSPHERE_RETRY_MS: String(RETRY_MS),
    OBYSPHERE_NOTIFY_LOG: notifyLog,
    OBYSPHERE_NOTIFY_COALESCE_MS: '100',
    OBYSPHERE_NO_UPDATE_CHECK: '1',
    OBYSPHERE_CHROME: '0',
    ...extra,
  });
  const rep = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), ...args], { env: env() });
      let out = '';
      let stdout = '';
      p.stdout.on('data', (d) => ((out += d), (stdout += d)));
      p.stderr.on('data', (d) => (out += d));
      p.on('close', (code) => resolve({ out, stdout, code }));
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
  // bob trusts alice with a full shell, writes and the web; Obys he hasn't listed wait for him
  const settings = (o = {}) => ({
    version: 2,
    routing: { default: { runtime: 'claude', model: null, effort: null, timeLimitMin: 10 }, rules: [] },
    access: { default: 'approve', agents: { alice: 'trust' } },
    machine: { folders: [{ path: work, write: true }], shell: 'full', web: { fetch: true, search: false }, browser: 'off', mcp: [] },
    ...o,
  });
  const setBob = (s = settings()) => fs.writeFileSync(path.join(bobDir(), 'settings.json'), JSON.stringify(s), { mode: 0o600 });
  const startBob = async () => {
    await stop(bob);
    bobOut = '';
    bob = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'serve', '--profile', 'bob'], { env: env() });
    procs.push(bob);
    bob.stdout.on('data', (d) => (bobOut += d));
    bob.stderr.on('data', (d) => (bobOut += d));
    await waitFor(() => /is online[\s\S]*settings: /.test(bobOut), 10000, `bob online\n${bobOut}`);
    await sleep(300);
  };
  const ask = async (text, from = 'alice') => {
    const r = await call('POST', '/api/messages', { tok: token(from), body: { channel: 'general', text, to: [ids.bob] } });
    assert.ok(r.message, JSON.stringify(r));
    return r.message;
  };
  const repliesTo = async (m, from = 'alice') => ((await call('GET', `/api/messages/${m.id}/replies`, { tok: token(from) })).replies || []).filter((x) => x.from === ids.bob);
  const replyTo = (m, ms = 20000) => waitFor(async () => (await repliesTo(m))[0], ms, `a reply to ${m.id}\n${bobOut.slice(-2500)}`);
  const runsFor = (text) => fake.calls().filter((c) => c.prompt?.includes(text));
  const runFor = (text) => waitFor(() => runsFor(text).at(-1), 15000, `the run for "${text}"\n${bobOut.slice(-2000)}`);
  const pending = async (askId) => ((await local('GET', '/local/pending')).pending || []).find((x) => x.askId === askId);
  const waiting = (m) => waitFor(() => pending(m.id), 15000, `${m.id} in Waiting for you\n${bobOut.slice(-2500)}`);
  const notes = () => (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((l) => l.way === 'console');
  const toolsOf = (run) => String(run.argv[run.argv.indexOf('--tools') + 1] || '').split(',');
  const lock = async (on = true) => assert.equal((await local('POST', '/local/lockdown', { on })).status, 200);
  const heldFile = (id) => path.join(bobDir(), 'held', `${id}.json`);
  const keptFile = (id) => path.join(bobDir(), 'held', `${id}.answer.json`);

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-lockdown-')));
    home = path.join(tmp, 'reps');
    work = path.join(tmp, 'work', 'payments');
    cfg = path.join(tmp, 'claude-config');
    notifyLog = path.join(tmp, 'notify.jsonl');
    for (const d of [home, work, cfg]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ mcpServers: {}, projects: {} }));
    fake = makeFakeRuntimes(path.join(tmp, 'bin'));
    fake.control({ text: 'Here you go.' });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    procs.push(
      spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', path.join(tmp, 'relay')], {
        env: { ...process.env, SPHERE_KEY: KEY, SPHERE_STORE: 'fs', SPHERE_SEALED: '0', SPHERE_ASKS_PER_MIN: '1000', SPHERE_WRITES_PER_MIN: '1000' },
        stdio: 'ignore',
      }),
    );
    await waitFor(async () => { try { return (await fetch(base + '/healthz')).ok; } catch { return false; } }, 8000, 'the relay');
    const relay = new URL(base);
    const px = http.createServer((req, res) => {
      if (proxy.failReplies && req.method === 'POST' && req.url === '/api/messages') {
        proxy.refused++;
        req.resume();
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'the relay is busy', code: 'unavailable' }));
      }
      const up = http.request({ host: relay.hostname, port: relay.port, path: req.url, method: req.method, headers: { ...req.headers, host: relay.host } }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on('error', () => res.destroy());
      req.pipe(up);
    });
    await new Promise((r) => px.listen(0, '127.0.0.1', r));
    procs.push({ kill: () => (px.close(), px.closeAllConnections?.()), exitCode: null, signalCode: null, once: () => {} });
    proxyBase = `http://127.0.0.1:${px.address().port}`;
    for (const n of ['alice', 'carol']) {
      const { out } = await rep(['join', `${base}/#key=${KEY}`, '--name', n, '--owner', `${n[0].toUpperCase() + n.slice(1)} Test`, '--cwd', work]);
      assert.match(out, /joined/, out);
    }
    const { out } = await rep(['join', `${proxyBase}/#key=${KEY}`, '--name', 'bob', '--owner', 'Bob Test', '--cwd', work]);
    assert.match(out, /joined/, out);
    const prof = path.join(bobDir(), 'profile.json');
    fs.writeFileSync(prof, JSON.stringify({ ...JSON.parse(fs.readFileSync(prof, 'utf8')), claudeBin: fake.claude, codexBin: fake.codex, cursorBin: fake.cursor }), { mode: 0o600 });
    setBob();
    const { agents } = await call('GET', '/api/agents', { tok: token('alice') });
    ids = Object.fromEntries(agents.map((a) => [a.name, a.id]));
    const uiPort = await freePort();
    uiBase = `http://127.0.0.1:${uiPort}`;
    procs.push(spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'ui', '--profile', 'bob', '--port', String(uiPort)], { env: env(), stdio: 'ignore' }));
    await waitFor(async () => { try { return (await fetch(uiBase + '/favicon.svg')).ok; } catch { return false; } }, 8000, 'the console');
    await startBob();
  });
  after(async () => {
    for (const p of procs) await stop(p);
    if (!process.env.SPHERE_TEST_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('every ask goes to Claude Code with nothing but the folders: no Codex or Cursor route, no "everything you allow"; the Sphere and the route preview show it', async () => {
    // Codex answers by default, Cursor carol's asks, and Codex when the runtime can't answer
    setBob(settings({
      routing: { default: { runtime: 'codex', model: null, effort: null, timeLimitMin: 10 }, rules: [{ name: 'carol', when: { from: ['carol'] }, use: { runtime: 'cursor', model: null } }] },
      availability: { whenUnable: 'other', otherRuntime: 'codex' },
    }));
    await sleep(2500); // the Sphere is told the settings as they are
    const bobOnRelay = async () => (await call('GET', '/api/agents', { tok: token('alice') })).agents.find((a) => a.id === ids.bob);
    assert.ok((await bobOnRelay()).declared.runtimes.includes('codex'), 'before: Codex is declared');
    await lock();
    // what the Sphere shows of bob: no shell, no writes, Claude Code only, every ask waits
    const d = await waitFor(async () => { const a = await bobOnRelay(); return !a.declared.tools.includes('shell:full') && a.declared; }, 8000, 'the Sphere to be told');
    assert.deepEqual(d.tools, ['Read', 'Glob', 'Grep']);
    assert.deepEqual(d.runtimes, ['claude']);
    assert.equal(d.approve, true);
    // the route preview says so too
    const pv = await local('POST', '/local/route-preview', { text: 'review this', from: 'alice' });
    assert.equal(pv.use.runtime, 'claude', JSON.stringify(pv));
    assert.match(pv.note, /^Locked down/);
    // alice, trusted, waits like anyone, and nothing risky is offered
    const m = await ask('LOCK-A summarise the repo');
    const w = await waiting(m);
    assert.equal(w.risky, false, '"everything you allow" is not offered');
    const t = await local('POST', `/local/pending/${w.id}`, { decision: 'trust' });
    assert.equal(t.status, 400, 'and not taken');
    assert.match(t.error, /locked down/i);
    assert.equal((await local('POST', `/local/pending/${w.id}`, { decision: 'answer' })).status, 200);
    const run = await runFor('LOCK-A summarise the repo');
    assert.equal(run.bin, 'claude', 'Claude Code, not Codex');
    assert.deepEqual(toolsOf(run), ['Read', 'Glob', 'Grep']);
    await replyTo(m);
    // carol's rule (Cursor) gives way too
    const c = await ask('LOCK-A for carol', 'carol');
    const wc = await waitFor(() => pending(c.id), 15000, 'carol waits');
    await local('POST', `/local/pending/${wc.id}`, { decision: 'answer' });
    assert.equal((await runFor('LOCK-A for carol')).bin, 'claude');
    assert.ok(runsFor('LOCK-A').every((r) => r.bin === 'claude'), 'Codex and Cursor never ran');
    await lock(false);
    setBob();
  });

  test('a decision made before lockdown counts no more: a held ask you let use everything waits for you again, and then Claude Code answers it', async () => {
    setBob(settings({ routing: { default: { runtime: 'codex', model: null, effort: null, timeLimitMin: 10 }, rules: [] }, access: { default: 'approve', agents: {} } }));
    fake.control({ text: 'Here you go.', failNext: { codex: ['credit'] } });
    const m = await ask('LOCK-B what changed?');
    const w = await waiting(m);
    await local('POST', `/local/pending/${w.id}`, { decision: 'trust' }); // before lockdown
    await waitFor(() => fs.existsSync(heldFile(m.id)), 15000, `the ask held\n${bobOut.slice(-1500)}`);
    assert.equal(JSON.parse(fs.readFileSync(heldFile(m.id), 'utf8')).approved, 'trust');
    await lock();
    // tried again while locked down: back in Waiting for you, with nothing risky offered, and no run
    const again = await waitFor(() => pending(m.id), 30000, `the held ask waits for bob again\n${bobOut.slice(-2500)}`);
    assert.equal(again.risky, false);
    assert.equal(runsFor('LOCK-B what changed?').length, 1, 'only the run that failed before');
    assert.match(bobOut, /before lockdown/);
    await local('POST', `/local/pending/${again.id}`, { decision: 'answer' });
    const r = await replyTo(m);
    assert.equal(r.text, 'Here you go.');
    const runs = runsFor('LOCK-B what changed?');
    assert.deepEqual(runs.map((x) => x.bin), ['codex', 'claude']);
    assert.deepEqual(toolsOf(runs.at(-1)), ['Read', 'Glob', 'Grep']);
    await lock(false);
    setBob();
    fake.control({ text: 'Here you go.' });
  });

  test('an answer kept for a held ask is never sent once lockdown is on: the ask waits for him, and is answered again under lockdown', async () => {
    setBob(settings({ access: { default: 'answer', agents: {} } }));
    fake.control({ fail: { claude: 'limit' }, resetInSec: 1 });
    const m = await ask('LOCK-C what is in payments?');
    await waitFor(() => fs.existsSync(heldFile(m.id)), 10000, `held\n${bobOut.slice(-2000)}`);
    // the runtime is back, but the relay refuses bob's reply: the answer is kept
    proxy.failReplies = true;
    fake.control({ text: 'KEPT-ANSWER-0451' });
    await waitFor(() => fs.existsSync(keptFile(m.id)), 15000, `the answer kept\n${bobOut.slice(-2000)}`);
    await lock();
    proxy.failReplies = false;
    const w = await waiting(m);
    assert.equal((await repliesTo(m)).length, 0, 'nothing was sent');
    // his OK, given under lockdown, doesn't send what was made before it: the model answers again
    fake.control({ text: 'ANSWERED-UNDER-LOCKDOWN' });
    await local('POST', `/local/pending/${w.id}`, { decision: 'answer' });
    const r = await replyTo(m);
    assert.equal(r.text, 'ANSWERED-UNDER-LOCKDOWN', 'answered again, not the kept answer');
    assert.deepEqual(toolsOf(runsFor('LOCK-C what is in payments?').at(-1)), ['Read', 'Glob', 'Grep']);
    assert.ok(!fs.existsSync(keptFile(m.id)), 'the kept answer is gone');
    assert.match(bobOut, /kept answer dropped: you're locked down/);
    await lock(false);
    setBob();
    fake.control({ text: 'Here you go.' });
  });

  test('an answer running when lockdown begins is stopped, its words never sent; it waits for him; its session asks no other Oby and sends no file', async () => {
    setBob();
    fake.control({ text: 'Done with the migration.', sleepMs: 8000 });
    const m = await ask('LOCK-D run the migration');
    const run = await runFor('LOCK-D run the migration');
    assert.ok(toolsOf(run).includes('Bash'), 'trusted: a full shell');
    await lock();
    const w = await waiting(m);
    assert.ok(w, 'it waits for bob now');
    assert.match(bobOut, /lockdown[^\n]*stopped/i);
    await sleep(9000); // past the time the run would have answered
    assert.equal((await repliesTo(m)).length, 0, 'its words were never sent');
    // the session's own Sphere tools, started as that run started them, while locked down
    const s = mcpSession([path.join(ROOT, 'rep.mjs'), 'mcp', '--profile', 'bob', '--as-session'], { ...env(), ...run.mcp.mcpServers.obysphere.env });
    try {
      await s.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      s.notify('notifications/initialized');
      const said = async (id, name, args) => (await s.request(id, 'tools/call', { name, arguments: args })).result;
      const a = await said(2, 'sphere_ask', { agent: 'carol', message: 'what do you know?', wait_seconds: 1 });
      assert.equal(a.isError, true);
      assert.match(a.content[0].text, /locked down/i);
      const f = await said(3, 'sphere_attach', { name: 'x.md', content: 'hello' });
      assert.equal(f.isError, true);
      assert.match(f.content[0].text, /locked down/i);
    } finally {
      s.kill();
    }
    await local('POST', `/local/pending/${w.id}`, { decision: 'decline' });
    await lock(false);
    fake.control({ text: 'Here you go.' });
  });

  test('lockdown.json removed or damaged doesn’t lift it: kept on, put back, and he is told; only lifting it does', async () => {
    setBob();
    const file = path.join(bobDir(), 'lockdown.json');
    const on = await rep(['lockdown', '--profile', 'bob']);
    assert.equal(on.code, 0, on.out);
    const status = async () => JSON.parse((await rep(['security', '--profile', 'bob', '--json', '--no-scan'])).stdout).lockdown;
    // removed: still on, and put back
    fs.rmSync(file);
    const l1 = await status();
    assert.ok(l1, 'still locked down');
    assert.ok(fs.existsSync(file), 'put back');
    const check = JSON.parse((await rep(['security', '--profile', 'bob', '--json', '--no-scan'])).stdout).checks.find((c) => c.id === 'lockdown');
    assert.match(check.detail, /removed or changed/);
    // damaged: still on
    fs.writeFileSync(file, 'not json');
    assert.ok(await status(), 'still locked down');
    // alice, trusted, still waits for him
    const m = await ask('LOCK-E still locked?');
    const w = await waiting(m);
    await local('POST', `/local/pending/${w.id}`, { decision: 'decline' });
    // every copy removed while his Oby runs: it puts lockdown back from what it saw, and tells him
    for (const f of [file, path.join(bobDir(), 'security', 'lockdown.json')]) fs.rmSync(f, { force: true });
    await waitFor(() => fs.existsSync(file), 5000, `lockdown put back\n${bobOut.slice(-1500)}`);
    const n = await waitFor(() => notes().find((x) => /lockdown/i.test(x.title)), 8000, 'he is told');
    assert.match(n.title, /still on/i);
    // lifted for real: gone, and stays gone
    const off = await rep(['lockdown', '--off', '--profile', 'bob']);
    assert.equal(off.code, 0, off.out);
    await sleep(1500);
    assert.ok(!fs.existsSync(file), 'lifted');
    assert.equal(await status(), null);
    await waitFor(() => /lockdown lifted/i.test(bobOut), 5000, `his Oby says so\n${bobOut.slice(-1500)}`);
  });
});
