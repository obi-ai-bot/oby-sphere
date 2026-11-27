// Who reaches what (security audit, findings 7, 8, 9, 11 and 12): an admin's open stream stops
// seeing closed channels once it's no longer an admin; tool counters count only the instruments
// the relay knows, and reads are rate-limited per agent, and a viewer's per address; behind a trusted proxy
// the client's address is the proxy's entry (the rightmost), and IPv6 clients count by their /64;
// a member taken out of a private channel can still delete its own messages there; and only on
// Vercel does ?__path= choose the route. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { KEY, ADMIN, relay, call, tempDir, members, listen, until, sleep } from './relay-hardening-helpers.mjs';

let T;
before(() => (T = tempDir('hardening-access')));
after(() => T.remove());

describe('streams and roles', () => {
  const procs = new Set();
  let R, m;
  before(async () => {
    R = await relay({ SPHERE_DATA: path.join(T.dir, 'roles'), SPHERE_WRITES_PER_MIN: '100000' }, { tmp: T.dir, procs });
    m = await members(R.base, ['alice', 'bob', 'carol']);
  });
  after(() => [...procs].forEach((p) => p.kill()));

  test("an admin's open stream stops seeing a private channel once it's no longer an admin", async () => {
    assert.equal((await call(R.base, 'POST', '/api/admin/claim', { token: m.alice.token, admin: ADMIN })).status, 200);
    assert.equal((await call(R.base, 'POST', '/api/channels', { token: m.bob.token, body: { name: 'secret', private: true, members: ['carol'] } })).status, 200);
    const s = listen(R.base, { authorization: `Bearer ${m.alice.token}` }, '?role=console');
    await s.ready;
    const words = (t) => s.got.some(([e, d]) => e === 'message' && d.text === t);
    assert.equal((await call(R.base, 'POST', '/api/messages', { token: m.bob.token, body: { channel: 'secret', text: 'first SECRET-1' } })).status, 200);
    assert.ok(await until(() => words('first SECRET-1')), 'an admin sees it');
    assert.equal((await call(R.base, 'POST', `/api/admin/agents/${m.alice.id}/role`, { admin: ADMIN, body: { admin: false } })).status, 200);
    assert.equal((await call(R.base, 'POST', '/api/messages', { token: m.bob.token, body: { channel: 'secret', text: 'second SECRET-2' } })).status, 200);
    assert.equal((await call(R.base, 'POST', '/api/messages', { token: m.bob.token, body: { text: 'in general' } })).status, 200);
    assert.ok(await until(() => words('in general')), 'the stream goes on');
    await sleep(200);
    assert.equal(words('second SECRET-2'), false, 'no longer an admin: not in the channel, not shown');
    s.close();
  });

  test('a member taken out of a private channel can still delete what it wrote there', async () => {
    const posted = await call(R.base, 'POST', '/api/messages', { token: m.carol.token, body: { channel: 'secret', text: 'the TROUT-4 note' } });
    assert.equal(posted.status, 200);
    assert.equal((await call(R.base, 'POST', '/api/channels/secret/members', { token: m.bob.token, body: { remove: ['carol'] } })).status, 200);
    assert.equal((await call(R.base, 'GET', `/api/messages/${posted.message.id}`, { token: m.carol.token })).status, 404, "she can't read it any more");
    const del = await call(R.base, 'DELETE', `/api/messages/${posted.message.id}`, { token: m.carol.token });
    assert.equal(del.status, 200, JSON.stringify(del));
    assert.equal(del.message.deleted.by, m.carol.id);
    assert.equal(del.message.text, undefined);
    // and still nobody else's there
    const bobs = await call(R.base, 'POST', '/api/messages', { token: m.bob.token, body: { channel: 'secret', text: 'bob here' } });
    assert.equal((await call(R.base, 'DELETE', `/api/messages/${bobs.message.id}`, { token: m.carol.token })).status, 404);
  });
});

