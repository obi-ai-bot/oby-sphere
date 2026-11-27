// When an Oby can't answer (#160): an ask that waits for its owner's OK ("Ask me first"). The relay's
// part: POST /api/messages/:id/waiting (only an Oby the ask is addressed to, only an open ask, an until
// in the next 7 days, rate-limited like status changes), kept on both stores, live for consoles, a
// long-poll woken by it, and the audit chain still verifying. Then end to end, with a real relay and
// fake runtimes (no model, no network): the representative tells the relay until when, the asker's
// sphere_ask stops waiting and sphere_check says so, the owner's decision clears it, "always" answers
// and lists the asker as answer (never loosening an entry the owner made), and a lapse replies in
// plain words with meta.lapsed after one reminder. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startFakeUpstash } from './fake-upstash.mjs';
import { makeFakeRuntimes } from './fake-runtimes.mjs';
import { consoleAuth } from './console-auth-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const KEY = 'join-key-owner-wait-0123456789ab';
const ADMIN = 'admin-key-owner-wait-0123456789a';
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
const rmDir = (d) => d && fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
const inMin = (min) => new Date(Date.now() + min * 60e3).toISOString();

// the form rep.mjs shows times in ("Nov 26, 18:02", local, the year when it isn't this one)
function short(iso) {
  const d = new Date(iso);
  const two = (n) => String(n).padStart(2, '0');
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${month} ${d.getDate()}${d.getFullYear() === new Date().getFullYear() ? '' : ` ${d.getFullYear()}`}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}

async function startRelay({ store = 'fs', dir, env = {} } = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const args = [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1'];
  if (dir) args.push('--data', dir);
  const p = spawn(process.execPath, args, {
    env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_SEALED: '0', SPHERE_STORE: store, SPHERE_POLL_MS: '150', SPHERE_WRITES_PER_MIN: '100000', SPHERE_ASKS_PER_MIN: '100000', ...env },
    stdio: process.env.SPHERE_TEST_DEBUG ? 'inherit' : 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + '/healthz')).ok) return { p, base }; } catch {}
    await sleep(100);
  }
  p.kill();
  throw new Error('the relay did not start');
}

