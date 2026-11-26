// Admins are members: the claim (a member's token and the admin key, together), what
// an admin member may do with its token alone and what other members may not,
// granting and revoking, the last admin, suspension and removal, live events, the
// audit log (never a key), /api/info, both stores keeping admins across a restart,
// wrong keys rate-limited, the `admin` command, and the console's proxy (the key
// passes through once, for a claim, and never reaches the page). `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { startFakeUpstash } from './fake-upstash.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const KEY = 'join-key-admin-tests-0123456789';
const ADMIN = 'admin-key-admin-tests-0123456789';
const WRONG = 'not-the-admin-key-0123456789ab';

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (name) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sphere-admin-${name}-`)));

async function startRelay({ data, env = {} }) {
  const port = await freePort();
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', ...(data ? ['--data', data] : [])], {
    env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_SEALED: '0', SPHERE_STORE: 'fs', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  p.stderr.on('data', (d) => process.env.SPHERE_TEST_DEBUG && process.stderr.write(`[relay ${port}] ${d}`));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + '/healthz')).ok) return { proc: p, base }; } catch {}
    await sleep(100);
  }
  throw new Error('the relay did not start');
}
const stop = (proc) => new Promise((resolve) => { if (proc.exitCode !== null) return resolve(); proc.once('exit', resolve); proc.kill(); });

function caller(baseOf) {
  return async (method, url, { token, key, admin, body, headers = {}, at } = {}) => {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (key) h['x-sphere-key'] = key;
    if (admin) h['x-admin-key'] = admin;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch((at || baseOf()) + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, ...j };
  };
}

// an open event stream, collecting its events
function openStream(base, headers) {
  const ac = new AbortController();
  const events = [];
  fetch(`${base}/api/stream`, { headers, signal: ac.signal })
    .then(async (r) => {
      const dec = new TextDecoder();
      let buf = '';
      for await (const c of r.body) {
        buf += dec.decode(c, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (\S+)/.exec(block)?.[1];
          const data = block.split('\n').find((l) => l.startsWith('data: '));
          if (ev && data) events.push({ ev, data: JSON.parse(data.slice(6)) });
        }
      }
    })
    .catch(() => {});
  return { events, close: () => ac.abort() };
}
async function until(fn, ms = 4000) {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t > ms) return v;
    await sleep(100);
  }
}

describe('admins on the relay (fs store)', () => {
  let relay, dir;
  const call = caller(() => relay.base);
  let alice, bob, carol, joinKey = KEY;

  before(async () => {
    dir = tmp('fs');
    relay = await startRelay({ data: dir });
    alice = await call('POST', '/api/join', { body: { key: KEY, name: 'alice', owner: 'Alice' } });
    bob = await call('POST', '/api/join', { body: { key: KEY, name: 'bob', owner: 'Bob' } });
    carol = await call('POST', '/api/join', { body: { key: KEY, name: 'carol', owner: 'Carol' } });
    assert.ok(alice.token && bob.token && carol.token);
  });
  after(async () => {
    if (relay) await stop(relay.proc);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('claiming admin needs the token and the admin key together', async () => {
    let info = await call('GET', '/api/info', { token: alice.token });
    assert.equal(info.admin, false);
    assert.equal(info.me.admin, false);
    assert.equal((await call('POST', '/api/admin/claim', { token: alice.token })).status, 403, 'a token alone');
    assert.equal((await call('POST', '/api/admin/claim', { admin: ADMIN })).status, 403, 'the key alone: no member to make an admin');
    assert.equal((await call('POST', '/api/admin/claim', { token: alice.token, admin: WRONG })).status, 401, 'a wrong key');
    assert.equal((await call('GET', '/api/info', { token: alice.token })).me.admin, false);
    const r = await call('POST', '/api/admin/claim', { token: alice.token, admin: ADMIN });
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(r.agent.admin, true);
    assert.equal((await call('POST', '/api/admin/claim', { token: alice.token, admin: ADMIN })).status, 200, 'claiming again is fine');
    info = await call('GET', '/api/info', { token: alice.token });
    assert.equal(info.admin, true);
    assert.equal(info.me.admin, true);
    const au = await call('GET', '/api/audit?limit=1000', { token: bob.token });
    const roles = au.events.filter((e) => e.type === 'role' && e.target === alice.agent.id);
    assert.equal(roles.length, 1, 'one claim, audited once');
    assert.equal(roles[0].actor, alice.agent.id);
    assert.match(roles[0].detail, /alice is an admin now: claimed with the admin key/);
  });

  test('/api/info and the Agent object say who is an admin', async () => {
    const { agents } = await call('GET', '/api/agents', { key: KEY });
    assert.ok(agents.every((a) => typeof a.admin === 'boolean'), 'every agent says admin: true or false');
    assert.deepEqual(agents.filter((a) => a.admin).map((a) => a.name), ['alice']);
    const asKey = await call('GET', '/api/info', { key: KEY, admin: ADMIN });
    assert.equal(asKey.admin, true);
    assert.equal(asKey.me, null);
    const asViewer = await call('GET', '/api/info', { key: KEY });
    assert.equal(asViewer.admin, false);
    const asBob = await call('GET', '/api/info', { token: bob.token });
    assert.equal(asBob.admin, false);
    assert.equal(asBob.me.admin, false);
    // a member who isn't an admin still reads the policy its representative needs
    for (const k of ['sealed', 'maxFileBytes', 'maxDepth']) assert.ok(k in asBob.sphere.policy, k);
  });

  test('an admin member governs with its token alone', async () => {
    assert.deepEqual(await call('GET', '/api/admin/check', { token: alice.token }), { status: 200, ok: true, via: 'member' });
    let r = await call('POST', '/api/admin/policy', { token: alice.token, body: { maxDepth: 2 } });
    assert.equal(r.status, 200);
    assert.equal(r.policy.maxDepth, 2);
    r = await call('POST', `/api/admin/agents/${bob.agent.id}/suspend`, { token: alice.token, body: { suspended: true } });
    assert.equal(r.agent.suspended, true);
    assert.equal((await call('POST', '/api/messages', { token: bob.token, body: { text: 'muted?' } })).code, 'suspended');
    await call('POST', `/api/admin/agents/${bob.agent.id}/suspend`, { token: alice.token, body: { suspended: false } });
    r = await call('POST', '/api/admin/rotate-key', { token: alice.token });
    assert.equal(r.status, 200);
    assert.ok(r.key && r.key !== KEY);
    joinKey = r.key;
    assert.equal((await call('GET', '/api/info', { key: joinKey })).status, 200, 'the new join key opens it');
    const au = await call('GET', '/api/audit?limit=1000', { token: alice.token });
    for (const type of ['policy', 'suspend', 'resume', 'rotate']) {
      const e = au.events.findLast((x) => x.type === type);
      assert.equal(e.actor, alice.agent.id, `${type} is alice's`);
      assert.match(e.detail, / · by alice$/, `${type}: ${e.detail}`);
    }
  });

  test('a member who is not an admin cannot (403)', async () => {
    const tries = [
      ['GET', '/api/admin/check'],
      ['POST', '/api/admin/policy', { maxDepth: 5 }],
      ['POST', `/api/admin/agents/${carol.agent.id}/suspend`, { suspended: true }],
      ['DELETE', `/api/admin/agents/${carol.agent.id}`],
      ['POST', '/api/admin/rotate-key', {}],
      ['POST', `/api/admin/agents/${bob.agent.id}/role`, { admin: true }],
    ];
    for (const [m, u, body] of tries) {
      const r = await call(m, u, { token: bob.token, body });
      assert.equal(r.status, 403, `${m} ${u}`);
      assert.equal(r.code, 'forbidden');
    }
    // a viewer with the join key can't either
    assert.equal((await call('POST', '/api/admin/policy', { key: joinKey, body: { maxDepth: 5 } })).status, 403);
    assert.equal((await call('GET', '/api/info', { token: bob.token })).sphere.policy.maxDepth, 2, 'nothing changed');
  });

  test('admins grant and revoke; the only admin cannot step down by itself', async () => {
    assert.equal((await call('POST', `/api/admin/agents/${bob.agent.id}/role`, { token: alice.token, body: { admin: 'yes' } })).status, 400);
    assert.equal((await call('POST', '/api/admin/agents/a_nobody/role', { token: alice.token, body: { admin: true } })).status, 404);
    let r = await call('POST', `/api/admin/agents/${bob.agent.id}/role`, { token: alice.token, body: { admin: true } });
    assert.equal(r.status, 200);
    assert.equal(r.agent.admin, true);
    assert.equal((await call('POST', '/api/admin/policy', { token: bob.token, body: { maxDepth: 3 } })).policy.maxDepth, 3, 'bob governs now');
    r = await call('POST', `/api/admin/agents/${alice.agent.id}/role`, { token: bob.token, body: { admin: false } });
    assert.equal(r.agent.admin, false);
    assert.equal((await call('GET', '/api/admin/check', { token: alice.token })).status, 403, 'alice no longer');
    r = await call('POST', `/api/admin/agents/${bob.agent.id}/role`, { token: bob.token, body: { admin: false } });
    assert.equal(r.status, 409);
    assert.equal(r.code, 'last_admin');
    assert.match(r.error, /only admin/);
    // with the admin key, the last admin may go (the key still works)
    r = await call('POST', `/api/admin/agents/${bob.agent.id}/role`, { token: bob.token, admin: ADMIN, body: { admin: false } });
    assert.equal(r.agent.admin, false);
    assert.equal((await call('POST', `/api/admin/agents/${alice.agent.id}/role`, { admin: ADMIN, body: { admin: true } })).agent.admin, true, 'the key alone grants');
    assert.equal((await call('POST', `/api/admin/agents/${bob.agent.id}/role`, { token: alice.token, body: { admin: true } })).agent.admin, true);
    assert.equal((await call('POST', `/api/admin/agents/${bob.agent.id}/role`, { token: bob.token, body: { admin: false } })).agent.admin, false, 'one of two may step down');
    // an admin's token can't suspend or remove its own Oby
    assert.equal((await call('POST', `/api/admin/agents/${alice.agent.id}/suspend`, { token: alice.token, body: { suspended: true } })).status, 400);
    assert.equal((await call('DELETE', `/api/admin/agents/${alice.agent.id}`, { token: alice.token })).status, 400);
    // a suspended member isn't made an admin
    await call('POST', `/api/admin/agents/${carol.agent.id}/suspend`, { token: alice.token, body: { suspended: true } });
    assert.equal((await call('POST', `/api/admin/agents/${carol.agent.id}/role`, { token: alice.token, body: { admin: true } })).code, 'target_suspended');
    await call('POST', `/api/admin/agents/${carol.agent.id}/suspend`, { token: alice.token, body: { suspended: false } });
  });

  test('a suspended admin has no power until it is resumed', async () => {
    assert.equal((await call('POST', `/api/admin/agents/${carol.agent.id}/role`, { token: alice.token, body: { admin: true } })).agent.admin, true);
    await call('POST', `/api/admin/agents/${carol.agent.id}/suspend`, { token: alice.token, body: { suspended: true } });
    const info = await call('GET', '/api/info', { token: carol.token });
    assert.equal(info.admin, false, 'no power while suspended');
    assert.equal(info.me.admin, true, 'the role is kept');
    assert.equal((await call('POST', '/api/admin/policy', { token: carol.token, body: { maxDepth: 4 } })).status, 403);
    // the only working admin still can't step down by itself: the suspended one doesn't count
    assert.equal((await call('POST', `/api/admin/agents/${alice.agent.id}/role`, { token: alice.token, body: { admin: false } })).code, 'last_admin');
    await call('POST', `/api/admin/agents/${carol.agent.id}/suspend`, { token: alice.token, body: { suspended: false } });
    assert.equal((await call('GET', '/api/info', { token: carol.token })).admin, true);
  });

  test('role changes reach every stream as agent events', async () => {
    const s = openStream(relay.base, { 'x-sphere-key': joinKey });
    await sleep(200);
    await call('POST', `/api/admin/agents/${bob.agent.id}/role`, { token: alice.token, body: { admin: true } });
    const got = await until(() => s.events.find((e) => e.ev === 'agent' && e.data.id === bob.agent.id && e.data.admin === true));
    await call('POST', `/api/admin/agents/${bob.agent.id}/role`, { token: alice.token, body: { admin: false } });
    const off = await until(() => s.events.find((e) => e.ev === 'agent' && e.data.id === bob.agent.id && e.data.admin === false));
    s.close();
    assert.ok(got && off);
  });

  test('removing an admin drops its role, and the audit log says so', async () => {
    assert.equal((await call('DELETE', `/api/admin/agents/${carol.agent.id}`, { token: alice.token })).status, 200);
    const c = (await call('GET', '/api/agents', { key: joinKey })).agents.find((a) => a.id === carol.agent.id);
    assert.equal(c.removed, true);
    assert.equal(c.admin, false);
    assert.equal((await call('GET', '/api/info', { token: carol.token })).status, 401, 'its token is gone');
    const au = await call('GET', '/api/audit?limit=1000', { token: alice.token });
    assert.ok(au.events.some((e) => e.type === 'role' && e.target === carol.agent.id && /no longer an admin: removed · by alice/.test(e.detail)));
  });

  test('the audit log records every role change, verified, and never a key', async () => {
    const r = await fetch(relay.base + '/api/audit?limit=1000', { headers: { 'x-sphere-key': joinKey } });
    const raw = await r.text();
    const au = JSON.parse(raw);
    assert.equal(au.verified, true);
    assert.ok(au.events.filter((e) => e.type === 'role').length >= 8);
    for (const secret of [ADMIN, WRONG, joinKey, KEY]) assert.ok(!raw.includes(secret), 'no key in the audit log');
    const snap = fs.readFileSync(path.join(dir, 'sphere.json'), 'utf8');
    assert.ok(!snap.includes(ADMIN) && !snap.includes(joinKey), 'no key in the snapshot');
  });

  test('the fs store keeps admins across a restart', async () => {
    const snap = JSON.parse(fs.readFileSync(path.join(dir, 'sphere.json'), 'utf8'));
    assert.deepEqual(snap.admins, [alice.agent.id]);
    await stop(relay.proc);
    relay = await startRelay({ data: dir });
    const a = await call('GET', '/api/info', { token: alice.token });
    assert.equal(a.admin, true);
    assert.equal(a.me.admin, true);
    assert.equal((await call('GET', '/api/info', { token: bob.token })).me.admin, false);
    assert.equal((await call('POST', '/api/admin/policy', { token: alice.token, body: { maxDepth: 3 } })).status, 200);
  });

  // last: it leaves this address rate-limited for wrong keys
  test('wrong admin keys are refused and rate-limited, claims included', async () => {
    const statuses = [];
    for (let i = 0; i < 34; i++) statuses.push((await call('POST', '/api/admin/claim', { token: bob.token, admin: WRONG + i })).status);
    assert.equal(statuses[0], 401);
    assert.ok(statuses.slice(-3).every((s) => s === 429), statuses.join(','));
    assert.equal((await call('GET', '/api/info', { token: bob.token })).me.admin, false);
    const au = await call('GET', '/api/audit?limit=1000', { token: alice.token });
    assert.ok(au.events.some((e) => e.type === 'deny' && /a wrong admin key/.test(e.detail)));
    // the right key still works: only failures count
    assert.equal((await call('GET', '/api/admin/check', { admin: ADMIN, key: KEY })).status, 200);
  });
});

