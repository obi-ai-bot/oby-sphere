// What a hostile relay can't do through your console (sec/console): put its own page at your
// console's origin (a one-file install has no page of its own, so `ui` won't start), pass HTML
// off as JSON, send its own Content-Security-Policy, or change a message's words, files or sender
// through a message-update. And the page's scripts run only with the nonce of the response
// that served them, at the console and at the relay. A fake relay on this machine, the real
// console; no model, no network beyond this machine. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { consoleAuth } from './console-auth-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = async () => {
  for (;;) {
    const p = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); }); });
    if (p < 4848 || p > 4851) return p;
  }
};
const stopAll = (procs) => Promise.all(procs.map((p) => (p.exitCode !== null || p.signalCode !== null ? null : new Promise((r) => { p.once('exit', r); p.kill(); }))));
const HOSTILE = '<!doctype html><html><head><title>HOSTILE-PAGE</title></head><body><script>fetch("/local/settings")</script></body></html>';
const BAD_FILE_ID = 'x"><img src=x onerror=alert(1)>';

// the scripts of a page, and its CSP's script-src
const scriptsOf = (html) => [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
const scriptSrc = (csp) => /(?:^|;)\s*script-src ([^;]*)/.exec(csp || '')?.[1].trim();

describe('a hostile relay and your console', () => {
  let tmp, home, relay, relayBase, uiPort, uiBase;
  const procs = [];
  const seen = [];
  const env = () => ({ ...process.env, OBYSPHERE_HOME: home, OBYSPHERE_NO_UPDATE_CHECK: '1' });

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-console-relay-')));
    home = path.join(tmp, 'reps');
    // a relay that tries what it can
    relay = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      seen.push(`${req.method} ${u.pathname}`);
      const json = (o, h = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
      if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(HOSTILE); }
      if (u.pathname === '/api/info') return json({ sphere: { name: 'Hostile Sphere', policy: { sealed: false } }, me: null });
      if (u.pathname === '/api/agents') return json({ agents: [] });
      if (u.pathname === '/api/files') return json({ files: [] });
      if (u.pathname === '/api/me') return json({});
      if (u.pathname === '/api/two-types') { res.writeHead(200, { 'content-type': 'application/json, text/html', 'content-security-policy': "script-src 'unsafe-inline' *" }); return res.end('<script>alert(1)</script>'); }
      if (u.pathname === '/api/html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<script>alert(1)</script>'); }
      if (u.pathname === '/api/plain') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-security-policy': 'default-src *' }); return res.end('just words'); }
      if (u.pathname === '/api/files/f_page') { res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "script-src *" }); return res.end('<script>alert(1)</script>'); }
      if (u.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const at = '2026-11-26T10:00:00.000Z';
        res.write(`event: message-update\ndata: ${JSON.stringify({ id: 'm_one', claimedAt: at, text: 'words the relay swapped in', from: 'a_mallory', files: [{ id: BAD_FILE_ID, name: 'x' }], waiting: { for: 'owner', until: at, since: at, by: 'a_bob', note: '<b>x</b>' } })}\n\n`);
        res.write(`event: message-update\ndata: ${JSON.stringify({ id: 'm_two', waiting: null, startedAt: 'not a time', claimedAt: { toString: 1 } })}\n\n`);
        res.write(`event: message-update\ndata: ${JSON.stringify({ id: '"><img src=x>', claimedAt: at })}\n\n`);
        res.write(`event: message-update\ndata: not json\n\n`);
        res.write(`event: agent\ndata: ${JSON.stringify({ id: 'a_carol', name: 'carol' })}\n\n`);
        return res.end();
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
    });
    const rport = await freePort();
    await new Promise((r) => relay.listen(rport, '127.0.0.1', r));
    relayBase = `http://127.0.0.1:${rport}`;
    // a profile that joined it (written as join writes one)
    const dir = path.join(home, 'bob');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ sphere: relayBase, sphereName: 'Hostile Sphere', token: 'tok_bob_never_shown', agent: { id: 'a_bob', name: 'bob', owner: 'Bob Test' } }), { mode: 0o600 });
    uiPort = await freePort();
    uiBase = `http://127.0.0.1:${uiPort}`;
    const ui = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'ui', '--profile', 'bob', '--port', String(uiPort)], { env: env() });
    let out = '';
    ui.stdout.on('data', (d) => (out += d));
    ui.stderr.on('data', (d) => (out += d));
    procs.push(ui);
    for (let i = 0; i < 100 && !/your console for/.test(out); i++) await sleep(100);
    assert.match(out, /your console for/, out);
  });
  after(async () => {
    await stopAll(procs);
    relay.close();
    if (!process.env.SPHERE_TEST_KEEP) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const get = (p, headers = {}) => fetch(uiBase + p, { headers: { ...consoleAuth(path.join(home, 'bob'), uiBase), ...headers } });

  test('a one-file install (rep.mjs with no page beside it) never serves the relay’s page with your local API', async () => {
    const solo = path.join(tmp, 'solo');
    fs.mkdirSync(solo);
    fs.copyFileSync(path.join(ROOT, 'rep.mjs'), path.join(solo, 'rep.mjs'));
    const port = await freePort();
    const before = seen.length;
    const p = spawn(process.execPath, [path.join(solo, 'rep.mjs'), 'ui', '--profile', 'bob', '--port', String(port)], { env: env() });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    procs.push(p);
    let page = null;
    for (let i = 0; i < 60 && p.exitCode === null; i++) {
      try { page = await (await fetch(`http://127.0.0.1:${port}/`)).text(); break; } catch {}
      await sleep(100);
    }
    assert.ok(page === null || !page.includes('HOSTILE-PAGE'), "the relay's page, at your console's origin");
    const code = await new Promise((r) => (p.exitCode !== null ? r(p.exitCode) : p.once('exit', r)));
    assert.notEqual(code, 0, out);
    assert.match(out, /public\/index\.html/, 'it says what is missing');
    assert.match(out, /install\.sh|DEPLOY\.md/, 'and how to install it properly');
    assert.ok(!seen.slice(before).includes('GET /'), 'it never asks the relay for a page');
  });

  test("the relay's answers: one type exactly, and this console's CSP, never the relay's", async () => {
    const two = await get('/api/two-types');
    assert.equal(two.headers.get('content-type'), 'application/octet-stream', '"application/json, text/html" is no JSON');
    assert.equal(two.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(two.headers.get('x-content-type-options'), 'nosniff');
    const html = await get('/api/html');
    assert.equal(html.headers.get('content-type'), 'application/octet-stream');
    const plain = await get('/api/plain');
    assert.equal(plain.headers.get('content-type'), 'text/plain; charset=utf-8', 'a plain type passes as it is');
    assert.equal(plain.headers.get('content-security-policy'), "default-src 'none'; sandbox", 'with our CSP, not "default-src *"');
    const file = await get('/api/files/f_page');
    assert.equal(file.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  });

  test('a message-update reaches the page with its timing and waiting only, each checked', async () => {
    const r = await get('/api/stream');
    assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    const body = await r.text();
    const events = body.split('\n\n').filter((b) => b.startsWith('event: ')).map((b) => ({ ev: /^event: (\S+)/.exec(b)[1], data: JSON.parse(b.split('\n').find((l) => l.startsWith('data: ')).slice(6)) }));
    const updates = events.filter((e) => e.ev === 'message-update').map((e) => e.data);
    assert.deepEqual(updates, [
      { id: 'm_one', claimedAt: '2026-11-26T10:00:00.000Z', waiting: { for: 'owner', until: '2026-11-26T10:00:00.000Z', since: '2026-11-26T10:00:00.000Z', by: 'a_bob' } },
      { id: 'm_two', waiting: null },
    ]);
    assert.ok(!body.includes('words the relay swapped in') && !body.includes('onerror') && !body.includes('a_mallory'), body);
    assert.ok(events.some((e) => e.ev === 'agent'), 'other events pass as they came');
  });

  test("the console's page: its scripts carry this response's nonce, and the CSP allows no others", async () => {
    const a = await fetch(uiBase + '/');
    const b = await fetch(uiBase + '/');
    for (const [r, html] of [[a, await a.text()], [b, await b.text()]]) {
      const src = scriptSrc(r.headers.get('content-security-policy'));
      assert.match(src, /^'nonce-[A-Za-z0-9+/=]{22,}'$/, src);
      assert.ok(!/unsafe-inline/.test(src));
      const nonce = /'nonce-([^']+)'/.exec(src)[1];
      const tags = scriptsOf(html);
      assert.ok(tags.length >= 2, 'the console data and the page');
      for (const t of tags) assert.equal(t, `<script nonce="${nonce}">`);
    }
    assert.notEqual(scriptSrc(a.headers.get('content-security-policy')), scriptSrc(b.headers.get('content-security-policy')), 'a new nonce each time');
  });
});

