// Conversations: channels with members (public and private), direct messages between two Obys,
// and bots, on both stores. Who may make, join, leave and change a channel; who may post and ask
// in one; that reads, files and live events are filtered for members, non-members, viewers and
// admins; that sealed messages in a private channel are sealed for its members only (and the
// relay refuses other readers); and that channels survive a restart. No Claude needed. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { startFakeUpstash } from './fake-upstash.mjs';
import { consoleAuth } from './console-auth-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const KEY = 'join-key-conversations-0123456789';
const ADMIN = 'admin-key-conversations-0123456789';
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const dmName = (a, b) => 'dm-' + sha([a, b].sort().join('|')).slice(0, 24);
// a process stopped and gone (a relay saves its state on the way out), so its folder can be removed
const stop = (p, signal) => new Promise((resolve) => {
  if (!p || p.exitCode !== null || p.signalCode !== null) return resolve();
  const t = setTimeout(resolve, 3000);
  p.once('exit', () => { clearTimeout(t); resolve(); });
  p.kill(signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM');
});
const rmDir = (d) => d && fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

async function startRelay({ store = 'fs', dir, sealed = false, env = {} } = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const args = [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1'];
  if (dir) args.push('--data', dir);
  const p = spawn(process.execPath, args, {
    env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_SEALED: sealed ? '1' : '0', SPHERE_STORE: store, SPHERE_POLL_MS: '150', SPHERE_WRITES_PER_MIN: '100000', SPHERE_ASKS_PER_MIN: '100000', ...env },
    stdio: process.env.SPHERE_TEST_DEBUG ? 'inherit' : 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + '/healthz')).ok) return { p, base }; } catch {}
    await sleep(100);
  }
  p.kill();
  throw new Error('the relay did not start');
}

function caller(getBase) {
  return async (method, url, { tok, key, admin, body } = {}) => {
    const headers = {};
    if (tok) headers.authorization = `Bearer ${tok}`;
    if (key) headers['x-sphere-key'] = key;
    if (admin) headers['x-admin-key'] = admin;
    if (body) headers['content-type'] = 'application/json';
    const r = await fetch(getBase() + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
}

// an open event stream, collecting its events
function openStream(base, { tok, key, admin, role } = {}) {
  const ac = new AbortController();
  const events = [];
  const headers = {};
  if (tok) headers.authorization = `Bearer ${tok}`;
  if (key) headers['x-sphere-key'] = key;
  if (admin) headers['x-admin-key'] = admin;
  fetch(`${base}/api/stream${role ? `?role=${role}` : ''}`, { headers, signal: ac.signal })
    .then(async (r) => {
      const dec = new TextDecoder();
      let buf = '';
      for await (const c of r.body) {
        buf += dec.decode(c, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (\S+)/.exec(block)?.[1];
          const data = block.split('\n').find((l) => l.startsWith('data: '));
          if (ev && data) events.push({ ev, data: JSON.parse(data.slice(6)) });
        }
      }
    })
    .catch(() => {});
  return { events, close: () => ac.abort() };
}

async function until(fn, ms = 4000) {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t > ms) return v;
    await sleep(100);
  }
}

// ---------------------------------------------------------------- the relay's rules (fs store, not sealed)

