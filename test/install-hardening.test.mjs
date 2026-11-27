// Installing, updating and the services, hardened (the November 2026 audit of install, update and
// the OS integration), with no network beyond this machine and nothing outside temp folders:
// programs found by their full path only (never in the folder a command runs in, nor through an
// empty or relative PATH entry, which is where Windows and a careless PATH look first), the
// download from GitHub only (the test variables only with OBYSPHERE_TEST=1, on this machine, and
// every redirect checked), no test variable written into a service file, the menu bar's app only
// as it was built here, a shim that isn't ours left alone, the `menubar` profile name kept for the
// icon, no downgrade unless asked, a download cut at its limit, the menu bar's polling kept small,
// install.sh safe to pipe, and a slug that costs no time. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitHub, buildApp, release } from './fake-cli.mjs';
import { makeFakeRuntimes } from './fake-runtimes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.join(HERE, '..'));
const CLI = path.join(ROOT, 'obysphere.mjs');
const REP = path.join(ROOT, 'rep.mjs');
const INSTALL = path.join(ROOT, 'install.sh');
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const NODE_DIR = path.dirname(process.execPath);
const KEY = 'join-key-hardening-0123456789';
const roots = [];
const closers = [];

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (name) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `obysphere-hard-${name}-`)));
  roots.push(d);
  return d;
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

after(() => {
  for (const c of closers) c();
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});

// a clean environment: its own home, a dry run for services, test mode, and no GitHub to reach
function envFor(home, extra = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: os.tmpdir(),
    LANG: 'C',
    OBYSPHERE_TEST: '1',
    OBYSPHERE_NO_UPDATE_CHECK: '1',
    OBYSPHERE_SERVICE_DRYRUN: '1',
    OBYSPHERE_SERVICE_DIR: path.join(home, 'services'),
    OBYSPHERE_APP_HOME: path.join(home, 'app'),
    OBYSPHERE_BIN_DIR: path.join(home, 'bin'),
    OBYSPHERE_HOME: path.join(home, 'profiles'),
    OBYSPHERE_RELEASES_API: 'http://127.0.0.1:9/api',
    OBYSPHERE_DOWNLOAD_BASE: 'http://127.0.0.1:9/dl',
    ...extra,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}
const ghEnv = (gh) => ({ OBYSPHERE_TEST: '1', OBYSPHERE_RELEASES_API: gh.api, OBYSPHERE_DOWNLOAD_BASE: gh.download });

function run(cmd, args, env, { cwd, input, timeoutMs = 90000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(cmd, args, { env, cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr, out: stdout + stderr, ms: Date.now() - t0 });
    });
    if (input !== undefined) {
      p.stdin.on('error', () => {});
      p.stdin.end(input);
    }
  });
}
const cli = (args, env, opts) => run(process.execPath, [CLI, ...args], env, opts);
const rep = (args, env, opts) => run(process.execPath, [REP, ...args], env, opts);

