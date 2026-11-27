// Members and what they say (security audit, findings 13, 16 and 17): an admin can release a
// removed member's handle (audited), and a Sphere holds at most policy.maxAgents members; one Oby
// asked together with another can't replace or clear the other's `waiting`; re-attaching another
// member's file in a sealed message doesn't rename that file; and the relay strips invisible
// characters from what members write. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { KEY, ADMIN, relay, call, audit, tempDir, members, envelope } from './relay-hardening-helpers.mjs';

let T;
before(() => (T = tempDir('hardening-members')));
after(() => T.remove());

describe('handles and how many members', () => {
  const procs = new Set();
  let R, m;
  before(async () => {
    R = await relay({ SPHERE_DATA: path.join(T.dir, 'handles') }, { tmp: T.dir, procs });
    m = await members(R.base, ['alice', 'bob', 'carol']);
  });
  after(() => [...procs].forEach((p) => p.kill()));
  const join = (name) => call(R.base, 'POST', '/api/join', { key: KEY, body: { name, owner: 'Someone Test' } });

  test("an admin releases a removed member's handle, and it can be taken again", async () => {
    const bobPost = await call(R.base, 'POST', '/api/messages', { token: m.bob.token, body: { text: 'bob was here' } });
    assert.equal((await call(R.base, 'DELETE', `/api/admin/agents/${m.bob.id}`, { admin: ADMIN })).status, 200);
    assert.equal((await join('bob')).code, 'name_taken', 'removed: not given out again');
    assert.equal((await call(R.base, 'POST', `/api/admin/agents/${m.bob.id}/release`, { token: m.carol.token })).status, 403, 'admins only');
    assert.equal((await call(R.base, 'POST', `/api/admin/agents/${m.alice.id}/release`, { admin: ADMIN })).status, 409, 'not a member who is still here');
    const r = await call(R.base, 'POST', `/api/admin/agents/${m.bob.id}/release`, { admin: ADMIN });
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(r.agent.removed, true);
    assert.equal(r.agent.released, true);
    const ev = (await audit(R.base)).filter((e) => e.type === 'release');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].target, m.bob.id);
    assert.equal(ev[0].actor, 'operator');
    assert.equal((await call(R.base, 'POST', `/api/admin/agents/${m.bob.id}/release`, { admin: ADMIN })).status, 200, 'again: nothing changes');
    assert.equal((await audit(R.base)).filter((e) => e.type === 'release').length, 1);
    const again = await join('bob');
    assert.equal(again.status, 200, JSON.stringify(again));
    assert.notEqual(again.agent.id, m.bob.id, 'a new member, not the old one back');
    assert.equal((await call(R.base, 'GET', `/api/messages/${bobPost.message.id}`, { key: KEY })).message.from, m.bob.id, 'old messages keep their author');
    assert.equal((await call(R.base, 'GET', '/api/audit', { key: KEY })).verified, true);
  });

  test('a Sphere holds at most policy.maxAgents members', async () => {
    assert.equal((await call(R.base, 'GET', '/api/info', { key: KEY })).sphere.policy.maxAgents, 1000, 'the default');
    for (const bad of [0, 1, 100001, 2.5, '10']) assert.equal((await call(R.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { maxAgents: bad } })).status, 400, String(bad));
    const here = (await call(R.base, 'GET', '/api/agents', { key: KEY })).agents.filter((a) => !a.removed).length;
    assert.equal((await call(R.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { maxAgents: here + 1 } })).status, 200);
    assert.equal((await join('dave')).status, 200);
    const full = await join('erin');
    assert.equal(full.status, 403);
    assert.equal(full.code, 'full');
    assert.ok((await audit(R.base)).some((e) => e.type === 'deny' && /^full/.test(e.detail)));
    // a removed member no longer counts
    assert.equal((await call(R.base, 'DELETE', `/api/admin/agents/${m.carol.id}`, { admin: ADMIN })).status, 200);
    assert.equal((await join('erin')).status, 200);
  });
});

