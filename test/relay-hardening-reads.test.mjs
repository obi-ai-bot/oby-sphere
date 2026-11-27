// Reads one caller can't turn against everyone (second security audit, R6, R7, R27 and R59): an
// ask's replies come in pages by bytes, and one Oby gives at most 10 replies to one ask; a reader
// that never takes its answers holds a few at a time and is dropped when it stalls; a viewer
// flooding reads from the members' own address doesn't block their reads or their streams; and a
// long-poll decides what its caller sees when it answers, not when it started. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { KEY, ADMIN, relay, call, tempDir, members, envelope, sleep } from './relay-hardening-helpers.mjs';

let T;
before(() => (T = tempDir('hardening-reads')));
after(() => T.remove());

describe("an ask's replies", () => {
  const procs = new Set();
  let R, m, ask;
  const who = ['bob', 'carol', 'dave', 'erin', 'frank', 'grace'];
  before(async () => {
    R = await relay({ SPHERE_DATA: path.join(T.dir, 'replies'), SPHERE_WRITES_PER_MIN: '100000', SPHERE_ASKS_PER_MIN: '100000' }, { tmp: T.dir, procs });
    m = await members(R.base, ['alice', ...who]);
    const ids = who.map((n) => m[n].id);
    const sealed = envelope(m.alice.keys, { from: m.alice.id, to: ids, readers: [m.alice.id, ...ids] });
    ask = (await call(R.base, 'POST', '/api/messages', { token: m.alice.token, body: { to: ids, text: '', sealed } })).message;
    assert.ok(ask?.id);
  });
  after(() => [...procs].forEach((p) => p.kill()));
  const reply = (n, ctBytes = 64) =>
    call(R.base, 'POST', '/api/messages', { token: m[n].token, body: { replyTo: ask.id, text: '', sealed: envelope(m[n].keys, { from: m[n].id, replyTo: ask.id, readers: [m[n].id, m.alice.id], ctBytes }) } });

  test('one Oby gives at most 10 replies to one ask', async () => {
    for (let i = 0; i < 10; i++) assert.equal((await reply('bob', 150 * 1024)).status, 200);
    const more = await reply('bob');
    assert.equal(more.status, 409);
    assert.equal(more.code, 'too_many_replies');
  });

  test('a read of the ask, or of its replies, is paged by bytes and says there is more', async () => {
    for (const n of who.slice(1)) for (let i = 0; i < 10; i++) assert.equal((await reply(n, 150 * 1024)).status, 200);
    for (const url of [`/api/messages/${ask.id}`, `/api/messages/${ask.id}/replies`]) {
      const first = await call(R.base, 'GET', url, { key: KEY });
      assert.equal(first.status, 200);
      assert.ok(first.replies.length < 60, `${first.replies.length} replies in one read of ${url}`);
      assert.equal(first.more, true);
      const seen = new Set(first.replies.map((r) => r.id));
      let before = first.replies[0].id;
      for (let i = 0; i < 10; i++) {
        const p = await call(R.base, 'GET', `${url}?before=${before}`, { key: KEY });
        assert.equal(p.status, 200);
        p.replies.forEach((r) => seen.add(r.id));
        if (!p.more) break;
        before = p.replies[0].id;
      }
      assert.equal(seen.size, 60, `every reply read through ${url}`);
    }
  });

  test("a reader that doesn't take its answers holds a few at a time, and is dropped when it stalls", { timeout: 60000 }, async () => {
    const socks = [];
    const statuses = [];
    try {
      for (let i = 0; i < 16; i++) {
        const s = net.connect({ port: R.port, host: '127.0.0.1' });
        s.on('error', () => {});
        const first = new Promise((resolve) => s.once('data', (d) => resolve(d.toString('latin1', 0, 12))));
        s.write(`GET /api/messages/${ask.id} HTTP/1.1\r\nHost: x\r\nx-sphere-key: ${KEY}\r\n\r\n`);
        statuses.push((await first).slice(9, 12));
        s.pause(); // and never read the rest
        socks.push(s);
      }
      const ok = statuses.filter((x) => x === '200').length;
      assert.ok(ok >= 1 && ok <= 8, `${ok} answered, the rest refused: ${statuses.join(',')}`);
      assert.ok(statuses.filter((x) => x === '429').length >= 8, statuses.join(','));
      // a member's own reads aren't held up by them
      assert.equal((await call(R.base, 'GET', `/api/messages/${ask.id}`, { token: m.alice.token })).status, 200);
      assert.equal((await call(R.base, 'GET', `/api/messages/${ask.id}`, { key: KEY })).status, 429, 'the address holds as many as it may');
      // stalled: dropped by the relay (in about 20 s), and the address may read again
      const t = Date.now();
      let again = 429;
      while (again === 429 && Date.now() - t < 45000) {
        await sleep(1000);
        again = (await call(R.base, 'GET', `/api/messages/${ask.id}/replies?wait=0`, { key: KEY })).status;
      }
      assert.equal(again, 200, `read again after ${Date.now() - t} ms`);
      assert.ok(Date.now() - t > 5000, 'not before it stalled');
    } finally {
      socks.forEach((s) => s.destroy());
    }
  });
});

