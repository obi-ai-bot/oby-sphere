// An Oby that can't answer an ask alone hands it to its owner (sphere_ask_owner), end to end: a real
// relay and representative, Claude Code faked (no model, no network) and paused while the test plays
// the model's part through the answering session's own MCP server, as Claude Code would call it. The
// ask goes to Waiting for you with the Oby's note, the asker is told it waits for the owner, the
// owner is notified, and what the Oby wrote is never sent; then the owner answers it, lets it try
// again or declines, or doesn't answer in time. Once per ask, at most 3 of one asker's a day, and
// only when the owner's settings allow it. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { makeFakeRuntimes } from './fake-runtimes.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'join-key-ask-owner-0123456789abc';
const NOTE = 'Wants the pull requests waiting on their review: I can’t see GitHub from here.';
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

// an MCP client over stdio, for a server started as Claude Code starts it
function mcpClient(command, args, env) {
  const p = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  let n = 0;
  const waiting = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.id !== undefined && waiting.has(m.id)) {
        waiting.get(m.id)(m);
        waiting.delete(m.id);
      }
    }
  });
  const req = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++n;
      waiting.set(id, resolve);
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return {
    proc: p,
    tools: async () => (await req('tools/list')).result.tools.map((t) => t.name),
    call: async (name, args) => {
      const r = await req('tools/call', { name, arguments: args });
      return r.result?.content?.[0]?.text ?? r.error?.message ?? '';
    },
    close: () => p.kill(),
  };
}

