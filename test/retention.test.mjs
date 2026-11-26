// Keeping messages for a set time (#139), on both stores: policy.keepDays (0, no time limit, by
// default, for new and older Spheres), messages dated 40 days back in the data folder and the
// fake Redis are hidden at once and removed with their files at the cut, which an `expire` event
// records; a shorter period removes older messages at once; a cut by count is recorded the same
// way; uploads never sent go after a day; the chain verifies after each cut, and a message
// removed by hand after the last cut is reported. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startFakeUpstash } from './fake-upstash.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const KEY = 'join-key-retention-0123456789abcd';
const ADMIN = 'admin-key-retention-0123456789abcd';
const DAY = 864e5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p >= 4848 && p <= 4850 ? freePort() : p));
    });
  });
async function until(fn, ms = 8000) {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t > ms) return v;
    await sleep(100);
  }
}

let tmp;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-retention-')));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

async function relay(env, procs) {
  const port = await freePort();
  const p = spawn(process.execPath, [SERVER, '--port', String(port), '--host', '127.0.0.1'], {
    env: { ...process.env, HOME: path.join(tmp, 'home'), TMPDIR: tmp, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_SEALED: '0', SPHERE_POLL_MS: '150', SPHERE_WRITES_PER_MIN: '100000', SPHERE_ASKS_PER_MIN: '100000', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  procs.add(p);
  let errs = '';
  p.stderr.on('data', (d) => (errs += d));
  const exited = new Promise((r) => p.on('exit', r));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + '/healthz')).ok)
        return {
          base,
          stop: async () => {
            p.kill();
            await exited;
            procs.delete(p);
          },
        };
    } catch {}
    if (p.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error(`the relay did not start: ${errs}`);
}

const call = async (base, method, url, { token, key, admin, body } = {}) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['x-sphere-key'] = key;
  if (admin) headers['x-admin-key'] = admin;
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};

