// An Oby's look: a colour and eyes its owner picks on Your Oby, kept on the relay (POST /api/me
// { look }, by name from fixed lists, never a colour or markup of its own) and drawn by every
// console wherever that Oby appears; people (you, in the rail and your account) keep their
// initials. The relay on its own, then the page's functions run with made-up data. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { fnSource, constSource, SCRIPT } from './accessibility-helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'join-key-looks-0123456789abcdef';
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startRelay(dir) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const p = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', dir], {
    env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: 'admin-key-looks-0123456789abcdef', SPHERE_SEALED: '0', SPHERE_STORE: 'fs', SPHERE_WRITES_PER_MIN: '100000' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + '/healthz')).ok) return { p, base }; } catch {}
    await sleep(100);
  }
  p.kill();
  throw new Error('the relay did not start');
}
const stop = (p) => new Promise((resolve) => {
  if (!p || p.exitCode !== null) return resolve();
  const t = setTimeout(resolve, 3000);
  p.once('exit', () => { clearTimeout(t); resolve(); });
  p.kill('SIGTERM');
});

describe('a look on the relay', () => {
  let relay, dir;
  const ag = {};
  const call = async (method, url, tok, body) => {
    const r = await fetch(relay.base + url, { method, headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const lookOf = async (name) => (await call('GET', '/api/agents', ag.bob.token)).agents.find((a) => a.name === name).look;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-looks-'));
    relay = await startRelay(dir);
    for (const n of ['alice', 'bob']) ag[n] = await (await fetch(relay.base + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: KEY, name: n, owner: n }) })).json();
  });
  after(async () => {
    await stop(relay?.p);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an Oby has none until its owner picks one; then every member sees it', async () => {
    assert.equal(await lookOf('alice'), null);
    const r = await call('POST', '/api/me', ag.alice.token, { look: { color: 'mint', eyes: 'happy' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.agent.look, { color: 'mint', eyes: 'happy' });
    assert.deepEqual(await lookOf('alice'), { color: 'mint', eyes: 'happy' });
    // the rest of its record is as it was
    assert.equal(r.agent.name, 'alice');
  });

  test('only names from its lists, and only a colour and eyes', async () => {
    for (const look of [{ color: 'red', eyes: 'happy' }, { color: 'mint', eyes: 'x' }, { color: 'mint' }, { color: 'mint', eyes: 'happy', hat: 'top' }, { color: '#ff0000', eyes: 'pill' }, ['mint', 'happy'], 'mint', 3]) {
      const r = await call('POST', '/api/me', ag.alice.token, { look });
      assert.equal(r.status, 400, JSON.stringify(look));
      assert.match(r.error, /^look is \{ color, eyes \} \(color: bone, sky, mint, lemon, peach, rose, lilac, sand; eyes: pill, round, happy, sleepy\), or null for the usual one\.$/);
    }
    assert.deepEqual(await lookOf('alice'), { color: 'mint', eyes: 'happy' }, 'what it had stays');
    // a change that doesn't name a look leaves it alone
    assert.equal((await call('POST', '/api/me', ag.alice.token, { runtime: 'claude' })).status, 200);
    assert.deepEqual(await lookOf('alice'), { color: 'mint', eyes: 'happy' });
  });

  test('null goes back to the usual look; a look is kept across a restart', async () => {
    await call('POST', '/api/me', ag.bob.token, { look: { color: 'lemon', eyes: 'sleepy' } });
    assert.equal((await call('POST', '/api/me', ag.alice.token, { look: null })).agent.look, null);
    assert.equal(await lookOf('alice'), null);
    await stop(relay.p);
    relay = await startRelay(dir);
    assert.deepEqual(await lookOf('bob'), { color: 'lemon', eyes: 'sleepy' });
    assert.equal(await lookOf('alice'), null);
  });
});

// the page's functions and consts, run with what's given; anything else they call returns ''
function run(names, call, given = {}, consts = []) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const base = { esc, ...given };
  const ctx = vm.createContext(new Proxy(base, {
    has: () => true,
    get: (o, k) => (k in o ? o[k] : k === Symbol.unscopables ? undefined : k in globalThis ? globalThis[k] : () => ''),
  }));
  // (an async function's source comes without its `async`)
  const source = (n) => (SCRIPT.includes(`async function ${n}(`) ? 'async ' : '') + fnSource(n);
  vm.runInContext(`${consts.map((c) => constSource(c)).join('\n')}\n${names.map(source).join('\n')}\nthis.__out = (${call});`, ctx);
  return base.__out;
}
const plain = (v) => JSON.parse(JSON.stringify(v));
const LOOK = ['LOOK_COLORS', 'LOOK_EYES', 'LOOK_WORDS', 'EYES', 'OBY_PATH', 'AVATAR_COLORS', 'djb2', 'obyPic'];