describe('channels, members and direct messages', () => {
  let relay, dir;
  let base;
  const call = caller(() => base);
  const ag = {}; // handle -> { token, agent }
  const tok = (n) => ag[n].token;
  const id = (n) => ag[n].agent.id;
  let dm; // alice and bob's direct conversation

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-conv-'));
    relay = await startRelay({ dir });
    base = relay.base;
    for (const n of ['alice', 'bob', 'carol']) ag[n] = await call('POST', '/api/join', { body: { key: KEY, name: n, owner: `${n[0].toUpperCase()}${n.slice(1)}` } });
    ag.reviewer = await call('POST', '/api/join', { body: { key: KEY, name: 'reviewer', owner: 'Platform team', bot: true } });
  });
  after(async () => {
    await stop(relay?.p);
    rmDir(dir);
  });

  test('a bot is marked as one; #general is public', async () => {
    assert.equal(ag.reviewer.agent.bot, true);
    assert.equal(ag.alice.agent.bot, false);
    const { agents } = await call('GET', '/api/agents', { key: KEY });
    assert.equal(agents.find((a) => a.name === 'reviewer').bot, true);
    const { channels } = await call('GET', '/api/channels', { key: KEY });
    assert.deepEqual(channels.map((c) => [c.name, c.kind]), [['general', 'public']]);
    assert.deepEqual(channels[0].members, []);
  });

  test('making channels: private or public, the creator in it, names taken once', async () => {
    const d = await call('POST', '/api/channels', { tok: tok('alice'), body: { name: 'Design', topic: 'Pixels and type', private: true, members: ['bob'] } });
    assert.equal(d.status, 200, JSON.stringify(d));
    assert.deepEqual([d.channel.name, d.channel.kind, d.channel.topic, d.channel.createdBy], ['design', 'private', 'Pixels and type', id('alice')]);
    assert.deepEqual(d.channel.members, [id('alice'), id('bob')]);
    assert.equal((await call('POST', '/api/channels', { tok: tok('bob'), body: { name: 'design' } })).status, 409);
    assert.equal((await call('POST', '/api/channels', { tok: tok('bob'), body: { name: 'dm-mine' } })).status, 400, 'dm- is kept for direct conversations');
    assert.equal((await call('POST', '/api/channels', { tok: tok('bob'), body: { name: 'x', members: ['nobody'] } })).status, 404);
    assert.equal((await call('POST', '/api/channels', { key: KEY, body: { name: 'watchers' } })).status, 403, 'viewers can only watch');
    const l = await call('POST', '/api/channels', { tok: tok('bob'), body: { name: 'lobby' } });
    assert.deepEqual([l.channel.kind, l.channel.members, l.channel.createdBy], ['public', [id('bob')], id('bob')]);
    // the channel's first line says who made it
    const { messages } = await call('GET', '/api/messages?channel=design', { tok: tok('bob') });
    assert.equal(messages[0].kind, 'system');
    assert.equal(messages[0].text, '**alice** made #design and added **bob**.');
  });

  test('who sees which channel: members, others, viewers, admins', async () => {
    const names = async (cred) => (await call('GET', '/api/channels', cred)).channels.map((c) => c.name).sort();
    assert.deepEqual(await names({ tok: tok('alice') }), ['design', 'general', 'lobby']);
    assert.deepEqual(await names({ tok: tok('carol') }), ['general', 'lobby']);
    assert.deepEqual(await names({ key: KEY }), ['general', 'lobby']);
    assert.deepEqual(await names({ admin: ADMIN }), ['design', 'general', 'lobby']);
    assert.deepEqual(await names({ tok: tok('carol'), admin: ADMIN }), ['design', 'general', 'lobby'], 'the admin key sees every channel');
  });

  test("who may change a private channel's members: its members, or an admin", async () => {
    const no = await call('POST', '/api/channels/design/members', { tok: tok('carol'), body: { add: ['carol'] } });
    assert.equal(no.status, 404, 'a non-member does not see it');
    assert.equal((await call('POST', '/api/channels/design/join', { tok: tok('carol') })).status, 404);
    assert.equal((await call('POST', '/api/channels/design/join', { tok: tok('bob') })).status, 403, 'a private channel is not joined, its members add you');
    const yes = await call('POST', '/api/channels/design/members', { tok: tok('bob'), body: { add: ['carol', ag.reviewer.agent.id] } });
    assert.equal(yes.status, 200, JSON.stringify(yes));
    assert.deepEqual(yes.channel.members, [id('alice'), id('bob'), id('carol'), id('reviewer')]);
    // a member takes another out; an admin with only the key does too
    assert.equal((await call('POST', '/api/channels/design/members', { tok: tok('carol'), body: { remove: ['reviewer'] } })).channel.members.includes(id('reviewer')), false);
    const op = await call('POST', '/api/channels/design/members', { admin: ADMIN, body: { remove: ['carol'] } });
    assert.equal(op.status, 200);
    assert.deepEqual(op.channel.members, [id('alice'), id('bob')]);
    assert.equal((await call('POST', '/api/channels/design/members', { key: KEY, body: { add: ['carol'] } })).status, 404, 'a viewer does not see it');
    const { messages } = await call('GET', '/api/messages?channel=design', { tok: tok('alice') });
    assert.deepEqual(messages.filter((m) => m.kind === 'system').map((m) => m.text), [
      '**alice** made #design and added **bob**.',
      '**bob** added **carol** and **reviewer**.',
      '**carol** took **reviewer** out.',
      "The Sphere's operator took **carol** out.",
    ]);
    const au = await call('GET', '/api/audit?limit=1000', { key: KEY });
    assert.ok(au.events.some((e) => e.type === 'channel' && e.actor === 'operator' && e.detail === 'the operator took carol out of #design'));
  });

  test('a public channel: anyone joins, adds and leaves; its creator takes others out', async () => {
    assert.deepEqual((await call('POST', '/api/channels/lobby/join', { tok: tok('alice') })).channel.members, [id('bob'), id('alice')]);
    assert.equal((await call('POST', '/api/channels/lobby/members', { tok: tok('carol'), body: { add: ['reviewer'] } })).status, 200, 'anyone adds');
    const out = await call('POST', '/api/channels/lobby/members', { tok: tok('carol'), body: { remove: ['alice'] } });
    assert.equal(out.status, 403);
    assert.equal(out.code, 'forbidden');
    assert.deepEqual((await call('POST', '/api/channels/lobby/leave', { tok: tok('alice') })).channel.members, [id('bob'), id('reviewer')]);
    assert.deepEqual((await call('POST', '/api/channels/lobby/members', { tok: tok('bob'), body: { remove: ['reviewer'] } })).channel.members, [id('bob')]);
    assert.equal((await call('POST', '/api/channels/lobby/join', { key: KEY })).status, 403, 'viewers can only watch');
    assert.equal((await call('POST', '/api/channels/nowhere/join', { tok: tok('alice') })).status, 404);
  });

  test('a direct conversation: one per pair, whoever opens it, and nobody changes it', async () => {
    const a = await call('POST', '/api/dm', { tok: tok('alice'), body: { with: 'bob' } });
    assert.equal(a.status, 200, JSON.stringify(a));
    dm = a.channel.name;
    assert.equal(dm, dmName(id('alice'), id('bob')));
    assert.equal(a.channel.kind, 'dm');
    assert.deepEqual(a.channel.members, [id('alice'), id('bob')].sort());
    assert.equal((await call('POST', '/api/dm', { tok: tok('alice'), body: { with: '@bob' } })).channel.name, dm);
    assert.equal((await call('POST', '/api/dm', { tok: tok('bob'), body: { with: id('alice') } })).channel.name, dm, 'the same from the other side');
    assert.equal((await call('POST', '/api/dm', { tok: tok('alice'), body: { with: 'alice' } })).status, 400);
    assert.equal((await call('POST', '/api/dm', { tok: tok('alice'), body: { with: 'nobody' } })).status, 404);
    assert.equal((await call('POST', '/api/dm', { key: KEY, body: { with: 'bob' } })).status, 403);
    assert.equal((await call('POST', `/api/channels/${dm}/members`, { tok: tok('alice'), body: { add: ['carol'] } })).status, 403);
    assert.equal((await call('POST', `/api/channels/${dm}/leave`, { tok: tok('alice') })).status, 403);
    assert.equal((await call('POST', '/api/dm', { tok: tok('alice'), body: { with: 'reviewer' } })).channel.kind, 'dm', 'a bot can be talked to directly');
    const au = await call('GET', '/api/audit?limit=1000', { key: KEY });
    assert.equal(au.events.filter((e) => e.type === 'channel' && /opened a direct conversation with bob/.test(e.detail)).length, 1, 'opened once');
    assert.ok(!(await call('GET', '/api/channels', { tok: tok('carol') })).channels.some((c) => c.name === dm));
  });

  let dmAsk, dmPost, fileId;
  test('in a closed channel only its members post, and only they are asked', async () => {
    assert.equal((await call('POST', '/api/messages', { tok: tok('carol'), body: { channel: dm, text: 'let me in' } })).code, 'not_member');
    dmAsk = (await call('POST', '/api/messages', { tok: tok('alice'), body: { channel: dm, text: 'between us: the launch date?', to: ['bob'] } })).message;
    assert.equal(dmAsk?.kind, 'ask');
    const third = await call('POST', '/api/messages', { tok: tok('alice'), body: { channel: dm, text: 'and you?', to: ['carol'] } });
    assert.equal(third.status, 403);
    assert.equal(third.code, 'not_member');
    dmPost = (await call('POST', '/api/messages', { tok: tok('alice'), body: { channel: dm, text: 'just for bob', files: [{ name: 'plan.txt', mime: 'text/plain', data: Buffer.from('the plan').toString('base64') }] } })).message;
    assert.equal(dmPost.kind, 'post');
    fileId = dmPost.files[0].id;
    assert.equal((await call('POST', '/api/messages', { tok: tok('alice'), body: { channel: 'design', text: 'carol?', to: ['carol'] } })).code, 'not_member');
    // a reply stays in its ask's channel
    assert.equal((await call('POST', '/api/messages', { tok: tok('bob'), body: { channel: 'general', text: 'May 3', replyTo: dmAsk.id } })).status, 400);
    assert.equal((await call('POST', '/api/messages', { tok: tok('bob'), body: { channel: dm, text: 'May 3', replyTo: dmAsk.id } })).message.kind, 'reply');
    // a post makes a new public channel, its poster in it; dm- names aren't made that way
    const fresh = (await call('POST', '/api/messages', { tok: tok('carol'), body: { channel: 'random', text: 'hello' } })).message;
    assert.equal(fresh.channel, 'random');
    const random = (await call('GET', '/api/channels', { key: KEY })).channels.find((c) => c.name === 'random');
    assert.deepEqual([random.kind, random.createdBy, random.members], ['public', id('carol'), [id('carol')]]);
    assert.equal((await call('POST', '/api/messages', { tok: tok('carol'), body: { channel: 'dm-abc', text: 'hi' } })).status, 400);
    const au = await call('GET', '/api/audit?limit=1000', { key: KEY });
    assert.ok(au.events.some((e) => e.type === 'deny' && e.actor === id('carol') && /not_member/.test(e.detail)), 'refusals are audited');
  });

  test('reads are filtered: messages, threads, files', async () => {
    const ids = async (url, cred) => (await call('GET', url, cred)).messages.map((m) => m.id);
    assert.ok((await ids('/api/messages?limit=1000', { tok: tok('alice') })).includes(dmAsk.id));
    assert.ok((await ids('/api/messages?limit=1000', { tok: tok('bob') })).includes(dmPost.id));
    assert.ok(!(await ids('/api/messages?limit=1000', { tok: tok('carol') })).includes(dmAsk.id));
    assert.ok(!(await ids('/api/messages?limit=1000', { key: KEY })).includes(dmPost.id), 'a viewer sees public channels only');
    assert.ok((await ids('/api/messages?limit=1000', { admin: ADMIN })).includes(dmPost.id), 'an admin sees every channel');
    assert.deepEqual(await ids(`/api/messages?channel=${dm}`, { tok: tok('carol') }), []);
    assert.equal((await ids(`/api/messages?channel=${dm}`, { tok: tok('bob') })).length, 3);
    assert.ok(!(await ids('/api/messages?to=bob', { tok: tok('carol') })).includes(dmAsk.id));
    assert.ok((await ids('/api/messages?to=bob', { tok: tok('bob') })).includes(dmAsk.id));
    assert.equal((await call('GET', `/api/messages/${dmAsk.id}`, { tok: tok('carol') })).status, 404);
    assert.equal((await call('GET', `/api/messages/${dmAsk.id}`, { key: KEY })).status, 404);
    assert.equal((await call('GET', `/api/messages/${dmAsk.id}/replies`, { tok: tok('carol') })).status, 404);
    assert.equal((await call('GET', `/api/messages/${dmAsk.id}`, { tok: tok('bob') })).replies.length, 1);
    assert.equal((await call('GET', `/api/messages/${dmAsk.id}`, { admin: ADMIN })).status, 200);
    const files = async (cred) => (await call('GET', '/api/files', cred)).files.map((f) => f.id);
    assert.ok((await files({ tok: tok('bob') })).includes(fileId));
    assert.ok(!(await files({ tok: tok('carol') })).includes(fileId));
    assert.ok(!(await files({ key: KEY })).includes(fileId));
    const get = (cred) => fetch(`${base}/api/files/${fileId}`, { headers: cred });
    assert.equal(await (await get({ authorization: `Bearer ${tok('bob')}` })).text(), 'the plan');
    assert.equal((await get({ authorization: `Bearer ${tok('carol')}` })).status, 404);
    assert.equal((await get({ 'x-sphere-key': KEY })).status, 404);
    assert.equal((await get({ 'x-admin-key': ADMIN })).status, 200);
    // nobody else attaches a file from a closed channel to their own message
    assert.equal((await call('POST', '/api/messages', { tok: tok('carol'), body: { channel: 'general', text: 'look', files: [{ id: fileId }] } })).status, 404);
    // a file not sent with a message yet: its uploader's (and an admin's) only
    const up = await (await fetch(`${base}/api/files`, { method: 'POST', headers: { authorization: `Bearer ${tok('carol')}`, 'x-file-name': 'draft.txt', 'content-type': 'text/plain' }, body: 'draft' })).json();
    assert.equal((await fetch(`${base}/api/files/${up.file.id}`, { headers: { 'x-sphere-key': KEY } })).status, 404);
    assert.equal((await fetch(`${base}/api/files/${up.file.id}`, { headers: { authorization: `Bearer ${tok('alice')}` } })).status, 404);
    assert.equal(await (await fetch(`${base}/api/files/${up.file.id}`, { headers: { authorization: `Bearer ${tok('carol')}` } })).text(), 'draft');
  });

  test("a reply to an ask elsewhere can't be hidden in a closed channel", async () => {
    const q = (await call('POST', '/api/messages', { tok: tok('alice'), body: { channel: 'general', text: 'open question', to: ['bob'] } })).message;
    // bob is in #design and the direct conversation, alice's #general ask isn't: its answer stays where alice reads it
    for (const channel of ['design', dm]) {
      const hidden = await call('POST', '/api/messages', { tok: tok('bob'), body: { channel, text: 'answered where you cannot see', replyTo: q.id } });
      assert.equal(hidden.status, 400, channel);
      assert.match(hidden.error, /#general/);
    }
    assert.equal((await call('POST', '/api/messages', { tok: tok('bob'), body: { channel: 'general', text: 'answered in the open', replyTo: q.id } })).message.kind, 'reply');
    assert.equal((await call('GET', `/api/messages/${q.id}`, { tok: tok('alice') })).replies.length, 1);
  });

  test('someone added to a private channel reads what was said there before', async () => {
    const made = await call('POST', '/api/channels', { tok: tok('alice'), body: { name: 'history', private: true, members: ['bob'] } });
    assert.equal(made.status, 200);
    const early = (await call('POST', '/api/messages', { tok: tok('alice'), body: { channel: 'history', text: 'said before carol came' } })).message;
    assert.deepEqual((await call('GET', '/api/messages?channel=history', { tok: tok('carol') })).messages, [], 'not before she is in it');
    await call('POST', '/api/channels/history/members', { tok: tok('bob'), body: { add: ['carol'] } });
    // the console fetches a conversation's own history when it's shown: this is what it reads
    assert.ok((await call('GET', '/api/messages?channel=history&limit=200', { tok: tok('carol') })).messages.some((m) => m.id === early.id));
    await call('POST', '/api/channels/history/members', { tok: tok('alice'), body: { remove: ['carol'] } });
    assert.deepEqual((await call('GET', '/api/messages?channel=history', { tok: tok('carol') })).messages, [], 'and not after she is out');
  });

  test('live events are filtered the same way', async () => {
    const s = {
      alice: openStream(base, { tok: tok('alice'), role: 'console' }),
      bob: openStream(base, { tok: tok('bob'), role: 'rep' }),
      carol: openStream(base, { tok: tok('carol'), role: 'console' }),
      viewer: openStream(base, { key: KEY }),
      admin: openStream(base, { admin: ADMIN }),
    };
    await sleep(400);
    const ask = (await call('POST', '/api/messages', { tok: tok('alice'), body: { channel: dm, text: 'live, between us', to: ['bob'] } })).message;
    await call('POST', `/api/messages/${ask.id}/claim`, { tok: tok('bob'), body: { instance: 'x' } });
    const open = (await call('POST', '/api/messages', { tok: tok('carol'), body: { channel: 'general', text: 'live, for all' } })).message;
    await call('POST', '/api/channels', { tok: tok('bob'), body: { name: 'secret', private: true, members: ['alice'] } });
    await until(() => s.admin.events.some((e) => e.ev === 'channel' && e.data.name === 'secret') && s.viewer.events.some((e) => e.ev === 'message' && e.data.id === open.id));
    await sleep(300);
    const got = (who, ev, pred) => s[who].events.some((e) => e.ev === ev && pred(e.data));
    for (const who of ['alice', 'bob', 'admin']) assert.ok(got(who, 'message', (d) => d.id === ask.id), `${who} gets the direct ask`);
    for (const who of ['carol', 'viewer']) assert.ok(!got(who, 'message', (d) => d.id === ask.id), `${who} doesn't`);
    for (const who of ['alice', 'admin']) assert.ok(got(who, 'message-update', (d) => d.id === ask.id), `${who} sees it claimed`);
    for (const who of ['carol', 'viewer']) assert.ok(!got(who, 'message-update', (d) => d.id === ask.id), `${who} doesn't`);
    for (const who of ['alice', 'carol', 'viewer', 'admin']) assert.ok(got(who, 'message', (d) => d.id === open.id), `${who} gets the public post`);
    for (const who of ['alice', 'admin']) assert.ok(got(who, 'channel', (d) => d.name === 'secret' && d.kind === 'private'), `${who} hears of #secret`);
    for (const who of ['carol', 'viewer', 'bob']) assert.ok(!got(who, 'channel', (d) => d.name === 'secret'), `${who} doesn't (a rep hears of no channels)`);
    // taken out: told once, then nothing more from it
    await call('POST', '/api/channels/secret/members', { tok: tok('bob'), body: { remove: ['alice'] } });
    await until(() => got('alice', 'channel', (d) => d.name === 'secret' && !d.members.includes(id('alice'))));
    assert.ok(got('alice', 'channel', (d) => d.name === 'secret' && !d.members.includes(id('alice'))), 'alice hears she is out');
    const after = (await call('POST', '/api/messages', { tok: tok('bob'), body: { channel: 'secret', text: 'now without alice' } })).message;
    await until(() => got('admin', 'message', (d) => d.id === after.id));
    await sleep(200);
    assert.ok(!got('alice', 'message', (d) => d.id === after.id));
    for (const x of Object.values(s)) x.close();
  });

  test('the audit chain verifies; nothing in it is filtered', async () => {
    const au = await call('GET', '/api/audit?limit=1000', { key: KEY });
    assert.equal(au.verified, true);
    assert.ok(au.events.some((e) => e.type === 'ask' && e.detail.includes(`#${dm}`)), 'who asked whom, and where, stays in the log');
    assert.ok(!JSON.stringify(au).includes('between us'), 'never the words');
  });

  test('channels and their members survive a restart', async () => {
    const before = (await call('GET', '/api/channels', { admin: ADMIN })).channels;
    await stop(relay.p, 'SIGKILL'); // a crash, not a clean stop: who is in a channel was saved as it changed
    relay = await startRelay({ dir });
    base = relay.base;
    const now = (await call('GET', '/api/channels', { admin: ADMIN })).channels;
    assert.deepEqual(now, before);
    assert.deepEqual((await call('GET', '/api/channels', { tok: tok('carol') })).channels.map((c) => c.name).sort(), ['general', 'lobby', 'random']);
    assert.equal((await call('POST', '/api/messages', { tok: tok('carol'), body: { channel: dm, text: 'still out' } })).code, 'not_member');
    assert.equal((await call('GET', '/api/audit?limit=1', { key: KEY })).verified, true);
  });
});