function fakeProfile(profiles, name, extra = {}) {
  const dir = path.join(profiles, name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ profile: name, sphere: 'http://127.0.0.1:9', sphereName: 'Test Sphere', token: 'tok_never_in_a_service_file', agent: { id: `a_${name}`, name, owner: 'Alice Test' }, ...extra }), { mode: 0o600 });
  return dir;
}
// a program that only leaves a mark that it ran
function plant(dir, name, mark) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "$0" >> '${mark}'\nexit 1\n`, { mode: 0o755 });
}
// what a plist sets: its program's arguments and its environment
function plistOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  const strings = (s) => [...s.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  const args = strings(text.split('<key>ProgramArguments</key>')[1].split('</array>')[0]);
  const envPart = text.split('<key>EnvironmentVariables</key>')[1].split('</dict>')[0];
  const env = Object.fromEntries([...envPart.matchAll(/<key>([^<]*)<\/key><string>([^<]*)<\/string>/g)].map((m) => [m[1], m[2]]));
  return { text, args, env };
}

// a function of obysphere.mjs or rep.mjs by itself: its text, from `function <name>(` to the first
// line that is only `}`, with the modules it uses
function fnFrom(file, name) {
  const src = fs.readFileSync(file, 'utf8');
  const at = src.indexOf(`\nfunction ${name}(`);
  assert.ok(at >= 0, `${path.basename(file)} has function ${name}`);
  const end = src.indexOf('\n}\n', at);
  return new Function('path', 'fs', 'process', `${src.slice(at, end + 2)}\nreturn ${name};`)(path, fs, process);
}

describe('programs by their full path, never from the folder a command runs in (finding 1, 3)', () => {
  test('Windows: a claude.exe in the working folder or a relative PATH entry is never the one run', () => {
    for (const file of [CLI, REP]) {
      const programPath = fnFrom(file, 'programPath');
      const on = (platform, PATH, files) => (name) => programPath(name, { env: { PATH }, platform, isFile: (f) => files.includes(f) });
      // the working folder (where Windows looks first), `.`, relative and drive- or root-relative entries: skipped
      let find = on('win32', '.;bin;;"C:\\Quoted Tools";D:rel;\\rooted;C:\\Tools;C:\\Windows\\System32', [
        'claude.exe', '.\\claude.exe', 'bin\\claude.exe', 'D:rel\\claude.exe', '\\rooted\\claude.exe', 'C:\\Tools\\claude.exe',
        'C:\\Windows\\System32\\tar.exe', 'C:\\Windows\\System32\\cmd.exe', 'C:\\Quoted Tools\\git.exe',
      ]);
      assert.equal(find('claude'), 'C:\\Tools\\claude.exe', file);
      assert.equal(find('tar'), 'C:\\Windows\\System32\\tar.exe');
      assert.equal(find('cmd'), 'C:\\Windows\\System32\\cmd.exe');
      assert.equal(find('git'), 'C:\\Quoted Tools\\git.exe', 'a quoted PATH entry is a folder too');
      assert.equal(find('codex'), null);
      // only the working folder and relative entries have it: none, never the bare name
      find = on('win32', '.;bin;', ['claude.exe', '.\\claude.exe', 'bin\\claude.exe']);
      assert.equal(find('claude'), null);
      // .com before .exe, as Windows runs them; a name with .exe as it is; never .cmd or .bat (spawn can't run them)
      find = on('win32', 'C:\\A;C:\\B', ['C:\\A\\gh.cmd', 'C:\\A\\gh.bat', 'C:\\B\\gh.exe', 'C:\\B\\x.com', 'C:\\B\\x.exe']);
      assert.equal(find('gh'), 'C:\\B\\gh.exe');
      assert.equal(find('x'), 'C:\\B\\x.com');
      assert.equal(find('gh.exe'), 'C:\\B\\gh.exe');
      // a full path as it is; a relative path never
      assert.equal(on('win32', '', [])('C:\\Program Files\\Git\\cmd\\git.exe'), 'C:\\Program Files\\Git\\cmd\\git.exe');
      assert.equal(on('win32', 'C:\\Tools', ['C:\\Tools\\x\\claude.exe', 'x\\claude.exe'])('x\\claude'), null);
      // macOS and Linux: an empty entry, `.` and relative ones skipped
      find = on('linux', ':.:node_modules/.bin:/usr/bin:', ['claude', './claude', 'node_modules/.bin/claude', '/usr/bin/claude']);
      assert.equal(find('claude'), '/usr/bin/claude');
      assert.equal(on('darwin', '.:bin:', ['claude', './claude', 'bin/claude'])('claude'), null);
      assert.equal(on('darwin', '/usr/bin', ['/usr/bin/tar'])('./tar'), null);
      assert.equal(on('darwin', '', [])('/opt/homebrew/bin/gh'), '/opt/homebrew/bin/gh');
    }
  });

  test('PATH for a service or a runtime keeps its full folders only', () => {
    for (const file of [CLI, REP]) {
      const fullPath = fnFrom(file, 'fullPath');
      assert.equal(fullPath('/usr/bin::.:node_modules/.bin:/opt/x/bin:', 'darwin'), '/usr/bin:/opt/x/bin', file);
      assert.equal(fullPath('.:bin:', 'linux'), '');
      assert.equal(fullPath('C:\\Windows\\System32;.;bin;;D:rel;\\rooted;"C:\\Program Files\\Git\\cmd"', 'win32'), 'C:\\Windows\\System32;"C:\\Program Files\\Git\\cmd"');
    }
  });

  test('both programs tell Windows not to look in the working folder, before they start anything', () => {
    for (const file of [CLI, REP]) {
      const src = fs.readFileSync(file, 'utf8');
      const set = src.indexOf("process.env.NoDefaultCurrentDirectoryInExePath = '1';");
      assert.ok(set > 0, `${path.basename(file)} sets NoDefaultCurrentDirectoryInExePath`);
      assert.ok(set < src.search(/\bspawn(Sync)?\(/), 'before anything is spawned');
    }
  });

  test('update unpacks with the tar on PATH, never one in the folder it runs in or in a relative PATH entry', { skip: WIN && 'shell scripts as programs' }, async () => {
    const h = tmp('tar');
    const gh = await startFakeGitHub();
    closers.push(() => gh.close());
    gh.release = release('9.9.0', buildApp(tmp('tar-build'), '9.9.0'));
    const here = path.join(h, 'shared-repo');
    const mark = path.join(h, 'planted-ran');
    plant(here, 'tar', mark);
    plant(path.join(here, 'node_modules', '.bin'), 'tar', mark);
    const env = envFor(h, { ...ghEnv(gh), PATH: `.:node_modules/.bin::${process.env.PATH}` });
    const r = await cli(['update'], env, { cwd: here });
    assert.equal(r.code, 0, r.out);
    assert.ok(!fs.existsSync(mark), `a planted tar ran: ${fs.existsSync(mark) && fs.readFileSync(mark, 'utf8')}`);
    assert.equal(linkOf(path.join(h, 'app', 'current')), '9.9.0');
  });

  test('rep.mjs runs gh from full PATH folders only, never from the temp folder it probes in', { skip: WIN && 'shell scripts as programs' }, async () => {
    const h = tmp('gh');
    const profiles = path.join(h, 'profiles');
    fakeProfile(profiles, 'alice', { cwd: h });
    const temp = path.join(h, 'shared-tmp');
    const mark = path.join(h, 'planted-ran');
    for (const n of ['gh', 'claude', 'codex', 'cursor-agent']) plant(temp, n, mark);
    // an empty entry and `.` both mean the folder a program runs in: the probes run in the temp folder
    const env = envFor(h, { PATH: `:.:/usr/bin:/bin`, TMPDIR: temp });
    const r = await rep(['github', 'status', '--profile', 'alice', '--json'], env);
    assert.equal(r.code, 0, r.out);
    assert.ok(!fs.existsSync(mark), `a planted gh ran: ${fs.existsSync(mark) && fs.readFileSync(mark, 'utf8')}`);
  });

  test("an answer runs the runtime on PATH, never a claude in the owner's shared folder", { skip: WIN && 'shell scripts as programs', timeout: 120e3 }, async () => {
    const h = tmp('answer');
    const data = path.join(h, 'data');
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const relay = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', data], {
      env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: 'admin-key-hardening-0123456789', SPHERE_SEALED: '0', SPHERE_STORE: 'fs' },
      stdio: 'ignore',
    });
    closers.push(() => relay.kill());
    await waitFor(async () => (await fetch(base + '/healthz')).ok);
    // Bob shares a repository that has a claude of its own; the real one (a fake) is on PATH
    const shared = path.join(h, 'shared-repo');
    const mark = path.join(h, 'planted-ran');
    plant(shared, 'claude', mark);
    plant(path.join(shared, 'bin'), 'claude', mark);
    const fakes = path.join(h, 'runtimes');
    makeFakeRuntimes(fakes);
    const env = envFor(h, { PATH: `.:bin::${fakes}:/usr/bin:/bin`, OBYSPHERE_NOTIFY_LOG: path.join(h, 'notify.log') });
    const j = await rep(['join', `${base}/#key=${KEY}`, '--name', 'bob', '--owner', 'Bob Test', '--cwd', shared], env);
    assert.equal(j.code, 0, j.out);
    // Bob's Oby answers Alice without waiting for him
    const settings = path.join(h, 'profiles', 'bob', 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ ...readJson(settings), access: { ...readJson(settings).access, default: 'answer' } }), { mode: 0o600 });
    const alice = await (await fetch(base + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sphere-key': KEY }, body: JSON.stringify({ name: 'alice', owner: 'Alice Test' }) })).json();
    const serve = spawn(process.execPath, [REP, 'serve', '--profile', 'bob'], { env, cwd: shared, stdio: ['ignore', 'pipe', 'pipe'] });
    closers.push(() => serve.kill());
    let log = '';
    serve.stdout.on('data', (d) => (log += d));
    serve.stderr.on('data', (d) => (log += d));
    await waitFor(() => /is online/.test(log));
    const bobId = readJson(path.join(h, 'profiles', 'bob', 'profile.json')).agent.id;
    const asked = await (await fetch(base + '/api/messages', { method: 'POST', headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'general', text: 'What is in the repo?', to: [bobId] }) })).json();
    let reply = null;
    await waitFor(async () => {
      const r = await (await fetch(`${base}/api/messages/${asked.message.id}/replies?wait=2`, { headers: { authorization: `Bearer ${alice.token}` } })).json();
      reply = (r.replies || []).find((x) => x.from === bobId);
      return !!reply;
    }, 60000).catch((e) => {
      e.message += `\n${log.slice(-3000)}`;
      throw e;
    });
    assert.ok(!fs.existsSync(mark), `the shared folder's claude ran: ${fs.existsSync(mark) && fs.readFileSync(mark, 'utf8')}`);
    assert.match(reply.text, /fake answer/, `${reply.text}\n${log.slice(-2000)}`);
  });
});