describe('a look in the console', () => {
  const lookOf = (a) => plain(run(['lookOf'], 'lookOf(A)', { A: a }, LOOK));

  test('its own, or the usual eyes and a colour from its id: the same in every console', () => {
    assert.deepEqual(lookOf({ id: 'a_1', look: { color: 'rose', eyes: 'round' } }), { color: 'rose', eyes: 'round' });
    const a = lookOf({ id: 'a_xyz' });
    assert.equal(a.eyes, 'pill');
    assert.deepEqual(lookOf({ id: 'a_xyz' }), a, 'the same id, the same colour');
    const colours = new Set(['a_1', 'a_2', 'a_3', 'a_4', 'a_5', 'a_6', 'a_7', 'a_8', 'a_9'].map((id) => lookOf({ id }).color));
    assert.ok(colours.size >= 3, 'Obys that haven’t picked differ');
    // what isn't a look of the lists is the usual one, part by part
    assert.equal(lookOf({ id: 'a_xyz', look: { color: '"><script>', eyes: 'happy' } }).color, a.color);
    assert.equal(lookOf({ id: 'a_xyz', look: { color: 'mint', eyes: 'x' } }).eyes, 'pill');
    assert.deepEqual(lookOf({ id: 'a_xyz', look: 'mint' }), a);
  });

  test('its face in its colour, with its eyes; every other picture is an Oby, and people keep their initials', () => {
    const face = (look) => run(['lookOf', 'obyFace'], 'obyPic({ id: "a_1", look: L }, 24)', { L: look }, LOOK);
    assert.match(face({ color: 'mint', eyes: 'happy' }), /fill="#8fe3bf"\/><g fill="none" stroke="#0d0d0e"[^>]*><path d="M5\.7 14\.1q1\.7-3 3\.4 0"\/>/);
    assert.match(face({ color: 'lemon', eyes: 'round' }), /fill="#f4d96b"\/><g fill="#0d0d0e"><circle cx="7\.4"/);
    assert.match(face({ color: 'bone', eyes: 'sleepy' }), /fill="#f1f1ee"\/><g fill="#0d0d0e"><rect x="5\.8" y="12\.5" width="3\.2" height="1\.4"/);
    assert.match(face({ color: 'bone', eyes: 'pill' }), /<rect x="6" y="10\.6" width="2\.8" height="5" rx="1\.4"\/>/);
    for (const l of [{ color: 'mint', eyes: 'happy' }, {}]) assert.match(face(l), /^<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">/);
    // an Oby, wherever it's drawn: by its record, or by its handle when that's all there is
    const bob = { id: 'a_bob', name: 'bob', owner: 'Bob Test', look: { color: 'sky', eyes: 'round' } };
    const pics = run(['lookOf', 'obyFace'], '[avatar(B, 22), avatar({ name: "bob", owner: "Bob Test" }, 22), picture(B, 22)]', { B: bob, members: () => [bob] }, LOOK.filter((c) => c !== 'obyPic').concat('obyPic', 'avatar', 'picture'));
    for (const p of pics) {
      assert.match(p, /fill="#9ccbff"/, 'Bob’s Oby, in its look');
      assert.doesNotMatch(p, /owner-avatar|BT/, 'no initials');
    }
    // a person: their initials
    assert.match(run(['person'], 'person({ owner: "Alice Test" }, 26)', { ownerName: (a) => a.owner }, ['AVATAR_COLORS', 'djb2']), /^<span class="owner-avatar" style="width:26px;height:26px;font-size:11px;background:#[0-9a-f]{6}" aria-hidden="true">AT<\/span>$/);
    // you in the rail and your account button are you; Your Oby in the nav and its menu item is your Oby
    const page = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert.match(page, /\$\{person\(S\.me, 28\)\}<\/span>`;/);
    assert.match(page, /title="You: \$\{esc\(S\.me\.owner\)\}">\$\{person\(S\.me, 26\)\}<\/button>/);
    assert.match(page, /\$\{icon \? navIcon\(icon\) : S\.me \? obyPic\(S\.me, 18\) : obyFace\(18\)\}/);
    assert.match(page, /\$\{it\('you', obyPic\(S\.me, 16\), 'Your Oby'\)\}/);
  });

  test('Your Oby: its face, then a colour and eyes as named radio groups, the colour by name', () => {
    const data = new Map();
    const html = run(['lookHtml', 'lookOf', 'obyFace', 'ctlSegmented'], 'lookHtml()', {
      S: { me: { id: 'a_me', look: { color: 'peach', eyes: 'sleepy' } }, agents: new Map() }, CTL: { data },
    }, [...LOOK, 'ctlName', 'ctlSame', 'ctlAttrs']);
    assert.match(html, /<span class="look-face" id="you-look-face"><svg width="56" height="56"[^>]*><path [^>]*fill="#ffb991"\/>/);
    assert.match(html, /<span class="route-label-sm" id="you-look-color-l">Colour<\/span><div class="ctl-seg look-colors" id="you-look-color" data-ctl="seg" role="radiogroup" aria-labelledby="you-look-color-l">/);
    const swatches = [...html.matchAll(/<button type="button" role="radio" id="you-look-color-(\d)" data-i="\1" aria-checked="(true|false)" tabindex="(0|-1)" title="(\w+)"><span class="look-dot" style="background:#[0-9a-f]{6}" aria-hidden="true"><\/span><span class="sr-only">\4<\/span><\/button>/g)];
    assert.deepEqual(swatches.map((m) => m[4]), ['Bone', 'Sky', 'Mint', 'Lemon', 'Peach', 'Rose', 'Lilac', 'Sand']);
    assert.deepEqual(swatches.filter((m) => m[2] === 'true').map((m) => [m[4], m[3]]), [['Peach', '0']], 'the one it has is checked, and the one Tab reaches');
    assert.match(html, /id="you-look-eyes" data-ctl="seg" role="radiogroup" aria-labelledby="you-look-eyes-l">/);
    assert.match(html, /aria-checked="true" tabindex="0">Sleepy<\/button>/);
    // the colour group is a segmented control like the others: arrows, Home, End, and the same change event
    assert.deepEqual(plain(data.get('you-look-color')).value, 'peach');
    assert.equal(plain(data.get('you-look-color')).options.length, 8);
    for (const id of [...html.matchAll(/aria-labelledby="([^"]+)"/g)].map((m) => m[1])) assert.ok(html.includes(`id="${id}"`), id);
  });

  test('a pick is shown at once and saved; a relay from before looks says so, and the old look comes back', async () => {
    const painted = [];
    const said = [];
    const run2 = (answer) => {
      const agents = [];
      const out = run(['saveLook', 'lookOf'], 'saveLook({ eyes: "happy" })', {
        S: { me: { id: 'a_me', look: { color: 'mint', eyes: 'pill' } }, agents: new Map() },
        document: { getElementById: () => null }, paintLook: (l) => painted.push(plain(l)), a11ySay: (k, w) => said.push([k, w]),
        apiPost: async (p, body) => { painted.push(['POST', p, plain(body)]); return answer(); }, upsertAgent: (a) => agents.push(a), renderNav: () => {},
      }, LOOK);
      return out.then(() => agents);
    };
    let agents = await run2(() => ({ agent: { id: 'a_me', look: { color: 'mint', eyes: 'happy' } } }));
    assert.deepEqual(painted.splice(0), [{ color: 'mint', eyes: 'happy' }, ['POST', '/api/me', { look: { color: 'mint', eyes: 'happy' } }]]);
    assert.equal(agents.length, 1);
    assert.deepEqual(said.splice(0), [['note', 'Saved']]);
    // an older relay answers with no look: nothing was kept
    agents = await run2(() => ({ agent: { id: 'a_me' } }));
    assert.deepEqual(painted.splice(0).at(-1), { color: 'mint', eyes: 'pill' }, 'the old look, back');
    assert.equal(agents.length, 0);
    assert.deepEqual(said.splice(0), [['problem', 'This Sphere’s relay can’t keep a look yet: whoever runs it updates it (obysphere server update).']]);
    // refused: its words, and the old look
    await run2(() => { throw new Error('Too many profile changes. Try again in a moment.'); });
    assert.deepEqual(painted.splice(0).at(-1), { color: 'mint', eyes: 'pill' });
    assert.deepEqual(said.splice(0), [['problem', 'Too many profile changes. Try again in a moment.']]);
  });
});
