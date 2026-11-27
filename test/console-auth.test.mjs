// Your console is yours alone (sec/console, sec2/console). `rep.mjs ui` makes a new secret each
// time it starts and keeps it in the profile (console-auth.json, 0600). Every /local/* and /api/*
// call needs it in x-obysphere-auth: a program of this user's reads it there, and a browser's page
// gets it by trading a code that works once, minted for a program that has the secret (#code=…,
// from obysphere open), and keeps it in its tab (sessionStorage). No cookie carries it: cookies
// reach every port of a host. It's never in a log, a command line, the menu bar's model or a
// notification. Other local users, containers and pages never get in on a constant header. The
// console also listens on ::1 beside 127.0.0.1, so nothing else can take its address, and proves
// who it is to `obysphere` with the secret, not its favicon. Its proxy never hands the page a
// token. A real relay, real consoles, no model, no network beyond this machine. `npm test`.
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
      assert.equal((await req(port, { method: 'POST', path: '/local/open-code', headers: h, body: {} })).status, 401, 'no sign-in code without the secret');
    }
    // the secret in a cookie is no credential (cookies reach every port of a host: R19)
    const secret = consoleSecret(bobDir(), port);
    for (const cookie of [`obysphere-console-${port}=${secret}`, `x=${secret}`]) {
      assert.equal((await req(port, { path: '/api/messages?limit=5', headers: page({ cookie }) })).status, 401, cookie);
      assert.equal((await req(port, { path: '/local/invite', headers: page({ cookie, 'x-obysphere-console': '1' }) })).status, 401, cookie);
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
    // who it is, for the page once it's signed in
    const me = await req(port, { path: '/local/me', headers: page({ [AUTH_HEADER]: secret }) });
    assert.equal(me.status, 200, me.body);
    assert.deepEqual(me.json, { name: 'bob', owner: 'Bob Test', sphere: base, sphereName: 'Auth Sphere' });
  });

  test("what it prints when it isn't in a terminal (a service's log) holds no secret and no sign-in code (R25, R46, R61)", async () => {
    const secret = consoleSecret(bobDir(), port);
    assert.ok(uiOut.includes(`http://bob.localhost:${port}/`), uiOut);
    assert.ok(!uiOut.includes(secret), 'never the secret');
    assert.ok(!/#(auth|code)=/.test(uiOut), uiOut);
    assert.ok(!uiOut.includes(`localhost:${port}/#`), uiOut);
    assert.match(uiOut, /rep\.mjs open/, 'it says how to sign a browser in');
  });

  test('a browser: a code that works once, traded for the secret, which the page keeps in its tab; never a cookie (R19)', async () => {
    const secret = consoleSecret(bobDir(), port);
    // the page holds nothing of yours, however it's asked for: it signs in by itself
    for (const h of [{ host: host() }, { host: host(), [AUTH_HEADER]: secret }, { host: host(), cookie: `obysphere-console-${port}=${secret}` }]) {
      const bare = await req(port, { headers: h });
      assert.equal(bare.status, 200);
      assert.match(bare.body, /window\.OBYSPHERE_CONSOLE=\{\}/);
      assert.ok(!bare.body.includes('Bob Test') && !bare.body.includes(base) && !bare.body.includes(secret), 'no owner, Sphere or secret in the page');
      assert.equal(bare.headers['set-cookie'], undefined);
    }
    // the old trade for a cookie is gone
    const old = await req(port, { method: 'POST', path: '/local/auth', headers: page({ [AUTH_HEADER]: secret }) });
    assert.equal(old.status, 410, old.body);
    assert.equal(old.headers['set-cookie'], undefined, 'no cookie');
    // a program with the secret asks for a code (obysphere open, the menu bar, a notification)
    const minted = await req(port, { method: 'POST', path: '/local/open-code', headers: { [AUTH_HEADER]: secret }, body: {} });
    assert.equal(minted.status, 200, minted.body);
    const { code } = minted.json;
    assert.match(code, /^[A-Za-z0-9_-]{43}$/, '256 random bits');
    assert.notEqual(code, secret);
    assert.ok(Date.parse(minted.json.expiresAt) > Date.now() && Date.parse(minted.json.expiresAt) <= Date.now() + 5 * 60e3 + 1000, 'a few minutes at most');
    const signin = (c, extra = {}) => req(port, { method: 'POST', path: '/console-signin', headers: page(extra), body: { code: c } });
    // only from this console's own page
    assert.equal((await signin(code, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await signin(code, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await req(port, { method: 'POST', path: '/console-signin', headers: { host: `evil.example:${port}` }, body: { code } })).status, 421);
    // a code it never made: nothing, and nothing changes
    const wrong = await signin('y'.repeat(43));
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.code, 'console_auth');
    assert.equal(consoleSecret(bobDir(), port), secret);
    // the trade: the secret, once, and no cookie
    const ok = await signin(code);
    assert.equal(ok.status, 200, ok.body);
    assert.deepEqual(ok.json, { secret });
    assert.equal(ok.headers['set-cookie'], undefined);
    assert.equal(ok.headers['cache-control'], 'no-store');
    // with it, the page calls the API in the header
    assert.equal((await req(port, { path: '/local/invite', headers: page({ [AUTH_HEADER]: ok.json.secret }) })).status, 200);
    // the same code again: someone else used it, or it was used twice. Nothing for the second, and
    // the console makes a new secret, so whoever used it first is signed out too
    const again = await signin(code);
    assert.equal(again.status, 401, again.body);
    assert.match(again.json.error, /already used/);
    const now = consoleSecret(bobDir(), port);
    assert.notEqual(now, secret, 'a new secret');
    assert.equal((await req(port, { path: '/local/invite', headers: { [AUTH_HEADER]: secret } })).status, 401, 'the old one opens nothing');
    assert.equal((await req(port, { path: '/local/invite', headers: { [AUTH_HEADER]: now } })).status, 200);
    // a bad body
    assert.equal((await req(port, { method: 'POST', path: '/console-signin', headers: page(), body: 'not json' })).status, 401);
    assert.equal((await req(port, { method: 'GET', path: '/console-signin', headers: page() })).status, 405);
  });

  test("the console's proxy never hands the page a token: a new one goes through /local/token alone (R54)", async () => {
    const secret = consoleSecret(bobDir(), port);
    const before = token('bob');
    assert.equal((await req(port, { method: 'POST', path: '/api/me/token', headers: page({ [AUTH_HEADER]: secret }), body: {} })).status, 403);
    for (const p of ['/api/me/token', '/api/me/token/', '/api//me/token', '/API/me/token', '/api/ME/token', '/api/join', '/api/me/token?__path=/api/me/token', '/api/info?__path=/api/me/token']) {
      const r = await req(port, { method: 'POST', path: p, headers: page({ [AUTH_HEADER]: secret }), body: {} });
      assert.ok(!/tok_/.test(r.body), `${p}: ${r.body}`);
      if (!p.startsWith('/api/info')) assert.ok([403, 404].includes(r.status), `${p}: ${r.status} ${r.body}`); // refused, or not the console's to pass on
    }
    assert.equal(token('bob'), before, 'the profile keeps its token');
    const still = await fetch(`${base}/api/info`, { headers: { authorization: `Bearer ${before}` } });
    assert.equal(still.status, 200, 'and the relay still takes it: it was never replaced');
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

  test('a new secret at each start: the old one, and its codes, no longer open it', async () => {
    const old = consoleSecret(bobDir(), port);
    const { code } = (await req(port, { method: 'POST', path: '/local/open-code', headers: { [AUTH_HEADER]: old }, body: {} })).json;
    await stopAll([ui]);
    await startConsole();
    const now = consoleSecret(bobDir(), port);
    assert.notEqual(now, old);
    assert.equal((await req(port, { path: '/local/invite', headers: { [AUTH_HEADER]: old } })).status, 401);
    assert.equal((await req(port, { method: 'POST', path: '/console-signin', headers: page(), body: { code } })).status, 401, 'a code from before');
    assert.equal(consoleSecret(bobDir(), port), now, 'and that changes nothing');
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

    // a sign-in link's code, traded as the page trades it: the secret, once
    const redeem = async (link) => {
      const code = new URLSearchParams(new URL(link).hash.slice(1)).get('code');
      assert.match(String(code), /^[A-Za-z0-9_-]{43}$/, link);
      const r = await req(port, { method: 'POST', path: '/console-signin', headers: page(), body: { code } });
      assert.equal(r.status, 200, r.body);
      return r.json.secret;
    };

    test('obysphere open: your console, signed in, from one command; the link goes to no command line (R24, R66)', async () => {
      servicePort(port);
      const secret = consoleSecret(bobDir(), port);
      const st = await cli(['status', '--json', '--profile', 'bob']);
      const row = JSON.parse(st.out).profiles[0];
      assert.equal(row.running, true, st.out);
      assert.equal(row.console, `http://bob.localhost:${port}/`, 'status never prints the secret');
      assert.ok(!st.out.includes(secret));
      // macOS: osascript gets the link on its stdin; its command line, which any user of the Mac
      // can read with ps, holds nothing. The link holds a code that works once, not the secret.
      let r = await cli(['open', '--profile', 'bob'], { OBYSPHERE_SERVICE_PLATFORM: 'darwin' });
      assert.equal(r.code, 0, r.out);
      let last = dry().at(-1);
      assert.equal(last.cmd, 'osascript');
      assert.deepEqual(last.args, []);
      const m = /^open location "(http:\/\/bob\.localhost:\d+\/#code=[A-Za-z0-9_-]{43})"\n$/.exec(last.input);
      assert.ok(m, last.input);
      assert.ok(!JSON.stringify(last).includes(secret), 'never the secret');
      assert.ok(!r.out.includes(secret) && !r.out.includes('#code='), 'what it prints holds neither');
      assert.equal(await redeem(m[1]), secret, 'the code signs the browser in');
      // a page of it, printed for a program that opens it itself (the menu bar, a notification)
      r = await cli(['open', '--profile', 'bob', '--page', 'you', '--print']);
      assert.equal(r.code, 0, r.out);
      const printed = r.out.trim();
      assert.match(printed, new RegExp(`^http://bob\\.localhost:${port}/#code=[A-Za-z0-9_-]{43}&page=you$`));
      assert.equal(await redeem(printed), secret);
      assert.equal((await cli(['open', '--profile', 'bob', '--page', 'x&code=1', '--print'])).code, 1, 'a page by its name only');
      // Linux: a browser started by xdg-open keeps its arguments, which other users can read, so
      // it opens a page in your profile (0600) that goes on to the link
      r = await cli(['open', '--profile', 'bob'], { OBYSPHERE_SERVICE_PLATFORM: 'linux', HOME: path.join(tmp, 'no-snap-home') });
      assert.equal(r.code, 0, r.out);
      last = dry().at(-1);
      assert.equal(last.cmd, 'xdg-open');
      assert.ok(!JSON.stringify(last).includes(secret), JSON.stringify(last));
      let file = last.args[0];
      assert.ok(file.startsWith(bobDir()), file);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      let text = fs.readFileSync(file, 'utf8');
      assert.ok(!text.includes(secret), 'the page holds a code, not the secret');
      assert.equal(await redeem(/url=([^"]+)"/.exec(text)[1].replace(/&#38;/g, '&')), secret);
      // a snap browser (Ubuntu's Firefox) reads no hidden folder of your home: the page goes in
      // that snap's own folder
      const fakeHome = path.join(tmp, 'snap-home');
      const snapDir = path.join(fakeHome, 'snap', 'firefox', 'common');
      fs.mkdirSync(snapDir, { recursive: true });
      const bin = path.join(tmp, 'xdg-bin');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'xdg-mime'), '#!/bin/sh\n[ "$*" = "query default text/html" ] && echo firefox_firefox.desktop\n', { mode: 0o755 });
      r = await cli(['open', '--profile', 'bob'], { OBYSPHERE_SERVICE_PLATFORM: 'linux', HOME: fakeHome, PATH: `${bin}:${process.env.PATH}` });
      assert.equal(r.code, 0, r.out);
      file = dry().at(-1).args[0];
      assert.equal(path.dirname(file), snapDir, file);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      text = fs.readFileSync(file, 'utf8');
      assert.ok(!text.includes(secret));
      assert.equal(await redeem(/url=([^"]+)"/.exec(text)[1].replace(/&#38;/g, '&')), secret);
      // Windows: no cmd /c start, which reads a link's & as its own
      r = await cli(['open', '--profile', 'bob', '--page', 'you'], { OBYSPHERE_SERVICE_PLATFORM: 'win32' });
      assert.equal(r.code, 0, r.out);
      last = dry().at(-1);
      assert.equal(last.cmd, 'rundll32');
      assert.equal(last.args[0], 'url.dll,FileProtocolHandler');
      assert.ok(!JSON.stringify(last).includes(secret));
      assert.equal(await redeem(last.args[1]), secret);
    });

    test('obysphere logs and menubar model never print the secret; the menu opens pages through obysphere open (R25, R44, R46)', async () => {
      servicePort(port);
      const secret = consoleSecret(bobDir(), port);
      // a log from before, with a signed-in link in it
      const logs = path.join(bobDir(), 'logs');
      fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(logs, 'console.log'), `● your console for bob: http://bob.localhost:${port}/#auth=${secret}\n  Also at http://localhost:${port}/#auth=${secret}\nan ordinary line\n`, { mode: 0o600 });
      const lg = await cli(['logs', '--profile', 'bob', '-n', '100']);
      assert.equal(lg.code, 0, lg.out);
      assert.ok(!lg.out.includes(secret), lg.out);
      assert.match(lg.out, /http:\/\/bob\.localhost:\d+\/#auth=…/);
      assert.match(lg.out, /an ordinary line/);
      // the menu bar's model
      fs.mkdirSync(path.join(tmp, 'services'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'services', 'com.obysphere.bob.plist'), '<plist/>');
      const md = await cli(['menubar', 'model'], { OBYSPHERE_SERVICE_PLATFORM: 'darwin' });
      assert.equal(md.code, 0, md.out);
      assert.ok(!md.out.includes(secret), 'no secret in the model');
      assert.ok(!/#(auth|code)=/.test(md.out), md.out);
      const items = (list) => list.flatMap((i) => [i, ...items(i.items || [])]);
      const opens = items(JSON.parse(md.out).items).filter((i) => i.kind === 'open');
      assert.ok(opens.length >= 2, md.out);
      for (const o of opens) {
        assert.equal(o.args[0], 'open');
        assert.deepEqual(o.args.slice(1, 3), ['--profile', 'bob']);
        assert.equal(o.args.at(-1), '--print', 'obysphere prints a link that works once, and the app opens it');
        assert.ok(o.url.startsWith(`http://bob.localhost:${port}/`), 'the page itself, for an app from before');
      }
      // what the app runs for "Open console" gives a link that signs the browser in
      const open = opens.find((o) => o.title === 'Open console');
      const r = await cli(open.args);
      assert.equal(r.code, 0, r.out);
      assert.equal(await redeem(r.out.trim()), secret);
    });

    test('rep.mjs open: a link that works once, for a notification or a terminal; a desktop notification carries no secret', async () => {
      const secret = consoleSecret(bobDir(), port);
      const r = await rep(['open', '--profile', 'bob', '--page', 'mode=conversation&c=general', '--print']);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out.trim(), new RegExp(`^http://bob\\.localhost:${port}/#code=[A-Za-z0-9_-]{43}&mode=conversation&c=general$`));
      assert.equal(await redeem(r.out.trim()), secret);
      assert.equal((await rep(['open', '--profile', 'bob', '--page', 'auth=x', '--print'])).code, 1, 'only a page of the console');
      if (process.platform !== 'darwin') return;
      // macOS: the note the app gets (in a file only you can read) has the page and how to sign a
      // browser in when it's clicked (rep.mjs open --print), never the secret
      const app = path.join(tmp, 'apps', 'Obysphere.app');
      const program = path.join(app, 'Contents', 'MacOS', 'Obysphere');
      fs.mkdirSync(path.dirname(program), { recursive: true });
      fs.writeFileSync(program, 'not run');
      const src = fs.readFileSync(path.join(ROOT, 'rep.mjs'), 'utf8');
      const version = /const NOTIFIER_VERSION = '(\d+)';/.exec(src)[1];
      fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<key>CFBundleVersion</key><string>${version}</string>`);
      fs.writeFileSync(path.join(home, 'notifier.json'), JSON.stringify({ app, version, sha256: crypto.createHash('sha256').update(fs.readFileSync(program)).digest('hex') }));
      const bin = path.join(tmp, 'open-bin');
      const notes = path.join(tmp, 'notes.jsonl');
      fs.mkdirSync(bin, { recursive: true });
      // the app, as `open -n -g <app> --args --note <file>` starts it: here, it keeps the note
      fs.writeFileSync(path.join(bin, 'open'), `#!${process.execPath}\nconst fs = require('fs');\nconst a = process.argv.slice(2);\nconst f = a[a.indexOf('--note') + 1];\nfs.appendFileSync(${JSON.stringify(notes)}, JSON.stringify({ args: a, note: JSON.parse(fs.readFileSync(f, 'utf8')) }) + '\\n');\nfs.rmSync(f);\nfs.writeFileSync(f + '.done', 'ok');\n`, { mode: 0o755 });
      const e = env({ OBYSPHERE_TEST: '1', OBYSPHERE_NOTIFIER_APP: app, PATH: bin });
      delete e.NODE_TEST_CONTEXT;
      delete e.OBYSPHERE_NOTIFY_LOG;
      const sent = await new Promise((resolve) => {
        const c = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'notify', 'test', '--via', 'desktop', '--profile', 'bob'], { env: e });
        let out = '';
        c.stdout.on('data', (d) => (out += d));
        c.stderr.on('data', (d) => (out += d));
        c.on('close', (code) => resolve({ code, out }));
      });
      assert.equal(sent.code, 0, sent.out);
      const [{ note }] = fs.readFileSync(notes, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.ok(!JSON.stringify(note).includes(secret), JSON.stringify(note));
      assert.ok(!/#(auth|code)=/.test(JSON.stringify(note)), JSON.stringify(note));
      assert.equal(note.url, `http://bob.localhost:${port}/`);
      assert.deepEqual({ node: note.node, cli: note.cli, home: note.home, profile: note.profile }, { node: process.execPath, cli: path.join(ROOT, 'rep.mjs'), home, profile: 'bob' });
      // a click: the app runs rep.mjs open --print, as the note says, and opens what it prints
      const click = await new Promise((resolve) => {
        const c = spawn(note.node, ['--preserve-symlinks-main', note.cli, 'open', '--profile', note.profile, ...(note.page ? ['--page', note.page] : []), '--print'], { env: { PATH: '/usr/bin:/bin', OBYSPHERE_HOME: note.home } });
        let out = '';
        c.stdout.on('data', (d) => (out += d));
        c.on('close', (code) => resolve({ code, out }));
      });
      assert.equal(click.code, 0, click.out);
      assert.equal(await redeem(click.out.trim()), secret);
    });
  });
});
