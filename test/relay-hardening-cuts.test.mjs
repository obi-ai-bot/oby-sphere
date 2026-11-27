// What the relay keeps and removes (security audit, findings 10, 14 and 15; second audit, R5): a
// member who floods the Sphere loses its own oldest messages at a cut by count, not everyone else's,
// also when it floods with system messages (changing a channel's members) or with a second agent:
// a cut takes the oldest first but never a member's newest share, and the chain still verifies, on
// both stores and after a cold start; on Redis, a deletion whose message a racing compaction
// already folded into the snapshot brings the next compaction forward on every instance; and a
// Sphere migrated from the first version keeps no copy of its old messages in sphere.json.v0.bak.
// `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startFakeUpstash } from './fake-upstash.mjs';
import { KEY, ADMIN, relay, call, audit, tempDir, members, until } from './relay-hardening-helpers.mjs';

let T;
before(() => (T = tempDir('hardening-cuts')));
after(() => T.remove());
const sha = (x) => createHash('sha256').update(x).digest('hex');

// every file in a folder, as text
function folderText(dir) {
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

for (const kind of ['fs', 'redis']) {
  describe(`a flood and the cut by count on the ${kind} store`, () => {
    const procs = new Set();
    let fake, R, m;
    const prefix = 'fair:';
    const env = () =>
      kind === 'fs'
        ? { SPHERE_DATA: path.join(T.dir, 'fair'), SPHERE_WRITES_PER_MIN: '100000' }
        : { SPHERE_STORE: 'redis', UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, SPHERE_REDIS_PREFIX: prefix, SPHERE_COMPACT_WAIT_MS: '0', SPHERE_WRITES_PER_MIN: '100000' };
    const held = async (base = R.base) => (await call(base, 'GET', '/api/messages?limit=1000', { admin: ADMIN })).messages;
    const post = (who, text) => call(R.base, 'POST', '/api/messages', { token: m[who].token, body: { text } });
    before(async () => {
      if (kind === 'redis') fake = await startFakeUpstash();
      R = await relay(env(), { tmp: T.dir, procs });
      m = await members(R.base, ['alice', 'bob', 'mallory']);
      assert.equal((await call(R.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { retainMessages: 100 } })).status, 200);
    });
    after(async () => {
      [...procs].forEach((p) => p.kill());
      await fake?.close();
    });

    test("mallory's flood takes her own oldest messages, not alice's", async () => {
      const alices = [];
      for (let i = 0; i < 5; i++) alices.push((await post('alice', `Alice Test: the SALMON-${i} plan`)).message.id);
      for (let i = 0; i < 130; i++) assert.equal((await post('mallory', `mallory ${i}`)).status, 200);
      await call(R.base, 'GET', '/api/info', { key: KEY });
      const now = await held();
      for (const id of alices) assert.ok(now.some((x) => x.id === id), `alice's ${id} stays`);
      const hers = now.filter((x) => x.from === m.mallory.id);
      assert.ok(hers.length < 130, `${hers.length} of mallory's held`);
      assert.equal(hers.at(-1).text, 'mallory 129', 'her newest stay');
      const cut = (await audit(R.base)).filter((e) => e.type === 'expire' && e.target === m.mallory.id);
      assert.ok(cut.length >= 1, 'the cut is audited, naming her');
      assert.match(cut[0].detail, /past the newest 100 removed, the oldest first but none of a member's newest \d+ \(mallory \d+/);
      assert.equal((await call(R.base, 'GET', '/api/audit', { key: KEY })).verified, true);
    });

    test('a plain cut of older messages after a fair cut still verifies: its event names the newest message any cut removed', async () => {
      // A Sphere of its own: alice and bob talk (40), then mallory floods (80) and loses her oldest.
      // Then alice and bob go on: once each holds more than its share, a cut takes the oldest of
      // all, which are older than every one of hers already cut.
      const S = await relay(kind === 'fs' ? { ...env(), SPHERE_DATA: path.join(T.dir, 'fair-order') } : { ...env(), SPHERE_REDIS_PREFIX: 'fairorder:' }, { tmp: T.dir, procs });
      const n = await members(S.base, ['alice', 'bob', 'mallory']);
      assert.equal((await call(S.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { retainMessages: 100 } })).status, 200);
      const say = async (who, text) => (await call(S.base, 'POST', '/api/messages', { token: n[who].token, body: { text } })).message.id;
      for (let i = 0; i < 40; i++) await say(i % 2 ? 'alice' : 'bob', `talk ${i}`);
      const hers = new Set();
      for (let i = 0; i < 80; i++) hers.add(await say('mallory', `flood ${i}`));
      const cuts = async () => (await call(S.base, 'GET', '/api/audit?limit=1000', { key: KEY })).events.filter((e) => e.type === 'expire');
      let plain = null;
      for (let i = 0; i < 200 && !plain; i++) {
        await say(i % 2 ? 'alice' : 'bob', `more ${i}`);
        if (i % 10 === 9) plain = (await cuts()).find((e) => /past the newest 100 removed(, up to m_[\w-]+)?$/.test(e.detail));
      }
      assert.ok(plain, `a plain cut came after the fair ones: ${(await cuts()).map((e) => e.detail).join(' | ')}`);
      const fair = (await cuts()).filter((e) => e.target === n.mallory.id);
      assert.ok(fair.length >= 1, 'her flood was cut first, naming her');
      assert.ok(hers.has(plain.ref), `it names one of mallory's, cut before it (${plain.detail})`);
      assert.equal((await call(S.base, 'GET', '/api/audit', { key: KEY })).verified, true);
      await S.stop();
    });

    test('a flood of system messages (adding and taking out a member, each said in the channel) or a second agent pushes no one else out', async () => {
      const S = await relay(kind === 'fs' ? { ...env(), SPHERE_DATA: path.join(T.dir, 'fair-sybil') } : { ...env(), SPHERE_REDIS_PREFIX: 'fairsybil:' }, { tmp: T.dir, procs });
      const n = await members(S.base, ['alice', 'bob', 'mallory', 'mallory-two']);
      assert.equal((await call(S.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { retainMessages: 100 } })).status, 200);
      const say = async (who, text) => assert.equal((await call(S.base, 'POST', '/api/messages', { token: n[who].token, body: { text } })).status, 200);
      for (let i = 0; i < 30; i++) {
        await say('alice', `Alice Test ${i}`);
        await say('bob', `Bob Test ${i}`);
      }
      const held = async () => (await call(S.base, 'GET', '/api/messages?limit=1000', { admin: ADMIN })).messages;
      const count = (list, id) => list.filter((x) => x.from === id).length;
      // one member: half of the newest 100 in posts, and as many system messages (adding bob to its
      // channel and taking him out again)
      assert.equal((await call(S.base, 'POST', '/api/channels', { token: n.mallory.token, body: { name: 'mine' } })).status, 200);
      for (let i = 0; i < 150; i++) {
        await say('mallory', `mallory ${i}`);
        assert.equal((await call(S.base, 'POST', '/api/channels/mine/members', { token: n.mallory.token, body: i % 2 ? { remove: ['bob'] } : { add: ['bob'] } })).status, 200);
      }
      await call(S.base, 'GET', '/api/info', { key: KEY });
      let now = await held();
      assert.equal(count(now, n.alice.id), 30, 'alice keeps all of hers');
      assert.equal(count(now, n.bob.id), 30, 'bob keeps all of his');
      // two agents, each under half
      for (let i = 0; i < 100; i++) {
        await say('mallory', `again ${i}`);
        await say('mallory-two', `again ${i}`);
      }
      await call(S.base, 'GET', '/api/info', { key: KEY });
      now = await held();
      // four members share the newest 100: each keeps at least its newest 20 (alice and bob, 30 each,
      // lose at most their oldest 10)
      assert.ok(count(now, n.alice.id) >= 20, `alice holds ${count(now, n.alice.id)}`);
      assert.ok(count(now, n.bob.id) >= 20, `bob holds ${count(now, n.bob.id)}`);
      assert.ok(now.some((x) => x.text === 'Alice Test 29') && now.some((x) => x.text === 'Bob Test 29'), 'their newest stay');
      assert.ok(count(now, n.mallory.id) <= 30 && count(now, n['mallory-two'].id) <= 30, 'the flood went');
      assert.equal((await call(S.base, 'GET', '/api/audit', { key: KEY })).verified, true);
      await S.stop();
    });

    test('after a restart (fs) or on a new instance (redis), the same messages and a verified chain', async () => {
      const was = (await held()).map((x) => x.id);
      let B;
      if (kind === 'fs') {
        await R.stop();
        R = B = await relay(env(), { tmp: T.dir, procs });
      } else B = await relay(env(), { tmp: T.dir, procs });
      assert.deepEqual((await held(B.base)).map((x) => x.id), was);
      assert.equal((await call(B.base, 'GET', '/api/audit', { key: KEY })).verified, true);
      if (kind === 'redis') {
        // a compaction folds the share cut in: the next cold start reads the same
        assert.ok(await until(() => fake.kv.has(prefix + 'snap'), 10000), 'compacted');
        const C = await relay({ ...env(), SPHERE_COMPACT_EVERY: '0' }, { tmp: T.dir, procs });
        assert.deepEqual((await held(C.base)).map((x) => x.id), was);
        assert.equal((await call(C.base, 'GET', '/api/audit', { key: KEY })).verified, true);
        await C.stop();
        await B.stop();
      }
    });
  });
}

