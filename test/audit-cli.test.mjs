// `obysphere admin audit export` and `admin audit verify` (#141): the audit log saved as JSON Lines,
// and checked on this machine with the admin key. Real relays on both stores (fs, and Redis through
// test/fake-upstash.mjs), with 2,500+ events so the export takes three pages: the export is the
// relay's pages, and verify passes online and on the file, which also keeps rep.mjs's copies of the
// chain's hash and of the content hash (an ask the relay patched among them) in step with
// server.mjs's. On the fs store, each tampering the issue lists is done on disk and the relay
// started again with the same key, and verify fails at the right seq: an edited detail, a dropped
// line, two lines swapped, the log re-chained under another key, a message changed.
// A wrong key fails at #1, a relay serving a forged log with verified: true fails, and a data
// folder's audit.jsonl checks with no profile. The key never reaches argv, a request (a recording
// proxy sees every one), the output or a file. Step 2: a cut or a rewrite after an export is caught
// with --since and with the head the profile kept, and a log that only grew passes. The rule for
// deleted messages (#139), against logs built here with the HMAC, a message deleted while a check
// runs among them. And the console: Export all saves the whole log as JSON Lines, which the CLI
// checks, and the Audit log page says how. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { startFakeUpstash } from './fake-upstash.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'join-key-audit-cli-tests-0123456789';
const ADMIN = 'admin-key-audit-cli-tests-0123456789';
const OTHER = 'another-admin-key-audit-cli-tests-0123';
const ZERO = '0'.repeat(64);
const POSTS = 2500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a free port on 127.0.0.1, never the demo's (4848 to 4850)
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p >= 4848 && p <= 4850 ? freePort() : p));
    });
  });
const roots = [];
const tmp = (name) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `obysphere-audit-${name}-`)));
  roots.push(d);
  return d;
};
after(() => {
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});

// the chain, as API.md gives it: this test's own copy, for logs built by hand
const chainKey = (adminKey) => createHmac('sha256', adminKey).update('obysphere/audit/v1').digest();
const hashOf = (e, k) => createHmac('sha256', k).update(e.prev + JSON.stringify([e.seq, e.ts, e.type, e.actor, e.target, e.ref, e.detail, e.content ?? null])).digest('hex');
const contentHash = (m) => {
  const { claimedAt, startedAt, waiting, ...posted } = m;
  return createHash('sha256').update(JSON.stringify(posted)).digest('hex');
};
function chain(events, adminKey) {
  const k = chainKey(adminKey);
  let prev = ZERO;
  return events.map((e, i) => {
    const x = { ...e, seq: i + 1, prev };
    delete x.hash;
    x.hash = hashOf(x, k);
    prev = x.hash;
    return x;
  });
}
const lines = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function startRelay({ data, env = {}, port }) {
  port ??= await freePort();
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--writes-per-min', '100000', '--asks-per-min', '100000', ...(data ? ['--data', data] : [])], {
    env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_SEALED: '0', SPHERE_STORE: 'fs', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + '/healthz')).ok) return { proc: p, base, port };
    } catch {}
    if (p.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error(`the relay did not start: ${err}`);
}
const stop = (proc) =>
  new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) return resolve();
    proc.once('exit', resolve);
    proc.kill();
  });

async function call(base, method, url, { token, body, admin } = {}) {
  const h = {};
  if (token) h.authorization = `Bearer ${token}`;
  if (admin) h['x-admin-key'] = admin;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}

// every event, as GET /api/audit pages it
async function relayPages(base, token) {
  const all = [];
  let after = 0;
  for (;;) {
    const r = await call(base, 'GET', `/api/audit?after=${after}&limit=1000`, { token });
    if (!r.events.length) return { events: all, head: r.head };
    all.push(...r.events);
    after = r.events.at(-1).seq;
    if (after >= r.head.seq) return { events: all, head: r.head };
  }
}

// A machine: profiles in their own folder, HOME, TMPDIR and the app home too, nothing shown on
// this desktop, no update check, and none of the tester's own keys or profile.
function machine(name) {
  const t = tmp(name);
  const m = { home: path.join(t, 'reps'), user: path.join(t, 'home'), app: path.join(t, 'app'), tmpdir: path.join(t, 'tmp'), work: path.join(t, 'work'), files: path.join(t, 'files') };
  for (const d of Object.values(m)) fs.mkdirSync(d, { recursive: true });
  m.env = (extra = {}) => {
    const e = { ...process.env, OBYSPHERE_HOME: m.home, HOME: m.user, TMPDIR: m.tmpdir, OBYSPHERE_APP_HOME: m.app, OBYSPHERE_NOTIFY_LOG: path.join(t, 'notify.jsonl'), OBYSPHERE_NO_UPDATE_CHECK: '1', ...extra };
    for (const k of Object.keys(e)) if (/^SPHERE_/.test(k) || (/^OBYSPHERE_(ADMIN_KEY|PROFILE|CLI)$/.test(k) && !(k in extra))) delete e[k];
    return e;
  };
  // rep.mjs to the end, with no terminal (nothing can be asked), in the files folder
  m.rep = (args, extra) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), ...args], { env: m.env(extra), cwd: m.files, stdio: ['pipe', 'pipe', 'pipe'] });
      p.stdin.end();
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.stderr.on('data', (d) => (stderr += d));
      const t = setTimeout(() => p.kill(), 60000);
      p.on('close', (code) => {
        clearTimeout(t);
        resolve({ code, stdout, stderr, out: stdout + stderr });
      });
    });
  m.token = (n) => JSON.parse(fs.readFileSync(path.join(m.home, n, 'profile.json'), 'utf8')).token;
  m.join = async (base, n) => {
    const r = await m.rep(['join', `${base}/#key=${KEY}`, '--name', n, '--owner', `${n[0].toUpperCase()}${n.slice(1)} Test`, '--cwd', m.work]);
    assert.match(r.out, /joined/, r.out);
  };
  // a profile by hand, for a relay that's a fake
  m.fakeProfile = (n, base) => {
    fs.mkdirSync(path.join(m.home, n), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(m.home, n, 'profile.json'), JSON.stringify({ sphere: base, sphereName: 'Fake Sphere', token: 'tok_fake0123456789', agent: { id: 'a_fake01', name: n, owner: 'Fake' }, cwd: m.work, runtime: 'claude' }), { mode: 0o600 });
  };
  return m;
}