// ---------------------------------------------------------------- the Redis store: many instances, one set of channels

describe('channels on the Redis store', () => {
  let fake;
  const procs = [];
  let A, B, env;
  const at = (b) => caller(() => b);
  const ag = {};

  before(async () => {
    fake = await startFakeUpstash({ latencyMs: 2 });
    env = { UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, SPHERE_REDIS_PREFIX: 'c:' };
    const [a, b] = await Promise.all([startRelay({ store: 'redis', env }), startRelay({ store: 'redis', env })]);
    procs.push(a.p, b.p);
    A = a.base;
    B = b.base;
    for (const n of ['alice', 'bob', 'carol']) ag[n] = await at(A)('POST', '/api/join', { body: { key: KEY, name: n, owner: n } });
  });
  after(async () => {
    await Promise.all(procs.map((p) => stop(p)));
    await fake?.close();
  });

  test('a channel made on one instance is the same, and as private, on another', async () => {
    const made = await at(A)('POST', '/api/channels', { tok: ag.alice.token, body: { name: 'core', private: true, members: ['bob'] } });
    assert.equal(made.status, 200);
    const seen = async (base, tok) => (await at(base)('GET', '/api/channels', { tok })).channels.map((c) => c.name).sort();
    assert.deepEqual(await seen(B, ag.bob.token), ['core', 'general']);
    assert.deepEqual(await seen(B, ag.carol.token), ['general']);
    assert.equal((await at(B)('POST', '/api/messages', { tok: ag.carol.token, body: { channel: 'core', text: 'x' } })).code, 'not_member');
    const changed = await at(B)('POST', '/api/channels/core/members', { tok: ag.bob.token, body: { add: ['carol'] } });
    assert.equal(changed.status, 200);
    assert.deepEqual(await seen(A, ag.carol.token), ['core', 'general']);
  });

  test('a direct conversation opened on both instances at once is one', async () => {
    const [x, y] = await Promise.all([at(A)('POST', '/api/dm', { tok: ag.alice.token, body: { with: 'bob' } }), at(B)('POST', '/api/dm', { tok: ag.bob.token, body: { with: 'alice' } })]);
    assert.equal(x.channel.name, y.channel.name);
    const au = await at(A)('GET', '/api/audit?limit=1000', { key: KEY });
    assert.equal(au.events.filter((e) => e.type === 'channel' && /direct conversation/.test(e.detail)).length, 1);
    const sent = (await at(A)('POST', '/api/messages', { tok: ag.alice.token, body: { channel: x.channel.name, text: 'hi bob', to: ['bob'] } })).message;
    assert.equal((await at(B)('GET', `/api/messages/${sent.id}`, { tok: ag.carol.token })).status, 404);
    assert.equal((await at(B)('GET', `/api/messages/${sent.id}`, { tok: ag.bob.token })).status, 200);
  });

  test('a new instance replays the log to the same channels', async () => {
    const c = await startRelay({ store: 'redis', env });
    procs.push(c.p);
    const [ca, cc] = await Promise.all([at(c.base)('GET', '/api/channels', { admin: ADMIN }), at(A)('GET', '/api/channels', { admin: ADMIN })]);
    assert.deepEqual(ca.channels, cc.channels);
    assert.deepEqual((await at(c.base)('GET', '/api/channels', { key: KEY })).channels.map((x) => x.name), ['general']);
    assert.equal((await at(c.base)('GET', '/api/audit?limit=1', { key: KEY })).verified, true);
  });
});