test("on Redis, a deletion a racing compaction got ahead of brings the next compaction forward on every instance", async () => {
  const procs = new Set();
  const fake = await startFakeUpstash();
  const prefix = 'race:';
  const env = { SPHERE_STORE: 'redis', UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, SPHERE_REDIS_PREFIX: prefix, SPHERE_COMPACT_WAIT_MS: '0' };
  const stored = () => [...fake.kv].filter(([k, e]) => k.startsWith(prefix) && !e.exp).map(([, e]) => (Array.isArray(e.v) ? e.v.join('\n') : String(e.v))).join('\n');
  const snapList = () => {
    const ptr = fake.kv.get(prefix + 'snap');
    return ptr ? fake.kv.get(prefix + 'snap:' + JSON.parse(ptr.v).id)?.v.join('\n') || '' : '';
  };
  try {
    // a compaction folds the message into the snapshot
    const A = await relay({ ...env, SPHERE_COMPACT_EVERY: '5' }, { tmp: T.dir, procs });
    const { alice } = await members(A.base, ['alice']);
    const msg = (await call(A.base, 'POST', '/api/messages', { token: alice.token, body: { text: 'the HERON-77 plan' } })).message;
    for (let i = 0; i < 20 && !snapList().includes('HERON-77'); i++) await call(A.base, 'POST', '/api/messages', { token: alice.token, body: { text: `more ${i}` } });
    assert.ok(await until(() => snapList().includes('HERON-77')), 'in the snapshot');
    await A.stop();
    // ... and a deletion committed by an instance that hadn't seen that compaction: not marked soon,
    // its overwrite of the message's entry skipped (the entry was already folded); then that
    // instance went away before compacting
    const tail = fake.kv.get(prefix + 'tail');
    assert.ok(tail, 'the log moved to its tail');
    tail.v.push(JSON.stringify({ t: 'delete', id: msg.id, by: alice.id, at: new Date().toISOString(), files: [] }));
    // another instance, with compaction as rare as it gets, picks the deletion up and compacts
    const B = await relay({ ...env, SPHERE_COMPACT_EVERY: '100000' }, { tmp: T.dir, procs });
    assert.equal((await call(B.base, 'GET', `/api/messages/${msg.id}`, { admin: ADMIN })).message.deleted?.by, alice.id);
    assert.ok(await until(() => !stored().includes('HERON-77'), 8000), 'the words left the snapshot');
    await B.stop();
  } finally {
    [...procs].forEach((p) => p.kill());
    await fake.close();
  }
});