for (const kind of ['fs', 'redis']) {
  describe(`keeping messages for a set time on the ${kind} store`, () => {
    const procs = new Set();
    let fake, R, dir, prefix, alice;
    const env = () => (kind === 'fs' ? { SPHERE_STORE: 'fs', SPHERE_DATA: dir } : { SPHERE_STORE: 'redis', UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, SPHERE_REDIS_PREFIX: prefix, SPHERE_COMPACT_EVERY: '400', SPHERE_COMPACT_WAIT_MS: '0' });
    const audit = async (base = R.base) => call(base, 'GET', '/api/audit?limit=1000', { key: KEY });
    const policy = async () => (await call(R.base, 'GET', '/api/info', { key: KEY })).sphere.policy;
    const held = async () => (await call(R.base, 'GET', '/api/messages?limit=1000', { admin: ADMIN })).messages;
    // what's stored, as text
    const stored = () => {
      if (kind === 'fs') {
        let all = '';
        const walk = (d) => {
          for (const f of fs.readdirSync(d)) {
            const p = path.join(d, f);
            if (fs.statSync(p).isDirectory()) walk(p);
            else all += fs.readFileSync(p).toString('latin1') + '\n';
          }
        };
        walk(dir);
        return all;
      }
      return [...fake.kv].filter(([k, e]) => k.startsWith(prefix) && !e.exp).map(([, e]) => (Array.isArray(e.v) ? e.v.join('\n') : String(e.v))).join('\n');
    };
    // Some messages dated back, as a long-lived Sphere would hold them: the relay stopped, the stored
    // messages' times moved `days` back, and a new one started (a cold start, on Redis). Their audit
    // events no longer match them, which is fine: a cut removes them before the chain is checked.
    const age = async (ids, days, { files = [] } = {}) => {
      await R.stop();
      const back = (ts) => new Date(Date.parse(ts) - days * DAY).toISOString();
      if (kind === 'fs') {
        const file = path.join(dir, 'messages.jsonl');
        const lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => {
          if (!l) return l;
          const o = JSON.parse(l);
          if (o.id && ids.includes(o.id)) return JSON.stringify({ ...o, ts: back(o.ts) });
          if (o.f && files.includes(o.f.id)) return JSON.stringify({ f: { ...o.f, ts: back(o.f.ts) } });
          return l;
        });
        fs.writeFileSync(file, lines.join('\n'));
      } else {
        const move = (op) => (op.t === 'msg' && ids.includes(op.m.id) ? { ...op, m: { ...op.m, ts: back(op.m.ts) } } : op.t === 'file' && files.includes(op.f.id) ? { ...op, f: { ...op.f, ts: back(op.f.ts) } } : op);
        const key = fake.kv.has(prefix + 'tail') ? prefix + 'tail' : prefix + 'log';
        if (fake.kv.get(key)?.type === 'list') fake.kv.get(key).v = fake.kv.get(key).v.map((x) => JSON.stringify(move(JSON.parse(x))));
        // and in the snapshot, when the log was compacted
        const ptr = fake.kv.get(prefix + 'snap')?.v;
        if (ptr) {
          const e = fake.kv.get(prefix + 'snap:' + JSON.parse(ptr).id);
          e.v = e.v.map((x) => {
            const [pos, op] = JSON.parse(x);
            return JSON.stringify([pos, move(op)]);
          });
        }
      }
      R = await relay(env(), procs);
    };

    before(async () => {
      dir = fs.mkdtempSync(path.join(tmp, `data-${kind}-`));
      prefix = `keep-${kind}:`;
      if (kind === 'redis') fake = await startFakeUpstash({ latencyMs: 2 });
      R = await relay(env(), procs);
      alice = await call(R.base, 'POST', '/api/join', { body: { key: KEY, name: 'alice', owner: 'Alice' } });
    });
    after(async () => {
      for (const p of procs) p.kill();
      await fake?.close();
    });

    test('a new Sphere keeps messages with no time limit, as before; Policy can set a period', async () => {
      const pol = await policy();
      assert.equal(pol.keepDays, 0);
      assert.equal(pol.retainMessages, 5000);
      for (const bad of [-1, 1.5, 3651, '30']) assert.equal((await call(R.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { keepDays: bad } })).status, 400, String(bad));
      const r = await call(R.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { keepDays: 3650 } });
      assert.equal(r.policy.keepDays, 3650);
      assert.ok((await audit()).events.some((e) => e.type === 'policy' && e.detail === 'messages kept with no time limit → 3,650 days'));
      assert.equal((await call(R.base, 'POST', '/api/admin/policy', { token: alice.token, body: { keepDays: 30 } })).status, 403, 'admins only');
      assert.equal((await call(R.base, 'GET', '/api/admin/expiring?keepDays=30', { token: alice.token })).status, 403);
    });

    // (A message moved back in time no longer matches its audit event: the chain is checked once a
    // cut has removed it, at the start that finds it (init cuts before the chain is first checked),
    // or after a restart.)
    test('messages older than the period leave with their files at the cut, which an expire event records', async () => {
      assert.equal((await call(R.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { keepDays: 30 } })).status, 200);
      assert.ok((await audit()).events.some((e) => e.type === 'policy' && e.detail === 'messages kept 3,650 days → 30 days'));
      const posts = [];
      for (let i = 0; i < 4; i++) posts.push((await call(R.base, 'POST', '/api/messages', { token: alice.token, body: { text: `old news ${kind} KESTREL-${i}`, ...(i === 0 ? { files: [{ name: 'old.txt', data: Buffer.from(`KESTREL-FILE-${kind}`).toString('base64') }] } : {}) } })).message);
      // every message so far (alice's join too) forty days back: the oldest, as in a Sphere that ran that long
      const old = (await held()).map((m) => m.id);
      const fresh = (await call(R.base, 'POST', '/api/messages', { token: alice.token, body: { text: 'still fresh' } })).message;
      const fid = posts[0].files[0].id;
      await age(old, 40);
      const ids = (await held()).map((m) => m.id);
      for (const id of old) assert.ok(!ids.includes(id), 'gone');
      assert.ok(ids.includes(fresh.id), 'a fresh one stays');
      assert.equal((await call(R.base, 'GET', `/api/messages/${posts[1].id}`, { admin: ADMIN })).status, 404);
      assert.equal((await fetch(`${R.base}/api/files/${fid}`, { headers: { 'x-admin-key': ADMIN } })).status, 404);
      const au = await audit();
      const cut = au.events.filter((e) => e.type === 'expire').at(-1);
      assert.equal(cut.detail, `${old.length} messages older than 30 days removed, up to ${posts[3].id} · 1 file`);
      assert.equal(cut.ref, posts[3].id);
      assert.equal(cut.actor, null);
      assert.equal(cut.content, undefined);
      assert.equal(au.verified, true, 'the chain verifies');
      // and from storage, with the file's bytes (on Redis, at the compaction the cut brings forward)
      if (kind === 'fs') assert.equal(fs.existsSync(path.join(dir, 'files', fid)), false);
      else assert.equal(fake.kv.has(`${prefix}file:${fid}`), false);
      assert.ok(await until(async () => (await call(R.base, 'GET', '/api/info', { key: KEY }), !stored().includes('KESTREL-'))), 'the words left storage');
      // the counts keep what was relayed
      assert.ok((await call(R.base, 'GET', '/api/stats', { key: KEY })).counts.messages >= 5);
      // a restart (a cold start on Redis) holds the same, and verifies
      await R.stop();
      R = await relay(env(), procs);
      assert.deepEqual((await held()).map((m) => m.id), ids);
      assert.equal((await audit()).verified, true);
    });

    test('a shorter period removes older messages at once; one that crosses the line between cuts is hidden until the next', async () => {
      for (let i = 0; i < 3; i++) await call(R.base, 'POST', '/api/messages', { token: alice.token, body: { text: `ten days old ${i}` } });
      const all = (await held()).map((m) => m.id);
      await age(all, 10); // under 30 days: kept and shown
      assert.equal((await held()).length, all.length);
      // Policy asks first, saying how many go
      assert.deepEqual(await call(R.base, 'GET', '/api/admin/expiring?keepDays=7', { admin: ADMIN }), { status: 200, keepDays: 7, messages: all.length });
      assert.equal((await call(R.base, 'GET', '/api/admin/expiring?keepDays=0', { admin: ADMIN })).status, 400);
      assert.equal((await call(R.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { keepDays: 7 } })).status, 200);
      assert.equal((await held()).length, 0, 'removed at once');
      assert.ok((await audit()).events.some((e) => e.type === 'expire' && e.ref === all.at(-1) && e.detail.startsWith(`${all.length} messages older than 7 days removed`)));

      // a cut by time comes at most once an hour: one that crosses the line meanwhile is hidden from every read
      const m = (await call(R.base, 'POST', '/api/messages', { token: alice.token, body: { text: 'crossing the line' } })).message;
      await age([m.id], 8);
      assert.equal((await call(R.base, 'GET', `/api/messages/${m.id}`, { admin: ADMIN })).status, 404, 'hidden');
      assert.ok(!(await held()).some((x) => x.id === m.id));
      assert.ok(!(await audit()).events.some((e) => e.type === 'expire' && e.ref === m.id), 'not cut yet');
      assert.equal((await call(R.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { keepDays: 1 } })).status, 200);
      assert.ok((await audit()).events.some((e) => e.type === 'expire' && e.ref === m.id && /older than 1 day removed/.test(e.detail)));
      await R.stop();
      R = await relay(env(), procs);
      assert.equal((await audit()).verified, true);
    });

    test('a longer period, or none, never brings back a message the old one hid', async () => {
      assert.equal((await policy()).keepDays, 1);
      const m = (await call(R.base, 'POST', '/api/messages', { token: alice.token, body: { text: 'hidden for good' } })).message;
      await age([m.id], 2); // past 1 day, with a cut by time this hour already: hidden, not cut yet
      assert.equal((await call(R.base, 'GET', `/api/messages/${m.id}`, { admin: ADMIN })).status, 404, 'hidden');
      assert.ok(!(await audit()).events.some((e) => e.type === 'expire' && e.ref === m.id), 'not cut yet');
      assert.equal((await call(R.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { keepDays: 30 } })).status, 200);
      assert.equal((await call(R.base, 'GET', `/api/messages/${m.id}`, { admin: ADMIN })).status, 404, 'it stays gone');
      assert.ok(!(await held()).some((x) => x.id === m.id));
      assert.ok((await audit()).events.some((e) => e.type === 'expire' && e.ref === m.id && /older than 1 day removed/.test(e.detail)), 'cut by the old period, in the same commit');
      await R.stop();
      R = await relay(env(), procs);
      assert.equal((await call(R.base, 'GET', `/api/messages/${m.id}`, { admin: ADMIN })).status, 404);
      assert.equal((await audit()).verified, true);
    });

    test('a cut by count is recorded the same way', async () => {
      assert.equal((await call(R.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { keepDays: 0, retainMessages: 100 } })).status, 200);
      for (let i = 0; i < 125; i++) assert.equal((await call(R.base, 'POST', '/api/messages', { token: alice.token, body: { text: `count ${i}` } })).status, 200);
      const au = await audit();
      const cut = au.events.filter((e) => e.type === 'expire').at(-1);
      assert.match(cut.detail, /^\d+ messages past the newest 100 removed, up to m_/);
      assert.ok((await held()).length <= 100 + 20, 'at most a little past retainMessages');
      assert.equal(au.verified, true);
      // fewer kept: down to exactly that many, at once
      assert.equal((await call(R.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { retainMessages: 100 } })).status, 200);
      assert.equal((await call(R.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { retainMessages: 5000 } })).status, 200);
    });

    test('an upload never sent goes after a day', async () => {
      const up = await fetch(`${R.base}/api/files`, { method: 'POST', headers: { authorization: `Bearer ${alice.token}`, 'x-file-name': 'draft.txt', 'content-type': 'text/plain' }, body: 'DRAFT NEVER SENT' });
      const f = (await up.json()).file;
      const kept = await fetch(`${R.base}/api/files`, { method: 'POST', headers: { authorization: `Bearer ${alice.token}`, 'x-file-name': 'today.txt', 'content-type': 'text/plain' }, body: 'today' });
      const k = (await kept.json()).file;
      await age([], 2, { files: [f.id] });
      // the next request looks for old uploads (at most once a minute here: a new process looks at once)
      await call(R.base, 'GET', '/api/info', { key: KEY });
      assert.ok(await until(async () => (await audit()).events.some((e) => e.type === 'expire' && e.detail === '1 upload never sent removed')));
      assert.equal((await fetch(`${R.base}/api/files/${f.id}`, { headers: { authorization: `Bearer ${alice.token}` } })).status, 404);
      assert.equal((await fetch(`${R.base}/api/files/${k.id}`, { headers: { authorization: `Bearer ${alice.token}` } })).status, 200, 'one from today stays');
      if (kind === 'fs') assert.equal(fs.existsSync(path.join(dir, 'files', f.id)), false);
      else assert.equal(fake.kv.has(`${prefix}file:${f.id}`), false);
      assert.equal((await audit()).verified, true);
    });

    if (kind === 'fs')
      test('a message removed by hand after the last cut is reported', async () => {
        const m = (await call(R.base, 'POST', '/api/messages', { token: alice.token, body: { text: 'removed by hand' } })).message;
        await R.stop();
        const file = path.join(dir, 'messages.jsonl');
        const was = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, was.split('\n').filter((l) => !l || JSON.parse(l).id !== m.id).join('\n'));
        R = await relay(env(), procs);
        assert.equal((await audit()).verified, false, 'no cut removed it');
        await R.stop();
        fs.writeFileSync(file, was);
        R = await relay(env(), procs);
        assert.equal((await audit()).verified, true);
      });

    if (kind === 'redis')
      test('every instance hides and cuts the same; a cold start agrees', async () => {
        const B = await relay(env(), procs);
        const [a, b] = [(await call(R.base, 'GET', '/api/messages?limit=1000', { admin: ADMIN })).messages, (await call(B.base, 'GET', '/api/messages?limit=1000', { admin: ADMIN })).messages];
        assert.deepEqual(b.map((m) => m.id), a.map((m) => m.id));
        assert.deepEqual((await audit(B.base)).head, (await audit()).head);
        assert.equal((await audit(B.base)).verified, true);
        await B.stop();
      });
  });
}