describe("other members' metadata", () => {
  const procs = new Set();
  let R, m;
  before(async () => {
    R = await relay({ SPHERE_DATA: path.join(T.dir, 'meta') }, { tmp: T.dir, procs });
    m = await members(R.base, ['alice', 'bob', 'carol']);
  });
  after(() => [...procs].forEach((p) => p.kill()));
  const inMin = (n) => new Date(Date.now() + n * 60e3).toISOString();
  const wait = (who, id, body) => call(R.base, 'POST', `/api/messages/${id}/waiting`, { token: m[who].token, body });
  const ask = async () => (await call(R.base, 'POST', '/api/messages', { token: m.alice.token, body: { to: ['bob', 'carol'], text: 'both of you?' } })).message.id;
  const waiting = async (id) => (await call(R.base, 'GET', `/api/messages/${id}`, { key: KEY })).message.waiting;

  test("one Oby asked with another can't replace or clear the other's wait", async () => {
    const id = await ask();
    const bobUntil = inMin(60);
    assert.equal((await wait('bob', id, { for: 'owner', until: bobUntil })).ok, true);
    assert.equal((await wait('carol', id, { for: 'owner', until: inMin(120) })).ok, true);
    let w = await waiting(id);
    assert.equal(w.by, m.bob.id, "bob's wait stays the one older readers see");
    assert.equal(w.until, bobUntil);
    assert.deepEqual(Object.keys(w.each).sort(), [m.bob.id, m.carol.id].sort(), 'each waiting Oby is kept');
    assert.equal((await wait('carol', id, { for: null })).ok, true);
    w = await waiting(id);
    assert.deepEqual(w, { for: 'owner', until: bobUntil, since: w.since, by: m.bob.id }, "carol clearing hers leaves bob's, in the shape of one");
    assert.equal((await wait('bob', id, { for: null })).ok, true);
    assert.equal(await waiting(id), undefined, 'none left');
  });

  test("when the first one's owner decides, the other's wait is the one shown", async () => {
    const id = await ask();
    const carolUntil = inMin(90);
    await wait('bob', id, { for: 'owner', until: inMin(60) });
    await wait('carol', id, { for: 'owner', until: carolUntil });
    await wait('bob', id, { for: null });
    const w = await waiting(id);
    assert.equal(w.by, m.carol.id);
    assert.equal(w.until, carolUntil);
  });

  test("re-attaching another member's file in a sealed message doesn't rename it", async () => {
    const up = await fetch(R.base + '/api/files', { method: 'POST', headers: { authorization: `Bearer ${m.alice.token}`, 'x-file-name': 'report.txt', 'content-type': 'text/plain' }, body: 'the GROUSE-8 report' });
    const f = (await up.json()).file;
    assert.equal((await call(R.base, 'POST', '/api/messages', { token: m.alice.token, body: { text: 'the report', files: [{ id: f.id }] } })).status, 200);
    const sealed = envelope(m.bob.keys, { from: m.bob.id, to: [m.carol.id], readers: [m.bob.id, m.carol.id] });
    const r = await call(R.base, 'POST', '/api/messages', { token: m.bob.token, body: { to: ['carol'], text: '', sealed, files: [{ id: f.id }] } });
    assert.equal(r.status, 200, JSON.stringify(r));
    const now = (await call(R.base, 'GET', '/api/files', { key: KEY })).files.find((x) => x.id === f.id);
    assert.equal(now.name, 'report.txt');
    assert.equal(now.mime, 'text/plain');
  });
});

test('the relay strips invisible characters from what members write', async () => {
  const procs = new Set();
  try {
    const R = await relay({ SPHERE_DATA: path.join(T.dir, 'invisible') }, { tmp: T.dir, procs });
    const j = await call(R.base, 'POST', '/api/join', { key: KEY, body: { name: 'alice', owner: 'Alice​ Test⁠', about: 'notes\u{E0049}\u{E0047}\u{E004E}' } });
    assert.equal(j.agent.owner, 'Alice Test');
    assert.equal(j.agent.about, 'notes');
    const hidden = 'a​b‌c‍d⁠e﻿f\u{E0041}\u{E0042}g️h\u{E0100}i­j‮k⁦l᠎m';
    const r = await call(R.base, 'POST', '/api/messages', { token: j.token, body: { text: `${hidden} line para` } });
    assert.equal(r.message.text, 'abcdefghijklm\nline\npara');
    const emoji = 'team \u{1F469}‍\u{1F4BB} and \u{1F468}\u{1F3FD}‍\u{1F52C}, \u{1F3F3}️‍\u{1F308}';
    const e = await call(R.base, 'POST', '/api/messages', { token: j.token, body: { text: emoji } });
    assert.equal(e.message.text, emoji, 'a joiner between emoji stays, and the emoji selector after one');
    // what writing needs stays, with no room for hidden words: ❤️ and 1️⃣ keep their selector (one, after
    // an emoji only), Persian its non-joiner, England its flag; any other tag, a second selector, a
    // non-joiner in Latin text go
    const needs = 'I \u2764\uFE0F it, 1\uFE0F\u20E3 \u{1F600}\uFE0F\uFE0F, \u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645, a\u200Cb, \u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} \u{1F3F4}\u{E0068}\u{E0069}\u{E007F}';
    const n = await call(R.base, 'POST', '/api/messages', { token: j.token, body: { text: needs } });
    assert.equal(n.message.text, 'I \u2764\uFE0F it, 1\uFE0F\u20E3 \u{1F600}\uFE0F, \u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645, ab, \u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} \u{1F3F4}');
    const topic = await call(R.base, 'POST', '/api/channels', { token: j.token, body: { name: 'plans', topic: 'the​ plan\u{E0020}' } });
    assert.equal(topic.channel.topic, 'the plan');
  } finally {
    [...procs].forEach((p) => p.kill());
  }
});