// ---------------------------------------------------------------- sealed: through representatives and the owner's console

// a sealed envelope built by hand, as API.md describes it, signed with the sender's keys.json
const b64 = (b) => Buffer.from(b).toString('base64url');
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}
function gcm(key, data) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(data), c.final()]);
  return { iv, ct, tag: c.getAuthTag() };
}
function sealByHand({ keys, from, channel, to = [], readers, text }) {
  const cek = crypto.randomBytes(32);
  const body = gcm(cek, Buffer.from(JSON.stringify({ text, files: [] })));
  const eph = crypto.generateKeyPairSync('x25519');
  const epk = Buffer.from(eph.publicKey.export({ format: 'jwk' }).x, 'base64url');
  const wrapped = {};
  for (const r of readers) {
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: r.keys.seal }, format: 'jwk' });
    const kek = Buffer.from(crypto.hkdfSync('sha256', crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pub }), Buffer.concat([epk, Buffer.from(r.keys.seal, 'base64url')]), 'obysphere/seal/v1', 32));
    const w = gcm(kek, cek);
    wrapped[r.id] = { iv: b64(w.iv), ct: b64(w.ct), tag: b64(w.tag) };
  }
  const sealed = { v: 1, epk: b64(epk), iv: b64(body.iv), ct: b64(body.ct), tag: b64(body.tag), to: wrapped, sig: '' };
  const digest = crypto.createHash('sha256').update(canonical({ v: 1, from, channel, to: [...to].sort(), replyTo: null, cause: null, depth: 0, epk: sealed.epk, iv: sealed.iv, ct: sealed.ct, tag: sealed.tag, readers: Object.keys(wrapped).sort() })).digest();
  const priv = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: keys.sign.d, x: keys.sign.x }, format: 'jwk' });
  sealed.sig = b64(crypto.sign(null, digest, priv));
  return sealed;
}

