// Deleting your own messages (#139), on both stores, sealed and not: a post, an ask and your
// Oby's reply become tombstones everywhere, their words and files leave storage at once (the
// data folder, the fake Redis, a compaction snapshot), nobody else may delete them (another
// member, a viewer, an admin), a reply to a deleted ask is refused, those who got the message
// hear message-delete, and the audit chain verifies after a restart and a cold start, while a
// tombstone or a delete event that doesn't match its message breaks it. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startFakeUpstash } from './fake-upstash.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SERVER = path.join(ROOT, 'server.mjs');
const KEY = 'join-key-delete-0123456789abcdef';
const ADMIN = 'admin-key-delete-0123456789abcdef';
const TOMBSTONE = ['id', 'ts', 'channel', 'from', 'kind', 'to', 'replyTo', 'cause', 'depth', 'claimedAt', 'startedAt', 'deleted'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (x) => createHash('sha256').update(x).digest('hex');
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
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-delete-')));
  fs.mkdirSync(path.join(tmp, 'home'));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const baseEnv = () => ({
  ...process.env,
  HOME: path.join(tmp, 'home'),
  TMPDIR: tmp,
  OBYSPHERE_HOME: path.join(tmp, 'reps'),
  OBYSPHERE_APP_HOME: path.join(tmp, 'app'),
  OBYSPHERE_NOTIFY_LOG: path.join(tmp, 'notify.log'),
  OBYSPHERE_NO_UPDATE_CHECK: '1',
  SPHERE_KEY: KEY,
  SPHERE_ADMIN_KEY: ADMIN,
  SPHERE_POLL_MS: '150',
  SPHERE_WRITES_PER_MIN: '100000',
  SPHERE_ASKS_PER_MIN: '100000',
});

// a relay process: { base, stop }
async function relay(env, procs) {
  const port = await freePort();
  const p = spawn(process.execPath, [SERVER, '--port', String(port), '--host', '127.0.0.1'], { env: { ...baseEnv(), ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
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
          errs: () => errs,
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

// the live events one stream gets, as [event, data]; `ready` once the relay holds the stream
// (it answers with the stream's headers only after adding it)
function listen(base, headers) {
  const got = [];
  const ac = new AbortController();
  const open = fetch(base + '/api/stream', { headers, signal: ac.signal });
  open
    .then(async (r) => {
      const dec = new TextDecoder();
      let buf = '';
      for await (const c of r.body) {
        buf += dec.decode(c, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (\S+)/m.exec(block)?.[1];
          const data = block.split('\n').find((l) => l.startsWith('data: '));
          if (ev && data) got.push([ev, JSON.parse(data.slice(6))]);
        }
      }
    })
    .catch(() => {});
  return { got, ready: open.then((r) => assert.equal(r.status, 200)), close: () => ac.abort() };
}

// a rep.mjs command to its end (async: the fake Upstash lives in this process)
const rep = (args, env = {}) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), ...args], { env: { ...baseEnv(), ...env } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => p.kill(), 30000);
    p.on('close', () => {
      clearTimeout(t);
      resolve(out);
    });
  });

for (const kind of ['fs', 'redis']) {
  describe(`deleting your own messages on the ${kind} store`, () => {
    const procs = new Set();
    let fake, R, dir, prefix;
    const ag = {};
    const tok = (n) => ag[n].token;
    const env = () => (kind === 'fs' ? { SPHERE_STORE: 'fs', SPHERE_DATA: dir, SPHERE_SEALED: '0' } : { SPHERE_STORE: 'redis', UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, SPHERE_REDIS_PREFIX: prefix, SPHERE_SEALED: '0', SPHERE_COMPACT_EVERY: '60', SPHERE_COMPACT_WAIT_MS: '0' });
    // everything the relay keeps, as text: its data folder, or every live value in Redis (an old
    // snapshot list that expires is left for instances still reading it, and named apart)
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
        return { kept: all, expiring: '' };
      }
      const text = (e) => (Array.isArray(e.v) ? e.v.join('\n') : e.v instanceof Map ? [...e.v.keys()].join('\n') : Buffer.from(String(e.v), 'base64').toString('latin1') + String(e.v));
      let kept = '';
      let expiring = '';
      for (const [k, e] of fake.kv) if (k.startsWith(prefix)) (e.exp ? (expiring += text(e)) : (kept += text(e)));
      return { kept, expiring };
    };
    const chain = async (base = R.base) => (await call(base, 'GET', '/api/audit?limit=1000', { key: KEY })).verified;

    before(async () => {
      dir = fs.mkdtempSync(path.join(tmp, `data-${kind}-`));
      prefix = `del-${kind}:`;
      if (kind === 'redis') fake = await startFakeUpstash({ latencyMs: 2 });
      R = await relay(env(), procs);
      for (const n of ['alice', 'bob', 'carol']) {
        ag[n] = await call(R.base, 'POST', '/api/join', { body: { key: KEY, name: n, owner: `${n[0].toUpperCase()}${n.slice(1)} Test` } });
        assert.ok(ag[n].token, JSON.stringify(ag[n]));
      }
      // bob is an admin member
      assert.equal((await call(R.base, 'POST', '/api/admin/claim', { token: tok('bob'), admin: ADMIN })).status, 200);
    });
    after(async () => {
      for (const p of procs) p.kill();
      await fake?.close();
    });

    test('alice deletes her post: a tombstone everywhere, its file gone, its words nowhere in storage', async () => {
      const viewer = listen(R.base, { 'x-sphere-key': KEY });
      const bobRep = listen(R.base, { authorization: `Bearer ${tok('bob')}` });
      await Promise.all([viewer.ready, bobRep.ready]);
      const words = `Wrong channel: the WALRUS-${kind}-81 plan`;
      const fileWords = `WALRUS-FILE-${kind}-82 inside`;
      const posted = await call(R.base, 'POST', '/api/messages', { token: tok('alice'), body: { text: words, files: [{ name: 'walrus.txt', data: Buffer.from(fileWords).toString('base64') }] } });
      assert.equal(posted.status, 200, JSON.stringify(posted));
      const m = posted.message;
      const fid = m.files[0].id;
      assert.equal((await fetch(`${R.base}/api/files/${fid}`, { headers: { 'x-sphere-key': KEY } })).status, 200);
      assert.ok(stored().kept.includes(`WALRUS-${kind}-81`), 'the words are stored before');

      const r = await call(R.base, 'DELETE', `/api/messages/${m.id}`, { token: tok('alice') });
      assert.equal(r.status, 200, JSON.stringify(r));
      const t = r.message;
      assert.deepEqual(Object.keys(t).filter((k) => !TOMBSTONE.includes(k)), [], 'nothing but the tombstone fields');
      assert.equal(t.id, m.id);
      assert.equal(t.kind, 'post');
      assert.equal(t.from, ag.alice.agent.id);
      assert.equal(t.channel, 'general');
      assert.equal(t.deleted.by, ag.alice.agent.id);
      assert.ok(Date.parse(t.deleted.at) >= Date.parse(m.ts));
      for (const k of ['text', 'files', 'meta', 'sealed']) assert.equal(k in t, false, `no ${k}`);
      // deleting again gives the same tombstone
      assert.deepEqual((await call(R.base, 'DELETE', `/api/messages/${m.id}`, { token: tok('alice') })).message, t);

      // everywhere: by id, in the list, for every viewer; its file is gone
      assert.deepEqual((await call(R.base, 'GET', `/api/messages/${m.id}`, { key: KEY })).message, t);
      assert.deepEqual((await call(R.base, 'GET', '/api/messages?limit=1000', { token: tok('carol') })).messages.find((x) => x.id === m.id), t);
      assert.equal((await fetch(`${R.base}/api/files/${fid}`, { headers: { 'x-sphere-key': KEY } })).status, 404);
      assert.equal((await fetch(`${R.base}/api/files/${fid}`, { headers: { 'x-admin-key': ADMIN } })).status, 404);
      assert.ok(!(await call(R.base, 'GET', '/api/files', { admin: ADMIN })).files.some((f) => f.id === fid));
      const reuse = await call(R.base, 'POST', '/api/messages', { token: tok('alice'), body: { text: 'again', files: [{ id: fid }] } });
      assert.equal(reuse.status, 404, "a deleted message's file can't be sent again");

      // the words, the file and its bytes, nowhere in storage: at once, as the deletion answered
      const s = stored();
      for (const w of [`WALRUS-${kind}-81`, `WALRUS-FILE-${kind}-82`, Buffer.from(fileWords).toString('base64')]) assert.ok(!s.kept.includes(w), `${w} left storage`);
      if (kind === 'fs') assert.equal(fs.existsSync(path.join(dir, 'files', fid)), false);
      else assert.equal(fake.kv.has(`${prefix}file:${fid}`), false);

      // the audit log: a delete event with the post's own content hash, and the chain verifies
      const au = await call(R.base, 'GET', '/api/audit?limit=1000', { key: KEY });
      const own = au.events.find((e) => e.type === 'post' && e.ref === m.id);
      const del = au.events.find((e) => e.type === 'delete' && e.ref === m.id);
      assert.ok(own && del, 'both events');
      assert.equal(del.content, own.content);
      assert.equal(del.actor, ag.alice.agent.id);
      assert.match(del.detail, /^alice deleted a post · #general · \d+(\.\d)? (B|KB) · 1 file$/);
      assert.equal(au.events.filter((e) => e.type === 'delete' && e.ref === m.id).length, 1, 'deleting again added nothing');
      assert.equal(au.verified, true);

      // those who got the message heard of it: the viewer did; bob's representative didn't get the post
      assert.ok(await until(() => viewer.got.some(([e, d]) => e === 'message-delete' && d.id === m.id)));
      const ev = viewer.got.find(([e, d]) => e === 'message-delete' && d.id === m.id)[1];
      assert.deepEqual(ev, { id: m.id, channel: 'general', deleted: t.deleted });
      assert.ok(!bobRep.got.some(([e, d]) => e === 'message-delete' && d.id === m.id), "a representative hears only of messages it's part of");
      viewer.close();
      bobRep.close();
    });

    test('alice deletes her ask and her Oby’s reply; bob can’t claim or answer a deleted ask', async () => {
      const bobRep = listen(R.base, { authorization: `Bearer ${tok('bob')}` });
      await bobRep.ready;
      const ask = (await call(R.base, 'POST', '/api/messages', { token: tok('alice'), body: { text: `Are you free? OTTER-${kind}-91`, to: ['bob'] } })).message;
      const ask2 = (await call(R.base, 'POST', '/api/messages', { token: tok('alice'), body: { text: `Claimed already. OTTER-${kind}-92`, to: ['bob'] } })).message;
      assert.equal((await call(R.base, 'POST', `/api/messages/${ask2.id}/claim`, { token: tok('bob'), body: { instance: 'b1' } })).ok, true);
      assert.equal((await call(R.base, 'POST', '/api/status', { token: tok('bob'), body: { state: 'working', about: ask2.id } })).status, 200);
      // bob asks alice, and alice's Oby answers
      const theirs = (await call(R.base, 'POST', '/api/messages', { token: tok('bob'), body: { text: 'What is the plan?', to: ['alice'] } })).message;
      const reply = (await call(R.base, 'POST', '/api/messages', { token: tok('alice'), body: { text: `The plan is OTTER-${kind}-93`, replyTo: theirs.id, meta: { model: 'fake', durationMs: 900 } } })).message;
      const before = (await call(R.base, 'GET', '/api/agents', { key: KEY })).agents.find((a) => a.name === 'alice').stats;

      for (const id of [ask.id, ask2.id, reply.id]) assert.equal((await call(R.base, 'DELETE', `/api/messages/${id}`, { token: tok('alice') })).status, 200);
      const t2 = (await call(R.base, 'GET', `/api/messages/${ask2.id}`, { key: KEY })).message;
      assert.equal(t2.kind, 'ask');
      assert.deepEqual(t2.to, [ag.bob.agent.id]);
      assert.ok(t2.claimedAt && t2.startedAt, 'its place in time stays');
      const tr = (await call(R.base, 'GET', `/api/messages/${theirs.id}`, { key: KEY })).replies.find((x) => x.id === reply.id);
      assert.equal(tr.replyTo, theirs.id);
      assert.ok(tr.deleted && !('text' in tr) && !('meta' in tr));
      // bob's representative got the asks, so it hears they're gone
      assert.ok(await until(() => [ask.id, ask2.id].every((id) => bobRep.got.some(([e, d]) => e === 'message-delete' && d.id === id))));
      bobRep.close();

      const claim = await call(R.base, 'POST', `/api/messages/${ask.id}/claim`, { token: tok('bob'), body: { instance: 'b1' } });
      assert.equal(claim.status, 404);
      const answer = await call(R.base, 'POST', '/api/messages', { token: tok('bob'), body: { text: 'yes', replyTo: ask.id } });
      assert.equal(answer.status, 410);
      assert.equal(answer.code, 'gone');
      const hop = await call(R.base, 'POST', '/api/messages', { token: tok('bob'), body: { text: 'carol, any idea?', to: ['carol'], cause: ask2.id } });
      assert.equal(hop.status, 410, 'nor passed on');
      assert.equal((await call(R.base, 'POST', `/api/messages/${ask.id}/waiting`, { token: tok('bob'), body: { for: 'owner', until: new Date(Date.now() + 3600e3).toISOString() } })).status, 404);

      // a deleted reply no longer counts as an answer; the ask it answered still counts
      const now = (await call(R.base, 'GET', '/api/agents', { key: KEY })).agents.find((a) => a.name === 'alice').stats;
      assert.equal(now.answered, before.answered - 1);
      assert.equal(now.asksIn, before.asksIn);
      const s = stored().kept;
      for (const n of [91, 92, 93]) assert.ok(!s.includes(`OTTER-${kind}-${n}`), `OTTER-${kind}-${n} left storage`);
      assert.equal(await chain(), true);
    });

    test("bob, a viewer and an admin can't delete alice's message", async () => {
      const m = (await call(R.base, 'POST', '/api/messages', { token: tok('alice'), body: { text: `Mine to keep, BADGER-${kind}` } })).message;
      const bob = await call(R.base, 'DELETE', `/api/messages/${m.id}`, { token: tok('bob') }); // bob is an admin member
      assert.equal(bob.status, 403);
      assert.equal(bob.code, 'forbidden');
      assert.equal((await call(R.base, 'DELETE', `/api/messages/${m.id}`, { token: tok('carol') })).status, 403);
      assert.equal((await call(R.base, 'DELETE', `/api/messages/${m.id}`, { key: KEY })).status, 403, 'a viewer only watches');
      assert.equal((await call(R.base, 'DELETE', `/api/messages/${m.id}`, { admin: ADMIN })).status, 403, 'the admin key deletes nothing');
      assert.equal((await call(R.base, 'DELETE', `/api/messages/${m.id}`, { admin: ADMIN, token: tok('bob') })).status, 403);
      // a system message is nobody's; a message you can't see is not found
      const sys = (await call(R.base, 'GET', '/api/messages?limit=1000', { key: KEY })).messages.find((x) => x.kind === 'system');
      assert.equal((await call(R.base, 'DELETE', `/api/messages/${sys.id}`, { token: tok('alice') })).status, 403);
      assert.equal((await call(R.base, 'DELETE', '/api/messages/m_nosuchmessage', { token: tok('alice') })).status, 404);
      await call(R.base, 'POST', '/api/channels', { token: tok('bob'), body: { name: `quiet-${kind}`, private: true } });
      const hidden = (await call(R.base, 'POST', '/api/messages', { token: tok('bob'), body: { text: 'just me', channel: `quiet-${kind}` } })).message;
      assert.equal((await call(R.base, 'DELETE', `/api/messages/${hidden.id}`, { token: tok('alice') })).status, 404);
      // it's all still there, and the refusals are in the audit log
      assert.equal((await call(R.base, 'GET', `/api/messages/${m.id}`, { key: KEY })).message.text, `Mine to keep, BADGER-${kind}`);
      const au = await call(R.base, 'GET', '/api/audit?limit=1000', { key: KEY });
      assert.ok(au.events.some((e) => e.type === 'deny' && e.actor === ag.bob.agent.id && /not its own/.test(e.detail)));
      assert.equal(au.verified, true);
    });

    test('the storage its files used comes back', async () => {
      const file = (n) => ({ name: `big-${n}.bin`, data: Buffer.alloc(700 * 1024, n).toString('base64') });
      assert.equal((await call(R.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { maxAgentBytes: 1024 * 1024, maxFileBytes: 1024 * 1024 } })).status, 200);
      const carol = tok('carol');
      const first = await call(R.base, 'POST', '/api/messages', { token: carol, body: { text: 'a big file', files: [file(1)] } });
      assert.equal(first.status, 200, JSON.stringify(first));
      assert.equal((await call(R.base, 'POST', '/api/messages', { token: carol, body: { text: 'another', files: [file(2)] } })).status, 413, 'past her storage');
      assert.equal((await call(R.base, 'DELETE', `/api/messages/${first.message.id}`, { token: carol })).status, 200);
      assert.equal((await call(R.base, 'POST', '/api/messages', { token: carol, body: { text: 'another', files: [file(3)] } })).status, 200, 'room again');
      assert.equal((await call(R.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { maxAgentBytes: kind === 'fs' ? 200 * 1024 * 1024 : 10 * 1024 * 1024, maxFileBytes: kind === 'fs' ? 5 * 1024 * 1024 : 512 * 1024 } })).status, 200);
    });

    test('a delete works while the relay is paused, and not while suspended', async () => {
      const m = (await call(R.base, 'POST', '/api/messages', { token: tok('alice'), body: { text: 'posted before the pause' } })).message;
      const c = (await call(R.base, 'POST', '/api/messages', { token: tok('carol'), body: { text: 'carol, before her suspension' } })).message;
      assert.equal((await call(R.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { paused: true } })).status, 200);
      assert.equal((await call(R.base, 'DELETE', `/api/messages/${m.id}`, { token: tok('alice') })).status, 200, 'it adds nothing');
      assert.equal((await call(R.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { paused: false } })).status, 200);
      assert.equal((await call(R.base, 'POST', `/api/admin/agents/${ag.carol.agent.id}/suspend`, { admin: ADMIN, body: { suspended: true } })).status, 200);
      assert.equal((await call(R.base, 'DELETE', `/api/messages/${c.id}`, { token: tok('carol') })).code, 'suspended');
      assert.equal((await call(R.base, 'POST', `/api/admin/agents/${ag.carol.agent.id}/suspend`, { admin: ADMIN, body: { suspended: false } })).status, 200);
    });

    test('the chain verifies after a restart, or a cold start, with the same tombstones', async () => {
      const all = (await call(R.base, 'GET', '/api/messages?limit=1000', { admin: ADMIN })).messages;
      const stats = (await call(R.base, 'GET', '/api/stats', { key: KEY })).counts;
      const agents = (await call(R.base, 'GET', '/api/agents', { key: KEY })).agents.map((a) => [a.name, a.stats]);
      if (kind === 'fs') {
        await R.stop();
        R = await relay(env(), procs);
      } else {
        const C = await relay(env(), procs); // a cold start beside the first
        await R.stop();
        R = C;
      }
      assert.equal(await chain(), true);
      assert.deepEqual((await call(R.base, 'GET', '/api/messages?limit=1000', { admin: ADMIN })).messages, all);
      const { online, working, ...now } = (await call(R.base, 'GET', '/api/stats', { key: KEY })).counts;
      const { online: o2, working: w2, ...was } = stats;
      assert.deepEqual(now, was, 'the same counts');
      assert.deepEqual((await call(R.base, 'GET', '/api/agents', { key: KEY })).agents.map((a) => [a.name, a.stats]), agents);
    });

    if (kind === 'redis')
      test('a copy already folded into a compaction snapshot leaves at a compaction the deletion brings forward', async () => {
        const m = (await call(R.base, 'POST', '/api/messages', { token: tok('alice'), body: { text: 'Snapshot me: HERON-77' } })).message;
        // enough writes for a compaction: the message is in the snapshot now
        for (let i = 0; i < 70; i++) assert.equal((await call(R.base, 'POST', '/api/messages', { token: tok('bob'), body: { text: `filler ${i}` } })).status, 200);
        const snapHas = () => {
          const ptr = fake.kv.get(prefix + 'snap')?.v;
          return !!ptr && fake.kv.get(prefix + 'snap:' + JSON.parse(ptr).id).v.join('\n').includes('HERON-77');
        };
        assert.ok(await until(async () => (await call(R.base, 'GET', '/api/info', { key: KEY }), snapHas())), 'the words are in the snapshot');
        const was = JSON.parse(fake.kv.get(prefix + 'snap').v).id;
        assert.equal((await call(R.base, 'DELETE', `/api/messages/${m.id}`, { token: tok('alice') })).status, 200);
        // a new snapshot, at once, without the words; the old one expires. A compaction already under
        // way when the deletion came may swap in a snapshot that read the words before they were
        // overwritten: the relay folds again as soon as it may (watchFolds), so wait for that one
        assert.ok(await until(async () => (await call(R.base, 'GET', '/api/info', { key: KEY }), JSON.parse(fake.kv.get(prefix + 'snap').v).id !== was)), 'compacted again');
        assert.ok(await until(async () => (await call(R.base, 'GET', '/api/info', { key: KEY }), !snapHas())), 'a snapshot without the words');
        const s = stored();
        assert.ok(!s.kept.includes('HERON-77'), 'nowhere that stays');
        assert.ok(fake.kv.get(prefix + 'snap:' + was).exp > 0 && fake.kv.get(prefix + 'snap:' + was).exp - Date.now() <= 900e3, 'the old snapshot goes within 15 minutes');
        // and a cold start from it holds the tombstone
        const C = await relay(env(), procs);
        assert.ok((await call(C.base, 'GET', `/api/messages/${m.id}`, { key: KEY })).message.deleted);
        assert.equal(await chain(C.base), true);
        await C.stop();
      });

    if (kind === 'fs')
      test("a tombstone without its delete event, or a delete event whose message holds its words, breaks the chain", async () => {
        const m = (await call(R.base, 'POST', '/api/messages', { token: tok('alice'), body: { text: 'about to be forged away' } })).message;
        const k = (await call(R.base, 'POST', '/api/messages', { token: tok('alice'), body: { text: 'about to come back' } })).message;
        assert.equal((await call(R.base, 'DELETE', `/api/messages/${k.id}`, { token: tok('alice') })).status, 200);
        await R.stop();
        const file = path.join(dir, 'messages.jsonl');
        const keep = fs.readFileSync(file, 'utf8');
        // the relay's disk changed by hand: m becomes a tombstone with no delete event
        const lines = keep.split('\n').map((l) => {
          if (!l) return l;
          const o = JSON.parse(l);
          if (o.id !== m.id) return l;
          const t = Object.fromEntries(Object.entries(o).filter(([key]) => TOMBSTONE.includes(key)));
          return JSON.stringify({ ...t, deleted: { at: new Date().toISOString(), by: o.from } });
        });
        fs.writeFileSync(file, lines.join('\n'));
        R = await relay(env(), procs);
        assert.equal(await chain(), false, 'a tombstone with no delete event');
        await R.stop();
        // k's words back where its tombstone was: its delete event no longer holds
        fs.writeFileSync(file, keep.split('\n').map((l) => (l && JSON.parse(l).id === k.id ? JSON.stringify({ ...k, to: [], files: [], meta: {}, depth: 0 }) : l)).join('\n'));
        R = await relay(env(), procs);
        assert.equal(await chain(), false, 'a delete event whose message still holds its words');
        await R.stop();
        fs.writeFileSync(file, keep);
        R = await relay(env(), procs);
        assert.equal(await chain(), true, 'and as it was, it verifies');
      });
  });
}

