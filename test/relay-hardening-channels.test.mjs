// Channels one member can't pile up (second security audit, R10): each is a record every instance
// holds, saves and sends to every reader, so a member makes at most 50 (by POST /api/channels or by
// posting to a new name), a Sphere holds at most 2,000 and 20,000 direct conversations, and an
// admin isn't held to a member's 50. `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ADMIN, relay, call, audit, tempDir, members } from './relay-hardening-helpers.mjs';

test('a member makes at most 50 channels; an admin more', async () => {
  const T = tempDir('hardening-channels');
  const procs = new Set();
  try {
    const R = await relay({ SPHERE_DATA: path.join(T.dir, 'c'), SPHERE_WRITES_PER_MIN: '100000' }, { tmp: T.dir, procs });
    const m = await members(R.base, ['alice', 'bob', 'mallory']);
    for (let i = 0; i < 50; i++) assert.equal((await call(R.base, 'POST', '/api/channels', { token: m.mallory.token, body: { name: `c${i}`, private: i % 2 === 1 } })).status, 200);
    const more = await call(R.base, 'POST', '/api/channels', { token: m.mallory.token, body: { name: 'c50' } });
    assert.equal(more.status, 409);
    assert.equal(more.code, 'too_many_channels');
    const byPost = await call(R.base, 'POST', '/api/messages', { token: m.mallory.token, body: { channel: 'c51', text: 'a new channel by posting' } });
    assert.equal(byPost.status, 409, 'nor by posting to a new name');
    assert.equal((await call(R.base, 'POST', '/api/messages', { token: m.mallory.token, body: { channel: 'c1', text: 'an old one still works' } })).status, 200);
    assert.equal((await call(R.base, 'POST', '/api/dm', { token: m.mallory.token, body: { with: 'alice' } })).status, 200, 'a direct conversation is one per pair, apart');
    assert.equal((await call(R.base, 'POST', '/api/channels', { token: m.bob.token, body: { name: 'bobs' } })).status, 200, 'another member still makes channels');
    assert.equal((await audit(R.base)).filter((e) => e.type === 'deny' && /too_many_channels/.test(e.detail)).length, 1, 'refusals are audited once a minute');
    // an admin member isn't held to it
    assert.equal((await call(R.base, 'POST', '/api/admin/claim', { token: m.alice.token, admin: ADMIN })).status, 200);
    for (let i = 0; i < 52; i++) assert.equal((await call(R.base, 'POST', '/api/channels', { token: m.alice.token, body: { name: `a${i}` } })).status, 200);
  } finally {
    [...procs].forEach((p) => p.kill());
    T.remove();
  }
});