// A busy Sphere: alice (an admin), bob, carol and dave; an ask and its reply; POSTS posts in
// #general; then a private channel of bob's and carol's, with a few posts dave can't see.
async function busy(base, m) {
  for (const n of ['alice', 'bob', 'carol', 'dave']) await m.join(base, n);
  const r = await m.rep(['admin', 'claim', '--profile', 'alice'], { OBYSPHERE_ADMIN_KEY: ADMIN });
  assert.equal(r.code, 0, r.out);
  const [bob, carol] = [m.token('bob'), m.token('carol')];
  const ask = await call(base, 'POST', '/api/messages', { token: bob, body: { channel: 'general', to: ['carol'], text: 'What changed this week?' } });
  assert.equal(ask.status, 200, JSON.stringify(ask));
  // carol's Oby takes the ask, works on it and holds it for her OK: the relay patches it (claimedAt,
  // startedAt, waiting), which its event's content leaves out. A real relay's patched message checking
  // keeps rep.mjs's copy of contentHash() in step with server.mjs's.
  const id = ask.message.id;
  assert.equal((await call(base, 'POST', `/api/messages/${id}/claim`, { token: carol, body: { instance: 'audit-cli-test' } })).ok, true);
  assert.equal((await call(base, 'POST', '/api/status', { token: carol, body: { state: 'working', about: id, note: 'looking' } })).status, 200);
  assert.equal((await call(base, 'POST', `/api/messages/${id}/waiting`, { token: carol, body: { for: 'owner', until: new Date(Date.now() + 3600e3).toISOString() } })).ok, true);
  const { message: patched } = await call(base, 'GET', `/api/messages/${id}`, { token: bob });
  for (const k of ['claimedAt', 'startedAt', 'waiting']) assert.ok(patched[k], `the ask carries ${k}: ${JSON.stringify(patched)}`);
  const reply = await call(base, 'POST', '/api/messages', { token: carol, body: { channel: 'general', replyTo: ask.message.id, text: 'The release notes.' } });
  assert.equal(reply.status, 200, JSON.stringify(reply));
  for (let i = 0; i < POSTS; i += 50) {
    const batch = [];
    for (let j = i; j < Math.min(POSTS, i + 50); j++) batch.push(call(base, 'POST', '/api/messages', { token: j % 2 ? bob : carol, body: { channel: 'general', text: `Post ${j + 1}` } }));
    for (const r of await Promise.all(batch)) assert.equal(r.status, 200, JSON.stringify(r));
  }
  assert.equal((await call(base, 'POST', '/api/channels', { token: bob, body: { name: 'secret', private: true, members: ['carol'] } })).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await call(base, 'POST', '/api/messages', { token: carol, body: { channel: 'secret', text: `Just us ${i}` } })).status, 200);
}

const verifyJson = async (m, args, extra = { OBYSPHERE_ADMIN_KEY: ADMIN }) => {
  const r = await m.rep(['admin', 'audit', 'verify', ...args, '--json'], extra);
  let j = null;
  try {
    j = JSON.parse(r.stdout);
  } catch {}
  return { ...r, j };
};
const mode = (f) => fs.statSync(f).mode & 0o777;

