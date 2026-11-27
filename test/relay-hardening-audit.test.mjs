// The audit log can't be flooded (security audit, finding 1): a refusal of a caller with no
// credential leaves no event; rate-limited and forbidden refusals are audited at most once a
// minute per caller and kind; refused deletes count as writes; a request with no credential
// costs the Redis store nothing; and a log the relay can't read stops it at start instead of
// starting empty. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFakeUpstash } from './fake-upstash.mjs';
import { KEY, ADMIN, relay, call, audit, tempDir, until, sleep } from './relay-hardening-helpers.mjs';

let T;
before(() => (T = tempDir('hardening-audit')));
after(() => T.remove());

const join = (base, { key, header = true, name = 'x' } = {}) =>
  call(base, 'POST', '/api/join', { ...(key && header ? { key } : {}), body: { name, owner: 'Mallory', ...(key && !header ? { key } : {}) } });
const denies = async (base, re) => (await audit(base)).filter((e) => e.type === 'deny' && (!re || re.test(e.detail)));

describe('refusals on the join route', () => {
  const procs = new Set();
  let R;
  before(async () => {
    R = await relay({ SPHERE_DATA: path.join(T.dir, 'join') }, { tmp: T.dir, procs });
  });
  after(() => [...procs].forEach((p) => p.kill()));

  test('a join flood with the key: one deny a minute, not one a request', async () => {
    const statuses = [];
    for (let i = 0; i < 25; i++) statuses.push((await join(R.base, { key: KEY })).status); // a handle too short: 400 once the key is checked
    assert.deepEqual(statuses.slice(0, 20), Array(20).fill(400));
    assert.deepEqual(statuses.slice(20), Array(5).fill(429));
    assert.equal((await denies(R.base, /rate_limited/)).length, 1, 'the first rate-limited join is audited, the rest of the minute is not');
  });

  test('refused joins with no key, or a wrong one, past the rate limit leave no event', async () => {
    const before = (await audit(R.base)).length;
    const statuses = [];
    for (let i = 0; i < 30; i++) statuses.push((await join(R.base)).status);
    for (let i = 0; i < 30; i++) statuses.push((await join(R.base, { key: 'not-the-key-of-this-sphere-at-all' })).status);
    assert.ok(statuses.every((s) => s === 429), statuses.join(','));
    assert.equal((await audit(R.base)).length, before, 'nothing was added to the audit log');
  });

  test('a join with no key at all is refused without an event; a wrong key is audited once a minute', async () => {
    // a fresh minute's worth of joins for this address
    assert.equal((await call(R.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { rate: { joinsPerMinPerIp: 600 } } })).status, 200);
    await sleep(2500); // ten a second come back
    const before = (await denies(R.base)).length;
    for (let i = 0; i < 10; i++) assert.equal((await join(R.base)).status, 401);
    assert.equal((await denies(R.base)).length, before, 'no credential, no event');
    for (let i = 0; i < 10; i++) assert.equal((await join(R.base, { key: 'not-the-key-of-this-sphere-at-all', header: false })).status, 401);
    assert.equal((await denies(R.base, /wrong key/)).length, 1, 'a wrong key: audited, once a minute');
  });
});

test("a member's refused deletes are writes: rate-limited, and audited once a minute", async () => {
  const procs = new Set();
  try {
    const R = await relay({ SPHERE_DATA: path.join(T.dir, 'delete'), SPHERE_WRITES_PER_MIN: '30' }, { tmp: T.dir, procs });
    const m = await call(R.base, 'POST', '/api/join', { key: KEY, body: { name: 'mallory', owner: 'Mallory' } });
    const system = (await call(R.base, 'GET', '/api/messages', { token: m.token })).messages.find((x) => x.kind === 'system');
    assert.ok(system);
    const statuses = [];
    for (let i = 0; i < 40; i++) statuses.push((await call(R.base, 'DELETE', `/api/messages/${system.id}`, { token: m.token })).status);
    assert.deepEqual(statuses.slice(0, 30), Array(30).fill(403), statuses.join(','));
    assert.deepEqual(statuses.slice(30), Array(10).fill(429), 'refused deletes count as writes');
    const mine = (await denies(R.base)).filter((e) => e.actor === m.agent.id);
    assert.equal(mine.filter((e) => /^forbidden/.test(e.detail)).length, 1, 'forbidden: once a minute');
    assert.equal(mine.filter((e) => /^rate_limited/.test(e.detail)).length, 1, 'rate-limited: once a minute');
  } finally {
    [...procs].forEach((p) => p.kill());
  }
});

test('on Redis, a request with no credential costs no Redis command', async () => {
  const procs = new Set();
  const fake = await startFakeUpstash();
  try {
    const R = await relay({ SPHERE_STORE: 'redis', UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, SPHERE_REDIS_PREFIX: 'nocred:' }, { tmp: T.dir, procs });
    const n = fake.commands();
    for (let i = 0; i < 20; i++) assert.equal((await call(R.base, 'GET', '/api/agents')).status, 401);
    for (let i = 0; i < 5; i++) assert.equal((await call(R.base, 'POST', '/api/messages', { body: { text: 'hi' } })).status, 401);
    assert.equal(fake.commands(), n, 'no read of the log for a caller with nothing to show');
    assert.equal((await call(R.base, 'GET', '/api/agents', { key: KEY })).status, 200, 'a viewer still reads');
  } finally {
    [...procs].forEach((p) => p.kill());
    await fake.close();
  }
});

describe("a log the relay can't read stops it at start", () => {
  const procs = new Set();
  const dir = () => path.join(T.dir, 'unreadable');
  let words;
  before(async () => {
    const R = await relay({ SPHERE_DATA: dir() }, { tmp: T.dir, procs });
    const a = await call(R.base, 'POST', '/api/join', { key: KEY, body: { name: 'alice', owner: 'Alice Test' } });
    words = 'the OTTER-91 plan';
    assert.equal((await call(R.base, 'POST', '/api/messages', { token: a.token, body: { text: words } })).status, 200);
    await R.stop();
  });
  after(() => {
    for (const f of ['messages.jsonl', 'audit.jsonl']) fs.chmodSync(path.join(dir(), f), 0o600);
    [...procs].forEach((p) => p.kill());
  });

  for (const file of ['messages.jsonl', 'audit.jsonl']) {
    test(`${file} that can be written but not read: the relay says so and stops, and keeps it as it was`, async (t) => {
      if (process.getuid?.() === 0) return t.skip('root reads any file');
      const f = path.join(dir(), file);
      const was = fs.readFileSync(f);
      fs.chmodSync(f, 0o200);
      try {
        const R = await relay({ SPHERE_DATA: dir() }, { tmp: T.dir, procs, wait: false });
        const code = await Promise.race([R.exited, new Promise((r) => setTimeout(() => r('still running'), 8000))]);
        if (code === 'still running') await R.stop();
        assert.notEqual(code, 'still running', 'it must not start on an empty log');
        assert.notEqual(code, 0);
        assert.match(R.errs(), new RegExp(file.replace('.', '\\.')), R.errs());
      } finally {
        fs.chmodSync(f, 0o600);
      }
      assert.deepEqual(fs.readFileSync(f), was, 'the log is as it was');
      const R = await relay({ SPHERE_DATA: dir() }, { tmp: T.dir, procs });
      const held = await until(async () => (await call(R.base, 'GET', '/api/messages', { key: KEY })).messages?.some((m) => m.text === words));
      assert.ok(held, 'the message is still there');
      assert.equal((await call(R.base, 'GET', '/api/audit', { key: KEY })).verified, true);
      await R.stop();
    });
  }
});