describe("the relay's page: its scripts carry the response's nonce", () => {
  let relay, base, data;
  before(async () => {
    data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-page-nonce-')));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    relay = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', data], {
      env: { ...process.env, SPHERE_KEY: 'join-key-page-nonce-0123456789', SPHERE_ADMIN_KEY: 'admin-key-page-nonce-0123456789', SPHERE_STORE: 'fs', SPHERE_SEALED: '0' },
      stdio: 'ignore',
    });
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
      await sleep(100);
    }
  });
  after(async () => {
    await stopAll([relay]);
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test('GET / at the relay', async () => {
    const nonces = [];
    for (let i = 0; i < 2; i++) {
      const r = await fetch(base + '/');
      const html = await r.text();
      const csp = r.headers.get('content-security-policy');
      const src = scriptSrc(csp);
      assert.match(src, /^'nonce-[A-Za-z0-9+/=]{22,}'$/, csp);
      assert.match(csp, /frame-ancestors 'none'/);
      const nonce = /'nonce-([^']+)'/.exec(src)[1];
      nonces.push(nonce);
      const tags = scriptsOf(html);
      assert.ok(tags.length >= 1);
      for (const t of tags) assert.equal(t, `<script nonce="${nonce}">`);
    }
    assert.notEqual(nonces[0], nonces[1]);
  });
});
