// When your Oby's runtime can't answer (#160), the answering side, end to end with a real relay and
// fake runtimes (no model, no network): the failure classes on real-looking outputs of Claude Code,
// Codex and Cursor; plain words to the asker, the full error to the owner; a rate limit tried again;
// out of usage: the runtime cools down, the ask is held (and survives a restart), the relay shows the
// pause, the owner is told once, and the held asks are answered at the reset; credit and sign-in
// rechecked; the longest hold; the catch-up after an offline gap (with the "expired" reply, and
// nothing answered twice); an asker's deadline; another runtime instead, or a decline; the owner's
// away left alone, and asks that wait for the owner waiting through it; the console's held list.
// Waits are scaled: OBYSPHERE_RETRY_MS (a "30 s"), OBYSPHERE_HOUR_MS (an "hour"). `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { makeFakeRuntimes } from './fake-runtimes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const KEY = 'join-key-hold-0123456789abcdef';
const RETRY_MS = 100; // a "30 s": rate retries 0.1, 0.4, 1 s; a recheck 2 s; no reset time 6 s; jitter up to 0.2 s
const HOUR_MS = 3000; // an "hour" of availability.holdHours
const UNABLE = "I can't answer this one right now.";
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

// ---- the failure classes: the block of rep.mjs that reads them, run as it is
const SRC = fs.readFileSync(path.join(ROOT, 'rep.mjs'), 'utf8');
const BLOCK = SRC.slice(SRC.indexOf('// ---- failure classes.'), SRC.indexOf('// ---- end of failure classes'));
const { classifyFailure } = new Function(`${BLOCK}\nreturn { classifyFailure };`)();

describe('failure classes', () => {
  const NOW = Date.parse('2026-11-26T12:00:00Z'); // a Thursday
  // the next such time on this machine's clock (and weekday: 0 is Sunday), as the reader finds it
  const nextLocal = (h, m, dow = null) => {
    for (let i = 0; i < 8; i++) {
      const d = new Date(NOW);
      d.setDate(d.getDate() + i);
      d.setHours(h, m, 0, 0);
      if ((dow === null || d.getDay() === dow) && d.getTime() > NOW) return d.toISOString();
    }
  };
  const epoch = Math.floor((NOW + 3 * 3600e3) / 1000);
  const cases = [
    // Claude Code (the result of a run that fails: stream-json's "result", or its stderr)
    ['claude', `Claude AI usage limit reached|${epoch}`, 'limit', new Date(epoch * 1000).toISOString()],
    ['claude', 'Claude AI usage limit reached', 'limit', null],
    ['claude', '5-hour limit reached ∙ resets 3pm', 'limit', nextLocal(15, 0)],
    ['claude', "You've hit your limit · resets 3:30pm (America/Chicago)", 'limit', '2026-11-26T21:30:00.000Z'],
    ['claude', 'Weekly limit reached ∙ resets Mon 9am', 'limit', nextLocal(9, 0, 1)],
    ['claude', 'Opus weekly limit reached ∙ resets Dec 1, 1pm (Europe/London)', 'limit', '2026-12-01T13:00:00.000Z'],
    ['claude', 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization of 50,000 input tokens per minute."}}', 'rate', null],
    ['claude', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'rate', null],
    ['claude', 'API Error: Repeated 529 Overloaded errors', 'rate', null],
    ['claude', 'Credit balance is too low', 'credit', null],
    ['claude', 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}', 'credit', null],
    ['claude', 'Invalid API key · Please run /login', 'auth', null],
    ['claude', 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}} · Please run /login', 'auth', null],
    ['claude', "Error: EACCES: permission denied, open '/Users/bob/payments/plan.md'", 'other', null],
    ['claude', 'No conversation found with session ID: 0b3f9d2e-77aa-4c1e-9e55-1d2c3b4a5f60', 'other', null],
    // Codex (exec --json: an "error" event, then "turn.failed")
    ['codex', "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again in 2 days 3 hours 4 minutes.", 'limit', new Date(NOW + 2 * 864e5 + 3 * 3600e3 + 4 * 60e3).toISOString()],
    ['codex', "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:04 PM.", 'limit', nextLocal(15, 4)],
    ['codex', "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://openai.com/chatgpt/pricing), or try again at Nov 27th, 2026 3:04 PM.", 'limit', new Date(2026, 10, 27, 15, 4).toISOString()],
    ['codex', 'exceeded retry limit, last status: 429 Too Many Requests, request id: 7f3c2a10-1b9e-4d55-a0c4-2f1e9b7d6c3a', 'rate', null],
    ['codex', 'Quota exceeded. You exceeded your current quota, please check your plan and billing details.', 'credit', null],
    ['codex', 'unexpected status 401 Unauthorized: {"error":{"message":"Incorrect API key provided: sk-proj-****. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error","code":"invalid_api_key"}}', 'auth', null],
    ['codex', 'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.', 'auth', null],
    ['codex', 'stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)', 'other', null],
    // Cursor (-p --output-format json: an error result, or its stderr)
    ['cursor', "Authentication required. Please run 'cursor-agent login' first, or set CURSOR_API_KEY environment variable.", 'auth', null],
    ['cursor', "You've hit your usage limit. Your limit resets at 10:12 AM.", 'limit', nextLocal(10, 12)],
    ['cursor', "You've reached your usage limit for this billing cycle. Your usage limits will reset on 12/1/2026. Switch to Auto to keep going.", 'limit', new Date(2026, 11, 1, 0, 0).toISOString()],
    ['cursor', "You've reached the limit of fast requests", 'limit', null],
    ['cursor', 'Rate limit exceeded. Please try again in a few moments.', 'rate', null],
    ['cursor', 'Error: the model returned an empty response', 'other', null],
    // what a model or its tools say is not the runtime failing: a bare number, another service's sign-in or limit
    ['claude', '{"type":"user","message":{"content":[{"type":"tool_result","content":"   428\\tfoo\\n   429\\tbar"}]}}', 'other', null],
    ['claude', '{"type":"assistant","message":{"usage":{"input_tokens":529,"output_tokens":12}}}', 'other', null],
    ['claude', 'Error: please sign in to the GitHub MCP server', 'other', null],
    ['claude', 'session limit reached for the MCP server', 'other', null],
    ['claude', 'Request failed: 401 Unauthorized when fetching https://example.com', 'other', null],
    ['claude', 'Not logged in · Please run /login', 'auth', null],
    ['claude', 'Your monthly limit reached; resets in 3 days', 'limit', new Date(NOW + 3 * 864e5).toISOString()],
    ['codex', 'unexpected status 429 Too Many Requests: slow down', 'rate', null],
  ];
  for (const [runtime, text, kind, until] of cases)
    test(`${runtime}: ${text.slice(0, 70)}`, () => {
      assert.deepEqual(classifyFailure(runtime, text, 1, NOW), { kind, until });
    });

  test('a reset time out of reach, or none, is null; a past one is now', () => {
    assert.equal(classifyFailure('claude', 'Claude AI usage limit reached|4102444800', 1, NOW).until, null, 'years ahead');
    assert.equal(classifyFailure('claude', 'Weekly limit reached ∙ resets soon', 1, NOW).until, null);
    assert.equal(classifyFailure('claude', `Claude AI usage limit reached|${Math.floor((NOW - 60e3) / 1000)}`, 1, NOW).until, new Date(NOW).toISOString());
  });
  test('the patterns sit in one table, each with a comment, near the runtimes', () => {
    const table = BLOCK.slice(BLOCK.indexOf('const FAILURE_PATTERNS'), BLOCK.indexOf('];'));
    const rows = table.split('\n').filter((l) => /^\s+\{ kind: /.test(l));
    assert.ok(rows.length >= 10);
    for (const r of rows) assert.match(r, /\}, \/\/ \S/, `a comment: ${r.slice(0, 60)}`);
    const at = SRC.indexOf('// ---- failure classes.');
    assert.ok(at > SRC.indexOf('function answeringEnv(') && at < SRC.indexOf('// ================================================================ MCP server'), 'just after the runtimes');
  });
});