describe('downloads from GitHub only (finding 2, 11)', () => {
  let gh, apps;
  before(async () => {
    gh = await startFakeGitHub();
    closers.push(() => gh.close());
    const work = tmp('builds');
    apps = { '9.9.0': buildApp(work, '9.9.0'), '9.9.1': buildApp(work, '9.9.1'), '9.9.9': buildApp(work, '9.9.9') };
  });

  test('without OBYSPHERE_TEST, the release variables send nothing anywhere', async () => {
    const h = tmp('no-test');
    gh.release = release('9.9.9', apps['9.9.9']);
    gh.main = apps['9.9.9'];
    gh.requests.length = 0;
    const env = envFor(h, { ...ghEnv(gh), OBYSPHERE_TEST: undefined });
    for (const args of [['update'], ['update', '--channel', 'main'], ['update', '--check']]) {
      const r = await cli(args, env);
      assert.equal(r.code, 1, r.out);
      assert.match(r.stderr, /OBYSPHERE_RELEASES_API and OBYSPHERE_DOWNLOAD_BASE are for tests only/);
    }
    // nor do the checks that status, doctor and the menu bar make
    fakeProfile(path.join(h, 'profiles'), 'alice');
    for (const args of [['status', '--json'], ['menubar', 'model']]) assert.equal((await cli(args, { ...env, OBYSPHERE_NO_UPDATE_CHECK: '' })).code, 0);
    const doc = await cli(['doctor'], { ...env, OBYSPHERE_NO_UPDATE_CHECK: '' });
    assert.match(doc.stdout, /✗ OBYSPHERE_RELEASES_API or OBYSPHERE_DOWNLOAD_BASE is set, so nothing is checked or downloaded/);
    assert.deepEqual(gh.requests, [], 'the fake release host was never asked');
    assert.ok(!fs.existsSync(path.join(h, 'app', '9.9.9')), 'nothing installed');
    // set to GitHub itself, they're refused all the same (another repository there is someone else's)
    const other = await cli(['update', '--check'], envFor(h, { OBYSPHERE_TEST: undefined, OBYSPHERE_RELEASES_API: 'https://api.github.com/repos/mallory/evil', OBYSPHERE_DOWNLOAD_BASE: undefined }));
    assert.equal(other.code, 1);
    assert.match(other.stderr, /for tests only/);
  });

  test('with OBYSPHERE_TEST, a server on this machine only', async () => {
    const h = tmp('elsewhere');
    // an IPv4-mapped address reaches this machine, but isn't one of the names a test may use
    const r = await cli(['update', '--check'], envFor(h, { OBYSPHERE_RELEASES_API: 'https://[::ffff:7f00:1]:9/api' }));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /refusing to download from https:\/\/\[::ffff:7f00:1\]:9: the app comes from GitHub only/);
    // nor another repository on GitHub: with the variables set, everything comes from this machine
    const other = await cli(['update', '--check'], envFor(h, { OBYSPHERE_RELEASES_API: 'https://api.github.com/repos/mallory/evil', OBYSPHERE_DOWNLOAD_BASE: 'https://github.com/mallory/evil' }));
    assert.equal(other.code, 1);
    assert.match(other.stderr, /refusing to download from https:\/\/api\.github\.com: the app comes from GitHub only/);
  });

  test('every redirect is checked before it is followed', async () => {
    const h = tmp('redirect');
    const port = new URL(gh.api).port;
    gh.release = release('9.9.0', apps['9.9.0']);
    const file = 'obysphere-9.9.0.tar.gz';
    // like GitHub, to where the asset is kept: followed
    gh.hook = (u, req, res) => {
      if (u.pathname === `/dl/releases/download/v9.9.0/${file}`) return res.writeHead(302, { location: `http://127.0.0.1:${port}/assets/${file}` }).end(), true;
      if (u.pathname === `/assets/${file}`) return res.writeHead(200).end(apps['9.9.0']), true;
      return false;
    };
    try {
      const ok = await cli(['update'], envFor(h, ghEnv(gh)));
      assert.equal(ok.code, 0, ok.out);
      assert.equal(linkOf(path.join(h, 'app', 'current')), '9.9.0');
      // elsewhere: refused before it's asked
      gh.release = release('9.9.1', apps['9.9.1']);
      gh.requests.length = 0;
      gh.hook = (u, req, res) => {
        if (u.pathname.startsWith('/dl/releases/download/v9.9.1/')) return res.writeHead(302, { location: `http://[::ffff:7f00:1]:${port}/elsewhere${u.pathname}` }).end(), true;
        return false;
      };
      const bad = await cli(['update'], envFor(h, ghEnv(gh)));
      assert.equal(bad.code, 1);
      assert.match(bad.stderr, /refusing to download from http:\/\/\[::ffff:7f00:1\]:\d+: the app comes from GitHub only/);
      assert.ok(!gh.requests.some((p) => p.startsWith('/elsewhere')), `followed: ${gh.requests.join(' ')}`);
      assert.equal(linkOf(path.join(h, 'app', 'current')), '9.9.0');
    } finally {
      gh.hook = null;
    }
  });

  test('a download is cut off at its limit, not read whole first', async () => {
    const h = tmp('endless');
    gh.release = release('9.9.1', apps['9.9.1']);
    let sent = 0;
    let closed = false;
    gh.hook = (u, req, res) => {
      if (!u.pathname.endsWith('.tar.gz')) return false;
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(1024 * 1024);
      const more = () => {
        while (!closed && sent < 256 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return res.once('drain', more);
        }
        res.end();
      };
      res.on('close', () => (closed = true));
      more();
      return true;
    };
    try {
      const r = await cli(['update'], envFor(h, ghEnv(gh)), { timeoutMs: 120e3 });
      assert.equal(r.code, 1, r.out);
      assert.match(r.stderr, /obysphere-9\.9\.1\.tar\.gz is larger than expected/);
      await waitFor(() => closed, 5000);
      assert.ok(sent < 80 * 1024 * 1024, `it read ${Math.round(sent / 1048576)} MB`);
    } finally {
      gh.hook = null;
    }
  });

  test('no downgrade unless asked: --allow-downgrade', async () => {
    const h = tmp('downgrade');
    gh.release = release('9.9.1', apps['9.9.1']);
    const env = envFor(h, ghEnv(gh));
    assert.equal((await cli(['update'], env)).code, 0);
    assert.equal(linkOf(path.join(h, 'app', 'current')), '9.9.1');
    gh.release = release('9.9.0', apps['9.9.0']);
    const r = await cli(['update'], env);
    assert.equal(r.code, 1, r.out);
    assert.match(r.stderr, /The latest release is 9\.9\.0, older than the 9\.9\.1 you have: nothing changed\. To go back to it on purpose: obysphere update --allow-downgrade/);
    assert.equal(linkOf(path.join(h, 'app', 'current')), '9.9.1');
    assert.ok(!fs.existsSync(path.join(h, 'app', '9.9.0')), 'nothing downloaded');
    const ok = await cli(['update', '--allow-downgrade'], env);
    assert.equal(ok.code, 0, ok.out);
    assert.equal(linkOf(path.join(h, 'app', 'current')), '9.9.0');
    assert.match((await cli(['help'], env)).stdout, /update \[--check\] \[--channel stable\|main\] \[--rollback\] \[--allow-downgrade\]/);
  });
});

