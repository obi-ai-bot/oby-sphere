// What the relay keeps and removes (security audit, finding 10): a member who floods the Sphere
// loses its own oldest messages at a cut by count, not everyone else's, and the chain still
// verifies, on both stores and after a cold start. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startFakeUpstash } from './fake-upstash.mjs';
import { KEY, ADMIN, relay, call, audit, tempDir, members, until } from './relay-hardening-helpers.mjs';

let T;
before(() => (T = tempDir('hardening-cuts')));
after(() => T.remove());

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
      assert.ok(cut.length >= 1, 'the share cut is audited, naming her');
      assert.match(cut[0].detail, /of mallory's messages removed: it held more than half of the newest 100/);
      assert.equal((await call(R.base, 'GET', '/api/audit', { key: KEY })).verified, true);
    });

    test('a plain cut of older messages after a share cut still verifies: its event names the newest message any cut removed', async () => {
      // A Sphere of its own: alice and bob talk (40), then mallory floods (80) and loses her oldest
      // (past half of 100). Then alice and bob go on (21): a few more of hers go, and then the oldest
      // of all, which are older than every one of hers already cut.
      const S = await relay(kind === 'fs' ? { ...env(), SPHERE_DATA: path.join(T.dir, 'fair-order') } : { ...env(), SPHERE_REDIS_PREFIX: 'fairorder:' }, { tmp: T.dir, procs });
      const n = await members(S.base, ['alice', 'bob', 'mallory']);
      assert.equal((await call(S.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { retainMessages: 100 } })).status, 200);
      const say = async (who, text) => (await call(S.base, 'POST', '/api/messages', { token: n[who].token, body: { text } })).message.id;
      for (let i = 0; i < 40; i++) await say(i % 2 ? 'alice' : 'bob', `talk ${i}`);
      const hers = new Set();
      for (let i = 0; i < 80; i++) hers.add(await say('mallory', `flood ${i}`));
      for (let i = 0; i < 21; i++) await say(i % 2 ? 'alice' : 'bob', `more ${i}`);
      await call(S.base, 'GET', '/api/info', { key: KEY });
      const au = await call(S.base, 'GET', '/api/audit?limit=1000', { key: KEY });
      const plain = au.events.filter((e) => e.type === 'expire' && /past the newest 100 removed/.test(e.detail)).at(-1);
      assert.ok(plain, `a plain cut came after the share cuts: ${au.events.filter((e) => e.type === 'expire').map((e) => e.detail).join(' | ')}`);
      assert.ok(hers.has(plain.ref), `it names one of mallory's, cut before it (${plain.detail})`);
      assert.equal(au.verified, true);
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
