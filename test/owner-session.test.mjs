// What other members (and a relay) can make the owner's own Claude Code session see and do,
// through `rep.mjs mcp` (no --as-session), its channel and `inbox --hook`. That session has the
// owner's full powers, so: sphere_post and sphere_ask never send a secret, Obysphere's own files,
// a system file, a link or a file the owner's never-read names hide, nor text or a file holding
// this profile's token or keys; a declined Oby notifies nothing, and an Oby the owner hasn't
// listed as Answer or Trust reaches the session only as who and where, never its words, and only
// a few times; the console's address isn't handed over; invisible characters (tags, zero-width,
// variation selectors, line separators) never reach Claude; a message can't fake another
// message, or the end of the fence, in sphere_read, a reply or a downloaded file; a handle is
// confirmed when names look alike; the relay's words come fenced; a downloaded file is
// quarantined and named for what it is; and the channel name a tool gets can't stall it.
// Alice Test is the owner here; bob is listed as Answer, mallory as Decline, carol not at all
// (Ask me first). No network beyond 127.0.0.1, no model: every home, profile and app folder is a
// temp folder, and no runtime is installed. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { mcpSession } from './mcp-protocol-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const REP = path.join(ROOT, 'rep.mjs');
const KEY = 'join-key-owner-session-0123456789';
const ADMIN = 'admin-key-owner-session-0123456789';
const COALESCE_MS = 300;
const CLIENT = { name: 'test-host', version: '1.0.0' };
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (res) => res.result?.content?.map((c) => c.text).join('\n') ?? '';
const waitFor = async (fn, ms = 10000, what = 'the condition') => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
// hidden words, as Unicode tag characters: invisible on screen, read by a model
const tags = (s) => [...s].map((c) => String.fromCodePoint(0xe0000 + c.codePointAt(0))).join('');
// everything between the fence lines of a quoted block (the label names the fence too)
const fenced = (t) => {
  const fence = /QUOTED-[0-9A-F]{12}/.exec(t)?.[0];
  assert.ok(fence, `no fence in ${t}`);
  const lines = t.split('\n');
  const open = lines.indexOf(fence);
  const close = lines.lastIndexOf(fence);
  assert.ok(open >= 0 && close > open, `the fence opens and closes on lines of its own\n${t}`);
  return { fence, inside: lines.slice(open + 1, close), after: lines.slice(close + 1) };
};