test('an older Sphere, from before keepDays, keeps messages with no time limit', async () => {
  const procs = new Set();
  const dir = fs.mkdtempSync(path.join(tmp, 'older-'));
  const { createHash } = await import('node:crypto');
  const sha = (x) => createHash('sha256').update(x).digest('hex');
  fs.writeFileSync(path.join(dir, 'sphere.json'), JSON.stringify({ sphere: { name: 'Older', keyHash: sha(KEY), adminKeyHash: sha(ADMIN), createdAt: new Date().toISOString() }, policy: { retainMessages: 5000, sealed: false } }), { mode: 0o600 });
  const R = await relay({ SPHERE_STORE: 'fs', SPHERE_DATA: dir }, procs);
  try {
    assert.equal((await call(R.base, 'GET', '/api/info', { key: KEY })).sphere.policy.keepDays, 0);
  } finally {
    await R.stop();
  }
});

// On Redis a cut's messages leave the log at the next compaction, which every cut brings forward:
// one by count, once the snapshot is an hour old, so a busy Sphere doesn't compact at every cut.
test('on Redis, a cut by count brings the compaction forward, at most once an hour', { timeout: 60000 }, async () => {
  const procs = new Set();
  const fake = await startFakeUpstash({ latencyMs: 1 });
  const prefix = 'countcut:';
  const env = { SPHERE_STORE: 'redis', UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, SPHERE_REDIS_PREFIX: prefix, SPHERE_COMPACT_EVERY: '100000', SPHERE_COMPACT_WAIT_MS: '0' };
  // what stays in Redis (an old snapshot list that expires is left for instances still reading it)
  const stored = () => [...fake.kv].filter(([k, e]) => k.startsWith(prefix) && !e.exp).map(([, e]) => (Array.isArray(e.v) ? e.v.join('\n') : String(e.v))).join('\n');
  const snap = () => (fake.kv.get(prefix + 'snap') ? JSON.parse(fake.kv.get(prefix + 'snap').v) : null);
  const R = await relay(env, procs);
  try {
    const alice = await call(R.base, 'POST', '/api/join', { body: { key: KEY, name: 'alice', owner: 'Alice' } });
    assert.equal((await call(R.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { retainMessages: 100 } })).status, 200);
    const texts = new Map();
    const post = async (n, tag) => {
      for (let i = 0; i < n; i++) {
        const r = await call(R.base, 'POST', '/api/messages', { token: alice.token, body: { text: `${tag}-${i}-end` } });
        assert.equal(r.status, 200);
        texts.set(r.message.id, r.message.text);
      }
    };
    const lastCut = async (base) => (await call(base, 'GET', '/api/audit?limit=1000', { key: KEY })).events.filter((e) => e.type === 'expire').at(-1);
    // past the newest 100 by 20: a cut, and with no snapshot yet, the compaction it brings forward
    await post(125, 'PIPIT');
    assert.match((await lastCut(R.base)).detail, /past the newest 100 removed/);
    assert.ok(await until(async () => (await call(R.base, 'GET', '/api/info', { key: KEY }), !!snap() && !stored().includes('PIPIT-0-end'))), 'compacted: the cut messages left the log');
    assert.ok(stored().includes('PIPIT-124-end'), 'the newest stay');
    const first = snap().id;
    // within the hour: the next cut waits (its messages hidden, still in the snapshot until then)
    await post(25, 'WREN');
    const cut = await lastCut(R.base);
    const gone = texts.get(cut.ref);
    assert.ok(gone, 'a message the second cut removed');
    assert.equal((await call(R.base, 'GET', `/api/messages/${cut.ref}`, { admin: ADMIN })).status, 404);
    for (let i = 0; i < 5; i++) await call(R.base, 'GET', '/api/info', { key: KEY });
    await sleep(300); // a compaction would run in the background now: none does
    assert.equal(snap().id, first, 'not compacted again within the hour');
    assert.ok(stored().includes(gone), 'its words wait for the next compaction');
    // an hour on (the snapshot's time moved back): the next instance to look compacts, and they leave
    const e = fake.kv.get(prefix + 'snap');
    e.v = JSON.stringify({ ...JSON.parse(e.v), at: new Date(Date.now() - 2 * 3600e3).toISOString() });
    const B = await relay(env, procs);
    assert.ok(await until(async () => (await call(B.base, 'GET', '/api/info', { key: KEY }), snap().id !== first)), 'compacted again');
    assert.ok(!stored().includes(gone), 'gone from the log');
    assert.equal((await call(B.base, 'GET', '/api/audit?limit=1000', { key: KEY })).verified, true);
    await B.stop();
  } finally {
    await R.stop();
    await fake.close();
  }
});
