// Names a member sends (security audit, finding 2): a channel name or handle longer than any name
// is refused at once, and no regex runs long on it (the relay keeps answering); names as people
// write them still work. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { KEY, relay, call, tempDir, members } from './relay-hardening-helpers.mjs';

let T;
before(() => (T = tempDir('hardening-names')));
after(() => T.remove());

describe('long names', () => {
  const procs = new Set();
  let R, a;
  before(async () => {
    R = await relay({ SPHERE_DATA: path.join(T.dir, 'names') }, { tmp: T.dir, procs });
    ({ alice: a } = await members(R.base, ['alice']));
  });
  after(() => [...procs].forEach((p) => p.kill()));

  const timed = async (fn) => {
    const t0 = Date.now();
    const r = await fn();
    return { ...r, ms: Date.now() - t0 };
  };
  const long = 'a' + '-'.repeat(150000) + 'a';

  test('a channel name of 150,000 characters is refused at once, and the relay keeps answering', async () => {
    const health = (async () => {
      await new Promise((r) => setTimeout(r, 50));
      return timed(async () => ({ status: (await fetch(R.base + '/healthz')).status }));
    })();
    const r = await timed(() => call(R.base, 'POST', '/api/messages', { token: a.token, body: { channel: long, text: 'hi' } }));
    assert.equal(r.status, 400, JSON.stringify(r));
    assert.ok(r.ms < 1500, `answered in ${r.ms} ms`);
    const h = await health;
    assert.ok(h.ms < 1500, `/healthz waited ${h.ms} ms`);
  });

  test('so is a new channel or a handle as long as their bodies allow', async () => {
    const c = await timed(() => call(R.base, 'POST', '/api/channels', { token: a.token, body: { name: 'a' + '-'.repeat(60000) + 'a' } }));
    assert.equal(c.status, 400);
    assert.ok(c.ms < 1500, `${c.ms} ms`);
    const j = await timed(() => call(R.base, 'POST', '/api/join', { key: KEY, body: { name: 'a' + '-'.repeat(15000) + 'a', owner: 'Mallory' } }));
    assert.equal(j.status, 400);
    assert.ok(j.ms < 1500, `${j.ms} ms`);
  });

  test('names as people write them still work, cut to 32 characters as before', async () => {
    const r = await call(R.base, 'POST', '/api/messages', { token: a.token, body: { channel: '#Design Review: the Q4 roadmap and its many open questions', text: 'hi' } });
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(r.message.channel, 'design-review-the-q4-roadmap-and');
    assert.equal((await call(R.base, 'POST', '/api/messages', { token: a.token, body: { channel: '--x--', text: 'hi' } })).message.channel, 'x');
  });
});