describe('admins on the Redis store', () => {
  let fake;
  const procs = [];
  const call = caller(() => null);
  const instance = async () => {
    const r = await startRelay({
      env: { SPHERE_STORE: 'redis', UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, SPHERE_REDIS_PREFIX: 'adm:', SPHERE_POLL_MS: '150' },
    });
    procs.push(r.proc);
    return r;
  };
  before(async () => {
    fake = await startFakeUpstash({ latencyMs: 2 });
  });
  after(async () => {
    for (const p of procs) await stop(p);
    await fake?.close();
  });

  test('a role is one operation in the log: every instance sees it, and a new one replays it', async () => {
    const A = await instance();
    const B = await instance();
    const dave = await call('POST', '/api/join', { at: A.base, body: { key: KEY, name: 'dave', owner: 'Dave' } });
    const erin = await call('POST', '/api/join', { at: B.base, body: { key: KEY, name: 'erin', owner: 'Erin' } });
    assert.equal((await call('POST', '/api/admin/claim', { at: A.base, token: dave.token, admin: ADMIN })).status, 200);
    assert.equal((await call('GET', '/api/info', { at: B.base, token: dave.token })).me.admin, true, 'the other instance knows');
    assert.equal((await call('POST', `/api/admin/agents/${erin.agent.id}/role`, { at: B.base, token: dave.token, body: { admin: true } })).agent.admin, true);
    assert.equal((await call('POST', `/api/admin/agents/${erin.agent.id}/role`, { at: A.base, token: dave.token, body: { admin: false } })).agent.admin, false);
    const log = fake.kv.get('adm:log').v.map((s) => JSON.parse(s));
    assert.equal(log.filter((o) => o.t === 'role').length, 3);
    assert.ok(!JSON.stringify(log).includes(ADMIN), 'no key in the log');
    // every instance goes; a new one starts from the log alone
    for (const p of procs.splice(0)) await stop(p);
    const C = await instance();
    const d = await call('GET', '/api/info', { at: C.base, token: dave.token });
    assert.equal(d.admin, true);
    assert.equal(d.me.admin, true);
    assert.equal((await call('GET', '/api/info', { at: C.base, token: erin.token })).me.admin, false);
    assert.equal((await call('POST', '/api/admin/policy', { at: C.base, token: dave.token, body: { maxDepth: 1 } })).policy.maxDepth, 1);
    assert.equal((await call('GET', '/api/audit?limit=1000', { at: C.base, token: dave.token })).verified, true);
  });
});