describe('audit export and verify on the fs store', () => {
  let relay, data, m, exported;
  const AUDIT = () => path.join(data, 'audit.jsonl');
  const MSGS = () => path.join(data, 'messages.jsonl');
  // the data folder changed while the relay is stopped, checked (the relay started again on the
  // same address, with the same key), then put back as it was
  const tampered = async (change, check) => {
    await stop(relay.proc);
    const was = { audit: fs.readFileSync(AUDIT(), 'utf8'), msgs: fs.readFileSync(MSGS(), 'utf8') };
    change();
    relay = await startRelay({ data, port: relay.port });
    try {
      await check();
    } finally {
      await stop(relay.proc);
      fs.writeFileSync(AUDIT(), was.audit);
      fs.writeFileSync(MSGS(), was.msgs);
      relay = await startRelay({ data, port: relay.port });
    }
  };
  const editLine = (file, seq, fn) => {
    const ls = fs.readFileSync(file, 'utf8').split('\n');
    ls[seq - 1] = JSON.stringify(fn(JSON.parse(ls[seq - 1])));
    fs.writeFileSync(file, ls.join('\n'));
  };

  before(async () => {
    m = machine('fs');
    data = path.join(path.dirname(m.home), 'relay');
    relay = await startRelay({ data });
    await busy(relay.base, m);
  });
  after(async () => {
    if (relay) await stop(relay.proc);
  });

  test('export saves every event as JSON Lines, exactly the pages the relay gives, owner-only', async () => {
    const r = await m.rep(['admin', 'audit', 'export', '--profile', 'bob', '--out', 'all.jsonl']);
    assert.equal(r.code, 0, r.out);
    exported = path.join(m.files, 'all.jsonl');
    const pages = await relayPages(relay.base, m.token('bob'));
    assert.ok(pages.events.length > 2500, `${pages.events.length} events: three pages`);
    assert.deepEqual(readLines(exported), pages.events);
    assert.equal(fs.readFileSync(exported, 'utf8'), lines(pages.events), 'each line as the relay sent it');
    assert.equal(mode(exported), 0o600);
    const n = pages.events.length.toLocaleString('en-US');
    assert.match(r.stderr, new RegExp(`${n} events, #1 to #${n}`));
    assert.match(r.stderr, new RegExp(`head: #${n} · ${pages.head.hash.slice(0, 12)}`));
    assert.match(r.stderr, /admin audit verify all\.jsonl/);
    assert.equal(r.stdout, '', 'stdout stays empty');
    // an existing file is kept unless --force
    const again = await m.rep(['admin', 'audit', 'export', '--profile', 'bob', '--out', 'all.jsonl']);
    assert.equal(again.code, 1);
    assert.match(again.out, /is there already: add --force/);
    assert.equal((await m.rep(['admin', 'audit', 'export', '--profile', 'bob', '--out', 'all.jsonl', '--force'])).code, 0);
    assert.deepEqual(readLines(exported), pages.events);
    assert.equal(mode(exported), 0o600);
    // to the terminal, and from a seq on
    const out = await m.rep(['admin', 'audit', 'export', '--profile', 'bob', '--out', '-']);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout, lines(pages.events));
    const tail = await m.rep(['admin', 'audit', 'export', '--profile', 'bob', '--out', 'tail.jsonl', '--after', '2000']);
    assert.equal(tail.code, 0, tail.out);
    assert.deepEqual(readLines(path.join(m.files, 'tail.jsonl')), pages.events.filter((e) => e.seq > 2000));
    assert.match(tail.stderr, /\(after #2,000\)/);
    // the default name: the Sphere's, and today's date
    const named = await m.rep(['admin', 'audit', 'export', '--profile', 'bob']);
    assert.equal(named.code, 0, named.out);
    assert.ok(fs.readdirSync(m.files).some((f) => /^obysphere-audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)), fs.readdirSync(m.files).join(', '));
    for (const bad of [['--after', 'x'], ['--after', '-1'], ['--out']]) assert.equal((await m.rep(['admin', 'audit', 'export', '--profile', 'bob', ...bad])).code, 1, bad.join(' '));
  });

  test('export to a pipe stops quietly when what reads it stops (| head)', async () => {
    const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'admin', 'audit', 'export', '--profile', 'bob', '--out', '-'], { env: m.env(), cwd: m.files, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    const closed = new Promise((resolve) => p.on('close', resolve));
    const first = await new Promise((resolve) => p.stdout.once('data', resolve));
    p.stdout.destroy(); // the first chunk read, and no more: the rest of the 2,500+ events has nowhere to go
    assert.match(String(first), /^\{"seq":1,/);
    assert.equal(await closed, 0, err);
    assert.doesNotMatch(err, /EPIPE|Unhandled|\n\s+at /, 'no stack trace');
  });

  test("rep.mjs's copy of the chain matches server.mjs's: a real relay's log checks, online and from the file", async () => {
    const online = await m.rep(['admin', 'audit', 'verify', '--profile', 'alice'], { OBYSPHERE_ADMIN_KEY: ADMIN });
    assert.equal(online.code, 0, online.out);
    assert.match(online.stdout, /The audit log checks with this key: 2,5\d\d events, #1 to #2,5\d\d\./);
    assert.match(online.stdout, /the relay's head too/);
    assert.match(online.stdout, /Messages: 2,50\d match what was recorded when they were posted; 0 not held any more\./);
    assert.match(online.stdout, /Kept #2,5\d\d in .*audit-heads\.json/);
    const file = await m.rep(['admin', 'audit', 'verify', exported], { OBYSPHERE_ADMIN_KEY: ADMIN });
    assert.equal(file.code, 0, file.out);
    assert.match(file.stdout, /The file checks with this key: 2,5\d\d events, #1 to #2,5\d\d\./);
    assert.match(file.stdout, /A file alone can't show that newer events weren't cut off/);
    const j = (await verifyJson(m, ['--profile', 'alice'])).j;
    assert.equal(j.verified, true);
    assert.equal(j.source, 'relay');
    assert.equal(j.from, 1);
    assert.equal(j.to, j.events);
    assert.deepEqual(j.relay.head, j.head);
    assert.equal(j.relay.verified, true);
    assert.equal(j.messages.checked, POSTS + 5, 'the ask, the reply, the posts, and the private ones (an admin sees every channel)');
    assert.equal(j.messages.hidden, 0);
    assert.equal(j.keptHead.held, true, 'the head kept by the check before');
    assert.equal(j.failure, null);
  });

  test("a member who isn't an admin downloads and checks the log too; messages it can't see are counted", async () => {
    const j = (await verifyJson(m, ['--profile', 'dave'])).j;
    assert.equal(j.verified, true, JSON.stringify(j));
    assert.equal(j.messages.everyChannel, false);
    assert.equal(j.messages.hidden, 3, "the private channel's three posts");
    assert.equal(j.messages.checked, POSTS + 2);
    const r = await m.rep(['admin', 'audit', 'verify', '--profile', 'dave'], { OBYSPHERE_ADMIN_KEY: ADMIN });
    assert.match(r.stdout, /Messages: 2,502 match what was recorded when they were posted; 3 in channels dave isn't in; 0 older ones not held any more, or in such channels \(an admin's Oby sees every channel\)\./);
  });

  test("a data folder's own audit.jsonl checks on this machine, with no profile at all", async () => {
    const empty = tmp('noprofile');
    const r = await m.rep(['admin', 'audit', 'verify', AUDIT()], { OBYSPHERE_ADMIN_KEY: ADMIN, OBYSPHERE_HOME: empty });
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /The file checks with this key/);
    // a line cut short at the end (a crash) is left out, as the relay leaves it out
    const torn = path.join(m.files, 'torn.jsonl');
    fs.writeFileSync(torn, fs.readFileSync(AUDIT(), 'utf8') + '{"seq": 99999, "ts"');
    const t = await m.rep(['admin', 'audit', 'verify', torn], { OBYSPHERE_ADMIN_KEY: ADMIN, OBYSPHERE_HOME: empty });
    assert.equal(t.code, 0, t.out);
    assert.match(t.stdout, /last line isn't whole/);
    // a file made with --after is checked from its first event, and says so
    const tail = await m.rep(['admin', 'audit', 'verify', path.join(m.files, 'tail.jsonl')], { OBYSPHERE_ADMIN_KEY: ADMIN, OBYSPHERE_HOME: empty });
    assert.equal(tail.code, 0, tail.out);
    assert.match(tail.stdout, /#2,001 to #2,5\d\d/);
    assert.match(tail.stdout, /It starts at #2,001 \(made with --after\): it's checked from there/);
  });

  test('a wrong key fails at #1', async () => {
    const r = await m.rep(['admin', 'audit', 'verify', '--profile', 'alice'], { OBYSPHERE_ADMIN_KEY: OTHER });
    assert.equal(r.code, 1, r.out);
    assert.match(r.stdout, /✗ Event #1 \(join, \d+ \w{3} \d\d:\d\d\) doesn't check with this key: it was changed, or the key is wrong\. Nothing from #1 on is proven\./);
    assert.match(r.stdout, /The relay says its chain is verified: that's its own word/);
    const f = await m.rep(['admin', 'audit', 'verify', exported], { OBYSPHERE_ADMIN_KEY: OTHER });
    assert.equal(f.code, 1);
    assert.match(f.stdout, /Event #1 .* doesn't check with this key/);
  });

  test('an edited detail fails at its seq', async () => {
    await tampered(
      () => editLine(AUDIT(), 1500, (e) => ({ ...e, detail: e.detail.replace(/^\w+/, 'mallory') })),
      async () => {
        const r = await verifyJson(m, ['--profile', 'alice']);
        assert.equal(r.code, 1, r.out);
        assert.deepEqual([r.j.failure.seq, r.j.failure.kind], [1500, 'hash']);
        assert.match(r.j.failure.message, /^Event #1,500 \(post, .*\) doesn't check with this key: it was changed, or the key is wrong\. Nothing from #1,500 on is proven\.$/);
        assert.equal(r.j.to, 1499, '#1 to #1,499 still check');
        const f = await verifyJson(m, [AUDIT()]);
        assert.deepEqual([f.code, f.j.failure.seq, f.j.failure.kind], [1, 1500, 'hash']);
      },
    );
  });

  test('a dropped line fails where it was', async () => {
    await tampered(
      () => fs.writeFileSync(AUDIT(), fs.readFileSync(AUDIT(), 'utf8').split('\n').filter((_, i) => i !== 1499).join('\n')),
      async () => {
        const r = await verifyJson(m, ['--profile', 'alice']);
        assert.equal(r.code, 1, r.out);
        assert.deepEqual([r.j.failure.seq, r.j.failure.kind], [1500, 'order']);
        assert.match(r.j.failure.message, /^Event #1,500 isn't where it should be: after #1,499 comes #1,501\. It was dropped or moved\./);
        assert.deepEqual((await verifyJson(m, [AUDIT()])).j.failure.seq, 1500);
      },
    );
  });

  test('two lines swapped fail where the first was', async () => {
    await tampered(
      () => {
        const ls = fs.readFileSync(AUDIT(), 'utf8').split('\n');
        [ls[1499], ls[1500]] = [ls[1500], ls[1499]];
        fs.writeFileSync(AUDIT(), ls.join('\n'));
      },
      async () => {
        const r = await verifyJson(m, ['--profile', 'alice']);
        assert.equal(r.code, 1, r.out);
        assert.deepEqual([r.j.failure.seq, r.j.failure.kind], [1500, 'order']);
        assert.match(r.j.failure.message, /after #1,499 comes #1,501/);
        assert.deepEqual((await verifyJson(m, [AUDIT()])).j.failure.seq, 1500);
      },
    );
  });

  test('the log re-chained under another key fails at #1', async () => {
    await tampered(
      () => fs.writeFileSync(AUDIT(), lines(chain(readLines(AUDIT()), OTHER))),
      async () => {
        const r = await verifyJson(m, ['--profile', 'alice']);
        assert.equal(r.code, 1, r.out);
        assert.deepEqual([r.j.failure.seq, r.j.failure.kind], [1, 'hash']);
        assert.deepEqual((await verifyJson(m, [AUDIT()])).j.failure.seq, 1);
      },
    );
  });

  test('a message changed in messages.jsonl fails, naming it', async () => {
    let id;
    await tampered(
      () => {
        const ls = fs.readFileSync(MSGS(), 'utf8').split('\n');
        const i = ls.findIndex((l) => l.includes('"text":"Post 1000"'));
        const msg = JSON.parse(ls[i]);
        id = msg.id;
        ls[i] = JSON.stringify({ ...msg, text: 'Post 1000, changed' });
        fs.writeFileSync(MSGS(), ls.join('\n'));
      },
      async () => {
        const r = await verifyJson(m, ['--profile', 'alice']);
        assert.equal(r.code, 1, r.out);
        assert.equal(r.j.failure.kind, 'content');
        assert.match(r.j.failure.message, new RegExp(`^The post ${id} \\(#[\\d,]+, \\d+ \\w{3} \\d\\d:\\d\\d\\) isn't what was recorded when it was posted: it was changed since\\.$`));
        const human = await m.rep(['admin', 'audit', 'verify', '--profile', 'alice'], { OBYSPHERE_ADMIN_KEY: ADMIN });
        assert.match(human.stdout, /The chain itself checks: #1 to #2,5\d\d\./);
        // the file has no messages to compare: it still checks
        assert.equal((await verifyJson(m, [AUDIT()])).code, 0);
      },
    );
  });

  test('a relay serving a forged log, with verified: true, fails', async () => {
    const real = readLines(exported);
    for (const [label, events, seq] of [
      ['an event changed', real.map((e) => (e.seq === 1234 ? { ...e, detail: 'nothing happened' } : e)), 1234],
      ['the whole log re-chained under another key', chain(real, OTHER), 1],
      ['an event left out', real.filter((e) => e.seq !== 77), 77],
    ]) {
      const fake = await fakeRelay({ events, messages: [] });
      m.fakeProfile('forged', fake.base);
      try {
        const r = await m.rep(['admin', 'audit', 'verify', '--profile', 'forged'], { OBYSPHERE_ADMIN_KEY: ADMIN });
        assert.equal(r.code, 1, `${label}: ${r.out}`);
        assert.match(r.stdout, new RegExp(`#${seq.toLocaleString('en-US')}\\b`), label);
        assert.match(r.stdout, /The relay says its chain is verified: that's its own word, and this check, on your machine, says otherwise\./, label);
        assert.ok(fake.paths.filter((p) => p.startsWith('/api/audit?after=')).length >= 3, `${label}: it paged`);
      } finally {
        await fake.close();
        fs.rmSync(path.join(m.home, 'forged'), { recursive: true, force: true });
      }
    }
  });

  test('a relay whose head is past the log it serves fails', async () => {
    const real = readLines(exported);
    const fake = await fakeRelay({ events: real.slice(0, -3), head: { seq: real.at(-1).seq, hash: real.at(-1).hash }, messages: [] });
    m.fakeProfile('short', fake.base);
    try {
      const r = await verifyJson(m, ['--profile', 'short']);
      assert.equal(r.code, 1, r.out);
      assert.equal(r.j.failure.kind, 'head');
      assert.match(r.j.failure.message, /The relay says its log ends at #2,5\d\d .* but the log it served ends at #2,5\d\d/);
    } finally {
      await fake.close();
      fs.rmSync(path.join(m.home, 'short'), { recursive: true, force: true });
    }
  });

  test('the admin key never goes on the command line, in a request, in the output or in a file', async () => {
    // refused as an argument, before anything else
    for (const args of [['--admin-key', ADMIN], [`--admin-key=${ADMIN}`]]) {
      const r = await m.rep(['admin', 'audit', 'verify', '--profile', 'alice', ...args]);
      assert.equal(r.code, 2, r.out);
      assert.match(r.out, /never goes on the command line/);
      assert.ok(!r.out.includes(ADMIN));
    }
    assert.equal((await m.rep(['admin', 'audit', 'export', '--profile', 'alice', '--admin-key', ADMIN])).code, 1);
    // no key and no terminal: it says how to give one, and couldn't check
    const none = await m.rep(['admin', 'audit', 'verify', '--profile', 'alice']);
    assert.equal(none.code, 2, none.out);
    assert.match(none.out, /OBYSPHERE_ADMIN_KEY/);
    assert.equal((await m.rep(['admin', 'audit', 'verify', exported], { OBYSPHERE_ADMIN_KEY: 'short key' })).code, 2);
    assert.equal((await m.rep(['admin', 'audit', 'verify', path.join(m.files, 'nothing.jsonl')], { OBYSPHERE_ADMIN_KEY: ADMIN })).code, 2);

    // every request through a proxy that records them: erin joins through it, exports and verifies
    const proxy = await recordingProxy(relay.base);
    try {
      await m.join(proxy.base, 'erin');
      const ex = await m.rep(['admin', 'audit', 'export', '--profile', 'erin', '--out', 'erin.jsonl'], { OBYSPHERE_ADMIN_KEY: ADMIN });
      assert.equal(ex.code, 0, ex.out);
      const v = await m.rep(['admin', 'audit', 'verify', '--profile', 'erin'], { OBYSPHERE_ADMIN_KEY: ADMIN });
      assert.equal(v.code, 0, v.out);
      assert.ok(proxy.seen.some((r) => r.url.startsWith('/api/audit')) && proxy.seen.some((r) => r.url.startsWith('/api/messages')), 'it went through the proxy');
      assert.ok(proxy.seen.every((r) => !('x-admin-key' in r.headers)), 'no request has an admin key header');
      assert.ok(!JSON.stringify(proxy.seen).includes(ADMIN), 'the key is in no request');
      for (const r of [ex, v]) assert.ok(!r.out.includes(ADMIN), 'nor in the output');
    } finally {
      await proxy.close();
    }
    // nor in a file: the exports, and every profile's files (the kept heads among them, owner-only)
    for (const f of fs.readdirSync(m.files)) assert.ok(!fs.readFileSync(path.join(m.files, f), 'utf8').includes(ADMIN), f);
    for (const n of fs.readdirSync(m.home)) {
      if (!fs.statSync(path.join(m.home, n)).isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(m.home, n))) {
        const p = path.join(m.home, n, f);
        if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p, 'utf8').includes(ADMIN), `${n}/${f}`);
      }
    }
    const heads = path.join(m.home, 'erin', 'audit-heads.json');
    assert.equal(mode(heads), 0o600);
    const kept = JSON.parse(fs.readFileSync(heads, 'utf8'));
    assert.deepEqual(Object.keys(kept), [JSON.parse(fs.readFileSync(path.join(m.home, 'erin', 'profile.json'), 'utf8')).sphere]);
    assert.match(Object.values(kept)[0].hash, /^[0-9a-f]{64}$/);
  });

  test('step 2: a log that only grew passes; a cut or a rewrite after an export is caught with --since and with the kept head', async () => {
    // an older export, and a check that keeps the head
    const older = path.join(m.files, 'older.jsonl');
    assert.equal((await m.rep(['admin', 'audit', 'export', '--profile', 'alice', '--out', older])).code, 0);
    assert.equal((await verifyJson(m, ['--profile', 'alice'])).j.verified, true);
    const olderLast = readLines(older).at(-1);

    // the log grows: both checks pass, and say what they checked
    for (let i = 0; i < 10; i++) assert.equal((await call(relay.base, 'POST', '/api/messages', { token: m.token('bob'), body: { channel: 'general', text: `More ${i}` } })).status, 200);
    let r = await m.rep(['admin', 'audit', 'verify', '--profile', 'alice', '--since', older], { OBYSPHERE_ADMIN_KEY: ADMIN });
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, new RegExp(`Since older\\.jsonl: the log still holds its last event, #${olderLast.seq.toLocaleString('en-US')}, unchanged\\.`));
    assert.match(r.stdout, new RegExp(`Since the last check \\(.*\\): the log still holds #${olderLast.seq.toLocaleString('en-US')}, unchanged\\.`));
    const newer = path.join(m.files, 'newer.jsonl');
    assert.equal((await m.rep(['admin', 'audit', 'export', '--profile', 'alice', '--out', newer])).code, 0);
    r = await m.rep(['admin', 'audit', 'verify', newer, '--since', older], { OBYSPHERE_ADMIN_KEY: ADMIN });
    assert.equal(r.code, 0, r.out);
    // a file made with --after, right after the older one, links on to it
    const next = path.join(m.files, 'next.jsonl');
    assert.equal((await m.rep(['admin', 'audit', 'export', '--profile', 'alice', '--out', next, '--after', String(olderLast.seq)])).code, 0);
    r = await verifyJson(m, [next, '--since', older]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual([r.j.since.held, r.j.since.links], [true, true]);
    // one that starts later than the older one ends can't be compared, and a missing one can't be read
    const first = path.join(m.files, 'first.jsonl');
    fs.writeFileSync(first, lines(readLines(older).slice(0, 1000)));
    r = await m.rep(['admin', 'audit', 'verify', path.join(m.files, 'tail.jsonl'), '--since', first], { OBYSPHERE_ADMIN_KEY: ADMIN });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /This log starts at #2,001, after first\.jsonl's last event \(#1,000\), so the two can't be compared\./);
    r = await m.rep(['admin', 'audit', 'verify', newer, '--since', path.join(m.files, 'missing.jsonl')], { OBYSPHERE_ADMIN_KEY: ADMIN });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /no such file/);
    const keptNow = JSON.parse(fs.readFileSync(path.join(m.home, 'alice', 'audit-heads.json'), 'utf8'))[relay.base];
    assert.ok(keptNow.seq > olderLast.seq, 'the kept head moved on');
    // the cut: the newest events gone, by someone with the data folder (the chain alone still checks)
    await tampered(
      () => fs.writeFileSync(AUDIT(), fs.readFileSync(AUDIT(), 'utf8').split('\n').slice(0, olderLast.seq - 5).join('\n') + '\n'),
      async () => {
        let c = await verifyJson(m, ['--profile', 'alice']);
        assert.equal(c.code, 1, c.out);
        assert.equal(c.j.failure.kind, 'kept-head');
        assert.match(c.j.failure.message, new RegExp(`this log checked up to #${keptNow.seq.toLocaleString('en-US')}, but now it ends at #${(olderLast.seq - 5).toLocaleString('en-US')}: events were cut off\\.`));
        const said = await m.rep(['admin', 'audit', 'verify', '--profile', 'alice'], { OBYSPHERE_ADMIN_KEY: ADMIN });
        assert.match(said.stdout, /Only if this Sphere was started afresh on purpose: delete .*alice\/audit-heads\.json/);
        // dave's own check kept a head before the cut too
        c = await verifyJson(m, ['--profile', 'dave']);
        assert.deepEqual([c.code, c.j.failure.kind], [1, 'kept-head']);
        c = await verifyJson(m, [AUDIT(), '--since', older]);
        assert.equal(c.code, 1, c.out);
        assert.equal(c.j.failure.kind, 'since');
        assert.match(c.j.failure.message, /older\.jsonl holds events up to #[\d,]+, but this log ends at #[\d,]+: events were cut off\./);
      },
    );
    // the rewrite: an early event changed and the whole log chained again, by someone with the admin key
    await tampered(
      () => {
        const evs = readLines(AUDIT());
        evs[99] = { ...evs[99], detail: 'rewritten' };
        fs.writeFileSync(AUDIT(), lines(chain(evs, ADMIN)));
      },
      async () => {
        const plain = await verifyJson(m, [AUDIT()]);
        assert.equal(plain.code, 0, 'the chain alone checks: it was made with the key');
        let c = await verifyJson(m, ['--profile', 'alice']);
        assert.equal(c.code, 1, c.out);
        assert.equal(c.j.failure.kind, 'kept-head');
        assert.match(c.j.failure.message, new RegExp(`Event #${keptNow.seq.toLocaleString('en-US')} isn't the one that checked on .*: the log was rewritten up to there`));
        c = await verifyJson(m, [AUDIT(), '--since', older]);
        assert.equal(c.code, 1);
        assert.equal(c.j.failure.kind, 'since');
        assert.match(c.j.failure.message, /isn't the one in older\.jsonl: the log was rewritten up to there/);
      },
    );
    // put back, it passes again
    assert.equal((await verifyJson(m, ['--profile', 'alice', '--since', older])).code, 0);
  });
});

describe('audit export and verify on the Redis store', () => {
  let fake, relay, m;
  before(async () => {
    fake = await startFakeUpstash({ port: await freePort() });
    m = machine('redis');
    // compacted along the way: every audit event is kept, so the chain still checks from #1
    relay = await startRelay({ env: { SPHERE_STORE: 'redis', UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, SPHERE_REDIS_PREFIX: 'audit-cli:', SPHERE_COMPACT_EVERY: '1000', SPHERE_COMPACT_WAIT_MS: '0' } });
    await busy(relay.base, m);
  });
  after(async () => {
    if (relay) await stop(relay.proc);
    await fake?.close?.();
  });

  test('export is the pages, and verify passes online and on the export', async () => {
    const r = await m.rep(['admin', 'audit', 'export', '--profile', 'carol', '--out', 'redis.jsonl']);
    assert.equal(r.code, 0, r.out);
    const pages = await relayPages(relay.base, m.token('carol'));
    assert.ok(pages.events.length > 2500);
    assert.deepEqual(readLines(path.join(m.files, 'redis.jsonl')), pages.events);
    assert.equal(mode(path.join(m.files, 'redis.jsonl')), 0o600);
    const online = await verifyJson(m, ['--profile', 'alice']);
    assert.equal(online.code, 0, online.out);
    assert.equal(online.j.events, pages.events.length);
    assert.equal(online.j.messages.checked, POSTS + 5);
    assert.equal((await verifyJson(m, [path.join(m.files, 'redis.jsonl')])).code, 0);
    assert.equal((await verifyJson(m, ['--profile', 'alice'], { OBYSPHERE_ADMIN_KEY: OTHER })).j.failure.seq, 1);
  });
});

// ---- deletions and cuts on a real relay (#139): what the relay writes for them checks with
// rep.mjs's rules, on both stores, and a message taken out of the data folder after the last cut
// is caught, by the relay's own check and by this one.

describe('deleted and cut messages on a real relay', () => {
  for (const store of ['fs', 'redis']) {
    test(`${store}: a deletion and a cut by count check; a message removed by hand after the cut doesn't`, async () => {
      const m = machine(`cut-${store}`);
      const data = path.join(path.dirname(m.home), 'relay');
      const fake = store === 'redis' ? await startFakeUpstash({ port: await freePort() }) : null;
      const env = fake ? { SPHERE_STORE: 'redis', UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, SPHERE_REDIS_PREFIX: 'audit-cut:', SPHERE_COMPACT_WAIT_MS: '0' } : {};
      let relay = await startRelay({ data: fake ? null : data, env });
      try {
        for (const n of ['alice', 'bob']) await m.join(relay.base, n);
        assert.equal((await m.rep(['admin', 'claim', '--profile', 'alice'], { OBYSPHERE_ADMIN_KEY: ADMIN })).code, 0);
        const bob = m.token('bob');
        const ids = [];
        for (let i = 0; i < 130; i += 50) {
          const batch = [];
          for (let j = i; j < Math.min(130, i + 50); j++) batch.push(call(relay.base, 'POST', '/api/messages', { token: bob, body: { channel: 'general', text: `Post ${j + 1}` } }));
          for (const r of await Promise.all(batch)) {
            assert.equal(r.status, 200, JSON.stringify(r));
            ids.push(r.message.id);
          }
        }
        const del = await call(relay.base, 'DELETE', `/api/messages/${ids[119]}`, { token: bob });
        assert.equal(del.status, 200, JSON.stringify(del));
        assert.ok(del.message.deleted && !('text' in del.message), JSON.stringify(del.message));
        // fewer kept: a cut, in the same commit, down to the newest 100
        assert.equal((await call(relay.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { retainMessages: 100 } })).status, 200);
        const audit = await relayPages(relay.base, bob);
        assert.ok(audit.events.some((e) => e.type === 'delete' && e.ref === ids[119]));
        assert.ok(audit.events.some((e) => e.type === 'expire' && e.ref), 'the cut is recorded');
        let r = await verifyJson(m, ['--profile', 'alice']);
        assert.equal(r.code, 0, r.out);
        assert.equal(r.j.messages.deleted, 1);
        assert.ok(r.j.messages.notHeld >= 30, JSON.stringify(r.j.messages));
        assert.ok(r.j.messages.checked + r.j.messages.deleted <= 100, JSON.stringify(r.j.messages));
        assert.equal(r.j.relay.verified, true);
        r = await verifyJson(m, ['--profile', 'bob']);
        assert.equal(r.code, 0, r.out);
        if (fake) return;
        // fs: Post 125 taken out of messages.jsonl while the relay is stopped
        await stop(relay.proc);
        const file = path.join(data, 'messages.jsonl');
        const ls = fs.readFileSync(file, 'utf8').split('\n');
        const i = ls.findIndex((l) => l.includes('"text":"Post 125"'));
        assert.ok(i >= 0);
        ls.splice(i, 1);
        fs.writeFileSync(file, ls.join('\n'));
        relay = await startRelay({ data, port: relay.port });
        r = await verifyJson(m, ['--profile', 'alice']);
        assert.equal(r.code, 1, r.out);
        assert.equal(r.j.relay.verified, false, "the relay's own check says so too");
        assert.match(r.j.failure.message, new RegExp(`^The post ${ids[124]} \\(#[\\d,]+, .*\\) isn't held, and no cut removed it: it was removed by hand\\.$`));
      } finally {
        await stop(relay.proc);
        await fake?.close?.();
      }
    });
  }
});

// ---- deleted and cut messages (#139): DELETE /api/messages/:id leaves a tombstone and writes a
// `delete` event with the content hash its ask, reply or post event carried; a cut writes an
// `expire` event naming the newest message it removed. Built here, as the relay writes them.

describe('deleted and cut messages, against logs built by hand', () => {
  let m;
  const ts = (i) => new Date(Date.UTC(2026, 10, 20, 14, i)).toISOString();
  const msgA = { id: 'm_aaaa0001', ts: ts(1), channel: 'general', from: 'a_bob001', kind: 'post', to: [], text: 'A thing I said', replyTo: null, cause: null, files: [], depth: 0, meta: {} };
  const msgB = { id: 'm_bbbb0002', ts: ts(2), channel: 'general', from: 'a_bob001', kind: 'post', to: [], text: 'Another', replyTo: null, cause: null, files: [], depth: 0, meta: {}, claimedAt: ts(3) };
  // what a tombstone keeps, and nothing else
  const tomb = (msg) => {
    const t = { id: msg.id, ts: msg.ts, channel: msg.channel, from: msg.from, kind: msg.kind, to: msg.to, replyTo: msg.replyTo, cause: msg.cause, depth: msg.depth };
    for (const k of ['claimedAt', 'startedAt']) if (msg[k]) t[k] = msg[k];
    return { ...t, deleted: { at: ts(9), by: msg.from } };
  };
  const ev = (type, extra = {}) => ({ ts: ts(5), type, actor: 'a_bob001', target: null, ref: null, detail: `bob · ${type}`, ...extra });
  const base = () => [ev('join', { detail: 'bob joined, representing Bob' }), ev('post', { ref: msgA.id, content: contentHash(msgA) }), ev('post', { ref: msgB.id, content: contentHash(msgB) })];
  const msgC = { ...msgA, id: 'm_cccc0003', ts: ts(3), text: 'A third thing' };
  const withC = () => [...base(), ev('post', { ref: msgC.id, content: contentHash(msgC) })]; // #1 join, #2 A, #3 B, #4 C
  const cut = (ref) => ev('expire', { actor: null, ref, detail: `1 message past the newest 5,000 removed, up to ${ref}` });
  // `more`: events written while the check runs, after the log was read and before the messages
  // were (chained on from `events`, unless they come chained already)
  const check = async (events, messages, { more = [], chained = null, info = {} } = {}) => {
    const all = chained ?? chain([...events, ...more], ADMIN);
    const fake = await fakeRelay({ events: all.slice(0, events.length), more: all.slice(events.length), messages, info });
    m.fakeProfile('hand', fake.base);
    try {
      return { ...(await verifyJson(m, ['--profile', 'hand'])), paths: fake.paths };
    } finally {
      await fake.close();
    }
  };
  before(() => {
    m = machine('deleted');
  });

  test('a log built here checks, the timing patches aside (the same hash as the relay)', async () => {
    const r = await check(base(), [msgA, { ...msgB, startedAt: ts(4), waiting: { for: 'owner' } }]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual([r.j.messages.checked, r.j.messages.deleted], [2, 0]);
  });

  test('a tombstone passes with a delete event that carries its post’s content hash', async () => {
    const r = await check([...base(), ev('delete', { ref: msgA.id, content: contentHash(msgA) })], [tomb(msgA), msgB]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual([r.j.messages.checked, r.j.messages.deleted], [1, 1]);
  });

  test('a tombstone with no delete event, or one with another content hash, fails', async () => {
    let r = await check(base(), [tomb(msgA), msgB]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.j.failure.message, /^The post m_aaaa0001 \(#2, \d+ \w{3}( \d{4})? \d\d:\d\d\) is shown as deleted, but the log has no delete event for it/);
    r = await check([...base(), ev('delete', { ref: msgA.id, content: contentHash(msgB) })], [tomb(msgA), msgB]);
    assert.equal(r.code, 1, r.out);
    assert.equal(r.j.failure.kind, 'content');
    // the content hash leaves claimedAt out, as the relay's does: a tombstone that keeps it passes
    r = await check([...base(), ev('delete', { ref: msgB.id, content: contentHash(msgB) })], [msgA, tomb(msgB)]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual([r.j.messages.checked, r.j.messages.deleted], [1, 1]);
  });

  test('a delete event whose message the relay still serves with its words fails', async () => {
    let r = await check([...base(), ev('delete', { ref: msgA.id, content: contentHash(msgA) })], [msgA, msgB]);
    assert.equal(r.code, 1, r.out);
    assert.equal(r.j.failure.seq, 4);
    assert.match(r.j.failure.message, /^The post m_aaaa0001 \(#2, .*\) was deleted \(#4\), but the relay still serves its words\./);
    r = await check([...base(), ev('delete', { ref: msgA.id, content: contentHash(msgA) })], [{ ...tomb(msgA), text: 'A thing I said' }, msgB]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.j.failure.message, /still serves its words/);
  });

  test('a message deleted while the check runs passes: the log read on after the messages has its delete event', async () => {
    const del = ev('delete', { ref: msgA.id, content: contentHash(msgA) });
    let r = await check(base(), [tomb(msgA), msgB], { more: [del] });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual([r.j.messages.checked, r.j.messages.deleted], [1, 1]);
    assert.ok(r.paths.includes('/api/audit?after=3&limit=1000'), `it read the log on from #3: ${r.paths.join(' ')}`);
    // posted and deleted while it runs: both events come after the log it checked
    const msgC = { ...msgA, id: 'm_cccc0003', text: 'Said and taken back' };
    r = await check(base(), [msgA, msgB, tomb(msgC)], { more: [ev('post', { ref: msgC.id, content: contentHash(msgC) }), ev('delete', { ref: msgC.id, content: contentHash(msgC) })] });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual([r.j.messages.checked, r.j.messages.deleted], [2, 0]);
    // a check with nothing to explain doesn't read on
    r = await check(base(), [msgA, msgB], { more: [del] });
    assert.equal(r.code, 0, r.out);
    assert.ok(!r.paths.some((p) => p.startsWith('/api/audit?after=3')), r.paths.join(' '));
  });

  test("a tombstone the log read on doesn't explain fails, and so does a log read on that doesn't link on", async () => {
    let r = await check(base(), [tomb(msgA), msgB], { more: [ev('post', { ref: 'm_dddd0004', content: contentHash(msgB) })] });
    assert.equal(r.code, 1, r.out);
    assert.equal(r.j.failure.kind, 'content');
    assert.match(r.j.failure.message, /^The post m_aaaa0001 \(#2, \d+ \w{3}( \d{4})? \d\d:\d\d\) is shown as deleted, but the log has no delete event for it/);
    r = await check(base(), [msgA, msgB, { ...tomb(msgA), id: 'm_eeee0005' }]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.j.failure.message, /Message m_eeee0005 is shown as deleted, but the log never recorded it being posted and deleted\./);
    // the delete event chained under another key: what was read on doesn't follow #3
    const del = ev('delete', { ref: msgA.id, content: contentHash(msgA) });
    const forged = chain([...base(), del], OTHER);
    r = await check(base(), [tomb(msgA), msgB], { chained: [...chain(base(), ADMIN), forged[3]] });
    assert.equal(r.code, 1, r.out);
    assert.deepEqual([r.j.failure.seq, r.j.failure.kind], [4, 'prev']);
    assert.match(r.j.failure.message, /^Event #4 \(delete, .*\) doesn't follow #3/);
  });

  test("a message deleted and then no longer held is counted as not held", async () => {
    const r = await check([...base(), ev('delete', { ref: msgA.id, content: contentHash(msgA) })], [msgB]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual([r.j.messages.checked, r.j.messages.notHeld], [1, 1]);
  });

  test('after a cut, a message at or before the one it names may be missing; one after it fails for an admin, and is counted for a member', async () => {
    let r = await check([...withC(), cut(msgA.id)], [msgB, msgC]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual([r.j.messages.checked, r.j.messages.notHeld], [2, 1]);
    // B is missing too, though no cut reached it: removed by hand
    r = await check([...withC(), cut(msgA.id)], [msgC]);
    assert.equal(r.code, 1, r.out);
    assert.deepEqual([r.j.failure.seq, r.j.failure.kind], [3, 'content']);
    assert.match(r.j.failure.message, /^The post m_bbbb0002 \(#3, \d+ \w{3}( \d{4})? \d\d:\d\d\) isn't held, and no cut removed it: it was removed by hand\.$/);
    // an Oby that doesn't see every channel can't tell it from one in a channel it isn't in
    r = await check([...withC(), cut(msgA.id)], [msgC], { info: { admin: false } });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual([r.j.messages.checked, r.j.messages.notHeld, r.j.messages.hidden], [1, 1, 1]);
    // before any cut is recorded, a missing message passes: older relays trimmed without a trace
    r = await check(withC(), [msgC]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual([r.j.messages.checked, r.j.messages.notHeld], [1, 2]);
  });

  test('a cut that names a message the log never recorded being posted fails', async () => {
    let r = await check([...base(), cut('m_ffff0006')], [msgA, msgB]);
    assert.equal(r.code, 1, r.out);
    assert.equal(r.j.failure.seq, 4);
    assert.match(r.j.failure.message, /^The cut #4 \(\d+ \w{3}( \d{4})? \d\d:\d\d\) names message m_ffff0006, but the log never recorded it being posted before\.$/);
    // nor one posted after the cut
    r = await check([...base(), cut(msgC.id), ev('post', { ref: msgC.id, content: contentHash(msgC) })], [msgA, msgB, msgC]);
    assert.equal(r.code, 1, r.out);
    assert.equal(r.j.failure.seq, 4);
  });

  test('a cut while the check runs passes: the log read on after the messages has it', async () => {
    const r = await check([...withC(), cut(msgA.id)], [msgC], { more: [cut(msgB.id)] });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual([r.j.messages.checked, r.j.messages.notHeld], [1, 2]);
    assert.ok(r.paths.includes('/api/audit?after=5&limit=1000'), `it read the log on from #5: ${r.paths.join(' ')}`);
  });

  test('a message older than the Sphere keeps messages may be missing before its cut: the relay hides it at once', async () => {
    const recent = { ...msgA, id: 'm_rrrr0007', ts: new Date().toISOString(), text: 'Just now' };
    const events = [...withC(), cut(msgA.id), ev('post', { ts: recent.ts, ref: recent.id, content: contentHash(recent) })];
    const day = { info: { sphere: { policy: { keepDays: 1 } } } };
    // B and C are days old, and this Sphere keeps messages for a day
    let r = await check(events, [recent], day);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual([r.j.messages.checked, r.j.messages.notHeld], [1, 3]);
    // with no time limit, they were removed by hand
    r = await check(events, [recent]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.j.failure.message, /^The post m_bbbb0002 .* removed by hand\.$/);
    // the newest is within the day: missing, it was removed by hand
    r = await check(events, [msgB, msgC], day);
    assert.equal(r.code, 1, r.out);
    assert.match(r.j.failure.message, /^The post m_rrrr0007 .* removed by hand\.$/);
  });
});

// ---- the console: Export all saves the whole log as JSON Lines, and the Audit log page says its
// "Chain verified" is the relay's word, and how to check it yourself. The page's own functions, in
// a sandbox (the browser tests click through it in Chromium).

describe("the console's Audit log", () => {
  const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'))[1];
  const piece = (re, name) => {
    const m = re.exec(SCRIPT);
    assert.ok(m, `the page has ${name}`);
    const start = m.index + 1;
    if (/^ {2}const /.test(SCRIPT.slice(start))) return SCRIPT.slice(start, SCRIPT.indexOf(';\n', start) + 1);
    let depth = 0;
    for (let i = SCRIPT.indexOf('{', start); i < SCRIPT.length; i++) {
      if (SCRIPT[i] === '{') depth++;
      else if (SCRIPT[i] === '}' && --depth === 0) return SCRIPT.slice(start, i + 1);
    }
    throw new Error(`${name} has no end`);
  };
  const fnOf = (n) => piece(new RegExp(`\\n  (?:async )?function ${n}\\(`), n);
  const constOf = (n) => piece(new RegExp(`\\n  const ${n} = `), n);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const page = (ctx) => {
    vm.createContext(ctx);
    vm.runInContext(`${constOf('auditFiltering')}\n${constOf('auditExportLabel')}\n${fnOf('auditHead')}\n${fnOf('exportAudit')}\nthis.f = { auditHead, exportAudit };`, ctx);
    return ctx.f;
  };
  const AU = () => ({ q: '', type: 'all', member: '', time: 'all', exporting: false });

  test('the page says "Chain verified" is the relay’s word, and how to check the log yourself', () => {
    const ctx = { S: { auditVerified: true, auditHead: { seq: 2600 }, audit: [] }, AU: AU(), head: (t, sub, right = '') => `<h1>${t}</h1><p>${sub}</p>${right}`, esc };
    const { auditHead } = page(ctx);
    assert.match(auditHead(), /Chain verified · 2,600 events/);
    assert.match(auditHead(), /<p class="au-own" id="au-own">That’s the relay’s own word\. To check the log yourself, export all of it and run <code>obysphere admin audit verify &lt;file&gt;<\/code> on your machine, with the admin key\.<\/p>/);
    ctx.S.auditVerified = false;
    assert.match(auditHead(), /Chain broken[\s\S]*That’s the relay’s own word/);
    ctx.S.auditVerified = null;
    assert.doesNotMatch(auditHead(), /au-own/, "no log published: nothing to check");
    assert.ok(!/admin key[^<]*<input|type="password"/.test(auditHead()), 'the page never asks for the key to check it');
  });

  test('Export all saves every event, past 1,000, as JSON Lines named for the Sphere and the day; Export shown stays JSON', async () => {
    const events = chain(Array.from({ length: 2600 }, (_, i) => ({ ts: new Date(Date.UTC(2026, 10, 20, 9, 0, i)).toISOString(), type: 'post', actor: 'a_bob001', target: null, ref: null, detail: `bob · #general · ${i} B` })), ADMIN);
    const head = { seq: 2600, hash: events.at(-1).hash };
    const run = async (au) => {
      const got = { saved: null, type: null, link: null, asked: [] };
      const ctx = {
        S: { sphere: { name: 'Our Team’s Sphere' }, auditHead: head, auditVerified: true, audit: events.slice(-1000) },
        AU: au,
        api: async (url) => {
          got.asked.push(url);
          const after = Number(new URL(url, 'http://x').searchParams.get('after'));
          return { events: events.filter((e) => e.seq > after).slice(0, 1000), head, verified: true, total: events.length };
        },
        updateAudit: () => {},
        auditShown: () => events.slice(-3).reverse(),
        Blob: class {
          constructor(parts, o) {
            got.saved = parts.join('');
            got.type = o?.type;
          }
        },
        URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
        document: { createElement: () => (got.link = { click() {} }), querySelector: () => null },
        setTimeout: () => {},
      };
      await page(ctx).exportAudit();
      return got;
    };
    const all = await run(AU());
    assert.equal(all.asked.length, 3, 'three pages');
    assert.equal(all.saved, lines(events), 'one event per line, as the relay sent it');
    assert.match(all.link.download, /^our-team-s-sphere-audit-\d{4}-\d{2}-\d{2}\.jsonl$/);
    assert.equal(all.type, 'application/jsonl');
    const shown = await run({ ...AU(), q: 'bob' });
    assert.equal(shown.link.download, 'our-team-s-sphere-audit-shown.json');
    assert.equal(JSON.parse(shown.saved).events.length, 3);
    assert.equal(JSON.parse(shown.saved).filter.search, 'bob');
  });

  test('what Export all saves checks with the CLI', async () => {
    const m = machine('console');
    const events = chain([{ ts: '2026-11-20T09:00:00.000Z', type: 'join', actor: 'a_bob001', target: null, ref: null, detail: 'bob joined, representing Bob' }], ADMIN);
    const file = path.join(m.files, 'console.jsonl');
    fs.writeFileSync(file, lines(events));
    const r = await m.rep(['admin', 'audit', 'verify', file], { OBYSPHERE_ADMIN_KEY: ADMIN });
    assert.equal(r.code, 0, r.out);
  });
});

// ---- fakes: a relay that serves what it's given, and a proxy that records every request

// `more`: events written once the messages were asked for (a message deleted while a check runs)
async function fakeRelay({ events, head, messages = [], more = [], info = {} }) {
  const paths = [];
  let log = events;
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    const u = new URL(req.url, 'http://x');
    const send = (o) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (u.pathname === '/api/info') return send({ sphere: { name: 'Fake Sphere', ...(info.sphere || {}) }, me: { id: 'a_fake01', name: 'fake' }, admin: info.admin ?? true });
    if (u.pathname === '/api/audit') {
      const after = Number(u.searchParams.get('after')) || 0;
      const limit = Math.min(1000, Number(u.searchParams.get('limit')) || 200);
      const last = log.at(-1);
      const h = head ?? { seq: last?.seq ?? 0, hash: last?.hash ?? ZERO };
      return send({ events: log.filter((e) => e.seq > after).slice(0, limit), head: h, verified: true, total: log.length });
    }
    if (u.pathname === '/api/messages') {
      log = [...events, ...more];
      return send({ messages: u.searchParams.get('before') ? [] : messages });
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });
  const port = await freePort();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${port}`, paths, close: () => new Promise((r) => server.close(r)) };
}

async function recordingProxy(target) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    seen.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: body.toString('utf8') });
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!['host', 'connection', 'content-length'].includes(k)) headers[k] = v;
    try {
      const r = await fetch(target + req.url, { method: req.method, headers, body: body.length ? body : undefined });
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch {
      res.writeHead(502);
      res.end();
    }
  });
  const port = await freePort();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(r)) };
}