describe('an ask the Oby hands to its owner, end to end', () => {
  let relay, base, tmp, home, work, cfg, fake, notifyLog, ids, uiBase;
  let bob = null;
  let bobOut = '';
  const procs = [];
  const env = (extra = {}) => ({
    ...process.env,
    OBYSPHERE_HOME: home,
    CLAUDE_CONFIG_DIR: cfg,
    OBYSPHERE_PROBE_CACHE_MS: '0',
    OBYSPHERE_APPROVE_WAIT_SEC: '60',
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
  // bob answers alice's asks; askOwner as given (absent: the default)
  const setBob = (availability) =>
    fs.writeFileSync(
      path.join(bobDir(), 'settings.json'),
      JSON.stringify({
        version: 2,
        routing: { default: { runtime: 'claude', model: null, effort: null, timeLimitMin: 120 }, rules: [] },
        access: { default: 'answer', agents: {} },
        machine: { folders: [{ path: work, write: false }], shell: 'off', web: { fetch: false, search: false }, browser: 'off', mcp: [] },
        ...(availability ? { availability } : {}),
      }),
      { mode: 0o600 },
    );
  const startBob = async (extra = {}) => {
    await stop(bob);
    bobOut = '';
    bob = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'serve', '--profile', 'bob'], { env: env(extra) });
    procs.push(bob);
    bob.stdout.on('data', (d) => (bobOut += d));
    bob.stderr.on('data', (d) => (bobOut += d));
    await waitFor(() => /is online[\s\S]*settings: /.test(bobOut), 10000, `bob online\n${bobOut}`);
    await sleep(300);
  };
  const ask = async (text) => {
    const r = await call('POST', '/api/messages', { tok: token('alice'), body: { channel: 'general', text, to: [ids.bob] } });
    assert.ok(r.message, JSON.stringify(r));
    return r.message;
  };
  const repliesTo = async (id) => (await call('GET', `/api/messages/${id}/replies`, { tok: token('alice') })).replies?.filter((x) => x.from === ids.bob) || [];
  const replyTo = (id, ms = 20000) => waitFor(async () => (await repliesTo(id))[0], ms, `a reply to ${id}\n${bobOut.slice(-3000)}`);
  const messageOf = async (id) => (await call('GET', `/api/messages/${id}`, { tok: token('alice') })).message;
  const pendingFor = (askId) => waitFor(async () => ((await local('GET', '/local/pending')).pending || []).find((x) => x.askId === askId), 15000, `${askId} in Waiting for you\n${bobOut.slice(-3000)}`);
  const notes = () => (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((l) => l.way === 'console');
  // the run Claude Code was started for, for this ask (the fake records it before it waits)
  const runFor = (text) => waitFor(() => fake.calls().filter((c) => c.prompt?.includes(text)).at(-1), 15000, `the run for "${text}"\n${bobOut.slice(-2000)}`);
  // its answering session's own MCP server, as Claude Code starts it
  const session = (run) => {
    const { command, args, env: e } = run.mcp.mcpServers.obysphere;
    const c = mcpClient(command, args, env(e));
    procs.push(c.proc);
    return c;
  };
  // an ask whose run hands it to bob
  const handed = async (text) => {
    const m = await ask(text);
    const run = await runFor(text);
    const s = session(run);
    assert.match(await s.call('sphere_ask_owner', { note: NOTE, need: 'access' }), /^Done: Bob Test is told, and can answer it themselves, change what you may reach and let you try again, or decline\./);
    s.close();
    return { m, run, w: await pendingFor(m.id) };
  };

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-ask-owner-')));
    home = path.join(tmp, 'reps');
    work = path.join(tmp, 'work', 'payments');
    cfg = path.join(tmp, 'claude-config');
    notifyLog = path.join(tmp, 'notify.jsonl');
    for (const d of [home, work, cfg]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ mcpServers: {}, projects: {} }));
    fake = makeFakeRuntimes(path.join(tmp, 'bin'));
    // the model's words, after a pause the test plays its part in
    fake.control({ text: 'I can’t see GitHub from here, so I asked Bob.', sleepMs: 2500 });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    relay = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', path.join(tmp, 'relay')], {
      env: { ...process.env, SPHERE_KEY: KEY, SPHERE_STORE: 'fs', SPHERE_SEALED: '0', SPHERE_ASKS_PER_MIN: '1000', SPHERE_WRITES_PER_MIN: '1000' },
      stdio: 'ignore',
    });
    procs.push(relay);
    await waitFor(async () => { try { return (await fetch(base + '/healthz')).ok; } catch { return false; } }, 8000, 'the relay');
    for (const n of ['alice', 'bob']) {
      const { out } = await rep(['join', `${base}/#key=${KEY}`, '--name', n, '--owner', `${n[0].toUpperCase() + n.slice(1)} Test`, '--cwd', work]);
      assert.match(out, /joined/, out);
    }
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

  let first;
  test('the Oby hands it over: Waiting for you with its note, the asker told it waits, the owner notified, and nothing it wrote sent', async () => {
    const m = await ask('Which pull requests wait for my review?');
    const run = await runFor('Which pull requests wait for my review?');
    const e = run.mcp.mcpServers.obysphere.env;
    assert.deepEqual([e.SPHERE_ANSWERING, e.SPHERE_OWNER_HELP], [m.id, '1']);
    assert.match(run.system, /sphere_ask_owner \(hand this ask to your owner\)/);
    assert.match(run.system, /hand it to them with sphere_ask_owner, with a short note on what's asked and what's missing, instead of telling the asker to reach "Bob Test" some other way/);
    assert.match(run.system, /say what's missing in plain words \("I can't see GitHub from here"/);
    const s = session(run);
    assert.ok((await s.tools()).includes('sphere_ask_owner'));
    assert.match(await s.call('sphere_ask_owner', { note: NOTE, need: 'access' }), /^Done: Bob Test is told/);
    // once per ask
    assert.equal(await s.call('sphere_ask_owner', { note: 'again' }), "You already handed this ask to Bob Test. Answer with what you have, and say plainly what's missing.");
    s.close();
    const w = await pendingFor(m.id);
    assert.deepEqual([w.reason, w.stuck, w.always], ['stuck', { note: NOTE, need: 'access' }, false]);
    assert.equal(w.text, 'Which pull requests wait for my review?');
    // the asker's side: it waits for bob, until when; no reply, and what the Oby wrote never went
    await waitFor(async () => (await messageOf(m.id)).waiting?.for === 'owner', 8000, 'the relay told it waits');
    await sleep(500);
    assert.deepEqual(await repliesTo(m.id), []);
    // bob is told what his Oby needs
    const n = await waitFor(() => notes().find((x) => x.type === 'waiting' && x.title === "Your Oby needs you for @alice's ask"), 8000, 'the notification');
    assert.equal(n.body, NOTE);
    assert.match(n.link, /#page=you$/, 'a click opens Waiting for you');
    assert.match(bobOut, /→ handed to you: Wants the pull requests waiting on their review/);
    // Claude Code's start of the day hears it too
    const hook = JSON.parse((await rep(['inbox', '--hook', '--profile', 'bob'])).out || '{}');
    assert.match(JSON.stringify(hook), /1 ask waits for you/);
    first = { m, w };
  });

  test('he answers it himself: the asker reads his words, and the note is gone', async () => {
    assert.deepEqual(await local('POST', `/local/pending/${first.w.id}`, { decision: 'write', text: 'Three: #12, #15 and #18.' }), { status: 200, ok: true });
    const r = await replyTo(first.m.id);
    assert.equal(r.text, 'Three: #12, #15 and #18.');
    assert.equal(r.meta.answeredBy, 'owner');
    await waitFor(async () => !('waiting' in (await messageOf(first.m.id))), 8000, 'the wait cleared');
    await waitFor(() => !fs.existsSync(path.join(bobDir(), 'handoff', `${first.m.id}.json`)), 8000, 'the note gone');
  });

  test('he lets it try again: it runs once more, can’t hand it back, and its answer is sent', async () => {
    const { m, w } = await handed('Can you list the open incidents?');
    const runs = fake.calls().length;
    assert.deepEqual(await local('POST', `/local/pending/${w.id}`, { decision: 'answer' }), { status: 200, ok: true });
    const again = await waitFor(() => fake.calls().length > runs && fake.calls().at(-1), 15000, 'a second run');
    const s = session(again);
    assert.equal(await s.call('sphere_ask_owner', { note: NOTE }), "You already handed this ask to Bob Test. Answer with what you have, and say plainly what's missing.");
    s.close();
    const r = await replyTo(m.id);
    assert.equal(r.text, 'I can’t see GitHub from here, so I asked Bob.');
    assert.equal(r.meta.answeredBy, 'agent');
    assert.match(bobOut, /you let your Oby try again/);
  });

  test('the asker takes it back while it waits for him: it leaves Waiting for you, and nothing is sent', async () => {
    const { m, w } = await handed('Never mind: which branch is live?');
    const del = await call('DELETE', `/api/messages/${m.id}`, { tok: token('alice') });
    assert.equal(del.status, 200, JSON.stringify(del));
    await waitFor(() => /alice took this ask back: not answered/.test(bobOut), 10000, `bob let it go\n${bobOut.slice(-2000)}`);
    const after = await local('GET', '/local/pending');
    assert.ok(!(after.pending || []).some((x) => x.id === w.id), 'not waiting any more');
    assert.ok((after.withdrawn || []).some((x) => x.id === w.id), 'Waiting for you says alice took it back');
    await sleep(500);
    assert.deepEqual((await repliesTo(m.id)).filter((x) => !x.deleted), []);
    await waitFor(() => !fs.existsSync(path.join(bobDir(), 'handoff', `${m.id}.json`)), 8000, 'the note gone');
  });

  test('he declines it: the asker reads plain words', async () => {
    const { m, w } = await handed('What is the deploy password?');
    await local('POST', `/local/pending/${w.id}`, { decision: 'decline' });
    const r = await replyTo(m.id);
    assert.ok(r.meta.declined);
    assert.equal(r.meta.answeredBy, 'owner');
    assert.match(r.text, /^Bob Test's Oby isn't taking this ask/);
  });

  test('no decision in time: the asker reads that he didn’t answer, as a lapse', async () => {
    await startBob({ OBYSPHERE_APPROVE_WAIT_SEC: '2' });
    const { m } = await handed('Is the release on Friday?');
    const r = await replyTo(m.id);
    assert.equal(r.text, "@bob's Oby asked its owner about this, and they didn't answer in time.");
    assert.ok(r.meta.lapsed && r.meta.declined);
    await startBob();
  });

  test('at most 3 of one asker’s asks a day', async () => {
    // three of alice's asks already handed to bob today (their notes, as the tool leaves them)
    const dir = path.join(bobDir(), 'handoff');
    fs.mkdirSync(dir, { recursive: true });
    for (const id of ['m_other1', 'm_other2', 'm_other3']) fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ askId: id, asker: ids.alice, note: 'earlier', need: 'access', at: new Date().toISOString() }));
    const m = await ask('And the staging URL?');
    const run = await runFor('And the staging URL?');
    const s = session(run);
    assert.equal(await s.call('sphere_ask_owner', { note: NOTE }), "Bob Test already has 3 of this asker's asks to look at today. Answer with what you have, and say plainly what's missing.");
    s.close();
    const r = await replyTo(m.id);
    assert.equal(r.meta.answeredBy, 'agent', 'answered as usual');
    for (const id of ['m_other1', 'm_other2', 'm_other3']) fs.rmSync(path.join(dir, `${id}.json`));
  });

  test('turned off in his settings: no tool, no line about it, and the plain-words line stays', async () => {
    setBob({ askOwner: false });
    const m = await ask('Who owns the billing service?');
    const run = await runFor('Who owns the billing service?');
    assert.equal(run.mcp.mcpServers.obysphere.env.SPHERE_OWNER_HELP, '0');
    assert.doesNotMatch(run.system, /sphere_ask_owner/);
    assert.match(run.system, /say what's missing in plain words/);
    const s = session(run);
    assert.ok(!(await s.tools()).includes('sphere_ask_owner'));
    s.close();
    await replyTo(m.id);
    setBob();
  });

  test('a note that says nothing, or a need that isn’t one, is refused', async () => {
    const m = await ask('What is on the roadmap?');
    const run = await runFor('What is on the roadmap?');
    const s = session(run);
    assert.match(await s.call('sphere_ask_owner', { note: '   ' }), /note: for Bob Test, what's asked and what you'd need to answer it/);
    assert.match(await s.call('sphere_ask_owner', { note: NOTE, need: 'money' }), /need is access, decision, knowledge/);
    s.close();
    assert.equal((await replyTo(m.id)).meta.answeredBy, 'agent');
  });
});