// ---------------------------------------------------------------- sealed: deleted unopened

for (const kind of ['fs', 'redis']) {
  test(`a sealed post and ask are deleted unopened, their envelopes gone from storage (${kind})`, { timeout: 90000 }, async () => {
    const procs = new Set();
    const dir = fs.mkdtempSync(path.join(tmp, `sealed-${kind}-`));
    const home = fs.mkdtempSync(path.join(tmp, `reps-${kind}-`));
    const fake = kind === 'redis' ? await startFakeUpstash() : null;
    const env = kind === 'fs' ? { SPHERE_STORE: 'fs', SPHERE_DATA: dir, SPHERE_SEALED: '1' } : { SPHERE_STORE: 'redis', UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, SPHERE_REDIS_PREFIX: 'sealdel:', SPHERE_SEALED: '1' };
    const R = await relay(env, procs);
    try {
      const cwd = fs.mkdtempSync(path.join(tmp, 'work-'));
      for (const n of ['alice', 'bob']) assert.match(await rep(['join', `${R.base}/#key=${KEY}`, '--name', n, '--owner', `${n} Test`, '--cwd', cwd], { OBYSPHERE_HOME: home }), /joined/);
      const token = (n) => JSON.parse(fs.readFileSync(path.join(home, n, 'profile.json'), 'utf8')).token;
      const f = path.join(tmp, `sealed-${kind}.txt`);
      fs.writeFileSync(f, 'SEALED FILE WORDS');
      assert.match(await rep(['post', 'A sealed post, PUFFIN-1', '--file', f, '--profile', 'alice'], { OBYSPHERE_HOME: home }), /Posted/);
      await rep(['ask', 'bob', 'A sealed ask, PUFFIN-2', '--profile', 'alice', '--wait', '1'], { OBYSPHERE_HOME: home });
      const list = (await call(R.base, 'GET', '/api/messages?limit=100', { key: KEY })).messages.filter((m) => m.sealed);
      assert.equal(list.length, 2);
      const text = () => (kind === 'fs' ? (() => { let all = ''; const walk = (d) => { for (const x of fs.readdirSync(d)) { const p = path.join(d, x); if (fs.statSync(p).isDirectory()) walk(p); else all += fs.readFileSync(p).toString('latin1'); } }; walk(dir); return all; })() : [...fake.kv.values()].map((e) => (Array.isArray(e.v) ? e.v.join('\n') : String(e.v))).join('\n'));
      for (const m of list) assert.ok(text().includes(m.sealed.ct), 'the envelope is stored before');
      const fileId = list.find((m) => m.files.length).files[0].id;
      for (const m of list) {
        const r = await call(R.base, 'DELETE', `/api/messages/${m.id}`, { token: token('alice') });
        assert.equal(r.status, 200);
        assert.equal('sealed' in r.message, false, 'nothing that was inside');
      }
      for (const m of list) assert.ok(!text().includes(m.sealed.ct), 'the envelope left storage');
      assert.equal((await fetch(`${R.base}/api/files/${fileId}`, { headers: { 'x-sphere-key': KEY } })).status, 404);
      const au = await call(R.base, 'GET', '/api/audit?limit=1000', { key: KEY });
      assert.ok(au.events.some((e) => e.type === 'delete' && / sealed · 1 file$/.test(e.detail)), 'the size, and that it was sealed');
      assert.equal(au.verified, true);
      // bob's read shows that it's gone, no words
      const read = await rep(['read', '--profile', 'bob'], { OBYSPHERE_HOME: home });
      assert.ok(!read.includes('PUFFIN'), read);
      assert.match(read, /alice: \(deleted\)/);
    } finally {
      await R.stop();
      await fake?.close();
    }
  });
}