describe('the admin command and the console', () => {
  let relay, dir, home, work;
  const procs = [];
  const call = caller(() => relay.base);
  const token = (n) => JSON.parse(fs.readFileSync(path.join(home, n, 'profile.json'), 'utf8')).token;
  // the shell's environment, minus any admin key of the person running the tests
  const env = (extra = {}) => {
    const e = { ...process.env, OBYSPHERE_HOME: home, ...extra };
    if (!('OBYSPHERE_ADMIN_KEY' in extra)) delete e.OBYSPHERE_ADMIN_KEY;
    delete e.OBYSPHERE_PROFILE;
    return e;
  };
  const rep = (args, extra) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), ...args], { env: env(extra), stdio: ['pipe', 'pipe', 'pipe'] });
      p.stdin.end(); // no terminal: nothing can be asked
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      const t = setTimeout(() => p.kill(), 30000);
      p.on('close', (code) => {
        clearTimeout(t);
        resolve({ out: out + err, stdout: out, code });
      });
    });
  const startUi = async (profile, extra) => {
    const port = await freePort();
    const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'ui', '--profile', profile, '--port', String(port)], { env: env(extra), stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    procs.push(p);
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + '/favicon.svg')).ok && err.includes('your console')) return { base, log: () => err }; } catch {}
      await sleep(100);
    }
    throw new Error(`the console did not start: ${err}`);
  };

  before(async () => {
    const t = tmp('cli');
    dir = path.join(t, 'relay');
    home = path.join(t, 'reps');
    work = path.join(t, 'work');
    for (const d of [dir, home, work]) fs.mkdirSync(d, { recursive: true });
    relay = await startRelay({ data: dir });
    for (const n of ['alice', 'bob', 'carol']) {
      const r = await rep(['join', `${relay.base}/#key=${KEY}`, '--name', n, '--owner', `${n[0].toUpperCase()}${n.slice(1)} Test`, '--cwd', work]);
      assert.match(r.out, /joined/, r.out);
    }
  });
  after(async () => {
    for (const p of procs) await stop(p);
    if (relay) await stop(relay.proc);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  test('admin claim takes the key from OBYSPHERE_ADMIN_KEY, never from the command line', async () => {
    let r = await rep(['admin', 'status', '--profile', 'alice']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /you: +not an admin/);
    assert.match(r.out, /admins: none yet/);
    r = await rep(['admin', 'claim', '--profile', 'alice', '--admin-key', ADMIN]);
    assert.equal(r.code, 1);
    assert.match(r.out, /never goes on the command line/);
    r = await rep(['admin', 'claim', '--profile', 'alice']);
    assert.equal(r.code, 1, 'no key and no terminal');
    assert.match(r.out, /OBYSPHERE_ADMIN_KEY/);
    r = await rep(['admin', 'claim', '--profile', 'alice'], { OBYSPHERE_ADMIN_KEY: WRONG });
    assert.equal(r.code, 1);
    assert.match(r.out, /isn't this Sphere's admin key/);
    assert.equal((await call('GET', '/api/info', { token: token('alice') })).me.admin, false);
    r = await rep(['admin', 'claim', '--profile', 'alice'], { OBYSPHERE_ADMIN_KEY: ADMIN });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /alice is an admin of .* now/);
    assert.ok(!r.out.includes(ADMIN), 'the key is never printed');
    assert.equal((await call('GET', '/api/info', { token: token('alice') })).me.admin, true);
    r = await rep(['admin', 'claim', '--profile', 'alice']);
    assert.match(r.out, /already an admin/, 'no key needed to learn that');
    for (const f of fs.readdirSync(path.join(home, 'alice'))) assert.ok(!fs.readFileSync(path.join(home, 'alice', f), 'utf8').includes(ADMIN), `${f} doesn't keep the key`);
  });

  test('admin status, whoami, grant and revoke', async () => {
    let r = await rep(['admin', 'status', '--profile', 'alice']);
    assert.match(r.out, /you: +an admin/);
    assert.match(r.out, /admins: @alice \(Alice Test\)/);
    const j = JSON.parse((await rep(['admin', 'status', '--profile', 'alice', '--json'])).stdout);
    assert.equal(j.you.admin, true);
    assert.deepEqual(j.admins.map((a) => a.handle), ['alice']);
    assert.match((await rep(['whoami', '--profile', 'alice'])).out, /an admin of this Sphere/);
    r = await rep(['admin', 'grant', 'bob', '--profile', 'alice']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /@bob \(Bob Test\) is an admin of this Sphere now/);
    assert.equal((await call('GET', '/api/info', { token: token('bob') })).me.admin, true);
    r = await rep(['admin', 'revoke', 'bob', '--profile', 'alice']);
    assert.match(r.out, /@bob \(Bob Test\) is not an admin of this Sphere now/);
    r = await rep(['admin', 'grant', 'nobody', '--profile', 'alice']);
    assert.equal(r.code, 1);
    assert.match(r.out, /no member @nobody here/);
    r = await rep(['admin', 'revoke', 'alice', '--profile', 'alice']);
    assert.equal(r.code, 1);
    assert.match(r.out, /only admin/);
    // the relay's "or use the admin key" isn't something this command can do: it says what works here
    assert.match(r.out, /admin grant <handle>/);
    assert.doesNotMatch(r.out, /use the admin key/);
  });

  test('admin policy: anyone reads it; only an admin changes it', async () => {
    let r = await rep(['admin', 'policy', '--profile', 'bob']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /this Sphere, for everyone in it/);
    assert.match(r.out, /hop limit 3/);
    assert.match(r.out, /Only admins change it/);
    r = await rep(['admin', 'policy', '--profile', 'bob', '--max-depth', '2']);
    assert.equal(r.code, 1);
    assert.match(r.out, /bob isn't an admin of this Sphere[\s\S]*admin claim/);
    r = await rep(['admin', 'policy', '--profile', 'alice', '--max-depth', '2', '--max-file-bytes', '2MB']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /hop limit 2 · largest file 2\.0 MB/);
    let pol = (await call('GET', '/api/info', { token: token('bob') })).sphere;
    assert.equal(pol.policy.maxDepth, 2);
    assert.equal(pol.policy.maxFileBytes, 2 * 1048576);
    assert.equal((await rep(['admin', 'policy', '--profile', 'alice', '--sealed', 'maybe'])).code, 1);
    assert.equal((await rep(['admin', 'policy', '--profile', 'alice', '--pause', '--resume'])).code, 1);
    r = await rep(['admin', 'policy', '--profile', 'alice', '--pause']);
    assert.match(r.out, /paused: no new messages/);
    assert.equal((await call('GET', '/api/info', { token: token('bob') })).sphere.paused, true);
    r = await rep(['admin', 'policy', '--profile', 'alice', '--resume', '--sealed', 'on']);
    assert.match(r.out, /contents sealed end to end · accepting messages/);
    pol = (await call('GET', '/api/info', { token: token('bob') })).sphere;
    assert.equal(pol.paused, false);
    assert.equal(pol.policy.sealed, true);
    await rep(['admin', 'policy', '--profile', 'alice', '--sealed', 'off']);
    assert.match((await rep(['admin', 'nonsense', '--profile', 'alice'])).out, /usage: node rep\.mjs admin/);
  });

  test('admin rotate-key asks for --yes without a terminal, then prints the new invite', async () => {
    let r = await rep(['admin', 'rotate-key', '--profile', 'alice']);
    assert.equal(r.code, 1);
    assert.match(r.out, /--yes/);
    r = await rep(['admin', 'rotate-key', '--profile', 'alice', '--yes']);
    assert.equal(r.code, 0, r.out);
    const key = /#key=([A-Za-z0-9_-]+)/.exec(r.out)?.[1];
    assert.ok(key && key !== KEY);
    assert.equal((await call('GET', '/api/info', { key })).status, 200, 'the new invite opens it');
    const au = await call('GET', '/api/audit?limit=1000', { token: token('alice') });
    assert.ok(au.events.some((e) => e.type === 'rotate' && /by alice$/.test(e.detail)));
  });

  test("the console: admin calls go with the member's token; the key passes through once, for a claim", async () => {
    const ui = await startUi('bob');
    const page = await (await fetch(ui.base + '/')).text();
    assert.ok(!page.includes(ADMIN));
    const injected = JSON.parse(/window\.OBYSPHERE_CONSOLE=(\{.*?\})<\/script>/.exec(page)[1]);
    assert.ok(!('admin' in injected), 'the page learns admin from /api/info, not from the console');
    const h = { 'x-obysphere-console': '1' };
    // bob isn't an admin: a key sent along on another call isn't passed on
    assert.equal((await call('GET', '/api/admin/check', { at: ui.base, headers: { ...h, 'x-admin-key': ADMIN } })).status, 403);
    assert.equal((await call('POST', '/api/admin/policy', { at: ui.base, headers: { ...h, 'x-admin-key': ADMIN }, body: { maxDepth: 4 } })).status, 403);
    assert.equal((await call('GET', '/api/info', { at: ui.base, headers: h })).admin, false);
    // Admin access…: the claim, through the console
    assert.equal((await call('POST', '/api/admin/claim', { at: ui.base, headers: { ...h, 'x-admin-key': WRONG } })).status, 401);
    const r = await call('POST', '/api/admin/claim', { at: ui.base, headers: { ...h, 'x-admin-key': ADMIN } });
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(r.agent.admin, true);
    // from now on bob's token is enough
    const info = await call('GET', '/api/info', { at: ui.base, headers: h });
    assert.equal(info.admin, true);
    assert.equal(info.me.admin, true);
    assert.equal((await call('POST', '/api/admin/policy', { at: ui.base, headers: h, body: { maxDepth: 3 } })).policy.maxDepth, 3);
    assert.ok(!ui.log().includes(ADMIN));
  });

  test('ui with OBYSPHERE_ADMIN_KEY (the old way) claims admin for the profile at start', async () => {
    assert.equal((await call('GET', '/api/info', { token: token('carol') })).me.admin, false);
    const ui = await startUi('carol', { OBYSPHERE_ADMIN_KEY: ADMIN });
    assert.match(ui.log(), /an admin of this Sphere/);
    assert.equal((await call('GET', '/api/info', { token: token('carol') })).me.admin, true);
    const h = { 'x-obysphere-console': '1' };
    assert.equal((await call('GET', '/api/admin/check', { at: ui.base, headers: h })).via, 'member', 'with its token, not the key');
    const page = await (await fetch(ui.base + '/')).text();
    assert.ok(!page.includes(ADMIN));
  });

  test("admin claim on a suspended Oby says it's suspended, not that it's already an admin", async () => {
    const carol = JSON.parse(fs.readFileSync(path.join(home, 'carol', 'profile.json'), 'utf8')).agent.id;
    assert.equal((await call('POST', `/api/admin/agents/${carol}/suspend`, { admin: ADMIN, body: { suspended: true } })).agent.suspended, true);
    try {
      const r = await rep(['admin', 'claim', '--profile', 'carol'], { OBYSPHERE_ADMIN_KEY: ADMIN });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /carol is suspended in .*: it keeps its admin role, but the role does nothing until an admin resumes it/);
      assert.doesNotMatch(r.out, /already an admin/);
    } finally {
      await call('POST', `/api/admin/agents/${carol}/suspend`, { admin: ADMIN, body: { suspended: false } });
    }
  });
});