describe('members behind one address', () => {
  const procs = new Set();
  let R, m;
  before(async () => {
    R = await relay({ SPHERE_DATA: path.join(T.dir, 'shared') }, { tmp: T.dir, procs });
    m = await members(R.base, ['alice', 'bob']);
  });
  after(() => [...procs].forEach((p) => p.kill()));

  test("a viewer flooding reads from the members' address doesn't block their reads or streams", async () => {
    let refused = 0;
    for (let i = 0; i < 40 && !refused; i++) {
      const got = await Promise.all(Array.from({ length: 100 }, () => fetch(R.base + '/api/info', { headers: { 'x-sphere-key': KEY } }).then((r) => (r.arrayBuffer(), r.status))));
      refused += got.filter((s) => s === 429).length;
    }
    assert.ok(refused > 0, "the viewer's reads are limited");
    assert.equal((await call(R.base, 'GET', '/api/agents', { token: m.alice.token })).status, 200, "a member's reads aren't");
    // the viewer holds every stream an address may have; the members' Obys still connect
    const views = [];
    for (let i = 0; i < 40; i++) {
      const ac = new AbortController();
      const r = await fetch(R.base + '/api/stream', { headers: { 'x-sphere-key': KEY }, signal: ac.signal }).catch(() => null);
      views.push(ac);
      if (r?.status === 429) break;
    }
    try {
      const ac = new AbortController();
      const r = await fetch(R.base + '/api/stream?role=rep', { headers: { authorization: `Bearer ${m.bob.token}` }, signal: ac.signal });
      assert.equal(r.status, 200, "bob's Oby connects");
      ac.abort();
    } finally {
      views.forEach((ac) => ac.abort());
    }
  });
});

test('a long-poll decides what its caller sees when it answers: a demoted admin gets no private reply', { timeout: 30000 }, async () => {
  const procs = new Set();
  try {
    const R = await relay({ SPHERE_DATA: path.join(T.dir, 'poll') }, { tmp: T.dir, procs });
    const m = await members(R.base, ['alice', 'bob', 'carol']);
    assert.equal((await call(R.base, 'POST', '/api/admin/claim', { token: m.alice.token, admin: ADMIN })).status, 200);
    assert.equal((await call(R.base, 'POST', '/api/channels', { token: m.bob.token, body: { name: 'secret', private: true, members: ['carol'] } })).status, 200);
    const ask = (await call(R.base, 'POST', '/api/messages', { token: m.carol.token, body: { channel: 'secret', to: ['bob'], text: 'the question' } })).message;
    const poll = call(R.base, 'GET', `/api/messages/${ask.id}/replies?wait=20`, { token: m.alice.token });
    await sleep(300);
    assert.equal((await call(R.base, 'POST', `/api/admin/agents/${m.alice.id}/role`, { admin: ADMIN, body: { admin: false } })).status, 200);
    assert.equal((await call(R.base, 'POST', '/api/messages', { token: m.bob.token, body: { channel: 'secret', replyTo: ask.id, text: 'the PRIVATE-7 answer' } })).status, 200);
    const got = await poll;
    assert.ok(!JSON.stringify(got).includes('PRIVATE-7'), JSON.stringify(got));
    assert.equal(got.status, 404);
    // an admin who stays one gets it
    const again = call(R.base, 'GET', `/api/messages/${ask.id}/replies?wait=5`, { admin: ADMIN });
    assert.ok((await again).replies.some((r) => r.text === 'the PRIVATE-7 answer'));
  } finally {
    [...procs].forEach((p) => p.kill());
  }
});
