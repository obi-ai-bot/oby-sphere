// Sizes a member can't push past (security audit, finding 3): a sealed message's ciphertext is at most
// what a message's words and file keys need; a member whose messages pass its share of bytes
// has its own oldest ones cut; and a read of messages is paged by bytes, saying there's more.
// `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startFakeUpstash } from './fake-upstash.mjs';
import { KEY, ADMIN, relay, call, audit, tempDir, members, envelope } from './relay-hardening-helpers.mjs';

let T;
before(() => (T = tempDir('hardening-sizes')));
after(() => T.remove());
const MB = 1024 * 1024;

describe('sealed messages', () => {
  const procs = new Set();
  let R, m;
  before(async () => {
    R = await relay({ SPHERE_DATA: path.join(T.dir, 'sealed'), SPHERE_WRITES_PER_MIN: '100000', SPHERE_ASKS_PER_MIN: '100000' }, { tmp: T.dir, procs });
    m = await members(R.base, ['alice', 'bob']);
  });
  after(() => [...procs].forEach((p) => p.kill()));
  const sealedAsk = (ctBytes) =>
    call(R.base, 'POST', '/api/messages', { token: m.alice.token, body: { to: ['bob'], text: '', sealed: envelope(m.alice.keys, { from: m.alice.id, to: [m.bob.id], readers: [m.alice.id, m.bob.id], ctBytes }) } });

  test("a sealed message's ciphertext is at most what its words and file keys need", async () => {
    const ok = await sealedAsk(140 * 1024);
    assert.equal(ok.status, 200, JSON.stringify(ok).slice(0, 300));
    const big = await sealedAsk(300 * 1024);
    assert.equal(big.status, 400, 'a 300 KB envelope is refused');
    assert.equal(big.code, 'bad_envelope');
  });

  test('a read of many large messages comes in pages by bytes, and says there is more', async () => {
    for (let i = 0; i < 60; i++) assert.equal((await sealedAsk(150 * 1024)).status, 200);
    const page = await call(R.base, 'GET', '/api/messages?limit=1000', { token: m.bob.token });
    assert.equal(page.status, 200);
    assert.ok(page.messages.length < 61, `${page.messages.length} messages in one page`);
    assert.equal(page.more, true, 'it says there is more');
    // paging back with `before` reaches every one
    const seen = new Set(page.messages.map((x) => x.id));
    let before = page.messages[0].id;
    for (let i = 0; i < 10; i++) {
      const p = await call(R.base, 'GET', `/api/messages?limit=1000&before=${before}`, { token: m.bob.token });
      p.messages.forEach((x) => seen.add(x.id));
      if (!p.more) break;
      before = p.messages[0].id;
    }
    const sealed = [...seen].length;
    assert.ok(sealed >= 61, `${sealed} read in all`);
  });
});

for (const kind of ['fs', 'redis']) {
  test(`on the ${kind} store, a member's messages past its share of bytes go first: its own oldest`, async () => {
    const procs = new Set();
    const fake = kind === 'redis' ? await startFakeUpstash() : null;
    try {
      const env = kind === 'fs' ? { SPHERE_DATA: path.join(T.dir, 'share-bytes') } : { SPHERE_STORE: 'redis', UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, SPHERE_REDIS_PREFIX: 'sharebytes:', SPHERE_COMPACT_WAIT_MS: '0' };
      const R = await relay({ ...env, SPHERE_WRITES_PER_MIN: '100000' }, { tmp: T.dir, procs });
      const m = await members(R.base, ['alice', 'mallory']);
      assert.equal((await call(R.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { maxAgentBytes: MB } })).status, 200);
      const keep = await call(R.base, 'POST', '/api/messages', { token: m.alice.token, body: { text: 'Alice Test: the BADGER-12 plan' } });
      for (let i = 0; i < 80; i++) assert.equal((await call(R.base, 'POST', '/api/messages', { token: m.mallory.token, body: { text: `${i} `.padEnd(20000, 'm') } })).status, 200);
      await call(R.base, 'GET', '/api/info', { key: KEY }); // a request after the last post: the cut comes before it
      const held = (await call(R.base, 'GET', '/api/messages?limit=1000', { admin: ADMIN })).messages;
      const hers = held.filter((x) => x.from === m.mallory.id);
      const bytes = hers.reduce((n, x) => n + x.text.length, 0);
      assert.ok(bytes <= 1.1 * MB, `mallory holds ${bytes} bytes of messages`);
      assert.ok(hers.length < 80 && hers.length > 40, `${hers.length} of hers held`);
      assert.ok(hers.at(-1).text.startsWith('79 '), 'her newest stay');
      assert.ok(held.some((x) => x.id === keep.message.id), "alice's message stays");
      const cuts = (await audit(R.base)).filter((e) => e.type === 'expire' && e.target === m.mallory.id);
      assert.ok(cuts.length >= 1, 'the cut is audited, naming her');
      assert.match(cuts[0].detail, /mallory/);
      assert.equal((await call(R.base, 'GET', '/api/audit', { key: KEY })).verified, true, 'the chain verifies');
    } finally {
      [...procs].forEach((p) => p.kill());
      await fake?.close();
    }
  });
}