// The console page's admin markup, run on its own: an agent id comes from the relay, which the
// console doesn't trust, and it goes into a button's attribute and then into a request path.
describe("the console page's admin markup", () => {
  const page = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  // a function declaration out of the page's script, by its braces
  const fnSource = (name) => {
    const start = page.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} is in the page`);
    let depth = 0;
    for (let i = page.indexOf('{', start); i < page.length; i++) {
      if (page[i] === '{') depth++;
      else if (page[i] === '}' && --depth === 0) return page.slice(start, i + 1);
    }
    throw new Error(`${name} has no end`);
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const HOSTILE = 'a_x" autofocus onfocus="alert(1)';
  const render = (fn, agents, S) => {
    const ctx = {
      S: { me: { id: 'a_me' }, admin: true, adminKey: null, sphere: { policy: {} }, ...S },
      members: () => agents.slice(),
      isMe: (a) => a.id === 'a_me',
      ownerName: (a) => a.owner,
      picture: () => '',
      obyOf: (a) => a.owner,
      stateOf: () => 'online',
      stateHtml: (s) => s,
      ago: () => 'now',
      fmtMs: (n) => `${n} ms`,
      head: (t, sub, right = '') => `<h1>${t}</h1>${sub}${right}`,
      esc,
      // Members since the console usability pass: the person's name, their status, what their Oby answers with
      label: (a) => a.owner,
      answersWith: () => '',
      MEMBER_STATE: { online: 'Online', working: 'Working', offline: 'Offline', suspended: 'Suspended' },
      // whether it can answer now (#160): away, offline since when, or its state
      availWords: () => 'Online',
      availDot: () => 'online',
    };
    vm.createContext(ctx);
    return vm.runInContext(`${fnSource('agentIdOk')}; ${fnSource(fn)}; ${fn}()`, ctx);
  };
  const agents = [
    { id: 'a_me', name: 'alice', owner: 'Alice', admin: true },
    { id: 'a_bob', name: 'bob', owner: 'Bob', admin: false },
    { id: HOSTILE, name: 'mallory', owner: 'Mallory', admin: false },
  ];

  test('Admins: a button for each real member, none for an id the relay should never send', () => {
    const html = render('pageAdmins', agents);
    assert.match(html, /data-role="a_bob" data-to="1">Make admin/);
    assert.ok(!html.includes('onfocus'), 'the id never reaches the markup');
    assert.equal((html.match(/data-role=/g) || []).length, 1, 'only bob gets a button (alice is the only admin)');
  });

  test('Members: suspend and remove for real members only', () => {
    const html = render('pageMembers', agents);
    assert.match(html, /data-suspend="a_bob"/);
    assert.match(html, /data-remove="a_bob"/);
    assert.ok(!html.includes('onfocus'), 'the id never reaches the markup');
    assert.equal((html.match(/data-remove=/g) || []).length, 1);
    assert.ok(!render('pageMembers', agents, { admin: false }).includes('data-remove'), 'no actions for a member who is not an admin');
  });
});
