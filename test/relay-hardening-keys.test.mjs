// A join key rotated through the API stays rotated (second security audit, R1): a restart, a cold
// start or a second instance with the same SPHERE_KEY doesn't bring the old key back. SPHERE_KEY is
// applied at start only when the operator changed it, and that change is audited. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startFakeUpstash } from './fake-upstash.mjs';
import { KEY, ADMIN, relay, call, audit, tempDir } from './relay-hardening-helpers.mjs';

let T;
before(() => (T = tempDir('hardening-keys')));
after(() => T.remove());
const sha = (x) => createHash('sha256').update(x).digest('hex');
const reads = async (base, key) => (await call(base, 'GET', '/api/agents', { key })).status;
const rotations = async (base) => (await audit(base)).filter((e) => e.type === 'rotate');

test('on Redis, a rotated join key stays rotated when another instance starts', async () => {
  const procs = new Set();
  const fake = await startFakeUpstash();
  try {
    const env = { SPHERE_STORE: 'redis', UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, SPHERE_REDIS_PREFIX: 'rotate:' };
    const A = await relay(env, { tmp: T.dir, procs });
    const rot = await call(A.base, 'POST', '/api/admin/rotate-key', { admin: ADMIN });
    assert.equal(rot.status, 200);
    assert.equal(await reads(A.base, KEY), 401, 'the leaked key is out');
    // a cold start, or Vercel scaling out, with the same SPHERE_KEY
    const B = await relay(env, { tmp: T.dir, procs });
    assert.equal(await reads(B.base, KEY), 401, 'the leaked key stays out on the new instance');
    assert.equal(await reads(A.base, KEY), 401, '... and on the old one');
    assert.equal(await reads(A.base, rot.key), 200, 'the rotated key works');
    assert.equal(await reads(B.base, rot.key), 200);
    assert.equal((await call(A.base, 'POST', '/api/join', { key: KEY, body: { name: 'mallory', owner: 'Mallory' } })).status, 401, 'no join with the leaked key');
    assert.equal((await rotations(A.base)).length, 1, 'one rotation, no other key change');
  } finally {
    [...procs].forEach((p) => p.kill());
    await fake.close();
  }
});

describe('on the fs store with SPHERE_KEY set', () => {
  const procs = new Set();
  const data = () => path.join(T.dir, 'fs');
  let rotated;
  after(() => [...procs].forEach((p) => p.kill()));

  test('a rotated join key stays rotated after a restart', async () => {
    let R = await relay({ SPHERE_DATA: data() }, { tmp: T.dir, procs });
    rotated = (await call(R.base, 'POST', '/api/admin/rotate-key', { admin: ADMIN })).key;
    assert.ok(rotated);
    await R.stop();
    R = await relay({ SPHERE_DATA: data() }, { tmp: T.dir, procs });
    assert.equal(await reads(R.base, KEY), 401, 'the leaked key stays out');
    assert.equal(await reads(R.base, rotated), 200, 'the rotated key works');
    assert.equal((await rotations(R.base)).length, 1);
    await R.stop();
  });

  test('a new SPHERE_KEY is applied at the next start, and audited as the operator\'s', async () => {
    const fresh = 'join-key-from-the-operator-0123456789';
    let R = await relay({ SPHERE_DATA: data(), SPHERE_KEY: fresh }, { tmp: T.dir, procs });
    assert.equal(await reads(R.base, fresh), 200, 'the new key works');
    assert.equal(await reads(R.base, rotated), 401, 'the rotated one is replaced');
    assert.equal(await reads(R.base, KEY), 401);
    const last = (await rotations(R.base)).at(-1);
    assert.equal(last.actor, 'operator');
    assert.match(last.detail, /SPHERE_KEY/);
    assert.equal((await call(R.base, 'GET', '/api/audit', { key: fresh })).verified, true);
    await R.stop();
    // the same value again: nothing changes, nothing is audited
    R = await relay({ SPHERE_DATA: data(), SPHERE_KEY: fresh }, { tmp: T.dir, procs });
    assert.equal(await reads(R.base, fresh), 200);
    assert.equal((await rotations(R.base)).length, 2);
    await R.stop();
  });

  test('a Sphere from before keeps its key silently when SPHERE_KEY is the same, and takes a different one as before, audited', async () => {
    const dir = path.join(T.dir, 'older');
    let R = await relay({ SPHERE_DATA: dir }, { tmp: T.dir, procs });
    await R.stop();
    // as an older relay wrote it: no record of which SPHERE_KEY was applied
    const file = path.join(dir, 'sphere.json');
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete snap.sphere.envKeyHash;
    assert.equal(snap.sphere.keyHash, sha(KEY));
    fs.writeFileSync(file, JSON.stringify(snap), { mode: 0o600 });
    R = await relay({ SPHERE_DATA: dir }, { tmp: T.dir, procs });
    assert.equal(await reads(R.base, KEY), 200);
    assert.equal((await rotations(R.base)).length, 0, 'the same key: no event');
    await R.stop();
    delete snap.sphere.envKeyHash;
    snap.sphere.keyHash = sha('a-key-rotated-before-the-upgrade-0123');
    fs.writeFileSync(file, JSON.stringify(snap), { mode: 0o600 });
    R = await relay({ SPHERE_DATA: dir }, { tmp: T.dir, procs });
    assert.equal(await reads(R.base, KEY), 200, 'SPHERE_KEY wins, as it did before');
    assert.equal((await rotations(R.base)).length, 1, 'and that is audited');
    await R.stop();
  });
});