describe('the service files and the menu bar app (finding 2, 3, 5)', () => {
  test('no test variable is written into a service file, and PATH keeps its full folders only', async () => {
    const h = tmp('svc-env');
    fakeProfile(path.join(h, 'profiles'), 'alice');
    const bad = { OBYSPHERE_RELEASES_API: 'http://127.0.0.1:9/api', OBYSPHERE_DOWNLOAD_BASE: 'http://127.0.0.1:9/dl', OBYSPHERE_NOTIFIER_APP: path.join(h, 'repo', 'Evil.app') };
    const PATH = `${NODE_DIR}::.:node_modules/.bin:/usr/bin:bin:`;
    const r = await cli(['start'], envFor(h, { ...bad, PATH, OBYSPHERE_SERVICE_PLATFORM: 'darwin' }));
    assert.equal(r.code, 0, r.out);
    for (const f of ['com.obysphere.alice.plist', 'com.obysphere.menubar.plist']) {
      const { env } = plistOf(path.join(h, 'services', f));
      for (const k of [...Object.keys(bad), 'OBYSPHERE_TEST']) assert.equal(env[k], undefined, `${f} has no ${k}`);
      assert.equal(env.PATH, `${NODE_DIR}:/usr/bin`, f);
    }
    const l = tmp('svc-env-linux');
    fakeProfile(path.join(l, 'profiles'), 'alice');
    assert.equal((await cli(['start'], envFor(l, { ...bad, PATH, OBYSPHERE_SERVICE_PLATFORM: 'linux' }))).code, 0);
    const unit = fs.readFileSync(path.join(l, 'services', 'obysphere-alice.service'), 'utf8');
    for (const k of [...Object.keys(bad), 'OBYSPHERE_TEST']) assert.ok(!unit.includes(k), `the unit has no ${k}`);
    assert.ok(unit.includes(`Environment="PATH=${NODE_DIR}:/usr/bin"`), unit);
  });

  test("OBYSPHERE_NOTIFIER_APP is the menu bar's app only in test mode", async () => {
    const h = tmp('evil-app');
    fakeProfile(path.join(h, 'profiles'), 'alice');
    const evil = path.join(h, 'repo', 'Evil.app');
    const real = path.join(h, 'Applications', 'Obysphere.app', 'Contents', 'MacOS', 'Obysphere');
    let r = await cli(['start'], envFor(h, { OBYSPHERE_TEST: undefined, OBYSPHERE_NOTIFIER_APP: evil, OBYSPHERE_SERVICE_PLATFORM: 'darwin' }));
    assert.equal(r.code, 0, r.out);
    assert.equal(plistOf(path.join(h, 'services', 'com.obysphere.menubar.plist')).args[0], real);
    r = await cli(['menubar', 'on'], envFor(h, { OBYSPHERE_NOTIFIER_APP: evil, OBYSPHERE_SERVICE_PLATFORM: 'darwin' }));
    assert.equal(r.code, 0, r.out);
    assert.equal(plistOf(path.join(h, 'services', 'com.obysphere.menubar.plist')).args[0], path.join(evil, 'Contents', 'MacOS', 'Obysphere'), 'tests may');
  });

  // an app with the right Info.plist and a program, as one someone else made would have
  const fakeApp = (app) => {
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleVersion</key><string>2</string></dict></plist>');
    fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'Obysphere'), '#!/bin/sh\necho evil\n', { mode: 0o755 });
    return path.join(app, 'Contents', 'MacOS', 'Obysphere');
  };

  test("rep.mjs uses the notifier app only as it built it here: a program it didn't build is built again", { skip: !MAC && 'macOS only' }, async () => {
    const h = tmp('notifier-hash');
    const evil = path.join(h, 'repo', 'Evil.app');
    const bin = fakeApp(evil);
    const empty = path.join(h, 'no-tools');
    fs.mkdirSync(empty);
    // no Xcode tools on this PATH: it can't be built, so there's no app, rather than that one
    const r = await rep(['notify', 'app', '--if-needed', '--json'], envFor(h, { OBYSPHERE_NOTIFIER_APP: evil, PATH: empty }));
    assert.equal(r.code, 1, r.out);
    const j = JSON.parse(r.stdout);
    assert.equal(j.app, null, r.out);
    assert.match(j.error, /Xcode command line tools/);
    assert.equal(fs.readFileSync(bin, 'utf8'), '#!/bin/sh\necho evil\n');
  });

  test('without test mode, rep.mjs ignores OBYSPHERE_NOTIFIER_APP and checks the app in ~/Applications', { skip: !MAC && 'macOS only' }, async () => {
    const h = tmp('notifier-default');
    const profiles = path.join(h, 'profiles');
    fs.mkdirSync(profiles);
    const evil = path.join(h, 'repo', 'Evil.app');
    fakeApp(evil);
    const app = path.join(h, 'Applications', 'Obysphere.app');
    const bin = fakeApp(app);
    // as built here: its program's hash, kept beside the profiles (0600)
    fs.writeFileSync(path.join(profiles, 'notifier.json'), JSON.stringify({ app, version: '2', sha256: sha256(fs.readFileSync(bin)) }), { mode: 0o600 });
    // no Xcode tools on PATH: were the check to fail, nothing could be built (or registered with macOS)
    const empty = path.join(h, 'no-tools');
    fs.mkdirSync(empty);
    const env = envFor(h, { OBYSPHERE_TEST: undefined, OBYSPHERE_NOTIFIER_APP: evil, PATH: empty });
    const r = await rep(['notify', 'app', '--if-needed', '--json'], env);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(JSON.parse(r.stdout), { app, built: false });
  });

  test('the profile name menubar is kept for the menu bar icon', async () => {
    const h = tmp('menubar-name');
    const profiles = path.join(h, 'profiles');
    fakeProfile(profiles, 'alice');
    fakeProfile(profiles, 'menubar');
    const env = envFor(h, { OBYSPHERE_SERVICE_PLATFORM: 'darwin' });
    const one = await cli(['start', '--profile', 'menubar'], env);
    assert.equal(one.code, 1, one.out);
    assert.match(one.stderr, /"menubar" is the menu bar icon's name/);
    assert.ok(!fs.existsSync(path.join(h, 'services', 'com.obysphere.menubar.plist')));
    const all = await cli(['start', '--all'], env);
    assert.equal(all.code, 0, all.out);
    assert.ok(!plistOf(path.join(h, 'services', 'com.obysphere.menubar.plist')).args.includes('ui'), 'the icon, not a console');
    assert.ok(!(await cli(['profiles', '--json'], env)).stdout.includes('"profile": "menubar"'));
    // and join won't make one
    fs.mkdirSync(path.join(h, 'work'));
    const j = await rep(['join', 'http://127.0.0.1:9/#key=nope', '--name', 'menubar', '--cwd', path.join(h, 'work')], envFor(h, { OBYSPHERE_HOME: path.join(h, 'other') }));
    assert.equal(j.code, 1);
    assert.match(j.stderr, /"menubar" is the menu bar icon's name/);
  });
});

