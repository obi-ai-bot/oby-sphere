// The obysphere command, with no network beyond this machine and nothing outside temp
// folders: help and the pass-through to rep.mjs, which folder holds your profiles (an "mvp
// only" layout too, and never making ~/.obysphere), the background service's files and the
// launchctl/systemctl commands it would run (macOS and Linux, dry run), logs, update from a
// fake GitHub (SHA256SUMS checked, a mismatch refused, rollback, main), install.sh, server
// deploy with a fake vercel (keys never in argv or output, a clean export, Redis checked),
// and status, open and the console's version check against a local relay. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub, buildApp, release, sha256, makeFakeVercel } from './fake-cli.mjs';
import { consoleAuth, consoleSecret } from './console-auth-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version; // this checkout's version
const ROOT = fs.realpathSync(path.join(HERE, '..'));
const CLI = path.join(ROOT, 'obysphere.mjs');
const REP = path.join(ROOT, 'rep.mjs');
const INSTALL = path.join(ROOT, 'install.sh');
const KEY = 'join-key-cli-tests-0123456789';
const ADMIN = 'admin-key-cli-tests-0123456789';
const UID = typeof process.getuid === 'function' ? process.getuid() : 0;
const roots = [];
const procs = [];
let relay, relayBase;

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (name) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `obysphere-cli-${name}-`)));
  roots.push(d);
  return d;
};

// a clean environment: its own home, a dry run for services, and no way to reach GitHub
function envFor(home, extra = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: os.tmpdir(),
    LANG: 'C',
    OBYSPHERE_NO_UPDATE_CHECK: '1',
    OBYSPHERE_SERVICE_DRYRUN: '1',
    OBYSPHERE_SERVICE_DIR: path.join(home, 'services'),
    OBYSPHERE_APP_HOME: path.join(home, 'app'),
    OBYSPHERE_BIN_DIR: path.join(home, 'bin'),
    OBYSPHERE_RELEASES_API: 'http://127.0.0.1:9/api',
    OBYSPHERE_DOWNLOAD_BASE: 'http://127.0.0.1:9/dl',
    ...extra,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

function run(bin, args, env, { cmd = process.execPath, pre = [bin] } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, [...pre, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    const t = setTimeout(() => p.kill(), 90000);
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr, out: stdout + stderr });
    });
  });
}
const cli = (args, env) => run(CLI, args, env);
const sh = (args, env) => run(INSTALL, args, env, { cmd: 'sh' });

function fakeProfile(home, name, extra = {}) {
  const dir = path.join(home, name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ profile: name, sphere: 'http://127.0.0.1:9', sphereName: 'Test Sphere', token: 'tok_never_in_a_service_file', agent: { id: `a_${name}`, name, owner: name[0].toUpperCase() + name.slice(1) }, ...extra }), { mode: 0o600 });
  return dir;
}
const dryrun = (home) => {
  try {
    return fs.readFileSync(path.join(home, 'services', 'dryrun.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const linkOf = (f) => {
  try {
    return fs.readlinkSync(f);
  } catch {
    return null;
  }
};

async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {}
    await sleep(100);
  }
  throw new Error('timed out');
}

before(async () => {
  const data = tmp('relay');
  const port = await freePort();
  relayBase = `http://127.0.0.1:${port}`;
  relay = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', data], {
    env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_SEALED: '0', SPHERE_STORE: 'fs' },
    stdio: 'ignore',
  });
  await waitFor(async () => (await fetch(relayBase + '/healthz')).ok);
});

after(() => {
  relay?.kill();
  for (const p of procs) p.kill();
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});

