// The menu bar icon (#163): what `obysphere menubar model` tells the app to show, from a fake
// console (its local API, with the console's secret) and a fake relay; and its LaunchAgent,
// written by start, removed with the last stop, and turned off and on (dry runs: no launchctl).
// `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const CLI = path.join(ROOT, 'obysphere.mjs');
const UID = typeof process.getuid === 'function' ? process.getuid() : 0;
const roots = [];
test.after(() => roots.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function home(name) {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `obysphere-menubar-${name}-`)));
  roots.push(h);
  return h;
}
function envFor(h, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: h,
    TMPDIR: os.tmpdir(),
    LANG: 'C',
    OBYSPHERE_HOME: path.join(h, 'profiles'),
    OBYSPHERE_NO_UPDATE_CHECK: '1',
    OBYSPHERE_SERVICE_DRYRUN: '1',
    OBYSPHERE_SERVICE_DIR: path.join(h, 'services'),
    OBYSPHERE_SERVICE_PLATFORM: 'darwin',
    OBYSPHERE_APP_HOME: path.join(h, 'app'),
    OBYSPHERE_BIN_DIR: path.join(h, 'bin'),
    OBYSPHERE_RELEASES_API: 'http://127.0.0.1:9/api',
    ...extra,
  };
}
function cli(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ code, stdout, stderr, out: stdout + stderr }));
  });
}
function profile(h, name, sphere, port) {
  const dir = path.join(h, 'profiles', name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ profile: name, sphere, sphereName: 'Test Sphere', token: 'tok_never_shown', agent: { id: `a_${name}`, name, owner: name[0].toUpperCase() + name.slice(1) } }));
  if (port) fs.writeFileSync(path.join(dir, 'service.json'), JSON.stringify({ port }));
  return dir;
}
// the service file start writes: there, the profile runs in the background
const installed = (h, name) => {
  fs.mkdirSync(path.join(h, 'services'), { recursive: true });
  fs.writeFileSync(path.join(h, 'services', `com.obysphere.${name}.plist`), '<plist/>');
};
const listen = (handler) =>
  new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(s));
  });
