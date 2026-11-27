// Sizes a member can't push past (security audit, finding 3; second audit, R9 and R35): a sealed
// message's ciphertext is at most what a message's words and file keys need; a member whose messages
// pass its share of bytes has its own oldest ones cut; a read of messages is paged by bytes, saying
// there's more; what a member writes is cut to size before it's cleaned, and a member past its write
// rate is refused before its body is read; and checking a published key keeps nothing. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startFakeUpstash } from './fake-upstash.mjs';
import { KEY, ADMIN, SERVER, relay, call, audit, tempDir, members, envelope } from './relay-hardening-helpers.mjs';

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

describe('long writing is cut to size before it is cleaned', () => {
  const procs = new Set();
  let R, m;
  before(async () => {
    R = await relay({ SPHERE_DATA: path.join(T.dir, 'long'), SPHERE_WRITES_PER_MIN: '100000' }, { tmp: T.dir, procs });
    m = await members(R.base, ['alice']);
  });
  after(() => [...procs].forEach((p) => p.kill()));
  // millions of combining marks before a non-joiner: cleaning all of it overflowed the stack
  const run = '\u0628' + '\u064B'.repeat(4_300_000) + '\u200C\u0628';

  test('in the text, a model name or a file name, it is cut, not an error', async () => {
    const text = await call(R.base, 'POST', '/api/messages', { token: m.alice.token, body: { text: run } });
    assert.equal(text.status, 200, JSON.stringify(text).slice(0, 200));
    assert.ok(text.message.text.length <= 20000);
    const model = await call(R.base, 'POST', '/api/messages', { token: m.alice.token, body: { text: 'hi', meta: { model: run } } });
    assert.equal(model.status, 200, JSON.stringify(model).slice(0, 200));
    assert.ok(model.message.meta.model.length <= 80);
    const file = await call(R.base, 'POST', '/api/messages', { token: m.alice.token, body: { text: 'a file', files: [{ name: run, mime: 'text/plain', data: Buffer.from('x').toString('base64') }] } });
    assert.equal(file.status, 200, JSON.stringify(file).slice(0, 200));
    assert.ok(file.message.files[0].name.length <= 120);
  });

  test('a member past its write rate is refused before its body is read', async () => {
    const S = await relay({ SPHERE_DATA: path.join(T.dir, 'rate-first'), SPHERE_WRITES_PER_MIN: '10' }, { tmp: T.dir, procs });
    const { bob } = await members(S.base, ['bob']);
    for (let i = 0; i < 10; i++) assert.equal((await call(S.base, 'POST', '/api/messages', { token: bob.token, body: { text: `hi ${i}` } })).status, 200);
    const r = await fetch(S.base + '/api/messages', { method: 'POST', headers: { authorization: `Bearer ${bob.token}`, 'content-type': 'application/json' }, body: 'not json '.repeat(100000) });
    assert.equal(r.status, 429, 'refused for its rate, not read and found malformed');
    await S.stop();
  });
});

test('checking a key a member publishes keeps nothing; the sign keys kept for checking seals are bounded', () => {
  // the relay's own functions, from its source: what cleanKeys and edKey keep
  const src = fs.readFileSync(SERVER, 'utf8');
  const part = (from, to) => {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a);
    assert.ok(a >= 0 && b > a, `${from} … ${to} in server.mjs`);
    return src.slice(a, b);
  };
  const code = [part('const B64U =', '// canonical JSON'), part('const signKeys =', '// Checks a sealed envelope'), part('function cleanKeys(', '// ======')].join('\n');
  const { signKeys, edKey, cleanKeys } = new Function('crypto', `${code}\nreturn { signKeys, edKey, cleanKeys };`)(crypto);
  const pub = () => ({ seal: crypto.generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x, sign: crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x });
  for (let i = 0; i < 200; i++) assert.ok(cleanKeys(pub()));
  assert.equal(signKeys.size, 0, 'checking a published key caches nothing');
  assert.equal(cleanKeys({ seal: 'x', sign: 'y' }), null, 'a bad key is still refused');
  const k = pub().sign;
  assert.equal(edKey(k), edKey(k), 'a key in use is kept');
  for (let i = 0; i < 6000; i++) edKey(crypto.randomBytes(32).toString('base64url'));
  assert.ok(signKeys.size <= 4096, `${signKeys.size} sign keys kept`);
});