describe('a Sphere of the first version, migrated', () => {
  const procs = new Set();
  after(() => [...procs].forEach((p) => p.kill()));
  const tok = 'tok_' + 'k'.repeat(32);
  const v0 = (dir) => {
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    const ts = new Date().toISOString();
    const agent = { id: 'a_alice', name: 'alice', owner: 'Alice Test', about: '', runtime: 'claude', createdAt: ts, lastSeen: ts, tokenHash: sha(tok) };
    const old = { id: 'm_oldmole', ts, channel: 'general', from: 'a_alice', kind: 'post', to: [], text: 'the old MOLE-3 note', replyTo: null, cause: null, files: [], depth: 0, meta: {} };
    fs.writeFileSync(path.join(dir, 'sphere.json'), JSON.stringify({ sphere: { name: 'Old', key: KEY, adminKey: ADMIN, createdAt: ts }, agents: { a_alice: agent }, messages: [old] }), { mode: 0o600 });
  };

  test('the old file is removed once its messages are in the log; a deleted one leaves no trace in the folder', async () => {
    const dir = path.join(T.dir, 'v0');
    v0(dir);
    const R = await relay({ SPHERE_DATA: dir }, { tmp: T.dir, procs });
    const got = await call(R.base, 'GET', '/api/messages', { admin: ADMIN });
    assert.ok(got.messages.some((x) => x.text === 'the old MOLE-3 note'), 'migrated');
    assert.equal(fs.existsSync(path.join(dir, 'sphere.json.v0.bak')), false, 'no copy of the old file left');
    assert.equal((await call(R.base, 'DELETE', '/api/messages/m_oldmole', { token: tok })).status, 200);
    assert.ok(!folderText(dir).includes('MOLE-3'), 'its words are nowhere in the data folder');
    await R.stop();
  });

  test('a copy left by an earlier migration is removed at start', async () => {
    const dir = path.join(T.dir, 'v0-left');
    v0(dir);
    fs.copyFileSync(path.join(dir, 'sphere.json'), path.join(T.dir, 'v0-left.json'));
    let R = await relay({ SPHERE_DATA: dir }, { tmp: T.dir, procs });
    await R.stop();
    // as an older relay left it
    fs.copyFileSync(path.join(T.dir, 'v0-left.json'), path.join(dir, 'sphere.json.v0.bak'));
    R = await relay({ SPHERE_DATA: dir }, { tmp: T.dir, procs });
    assert.equal(fs.existsSync(path.join(dir, 'sphere.json.v0.bak')), false);
    assert.ok((await call(R.base, 'GET', '/api/messages', { admin: ADMIN })).messages.some((x) => x.text === 'the old MOLE-3 note'), 'the messages are still there');
    await R.stop();
  });
});