describe("when your Oby's runtime can't answer", () => {
  let relay, base, tmp, home, work, cfg, fake, notifyLog, ids, ui, uiBase;
  let bob = null;
  let bobOut = '';
  const procs = [];
  const env = (extra = {}) => ({
    ...process.env,
    OBYSPHERE_HOME: home,
    CLAUDE_CONFIG_DIR: cfg,
    OBYSPHERE_PROBE_CACHE_MS: '0',
    OBYSPHERE_MINUTE_MS: '1000',
    OBYSPHERE_RETRY_MS: String(RETRY_MS),
    OBYSPHERE_HOUR_MS: String(HOUR_MS),
    OBYSPHERE_APPROVE_WAIT_SEC: '1',
    OBYSPHERE_NOTIFY_LOG: notifyLog,
    OBYSPHERE_NOTIFY_COALESCE_MS: '100',
    OBYSPHERE_NO_UPDATE_CHECK: '1',
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
  const token =(n) => JSON.parse(fs.readFileSync(path.join(home, n, 'profile.json'), 'utf8')).token;
  const bobDir = () => path.join(home, 'bob');
  const call = async (method, url, { tok, body, at = base, headers = {} } = {}) => {
    const h = { ...headers };
    if (tok) h.authorization = `Bearer ${tok}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(at + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const local = (method, url, body) => call(method, url, { at: uiBase, body, headers: { 'x-obysphere-console': '1' } });
  const settings = ({ availability = {}, access = {} } = {}) => ({
    version: 2,
    routing: { default: { runtime: 'claude', model: null, effort: null, timeLimitMin: 10 }, rules: [] },
    access: { default: 'answer', agents: { carol: 'trust' }, ...access },
    machine: { folders: [{ path: work, write: false }], shell: 'off', web: { fetch: false, search: false }, browser: 'off', mcp: [] },
    availability: { holdHours: 20, ...availability },
  });
  const setBob = (o) => fs.writeFileSync(path.join(bobDir(), 'settings.json'), JSON.stringify(settings(o)), { mode: 0o600 });
  const startBob = async () => {
    bobOut = '';
    bob = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'serve', '--profile', 'bob'], { env: env() });
    procs.push(bob);
    bob.stdout.on('data', (d) => (bobOut += d));
    bob.stderr.on('data', (d) => (bobOut += d));
    await waitFor(() => /is online[\s\S]*settings: /.test(bobOut), 10000, `bob online\n${bobOut}`);
    await sleep(300); // its catch-up
  };
  const stopBob = async () => {
    await stop(bob);
    bob = null;
  };
  const ask = async (from, text, extra = {}) => {
    const r = await call('POST', '/api/messages', { tok: token(from), body: { channel: 'general', text, to: [ids.bob], ...extra } });
    assert.ok(r.message, JSON.stringify(r));
    return r.message;
  };
  const repliesOf = async (m, from = 'alice') => ((await call('GET', `/api/messages/${m.id}/replies`, { tok: token(from) })).replies || []).filter((y) => y.from === ids.bob);
  const replyTo = async (m, from = 'alice', ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const r = await call('GET', `/api/messages/${m.id}/replies?wait=2`, { tok: token(from) });
      const x = (r.replies || []).find((y) => y.from === ids.bob);
      if (x) return x;
    }
    throw new Error(`no reply to ${m.id}\n${bobOut.slice(-3000)}`);
  };
  const noReplyFor = async (m, ms, from = 'alice') => {
    await sleep(ms);
    assert.deepEqual(await repliesOf(m, from), [], `no reply yet\n${bobOut.slice(-2000)}`);
  };
  const held = () => (fs.existsSync(path.join(bobDir(), 'held')) ? fs.readdirSync(path.join(bobDir(), 'held')).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(fs.readFileSync(path.join(bobDir(), 'held', n), 'utf8'))) : []);
  const cooldown = () => JSON.parse(fs.existsSync(path.join(bobDir(), 'cooldown.json')) ? fs.readFileSync(path.join(bobDir(), 'cooldown.json'), 'utf8') : '{}');
  const bobAgent = async () => (await call('GET', '/api/agents', { tok: token('alice') })).agents.find((a) => a.id === ids.bob);
  const claudeCalls = () => fake.calls().filter((c) => c.bin === 'claude').length;
  const notes = () => (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((l) => l.way === 'console');
  // between tests: the runtimes answer, nothing cools down or waits, no away
  const fresh = async () => {
    fake.control({ cursorSignedIn: true });
    for (const f of ['cooldown.json', 'away.json']) fs.rmSync(path.join(bobDir(), f), { force: true });
    fs.rmSync(path.join(bobDir(), 'held'), { recursive: true, force: true });
    await call('POST', '/api/away', { tok: token('bob'), body: { off: true } });
  };

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-hold-')));
    home = path.join(tmp, 'reps');
    work = path.join(tmp, 'work', 'payments');
    cfg = path.join(tmp, 'claude-config');
    notifyLog = path.join(tmp, 'notify.jsonl');
    for (const d of [home, work, cfg]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ mcpServers: {}, projects: {} }));
    fake = makeFakeRuntimes(path.join(tmp, 'bin'));
    fake.control({ cursorSignedIn: true });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    relay = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', path.join(tmp, 'relay')], {
      env: { ...process.env, SPHERE_KEY: KEY, SPHERE_STORE: 'fs', SPHERE_SEALED: '0', SPHERE_ASKS_PER_MIN: '1000', SPHERE_WRITES_PER_MIN: '1000' },
      stdio: process.env.SPHERE_TEST_DEBUG ? 'inherit' : 'ignore',
    });
    procs.push(relay);
    await waitFor(async () => {
      try {
        return (await fetch(base + '/healthz')).ok;
      } catch {
        return false;
      }
    }, 8000, 'the relay');
    for (const n of ['alice', 'bob', 'carol']) {
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
    ui = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'ui', '--profile', 'bob', '--port', String(uiPort)], { env: env(), stdio: 'ignore' });
    procs.push(ui);
    await waitFor(async () => {
      try {
        return (await fetch(uiBase + '/favicon.svg')).ok;
      } catch {
        return false;
      }
    }, 8000, 'the console');
    await startBob();
  });
  after(async () => {
    for (const p of procs) await stop(p);
    if (!process.env.SPHERE_TEST_KEEP) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test("plain words: the asker never reads the runtime's error or a path; the owner does", async () => {
    await fresh();
    fake.control({ cursorSignedIn: true, fail: { claude: 'other' } });
    const mark = notes().length;
    const r = await replyTo(await ask('alice', 'what is in the plan?'));
    assert.equal(r.text, UNABLE);
    assert.equal(r.meta.error, true);
    assert.equal(r.meta.unable, true);
    assert.ok(!/EACCES|secret-plan|payments/.test(JSON.stringify(r)), 'nothing of the error');
    const failed = await waitFor(() => notes().slice(mark).find((l) => l.type === 'failed'), 5000, 'the failed notification');
    assert.match(failed.body, /EACCES: permission denied, open 'payments\/secret-plan\.md'/, 'the owner reads why, the folder by its name only');
    assert.ok(!failed.body.includes(work), 'no full path, even to the owner');
    assert.match(bobOut, /EACCES/, 'and the log has it');
    assert.deepEqual(held(), [], 'not held: it won\'t pass on its own');
    assert.deepEqual(cooldown(), {});
  });

  test('a rate limit is tried again (30 s, 2 min, 5 min) inside the time limit', async () => {
    await fresh();
    fake.control({ cursorSignedIn: true, failNext: { claude: ['rate', 'overloaded'] } });
    const before = claudeCalls();
    const r = await replyTo(await ask('alice', 'busy day?'));
    assert.match(r.text, /^fake answer from/);
    assert.equal(claudeCalls(), before + 3, 'two tries that were busy, then the answer');
    assert.match(bobOut, /rate-limited: [\s\S]*trying again in 1 s[\s\S]*rate-limited: /);
    assert.deepEqual(held(), []);
    assert.deepEqual(cooldown(), {}, 'a rate limit cools nothing down');
  });

  test('out of usage: the runtime cools down, asks are held, the relay shows when, the owner hears once; at the reset all are answered', async () => {
    await fresh();
    setBob({ availability: { showReason: true } });
    fake.control({ cursorSignedIn: true, fail: { claude: 'limit' }, resetInSec: 4 });
    const mark = notes().length;
    const before = claudeCalls();
    const asks = [await ask('alice', 'first'), await ask('alice', 'second'), await ask('carol', 'third')];
    await waitFor(() => held().length === 3, 10000, `three held\n${bobOut}`);
    assert.equal(claudeCalls(), before + 1, 'the first hit the limit; the others never ran into it');
    const cool = cooldown().claude;
    assert.equal(cool.kind, 'limit');
    const reset = Date.parse(cool.until);
    assert.ok(reset > Date.now() && reset < Date.now() + 5000, cool.until);
    for (const h of held()) {
      assert.deepEqual(Object.keys(h).slice(0, 8), ['id', 'from', 'channel', 'ts', 'heldAt', 'until', 'tries', 'kind']);
      assert.equal(h.kind, 'limit');
      assert.ok(Date.parse(h.until) >= reset && Date.parse(h.until) <= reset + 2 * RETRY_MS, 'at the reset, plus up to a minute');
      assert.ok(['alice', 'carol'].includes(h.from), 'the asker by handle');
    }
    for (const m of asks) assert.deepEqual(await repliesOf(m), [], 'no reply while held');
    // the relay: away until the reset, and why (Tell askers why is on)
    const away = await waitFor(async () => (await bobAgent()).away, 3000, 'the pause on the relay');
    assert.equal(away.until, cool.until);
    assert.equal(away.note, 'out of AI usage');
    assert.equal(JSON.parse(fs.readFileSync(path.join(bobDir(), 'away.json'), 'utf8')).by, 'pause');
    await waitFor(() => notes().slice(mark).some((l) => l.type === 'paused'), 5000, 'paused');
    // the reset: the runtime answers again
    fake.control({ cursorSignedIn: true });
    const replies = [];
    for (const m of asks) replies.push(await replyTo(m, 'alice', 15000));
    for (const r of replies) assert.match(r.text, /^fake answer from/);
    await waitFor(() => held().length === 0, 3000, 'nothing held');
    assert.deepEqual(cooldown(), {}, 'the pause is over');
    await waitFor(async () => (await bobAgent()).away === null, 5000, 'the pause gone from the relay');
    assert.ok(!fs.existsSync(path.join(bobDir(), 'away.json')));
    const resumed = await waitFor(() => notes().slice(mark).find((l) => l.type === 'resumed'), 5000, 'resumed');
    assert.equal(resumed.title, 'Claude Code is back: answered 3 held asks');
    await sleep(500);
    const paused = notes().slice(mark).filter((l) => l.type === 'paused');
    assert.equal(paused.length, 1, 'one notification for the outage, not one per ask');
    assert.match(paused[0].title, /^Claude Code can't answer until (\d\d:\d\d|\w+ \d+, \d\d:\d\d) \(out of usage\); \d asks? (is|are) held$/);
    assert.match(paused[0].body, /usage limit reached/, 'the owner reads the runtime\'s words');
    assert.equal(notes().slice(mark).filter((l) => l.type === 'resumed').length, 1);
    assert.equal(notes().slice(mark).filter((l) => l.type === 'failed').length, 0, 'a hold is a pause, not a failure');
    for (const m of asks) assert.equal((await repliesOf(m)).length, 1, 'each answered once');
  });

  test('a hold survives a restart, and is answered when the runtime is back', async () => {
    await fresh();
    setBob();
    fake.control({ cursorSignedIn: true, fail: { claude: 'limit' }, resetInSec: 3 });
    const m = await ask('alice', 'still there after a restart?');
    await waitFor(() => held().length === 1, 10000, 'held');
    const away = await waitFor(async () => (await bobAgent()).away, 3000, 'the pause');
    assert.equal(away.note, '', 'askers see only the time unless you say otherwise');
    await stopBob();
    fake.control({ cursorSignedIn: true });
    await startBob();
    const r = await replyTo(m, 'alice', 15000);
    assert.match(r.text, /^fake answer from/);
    await waitFor(() => held().length === 0, 3000, 'nothing held');
    await sleep(500);
    assert.equal((await repliesOf(m)).length, 1, 'answered once');
  });

  test('out of credit or signed out: tried again at the next check, not at every ask', async () => {
    await fresh();
    setBob();
    fake.control({ cursorSignedIn: true, fail: { claude: 'credit' } });
    const before = claudeCalls();
    const a = await ask('alice', 'credit one');
    await waitFor(() => held().length === 1, 10000, 'held');
    assert.equal(cooldown().claude.kind, 'credit');
    assert.equal(cooldown().claude.until, null);
    const b = await ask('alice', 'credit two');
    await waitFor(() => held().length === 2, 10000, 'both held');
    assert.ok(claudeCalls() >= before + 1);
    // the second was held by the cooldown, without a run (a check later may try either one: that's the check)
    assert.match(bobOut, /credit two[\s\S]*route: [\s\S]*Claude Code is paused \(it couldn't answer a moment ago/);
    assert.equal(held().find((h) => h.id === b.id).kind, 'credit');
    fake.control({ cursorSignedIn: true }); // credit bought
    assert.match((await replyTo(a, 'alice', 15000)).text, /^fake answer from/);
    assert.match((await replyTo(b, 'alice', 15000)).text, /^fake answer from/);
    // signed out, the same way
    fake.control({ cursorSignedIn: true, failNext: { claude: ['auth'] } });
    const c = await ask('alice', 'signed out?');
    await waitFor(() => held().length === 1, 10000, 'held, signed out');
    assert.equal(held()[0].kind, 'auth');
    assert.match((await replyTo(c, 'alice', 15000)).text, /^fake answer from/);
  });

  test('the longest hold: an ask held past it gets the "expired" reply', async () => {
    await fresh();
    setBob({ availability: { holdHours: 1 } }); // 3 s here
    fake.control({ cursorSignedIn: true, fail: { claude: 'limit-noreset' } }); // tried again in "30 min"
    const before = claudeCalls();
    const m = await ask('alice', 'will this wait forever?');
    const r = await replyTo(m, 'alice', 15000);
    assert.equal(r.text, "@bob's Oby couldn't answer this one within 1 h. Ask again if it still matters.");
    assert.equal(r.meta.expired, true);
    assert.equal(claudeCalls(), before + 1);
    await waitFor(() => held().length === 0, 3000, 'nothing held');
  });

  test('the catch-up after an offline gap: every missed ask, an "expired" reply for one too old, nothing answered twice', async () => {
    await fresh();
    setBob({ availability: { holdHours: 1 } }); // 3 s here
    await sleep(300);
    await stopBob();
    const old = await ask('alice', 'asked long ago');
    await sleep(HOUR_MS + 500);
    const recent = await ask('carol', 'asked just now');
    const before = claudeCalls();
    await startBob();
    const r1 = await replyTo(old);
    // lengths of time, not clock times: the asker may be in another time zone
    assert.match(r1.text, /^This ask came while @bob's Oby was offline \(for \d+ (min|h|days)\) and, asked \d+ (min|h|days) ago, is older than it answers now\. Ask again if it still matters\.$/);
    assert.equal(r1.meta.expired, true);
    const r2 = await replyTo(recent, 'carol');
    assert.match(r2.text, /^fake answer from/);
    assert.equal(claudeCalls(), before + 1, 'only the recent one ran');
    const cursor = JSON.parse(fs.readFileSync(path.join(bobDir(), 'cursor.json'), 'utf8'));
    assert.equal(cursor.after, recent.id, 'the cursor: the last ask seen');
    // online again: nothing is answered twice
    await stopBob();
    await startBob();
    await sleep(1000);
    assert.equal((await repliesOf(old)).length, 1);
    assert.equal((await repliesOf(recent, 'carol')).length, 1);
    assert.equal(claudeCalls(), before + 1);
  });

  test("an ask past its deadline (neededBy) isn't started", async () => {
    await fresh();
    setBob();
    await stopBob();
    const m = await ask('alice', 'only useful for a moment', { neededBy: new Date(Date.now() + 1500).toISOString() });
    await sleep(2000);
    const before = claudeCalls();
    await startBob();
    const r = await replyTo(m);
    assert.equal(r.text, "This ask's deadline passed before @bob's Oby could start on it.");
    assert.equal(r.meta.expired, true);
    assert.equal(claudeCalls(), before);
  });

  test('another runtime answers instead (Codex only for Obys you trust), or the ask is declined', async () => {
    await fresh();
    setBob({ availability: { whenUnable: 'other', otherRuntime: 'codex' } });
    fake.control({ cursorSignedIn: true, fail: { claude: 'limit' }, resetInSec: 3600 });
    const mark = notes().length;
    const codexBefore = fake.calls().filter((c) => c.bin === 'codex').length;
    const a = await replyTo(await ask('alice', 'alice asks'));
    assert.equal(a.text, UNABLE, "Codex never answers an Oby you don't trust");
    assert.equal(a.meta.unable, true);
    const c = await replyTo(await ask('carol', 'carol asks'), 'carol');
    assert.match(c.text, /^codex answer from/, 'carol is trusted: Codex answers');
    assert.equal(fake.calls().filter((x) => x.bin === 'codex').length, codexBefore + 1);
    assert.deepEqual(held(), [], 'nothing held');
    assert.equal((await bobAgent()).away, null, 'no pause shown: asks are answered');
    const paused = await waitFor(() => notes().slice(mark).find((l) => l.type === 'paused'), 5000, 'paused');
    assert.match(paused.title, /\(out of usage\); Codex answers meanwhile$/);
    // decline: plain words at once, the cooling runtime not tried
    setBob({ availability: { whenUnable: 'decline' } });
    const before = claudeCalls();
    const d = await replyTo(await ask('alice', 'and now?'));
    assert.equal(d.text, UNABLE);
    assert.equal(claudeCalls(), before);
    assert.deepEqual(held(), []);
  });

  test("your away: never overridden by a pause, and an ask that waits for you waits through it", async () => {
    await fresh();
    setBob();
    // the checks are the relay's, said here first
    assert.deepEqual(await local('POST', '/local/away', { until: '2020-01-01T00:00:00Z' }), { status: 400, error: 'until: a time in the future', field: 'until' });
    assert.equal((await local('POST', '/local/away', { until: 'tomorrow-ish' })).field, 'until');
    assert.equal((await local('POST', '/local/away', { until: new Date(Date.now() + 31 * 864e5).toISOString() })).field, 'until');
    assert.equal((await local('POST', '/local/away', { note: 'x'.repeat(121) })).field, 'note');
    assert.deepEqual(await local('GET', '/local/away'), { status: 200, away: null });
    const until = new Date(Date.now() + 2 * 864e5).toISOString();
    const set = await local('POST', '/local/away', { until, note: 'on holiday' });
    assert.equal(set.status, 200, JSON.stringify(set));
    assert.deepEqual([set.away.by, set.away.until, set.away.note], ['owner', until, 'on holiday']);
    assert.deepEqual((await local('GET', '/local/away')).away, set.away);
    assert.equal((await bobAgent()).away.note, 'on holiday');
    // a hold while you're away: your away stays as it is
    fake.control({ cursorSignedIn: true, fail: { claude: 'limit' }, resetInSec: 2 });
    const m = await ask('alice', 'while bob is away');
    await waitFor(() => held().length === 1, 10000, 'held');
    await sleep(600);
    assert.deepEqual([(await bobAgent()).away.until, (await bobAgent()).away.note], [until, 'on holiday']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(bobDir(), 'away.json'), 'utf8')).by, 'owner');
    fake.control({ cursorSignedIn: true });
    assert.match((await replyTo(m, 'alice', 15000)).text, /^fake answer from/);
    await sleep(600);
    assert.equal((await bobAgent()).away.note, 'on holiday', 'and stays after the pause');
    // an ask that waits for you: not declined after the usual wait (1 s here) while you're away
    await local('POST', '/local/away', { until: new Date(Date.now() + 5000).toISOString(), note: '' });
    setBob({ access: { default: 'approve' } });
    const w = await ask('alice', 'may I?');
    const pending = await waitFor(async () => ((await local('GET', '/local/pending')).pending || []).find((x) => x.askId === w.id), 8000, 'waiting for you');
    await noReplyFor(w, 2500);
    assert.ok(((await local('GET', '/local/pending')).pending || []).some((x) => x.askId === w.id), 'still waiting for you');
    assert.equal((await local('POST', `/local/pending/${pending.id}`, { decision: 'answer' })).status, 200);
    assert.match((await replyTo(w)).text, /^fake answer from/);
    // back: the usual wait again
    assert.deepEqual(await local('POST', '/local/away', { off: true }), { status: 200, away: null });
    assert.equal((await bobAgent()).away, null);
    const late = await replyTo(await ask('alice', 'and now?'));
    assert.equal(late.meta.declined, true, 'declined after the usual wait');
    setBob();
  });

  test("the console's held list: the ask's words, Retry and Drop", async () => {
    await fresh();
    setBob();
    fake.control({ cursorSignedIn: true, fail: { claude: 'limit' }, resetInSec: 3600 });
    const mark = notes().length;
    const a = await ask('alice', 'please hold this one');
    const b = await ask('alice', 'x'.repeat(300));
    await waitFor(() => held().length === 2, 10000, 'two held');
    const g = await local('GET', '/local/held');
    assert.equal(g.status, 200);
    assert.deepEqual(g.held.map((h) => Object.keys(h)), [0, 1].map(() => ['id', 'from', 'channel', 'ts', 'heldAt', 'until', 'tries', 'kind', 'words']));
    const ha = g.held.find((h) => h.id === a.id);
    assert.deepEqual([ha.from, ha.channel, ha.kind, ha.tries, ha.words], ['alice', 'general', 'limit', 1, 'please hold this one']);
    assert.equal(g.held.find((h) => h.id === b.id).words, 'x'.repeat(200), 'its first 200 characters');
    // the checks
    assert.equal((await local('POST', '/local/held', { id: 'nope', action: 'drop' })).field, 'id');
    assert.equal((await local('POST', '/local/held', { id: a.id, action: 'later' })).field, 'action');
    assert.equal((await local('POST', '/local/held', { id: 'm_notheld00', action: 'drop' })).status, 404);
    // drop: plain words to the asker
    assert.deepEqual(await local('POST', '/local/held', { id: b.id, action: 'drop' }), { status: 200, ok: true });
    const dropped = await replyTo(b);
    assert.equal(dropped.text, UNABLE);
    assert.equal(dropped.meta.unable, true);
    assert.deepEqual((await local('GET', '/local/held')).held.map((h) => h.id), [a.id]);
    // retry: tried at once, the runtime as if its pause were over
    fake.control({ cursorSignedIn: true });
    assert.deepEqual(await local('POST', '/local/held', { id: a.id, action: 'retry' }), { status: 200, ok: true });
    assert.match((await replyTo(a)).text, /^fake answer from/);
    await waitFor(async () => (await local('GET', '/local/held')).held.length === 0, 3000, 'nothing held');
    const resumed = await waitFor(() => notes().slice(mark).find((l) => l.type === 'resumed'), 5000, 'resumed');
    assert.equal(resumed.title, 'Claude Code is back: answered 1 held ask');
    assert.equal((await repliesOf(b)).length, 1, 'the dropped one is never answered too');
  });

  // ---- after review
  const pendingFor = async (askId) => ((await local('GET', '/local/pending')).pending || []).find((x) => x.askId === askId);
  const lapsesAt = (w) => JSON.parse(fs.readFileSync(path.join(bobDir(), 'pending', `${w.id}.json`), 'utf8')).expiresAt;

  test('an ask waiting for you when your Oby stops is back in Waiting for you after a restart, with what was left of its wait', async () => {
    await fresh();
    setBob({ access: { default: 'approve' } }); // while you're away it waits up to the longest hold: 60 s here
    await local('POST', '/local/away', { until: new Date(Date.now() + 864e5).toISOString(), note: '' });
    const m = await ask('alice', 'may I, while you are away?');
    const first = await waitFor(() => pendingFor(m.id), 8000, 'waiting for you');
    const lapses = lapsesAt(first);
    await stopBob(); // the wait's process is gone; the cursor moved past the ask when it came
    await sleep(1500);
    await startBob();
    const again = await waitFor(() => pendingFor(m.id), 8000, `waiting for you again\n${bobOut}`);
    assert.notEqual(again.id, first.id);
    assert.equal(lapsesAt(again), lapses, 'what was left of its wait, not a new one');
    assert.equal((await local('POST', `/local/pending/${again.id}`, { decision: 'answer' })).status, 200);
    assert.match((await replyTo(m)).text, /^fake answer from/);
    await sleep(500);
    assert.equal((await repliesOf(m)).length, 1);
    await local('POST', '/local/away', { off: true });
  });

  test("…and declined, as if it lapsed, when its wait passed while your Oby was stopped (even past the longest hold's look-back)", async () => {
    await fresh();
    setBob({ access: { default: 'approve' }, availability: { holdHours: 1 } }); // the wait, and the look-back: 3 s here
    await local('POST', '/local/away', { until: new Date(Date.now() + 864e5).toISOString(), note: '' });
    const m = await ask('alice', 'may I, quickly?');
    await waitFor(() => pendingFor(m.id), 8000, 'waiting for you');
    await stopBob();
    await sleep(HOUR_MS + 1500);
    await startBob();
    const r = await replyTo(m);
    assert.equal(r.meta.declined, true);
    assert.match(r.text, /no answer from its owner/);
    await sleep(500);
    assert.equal((await repliesOf(m)).length, 1);
    assert.equal(await pendingFor(m.id), undefined);
    await local('POST', '/local/away', { off: true });
    setBob();
  });

  test("output that only looks like a limit, a rate limit or a sign-out (the model's, its tools') isn't read as one", async () => {
    await fresh();
    setBob();
    fake.control({ cursorSignedIn: true, fail: { claude: 'crash' } }); // no result, nothing on stderr
    const before = claudeCalls();
    const r = await replyTo(await ask('alice', 'what do the logs say?'));
    assert.equal(r.text, UNABLE);
    assert.ok(claudeCalls() - before <= 2, 'never tried again as a rate limit (a saved conversation, then a fresh one, at most)');
    assert.deepEqual(held(), [], 'not held');
    assert.deepEqual(cooldown(), {}, 'nothing cools down');
  });

  test("Drop when the Sphere can't be reached: the ask stays held (502); inbox --hook says a passed retry waits for your Oby to run", async () => {
    // dave: a profile whose Sphere is down, with one held ask whose retry time has passed
    const dir = path.join(home, 'dave');
    fs.mkdirSync(path.join(dir, 'held'), { recursive: true, mode: 0o700 });
    const dead = await freePort();
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(bobDir(), 'profile.json'), 'utf8')), sphere: `http://127.0.0.1:${dead}` }), { mode: 0o600 });
    const id = 'm_daveheld01';
    const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
    const file = path.join(dir, 'held', `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ id, from: 'alice', channel: 'general', ts: ago(60), heldAt: ago(59), until: ago(30), tries: 1, kind: 'limit', runtime: 'claude' }), { mode: 0o600 });
    const port = await freePort();
    const daveUi = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'ui', '--profile', 'dave', '--port', String(port)], { env: env(), stdio: 'ignore' });
    procs.push(daveUi);
    const at = `http://127.0.0.1:${port}`;
    await waitFor(async () => {
      try {
        return (await fetch(at + '/favicon.svg')).ok;
      } catch {
        return false;
      }
    }, 8000, "dave's console");
    const g = await call('GET', '/local/held', { at, headers: { 'x-obysphere-console': '1' } });
    assert.deepEqual(g.held.map((h) => [h.id, h.words]), [[id, '']], 'listed, with no words to show');
    const d = await call('POST', '/local/held', { at, body: { id, action: 'drop' }, headers: { 'x-obysphere-console': '1' } });
    assert.equal(d.status, 502, JSON.stringify(d));
    assert.match(d.error, /stays held/);
    assert.ok(fs.existsSync(file), 'never dropped in silence');
    const h = JSON.parse((await rep(['inbox', '--hook', '--profile', 'dave'])).stdout);
    assert.match(h.systemMessage, /your Oby holds 1 ask until it's running again$/);
    await stop(daveUi);
  });

  test('still rate-limited after its tries: held, the pause shown with no time and told once; a later answer brings it forward, and you hear it is back', async () => {
    await fresh();
    setBob();
    fake.control({ cursorSignedIn: true, fail: { claude: 'rate' } });
    const mark = notes().length;
    const logMark = bobOut.length;
    const a = await ask('alice', 'busy, busy');
    await waitFor(() => held().length === 1, 15000, 'held after its rate retries');
    assert.equal(held()[0].kind, 'rate');
    assert.deepEqual(cooldown(), {}, 'a rate limit cools nothing down');
    const away = await waitFor(async () => (await bobAgent()).away, 3000, 'the pause');
    assert.equal(away.until, null, 'no time: one that moved with each try would be told again each time');
    // tried again (a check: 2 s here), still busy: held again, the pause not told again
    const tries = held()[0].tries;
    await waitFor(() => held()[0]?.tries > tries, 15000, 'tried again');
    assert.equal((bobOut.slice(logMark).match(/askers see your Oby away/g) || []).length, 1, 'the relay told once');
    // a run works again: the held ask goes next, before its own time
    fake.control({ cursorSignedIn: true });
    const due = Date.parse(held()[0].until);
    assert.match((await replyTo(await ask('carol', 'and me?'), 'carol')).text, /^fake answer from/);
    const r = await replyTo(a, 'alice', 15000);
    assert.match(r.text, /^fake answer from/);
    assert.ok(Date.parse(r.ts) < due, 'brought forward by the answer that worked');
    const resumed = await waitFor(() => notes().slice(mark).find((l) => l.type === 'resumed'), 5000, 'resumed');
    assert.equal(resumed.title, 'Claude Code is back: answered 1 held ask');
    assert.equal(notes().slice(mark).filter((l) => l.type === 'paused').length, 1, 'told once');
    await waitFor(async () => (await bobAgent()).away === null, 5000, 'the pause gone');
  });

  test('an ask the catch-up finds under another claim (a process of yours that stopped mid-answer) is looked at again, not dropped', async () => {
    await fresh();
    setBob();
    await stopBob();
    const m = await ask('alice', 'claimed by a process that is gone');
    // the relay keeps that claim 15 minutes, as it would for bob's stopped process
    assert.equal((await call('POST', `/api/messages/${m.id}/claim`, { tok: token('bob'), body: { instance: 'feedfacefeed' } })).ok, true);
    await startBob();
    const said = /m_\w+: another process of yours claimed it/g;
    await waitFor(() => (bobOut.match(said) || []).length >= 1, 8000, 'set aside');
    // looked at again after the claim could lapse (16 min; 3.2 s here): still claimed here, so set aside again
    await waitFor(() => (bobOut.match(said) || []).length >= 2, 10000, `looked at again\n${bobOut}`);
    assert.deepEqual(await repliesOf(m), [], 'never answered under another claim');
  });

  test("a reset read as already past waits a check, not a moment", async () => {
    await fresh();
    setBob();
    fake.control({ cursorSignedIn: true, fail: { claude: 'limit' }, resetInSec: -60 });
    const m = await ask('alice', 'a reset in the past?');
    await waitFor(() => held().length === 1, 10000, 'held');
    const h = held()[0];
    assert.ok(Date.parse(h.until) - Date.parse(h.heldAt) >= 20 * RETRY_MS - 300, `at least a check (10 min; 2 s here): ${h.heldAt} → ${h.until}`);
    fake.control({ cursorSignedIn: true });
    assert.match((await replyTo(m, 'alice', 15000)).text, /^fake answer from/);
  });

  test('a catch-up that fails is tried again, a little later each time, for as long as the connection lasts', async () => {
    await fresh();
    setBob();
    await stopBob();
    const m = await ask('alice', 'asked while the Sphere was flaky');
    // between bob and the relay: refuses the catch-up's first six looks, passes the rest (the live stream too)
    let refuse = 6;
    const proxy = http.createServer(async (req, res) => {
      const u = new URL(req.url, base);
      if (refuse > 0 && req.method === 'GET' && u.pathname === '/api/messages' && u.searchParams.has('to')) {
        refuse--;
        res.writeHead(503, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'busy', code: 'unavailable' }));
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = {};
      for (const k of ['authorization', 'content-type', 'accept', 'x-file-name']) if (req.headers[k]) headers[k] = req.headers[k];
      try {
        const r = await fetch(base + req.url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
        if (!r.body) return res.end();
        Readable.fromWeb(r.body).on('error', () => res.end()).pipe(res);
      } catch {
        res.writeHead(502);
        res.end();
      }
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const prof = path.join(bobDir(), 'profile.json');
    const orig = fs.readFileSync(prof, 'utf8');
    fs.writeFileSync(prof, JSON.stringify({ ...JSON.parse(orig), sphere: `http://127.0.0.1:${proxy.address().port}` }), { mode: 0o600 });
    try {
      await startBob();
      const r = await replyTo(m, 'alice', 25000);
      assert.match(r.text, /^fake answer from/);
      assert.equal(refuse, 0);
      assert.ok((bobOut.match(/catch-up failed/g) || []).length >= 6, 'more than five tries');
    } finally {
      await stopBob();
      fs.writeFileSync(prof, orig, { mode: 0o600 });
      proxy.closeAllConnections();
      proxy.close();
      await startBob();
    }
  });
});
