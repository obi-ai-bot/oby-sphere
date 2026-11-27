// Your console is yours alone (sec/console). `rep.mjs ui` makes a new secret each time it
// starts and keeps it in the profile (console-auth.json, 0600). Every /local/* and /api/* call
// needs it: a program of this user's sends it in x-obysphere-auth, and a browser gets it once in
// a link's fragment (#auth=…) and trades it for an HttpOnly, SameSite=Strict cookie. Other
// local users, containers and pages never get in on a constant header. The console also listens
// on ::1 beside 127.0.0.1, so nothing else can take its address, and proves who it is to
// `obysphere` with the secret, not its favicon. A real relay, real consoles, no model, no network
// beyond this machine. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { consoleSecret, AUTH_HEADER } from './console-auth-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const KEY = 'join-key-console-auth-0123456789';
const ADMIN = 'admin-key-console-auth-0123456789';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a free port on both 127.0.0.1 and ::1, never the demo's (4848-4851)
const freePort = async () => {
  for (;;) {
    const p = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); }); });
    if (p >= 4848 && p <= 4851) continue;
    if (!HAS_V6 || (await new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(p, '::1', () => s.close(() => resolve(true))); }))) return p;
  }
};
// whether this machine has IPv6's loopback (CI containers may not)
const HAS_V6 = await new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(0, '::1', () => s.close(() => resolve(true))); });
const stopAll = (procs) => Promise.all(procs.map((p) => (p.exitCode !== null || p.signalCode !== null ? null : new Promise((r) => { p.once('exit', r); p.kill(); }))));
// an HTTP request with any Host and headers, to 127.0.0.1 or ::1: { status, headers, body }
function req(port, { method = 'GET', path: p = '/', headers = {}, body, family = 4 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const r = http.request({ host: family === 6 ? '::1' : '127.0.0.1', port, path: p, method, headers: { ...(data !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let out = '';
      res.on('data', (d) => (out += d));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(out); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: out, json });
      });
    });
    r.on('error', reject);
    r.end(data ?? undefined);
  });
}
const proofOf = (secret, nonce) => crypto.createHmac('sha256', secret).update(`obysphere console hello ${nonce}`).digest('hex');