describe('sealed private channels and direct messages', () => {
  let relay, dir, home, base;
  const procs = [];
  const call = caller(() => base);
  const rep = (args, env = {}) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), ...args], { env: { ...process.env, OBYSPHERE_HOME: home, SPHERE_CHANNEL: '', ...env } });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      const t = setTimeout(() => p.kill(), 30000);
      p.on('close', () => {
        clearTimeout(t);
        resolve(out);
      });
    });
  const profile = (n) => JSON.parse(fs.readFileSync(path.join(home, n, 'profile.json'), 'utf8'));
  const keysOf = (n) => JSON.parse(fs.readFileSync(path.join(home, n, 'keys.json'), 'utf8'));
  const tok = (n) => profile(n).token;
  const idOf = (n) => profile(n).agent.id;
  let agents;
  const latest = async (pred) => (await call('GET', '/api/messages?limit=1000', { admin: ADMIN })).messages.filter(pred).pop();

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-conv-sealed-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-conv-reps-'));
    relay = await startRelay({ dir, sealed: true });
    procs.push(relay.p);
    base = relay.base;
  });
  after(async () => {
    await Promise.all(procs.map((p) => stop(p)));
    rmDir(dir);
    rmDir(home);
  });

  test('join --bot makes an Oby with no person behind it', async () => {
    for (const n of ['alice', 'bob', 'carol']) assert.match(await rep(['join', `${base}/#key=${KEY}`, '--name', n, '--owner', `${n} Test`, '--cwd', os.tmpdir()]), /joined/);
    const out = await rep(['join', `${base}/#key=${KEY}`, '--name', 'reviewer', '--owner', 'Platform team', '--cwd', os.tmpdir(), '--bot']);
    assert.match(out, /as a bot for Platform team \(no person behind it\)/);
    assert.equal(profile('reviewer').bot, true);
    agents = (await call('GET', '/api/agents', { key: KEY })).agents;
    assert.deepEqual(agents.map((a) => [a.name, a.bot]).sort(), [['alice', false], ['bob', false], ['carol', false], ['reviewer', true]]);
    assert.match(await rep(['whoami', '--profile', 'reviewer']), /a bot/);
  });

  test("a post in a private channel is sealed for its members, not the Sphere's", async () => {
    assert.equal((await call('POST', '/api/channels', { tok: tok('alice'), body: { name: 'core', private: true, members: ['bob'] } })).status, 200);
    const out = await rep(['post', 'core secret: ship friday', '--channel', 'core', '--profile', 'alice']);
    assert.match(out, /sealed for the 1 member with keys/);
    const m = await latest((x) => x.channel === 'core' && x.kind === 'post');
    assert.deepEqual(Object.keys(m.sealed.to).sort(), [idOf('alice'), idOf('bob')].sort());
    assert.match(await rep(['read', 'core', '--profile', 'bob']), /core secret: ship friday/);
    assert.match(await rep(['read', 'core', '--profile', 'carol']), /#core is empty/);
    // a post to #general is still sealed for every member
    await rep(['post', 'hello all', '--profile', 'alice']);
    assert.equal(Object.keys((await latest((x) => x.channel === 'general' && x.kind === 'post')).sealed.to).length, 4);
  });

  test('the relay refuses a reader outside a private channel', async () => {
    const byName = (n) => agents.find((a) => a.name === n);
    const mk = (names) => sealByHand({ keys: keysOf('alice'), from: idOf('alice'), channel: 'core', readers: names.map(byName), text: 'by hand' });
    const ok = await call('POST', '/api/messages', { tok: tok('alice'), body: { channel: 'core', text: '', sealed: mk(['alice', 'bob']) } });
    assert.equal(ok.status, 200, JSON.stringify(ok));
    const bad = await call('POST', '/api/messages', { tok: tok('alice'), body: { channel: 'core', text: '', sealed: mk(['alice', 'bob', 'carol']) } });
    assert.equal(bad.status, 400);
    assert.equal(bad.code, 'bad_envelope');
    assert.match(bad.error, /carol isn't in #core/);
  });

  test('an ask in a direct conversation is sealed for the two of them', async () => {
    const dm = (await call('POST', '/api/dm', { tok: tok('alice'), body: { with: 'bob' } })).channel.name;
    const out = await rep(['ask', 'bob', 'just between us', '--channel', dm, '--profile', 'alice', '--wait', '10']);
    assert.match(out, /posted in your direct conversation with it/);
    const m = await latest((x) => x.channel === dm && x.kind === 'ask');
    assert.deepEqual(Object.keys(m.sealed.to).sort(), [idOf('alice'), idOf('bob')].sort());
    assert.match(await rep(['ask', 'carol', 'you too?', '--channel', dm, '--profile', 'alice', '--wait', '10']), /isn't in #dm-/);
  });

  test('answering in a private channel, an ask to someone outside it goes to a direct conversation', async () => {
    const out = await rep(['ask', 'carol', 'a hop out of core', '--profile', 'alice', '--wait', '10'], { SPHERE_CHANNEL: 'core' });
    assert.match(out, /posted in your direct conversation with it/, out);
    const m = await latest((x) => x.kind === 'ask' && x.to.includes(idOf('carol')));
    assert.equal(m.channel, dmName(idOf('alice'), idOf('carol')));
    assert.deepEqual(Object.keys(m.sealed.to).sort(), [idOf('alice'), idOf('carol')].sort());
    assert.ok(!(await call('GET', '/api/messages?channel=core&limit=1000', { admin: ADMIN })).messages.some((x) => x.to.includes(idOf('carol'))));
  });

  test("the owner's console seals what the page posts in a private channel for its members", async () => {
    const port = await freePort();
    const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'ui', '--profile', 'alice', '--port', String(port)], { env: { ...process.env, OBYSPHERE_HOME: home }, stdio: 'ignore' });
    procs.push(p);
    const ui = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(ui + '/api/channels')).ok) break; } catch {}
      await sleep(100);
    }
    const page = (method, url, body) => fetch(ui + url, { method, headers: { 'content-type': 'application/json', ...consoleAuth(path.join(home, 'alice'), ui) }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
    assert.ok((await page('GET', '/api/channels')).channels.some((c) => c.name === 'core' && c.kind === 'private'));
    const sent = await page('POST', '/api/messages', { channel: 'core', text: 'from the page, for core' });
    assert.equal(sent.message.open, true);
    assert.deepEqual(Object.keys(sent.message.sealed.to).sort(), [idOf('alice'), idOf('bob')].sort());
    // the page opens a direct conversation through the console, and asks there
    const dm = (await page('POST', '/api/dm', { with: 'reviewer' })).channel;
    assert.equal(dm.kind, 'dm');
    const asked = await page('POST', '/api/messages', { channel: dm.name, text: 'review this?', to: ['reviewer'] });
    assert.deepEqual(Object.keys(asked.message.sealed.to).sort(), [idOf('alice'), idOf('reviewer')].sort());
    assert.equal((await page('GET', `/api/messages?channel=${dm.name}`)).messages.find((m) => m.id === asked.message.id).text, 'review this?');
  });

  test("a note in a direct conversation isn't sealed for you alone when the other's keys changed", async () => {
    const dm = (await call('POST', '/api/dm', { tok: tok('alice'), body: { with: 'carol' } })).channel.name;
    assert.match(await rep(['post', 'before the change', '--channel', dm, '--profile', 'alice']), /sealed for the 1 member/);
    // carol's keys change on the relay (a new machine, or a relay lying): alice pinned the old ones
    const pub = (kind) => crypto.generateKeyPairSync(kind).publicKey.export({ format: 'jwk' }).x;
    assert.equal((await call('POST', '/api/me', { tok: tok('carol'), body: { keys: { seal: pub('x25519'), sign: pub('ed25519') } } })).status, 200);
    const count = async () => (await call('GET', `/api/messages?channel=${dm}&limit=1000`, { admin: ADMIN })).messages.filter((m) => m.kind === 'post').length;
    const before = await count();
    assert.match(await rep(['post', 'after the change', '--channel', dm, '--profile', 'alice']), /Not sealing to @carol: its keys changed/);
    assert.equal(await count(), before, 'nothing was sent that only alice could read');
  });

  test('the audit chain still verifies', async () => {
    assert.equal((await call('GET', '/api/audit?limit=1', { key: KEY })).verified, true);
  });
});