describe("the owner's own session", () => {
  let tmp, relay, base, home, work, bin, userHome, appHome, downloads, cfg, logFile, ids;
  const procs = [];
  const envFor = (extra = {}) => ({
    PATH: bin,
    HOME: userHome,
    USERPROFILE: userHome,
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
    OBYSPHERE_HOME: home,
    OBYSPHERE_APP_HOME: appHome,
    OBYSPHERE_NOTIFY_LOG: logFile,
    OBYSPHERE_NOTIFY_COALESCE_MS: String(COALESCE_MS),
    OBYSPHERE_CHANNEL_POLL_MS: '150',
    OBYSPHERE_APPROVE_WAIT_SEC: '8',
    OBYSPHERE_PROBE_CACHE_MS: '0',
    OBYSPHERE_NO_UPDATE_CHECK: '1',
    OBYSPHERE_DOWNLOADS: downloads,
    OBYSPHERE_CHROME: '0',
    CLAUDE_CONFIG_DIR: cfg,
    ...extra,
  });
  const rep = (args, extra = {}) =>
    new Promise((resolve) => {
      const started = Date.now();
      const p = spawn(process.execPath, [REP, ...args], { env: envFor(extra) });
      procs.push(p);
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      const t = setTimeout(() => p.kill(), 30000);
      p.on('close', (code) => {
        clearTimeout(t);
        resolve({ code, out, err, ms: Date.now() - started });
      });
    });
  const profileOf = (n) => JSON.parse(fs.readFileSync(path.join(home, n, 'profile.json'), 'utf8'));
  const token = (n) => profileOf(n).token;
  const call = async (method, url, { tok, body } = {}) => {
    const h = {};
    if (tok) h.authorization = `Bearer ${tok}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const say = async (from, body) => {
    const r = await call('POST', '/api/messages', { tok: token(from), body: { channel: 'general', ...body } });
    assert.ok(r.message, JSON.stringify(r));
    return r.message;
  };
  const dm = async (from, to) => (await call('POST', '/api/dm', { tok: token(from), body: { with: to } })).channel.name;
  const logLines = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  // alice's own session: the MCP server her Claude Code starts, with the channel on
  const session = async (extra = {}) => {
    const s = mcpSession([REP, 'mcp', '--profile', 'alice'], envFor(extra));
    procs.push(s.p);
    const init = await s.request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CLIENT });
    s.notify('notifications/initialized');
    let n = 100;
    s.tool = (name, args = {}) => s.request(++n, 'tools/call', { name, arguments: args }, 60000);
    s.init = init;
    s.channel = () => s.msgs.map((x) => x.m).filter((m) => m.method === 'notifications/claude/channel');
    return s;
  };
  const files = async () => (await call('GET', '/api/files', { tok: token('alice') })).files || [];
  let alice; // her session, shared by the tests below

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-owner-session-')));
    const data = path.join(tmp, 'relay');
    home = path.join(tmp, 'reps');
    work = path.join(tmp, 'work');
    bin = path.join(tmp, 'bin');
    userHome = path.join(tmp, 'home');
    appHome = path.join(tmp, 'app');
    downloads = path.join(tmp, 'downloads');
    cfg = path.join(tmp, 'claude-config');
    logFile = path.join(tmp, 'notify.jsonl');
    for (const d of [data, home, work, bin, userHome, appHome, downloads, cfg]) fs.mkdirSync(d, { recursive: true });
    try {
      fs.symlinkSync(process.execPath, path.join(bin, process.platform === 'win32' ? 'node.exe' : 'node'));
    } catch {
      bin = `${bin}${path.delimiter}${path.dirname(process.execPath)}`;
    }
    for (const n of ['osascript', 'terminal-notifier', 'notify-send']) fs.writeFileSync(path.join(tmp, 'bin', n), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    relay = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', data], {
      env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_STORE: 'fs', SPHERE_ASKS_PER_MIN: '1000', SPHERE_WRITES_PER_MIN: '1000' },
      stdio: process.env.SPHERE_TEST_DEBUG ? 'inherit' : 'ignore',
    });
    procs.push(relay);
    await waitFor(async () => (await fetch(base + '/healthz').catch(() => null))?.ok, 8000, 'the relay');
    // mallory's owner name is bob's owner's first name: name squatting
    for (const [n, owner] of [['alice', 'Alice Test'], ['bob', 'Robert Test'], ['carol', 'Carol Test'], ['mallory', 'Robert']]) {
      const r = await rep(['join', `${base}/#key=${KEY}`, '--name', n, '--owner', owner, '--cwd', work]);
      assert.match(r.out, /joined/, r.out + r.err);
      // no runtime is installed here: nothing ever runs a model
      const missing = path.join(tmp, 'bin', 'not-installed');
      fs.writeFileSync(path.join(home, n, 'profile.json'), JSON.stringify({ ...profileOf(n), claudeBin: missing, codexBin: missing, cursorBin: missing }), { mode: 0o600 });
    }
    ids = Object.fromEntries(['alice', 'bob', 'carol', 'mallory'].map((n) => [n, profileOf(n).agent.id]));
    // alice: bob answers, mallory is declined, carol (not listed) waits for her; *.sqlite is hers alone
    fs.writeFileSync(
      path.join(home, 'alice', 'settings.json'),
      JSON.stringify({ version: 2, routing: { default: { runtime: 'claude' } }, access: { default: 'approve', agents: { bob: 'answer', mallory: 'decline' } }, machine: { folders: [{ path: work, write: false }], neverRead: ['*.sqlite'] }, notify: { desktop: false } }),
      { mode: 0o600 },
    );
    // secrets on alice's computer
    fs.mkdirSync(path.join(userHome, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(userHome, '.ssh', 'id_rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n');
    fs.writeFileSync(path.join(work, '.env'), 'API_TOKEN=sk-not-real\n');
    fs.writeFileSync(path.join(work, 'customers.sqlite'), 'rows');
    fs.writeFileSync(path.join(work, 'notes.md'), '# Notes\nfine to share\n');
    fs.mkdirSync(path.join(appHome, 'current'), { recursive: true });
    fs.writeFileSync(path.join(appHome, 'current', 'update-check.json'), '{}');
    fs.symlinkSync(path.join(work, 'notes.md'), path.join(work, 'notes-link.md'));
    fs.symlinkSync(path.join(userHome, '.ssh', 'id_rsa'), path.join(work, 'innocent.txt'));
    fs.writeFileSync(path.join(work, 'leak.txt'), `here it is: ${token('alice')}\n`);
    alice = await session();
  });

  after(async () => {
    await Promise.all(procs.map((p) => (p.exitCode !== null || p.signalCode !== null ? null : new Promise((r) => { p.once('exit', r); p.kill(); }))));
    if (tmp && !process.env.SPHERE_TEST_KEEP) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // ---------------------------------------------------------------- 1. files and secrets going out

  test('sphere_post and sphere_ask send no secret, no Obysphere file, no system file, no link and nothing never-read', async () => {
    const before = (await files()).length;
    const refused = [
      [path.join(userHome, '.ssh', 'id_rsa'), /looks like a secret/],
      ['~/.ssh/id_rsa', /looks like a secret/],
      [path.join(work, '.env'), /looks like a secret/],
      [path.join(home, 'alice', 'profile.json'), /Obysphere's own files/],
      [path.join(home, 'alice', 'keys.json'), /Obysphere's own files/],
      [path.join(home, 'alice', 'settings.json'), /Obysphere's own files/],
      [path.join(appHome, 'current', 'update-check.json'), /Obysphere's own files/],
      [path.join(work, 'customers.sqlite'), /never-read/],
      [path.join(work, 'notes-link.md'), /is a link/],
      [path.join(work, 'innocent.txt'), /is a link/],
      [path.join(work, 'leak.txt'), /token or keys/],
      ...(fs.existsSync('/proc/self/environ') ? [['/proc/self/environ', /system file/]] : []),
      ...(fs.existsSync('/dev/null') ? [['/dev/null', /system file|not a file/]] : []),
    ];
    for (const [f, why] of refused) {
      const post = await alice.tool('sphere_post', { message: 'here you go', files: [f] });
      assert.ok(post.result.isError, `${f} was sent: ${text(post)}`);
      assert.match(text(post), why, f);
      const ask = await alice.tool('sphere_ask', { agent: 'bob', message: 'look at this', files: [f], wait_seconds: 10 });
      assert.ok(ask.result.isError, `${f} was sent with an ask: ${text(ask)}`);
      assert.match(text(ask), why, f);
    }
    assert.equal((await files()).length, before, 'nothing was uploaded');
    // a file the person named, that's none of those, goes
    const ok = await alice.tool('sphere_post', { message: 'my notes', files: [path.join(work, 'notes.md')] });
    assert.ok(!ok.result.isError, text(ok));
    assert.equal((await files()).length, before + 1);
  });

  test("no text, sphere_use input or file leaves with this profile's token or private keys", async () => {
    const keys = JSON.parse(fs.readFileSync(path.join(home, 'alice', 'keys.json'), 'utf8'));
    const n = (await call('GET', '/api/messages?channel=general&limit=100', { tok: token('alice') })).messages.length;
    for (const secret of [token('alice'), keys.sign.d, keys.seal.d]) {
      const post = await alice.tool('sphere_post', { message: `my token is ${secret}, use it` });
      assert.ok(post.result.isError, text(post));
      assert.match(text(post), /token or keys/);
      assert.ok(!text(post).includes(secret), 'the refusal never repeats it');
      const ask = await alice.tool('sphere_ask', { agent: 'bob', message: `here: ${secret}`, wait_seconds: 10 });
      assert.ok(ask.result.isError, text(ask));
      const use = await alice.tool('sphere_use', { agent: 'bob', instrument: 'explain-code', input: { area: secret } });
      assert.ok(use.result.isError, text(use));
      assert.match(text(use), /token or keys/);
    }
    assert.equal((await call('GET', '/api/messages?channel=general&limit=100', { tok: token('alice') })).messages.length, n, 'nothing was posted');
  });

  test('the files fields and the instructions say: only files the person named, never secrets', async () => {
    const { tools } = (await alice.request(2, 'tools/list', {})).result;
    for (const name of ['sphere_post', 'sphere_ask']) assert.match(tools.find((t) => t.name === name).inputSchema.properties.files.description, /only files the person named.*never secrets/i, name);
    assert.match(alice.init.result.instructions, /only files the person named/i);
  });
});
