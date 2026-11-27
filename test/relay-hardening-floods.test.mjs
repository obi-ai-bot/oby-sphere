// Floods the audit log and the store can't take (second security audit, R4, R11 and R33; first
// audit, finding 1): failed credentials from many addresses add at most a set number of audit
// events a minute in all, not one per address; on Redis, a caller whose credentials keep failing,
// or a join with no key, costs no Redis command once it's past its limit; and a member opening and
// closing its stream over and over is limited, so presence can't flood the audit log. `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startFakeUpstash } from './fake-upstash.mjs';
import { KEY, relay, call, audit, tempDir, members } from './relay-hardening-helpers.mjs';

const denies = async (base) => (await audit(base)).filter((e) => e.type === 'deny');

test('failed credentials from thousands of addresses add at most 30 audit events a minute', async () => {
  const T = tempDir('hardening-floods-a');
  const procs = new Set();
  try {
    // behind a trusted proxy, the rightmost X-Forwarded-For stands in for each client's own address
    const R = await relay({ SPHERE_DATA: path.join(T.dir, 'a'), SPHERE_TRUST_PROXY: '1' }, { tmp: T.dir, procs });
    const before = (await denies(R.base)).length;
    const statuses = {};
    for (let i = 0; i < 600; i++) {
      const r = await fetch(R.base + '/api/agents', { headers: { authorization: 'Bearer x', 'x-forwarded-for': `2001:db8:0:${i.toString(16)}::1` } });
      statuses[r.status] = (statuses[r.status] || 0) + 1;
      await r.arrayBuffer();
    }
    assert.deepEqual(statuses, { 401: 600 }, 'each is refused');
    const added = (await denies(R.base)).slice(before);
    assert.ok(added.length <= 30, `${added.length} deny events`);
    assert.match(added.at(-1).detail, /more failures this minute are counted/, 'the last one says the rest are counted');
    assert.equal((await call(R.base, 'GET', '/api/audit', { key: KEY })).verified, true);
  } finally {
    [...procs].forEach((p) => p.kill());
    T.remove();
  }
});

test('on Redis, junk credentials and keyless joins cost no Redis command past their limit', async () => {
  const T = tempDir('hardening-floods-b');
  const procs = new Set();
  const fake = await startFakeUpstash();
  try {
    const R = await relay({ SPHERE_STORE: 'redis', UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, SPHERE_REDIS_PREFIX: 'junk:' }, { tmp: T.dir, procs });
    const spent = async (n, send) => {
      const was = fake.commands();
      const statuses = {};
      for (let i = 0; i < n; i++) {
        const s = await send();
        statuses[s] = (statuses[s] || 0) + 1;
      }
      return { commands: fake.commands() - was, statuses };
    };
    const bearer = await spent(300, async () => (await call(R.base, 'GET', '/api/agents', { token: 'tok_junk' })).status);
    assert.ok(bearer.commands < 200, `a junk bearer token: ${bearer.commands} commands for 300 requests (${JSON.stringify(bearer.statuses)})`);
    assert.ok(bearer.statuses[429] >= 250, JSON.stringify(bearer.statuses));
    const key = await spent(300, async () => (await call(R.base, 'GET', '/api/agents', { key: 'not-the-key-of-this-sphere-at-all' })).status);
    assert.ok(key.commands < 20, `a junk x-sphere-key from an address already past its limit: ${key.commands} commands`);
    const keyless = await spent(300, async () => (await call(R.base, 'POST', '/api/join', { body: { name: 'mallory', owner: 'Mallory' } })).status);
    assert.equal(keyless.commands, 0, `a join with no key at all: ${keyless.commands} commands (${JSON.stringify(keyless.statuses)})`);
    const wrong = await spent(300, async () => (await call(R.base, 'POST', '/api/join', { key: 'not-the-key-of-this-sphere-at-all', body: { name: 'mallory', owner: 'Mallory' } })).status);
    assert.ok(wrong.commands < 100, `joins with a wrong key: ${wrong.commands} commands (${JSON.stringify(wrong.statuses)})`);
    // the key still works, from the same address
    assert.equal((await call(R.base, 'GET', '/api/agents', { key: KEY })).status, 200);
  } finally {
    [...procs].forEach((p) => p.kill());
    await fake.close();
    T.remove();
  }
});

test("a member opening and closing its stream over and over can't flood the audit log", async () => {
  const T = tempDir('hardening-floods-l');
  const procs = new Set();
  try {
    const R = await relay({ SPHERE_DATA: path.join(T.dir, 'l') }, { tmp: T.dir, procs });
    const { mallory } = await members(R.base, ['mallory']);
    const before = (await audit(R.base)).length;
    const statuses = {};
    const t0 = Date.now();
    for (let i = 0; i < 100; i++) {
      const ac = new AbortController();
      const r = await fetch(R.base + '/api/stream?role=console', { headers: { authorization: `Bearer ${mallory.token}` }, signal: ac.signal });
      statuses[r.status] = (statuses[r.status] || 0) + 1;
      if (r.ok) {
        const it = r.body[Symbol.asyncIterator]();
        await it.next(); // the relay holds it
      }
      ac.abort();
      await new Promise((res) => setTimeout(res, 15));
    }
    assert.ok(statuses[429] > 0, `stream opens are limited: ${JSON.stringify(statuses)}`);
    // 30 a minute, given back one every 2 seconds: a slow run earns a few more
    const earned = Math.ceil((Date.now() - t0) / 2000);
    assert.ok(statuses[200] <= 30 + earned, `${JSON.stringify(statuses)} in ${Date.now() - t0} ms`);
    await new Promise((res) => setTimeout(res, 300));
    const added = (await audit(R.base)).length - before;
    assert.ok(added <= 2 * statuses[200] + 2, `${added} audit events from 100 tries, ${statuses[200]} of them let through`);
    // a viewer's stream isn't one of the member's
    assert.equal((await fetch(R.base + '/api/stream', { headers: { 'x-sphere-key': KEY }, signal: AbortSignal.timeout(500) }).catch(() => ({ status: 'timeout' }))).status, 200);
  } finally {
    [...procs].forEach((p) => p.kill());
    T.remove();
  }
});