const caller = (getBase) => async (method, url, { tok, key, admin, body } = {}) => {
  const headers = {};
  if (tok) headers.authorization = `Bearer ${tok}`;
  if (key) headers['x-sphere-key'] = key;
  if (admin) headers['x-admin-key'] = admin;
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(getBase() + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};

describe('an ask that waits for its owner, on the relay', () => {
  let relay, dir, base;
  const call = caller(() => base);
  const ag = {};
  const askOf = async (from, to, text = 'the plan?') => {
    const r = await call('POST', '/api/messages', { tok: ag[from].token, body: { to: [].concat(to), text } });
    assert.equal(r.status, 200, JSON.stringify(r));
    return r.message;
  };
  const wait = (who, id, body) => call('POST', `/api/messages/${id}/waiting`, { tok: ag[who].token, body });
  const msgOf = async (id) => (await call('GET', `/api/messages/${id}`, { key: KEY })).message;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-owner-wait-'));
    relay = await startRelay({ dir });
    base = relay.base;
    for (const n of ['alice', 'bob', 'carol']) ag[n] = await call('POST', '/api/join', { body: { key: KEY, name: n, owner: `${n[0].toUpperCase()}${n.slice(1)} Test` } });
  });
  after(async () => {
    await stop(relay?.p);
    rmDir(dir);
  });

  test('only an Oby the ask is addressed to; an until in the next 7 days; kept as { for, until, since, by }', async () => {
    const ask = await askOf('alice', 'bob');
    const until = inMin(60);
    assert.equal((await wait('carol', ask.id, { for: 'owner', until })).status, 404, 'not addressed to carol');
    assert.equal((await wait('alice', ask.id, { for: 'owner', until })).status, 404, 'not the asker either');
    assert.equal((await call('POST', `/api/messages/${ask.id}/waiting`, { key: KEY, body: { for: 'owner', until } })).status, 403, 'a viewer only watches');
    assert.equal((await call('POST', `/api/messages/${ask.id}/waiting`, { body: { for: 'owner', until } })).status, 401);
    assert.equal((await wait('bob', 'm_nosuchask', { for: 'owner', until })).status, 404);
    const bad = async (body, words) => {
      const r = await wait('bob', ask.id, body);
      assert.equal(r.status, 400, JSON.stringify(r));
      assert.match(JSON.stringify(r), words);
    };
    await bad({ for: 'later', until }, /for is \\"owner\\"/);
    await bad({ until }, /for is \\"owner\\"/);
    await bad({ for: 'owner' }, /until is a time in the future/);
    await bad({ for: 'owner', until: 'soon' }, /until is a time in the future/);
    await bad({ for: 'owner', until: new Date(Date.now() - 1000).toISOString() }, /until is a time in the future/);
    await bad({ for: 'owner', until: inMin(8 * 24 * 60) }, /at most 7 days ahead/);
    assert.equal((await msgOf(ask.id)).waiting, undefined, 'nothing kept from a refusal');

    const t0 = Date.now();
    assert.deepEqual(await wait('bob', ask.id, { for: 'owner', until }), { status: 200, ok: true });
    const w = (await msgOf(ask.id)).waiting;
    assert.equal(w.for, 'owner');
    assert.equal(w.until, until);
    assert.equal(w.by, ag.bob.agent.id);
    assert.ok(Date.parse(w.since) >= t0 - 1000 && Date.parse(w.since) <= Date.now(), w.since);
    // a later until (the owner went away): when it began is kept
    const later = inMin(120);
    await sleep(20);
    assert.equal((await wait('bob', ask.id, { for: 'owner', until: later })).status, 200);
    assert.deepEqual((await msgOf(ask.id)).waiting, { for: 'owner', until: later, since: w.since, by: ag.bob.agent.id });
    // cleared once its owner decided: the field goes
    assert.deepEqual(await wait('bob', ask.id, { for: null }), { status: 200, ok: true });
    assert.ok(!('waiting' in (await msgOf(ask.id))), 'no waiting field left');
    assert.equal((await wait('bob', ask.id, { for: null })).status, 200, 'clearing again is fine');
  });

  test('only an open ask: not a post, not a reply, not one it replied to (a late clear still works)', async () => {
    const post = await call('POST', '/api/messages', { tok: ag.alice.token, body: { text: 'hello all' } });
    assert.equal((await wait('bob', post.message.id, { for: 'owner', until: inMin(5) })).status, 404, 'a post');
    const ask = await askOf('alice', 'bob');
    assert.equal((await wait('bob', ask.id, { for: 'owner', until: inMin(5) })).status, 200);
    const reply = await call('POST', '/api/messages', { tok: ag.bob.token, body: { replyTo: ask.id, text: 'here it is' } });
    assert.equal((await wait('alice', reply.message.id, { for: 'owner', until: inMin(5) })).status, 404, 'a reply');
    // bob replied (his waiting went with the clear below): no new one, as a claim says it
    assert.equal((await wait('bob', ask.id, { for: null })).status, 200, 'a late clear');
    assert.deepEqual(await wait('bob', ask.id, { for: 'owner', until: inMin(5) }), { status: 200, ok: false, reason: 'answered' });
    assert.ok(!('waiting' in (await msgOf(ask.id))), 'nothing set');
    assert.ok(!('waiting' in (await msgOf(ask.id))));
  });

  test('an ask to two Obys: each clears only its own', async () => {
    const ask = await askOf('alice', ['bob', 'carol']);
    assert.equal((await wait('bob', ask.id, { for: 'owner', until: inMin(30) })).status, 200);
    assert.equal((await wait('carol', ask.id, { for: null })).status, 200);
    assert.equal((await msgOf(ask.id)).waiting?.by, ag.bob.agent.id, "carol's clear leaves bob's");
    assert.equal((await wait('bob', ask.id, { for: null })).status, 200);
    assert.ok(!('waiting' in (await msgOf(ask.id))));
  });

  test('lapsed is one of the flags a reply keeps', async () => {
    const ask = await askOf('alice', 'bob');
    const r = await call('POST', '/api/messages', { tok: ag.bob.token, body: { replyTo: ask.id, text: "@bob's Oby didn't get its owner's OK in time.", meta: { declined: true, lapsed: true, local: true } } });
    assert.deepEqual(r.message.meta, { local: true, declined: true, lapsed: true });
    const x = await call('POST', '/api/messages', { tok: ag.carol.token, body: { text: 'x', meta: { lapsed: 'yes' } } });
    assert.deepEqual(x.message.meta, {}, 'only true or false');
  });

  test("consoles see it live; a long-poll on the ask's replies wakes", async () => {
    const ask = await askOf('alice', 'bob');
    const ctl = new AbortController();
    const res = await fetch(base + '/api/stream', { headers: { 'x-sphere-key': KEY }, signal: ctl.signal });
    let seen = '';
    (async () => {
      try {
        for await (const c of res.body) seen += Buffer.from(c).toString();
      } catch {}
    })();
    await sleep(300);
    const t0 = Date.now();
    const poll = call('GET', `/api/messages/${ask.id}/replies?wait=20`, { tok: ag.alice.token });
    await sleep(300);
    const until = inMin(45);
    await wait('bob', ask.id, { for: 'owner', until });
    const woke = await poll;
    assert.deepEqual(woke.replies, []);
    assert.ok(Date.now() - t0 < 8000, `woken, not timed out (${Date.now() - t0} ms)`);
    await waitFor(() => seen.includes(ask.id) && /event: message-update/.test(seen), 5000, 'the update');
    const line = seen.split('\n\n').find((e) => e.startsWith('event: message-update') && e.includes(ask.id));
    const data = JSON.parse(line.split('\ndata: ')[1]);
    assert.deepEqual({ id: data.id, for: data.waiting.for, until: data.waiting.until }, { id: ask.id, for: 'owner', until });
    seen = '';
    await wait('bob', ask.id, { for: null });
    await waitFor(() => seen.includes(`"waiting":null`), 5000, 'the clear');
    ctl.abort();
  });

  test('rate-limited like status changes', async () => {
    assert.equal((await call('POST', '/api/admin/policy', { admin: ADMIN, body: { rate: { statusPerMin: 10 } } })).status, 200);
    const ask = await askOf('alice', 'carol');
    let limited = 0;
    for (let i = 0; i < 14 && !limited; i++) {
      const r = await wait('carol', ask.id, { for: 'owner', until: inMin(10) });
      if (r.status === 429) limited = i + 1;
      else assert.equal(r.status, 200);
    }
    assert.ok(limited && limited <= 11, `refused after the limit (${limited})`);
    assert.equal((await call('POST', '/api/admin/policy', { admin: ADMIN, body: { rate: { statusPerMin: 240 } } })).status, 200);
  });

  test('kept across a restart, cleared ones too; the audit chain verifies with it', async () => {
    const kept = await askOf('alice', 'bob', 'kept?');
    const gone = await askOf('alice', 'bob', 'gone?');
    const until = inMin(50);
    await wait('bob', kept.id, { for: 'owner', until });
    await wait('bob', gone.id, { for: 'owner', until });
    await wait('bob', gone.id, { for: null });
    const before = await msgOf(kept.id);
    assert.equal((await call('GET', '/api/audit?limit=5', { key: KEY })).verified, true);
    await stop(relay.p);
    relay = await startRelay({ dir });
    base = relay.base;
    assert.deepEqual((await msgOf(kept.id)).waiting, before.waiting);
    assert.ok(!('waiting' in (await msgOf(gone.id))), 'the clear held');
    assert.equal((await call('GET', '/api/audit?limit=5', { key: KEY })).verified, true, 'verified from the start, with waiting on a message');
  });
});