// ---------------------------------------------------------------- the console page

describe('the Conversation view', () => {
  const page = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]).join('\n;\n');
  const body = (head) => {
    const i = script.indexOf(head);
    return i < 0 ? '' : script.slice(i, script.indexOf('\n  }\n', i));
  };

  test("the page's script parses", () => {
    assert.ok(script.length > 1000);
    assert.doesNotThrow(() => new vm.Script(script, { filename: 'index.html' }));
  });

  test('a conversation shows its own history, not only what the page started with', () => {
    // the page starts with the Sphere's newest 500 messages, every channel together: a quiet
    // direct conversation, or a private channel you were just added to, is fetched when shown
    assert.match(body('function renderFeed() {'), /loadHistory\(S\.current\)/);
    const load = body('async function loadHistory(name) {');
    assert.match(load, /\/api\/messages\?channel=\$\{encodeURIComponent\(name\)\}/);
    assert.match(load, /!S\.byId\.has\(m\.id\)/, 'what the page holds already is kept, not doubled');
  });

  test("a closed conversation you aren't in is read only", () => {
    // an admin's console sees every channel; the relay refuses its posts in ones it isn't in
    assert.match(body('function renderTo() {'), /const outside = isClosed\(c\) && !inCh\(c\) && !inModal\(\);\s*\$\('#text'\)\.disabled = outside;/);
    assert.match(body('async function send() {'), /if \(isClosed\(c\) && !inCh\(c\) && !modal\) return;/);
  });
});