describe('the shim, the menu bar and the slug (finding 4, 9, 10, 12)', () => {
  let gh, app90;
  before(async () => {
    gh = await startFakeGitHub();
    closers.push(() => gh.close());
    app90 = buildApp(tmp('shim-build'), '9.9.0');
  });

  test("update writes the shim by a rename, and leaves a link or a file that isn't ours alone", { skip: WIN && 'no shim on Windows' }, async () => {
    const h = tmp('shim');
    gh.release = release('9.9.0', app90);
    const env = envFor(h, ghEnv(gh));
    const bin = path.join(h, 'bin');
    fs.mkdirSync(bin);
    const shim = path.join(bin, 'obysphere');
    // a link to a file of the user's own that holds the shim's words (obysphere.mjs does)
    const mine = path.join(h, 'my-obysphere.mjs');
    fs.copyFileSync(CLI, mine);
    fs.symlinkSync(mine, shim);
    const r = await cli(['update'], env);
    assert.equal(r.code, 0, r.out);
    assert.equal(fs.readFileSync(mine, 'utf8'), fs.readFileSync(CLI, 'utf8'), "the link's target is untouched");
    assert.ok(fs.lstatSync(shim).isSymbolicLink(), 'the link stays');
    assert.match(r.stderr, /isn't ours, so it's left as it is/);
    // a file that has the words somewhere other than its second line isn't ours either
    fs.rmSync(shim);
    fs.writeFileSync(shim, '#!/bin/sh\necho mine # obysphere shim\n', { mode: 0o755 });
    assert.equal((await cli(['update'], env)).code, 0);
    assert.equal(fs.readFileSync(shim, 'utf8'), '#!/bin/sh\necho mine # obysphere shim\n');
    // ours (an older one): replaced by a new file, renamed over it
    fs.writeFileSync(shim, '#!/bin/sh\n# obysphere shim: runs the installed version\nexec node /old/obysphere.mjs "$@"\n', { mode: 0o755 });
    const ino = fs.statSync(shim).ino;
    assert.equal((await cli(['update'], env)).code, 0);
    assert.ok(fs.readFileSync(shim, 'utf8').includes(path.join(h, 'app', 'current', 'obysphere.mjs')));
    assert.notEqual(fs.statSync(shim).ino, ino, 'a new file, not written through');
    assert.equal(fs.statSync(shim).mode & 0o777, 0o755);
    assert.deepEqual(fs.readdirSync(bin), ['obysphere'], 'no temp file left');
  });

  test("the menu bar's model: the update check kept beside the profiles, no Sphere asked for an Oby that isn't running, and Update takes the stable channel", async () => {
    const h = tmp('menu-poll');
    const hits = [];
    const relay = await new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        hits.push(req.url);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, version: 'obysphere/0.3' }));
      }).listen(0, '127.0.0.1', () => resolve(s));
    });
    closers.push(() => relay.close());
    fakeProfile(path.join(h, 'profiles'), 'alice', { sphere: `http://127.0.0.1:${relay.address().port}` });
    gh.release = { tag: 'v99.0.0', assets: {} };
    gh.requests.length = 0;
    const env = envFor(h, { ...ghEnv(gh), OBYSPHERE_NO_UPDATE_CHECK: '', OBYSPHERE_SERVICE_PLATFORM: 'darwin' });
    let m;
    for (let i = 0; i < 3; i++) {
      const r = await cli(['menubar', 'model'], env);
      assert.equal(r.code, 0, r.out);
      m = JSON.parse(r.stdout);
    }
    assert.equal(gh.requests.filter((p) => p === '/api/releases/latest').length, 1, 'GitHub once a day, not every 30 seconds');
    const cache = path.join(h, 'profiles', 'update-check.json');
    assert.equal(readJson(cache).latest, '99.0.0');
    assert.equal(fs.statSync(cache).mode & 0o777, 0o600);
    assert.ok(!fs.existsSync(path.join(h, 'app')), 'no app home made for it');
    assert.deepEqual(hits, [], "the Sphere of an Oby that isn't running isn't asked");
    const up = m.items.find((i) => i.title === 'Update to 99.0.0');
    assert.deepEqual(up.args, ['update', '--channel', 'stable']);
    // status still asks every Sphere
    await cli(['status', '--json'], env);
    assert.deepEqual(hits, ['/healthz']);
  });

  test('a long profile name costs no time', async () => {
    const h = tmp('slug');
    const profiles = path.join(h, 'profiles');
    fakeProfile(profiles, 'alice');
    fs.writeFileSync(path.join(profiles, '.default-profile'), `a${'-'.repeat(200000)}b\n`);
    const r = await cli(['profiles', '--json'], envFor(h), { timeoutMs: 60e3 });
    assert.equal(r.code, 0, r.out);
    assert.ok(r.ms < 3000, `${r.ms} ms`);
    assert.equal(JSON.parse(r.stdout).default, null);
  });
});