test('obysphere delete <message id>: your own message, by the id read shows; nothing else on the command line', { timeout: 60000 }, async () => {
  const procs = new Set();
  const dir = fs.mkdtempSync(path.join(tmp, 'cli-'));
  const home = fs.mkdtempSync(path.join(tmp, 'reps-cli-'));
  const R = await relay({ SPHERE_STORE: 'fs', SPHERE_DATA: dir, SPHERE_SEALED: '0' }, procs);
  try {
    const cwd = fs.mkdtempSync(path.join(tmp, 'work-'));
    for (const n of ['alice', 'bob']) assert.match(await rep(['join', `${R.base}/#key=${KEY}`, '--name', n, '--owner', `${n} Test`, '--cwd', cwd], { OBYSPHERE_HOME: home }), /joined/);
    await rep(['post', 'Delete me from the terminal', '--profile', 'alice'], { OBYSPHERE_HOME: home });
    await rep(['post', "Bob's, not yours", '--profile', 'bob'], { OBYSPHERE_HOME: home });
    const read = await rep(['read', '--profile', 'alice'], { OBYSPHERE_HOME: home });
    const id = /(m_[\w-]+) alice: Delete me from the terminal/.exec(read)?.[1];
    const bobs = /(m_[\w-]+) bob: Bob's, not yours/.exec(read)?.[1];
    assert.ok(id && bobs, read);
    const out = await rep(['delete', id, '--profile', 'alice'], { OBYSPHERE_HOME: home });
    assert.match(out, /Deleted/, out);
    assert.ok((await call(R.base, 'GET', `/api/messages/${id}`, { key: KEY })).message.deleted);
    assert.match(await rep(['delete', bobs, '--profile', 'alice'], { OBYSPHERE_HOME: home }), /only delete your own/i);
    assert.match(await rep(['delete', 'not-an-id', '--profile', 'alice'], { OBYSPHERE_HOME: home }), /usage|looks like m_/i);
    assert.match(await rep(['read', '--profile', 'alice'], { OBYSPHERE_HOME: home }), new RegExp(`${id} alice: \\(deleted\\)`));
  } finally {
    await R.stop();
  }
});
