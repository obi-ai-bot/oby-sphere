// Notifications, made on the owner's machine by rep.mjs: the notify section of settings.json
// (checked strictly; a file without it gets the defaults), the webhook and the topic masked for
// the console and kept when it sends them back, `notify test` through each way, Slack and phone
// payloads (summary or full, Slack's escaping, the clip at 600) against a local fake server,
// asks coalesced into one notification per way, quiet hours (only "waiting" comes through),
// failures, answers, mentions and direct messages from the streams, one notification per event
// across processes, the MCP channel in your own Claude Code session (and never in an answering
// one), `inbox --hook`, a console page that sends no notify section, a sealed Sphere's plain
// messages (from a relay of the test's own), and the desktop notifiers themselves (fakes, on a
// PATH with nothing else). Every other rep runs with OBYSPHERE_NOTIFY_LOG, so nothing reaches the
// desktop, and with runtimes that aren't installed, so no model runs. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const KEY = 'join-key-notify-0123456789';
const ADMIN = 'admin-key-notify-0123456789';
const SLACK_SECRET = 'abcdefghijklmnop1234';
const TOPIC = 'obysphere-topic-secret-9876';
const COALESCE_MS = 1500;
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000, what = 'the condition') => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
const hhmm = (mins) => {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

describe('notifications', () => {
  let relay, relayPort, base, data, home, work, cfg, logFile, uiBase, fakeBase, ids, serveOut = '';
  const procs = [];
  const hits = []; // what the fake Slack and ntfy got
  let fakeServer;
  const env = (extra = {}) => ({
    ...process.env,
    OBYSPHERE_HOME: home,
    OBYSPHERE_NOTIFY_LOG: logFile,
    OBYSPHERE_NOTIFY_COALESCE_MS: String(COALESCE_MS),
    OBYSPHERE_APPROVE_WAIT_SEC: '5',
    OBYSPHERE_PROBE_CACHE_MS: '0',
    OBYSPHERE_CHANNEL_POLL_MS: '200',
    OBYSPHERE_CHROME: '0',
    CLAUDE_CONFIG_DIR: cfg,
    ...extra,
  });
  const rep = (args, extra = {}) =>
    new Promise((resolve) => {
      const started = Date.now();
      const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), ...args], { env: env(extra) });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      const t = setTimeout(() => p.kill(), 30000);
      p.on('close', (code) => {
        clearTimeout(t);
        resolve({ out: out + err, stdout: out, stderr: err, code, ms: Date.now() - started });
      });
    });
  const profileOf = (n) => JSON.parse(fs.readFileSync(path.join(home, n, 'profile.json'), 'utf8'));
  const token = (n) => profileOf(n).token;
  const call = async (method, url, { tok, body, at = base, headers = {} } = {}) => {
    const h = { ...headers };
    if (tok) h.authorization = `Bearer ${tok}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(at + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const local = (method, url, body) => call(method, url, { at: uiBase, body, headers: { 'x-obysphere-console': '1' } });
  const settingsPath = (n = 'bob') => path.join(home, n, 'settings.json');
  const fileSettings = (n = 'bob') => JSON.parse(fs.readFileSync(settingsPath(n), 'utf8'));
  const slackUrl = (p = '/services/T000/B000/' + SLACK_SECRET) => `${fakeBase}${p}`;
  const phoneUrl = () => `${fakeBase}/${TOPIC}`;
  // bob's settings: no runtime ever runs (asks are declined, wait for him, or find no runtime)
  const setBob = (notify, access = {}) => fs.writeFileSync(settingsPath(), JSON.stringify({ version: 2, routing: { default: { runtime: 'claude' } }, access: { default: 'decline', ...access }, machine: { folders: [{ path: work, write: false }] }, ...(notify === undefined ? {} : { notify }) }), { mode: 0o600 });
  const logLines = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const log2 = () => logLines().length;
  let serve = null;
  const startServe = async (...flags) => {
    if (serve) {
      serve.kill();
      await new Promise((r) => serve.on('close', r));
    }
    serveOut = '';
    serve = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'serve', '--profile', 'bob', ...flags], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(serve);
    serve.stdout.on('data', (d) => (serveOut += d));
    serve.stderr.on('data', (d) => (serveOut += d));
    await waitFor(() => /is online/.test(serveOut), 10000, 'serve');
  };
  const ask = async (from, text, to = 'bob') => {
    const r = await call('POST', '/api/messages', { tok: token(from), body: { channel: 'general', text, to: [ids[to]] } });
    assert.ok(r.message, JSON.stringify(r));
    return r.message;
  };
  const replyTo = async (m, from) => {
    for (let i = 0; i < 40; i++) {
      const r = await call('GET', `/api/messages/${m.id}/replies?wait=3`, { tok: token(from) });
      const x = (r.replies || []).find((y) => y.from !== ids[from]);
      if (x) return x;
    }
    throw new Error(`no reply to ${m.id}\n${serveOut.slice(-3000)}`);
  };
  const startRelay = async () => {
    relay = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(relayPort), '--host', '127.0.0.1', '--data', data], {
      env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_STORE: 'fs', SPHERE_ASKS_PER_MIN: '1000', SPHERE_WRITES_PER_MIN: '1000' },
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
  };
  // a JSON-RPC client over the MCP server's stdio
  const mcpClient = (args) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'mcp', ...args], { env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
    procs.push(child);
    const got = [];
    readline.createInterface({ input: child.stdout }).on('line', (l) => {
      try {
        got.push(JSON.parse(l));
      } catch {}
    });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    let n = 0;
    return {
      child,
      got,
      err: () => err,
      channel: () => got.filter((m) => m.method === 'notifications/claude/channel'),
      request: async (method, params = {}) => {
        const id = ++n;
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        return waitFor(() => got.find((m) => m.id === id), 10000, `${method}'s answer`);
      },
    };
  };

  before(async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-notify-')));
    data = path.join(tmp, 'relay');
    home = path.join(tmp, 'reps');
    work = path.join(tmp, 'work');
    cfg = path.join(tmp, 'claude-config');
    logFile = path.join(tmp, 'notify.jsonl');
    for (const d of [data, home, work, cfg]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ mcpServers: {}, projects: {} }));
    fakeServer = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        hits.push({ path: req.url, headers: req.headers, body: b });
        res.writeHead(req.url.startsWith('/fail') ? 500 : 200, { 'content-type': 'text/plain' });
        res.end(req.url.startsWith('/fail') ? 'no' : 'ok');
      });
    });
    await new Promise((r) => fakeServer.listen(0, '127.0.0.1', r));
    fakeBase = `http://127.0.0.1:${fakeServer.address().port}`;
    relayPort = await freePort();
    base = `http://127.0.0.1:${relayPort}`;
    await startRelay();
    for (const n of ['alice', 'bob', 'carol']) {
      const { out } = await rep(['join', `${base}/#key=${KEY}`, '--name', n, '--owner', `${n[0].toUpperCase() + n.slice(1)} Test`, '--cwd', work]);
      assert.match(out, /joined/, out);
      // no runtime is installed here: nothing ever runs a model, or a real binary
      const missing = path.join(tmp, 'bin', 'not-installed');
      fs.writeFileSync(path.join(home, n, 'profile.json'), JSON.stringify({ ...profileOf(n), claudeBin: missing, codexBin: missing, cursorBin: missing }), { mode: 0o600 });
    }
    ids = Object.fromEntries(['alice', 'bob', 'carol'].map((n) => [n, profileOf(n).agent.id]));
    // a direct conversation between alice and bob, as the conversations work shapes it (kind,
    // members): written into the stopped relay's data, then the relay starts again
    relay.kill();
    await new Promise((r) => relay.on('close', r));
    const sphere = JSON.parse(fs.readFileSync(path.join(data, 'sphere.json'), 'utf8'));
    sphere.channels = { ...(sphere.channels || {}), 'dm-alice-bob': { name: 'dm-alice-bob', topic: '', kind: 'dm', members: [ids.alice, ids.bob], createdBy: ids.alice, createdAt: new Date().toISOString() } };
    fs.writeFileSync(path.join(data, 'sphere.json'), JSON.stringify(sphere), { mode: 0o600 });
    await startRelay();
    const { channels } = await call('GET', '/api/channels', { tok: token('bob') });
    assert.equal(channels.find((c) => c.name === 'dm-alice-bob')?.kind, 'dm');
  });
  after(() => {
    for (const p of procs) p.kill();
    fakeServer?.close();
    if (!process.env.SPHERE_TEST_KEEP) fs.rmSync(path.dirname(data), { recursive: true, force: true });
  });

  test('settings: a file without notify gets the defaults; the section is checked strictly; addresses are masked for the console', async () => {
    // an older file stays as it is, and reads as the defaults
    setBob(undefined, { default: 'answer' });
    let r = await rep(['settings', '--profile', 'bob', '--json']);
    assert.equal(r.code, 0, r.out);
    assert.ok(!('notify' in JSON.parse(r.stdout)), 'nothing written for a file that has no notify section');
    r = await rep(['settings', '--profile', 'bob']);
    assert.match(r.stdout, /Notifications\n {2}ways: this computer, your console, Claude Code\n {2}for: what waits for you, asks to your Oby, direct messages, mentions, answers to your asks, asks your Oby couldn't answer\n {2}quiet hours: none/);

    const port = await freePort();
    uiBase = `http://127.0.0.1:${port}`;
    const ui = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'ui', '--profile', 'bob', '--port', String(port)], { env: env(), stdio: 'ignore' });
    procs.push(ui);
    await waitFor(async () => {
      try {
        return (await fetch(uiBase + '/favicon.svg')).ok;
      } catch {
        return false;
      }
    }, 8000, 'the console');
    const g = await local('GET', '/local/settings');
    assert.equal(g.status, 200);
    assert.deepEqual(g.settings.notify, { desktop: true, console: true, claude: true, phone: { url: null, content: 'summary' }, slack: { webhookUrl: null, content: 'summary' }, events: { waiting: true, asked: true, direct: true, mention: true, answered: true, failed: true }, quiet: { from: null, to: null } });
    // the console's address, for the links in notifications
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'bob', 'notify', 'console.json'), 'utf8')).url, `http://bob.localhost:${port}/`);

    const bad = async (notify, field, words) => {
      const s = { ...g.settings, notify };
      const x = await local('PUT', '/local/settings', { settings: s });
      assert.equal(x.status, 400, JSON.stringify(x));
      assert.equal(x.field, field, JSON.stringify(x));
      if (words) assert.match(x.error, words);
    };
    await bad([], 'notify', /is \{ desktop, console, claude, phone, slack, events, quiet \}/);
    await bad({ pager: true }, 'notify.pager', /isn't a setting/);
    await bad({ desktop: 'yes' }, 'notify.desktop', /true or false/);
    await bad({ slack: { webhookUrl: 'http://hooks.slack.com/services/T/B/x' } }, 'notify.slack.webhookUrl', /must be https:\/\/ \(http:\/\/ only for this machine\)/);
    await bad({ slack: { webhookUrl: 'not an address' } }, 'notify.slack.webhookUrl', /Slack incoming-webhook address/);
    await bad({ slack: { webhookUrl: 'hooks.slack.com/services/…1234' } }, 'notify.slack.webhookUrl', /Slack incoming-webhook address/);
    await bad({ slack: { webhookUrl: 'javascript:alert(1)' } }, 'notify.slack.webhookUrl', /https/);
    await bad({ phone: { url: 'https://me:pw@ntfy.example/topic' } }, 'notify.phone.url', /user name or password/);
    await bad({ phone: { url: 'https://ntfy.sh/x', content: 'everything' } }, 'notify.phone.content', /summary or full/);
    await bad({ phone: { url: 'https://ntfy.sh/x', token: 'x' } }, 'notify.phone.token', /isn't a setting/);
    await bad({ events: { typo: true } }, 'notify.events.typo', /isn't a setting/);
    await bad({ events: { asked: 'no' } }, 'notify.events.asked', /true or false/);
    await bad({ quiet: { from: '22:00' } }, 'notify.quiet.to', /both from and to, or neither/);
    await bad({ quiet: { from: '25:00', to: '07:00' } }, 'notify.quiet.from', /HH:MM/);
    await bad({ quiet: { from: '7:00', to: '08:00' } }, 'notify.quiet.from', /HH:MM/);
    await bad({ quiet: { from: '08:00', to: '08:00' } }, 'notify.quiet.to', /same time/);

    // good: saved whole, shown masked
    const put = await local('PUT', '/local/settings', { settings: { ...g.settings, notify: { ...g.settings.notify, slack: { webhookUrl: slackUrl(), content: 'summary' }, phone: { url: phoneUrl(), content: 'summary' }, quiet: { from: '22:00', to: '07:30' } } } });
    assert.equal(put.status, 200, JSON.stringify(put));
    const host = new URL(fakeBase).host;
    assert.equal(put.settings.notify.slack.webhookUrl, `${host}/services/…1234`);
    assert.equal(put.settings.notify.phone.url, `${host}/…9876`);
    let f = fileSettings();
    assert.equal(f.notify.slack.webhookUrl, slackUrl(), 'the file keeps the whole address');
    assert.equal(f.notify.phone.url, phoneUrl());
    assert.deepEqual(f.notify.quiet, { from: '22:00', to: '07:30' });
    assert.equal(fs.statSync(settingsPath()).mode & 0o777, 0o600);
    const g2 = await local('GET', '/local/settings');
    assert.ok(!JSON.stringify(g2).includes(SLACK_SECRET) && !JSON.stringify(g2).includes(TOPIC), 'the console never gets an address');

    // the masked ones sent back unchanged keep the stored ones; other changes still apply
    const back = await local('PUT', '/local/settings', { settings: { ...g2.settings, notify: { ...g2.settings.notify, slack: { ...g2.settings.notify.slack, content: 'full' } } } });
    assert.equal(back.status, 200, JSON.stringify(back));
    f = fileSettings();
    assert.equal(f.notify.slack.webhookUrl, slackUrl());
    assert.equal(f.notify.slack.content, 'full');
    assert.equal(f.notify.phone.url, phoneUrl());
    // a new address replaces it; null clears it; a masked one with nothing stored is no address
    const other = slackUrl('/services/T111/B111/zyxwvutsrqponm5678');
    assert.equal((await local('PUT', '/local/settings', { settings: { ...g2.settings, notify: { ...g2.settings.notify, slack: { webhookUrl: other, content: 'summary' } } } })).status, 200);
    assert.equal(fileSettings().notify.slack.webhookUrl, other);
    // a masked address from before it changed (another tab) is no address
    await bad({ ...g2.settings.notify }, 'notify.slack.webhookUrl', /Slack incoming-webhook address/);
    const g3 = await local('GET', '/local/settings');
    assert.equal((await local('PUT', '/local/settings', { settings: { ...g3.settings, notify: { ...g3.settings.notify, phone: { url: null, content: 'summary' } } } })).status, 200);
    assert.equal(fileSettings().notify.phone.url, null);
    assert.equal(fileSettings().notify.slack.webhookUrl, other, 'kept');
    await bad({ ...g3.settings.notify, phone: { url: g2.settings.notify.phone.url, content: 'summary' } }, 'notify.phone.url', /ntfy topic's address/);

    // the terminal says which ways, never where
    setBob({ slack: { webhookUrl: slackUrl(), content: 'summary' }, phone: { url: phoneUrl(), content: 'full' }, quiet: { from: '22:00', to: '07:00' } }, { default: 'answer' });
    r = await rep(['settings', '--profile', 'bob']);
    assert.match(r.stdout, /ways: this computer, your console, Claude Code, your phone \(full\), Slack \(summary\)/);
    assert.match(r.stdout, /quiet hours: 22:00 to 07:00 \(only what waits for you comes through\)/);
    r = await rep(['settings', '--profile', 'bob', '--json']);
    assert.equal(JSON.parse(r.stdout).notify.slack.webhookUrl, `${host}/services/…1234`);
    for (const x of [await rep(['settings', '--profile', 'bob']), r, await rep(['whoami', '--profile', 'bob'])]) assert.ok(!x.out.includes(SLACK_SECRET) && !x.out.includes(TOPIC), 'no address in the terminal');
  });

  test('notify test: each way says what happened; Slack and phone get the summary or the full text', async () => {
    setBob({ slack: { webhookUrl: slackUrl(), content: 'summary' }, phone: { url: phoneUrl(), content: 'summary' } });
    let mark = logLines().length;
    let h = hits.length;
    let r = await rep(['notify', 'test', '--profile', 'bob']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /✓ Desktop {6}recorded in the notification log \(OBYSPHERE_NOTIFY_LOG\)/);
    assert.match(r.stdout, /✓ Console {6}recorded: your console shows it/);
    assert.match(r.stdout, /✓ Claude Code {2}recorded: a Claude Code session with the Obysphere channel shows it/);
    assert.match(r.stdout, /✓ Phone {8}sent \(summary\)/);
    assert.match(r.stdout, /✓ Slack {8}sent \(summary\)/);
    assert.ok(!r.out.includes(SLACK_SECRET) && !r.out.includes(TOPIC));
    const lines = logLines().slice(mark);
    assert.deepEqual(lines.map((l) => l.way).sort(), ['claude', 'console', 'desktop', 'phone', 'slack']);
    assert.ok(lines.every((l) => l.type === 'test' && l.title === 'A test from your Obysphere'));
    const link = JSON.parse(fs.readFileSync(path.join(home, 'bob', 'notify', 'console.json'), 'utf8')).url;
    const slack = hits.slice(h).find((x) => x.path.startsWith('/services/'));
    assert.equal(slack.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(slack.body), { text: `A test from your Obysphere. Open your console: <${link}>` }, 'summary: who and what kind, and the console');
    const phone = hits.slice(h).find((x) => x.path === `/${TOPIC}`);
    assert.equal(phone.headers.title, 'A test from your Obysphere');
    assert.equal(phone.headers.priority, 'default');
    assert.equal(phone.body, 'Open your Obysphere console to see it.', 'summary: never the words');

    // full: the words too
    setBob({ slack: { webhookUrl: slackUrl(), content: 'full' }, phone: { url: phoneUrl(), content: 'full' } });
    h = hits.length;
    r = await rep(['notify', 'test', '--profile', 'bob', '--via', 'slack']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /✓ Slack {8}sent \(full text\)/);
    assert.ok(!/Desktop|Phone|Console/.test(r.stdout), 'only the way asked for');
    assert.equal(JSON.parse(hits.at(-1).body).text, `A test from your Obysphere. Open your console: <${link}>\n> If you see this, notifications for bob reach you here.`);
    r = await rep(['notify', 'test', '--profile', 'bob', '--via', 'phone']);
    assert.equal(hits.at(-1).body, 'If you see this, notifications for bob reach you here.');
    assert.equal(hits.length, h + 2);

    // a way that fails says so, with the address masked, and the command fails
    setBob({ slack: { webhookUrl: slackUrl('/fail/T/B/' + SLACK_SECRET), content: 'summary' }, desktop: false });
    r = await rep(['notify', 'test', '--profile', 'bob']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.stdout, /✗ Slack {8}the address answered HTTP 500/);
    assert.match(r.stdout, /– Desktop {6}off in your settings/);
    assert.match(r.stdout, /– Phone {8}no ntfy topic address set/);
    assert.ok(!r.out.includes(SLACK_SECRET));
    // asked for by name, a way that's off still gets its test
    mark = logLines().length;
    r = await rep(['notify', 'test', '--profile', 'bob', '--via', 'desktop']);
    assert.match(r.stdout, /✓ Desktop {6}recorded in the notification log \(OBYSPHERE_NOTIFY_LOG\) \(it's off in your settings: only tests come this way\)/);
    assert.deepEqual(logLines().slice(mark).map((l) => l.way), ['desktop']);
    r = await rep(['notify', 'test', '--profile', 'bob', '--via', 'pager']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /usage: node rep\.mjs notify test/);

    // the console's own: POST /local/notify-test, and what it records for the page
    setBob({ slack: { webhookUrl: slackUrl(), content: 'summary' } });
    const t = await local('POST', '/local/notify-test', { via: 'console' });
    assert.equal(t.status, 200, JSON.stringify(t));
    assert.equal(t.results.length, 1);
    assert.equal(t.results[0].way, 'console');
    assert.equal(t.results[0].ok, true);
    assert.match(t.results[0].id, /^n_[0-9a-z]{15}$/);
    assert.equal((await local('POST', '/local/notify-test', { via: 'pager' })).status, 400);
    const s = await local('POST', '/local/notify-test', { via: 'slack' });
    assert.deepEqual(s.results.map((x) => [x.way, x.ok]), [['slack', true]]);
    const list = await local('GET', '/local/notifications');
    assert.equal(list.status, 200);
    const mine = list.notifications.find((x) => x.id === t.results[0].id);
    assert.deepEqual([mine.type, mine.title, mine.console], ['test', 'A test from your Obysphere', true]);
    const after = await local('GET', `/local/notifications?after=${encodeURIComponent(list.last)}`);
    assert.deepEqual(after.notifications, [], 'nothing newer');
    assert.equal(after.last, list.last);
  });

  test('asks: a burst becomes one notification per way; serve --notify keeps the desktop on; Slack escapes and clips the words', async () => {
    setBob({ desktop: false, slack: { webhookUrl: slackUrl(), content: 'full' }, phone: { url: phoneUrl(), content: 'summary' } });
    await startServe('--notify');
    try {
      const mark = logLines().length;
      const h = hits.length;
      const asks = await Promise.all(['one', 'two', 'three'].map((w) => ask('alice', `burst ${w}`)));
      for (const m of asks) assert.equal((await replyTo(m, 'alice')).meta?.declined, true);
      const lines = await waitFor(() => {
        const x = logLines().slice(mark).filter((l) => l.type === 'asked');
        return x.length >= 5 && x;
      }, 8000, 'the burst');
      await sleep(COALESCE_MS + 500);
      const all = logLines().slice(mark).filter((l) => l.type === 'asked');
      assert.equal(all.length, 5, `one per way: ${JSON.stringify(all)}`);
      assert.deepEqual(all.map((l) => l.way).sort(), ['claude', 'console', 'desktop', 'phone', 'slack'], 'the desktop too: serve --notify');
      assert.ok(lines.every((l) => l.title === '3 asks for your Oby'), JSON.stringify(lines));
      assert.equal(all.find((l) => l.way === 'console').body, 'From @alice.');
      const slack = await waitFor(() => { const s = hits.slice(h).filter((x) => x.path.startsWith('/services/')); return s.length && s; }, 4000, 'the Slack request');
      assert.equal(slack.length, 1);
      assert.match(JSON.parse(slack[0].body).text, /^3 asks for your Oby\. Open your console: <http:\/\/bob\.localhost:\d+\/>\n> From @alice\.$/);

      // one ask alone: its words, escaped for Slack (no <!channel>), clipped at 600
      const m2 = log2();
      const slackBefore = hits.filter((x) => x.path.startsWith('/services/')).length;
      const phoneBefore = hits.filter((x) => x.path === `/${TOPIC}`).length;
      const words = `<!channel> & <@U123> ${'x'.repeat(700)}`;
      await replyTo(await ask('alice', words), 'alice');
      const one = await waitFor(() => logLines().slice(m2).find((l) => l.type === 'asked' && l.way === 'slack'), 8000, 'one ask');
      assert.equal(one.title, '@alice asks your Oby');
      // the log line is written as the request goes out: wait for the fake Slack to get it
      const slackNow = await waitFor(() => { const s = hits.filter((x) => x.path.startsWith('/services/')); return s.length > slackBefore && s; }, 4000, 'the Slack request for one ask');
      const text = JSON.parse(slackNow.at(-1).body).text;
      assert.ok(text.startsWith('@alice asks your Oby. Open your console: <http://bob.localhost:'), text);
      assert.ok(text.includes('\n> &lt;!channel&gt; &amp; &lt;@U123&gt; xxx'), text);
      assert.ok(!text.includes('<!channel>') && !text.includes('<@U123>'));
      assert.ok(text.endsWith('x…'), 'clipped');
      assert.equal(text.split('\n> ')[1].length, '&lt;!channel&gt; &amp; &lt;@U123&gt; '.length + 600 - '<!channel> & <@U123> '.length + 1);
      // phone: the summary, never the words
      const phoneNow = await waitFor(() => { const s = hits.filter((x) => x.path === `/${TOPIC}`); return s.length > phoneBefore && s; }, 4000, 'the phone request for one ask');
      assert.equal(phoneNow.at(-1).body, 'Open your Obysphere console to see it.');
    } finally {
      // from here on, the settings alone decide the desktop, even when an assertion above failed
      await startServe();
    }
  });

  test("quiet hours: only what waits for you comes through, at high priority; an ask that waits is told once", async () => {
    const now = new Date().getHours() * 60 + new Date().getMinutes();
    const quiet = { from: hhmm(now - 5), to: hhmm(now + 60) };
    setBob({ desktop: false, phone: { url: phoneUrl(), content: 'summary' }, quiet });
    let mark = log2();
    await replyTo(await ask('alice', 'a quiet ask'), 'alice');
    await sleep(COALESCE_MS + 1000);
    assert.deepEqual(logLines().slice(mark), [], 'nothing in quiet hours');
    const quietOne = (await local('GET', '/local/notifications')).notifications.at(-1);
    assert.deepEqual([quietOne.type, quietOne.quiet, quietOne.console], ['asked', true, false], 'kept in the history, shown nowhere');

    // an ask that waits for you comes through, at high priority
    setBob({ desktop: false, phone: { url: phoneUrl(), content: 'summary' }, quiet }, { default: 'approve' });
    mark = log2();
    const h = hits.length;
    const w = await ask('alice', 'please look at this one');
    await waitFor(() => logLines().slice(mark).some((l) => l.type === 'waiting'), 8000, 'waiting');
    const waiting = await waitFor(() => { const x = logLines().slice(mark).filter((l) => l.type === 'waiting'); return x.length >= 3 && x; }, 4000, 'every way');
    assert.equal(waiting[0].title, "@alice's ask waits for you");
    assert.deepEqual(logLines().slice(mark).map((l) => l.way).sort(), ['claude', 'console', 'phone']);
    // the log line is written as the request goes out: wait for the fake server to have it
    const phone = await waitFor(() => hits.slice(h).find((x) => x.path === `/${TOPIC}`), 4000, 'the phone request');
    assert.equal(phone.headers.priority, 'high');
    assert.equal(phone.headers.title, "@alice's ask waits for you");

    // inbox --hook while it waits: JSON for Claude Code's SessionStart, fenced, quick, no secrets
    const r = await rep(['inbox', '--hook', '--profile', 'bob']);
    assert.equal(r.code, 0, r.out);
    const j = JSON.parse(r.stdout);
    assert.equal(j.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(j.systemMessage, /^1 ask waits for you in your Obysphere console/);
    const ctx = j.hookSpecificOutput.additionalContext;
    const fence = /QUOTED-[0-9A-F]{12}/.exec(ctx)?.[0];
    assert.ok(fence, ctx);
    assert.ok(ctx.indexOf('please look at this one') > ctx.indexOf(fence) && ctx.indexOf('please look at this one') < ctx.lastIndexOf(fence), 'the ask is inside the fence');
    assert.match(ctx, /"@alice"/);
    assert.ok(r.ms < 3500, `quick: ${r.ms} ms`);
    for (const secret of [token('bob'), SLACK_SECRET, TOPIC]) assert.ok(!r.stdout.includes(secret), 'never a token or an address');
    await replyTo(w, 'alice'); // no one decided: declined after the wait

    // outside quiet hours, an ask that waits is told as waiting only, not also as asked
    setBob({ desktop: false, events: { failed: true } }, { default: 'approve' });
    mark = log2();
    const w2 = await ask('alice', 'and this one');
    await waitFor(() => logLines().slice(mark).some((l) => l.type === 'waiting'), 8000, 'waiting');
    await sleep(COALESCE_MS + 500);
    assert.deepEqual([...new Set(logLines().slice(mark).map((l) => l.type))], ['waiting']);
    await replyTo(w2, 'alice');
    // an event turned off is never told
    setBob({ desktop: false, events: { waiting: false } }, { default: 'approve' });
    mark = log2();
    const w3 = await ask('alice', 'and a third');
    await replyTo(w3, 'alice');
    await sleep(COALESCE_MS + 500);
    assert.deepEqual(logLines().slice(mark).map((l) => l.type), ['asked', 'asked'], 'asked (console and Claude Code), never waiting');
  });

  test('inbox --hook: nothing to say prints nothing; a Sphere that never answers costs at most 3 seconds', async () => {
    let r = await rep(['inbox', '--hook', '--profile', 'carol']);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.stdout, '', 'nothing, so the session starts as usual');
    // a Sphere that takes the connection and never answers
    const hang = net.createServer(() => {}).listen(0, '127.0.0.1');
    await new Promise((res) => hang.once('listening', res));
    const dir = path.join(home, 'slow');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ ...profileOf('carol'), sphere: `http://127.0.0.1:${hang.address().port}` }), { mode: 0o600 });
    fs.copyFileSync(path.join(home, 'carol', 'keys.json'), path.join(dir, 'keys.json'));
    r = await rep(['inbox', '--hook', '--profile', 'slow']);
    hang.close();
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.stdout, '');
    assert.ok(r.ms < 4500, `at most 3 s on the network: ${r.ms} ms`);
    // no profile at all: nothing, exit 0
    r = await rep(['inbox', '--hook', '--profile', 'nobody-here']);
    assert.deepEqual([r.code, r.stdout], [0, '']);
  });

  test("failed: an ask your Oby couldn't answer notifies, and inbox --hook says so", async () => {
    setBob({ desktop: false }, { default: 'answer' });
    const mark = log2();
    const reply = await replyTo(await ask('alice', 'can you answer this?'), 'alice');
    assert.match(reply.text, /couldn't answer this one/);
    const failed = await waitFor(() => logLines().slice(mark).find((l) => l.type === 'failed' && l.way === 'console'), 8000, 'failed');
    assert.equal(failed.title, "Your Oby couldn't answer @alice");
    assert.equal(failed.body, "Claude Code isn't installed on this machine.");
    const r = await rep(['inbox', '--hook', '--profile', 'bob']);
    const j = JSON.parse(r.stdout);
    assert.match(j.systemMessage, /^Your Obysphere: your Oby couldn't answer 1 ask today$/);
    assert.match(j.hookSpecificOutput.additionalContext, /"couldntAnswerToday"/);
  });

  test("answers, mentions and direct messages from the streams; the MCP channel tells your own Claude Code session, once", async () => {
    setBob({ desktop: false });
    const mcp = mcpClient(['--profile', 'bob']);
    const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.deepEqual(init.result.capabilities, { tools: {}, experimental: { 'claude/channel': {} } });
    assert.match(init.result.instructions, /<channel source="obysphere" kind="waiting\|asked\|direct\|mention\|answered\|failed">/);
    // an answering session never gets the channel
    const session = mcpClient(['--profile', 'bob', '--as-session']);
    const sinit = await session.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.deepEqual(sinit.result.capabilities, { tools: {} });
    assert.ok(!/channel source/.test(sinit.result.instructions));
    session.child.kill();
    await sleep(1000); // the client stream connects

    // bob asks alice himself; alice answers: told once, though serve and mcp both see it
    let mark = log2();
    const own = await call('POST', '/api/messages', { tok: token('bob'), body: { channel: 'general', text: 'what is the plan?', to: [ids.alice] } });
    await sleep(300);
    await call('POST', '/api/messages', { tok: token('alice'), body: { channel: 'general', text: 'the plan is <b>ship it</b>', replyTo: own.message.id } });
    await waitFor(() => logLines().slice(mark).some((l) => l.type === 'answered'), 8000, 'answered');
    await sleep(COALESCE_MS + 500);
    const answered = logLines().slice(mark).filter((l) => l.type === 'answered');
    assert.deepEqual(answered.map((l) => l.way).sort(), ['claude', 'console'], `once, across processes: ${JSON.stringify(answered)}`);
    assert.equal(answered[0].title, '@alice answered your ask');
    const pushed = await waitFor(() => mcp.channel().find((x) => x.params.meta.kind === 'answered'), 5000, 'the channel');
    assert.deepEqual(pushed.params.meta, { kind: 'answered', count: '1', from: 'alice', channel: 'general' });
    const fence = /QUOTED-[0-9A-F]{12}/.exec(pushed.params.content)?.[0];
    assert.ok(fence && pushed.params.content.startsWith('Your Obysphere: an answer to your ask. Your console: http://bob.localhost:'), pushed.params.content);
    const inside = pushed.params.content.split(fence)[2]; // the label names the fence too
    assert.ok(inside.includes('the plan is <b>ship it</b>') && inside.includes('@alice answered your ask'), 'what came from the Sphere is inside the fence');

    // an answer that says it failed is told as that, not as an answer
    mark = log2();
    const own2 = await call('POST', '/api/messages', { tok: token('bob'), body: { channel: 'general', text: 'and the date?', to: [ids.alice] } });
    await sleep(300);
    await call('POST', '/api/messages', { tok: token('alice'), body: { channel: 'general', text: "I couldn't answer this one", replyTo: own2.message.id, meta: { error: true, local: true } } });
    const failedAnswer = await waitFor(() => logLines().slice(mark).find((l) => l.type === 'answered' && l.way === 'console'), 8000, 'the failed answer');
    assert.equal(failedAnswer.title, "@alice couldn't answer your ask");

    // an ask the answering session made (a hop) isn't yours: its answer tells you nothing
    mark = log2();
    const hop = await call('POST', '/api/messages', { tok: token('bob'), body: { channel: 'general', text: 'a hop', to: [ids.carol], cause: (await ask('alice', 'start a hop')).id } });
    await sleep(300);
    await call('POST', '/api/messages', { tok: token('carol'), body: { channel: 'general', text: 'hop answer', replyTo: hop.message.id } });

    // a mention in a channel; not @bobby, not an email
    await call('POST', '/api/messages', { tok: token('alice'), body: { channel: 'general', text: 'mail me at x@bob or ask @bobby' } });
    await call('POST', '/api/messages', { tok: token('alice'), body: { channel: 'general', text: 'hey @bob, a look at this?' } });
    const mention = await waitFor(() => logLines().slice(mark).find((l) => l.type === 'mention' && l.way === 'console'), 8000, 'the mention');
    assert.equal(mention.title, '@alice mentioned you in #general');
    assert.equal(mention.body, 'hey @bob, a look at this?');
    await waitFor(() => mcp.channel().some((x) => x.params.meta.kind === 'mention'), 5000, 'the mention on the channel');

    // a direct message: a channel of kind dm that bob is in
    await call('POST', '/api/messages', { tok: token('alice'), body: { channel: 'dm-alice-bob', text: 'just for you, bob' } });
    const direct = await waitFor(() => logLines().slice(mark).find((l) => l.type === 'direct' && l.way === 'console'), 8000, 'the direct message');
    assert.equal(direct.title, '@alice wrote to you');
    await sleep(COALESCE_MS + 500);
    const since = logLines().slice(mark);
    assert.deepEqual(since.filter((l) => l.type === 'mention').length, 2, 'one mention, console and Claude Code');
    assert.equal(since.filter((l) => l.type === 'answered').length, 0, "a hop's answer isn't yours");
    assert.ok(!since.some((l) => l.way === 'desktop'), 'the desktop is off here (no --notify in mcp)');
    const r = await rep(['inbox', '--hook', '--profile', 'bob']);
    const j = JSON.parse(r.stdout);
    assert.match(j.systemMessage, /1 new direct message/);
    assert.match(j.hookSpecificOutput.additionalContext, /just for you, bob/);
    const again = JSON.parse((await rep(['inbox', '--hook', '--profile', 'bob'])).stdout);
    assert.ok(!/direct message/.test(again.systemMessage), 'new ones only, once');

    // Claude Code off: the channel stays quiet; `notify test --via claude` while it's on gets through
    const before = mcp.channel().length;
    setBob({ desktop: false, claude: false });
    mark = log2();
    await call('POST', '/api/messages', { tok: token('alice'), body: { channel: 'general', text: 'again @bob' } });
    await waitFor(() => logLines().slice(mark).some((l) => l.type === 'mention'), 8000, 'the mention');
    await sleep(800);
    assert.equal(mcp.channel().length, before);
    assert.deepEqual(logLines().slice(mark).map((l) => l.way), ['console']);
    assert.equal((await rep(['inbox', '--hook', '--profile', 'bob'])).stdout, '', 'the SessionStart summary is part of the Claude Code way');
    setBob({ desktop: false });
    await rep(['notify', 'test', '--profile', 'bob', '--via', 'claude']);
    const t = await waitFor(() => mcp.channel().find((x) => x.params.meta.kind === 'test'), 5000, 'the test on the channel');
    assert.match(t.params.content, /^Your Obysphere: a test notification\./);
  });

  test('settings: a page that sends no notify section (an older one, from the relay) keeps the stored one', async () => {
    setBob({ slack: { webhookUrl: slackUrl(), content: 'full' }, quiet: { from: '22:00', to: '07:00' } }, { default: 'answer' });
    const g = await local('GET', '/local/settings');
    assert.equal(g.status, 200, JSON.stringify(g));
    const { notify, ...older } = g.settings;
    assert.ok(notify);
    const r = await local('PUT', '/local/settings', { settings: { ...older, access: { ...older.access, rules: 'be brief' } } });
    assert.equal(r.status, 200, JSON.stringify(r));
    let f = fileSettings();
    assert.equal(f.access.rules, 'be brief', 'the change is saved');
    assert.equal(f.notify?.slack?.webhookUrl, slackUrl(), 'the address stays');
    assert.deepEqual(f.notify.quiet, { from: '22:00', to: '07:00' });
    assert.ok(!JSON.stringify(r).includes(SLACK_SECRET), 'and the answer is masked');
    // null still means the defaults
    assert.equal((await local('PUT', '/local/settings', { settings: { ...older, notify: null } })).status, 200);
    f = fileSettings();
    assert.ok(!('notify' in f), JSON.stringify(f.notify));
    // a file that doesn't pass comes back as it is, with a notify section all the same (the page
    // takes a missing one for an older rep.mjs, and leaves it out), masked
    fs.writeFileSync(settingsPath(), JSON.stringify({ ...f, routing: { default: { runtime: 'nope' } } }), { mode: 0o600 });
    let x = await local('GET', '/local/settings');
    assert.equal(x.field, 'routing.default.runtime', JSON.stringify(x));
    assert.deepEqual(x.settings.notify.events.waiting, true);
    fs.writeFileSync(settingsPath(), JSON.stringify({ ...f, routing: { default: { runtime: 'nope' } }, notify: { slack: { webhookUrl: slackUrl() } } }), { mode: 0o600 });
    x = await local('GET', '/local/settings');
    assert.equal(x.settings.notify.slack.webhookUrl, `${new URL(fakeBase).host}/services/…1234`);
    assert.ok(!JSON.stringify(x).includes(SLACK_SECRET));
  });

  test("a sealed Sphere: a plain message is the relay's own doing, so it notifies nothing", async () => {
    // a relay of our own, which can say anything: first unsealed, then sealed
    const me = { id: 'a_vic000000001', name: 'vic', owner: 'Vic Test' };
    const mal = { id: 'a_mal000000001', name: 'mal', owner: 'Mal Test' };
    let sealed = false;
    const streams = new Set();
    const msgs = [];
    const fake = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const send = (o) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (u.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('retry: 2000\n\n');
        streams.add(res);
        req.on('close', () => streams.delete(res));
        return;
      }
      if (u.pathname === '/api/info') return send({ sphere: { name: 'Fake', policy: { sealed } }, me: {} });
      if (u.pathname === '/api/agents') return send({ agents: [me, mal] });
      if (u.pathname === '/api/channels') return send({ channels: [{ name: 'general', topic: '' }, { name: 'dm-mal-vic', topic: '', kind: 'dm', members: [me.id, mal.id], createdBy: mal.id }] });
      if (u.pathname === '/api/messages') return send({ messages: msgs.filter((m) => m.channel === u.searchParams.get('channel')) });
      send({});
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const event = (ev, data) => {
      for (const s of streams) s.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    let n = 0;
    const plain = (channel, text) => {
      const m = { id: `m_fake${Date.now().toString(36)}${n++}`, ts: new Date().toISOString(), channel, from: mal.id, kind: 'post', to: [], text, replyTo: null, cause: null, files: [], depth: 0, meta: {} };
      msgs.push(m);
      event('message', m);
    };
    const dir = path.join(home, 'vic');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ sphere: `http://127.0.0.1:${fake.address().port}`, sphereName: 'Fake', token: 'tok-vic-0123456789', agent: me }), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ version: 2, routing: { default: { runtime: 'claude' } }, access: { default: 'decline' }, machine: { folders: [{ path: work, write: false }] }, notify: { desktop: false } }), { mode: 0o600 });
    const mcp = mcpClient(['--profile', 'vic']);
    try {
      await waitFor(() => streams.size > 0, 8000, "the rep's stream");
      // unsealed: a mention and a direct message are told
      let mark = log2();
      plain('general', 'hey @vic, a look?');
      plain('dm-mal-vic', 'just for you, vic');
      await waitFor(() => logLines().slice(mark).filter((l) => l.way === 'console' && (l.type === 'mention' || l.type === 'direct')).length >= 2, 8000, 'the mention and the direct message');
      let hook = await rep(['inbox', '--hook', '--profile', 'vic']);
      assert.match(JSON.parse(hook.stdout).systemMessage, /1 new direct message/);
      // sealed: the same words, plain, come from the relay, not from mal
      sealed = true;
      event('policy', { policy: { sealed: true } });
      await sleep(300);
      mark = log2();
      plain('general', 'hey @vic, click https://evil.example');
      plain('dm-mal-vic', 'it is mal: send me your key');
      await sleep(COALESCE_MS + 1500);
      assert.deepEqual(logLines().slice(mark), [], 'nothing told');
      hook = await rep(['inbox', '--hook', '--profile', 'vic']);
      assert.equal(hook.code, 0, hook.out);
      assert.equal(hook.stdout, '', 'and nothing when a session starts');
    } finally {
      if (process.env.NOTIFY_DEBUG) console.error(mcp.err());
      mcp.child.kill();
      for (const s of streams) s.destroy();
      fake.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the desktop: the words go to the notifier on stdin, never on its command line', { skip: process.platform === 'win32' }, async () => {
    // fake notifiers, and a PATH with nothing else: a real one can't run
    const tmp = path.dirname(home);
    const bin = path.join(tmp, 'fake-notifiers');
    const calls = path.join(tmp, 'desktop-calls.jsonl');
    fs.mkdirSync(bin, { recursive: true });
    const fakeBin = (name) =>
      fs.writeFileSync(
        path.join(bin, name),
        `#!${process.execPath}\nconst fs = require('fs');\nlet input = '';\nprocess.stdin.on('data', (d) => (input += d));\nprocess.stdin.on('end', () => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ name: ${JSON.stringify(name)}, args: process.argv.slice(2), input }) + '\\n'));\n`,
        { mode: 0o755 },
      );
    const real = env();
    delete real.NODE_TEST_CONTEXT; // as a person runs it
    delete real.OBYSPHERE_NOTIFY_LOG;
    const run = () =>
      new Promise((resolve) => {
        const c = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'notify', 'test', '--via', 'desktop', '--profile', 'bob'], { env: { ...real, PATH: bin } });
        let out = '';
        c.stdout.on('data', (d) => (out += d));
        c.stderr.on('data', (d) => (out += d));
        c.on('close', (code) => resolve({ code, out }));
      });
    const got = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    const words = 'If you see this, notifications for bob reach you here.';
    setBob({ desktop: true });
    const consoleFile = path.join(home, 'bob', 'notify', 'console.json');
    const link = fs.existsSync(consoleFile) ? JSON.parse(fs.readFileSync(consoleFile, 'utf8')).url : 'http://bob.localhost:4849/';
    if (process.platform === 'darwin') {
      fakeBin('terminal-notifier');
      let r = await run();
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /✓ Desktop {6}shown \(a click opens your console\)/);
      let [c] = got();
      assert.equal(c.name, 'terminal-notifier');
      assert.deepEqual(c.args, ['-title', 'A test from your Obysphere', '-group', 'obysphere-bob-test', '-open', link]);
      assert.equal(c.input, words);
      // without terminal-notifier: osascript, its script on stdin
      fs.rmSync(path.join(bin, 'terminal-notifier'));
      fakeBin('osascript');
      r = await run();
      assert.equal(r.code, 0, r.out);
      c = got().at(-1);
      assert.equal(c.name, 'osascript');
      assert.deepEqual(c.args, []);
      assert.equal(c.input, `display notification "${words}" with title "A test from your Obysphere"\n`);
    } else {
      fakeBin('notify-send');
      const r = await run();
      assert.equal(r.code, 0, r.out);
      const [c] = got();
      assert.deepEqual(c.args, ['--app-name=Obysphere', '--', 'A test from your Obysphere', 'Open your Obysphere console to see it.'], 'the summary only');
    }
    assert.ok(got().every((c) => !c.args.join(' ').includes('reach you here')), 'never the words on a command line');
    // no notifier at all: said, once, and the command fails
    fs.rmSync(bin, { recursive: true, force: true });
    fs.mkdirSync(bin);
    const r = await run();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /✗ Desktop {6}(osascript|notify-send) isn't installed/);
  });

  test('the relay never learns where notifications go', async () => {
    const files = [];
    const walk = (d) => {
      for (const n of fs.readdirSync(d)) {
        const f = path.join(d, n);
        if (fs.statSync(f).isDirectory()) walk(f);
        else files.push(f);
      }
    };
    walk(data);
    for (const f of files) {
      const s = fs.readFileSync(f, 'utf8');
      assert.ok(!s.includes(SLACK_SECRET) && !s.includes(TOPIC) && !s.includes('"notify"'), `${path.basename(f)} has no notification settings`);
    }
    const { agents } = await call('GET', '/api/agents', { tok: token('alice') });
    assert.ok(!JSON.stringify(agents.find((a) => a.id === ids.bob)?.declared).includes('notif'));
  });
});