describe('install.sh (finding 4, 7)', () => {
  let gh, app91;
  before(async () => {
    gh = await startFakeGitHub();
    closers.push(() => gh.close());
    app91 = buildApp(tmp('sh-build'), '9.9.1');
  });
  const shEnv = (h, extra = {}) => ({ PATH: `${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: h, TMPDIR: os.tmpdir(), SHELL: '/bin/zsh', OBYSPHERE_SERVICE_DRYRUN: '1', OBYSPHERE_SERVICE_DIR: path.join(h, 'services'), ...ghEnv(gh), ...extra });

  test('piped and cut short anywhere, it does nothing at all', { skip: WIN && 'sh' }, async () => {
    gh.release = release('9.9.1', app91);
    const text = fs.readFileSync(INSTALL, 'utf8');
    const lines = text.split('\n');
    const last = lines.at(-2);
    const cuts = [];
    for (let k = 1; k <= lines.length - 2; k++) cuts.push(lines.slice(0, k).join('\n') + '\n');
    // and inside its last line (all but a cut right after its first word, which runs with no arguments)
    for (let n = 1; n < last.length; n++) if (last.slice(0, n).trim() !== last.split(' ')[0]) cuts.push(lines.slice(0, -2).join('\n') + '\n' + last.slice(0, n));
    const h = tmp('cut');
    gh.requests.length = 0;
    for (const part of cuts) await run('sh', [], shEnv(h), { input: part });
    assert.deepEqual(gh.requests, [], 'nothing was downloaded');
    assert.deepEqual(fs.readdirSync(h), [], 'nothing was made');
    // whole, it installs
    const r = await run('sh', [], shEnv(h), { input: text });
    assert.equal(r.code, 0, r.out);
    assert.equal(linkOf(path.join(h, '.local', 'share', 'obysphere', 'current')), '9.9.1');
  });

  test('the test variables only with OBYSPHERE_TEST, on this machine', { skip: WIN && 'sh' }, async () => {
    gh.release = release('9.9.1', app91);
    gh.requests.length = 0;
    const h = tmp('sh-no-test');
    const r = await run('sh', [INSTALL], shEnv(h, { OBYSPHERE_TEST: undefined }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.stderr, /OBYSPHERE_RELEASES_API and OBYSPHERE_DOWNLOAD_BASE are for tests only/);
    // https on this machine isn't a test server's address either
    const far = await run('sh', [INSTALL], shEnv(h, { OBYSPHERE_RELEASES_API: 'https://127.0.0.1:9/api' }));
    assert.equal(far.code, 1, far.out);
    assert.match(far.stderr, /refusing to download from https:\/\/127\.0\.0\.1:9\/api: the app comes from GitHub only/);
    // with them set, both come from this machine: GitHub (another repository there) isn't a test server
    const both = await run('sh', [INSTALL], shEnv(h, { OBYSPHERE_DOWNLOAD_BASE: 'https://github.com/mallory/evil' }));
    assert.equal(both.code, 1, both.out);
    assert.match(both.stderr, /refusing to download from https:\/\/github\.com\/mallory\/evil: the app comes from GitHub only/);
    assert.deepEqual(gh.requests, []);
    assert.deepEqual(fs.readdirSync(h), []);
  });

  test("install.sh leaves a link or a file that isn't ours alone, and replaces its own", { skip: WIN && 'sh' }, async () => {
    gh.release = release('9.9.1', app91);
    const h = tmp('sh-shim');
    const bin = path.join(h, '.local', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const shim = path.join(bin, 'obysphere');
    const mine = path.join(h, 'my-obysphere.mjs');
    fs.copyFileSync(CLI, mine);
    fs.symlinkSync(mine, shim);
    let r = await run('sh', [INSTALL], shEnv(h));
    assert.equal(r.code, 0, r.out);
    assert.ok(fs.lstatSync(shim).isSymbolicLink(), 'the link stays');
    assert.match(r.stdout, /isn't ours, so it's left as it is/);
    fs.rmSync(shim);
    fs.writeFileSync(shim, '#!/bin/sh\n# obysphere shim: runs the installed version\nexec node /old/obysphere.mjs "$@"\n', { mode: 0o755 });
    r = await run('sh', [INSTALL], shEnv(h));
    assert.equal(r.code, 0, r.out);
    assert.ok(fs.readFileSync(shim, 'utf8').includes(path.join(h, '.local', 'share', 'obysphere', 'current', 'obysphere.mjs')));
  });

  test('with wget only: --https-only, or it asks for curl', { skip: WIN && 'sh' }, async () => {
    const h = tmp('wget');
    const bin = path.join(h, 'bin');
    fs.mkdirSync(bin);
    // the tools install.sh uses, without curl
    for (const t of ['shasum', 'sha256sum', 'tar', 'mktemp', 'rm', 'sed', 'head', 'awk', 'cut', 'mkdir', 'mv', 'chmod', 'readlink', 'grep', 'cat', 'ln', 'tr', 'dirname', 'uname']) {
      const at = ['/usr/bin', '/bin'].map((d) => path.join(d, t)).find((f) => fs.existsSync(f));
      if (at) fs.symlinkSync(at, path.join(bin, t));
    }
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    const calls = path.join(h, 'wget-calls');
    const wget = (help) =>
      fs.writeFileSync(path.join(bin, 'wget'), `#!/bin/sh\nif [ "$1" = --help ]; then echo '${help}'; exit 0; fi\necho "$*" >> '${calls}'\nexit 8\n`, { mode: 0o755 });
    const env = { PATH: bin, HOME: h, TMPDIR: os.tmpdir(), SHELL: '/bin/zsh' };
    wget('  --https-only   only follow secure HTTPS links');
    const r = await run('/bin/sh', [INSTALL], env);
    assert.equal(r.code, 1, r.out);
    assert.match(r.stderr, /there's no release yet/);
    const [first] = fs.readFileSync(calls, 'utf8').trim().split('\n');
    assert.match(first, /--https-only/);
    assert.match(first, /https:\/\/api\.github\.com\/repos\/obi-ai-bot\/oby-sphere\/releases\/latest$/);
    // a wget without it (BusyBox's): curl, please
    fs.rmSync(calls);
    wget('BusyBox v1.36 multi-call binary. Usage: wget [-cqS] [-O FILE] URL');
    const old = await run('/bin/sh', [INSTALL], env);
    assert.equal(old.code, 1);
    assert.match(old.stderr, /this needs curl, or a wget that has --https-only/);
    assert.ok(!fs.existsSync(calls), 'nothing downloaded');
  });
});