describe('counters and reads', () => {
  const procs = new Set();
  let R, m;
  before(async () => {
    R = await relay({ SPHERE_DATA: path.join(T.dir, 'reads') }, { tmp: T.dir, procs });
    m = await members(R.base, ['alice', 'mallory']);
  });
  after(() => [...procs].forEach((p) => p.kill()));

  test('only the instruments the relay knows are counted, whatever x-sphere-tool says', async () => {
    for (let i = 0; i < 40; i++) await call(R.base, 'GET', '/api/info', { token: m.mallory.token, headers: { 'x-sphere-tool': `sphere_junk_${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}` } });
    await call(R.base, 'GET', '/api/agents', { token: m.alice.token, headers: { 'x-sphere-tool': 'sphere_agents', 'x-sphere-call': 'c1' } });
    const tools = (await call(R.base, 'GET', '/api/stats', { key: KEY })).tools;
    assert.deepEqual(Object.keys(tools), ['sphere_agents']);
    assert.equal(tools.sphere_agents.calls, 1);
  });

  test('reads are rate-limited per agent', async () => {
    const statuses = [];
    for (let i = 0; i < 700; i++) statuses.push((await fetch(R.base + '/api/info', { headers: { authorization: `Bearer ${m.mallory.token}` } })).status);
    assert.ok(statuses.includes(429), 'past 600 in a minute: 429');
    assert.equal(statuses.slice(0, 500).filter((s) => s !== 200).length, 0, 'a burst of hundreds is fine');
    assert.equal((await call(R.base, 'GET', '/api/info', { token: m.alice.token })).status, 200, 'another member still reads');
  });

  test("and a viewer's per address; a member's reads don't count there", async () => {
    const statuses = [];
    for (let i = 0; i < 40 && !statuses.includes(429); i++)
      statuses.push(...(await Promise.all(Array.from({ length: 100 }, () => fetch(R.base + '/api/info', { headers: { 'x-sphere-key': KEY } }).then((r) => (r.arrayBuffer(), r.status))))));
    assert.ok(statuses.includes(429), 'past 3,000 in a minute from one address: 429');
    assert.equal(statuses.slice(0, 2900).filter((s) => s !== 200).length, 0, "the members' reads before this one came from this address too, and don't count");
    assert.equal((await call(R.base, 'GET', '/api/info', { token: m.alice.token })).status, 200, 'a member there still reads');
  });
});

describe('client addresses behind a trusted proxy', () => {
  const procs = new Set();
  let R;
  before(async () => {
    R = await relay({ SPHERE_DATA: path.join(T.dir, 'proxy'), SPHERE_TRUST_PROXY: '1' }, { tmp: T.dir, procs });
  });
  after(() => [...procs].forEach((p) => p.kill()));
  const join = (xff) => fetch(R.base + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff }, body: JSON.stringify({ key: 'not-the-key-of-this-sphere-at-all', name: 'x' }) });

  test('the proxy\'s entry counts, not one the client put before it', async () => {
    const statuses = [];
    for (let i = 0; i < 25; i++) statuses.push((await join(`10.9.${i}.${i}, 203.0.113.7`)).status);
    assert.equal(statuses.at(-1), 429, `a new spoofed address each time is still one client: ${statuses.join(',')}`);
    assert.equal((await join('203.0.113.7, 198.51.100.9')).status, 401, 'another client is not limited');
  });

  test('IPv6 clients count by their /64', async () => {
    const statuses = [];
    for (let i = 1; i <= 25; i++) statuses.push((await join(`2001:db8:1:2::${i.toString(16)}`)).status);
    assert.equal(statuses.at(-1), 429, statuses.join(','));
    assert.equal((await join('2001:db8:1:3::1')).status, 401, 'the next /64 is another client');
  });

  test('two proxies in a row: SPHERE_TRUST_PROXY=2 takes the second from the right', async () => {
    const R2 = await relay({ SPHERE_DATA: path.join(T.dir, 'proxy2'), SPHERE_TRUST_PROXY: '2' }, { tmp: T.dir, procs });
    const statuses = [];
    for (let i = 0; i < 22; i++) statuses.push((await fetch(R2.base + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `1.1.1.${i}, 203.0.113.8, 10.0.0.${i}` }, body: JSON.stringify({ key: 'nope-not-the-key-of-this-sphere', name: 'x' }) })).status);
    assert.equal(statuses.at(-1), 429, statuses.join(','));
    const other = await fetch(R2.base + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.1.1.1, 198.51.100.77, 10.0.0.1' }, body: JSON.stringify({ key: 'nope-not-the-key-of-this-sphere', name: 'x' }) });
    assert.equal(other.status, 401, 'another client behind the same two proxies is not limited');
    await R2.stop();
  });
});

test('?__path= chooses the route only on Vercel', async () => {
  const procs = new Set();
  try {
    const R = await relay({ SPHERE_DATA: path.join(T.dir, 'path') }, { tmp: T.dir, procs });
    const r = await fetch(R.base + '/healthz?__path=' + encodeURIComponent('/api/agents'), { headers: { 'x-sphere-key': KEY } });
    const body = await r.json();
    assert.equal(body.ok, true, 'it is /healthz, as the path says');
    assert.equal(body.agents, undefined);
    const page = await fetch(R.base + '/?__path=' + encodeURIComponent('/api/info'), { headers: { 'x-sphere-key': KEY } });
    assert.match(page.headers.get('content-type'), /text\/html/);
  } finally {
    [...procs].forEach((p) => p.kill());
  }
});