describe('the obysphere command', () => {
  test('help lists the whole contract, grouped for a person', async () => {
    const h = tmp('help');
    const r = await cli(['help'], envFor(h));
    assert.equal(r.code, 0);
    for (const w of ['obysphere join', 'obysphere start', 'stop | restart', 'obysphere status', 'obysphere open', 'obysphere logs', '-f', 'obysphere profiles', 'obysphere settings',
      'obysphere ask', 'obysphere mcp-config', 'inbox --hook', 'notify test', 'admin claim', 'admin status | grant <handle> | revoke <handle> | rotate-key', 'admin policy', 'github status',
      'instruments new | list | check | remove', 'menubar [on | off]', 'update [--check] [--channel stable|main] [--rollback]', 'version | doctor', 'server start', 'server deploy vercel --project <name> [--scope <team>]', 'server deploy docker | railway', 'server update', 'server status'])
      assert.ok(r.stdout.includes(w), `help mentions ${w}`);
    for (const head of ['Join and run your Oby', 'Ask and read', 'Claude Code and Cursor', 'Notifications and the menu bar', 'GitHub', 'Admins', 'Keep it up to date', 'Run a Sphere']) assert.match(r.stdout, new RegExp(`^${head}$`, 'm'));
    assert.equal((await cli(['--help'], envFor(h))).stdout, r.stdout);
    assert.equal((await cli([], envFor(h))).stdout, r.stdout);
  });

  test('every other command goes to rep.mjs, with its exit code', async () => {
    const h = tmp('pass');
    const env = envFor(h, { OBYSPHERE_HOME: path.join(h, 'profiles') });
    const unknown = await cli(['no-such-command'], env);
    assert.equal(unknown.code, 0);
    assert.match(unknown.stdout, /Obysphere representative/); // rep.mjs's own help
    const who = await cli(['whoami'], env);
    assert.equal(who.code, 1);
    assert.match(who.stderr, /not joined yet\. Run: obysphere join </, 'through the CLI, hints name obysphere');
    const direct = await run(REP, ['whoami'], env);
    assert.match(direct.stderr, /not joined yet\. Run: node \S*rep\.mjs join </, 'run by itself, rep.mjs names its own path');
    const settings = await cli(['settings', '--profile', 'ghost'], env);
    assert.equal(settings.code, 1);
    assert.match(settings.stderr, /no profile "ghost"/);
    assert.ok(!fs.existsSync(path.join(h, 'profiles')), 'nothing made the profiles folder');
  });

  test('profiles use: a default profile for every command, rep.mjs and the plugin; --profile and OBYSPHERE_PROFILE come first', async () => {
    const h = tmp('default-profile');
    const profiles = path.join(h, 'profiles');
    fakeProfile(profiles, 'alice');
    fakeProfile(profiles, 'work');
    const env = envFor(h, { OBYSPHERE_HOME: profiles });
    // several, none chosen: both say how to choose
    const before = await cli(['mcp-config'], env);
    assert.equal(before.code, 1);
    assert.match(before.stderr, /several profiles here \(alice, work\).*obysphere profiles use <name>/);
    assert.match((await cli(['profiles'], env)).stdout, /Choose the one commands and Claude Code use when you don't say: obysphere profiles use <name>/);
    // a name that isn't a profile is refused, and nothing is written
    const bad = await cli(['profiles', 'use', 'nobody'], env);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /no profile "nobody"/);
    assert.ok(!fs.existsSync(path.join(profiles, '.default-profile')));
    // chosen: kept beside the profiles, shown, and used by the CLI and by rep.mjs run alone
    const use = await cli(['profiles', 'use', 'work'], env);
    assert.equal(use.code, 0, use.out);
    assert.equal(fs.readFileSync(path.join(profiles, '.default-profile'), 'utf8'), 'work\n');
    assert.match((await cli(['profiles'], env)).stdout, /work {2}\(default\)/);
    assert.equal(JSON.parse((await cli(['profiles', '--json'], env)).stdout).default, 'work');
    assert.match((await cli(['mcp-config'], env)).stdout, /mcp --profile work --serve/);
    assert.match((await run(REP, ['mcp-config'], env)).stdout, /mcp --profile work --serve/);
    // --profile and OBYSPHERE_PROFILE still win
    assert.match((await cli(['mcp-config', '--profile', 'alice'], env)).stdout, /mcp --profile alice --serve/);
    assert.match((await cli(['mcp-config'], { ...env, OBYSPHERE_PROFILE: 'alice' })).stdout, /mcp --profile alice --serve/);
    // a default whose profile is gone counts as none
    fs.writeFileSync(path.join(profiles, '.default-profile'), 'gone\n');
    assert.match((await cli(['mcp-config'], env)).stderr, /several profiles here/);
    // --clear forgets it
    await cli(['profiles', 'use', 'work'], env);
    assert.equal((await cli(['profiles', 'use', '--clear'], env)).code, 0);
    assert.ok(!fs.existsSync(path.join(profiles, '.default-profile')));
  });

  test('profiles live in the folder that holds them, and nothing makes ~/.obysphere', async () => {
    const repHome = async (h, extra = {}) => /Profiles live in (.+)\/<profile>\//.exec((await run(REP, ['help'], envFor(h, extra))).stdout)?.[1];
    const cliHome = async (h, extra = {}) => { const { home, profiles } = JSON.parse((await cli(['profiles', '--json'], envFor(h, extra))).stdout); return { home, profiles }; };

    // nothing yet: ~/.obysphere, and it isn't made by looking
    const empty = tmp('home-empty');
    assert.equal(await repHome(empty), path.join(empty, '.obysphere'));
    assert.deepEqual(await cliHome(empty), { home: path.join(empty, '.obysphere'), profiles: [] });
    for (const c of [['help'], ['version'], ['status'], ['doctor'], ['profiles'], ['update', '--check']]) await cli(c, envFor(empty));
    assert.ok(!fs.existsSync(path.join(empty, '.obysphere')), 'no ~/.obysphere');
    assert.ok(!fs.existsSync(path.join(empty, '.obysphere-mvp')));
    assert.ok(!fs.existsSync(path.join(empty, 'app')), 'no app home either');

    // only ~/.obysphere-mvp holds profiles (made before the rename)
    const mvp = tmp('home-mvp');
    fakeProfile(path.join(mvp, '.obysphere-mvp'), 'alice');
    assert.equal(await repHome(mvp), path.join(mvp, '.obysphere-mvp'));
    const got = await cliHome(mvp);
    assert.equal(got.home, path.join(mvp, '.obysphere-mvp'));
    assert.deepEqual(got.profiles.map((p) => p.profile), ['alice']);
    assert.ok(!JSON.stringify(got).includes('tok_'), 'never the token');
    assert.ok(!fs.existsSync(path.join(mvp, '.obysphere')));
    assert.match((await cli(['profiles'], envFor(mvp))).stdout, /holds your profiles; ~\/\.obysphere doesn't/);

    // an empty ~/.obysphere (made by an older installer) no longer hides them
    const hidden = tmp('home-hidden');
    fs.mkdirSync(path.join(hidden, '.obysphere'));
    fakeProfile(path.join(hidden, '.obysphere-mvp'), 'alice');
    assert.equal(await repHome(hidden), path.join(hidden, '.obysphere-mvp'));
    assert.equal((await cliHome(hidden)).home, path.join(hidden, '.obysphere-mvp'));

    // both hold profiles: ~/.obysphere, and the others are pointed out
    const both = tmp('home-both');
    fakeProfile(path.join(both, '.obysphere'), 'bob');
    fakeProfile(path.join(both, '.obysphere-mvp'), 'alice');
    assert.equal(await repHome(both), path.join(both, '.obysphere'));
    assert.equal((await cliHome(both)).home, path.join(both, '.obysphere'));
    assert.match((await cli(['profiles'], envFor(both))).stdout, /More profiles are in .*\.obysphere-mvp/);

    // OBYSPHERE_HOME wins
    const set = path.join(both, 'elsewhere');
    assert.equal(await repHome(both, { OBYSPHERE_HOME: set }), set);
    assert.equal((await cliHome(both, { OBYSPHERE_HOME: set })).home, set);
  });

  test('start on macOS: a LaunchAgent, launchctl bootstrap, and a port of its own (dry run)', async () => {
    const h = tmp('mac');
    const profiles = path.join(h, 'profiles');
    fakeProfile(profiles, 'alice');
    const env = envFor(h, { OBYSPHERE_HOME: profiles, OBYSPHERE_SERVICE_PLATFORM: 'darwin' });
    const r = await cli(['start'], env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /dry run, so nothing was started/);
    const port = readJson(path.join(profiles, 'alice', 'service.json')).port;
    assert.ok(Number.isInteger(port) && ![4848, 4849, 4850].includes(port), `port ${port}`);
    const plistFile = path.join(h, 'services', 'com.obysphere.alice.plist');
    const plist = fs.readFileSync(plistFile, 'utf8');
    assert.match(plist, /<key>Label<\/key><string>com\.obysphere\.alice<\/string>/);
    assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
    const args = [...plist.split('<key>ProgramArguments</key>')[1].split('</array>')[0].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    assert.deepEqual(args.slice(1), ['--preserve-symlinks-main', REP, 'ui', '--serve', '--profile', 'alice', '--port', String(port)]);
    assert.ok(plist.includes(`<key>StandardOutPath</key><string>${path.join(profiles, 'alice', 'logs', 'console.log')}</string>`));
    assert.ok(plist.includes(`<key>OBYSPHERE_HOME</key><string>${profiles}</string>`));
    assert.ok(!plist.includes('tok_'), 'no token in the service file');
    assert.ok(fs.statSync(path.join(profiles, 'alice', 'logs')).isDirectory());
    // and the menu bar icon's own agent (test/menubar.test.mjs)
    assert.deepEqual(dryrun(h), [
      { cmd: 'launchctl', args: ['bootout', `gui/${UID}/com.obysphere.alice`] },
      { cmd: 'launchctl', args: ['bootstrap', `gui/${UID}`, plistFile] },
      { cmd: 'launchctl', args: ['bootout', `gui/${UID}/com.obysphere.menubar`] },
      { cmd: 'launchctl', args: ['bootstrap', `gui/${UID}`, path.join(h, 'services', 'com.obysphere.menubar.plist')] },
    ]);

    // the port stays the profile's; a profile that already has one keeps it; a new one gets another
    // (never 4848-4850 here: a demo and a live console may run there)
    assert.equal((await cli(['restart'], env)).code, 0);
    assert.equal(readJson(path.join(profiles, 'alice', 'service.json')).port, port);
    fakeProfile(profiles, 'bob');
    const bobPort = await freePort();
    fs.writeFileSync(path.join(profiles, 'bob', 'service.json'), JSON.stringify({ port: bobPort }));
    fakeProfile(profiles, 'carol');
    const several = await cli(['start'], env);
    assert.equal(several.code, 1);
    assert.match(several.stderr, /several profiles here \(alice, bob, carol\): pass --profile <name>, or --all/);
    // logs and open take one profile: --all isn't offered to them
    const logsMany = await cli(['logs'], env);
    assert.equal(logsMany.code, 1);
    assert.match(logsMany.stderr, /several profiles here \(alice, bob, carol\): pass --profile <name>, or choose one for every command: obysphere profiles use <name>\n/);
    assert.doesNotMatch(logsMany.stderr, /--all/);
    assert.equal((await cli(['start', '--all'], env)).code, 0);
    assert.match(fs.readFileSync(path.join(h, 'services', 'com.obysphere.bob.plist'), 'utf8'), new RegExp(`<string>--port</string>\\s*<string>${bobPort}</string>`));
    const carol = readJson(path.join(profiles, 'carol', 'service.json')).port;
    assert.ok(carol !== port && carol !== bobPort && ![4848, 4849, 4850].includes(carol));

    const stop = await cli(['stop', '--profile', 'alice'], env);
    assert.equal(stop.code, 0);
    assert.match(stop.stdout, /won't start at login/);
    assert.ok(!fs.existsSync(plistFile));
    assert.deepEqual(dryrun(h).at(-1), { cmd: 'launchctl', args: ['bootout', `gui/${UID}/com.obysphere.alice`] });
    assert.match((await cli(['stop', '--profile', 'alice'], env)).stdout, /isn't running in the background/);
  });

  test('start on Linux: a systemd user unit and systemctl --user (dry run); logs', async () => {
    const h = tmp('linux');
    const profiles = path.join(h, 'profiles');
    fakeProfile(profiles, 'alice');
    // a PATH with $ and % in it: systemd reads $ literally in Environment= and % everywhere as a specifier
    const env = envFor(h, { OBYSPHERE_HOME: profiles, OBYSPHERE_SERVICE_PLATFORM: 'linux', PATH: `${process.env.PATH}:/opt/odd$dir%x` });
    const r = await cli(['start'], env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /loginctl enable-linger/);
    const port = readJson(path.join(profiles, 'alice', 'service.json')).port;
    const unitFile = path.join(h, 'services', 'obysphere-alice.service');
    const unit = fs.readFileSync(unitFile, 'utf8');
    const exec = /^ExecStart=(.*)$/m.exec(unit)[1];
    assert.equal(exec.replace(/^"[^"]*" /, ''), `"--preserve-symlinks-main" "${REP}" "ui" "--serve" "--profile" "alice" "--port" "${port}"`);
    assert.match(unit, /^Restart=always$/m);
    assert.match(unit, /^WantedBy=default\.target$/m);
    assert.ok(unit.includes(`StandardOutput=append:${path.join(profiles, 'alice', 'logs', 'console.log')}`));
    assert.ok(unit.includes(`Environment="OBYSPHERE_HOME=${profiles}"`));
    assert.ok(unit.includes(`Environment="PATH=${process.env.PATH.replace(/%/g, '%%')}:/opt/odd$dir%%x"`), 'one $ in Environment=, and %% for %');
    assert.ok(!unit.includes('tok_'));
    assert.deepEqual(dryrun(h), [
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
      { cmd: 'systemctl', args: ['--user', 'enable', 'obysphere-alice.service'] },
      { cmd: 'systemctl', args: ['--user', 'restart', 'obysphere-alice.service'] },
    ]);

    // logs: the last lines, without terminal escapes
    fs.writeFileSync(path.join(profiles, 'alice', 'logs', 'console.log'), 'one\ntwo\n\x1b[31mthree\x1b[0m\n');
    const logs = await cli(['logs', '-n', '2'], env);
    assert.equal(logs.code, 0);
    assert.equal(logs.stdout, 'two\n[31mthree[0m\n');

    assert.equal((await cli(['stop'], env)).code, 0);
    assert.ok(!fs.existsSync(unitFile));
    assert.deepEqual(dryrun(h).slice(-2), [
      { cmd: 'systemctl', args: ['--user', 'disable', '--now', 'obysphere-alice.service'] },
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
    ]);
  });
});

describe('update and install.sh, from a fake GitHub', () => {
  let gh, work, apps;
  before(async () => {
    gh = await startFakeGitHub();
    work = tmp('builds');
    apps = {
      '9.9.0': buildApp(work, '9.9.0'),
      '9.9.1': buildApp(work, '9.9.1'),
      '9.9.2': buildApp(work, '9.9.2'),
      main: buildApp(work, '9.9.3', { prefix: 'oby-sphere-main' }),
    };
    gh.main = apps.main;
  });
  after(() => gh.close());
  // the fake GitHub: OBYSPHERE_TEST lets the two variables point at this machine
  const ghEnv = () => ({ OBYSPHERE_TEST: '1', OBYSPHERE_RELEASES_API: gh.api, OBYSPHERE_DOWNLOAD_BASE: gh.download });

  test('update: checked against SHA256SUMS, a mismatch refused, services restarted, rollback, main', async () => {
    const h = tmp('update');
    const app = path.join(h, 'app');
    const profiles = path.join(h, 'profiles');
    fakeProfile(profiles, 'alice');
    const env = envFor(h, { OBYSPHERE_HOME: profiles, OBYSPHERE_SERVICE_PLATFORM: 'darwin', ...ghEnv() });
    assert.equal((await cli(['start'], env)).code, 0);

    gh.release = null;
    const none = await cli(['update'], env);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /no release yet.*--channel main/);

    gh.release = release('9.9.0', apps['9.9.0']);
    assert.match((await cli(['update', '--check'], env)).stdout, new RegExp(`9\\.9\\.0 is out \\(you have ${PKG_VERSION.replaceAll(".", "\\.")}\\): obysphere update`));
    assert.ok(!fs.existsSync(path.join(app, '9.9.0')), '--check downloads nothing');

    const first = await cli(['update'], env);
    assert.equal(first.code, 0, first.out);
    assert.match(first.stdout, /matches the release's SHA256SUMS/);
    assert.equal(linkOf(path.join(app, 'current')), '9.9.0');
    assert.ok(fs.existsSync(path.join(app, '9.9.0', 'rep.mjs')));
    assert.equal(readJson(path.join(app, 'install.json')).channel, 'stable');
    const shim = fs.readFileSync(path.join(h, 'bin', 'obysphere'), 'utf8');
    assert.match(shim, /^#!\/bin\/sh\n# obysphere shim/);
    assert.ok(shim.includes(`exec node --preserve-symlinks-main '${path.join(app, 'current', 'obysphere.mjs')}' "$@"`));
    // the running service starts again, from `current`
    const plist = fs.readFileSync(path.join(h, 'services', 'com.obysphere.alice.plist'), 'utf8');
    assert.ok(plist.includes(`<string>${path.join(app, 'current', 'rep.mjs')}</string>`));
    // and the menu bar icon's agent (test/menubar.test.mjs), whose obysphere is current's now
    assert.deepEqual(dryrun(h).slice(-4), [
      { cmd: 'launchctl', args: ['bootout', `gui/${UID}/com.obysphere.alice`] },
      { cmd: 'launchctl', args: ['bootstrap', `gui/${UID}`, path.join(h, 'services', 'com.obysphere.alice.plist')] },
      { cmd: 'launchctl', args: ['bootout', `gui/${UID}/com.obysphere.menubar`] },
      { cmd: 'launchctl', args: ['bootstrap', `gui/${UID}`, path.join(h, 'services', 'com.obysphere.menubar.plist')] },
    ]);
    assert.ok(fs.readFileSync(path.join(h, 'services', 'com.obysphere.menubar.plist'), 'utf8').includes(`<string>${path.join(app, 'current', 'obysphere.mjs')}</string>`));
    assert.match(first.stdout, /restarted alice/);
    // and the installed one runs
    const installed = await run(path.join(app, 'current', 'obysphere.mjs'), ['version'], env, { pre: ['--preserve-symlinks-main', path.join(app, 'current', 'obysphere.mjs')] });
    assert.match(installed.stdout, /^obysphere 9\.9\.0\n/);
    assert.match(installed.stdout, /installed, stable channel, current: 9\.9\.0/);

    gh.release = release('9.9.1', apps['9.9.1']);
    assert.equal((await cli(['update'], env)).code, 0);
    assert.equal(linkOf(path.join(app, 'current')), '9.9.1');
    assert.equal(linkOf(path.join(app, 'previous')), '9.9.0');
    assert.match((await cli(['update'], env)).stdout, /You have it already: 9\.9\.1/);

    // a download that doesn't match its SHA256SUMS changes nothing
    gh.release = release('9.9.2', apps['9.9.2'], { badSum: true });
    const bad = await cli(['update'], env);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /obysphere-9\.9\.2\.tar\.gz doesn't match the release's SHA256SUMS .*Nothing was changed/);
    gh.release = release('9.9.2', apps['9.9.2'], { noLine: true });
    assert.match((await cli(['update'], env)).stderr, /has no line for obysphere-9\.9\.2\.tar\.gz/);
    assert.ok(!fs.existsSync(path.join(app, '9.9.2')));
    assert.equal(linkOf(path.join(app, 'current')), '9.9.1');
    assert.deepEqual(fs.readdirSync(app).filter((n) => n.startsWith('.')), [], 'nothing left half-unpacked');

    // rollback, both ways
    const back = await cli(['update', '--rollback'], env);
    assert.equal(back.code, 0);
    assert.match(back.stdout, /back to 9\.9\.0/);
    assert.equal(linkOf(path.join(app, 'current')), '9.9.0');
    assert.equal(linkOf(path.join(app, 'previous')), '9.9.1');
    assert.equal((await cli(['update', '--rollback'], env)).code, 0);
    assert.equal(linkOf(path.join(app, 'current')), '9.9.1');

    // main: not checksummed, and said so; only current and previous are kept
    const main = await cli(['update', '--channel', 'main'], env);
    assert.equal(main.code, 0, main.out);
    assert.match(main.stderr, /main isn't checksummed/);
    assert.equal(linkOf(path.join(app, 'current')), `9.9.3+main.${sha256(apps.main).slice(0, 8)}`);
    assert.equal(readJson(path.join(app, 'install.json')).channel, 'main');
    assert.deepEqual(fs.readdirSync(app).filter((n) => /^\d/.test(n)).sort(), ['9.9.1', `9.9.3+main.${sha256(apps.main).slice(0, 8)}`]);
    assert.match((await cli(['update', '--check'], env)).stdout, /main has no version to compare with/);
  });

  test('install.sh: the latest release, checked, in the app home, with the obysphere command', async () => {
    const nodeDir = path.dirname(process.execPath);
    // install.sh reads only PATH, HOME, SHELL and the download overrides (with OBYSPHERE_TEST); the rest keeps the installed CLI in a dry run
    const shEnv = (h, extra = {}) => ({ PATH: `${nodeDir}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: h, TMPDIR: os.tmpdir(), SHELL: '/bin/zsh', OBYSPHERE_SERVICE_DRYRUN: '1', OBYSPHERE_SERVICE_DIR: path.join(h, 'services'), ...ghEnv(), ...extra });

    gh.release = release('9.9.1', apps['9.9.1']);
    const h = tmp('install');
    const r = await sh([], shEnv(h));
    assert.equal(r.code, 0, r.out);
    const app = path.join(h, '.local', 'share', 'obysphere');
    assert.ok(fs.existsSync(path.join(app, '9.9.1', 'obysphere.mjs')));
    assert.equal(linkOf(path.join(app, 'current')), '9.9.1');
    assert.deepEqual(readJson(path.join(app, 'install.json')), { channel: 'stable', version: '9.9.1' });
    const shim = path.join(h, '.local', 'bin', 'obysphere');
    assert.ok(fs.statSync(shim).mode & 0o100, 'the shim runs');
    assert.match(r.stdout, /matches the release's SHA256SUMS/);
    assert.match(r.stdout, /\.local\/bin isn't on your PATH yet/);
    assert.match(r.stdout, /echo 'export PATH=".*\.local\/bin:\$PATH"' >> .*\.zshrc/);
    assert.match(r.stdout, /obysphere join "<invite link>" --name <handle> --owner "<Your Name>"/);
    assert.match(r.stdout, /obysphere start/);
    assert.ok(!fs.existsSync(path.join(h, '.obysphere')), 'the installer never makes ~/.obysphere');
    // the shim runs the installed version, and is the one obysphere update would write
    const ran = await run(shim, ['version'], shEnv(h), { cmd: 'sh' });
    assert.match(ran.stdout, /^obysphere 9\.9\.1\n/);
    const upd = await run(shim, ['update', '--check'], shEnv(h), { cmd: 'sh' });
    assert.match(upd.stdout, /You have the newest release \(9\.9\.1\)/);
    const before = fs.readFileSync(shim, 'utf8');
    gh.release = release('9.9.2', apps['9.9.2']);
    assert.equal((await run(shim, ['update'], shEnv(h, { OBYSPHERE_NO_UPDATE_CHECK: '1' }), { cmd: 'sh' })).code, 0);
    assert.equal(fs.readFileSync(shim, 'utf8'), before);
    assert.equal(linkOf(path.join(app, 'current')), '9.9.2');
    assert.equal(linkOf(path.join(app, 'previous')), '9.9.1');

    // a mismatch installs nothing
    gh.release = release('9.9.2', apps['9.9.2'], { badSum: true });
    const h2 = tmp('install-bad');
    const bad = await sh([], shEnv(h2));
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /doesn't match the release's SHA256SUMS.*Nothing was installed/);
    assert.ok(!fs.existsSync(path.join(h2, '.local', 'bin', 'obysphere')));
    assert.ok(!fs.existsSync(path.join(h2, '.local', 'share', 'obysphere', '9.9.2')));

    // no release yet: it says how to take main
    gh.release = null;
    const none = await sh([], shEnv(tmp('install-none')));
    assert.notEqual(none.code, 0);
    assert.match(none.stderr, /no release yet.*\n.*--channel main/);

    // --channel main
    const h3 = tmp('install-main');
    const main = await sh(['--channel', 'main'], shEnv(h3));
    assert.equal(main.code, 0, main.out);
    assert.match(main.stdout, /main isn't checksummed/);
    assert.equal(linkOf(path.join(h3, '.local', 'share', 'obysphere', 'current')), `9.9.3+main.${sha256(apps.main).slice(0, 8)}`);

    // a version that isn't a folder name (a / or ..) is refused before anything moves, by both
    try {
      gh.main = buildApp(work, '9.9.4/../../escaped', { prefix: 'oby-sphere-main' });
      const h4 = tmp('install-bad-version');
      const odd = await sh(['--channel', 'main'], shEnv(h4));
      assert.equal(odd.code, 1);
      assert.match(odd.stderr, /no usable version: '9\.9\.4\/\.\.\/\.\.\/escaped'/);
      assert.deepEqual(fs.readdirSync(h4).filter((n) => n !== '.local'), [], 'nothing outside the app home');
      assert.ok(!fs.existsSync(path.join(h4, '.local', 'bin', 'obysphere')));
      const upd = await cli(['update', '--channel', 'main'], envFor(h4, ghEnv()));
      assert.equal(upd.code, 1);
      assert.match(upd.stderr, /no usable version/);
    } finally {
      gh.main = apps.main;
    }

    // Node older than 22: said plainly
    const old = tmp('install-old-node');
    fs.mkdirSync(path.join(old, 'fakebin'));
    fs.writeFileSync(path.join(old, 'fakebin', 'node'), '#!/bin/sh\necho v18.19.0\n', { mode: 0o755 });
    const r18 = await sh([], { ...shEnv(old), PATH: `${path.join(old, 'fakebin')}:/usr/bin:/bin` });
    assert.equal(r18.code, 1);
    assert.match(r18.stderr, /needs Node 22 or later; this computer has v18\.19\.0/);
    assert.ok(!fs.existsSync(path.join(old, '.local')));
  });
});

describe('server deploy vercel, with a fake vercel', () => {
  let h, env, vercel, app;
  const keysFile = () => path.join(app, 'servers', 'team-sphere.keys');
  const appAt = (version) => {
    const dir = path.join(app, version);
    for (const f of ['server.mjs', 'rep.mjs', 'obysphere.mjs', 'vercel.json', '.vercelignore', 'api/sphere.mjs', 'public/index.html']) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
    }
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'obysphere', version }));
    // what must never be deployed
    for (const [f, text] of [['data/sphere.json', '{"secret":true}'], ['.env.local', 'VERCEL_OIDC_TOKEN=nope'], ['.git/config', '[core]'], ['node_modules/x/index.js', ''], ['notes.log', 'log']]) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), text);
    }
    fs.rmSync(path.join(app, 'current'), { force: true });
    fs.symlinkSync(version, path.join(app, 'current'));
  };
  const secretsIn = (s) => {
    const k = readJson(keysFile());
    return s.includes(k.SPHERE_KEY) || s.includes(k.SPHERE_ADMIN_KEY);
  };

  before(() => {
    h = tmp('deploy');
    app = path.join(h, 'app');
    appAt('1.2.3');
    vercel = makeFakeVercel(path.join(h, 'fakebin'), { url: relayBase, deployment: 'https://team-sphere-abc123.vercel.app' });
    env = envFor(h, { OBYSPHERE_HOME: path.join(h, 'profiles'), PATH: `${vercel.dir}:${process.env.PATH}` });
  });

  test('without Redis it stops before deploying; the keys are made once and reach vercel on stdin', async () => {
    const r = await cli(['server', 'deploy', 'vercel', '--project', 'team-sphere', '--scope', 'acme-team', '--name', 'Team Sphere'], env);
    assert.equal(r.code, 1, r.out);
    assert.match(r.stderr, /No Redis store is connected to team-sphere yet/);
    assert.match(r.stderr, /Upstash/);
    const keys = readJson(keysFile());
    assert.equal(fs.statSync(keysFile()).mode & 0o777, 0o600);
    assert.ok(keys.SPHERE_KEY.length >= 22 && keys.SPHERE_ADMIN_KEY.length >= 22 && keys.SPHERE_KEY !== keys.SPHERE_ADMIN_KEY);
    const calls = vercel.calls();
    assert.deepEqual(calls.map((c) => c.argv), [
      ['link', '--yes', '--project', 'team-sphere', '--scope', 'acme-team'],
      ['env', 'ls', 'production', '--scope', 'acme-team'],
      ['env', 'add', 'SPHERE_KEY', 'production', '--sensitive', '--scope', 'acme-team'],
      ['env', 'add', 'SPHERE_ADMIN_KEY', 'production', '--sensitive', '--scope', 'acme-team'],
      ['env', 'add', 'SPHERE_NAME', 'production', '--sensitive', '--scope', 'acme-team'],
    ]);
    assert.deepEqual(calls.slice(2).map((c) => c.stdin), [keys.SPHERE_KEY, keys.SPHERE_ADMIN_KEY, 'Team Sphere']);
    assert.ok(!calls.some((c) => secretsIn(c.argv.join(' '))), 'no key in any argument');
    assert.ok(!secretsIn(r.out), 'no key printed');
    // a clean export, removed afterwards
    const files = calls[0].files;
    for (const f of ['server.mjs', 'rep.mjs', 'vercel.json', '.vercelignore', 'package.json', path.join('api', 'sphere.mjs'), path.join('public', 'index.html')]) assert.ok(files.includes(f), `exports ${f}`);
    assert.ok(!files.some((f) => /^(\.git|data|node_modules)[\\/]|^\.env|\.log$/.test(f)), files.join(', '));
    assert.ok(!fs.existsSync(calls[0].cwd), 'the export is gone');
  });

  test('with Redis it deploys, records it without secrets, and prints the invite without the key', async () => {
    const before = vercel.calls().length;
    const keys = readJson(keysFile());
    vercel.set({ redis: true });
    const r = await cli(['server', 'deploy', 'vercel', '--project', 'team-sphere', '--scope', 'acme-team', '--name', 'Team Sphere'], env);
    assert.equal(r.code, 0, r.out);
    const calls = vercel.calls().slice(before);
    assert.deepEqual(calls.map((c) => c.argv.slice(0, 2)), [['link', '--yes'], ['env', 'ls'], ['deploy', '--prod']], 'the variables are set once');
    assert.ok(calls[2].files.includes(path.join('.vercel', 'project.json')), 'linked by vercel link');
    assert.deepEqual(readJson(keysFile()), keys, 'the same keys');
    const rec = readJson(path.join(app, 'servers', 'team-sphere.json'));
    assert.equal(rec.project, 'team-sphere');
    assert.equal(rec.scope, 'acme-team');
    assert.equal(rec.url, relayBase);
    assert.equal(rec.deployment, 'https://team-sphere-abc123.vercel.app');
    assert.equal(rec.version, '1.2.3');
    assert.ok(!secretsIn(JSON.stringify(rec)), 'no secrets in the record');
    assert.ok(r.stdout.includes(`${relayBase}/#key=<SPHERE_KEY from that file>`));
    assert.ok(r.stdout.includes(keysFile()));
    assert.match(r.stdout, /It answers: relay 0\.3, fs store/);
    assert.ok(!secretsIn(r.out), 'no key printed');
  });

  test('server update deploys the installed version again; server status checks /healthz', async () => {
    appAt('1.2.4');
    const r = await cli(['server', 'update'], env);
    assert.equal(r.code, 0, r.out);
    assert.equal(vercel.calls().at(-1).argv[0], 'deploy');
    assert.equal(readJson(path.join(app, 'servers', 'team-sphere.json')).version, '1.2.4');

    const st = await cli(['server', 'status'], env);
    assert.equal(st.code, 0, st.out);
    assert.match(st.stdout, /team-sphere/);
    assert.match(st.stdout, /up · relay 0\.3 · fs store/);
    const down = await cli(['server', 'status', 'http://127.0.0.1:9'], env);
    assert.equal(down.code, 1);
    assert.match(down.stdout, /doesn't answer/);

    assert.match((await cli(['server', 'deploy', 'docker'], env)).stdout, /docker build -t obysphere[\s\S]*--env-file ~\/obysphere\.env/);
    const railway = (await cli(['server', 'deploy', 'railway'], env)).stdout;
    assert.match(railway, /mounted at \/data/);
    assert.ok(railway.includes('https://railway.com/deploy/oby-sphere'), 'the one-click template');
  });

  test('server update never makes new keys for a Sphere that has data', async () => {
    fs.rmSync(keysFile());
    const s = vercel.state();
    delete s.env.SPHERE_ADMIN_KEY;
    vercel.set({ env: s.env });
    const r = await cli(['server', 'update', 'team-sphere'], env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /SPHERE_ADMIN_KEY isn't set on Vercel any more.*new keys would lock its data/s);
    assert.ok(!fs.existsSync(keysFile()));
  });

  test('a key set on Vercel by hand is left alone, and the keys file never claims it', async () => {
    const byHand = 'set-by-hand-on-vercel-0123456789';
    const v2 = makeFakeVercel(path.join(h, 'fakebin2'), { url: relayBase, deployment: 'https://by-hand-abc123.vercel.app', redis: true, env: { SPHERE_KEY: byHand } });
    const env2 = { ...env, PATH: `${v2.dir}:${process.env.PATH}` };
    const file = path.join(app, 'servers', 'by-hand.keys');
    const r = await cli(['server', 'deploy', 'vercel', '--project', 'by-hand'], env2);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(v2.calls().filter((c) => c.argv[0] === 'env' && c.argv[1] === 'add').map((c) => c.argv[2]), ['SPHERE_ADMIN_KEY'], 'only the missing key is set');
    const keys = readJson(file);
    assert.equal(keys.SPHERE_KEY, undefined, 'no made-up join key in the file');
    assert.equal(keys.SPHERE_ADMIN_KEY, v2.state().env.SPHERE_ADMIN_KEY);
    assert.equal(v2.state().env.SPHERE_KEY, byHand, 'the join key on Vercel is untouched');
    assert.ok(r.stdout.includes(`${relayBase}/#key=<the join key set on Vercel>`), r.stdout);
    assert.ok(r.stdout.includes('OBYSPHERE_ADMIN_KEY=<SPHERE_ADMIN_KEY from that file>'));
    assert.ok(!r.out.includes(keys.SPHERE_ADMIN_KEY) && !r.out.includes(byHand), 'no key printed');

    // later, with SPHERE_KEY gone from Vercel: the file doesn't have it, so no new one is made up
    const s = v2.state();
    delete s.env.SPHERE_KEY;
    v2.set({ env: s.env });
    const up = await cli(['server', 'update', 'by-hand'], env2);
    assert.equal(up.code, 1);
    assert.match(up.stderr, /SPHERE_KEY isn't set on Vercel any more, and it isn't in the keys for by-hand here/);
    assert.deepEqual(readJson(file), keys, 'the keys file is unchanged');
  });
});

describe('status, open and the version check, against a local relay', () => {
  let h, profiles, env, port;
  before(async () => {
    h = tmp('status');
    profiles = path.join(h, 'profiles');
    fs.mkdirSync(path.join(h, 'work'));
    fs.mkdirSync(path.join(h, 'app'));
    env = envFor(h, { OBYSPHERE_HOME: profiles, OBYSPHERE_SERVICE_PLATFORM: 'darwin' });
    const j = await cli(['join', `${relayBase}/#key=${KEY}`, '--name', 'alice', '--owner', 'Alice', '--cwd', path.join(h, 'work')], env);
    assert.equal(j.code, 0, j.out);
    assert.match(j.stdout, /Go online, in the background: +obysphere start --profile alice/);
  });

  test('status: running or not, the console, the Sphere, versions and updates', async () => {
    let s = JSON.parse((await cli(['status', '--json'], env)).stdout);
    assert.equal(s.client, PKG_VERSION);
    assert.equal(s.profiles.length, 1);
    assert.deepEqual(
      { profile: s.profiles[0].profile, running: s.profiles[0].running, reachable: s.profiles[0].relay.reachable, relay: s.profiles[0].relay.version, versions: s.profiles[0].versions },
      { profile: 'alice', running: false, reachable: true, relay: '0.3', versions: 'same' },
    );
    assert.match((await cli(['status'], env)).stdout, /not running: obysphere start[\s\S]*reachable · relay 0\.3[\s\S]*they match/);
    assert.equal((await cli(['open'], env)).code, 1);

    // the console running (as its service would run it)
    port = await freePort();
    fs.writeFileSync(path.join(profiles, 'alice', 'service.json'), JSON.stringify({ port }));
    const ui = spawn(process.execPath, [REP, 'ui', '--profile', 'alice', '--port', String(port)], { env, stdio: 'ignore' });
    procs.push(ui);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/favicon.svg`)).ok);
    s = JSON.parse((await cli(['status', '--json'], env)).stdout);
    assert.equal(s.profiles[0].running, true);
    assert.equal(s.profiles[0].console, `http://alice.localhost:${port}/`);
    assert.equal(s.profiles[0].service, false);
    assert.match((await cli(['status'], env)).stdout, /running at http:\/\/alice\.localhost:\d+\/ \(in a terminal\)/);

    const open = await cli(['open'], env);
    assert.equal(open.code, 0, open.out);
    // signed in: a code that works once, on osascript's stdin (never the secret, nor a command line)
    const opened = dryrun(h).at(-1);
    assert.equal(opened.cmd, 'osascript');
    assert.deepEqual(opened.args, []);
    assert.match(opened.input, new RegExp(`^open location "http://alice\\.localhost:${port}/#code=[A-Za-z0-9_-]{43}"\n$`));
    assert.ok(!JSON.stringify(opened).includes(consoleSecret(path.join(profiles, 'alice'), port)));

    // restart doesn't put a service on the port a console in a terminal holds (it would only fail to listen)
    const again = await cli(['restart'], env);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /alice's console runs at http:\/\/alice\.localhost:\d+\/, in a terminal: stop it there/);
    assert.ok(!fs.existsSync(path.join(h, 'services', 'com.obysphere.alice.plist')), 'no service written');

    // a Sphere that doesn't answer
    fakeProfile(profiles, 'bob');
    const bob = JSON.parse((await cli(['status', '--json'], env)).stdout).profiles.find((p) => p.profile === 'bob');
    assert.equal(bob.relay.reachable, false);
    assert.ok(bob.relay.error);

    // an update, as last checked
    fs.writeFileSync(path.join(h, 'app', 'update-check.json'), JSON.stringify({ latest: '9.9.9', checkedAt: new Date().toISOString() }));
    s = JSON.parse((await cli(['status', '--json'], env)).stdout);
    assert.equal(s.update, '9.9.9');
    assert.match((await cli(['status'], env)).stdout, /9\.9\.9 is out: obysphere update/);
    const doc = await cli(['doctor'], env);
    assert.match(doc.stdout, /Node \d+/);
    assert.match(doc.stdout, /alice[\s\S]*console running at/);
    assert.match(doc.stdout, new RegExp(`9\\.9\\.9 is out \\(you have ${PKG_VERSION.replaceAll(".", "\\.")}\\)`));
  });

  test("the console's GET /local/version: what's known now, checked once a day in the background", async () => {
    const get = (p, headers = consoleAuth(path.join(profiles, 'alice'), p)) => fetch(`http://127.0.0.1:${p}/local/version`, { headers }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
    assert.equal((await get(port, { 'x-obysphere-console': '1' })).status, 401, 'the old constant header opens nothing');
    fs.rmSync(path.join(h, 'app', 'update-check.json'), { force: true });
    assert.deepEqual(await get(port), { status: 200, current: PKG_VERSION, latest: null, checkedAt: null }); // OBYSPHERE_NO_UPDATE_CHECK
    fs.writeFileSync(path.join(h, 'app', 'update-check.json'), JSON.stringify({ latest: '9.9.9', checkedAt: '2026-11-25T10:00:00.000Z' }));
    assert.deepEqual(await get(port), { status: 200, current: PKG_VERSION, latest: '9.9.9', checkedAt: '2026-11-25T10:00:00.000Z' });

    // with the check on: the first answer doesn't wait for GitHub; the next has it; then no more asking
    const gh = await startFakeGitHub();
    try {
      gh.release = { tag: 'v9.9.1', assets: {} };
      const app2 = path.join(h, 'app2');
      fs.mkdirSync(app2);
      const p2 = await freePort();
      const ui = spawn(process.execPath, [REP, 'ui', '--profile', 'alice', '--port', String(p2)], {
        env: { ...env, OBYSPHERE_APP_HOME: app2, OBYSPHERE_NO_UPDATE_CHECK: '', OBYSPHERE_TEST: '1', OBYSPHERE_RELEASES_API: gh.api },
        stdio: 'ignore',
      });
      procs.push(ui);
      await waitFor(async () => (await fetch(`http://127.0.0.1:${p2}/favicon.svg`)).ok);
      const first = await get(p2);
      assert.equal(first.latest, null);
      await waitFor(() => fs.existsSync(path.join(app2, 'update-check.json')));
      const second = await get(p2);
      assert.equal(second.latest, '9.9.1');
      assert.ok(second.checkedAt);
      await get(p2);
      await get(p2);
      assert.equal(gh.requests.filter((r) => r === '/api/releases/latest').length, 1, 'once a day');
      assert.equal(fs.statSync(path.join(app2, 'update-check.json')).mode & 0o777, 0o600);
    } finally {
      gh.close();
    }
  });
});

describe('the background service when the Sphere is away as it starts', () => {
  test('ui --serve keeps the console up and brings your Oby online once the Sphere answers', async () => {
    const h = tmp('offline');
    const data = path.join(h, 'data');
    const rport = await freePort();
    const base = `http://127.0.0.1:${rport}`;
    const startRelay = () => {
      const r = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(rport), '--host', '127.0.0.1', '--data', data], {
        env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_SEALED: '0', SPHERE_STORE: 'fs' },
        stdio: 'ignore',
      });
      procs.push(r);
      return r;
    };
    const first = startRelay();
    await waitFor(async () => (await fetch(base + '/healthz')).ok);
    fs.mkdirSync(path.join(h, 'work'));
    const env = envFor(h, { OBYSPHERE_HOME: path.join(h, 'profiles') });
    const j = await cli(['join', `${base}/#key=${KEY}`, '--name', 'dora', '--owner', 'Dora', '--cwd', path.join(h, 'work')], env);
    assert.equal(j.code, 0, j.out);
    first.kill();
    await waitFor(async () => !(await fetch(base + '/healthz').then((x) => x.ok, () => false)));

    // as the service runs it, with no Sphere to reach (at login, before the network is up)
    const cport = await freePort();
    let log = '';
    const ui = spawn(process.execPath, [REP, 'ui', '--serve', '--profile', 'dora', '--port', String(cport)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(ui);
    ui.stdout.on('data', (d) => (log += d));
    ui.stderr.on('data', (d) => (log += d));
    await waitFor(() => /your Oby isn't online yet .*trying again in \d+s/.test(log));
    assert.ok((await fetch(`http://127.0.0.1:${cport}/favicon.svg`)).ok, 'the console is up');

    startRelay();
    await waitFor(() => /dora is online/.test(log), 30000);
    const { agents } = await (await fetch(base + '/api/agents', { headers: { 'x-sphere-key': KEY } })).json();
    assert.equal(agents.find((a) => a.name === 'dora')?.online, true, 'the Sphere sees it online');
  });
});