describe('an ask that waits for its owner, on the Redis store', () => {
  let fake;
  const procs = [];
  let A, B, env;
  const at = (b) => caller(() => b);
  const ag = {};

  before(async () => {
    fake = await startFakeUpstash({ latencyMs: 2 });
    env = { UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, SPHERE_REDIS_PREFIX: 'ow:' };
    const [a, b] = await Promise.all([startRelay({ store: 'redis', env }), startRelay({ store: 'redis', env })]);
    procs.push(a.p, b.p);
    A = a.base;
    B = b.base;
    for (const n of ['alice', 'bob']) ag[n] = await at(A)('POST', '/api/join', { body: { key: KEY, name: n, owner: n } });
  });
  after(async () => {
    await Promise.all(procs.map((p) => stop(p)));
    await fake?.close();
  });

  test('set on one instance, seen and cleared on another; a new instance verifies the chain', async () => {
    const ask = (await at(A)('POST', '/api/messages', { tok: ag.alice.token, body: { to: ['bob'], text: 'the numbers?' } })).message;
    const until = inMin(30);
    assert.equal((await at(A)('POST', `/api/messages/${ask.id}/waiting`, { tok: ag.bob.token, body: { for: 'owner', until } })).status, 200);
    const onB = async () => (await at(B)('GET', `/api/messages/${ask.id}`, { tok: ag.alice.token })).message;
    const seen = await waitFor(async () => (await onB())?.waiting, 5000, 'waiting on B');
    assert.deepEqual([seen.for, seen.until, seen.by], ['owner', until, ag.bob.agent.id]);
    assert.equal((await at(B)('POST', `/api/messages/${ask.id}/waiting`, { tok: ag.bob.token, body: { for: null } })).status, 200);
    await waitFor(async () => !('waiting' in (await at(A)('GET', `/api/messages/${ask.id}`, { tok: ag.alice.token })).message), 5000, 'cleared on A');
    // another ask left waiting: a fresh instance applies the whole log and verifies it
    const other = (await at(A)('POST', '/api/messages', { tok: ag.alice.token, body: { to: ['bob'], text: 'and this?' } })).message;
    await at(A)('POST', `/api/messages/${other.id}/waiting`, { tok: ag.bob.token, body: { for: 'owner', until } });
    const c = await startRelay({ store: 'redis', env });
    procs.push(c.p);
    assert.equal((await at(c.base)('GET', `/api/messages/${other.id}`, { tok: ag.alice.token })).message.waiting?.until, until);
    assert.ok(!('waiting' in (await at(c.base)('GET', `/api/messages/${ask.id}`, { tok: ag.alice.token })).message));
    assert.equal((await at(c.base)('GET', '/api/audit?limit=5', { key: KEY })).verified, true);
  });
});