// ---- the console: the card of an ask your Oby handed you, and the setting
import vm from 'node:vm';
import { fnSource, constSource } from './accessibility-helpers.mjs';
function render(names, call, given = {}, consts = []) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const base = { esc, ...given };
  const ctx = vm.createContext(new Proxy(base, { has: () => true, get: (o, k) => (k in o ? o[k] : k === Symbol.unscopables ? undefined : k in globalThis ? globalThis[k] : () => '') }));
  vm.runInContext(`${consts.map((c) => constSource(c)).join('\n')}\n${names.map((n) => fnSource(n)).join('\n')}\nthis.__out = (${call});`, ctx);
  return base.__out;
}

describe('an ask your Oby handed you, in the console', () => {
  const card = (p, given = {}) => render(['pendingHtml'], 'pendingHtml()', { S: { pending: [p], me: { id: 'a_me' } }, CONSOLE: true, SET: {}, ownerName: (a) => a.owner, obyPic: () => '<svg aria-hidden="true"></svg>', ...given }, ['REASON_WORDS', 'NEED_WORDS']);
  const ask = { id: 'w_0123456789ab', askId: 'm_1', from: { name: 'alice', owner: 'Alice Test' }, channel: 'general', text: 'Which PRs wait for my review?', reason: 'stuck', always: false };

  test('what it needs and its note, quoted; Let my Oby try again; Settings when it needs access; never Always answer', () => {
    const html = card({ ...ask, stuck: { note: 'I can’t see GitHub <here>', need: 'access' } });
    assert.match(html, /<span class="why">your Oby couldn’t answer it alone<\/span>/);
    assert.match(html, /<div class="stuck-note"><span class="stuck-head"><svg aria-hidden="true"><\/svg>It needs something it can’t reach<\/span><span>I can’t see GitHub &lt;here&gt;<\/span><\/div>/);
    assert.match(html, /<button class="modal-primary" data-decide="answer">Let my Oby try again<\/button>/);
    assert.match(html, /<button class="set-button" data-page="settings"[^>]*>Settings<\/button>/);
    assert.doesNotMatch(html, /data-decide="always"/);
    assert.match(html, /data-decide="write">Answer myself<\/button>/);
    // a decision it needs: no Settings
    const decide = card({ ...ask, stuck: { note: 'Only Bob can say yes to this.', need: 'decision' } });
    assert.match(decide, /It needs your decision/);
    assert.doesNotMatch(decide, /data-page="settings"/);
    // an ask that waits under Ask me first is as it was
    const plain = card({ ...ask, reason: 'default' });
    assert.doesNotMatch(plain, /stuck-note/);
    assert.match(plain, /data-decide="answer">Let my Oby answer<\/button>/);
  });

  test('the switch shows only when rep.mjs sends the setting, and the console never adds it', () => {
    const page = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert.match(page, /\$\{'askOwner' in a \? swRow\('availability\.askOwner', a\.askOwner !== false, 'Ask me when it can’t answer alone'/);
    assert.match(page, /const AVAIL_DEFAULTS = \{ whenUnable: 'hold', otherRuntime: null, holdHours: 24, showReason: false \};/, 'not in the defaults the console fills in');
  });
});