const dryrun = (h) => {
  try {
    return fs.readFileSync(path.join(h, 'services', 'dryrun.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const model = async (env) => {
  const r = await cli(['menubar', 'model'], env);
  assert.equal(r.code, 0, r.out);
  return JSON.parse(r.stdout);
};
const find = (items, title) => items.find((i) => i.title === title);

test('menubar model: your Oby as the console sees it, from its local API with the console header', async () => {
  const h = home('model');
  // a relay that answers, and a console that answers only with its header (as the real one does)
  let relayUp = true;
  const relay = await listen((req, res) => {
    res.writeHead(relayUp ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: relayUp, version: 'obysphere/0.3' }));
  });
  const soon = new Date(Date.now() + 3 * 3600e3).toISOString();
  const state = { pending: [{ id: 'w_1' }, { id: 'w_2' }], away: { by: 'owner', until: soon, note: 'lunch' } };
  const asked = [];
  // the console's secret, as rep.mjs ui keeps it in the profile: it proves it knows it
  // (/console-hello), and its local API takes nothing without it
  const secret = crypto.randomBytes(32).toString('base64url');
  const consoleServer = await listen((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/console-hello') return res.end(JSON.stringify({ proof: crypto.createHmac('sha256', secret).update(`obysphere console hello ${u.searchParams.get('nonce')}`).digest('hex') }));
    asked.push({ url: req.url, header: req.headers['x-obysphere-auth'] });
    if (req.headers['x-obysphere-auth'] !== secret) return res.writeHead(401).end('{}');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/local/pending') return res.end(JSON.stringify({ pending: state.pending }));
    if (req.url === '/local/away') return res.end(JSON.stringify({ away: state.away }));
    res.end('{}');
  });
  try {
    const port = consoleServer.address().port;
    const sphere = `http://127.0.0.1:${relay.address().port}`;
    const dir = profile(h, 'alice', sphere, port);
    fs.writeFileSync(path.join(dir, 'console-auth.json'), JSON.stringify({ [port]: { secret, pid: process.pid, at: new Date().toISOString() } }), { mode: 0o600 });
    installed(h, 'alice');
    fs.mkdirSync(path.join(dir, 'held'));
    fs.writeFileSync(path.join(dir, 'held', 'm_held1.json'), '{}');
    fs.writeFileSync(path.join(dir, 'held', 'notes.txt'), 'not an ask');
    const env = envFor(h);
    const page = `http://alice.localhost:${port}/`;
    const signed = `${page}#auth=${secret}`; // each page it opens signs the browser in

    // away, with two asks waiting and one held
    let m = await model(env);
    assert.ok(asked.length >= 2 && asked.every((a) => a.header === secret), 'every local call carries the secret');
    assert.deepEqual({ state: m.icon.state, count: m.icon.count }, { state: 'away', count: 2 });
    assert.match(m.icon.tip, /^Obysphere · Away until .+ · 2 asks wait for you$/);
    assert.deepEqual(m.items[0], { kind: 'header', title: 'Alice’s Oby in Test Sphere' });
    assert.equal(m.items[1].kind, 'line');
    assert.equal(m.items[1].dot, 'away');
    assert.match(m.items[1].title, /^Away until (\d{1,2}:\d\d|[A-Z][a-z]{2} \d{1,2}:\d\d)$/);
    assert.deepEqual(find(m.items, '2 asks wait for you'), { kind: 'open', title: '2 asks wait for you', url: `${signed}&page=you` });
    assert.deepEqual(find(m.items, '1 ask held until your runtime can answer'), { kind: 'open', title: '1 ask held until your runtime can answer', url: `${signed}&page=you` });
    assert.deepEqual(find(m.items, 'Open console'), { kind: 'open', title: 'Open console', url: signed });
    assert.deepEqual(find(m.items, 'I’m back').args, ['away', '--off', '--profile', 'alice']);
    assert.equal(find(m.items, 'Away'), undefined, 'while away: I’m back, not Away');
    const stop = find(m.items, 'Stop');
    assert.deepEqual(stop.args, ['stop', '--profile', 'alice']);
    assert.match(stop.confirm.text, /this icon goes too/, 'the last Oby in the background: the icon goes with it');
    assert.deepEqual(find(m.items, 'Hide this icon').args, ['menubar', 'off']);
    assert.ok(!JSON.stringify(m).includes('tok_'), 'no token');
    // every page it opens is this console's
    const urls = JSON.stringify(m).match(/"url":"[^"]*"/g);
    assert.ok(urls.every((u) => u.startsWith(`"url":"${page}`)), urls.join(' '));

    // back, nothing waiting: the Away menu, its times for the CLI to read
    state.pending = [];
    state.away = null;
    m = await model(env);
    assert.deepEqual({ state: m.icon.state, count: m.icon.count, tip: m.icon.tip }, { state: 'on', count: 0, tip: 'Obysphere · Running' });
    assert.equal(m.items[1].title, 'Running');
    const away = find(m.items, 'Away');
    assert.deepEqual(find(away.items, 'For an hour').args, ['away', '--until', '1h', '--profile', 'alice']);
    assert.deepEqual(find(away.items, 'Until I’m back').args, ['away', '--note=', '--profile', 'alice']);
    const morning = away.items.find((i) => /^Until (tomorrow|Monday) 9:00$/.test(i.title));
    assert.ok(morning, away.items.map((i) => i.title).join(' | '));
    const at = new Date(morning.args[2]);
    assert.ok(at > new Date() && at.getHours() === 9 && at.getMinutes() === 0 && ![0, 6].includes(at.getDay()), morning.args[2]);
    assert.deepEqual(find(away.items, 'Another time, or a note…'), { kind: 'open', title: 'Another time, or a note…', url: `${signed}&page=you` });

    // paused by its runtime
    state.away = { by: 'pause', until: soon };
    m = await model(env);
    assert.equal(m.icon.state, 'away');
    assert.match(m.items[1].title, /^Paused until .+: your runtime can’t answer$/);
    assert.ok(find(m.items, 'Away'), 'paused: you can still say you’re away');

    // the Sphere can't be reached
    relayUp = false;
    state.away = null;
    m = await model(env);
    assert.equal(m.icon.state, 'off');
    assert.equal(m.items[1].title, 'Running, but it can’t reach the Sphere');

    // a newer release: Update
    fs.mkdirSync(path.join(h, 'app'), { recursive: true });
    fs.writeFileSync(path.join(h, 'app', 'update-check.json'), JSON.stringify({ latest: '99.0.0', checkedAt: new Date().toISOString() }));
    m = await model(env);
    // the release it names: the stable channel, whichever one was installed
    assert.deepEqual(find(m.items, 'Update to 99.0.0'), { kind: 'run', title: 'Update to 99.0.0', args: ['update', '--channel', 'stable'], busy: 'Updating to 99.0.0…' });
    assert.match(m.icon.tip, /99\.0\.0 is out/);
  } finally {
    consoleServer.close();
    relay.close();
  }
});

test('menubar model: stopped, not answering, and other profiles folded into Start another Oby', async () => {
  const h = home('stopped');
  const env = envFor(h);
  profile(h, 'alice', 'http://127.0.0.1:9', 9);
  // its own console doesn't answer, and it has no service: Stopped, Start
  let m = await model(env);
  assert.deepEqual(m.icon, { state: 'off', count: 0, tip: 'Obysphere · Stopped' });
  assert.deepEqual(m.items.slice(1, 3), [
    { kind: 'line', title: 'Stopped', dot: 'off' },
    { kind: 'run', title: 'Start', args: ['start', '--profile', 'alice'], busy: 'Starting your Oby…' },
  ]);
  assert.equal(find(m.items, 'Open console'), undefined);
  // a service that doesn't answer: Restart
  installed(h, 'alice');
  m = await model(env);
  assert.equal(m.items[1].title, 'Not answering: obysphere logs shows why');
  assert.deepEqual(find(m.items, 'Restart').args, ['restart', '--profile', 'alice']);
  // another profile, not meant to run: only a Start, in a submenu
  profile(h, 'bob', 'http://127.0.0.1:9', 0);
  m = await model(env);
  assert.deepEqual(m.items[0], { kind: 'header', title: 'Test Sphere: @alice' });
  const other = find(m.items, 'Start another Oby');
  assert.deepEqual(other.items, [{ kind: 'run', title: 'Test Sphere: @bob', args: ['start', '--profile', 'bob'], busy: 'Starting your Oby…' }]);
  // none here yet
  const empty = home('empty');
  m = await model(envFor(empty));
  assert.deepEqual(m.items[0], { kind: 'line', title: 'No profile here yet: obysphere join', dot: 'off' });
});

test('start on macOS writes the menu bar agent once; the last stop removes it; menubar off and on', async () => {
  const h = home('agent');
  const env = envFor(h);
  profile(h, 'alice', 'http://127.0.0.1:9', 0);
  profile(h, 'bob', 'http://127.0.0.1:9', 0);
  const file = path.join(h, 'services', 'com.obysphere.menubar.plist');
  const menuCmds = () => dryrun(h).filter((c) => c.args.some((a) => String(a).includes('com.obysphere.menubar')));

  assert.equal((await cli(['start', '--all'], env)).code, 0);
  const plist = fs.readFileSync(file, 'utf8');
  const args = [...plist.split('<key>ProgramArguments</key>')[1].split('</array>')[0].matchAll(/<string>([^<]*)<\/string>/g)].map((x) => x[1]);
  assert.deepEqual([args[0], args[1], args[2], args[4], args[5]], [path.join(h, 'Applications', 'Obysphere.app', 'Contents', 'MacOS', 'Obysphere'), '--menu', '--node', '--cli', CLI]);
  assert.ok(fs.existsSync(args[3]), `node: ${args[3]}`);
  assert.match(plist, /<key>Label<\/key><string>com\.obysphere\.menubar<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/, 'Hide ends it; a crash starts it again');
  assert.match(plist, /<key>LimitLoadToSessionType<\/key><string>Aqua<\/string>/);
  assert.match(plist, /<key>AbandonProcessGroup<\/key><true\/>/, 'stop and update outlive it');
  assert.ok(plist.includes(`<key>OBYSPHERE_HOME</key><string>${path.join(h, 'profiles')}</string>`));
  assert.ok(!plist.includes('tok_'));
  assert.deepEqual(menuCmds(), [
    { cmd: 'launchctl', args: ['bootout', `gui/${UID}/com.obysphere.menubar`] },
    { cmd: 'launchctl', args: ['bootstrap', `gui/${UID}`, file] },
  ]);

  // started again, restarted: the same agent, left alone
  assert.equal((await cli(['start', '--profile', 'alice'], env)).code, 0);
  assert.equal((await cli(['restart', '--profile', 'alice'], env)).code, 0);
  assert.equal(menuCmds().length, 2);
  // one stopped: bob still runs, the icon stays; the last stopped: it goes
  assert.equal((await cli(['stop', '--profile', 'alice'], env)).code, 0);
  assert.ok(fs.existsSync(file));
  const last = await cli(['stop', '--profile', 'bob'], env);
  assert.match(last.stdout, /The menu bar icon goes with it/);
  assert.ok(!fs.existsSync(file));
  assert.deepEqual(menuCmds().at(-1), { cmd: 'launchctl', args: ['bootout', `gui/${UID}/com.obysphere.menubar`] });

  // off: start doesn't put it back; on: it's back while an Oby runs
  const off = await cli(['menubar', 'off'], env);
  assert.equal(off.code, 0, off.out);
  assert.match(off.stdout, /The menu bar icon is off\. Your Oby keeps running/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h, 'profiles', 'menubar.json'), 'utf8')), { on: false });
  assert.equal((await cli(['start', '--profile', 'alice'], env)).code, 0);
  assert.ok(!fs.existsSync(file));
  assert.match((await cli(['menubar'], env)).stdout, /The menu bar icon is off/);
  const on = await cli(['menubar', 'on'], env);
  assert.equal(on.code, 0, on.out);
  assert.ok(fs.existsSync(file));
  assert.match((await cli(['menubar'], env)).stdout, /The menu bar icon is on\./);
  // off while it runs: removed at once
  await cli(['menubar', 'off'], env);
  assert.ok(!fs.existsSync(file));
});

test('the menu bar is macOS only: Linux and Windows services write none', async () => {
  for (const platform of ['linux', 'win32']) {
    const h = home(platform);
    const env = envFor(h, { OBYSPHERE_SERVICE_PLATFORM: platform });
    profile(h, 'alice', 'http://127.0.0.1:9', 0);
    if (platform === 'linux') await cli(['start'], env);
    assert.ok(!fs.existsSync(path.join(h, 'services', 'com.obysphere.menubar.plist')));
    const r = await cli(['menubar', 'on'], env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /The menu bar icon is for macOS/);
  }
});