describe('your console: only you get in', () => {
  let tmp, data, home, work, base, port, ui, uiOut = '';
  const procs = [];
  const env = (extra = {}) => ({ ...process.env, OBYSPHERE_HOME: home, OBYSPHERE_NO_UPDATE_CHECK: '1', ...extra });
  const rep = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), ...args], { env: env() });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      const t = setTimeout(() => p.kill(), 30000);
      p.on('close', (code) => { clearTimeout(t); resolve({ out, code }); });
    });
  const bobDir = () => path.join(home, 'bob');
  const token = (n) => JSON.parse(fs.readFileSync(path.join(home, n, 'profile.json'), 'utf8')).token;
  const host = () => `bob.localhost:${port}`;
  const origin = () => `http://${host()}`;
  // the page's own requests: its Host, its Origin, same-origin
  const page = (extra = {}) => ({ host: host(), origin: origin(), 'sec-fetch-site': 'same-origin', ...extra });
  const startConsole = async () => {
    uiOut = '';
    ui = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'ui', '--profile', 'bob', '--port', String(port)], { env: env() });
    ui.stdout.on('data', (d) => (uiOut += d));
    ui.stderr.on('data', (d) => (uiOut += d));
    procs.push(ui);
    for (let i = 0; i < 100 && !/your console for/.test(uiOut); i++) await sleep(100);
    assert.match(uiOut, /your console for/, uiOut);
  };
  const settingsText = () => { try { return fs.readFileSync(path.join(bobDir(), 'settings.json'), 'utf8'); } catch { return null; } };
  const relayMessages = async () => (await (await fetch(`${base}/api/messages?limit=500`, { headers: { authorization: `Bearer ${token('alice')}` } })).json()).messages;

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-console-auth-')));
    data = path.join(tmp, 'relay');
    home = path.join(tmp, 'reps');
    work = path.join(tmp, 'work');
    for (const d of [data, home, work]) fs.mkdirSync(d, { recursive: true });
    const rport = await freePort();
    base = `http://127.0.0.1:${rport}`;
    procs.push(spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(rport), '--host', '127.0.0.1', '--data', data, '--name', 'Auth Sphere'], {
      env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_STORE: 'fs', SPHERE_SEALED: '0' },
      stdio: 'ignore',
    }));
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
      await sleep(100);
    }
    for (const [name, owner] of [['bob', 'Bob Test'], ['alice', 'Alice Test']]) {
      const r = await rep(['join', `${base}/#key=${KEY}`, '--name', name, '--owner', owner, '--cwd', work]);
      assert.equal(r.code, 0, r.out);
    }
    await fetch(`${base}/api/messages`, { method: 'POST', headers: { authorization: `Bearer ${token('alice')}`, 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'general', text: 'a note only members read' }) });
    port = await freePort();
    await startConsole();
  });
  after(async () => {
    await stopAll(procs);
    if (!process.env.SPHERE_TEST_KEEP) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test('without the secret, nothing: not the messages, the join key, your settings, your decisions, or posting as you', async () => {
    const before = settingsText();
    const posted = (await relayMessages()).length;
    // the old constant header is no credential, from any Host the console answers to
    for (const h of [{}, { 'x-obysphere-console': '1' }, page({ 'x-obysphere-console': '1' }), { [AUTH_HEADER]: 'not-the-secret', 'x-obysphere-console': '1' }]) {
      const msgs = await req(port, { path: '/api/messages?limit=50', headers: h });
      assert.equal(msgs.status, 401, `GET /api/messages ${JSON.stringify(h)}`);
      assert.ok(!msgs.body.includes('a note only members read'));
      assert.match(String(msgs.headers['www-authenticate']), /^Obysphere-Console/, 'the page can tell it from the relay');
      assert.equal((await req(port, { path: '/api/stream', headers: h })).status, 401, 'the live stream');
      const inv = await req(port, { path: '/local/invite', headers: h });
      assert.equal(inv.status, 401, 'GET /local/invite');
      assert.ok(!inv.body.includes(KEY), 'never the join key');
      assert.equal((await req(port, { method: 'PUT', path: '/local/settings', headers: h, body: { settings: { machine: { shell: 'full' }, access: { default: 'answer', agents: { alice: 'trust' } } } } })).status, 401, 'PUT /local/settings');
      assert.equal((await req(port, { method: 'POST', path: '/local/pending/w_0123456789ab', headers: h, body: { decision: 'answer' } })).status, 401, 'a decision');
      assert.equal((await req(port, { method: 'POST', path: '/api/messages', headers: h, body: { channel: 'general', text: 'posted as Bob by someone else' } })).status, 401, 'posting as you');
      assert.equal((await req(port, { path: '/local/a-route-added-later', headers: h })).status, 401, 'every /local route, known or not');
    }
    assert.equal(settingsText(), before, 'your settings are as they were');
    assert.equal((await relayMessages()).length, posted, 'nothing was posted');
  });

  test('a program of yours: the secret from the profile, in x-obysphere-auth', async () => {
    const file = path.join(bobDir(), 'console-auth.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'only you can read it');
    const secret = consoleSecret(bobDir(), port);
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/, '256 random bits');
    const inv = await req(port, { path: '/local/invite', headers: { [AUTH_HEADER]: secret } });
    assert.equal(inv.status, 200, inv.body);
    assert.equal(inv.json.invite, `${base}/#key=${KEY}`);
    const msgs = await req(port, { path: '/api/messages?limit=50', headers: { [AUTH_HEADER]: secret } });
    assert.equal(msgs.status, 200);
    assert.ok(msgs.body.includes('a note only members read'));
    // the Host checks still hold, secret or not (DNS rebinding)
    assert.equal((await req(port, { path: '/local/invite', headers: { host: `evil.example:${port}`, [AUTH_HEADER]: secret } })).status, 421);
    // the console prints the link with it, for you to open (and the second browser)
    assert.ok(uiOut.includes(`http://bob.localhost:${port}/#auth=${secret}`), uiOut);
  });

  test('a browser: #auth=… traded once for a cookie, HttpOnly and SameSite=Strict', async () => {
    const secret = consoleSecret(bobDir(), port);
    // the page without the cookie: it can sign in, and holds nothing of yours
    const bare = await req(port, { headers: { host: host() } });
    assert.equal(bare.status, 200);
    assert.match(bare.body, /window\.OBYSPHERE_CONSOLE=\{"signin":true\}/);
    assert.ok(!bare.body.includes('Bob Test') && !bare.body.includes(base), 'no owner or Sphere before you sign in');
    // a wrong secret gets nothing
    const wrong = await req(port, { method: 'POST', path: '/local/auth', headers: page({ [AUTH_HEADER]: 'x'.repeat(43) }) });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers['set-cookie'], undefined);
    // the trade
    const ok = await req(port, { method: 'POST', path: '/local/auth', headers: page({ [AUTH_HEADER]: secret }) });
    assert.equal(ok.status, 204, ok.body);
    const set = String(ok.headers['set-cookie']);
    const [pair, ...attrs] = set.split(';').map((s) => s.trim());
    assert.equal(pair, `obysphere-console-${port}=${secret}`);
    assert.deepEqual(new Set(attrs.map((a) => a.toLowerCase())), new Set(['path=/', 'httponly', 'samesite=strict']), set);
    const cookie = pair;
    // with it: the page is yours, and so is the API
    const signed = await req(port, { headers: { host: host(), cookie } });
    assert.match(signed.body, /window\.OBYSPHERE_CONSOLE=\{"name":"bob","owner":"Bob Test"/);
    assert.equal((await req(port, { path: '/local/invite', headers: page({ cookie, 'x-obysphere-console': '1' }) })).status, 200);
    assert.equal((await req(port, { path: '/api/messages?limit=5', headers: page({ cookie }) })).status, 200, 'a GET, as a download link sends it');
    // a write needs the page's header too, and every call its own origin
    assert.equal((await req(port, { method: 'POST', path: '/api/messages', headers: page({ cookie }), body: { channel: 'general', text: 'no header' } })).status, 403);
    assert.equal((await req(port, { path: '/local/invite', headers: page({ cookie }) })).status, 403, '/local needs the header on GETs too');
    assert.equal((await req(port, { path: '/local/invite', headers: page({ cookie, 'x-obysphere-console': '1', 'sec-fetch-site': 'cross-site' }) })).status, 403);
    assert.equal((await req(port, { path: '/api/messages', headers: page({ cookie, 'sec-fetch-site': 'same-site' }) })).status, 403, "another profile's console");
    assert.equal((await req(port, { method: 'POST', path: '/api/messages', headers: page({ cookie, 'x-obysphere-console': '1', origin: 'http://evil.example' }), body: { channel: 'general', text: 'x' } })).status, 403);
    const sent = await req(port, { method: 'POST', path: '/api/messages', headers: page({ cookie, 'x-obysphere-console': '1' }), body: { channel: 'general', text: 'from the page, signed in' } });
    assert.equal(sent.status, 200, sent.body);
    // a cookie from another console, or another start, opens nothing
    assert.equal((await req(port, { path: '/api/messages', headers: page({ cookie: `obysphere-console-${port}=${'y'.repeat(43)}` }) })).status, 401);
  });

  test('the console proves it is yours: a challenge answered with the secret, at both its addresses', async () => {
    const secret = consoleSecret(bobDir(), port);
    const nonce = crypto.randomBytes(16).toString('hex');
    const r = await req(port, { path: `/console-hello?nonce=${nonce}` });
    assert.equal(r.status, 200);
    assert.equal(r.json.proof, proofOf(secret, nonce));
    assert.ok(!r.body.includes(secret), 'never the secret itself');
    assert.equal((await req(port, { path: '/console-hello?nonce=short' })).status, 400);
    if (!HAS_V6) return;
    // *.localhost reaches ::1 first in browsers: the console holds it too
    const six = await req(port, { family: 6, path: `/console-hello?nonce=${nonce}`, headers: { host: host() } });
    assert.equal(six.json?.proof, proofOf(secret, nonce), 'the same console on ::1');
  });

  test('a new secret at each start: the old one, and its cookie, no longer open it', async () => {
    const old = consoleSecret(bobDir(), port);
    await stopAll([ui]);
    await startConsole();
    const now = consoleSecret(bobDir(), port);
    assert.notEqual(now, old);
    assert.equal((await req(port, { path: '/local/invite', headers: { [AUTH_HEADER]: old } })).status, 401);
    assert.equal((await req(port, { path: '/api/messages', headers: page({ cookie: `obysphere-console-${port}=${old}` }) })).status, 401);
    assert.equal((await req(port, { path: '/local/invite', headers: { [AUTH_HEADER]: now } })).status, 200);
  });

  test('another program on [::1]:<port>: the console refuses to start rather than share its address', { skip: !HAS_V6 && 'no IPv6 loopback here' }, async () => {
    const taken = await freePort();
    const squatter = http.createServer((q, s) => s.end('<svg viewBox="0 0 64 64"></svg>'));
    await new Promise((r) => squatter.listen(taken, '::1', r));
    try {
      const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'ui', '--profile', 'bob', '--port', String(taken)], { env: env() });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      const code = await new Promise((r) => { const t = setTimeout(() => { p.kill(); r('still running'); }, 15000); p.on('exit', (c) => { clearTimeout(t); r(c); }); });
      assert.notEqual(code, 0, out);
      assert.notEqual(code, 'still running', out);
      assert.match(out, /::1/, out);
      assert.ok(!(JSON.parse(fs.readFileSync(path.join(bobDir(), 'console-auth.json'), 'utf8'))[taken]), 'no secret kept for it');
    } finally {
      squatter.close();
    }
  });

  describe('obysphere: your console is the one that knows its secret', () => {
    const cli = (args, extra = {}) =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, [path.join(ROOT, 'obysphere.mjs'), ...args], { env: env({ OBYSPHERE_SERVICE_DRYRUN: path.join(tmp, 'dryrun.jsonl'), OBYSPHERE_SERVICE_DIR: path.join(tmp, 'services'), OBYSPHERE_APP_HOME: path.join(tmp, 'app'), OBYSPHERE_RELEASES_API: 'http://127.0.0.1:9/api', ...extra }), stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (out += d));
        p.on('close', (code) => resolve({ code, out }));
      });
    const dry = () => { try { return fs.readFileSync(path.join(tmp, 'dryrun.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    const servicePort = (p) => fs.writeFileSync(path.join(bobDir(), 'service.json'), JSON.stringify({ port: p }));

    test("a stranger at the port with the console's favicon isn't your console", async () => {
      const impostor = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'image/svg+xml' }); s.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>'); });
      const iport = await freePort();
      await new Promise((r) => impostor.listen(iport, '127.0.0.1', r));
      try {
        servicePort(iport);
        const st = await cli(['status', '--json', '--profile', 'bob']);
        assert.equal(st.code, 0, st.out);
        assert.equal(JSON.parse(st.out).profiles[0].running, false, 'not running: it can’t answer the challenge');
        const n = dry().length;
        const op = await cli(['open', '--profile', 'bob']);
        assert.notEqual(op.code, 0);
        assert.match(op.out, /isn't running/);
        assert.equal(dry().length, n, 'no browser opened at a stranger, with your secret');
      } finally {
        impostor.close();
      }
    });

    test('obysphere open: your console, signed in, from one command', async () => {
      servicePort(port);
      const secret = consoleSecret(bobDir(), port);
      const st = await cli(['status', '--json', '--profile', 'bob']);
      const row = JSON.parse(st.out).profiles[0];
      assert.equal(row.running, true, st.out);
      assert.equal(row.console, `http://bob.localhost:${port}/`, 'status never prints the secret');
      assert.ok(!st.out.includes(secret));
      // macOS: open hands the link to the browser (LaunchServices; not left on a command line)
      let r = await cli(['open', '--profile', 'bob'], { OBYSPHERE_SERVICE_PLATFORM: 'darwin' });
      assert.equal(r.code, 0, r.out);
      assert.deepEqual(dry().at(-1), { cmd: 'open', args: [`http://bob.localhost:${port}/#auth=${secret}`] });
      assert.ok(!r.out.includes(secret), 'what it prints holds no secret');
      // Linux: a browser started by xdg-open keeps its arguments, which other users can read, so
      // it opens a page in your profile (0600) that goes on to the link
      r = await cli(['open', '--profile', 'bob'], { OBYSPHERE_SERVICE_PLATFORM: 'linux' });
      assert.equal(r.code, 0, r.out);
      const last = dry().at(-1);
      assert.equal(last.cmd, 'xdg-open');
      assert.ok(!JSON.stringify(last).includes(secret), JSON.stringify(last));
      const file = last.args[0].replace(/^file:\/\//, '');
      assert.ok(file.startsWith(bobDir()), file);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.ok(fs.readFileSync(file, 'utf8').includes(`http://bob.localhost:${port}/#auth=${secret}`));
    });
  });
});