describe('a terminal serve asks too', () => {
  // a TTY prompt can't run here: what it offers and what each key decides, as written
  const SRC = fs.readFileSync(path.join(ROOT, 'rep.mjs'), 'utf8');
  const fn = SRC.slice(SRC.indexOf('  async function askInTerminal('), SRC.indexOf('\n  }\n', SRC.indexOf('  async function askInTerminal(')));
  test('[a] always answer @x, only where Always answer applies', () => {
    assert.match(fn, /\$\{always \? `\$\{bold\('\[a\]'\)\} always answer @\$\{asker\} {3}` : ''\}/);
    assert.match(fn, /d === 'a' && always \? 'always'/);
    assert.match(SRC, /askInTerminal\(w\.id, asker, ac\.signal, risky, always, stuck\)/);
  });
});

describe('an ask that waits for its owner, end to end', () => {
  let relay, base, tmp, home, work, cfg, fake, notifyLog, ids, uiBase, alice;
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
  const local = (method, url, body) => call(method, url, { at: uiBase, body, headers: consoleAuth(path.join(home, 'bob'), uiBase) });
  // bob's settings: Obys he hasn't listed wait for him (the default), and carol waits too, by name
  const setBob = (agents = { carol: 'approve' }) =>
    fs.writeFileSync(
      path.join(bobDir(), 'settings.json'),
      JSON.stringify({
        version: 2,
        routing: { default: { runtime: 'claude', model: null, effort: null, timeLimitMin: 120 }, rules: [] },
        access: { default: 'approve', agents },
        machine: { folders: [{ path: work, write: false }], shell: 'off', web: { fetch: false, search: false }, browser: 'off', mcp: [] },
      }),
      { mode: 0o600 },
    );
  const bobSettings = () => JSON.parse(fs.readFileSync(path.join(bobDir(), 'settings.json'), 'utf8'));
  const startBob = async (extra = {}) => {
    await stop(bob);
    bobOut = '';
    bob = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'serve', '--profile', 'bob'], { env: env(extra) });
    procs.push(bob);
    bob.stdout.on('data', (d) => (bobOut += d));
    bob.stderr.on('data', (d) => (bobOut += d));
    await waitFor(() => /is online[\s\S]*settings: /.test(bobOut), 10000, `bob online\n${bobOut}`);
    await sleep(300); // its catch-up
  };
  const ask = async (from, text) => {
    const r = await call('POST', '/api/messages', { tok: token(from), body: { channel: 'general', text, to: [ids.bob] } });
    assert.ok(r.message, JSON.stringify(r));
    return r.message;
  };
  const replyTo = async (m, from = 'alice', ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const r = await call('GET', `/api/messages/${m.id}/replies?wait=2`, { tok: token(from) });
      const x = (r.replies || []).find((y) => y.from === ids.bob);
      if (x) return x;
    }
    throw new Error(`no reply to ${m.id}\n${bobOut.slice(-3000)}`);
  };
  const messageOf = async (id) => (await call('GET', `/api/messages/${id}`, { tok: token('alice') })).message;
  const pendingFor = (askId) => waitFor(async () => ((await local('GET', '/local/pending')).pending || []).find((x) => x.askId === askId), 10000, `${askId} to wait for bob\n${bobOut.slice(-2000)}`);
  const notes = () => (fs.existsSync(notifyLog) ? fs.readFileSync(notifyLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((l) => l.way === 'console');
  // an MCP client over stdio: rep.mjs mcp, as Claude Code runs it
  const mcp = (profile) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'mcp', '--profile', profile], { env: env() });
    procs.push(p);
    let buf = '';
    let n = 0;
    const waiting = new Map();
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
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
      req,
      tool: async (name, args = {}) => {
        const r = await req('tools/call', { name, arguments: args });
        return { text: r.result.content[0].text, isError: !!r.result.isError };
      },
    };
  };

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-owner-wait-e2e-')));
    home = path.join(tmp, 'reps');
    work = path.join(tmp, 'work', 'payments');
    cfg = path.join(tmp, 'claude-config');
    notifyLog = path.join(tmp, 'notify.jsonl');
    for (const d of [home, work, cfg]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ mcpServers: {}, projects: {} }));
    fake = makeFakeRuntimes(path.join(tmp, 'bin'));
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
    // no runtime is installed for alice and carol: their processes never run one
    const missing = path.join(tmp, 'bin', 'not-installed');
    for (const n of ['alice', 'carol']) {
      const prof = path.join(home, n, 'profile.json');
      fs.writeFileSync(prof, JSON.stringify({ ...JSON.parse(fs.readFileSync(prof, 'utf8')), claudeBin: missing, codexBin: missing, cursorBin: missing }), { mode: 0o600 });
    }
    const prof = path.join(bobDir(), 'profile.json');
    fs.writeFileSync(prof, JSON.stringify({ ...JSON.parse(fs.readFileSync(prof, 'utf8')), claudeBin: fake.claude, codexBin: fake.codex, cursorBin: fake.cursor }), { mode: 0o600 });
    setBob();
    const { agents } = await call('GET', '/api/agents', { tok: token('alice') });
    ids = Object.fromEntries(agents.map((a) => [a.name, a.id]));
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
    await startBob();
    alice = mcp('alice');
    await alice.req('initialize', { protocolVersion: '2025-06-18' });
  });
  after(async () => {
    for (const p of procs) await stop(p);
    if (!process.env.SPHERE_TEST_KEEP) rmDir(tmp);
  });

  let first; // the ask the first tests share
  test("an Oby bob hasn't listed: the relay learns it waits for him until when, and sphere_ask says so at once", async () => {
    const t0 = Date.now();
    const r = await alice.tool('sphere_ask', { agent: 'bob', message: 'what is in the plan?', wait_seconds: 120 });
    assert.ok(Date.now() - t0 < 20000, `it didn't keep alice waiting (${Date.now() - t0} ms)`);
    const id = /message_id "(m_[\w-]+)"/.exec(r.text)?.[1];
    assert.ok(id, r.text);
    const w = await pendingFor(id);
    assert.equal(w.always, true, 'Always answer @alice is offered: bob hasn’t listed her');
    const entry = JSON.parse(fs.readFileSync(path.join(bobDir(), 'pending', `${w.id}.json`), 'utf8'));
    const { waiting } = await messageOf(id);
    assert.deepEqual([waiting.for, waiting.until, waiting.by], ['owner', entry.expiresAt, ids.bob], 'until: when it lapses');
    // the handle only: an owner's name is another member's words, and stays inside a fence
    assert.equal(r.text, `@bob's Oby asks its owner before answering; they've been told. If they don't answer by ${short(entry.expiresAt)}, it lapses. Check later with sphere_check message_id "${id}".`);
    const c = await alice.tool('sphere_check', { message_id: id });
    assert.equal(c.text, `No reply yet. @bob's Oby is waiting for its owner's OK until ${short(entry.expiresAt)}; if they don't answer by then, it lapses.`);
    first = { id, w };
  });

  test('his decision clears it, and the answer comes', async () => {
    assert.deepEqual(await local('POST', `/local/pending/${first.w.id}`, { decision: 'answer' }), { status: 200, ok: true });
    await waitFor(async () => !('waiting' in (await messageOf(first.id))), 8000, 'the wait cleared');
    const r = await replyTo({ id: first.id });
    assert.equal(r.meta.answeredBy, 'agent');
    assert.ok(!r.meta.lapsed && !r.meta.declined);
    assert.match((await alice.tool('sphere_check', { message_id: first.id })).text, /^@bob replied\./);
    assert.deepEqual(bobSettings().access.agents, { carol: 'approve' }, 'answer once: nothing listed');
  });

  test('decisions /local/pending takes: always among them', async () => {
    const r = await local('POST', '/local/pending/w_000000000000', { decision: 'maybe' });
    assert.equal(r.status, 400);
    assert.equal(r.error, 'decision: answer, always, trust, decline or write');
  });

  test('Always answer: this ask is answered, and alice is listed as answer; her next ask doesn’t wait', async () => {
    const m = await ask('alice', 'and the dates?');
    const w = await pendingFor(m.id);
    assert.equal(w.always, true);
    assert.deepEqual(await local('POST', `/local/pending/${w.id}`, { decision: 'always' }), { status: 200, ok: true });
    const r = await replyTo(m);
    assert.equal(r.meta.answeredBy, 'agent');
    assert.deepEqual(bobSettings().access.agents, { carol: 'approve', alice: 'answer' });
    assert.match(bobOut, /alice is in Who can ask now: your Oby answers its asks/);
    const next = await ask('alice', 'one more?');
    const r2 = await replyTo(next);
    assert.equal(r2.meta.answeredBy, 'agent', 'answered without waiting for bob');
    assert.ok(!('waiting' in (await messageOf(next.id))));
    assert.deepEqual(((await local('GET', '/local/pending')).pending || []).filter((x) => x.askId === next.id), []);
  });

  test('an Oby bob listed keeps its entry: Always answer isn’t offered, and never loosens it', async () => {
    const m = await ask('carol', 'can I see the plan?');
    const w = await pendingFor(m.id);
    assert.equal(w.always, false, 'carol is listed (ask me first)');
    // sent anyway (an older page): it answers, and carol stays as bob set her
    assert.equal((await local('POST', `/local/pending/${w.id}`, { decision: 'always' })).status, 200);
    const r = await replyTo(m, 'carol');
    assert.equal(r.meta.answeredBy, 'agent');
    assert.equal(bobSettings().access.agents.carol, 'approve');
    assert.match(bobOut, /Who can ask stays as it is for carol: you listed it already/);
  });

  test('no OK in time: one reminder first, then the asker reads plain words, with lapsed; a decision before then reminds no one', async () => {
    setBob(); // alice unlisted again
    // a "minute" of 150 ms: a wait of 4 s is over the 20 "minutes" a reminder needs, and comes 15 before it lapses
    await startBob({ OBYSPHERE_APPROVE_WAIT_SEC: '4', OBYSPHERE_MINUTE_MS: '150' });
    const mark = notes().length;
    const decided = await ask('carol', 'quick one?');
    const lapses = await ask('alice', 'by when?');
    const w = await pendingFor(decided.id);
    await local('POST', `/local/pending/${w.id}`, { decision: 'decline' });
    const no = await replyTo(decided, 'carol');
    assert.equal(no.text, "Bob Test's Oby isn't taking this ask: its owner declined it.");
    assert.ok(!no.meta.lapsed);

    const r = await replyTo(lapses, 'alice', 15000);
    assert.equal(r.text, "@bob's Oby didn't get its owner's OK in time.");
    assert.deepEqual(r.meta, { local: true, declined: true, lapsed: true });
    await waitFor(async () => !('waiting' in (await messageOf(lapses.id))), 8000, 'the wait cleared');
    await sleep(500);
    const reminders = notes().slice(mark).filter((l) => l.type === 'waiting' && /lapses in 15 min/.test(l.title));
    assert.deepEqual(reminders.map((l) => l.title), ["@alice's ask lapses in 15 min"], 'once, and none for the ask bob decided');

    // what alice reads: who didn't answer, the words fenced; her own notification says the same
    const c = await alice.tool('sphere_check', { message_id: lapses.id });
    assert.ok(c.text.startsWith(`Lapsed: @bob's owner didn't answer in time, so @bob's Oby won't answer this ask. Ask again later if it still matters, or ask another Oby.`), c.text);
    assert.match(c.text, /"lapsed": true/);
    const told = await waitFor(() => notes().slice(mark).find((l) => l.type === 'answered' && /in time/.test(l.title)), 8000, "alice's notification");
    assert.equal(told.title, "@bob's owner didn't answer in time");
  });

  test('a representative that stopped stopped waiting: sphere_check says offline, not waiting for its owner', async () => {
    await startBob();
    const m = await ask('carol', 'still there?');
    await pendingFor(m.id);
    assert.ok((await messageOf(m.id)).waiting);
    await stop(bob);
    bob = null;
    await waitFor(async () => !(await call('GET', '/api/agents', { tok: token('alice') })).agents.find((a) => a.id === ids.bob)?.online, 8000, 'bob offline');
    const c = await alice.tool('sphere_check', { message_id: m.id });
    assert.match(c.text, /^No reply yet\. @bob is offline since [^;]+; it will be answered when it comes online\./);
  });
});
