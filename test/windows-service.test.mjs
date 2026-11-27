// `obysphere start` on Windows, tested on any system (OBYSPHERE_SERVICE_PLATFORM=win32, which only
// tests set): it writes a scheduled task (its XML, the JScript file wscript.exe runs, and the
// supervisor's spec) and calls a fake schtasks first on PATH (test/fake-schtasks.mjs), which
// records its arguments and runs the task as Windows would, with wscript.exe emulated: the
// JScript file's command split by Windows' rules, then the real supervisor (obysphere.mjs
// service-run) and the real console (rep.mjs ui --serve). So this checks install, start, status,
// logs, restart, update's restart, stop (which uninstalls), the quoting of paths with spaces and
// odd characters, that no token or key reaches an argument or a file, and the supervisor: the
// console started again after it stops, and ended with its task. With
// OBYSPHERE_TEST_REAL_SCHTASKS=1 on Windows (CI), the real Task Scheduler takes a task too.
// Nothing here reaches the network, a real Claude or gh, or a desktop notification.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeFakeSchtasks, splitWin } from './fake-schtasks.mjs';
import { makeFakeRuntimes } from './fake-runtimes.mjs';
import { makeFakeGh } from './fake-gh.mjs';
import { startFakeGitHub, buildApp, release } from './fake-cli.mjs';
import { consoleAuth } from './console-auth-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.join(HERE, '..'));
const WIN = process.platform === 'win32';
const TOKEN = 'tok_never_in_a_task_0123456789';
const ADMIN_KEY = 'admin-key-never-in-a-task-0123456789';
const JOIN_KEY = 'join-key-never-in-a-task-0123456789';
const SECRETS = [TOKEN, ADMIN_KEY, JOIN_KEY];
// a folder name with what quoting has to survive: spaces, ' & ( ), a letter outside ASCII, a lone %
const ODD = "Bob's & Co (José) 100%";
const roots = [];
const cleanups = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const tmp = (name) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `obysphere-win-${name}-`)));
  roots.push(d);
  return d;
};
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
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
async function answers(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/favicon.svg`, { signal: AbortSignal.timeout(1500) });
    return r.ok && (await r.text()).includes('viewBox="0 0 64 64"');
  } catch {
    return false;
  }
}

after(async () => {
  for (const f of cleanups) await f();
  // give processes a moment to let go of their folders (Windows won't remove an open one)
  await sleep(WIN ? 1500 : 200);
  for (const d of roots) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (e) {
      // a task's process can hold its log a little longer on Windows: a temp folder left behind isn't a failure
      if (!(WIN && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'ENOTEMPTY'))) throw e;
      console.log(`# left behind (still in use): ${d}`);
    }
  }
});

function run(cli, args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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

function fakeProfile(home, name) {
  const dir = path.join(home, name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ profile: name, sphere: 'http://127.0.0.1:9', sphereName: 'Test Sphere', token: TOKEN, agent: { id: `a_${name}`, name, owner: 'Sam' } }), { mode: 0o600 });
  return dir;
}

// the app, copied into a folder of its own (with spaces in its path)
function copyApp(dest) {
  for (const f of ['obysphere.mjs', 'rep.mjs', 'package.json', 'public/index.html', 'public/favicon.svg']) {
    fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(dest, f));
  }
  return dest;
}

// this node, reached through a folder with a space in its name (the service runs the node on your
// PATH when it's this one); null where a link can't be made (Windows without the right to)
function nodeWithSpaces(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, WIN ? 'node.exe' : 'node');
  try {
    fs.symlinkSync(process.execPath, bin, 'file');
    return { dir, bin };
  } catch {
    return null;
  }
}

// a clean environment: its own home, Windows' service, fakes first on PATH, no update check, a
// notification log instead of the desktop, and keys that must never reach the task
function envFor(h, { path: pathDirs = [], ...extra } = {}) {
  const base = WIN ? { ...process.env } : { TMPDIR: os.tmpdir(), LANG: 'C' };
  for (const k of Object.keys(base)) if (/^(OBYSPHERE_|SPHERE_)/i.test(k) || /^(PATH|NODE_OPTIONS|NODE_TEST_CONTEXT)$/i.test(k)) delete base[k];
  const tail = WIN ? process.env.PATH || process.env.Path || '' : '/usr/bin:/bin:/usr/sbin:/sbin';
  const env = {
    ...base,
    PATH: [...pathDirs, tail].join(path.delimiter),
    HOME: h,
    USERPROFILE: h,
    USERDOMAIN: 'WORKSHOP',
    USERNAME: 'sam',
    OBYSPHERE_SERVICE_PLATFORM: 'win32',
    OBYSPHERE_NO_UPDATE_CHECK: '1',
    OBYSPHERE_APP_HOME: path.join(h, 'app'),
    OBYSPHERE_BIN_DIR: path.join(h, 'bin'),
    OBYSPHERE_RELEASES_API: 'http://127.0.0.1:9/api',
    OBYSPHERE_DOWNLOAD_BASE: 'http://127.0.0.1:9/dl',
    OBYSPHERE_NOTIFY_LOG: path.join(h, 'notify.log'),
    OBYSPHERE_ADMIN_KEY: ADMIN_KEY,
    SPHERE_KEY: JOIN_KEY,
    ...extra,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

// the fakes every test here puts first on PATH: schtasks, and (where scripts can be programs)
// claude, codex, cursor-agent and gh, so nothing real answers
function fakes(h) {
  const sched = makeFakeSchtasks(path.join(h, 'fake-schtasks'));
  cleanups.push(() => sched.endAll());
  const dirs = [sched.dir];
  if (!WIN) {
    makeFakeRuntimes(path.join(h, 'fake-runtimes'));
    makeFakeGh(path.join(h, 'fake-gh'));
    dirs.push(path.join(h, 'fake-runtimes'), path.join(h, 'fake-gh'));
  }
  return { sched, dirs };
}

const noSecret = (what, text) => {
  for (const s of SECRETS) assert.ok(!String(text).includes(s), `no key or token in ${what}`);
};

describe('obysphere start on Windows: a scheduled task (schtasks faked)', () => {
  test('start, status, logs, restart and stop; the quoting; no key or token anywhere', async () => {
    const h = tmp('task');
    const odd = path.join(h, ODD);
    const profiles = path.join(odd, 'profiles');
    const services = path.join(odd, 'App Data', 'services');
    fakeProfile(profiles, 'alice');
    const port = await freePort();
    fs.writeFileSync(path.join(profiles, 'alice', 'service.json'), JSON.stringify({ port }));
    const app = copyApp(path.join(odd, 'My App'));
    const cli = path.join(app, 'obysphere.mjs');
    const node = nodeWithSpaces(path.join(h, 'Node JS'));
    const { sched, dirs } = fakes(h);
    const env = envFor(h, { OBYSPHERE_HOME: profiles, OBYSPHERE_SERVICE_DIR: services, path: [...dirs, ...(node ? [node.dir] : [])], ...sched.env });
    const task = 'Obysphere-alice-sam';
    const file = (ext) => path.join(services, `obysphere-alice${ext}`);
    cleanups.push(() => run(cli, ['stop'], env));

    const r = await run(cli, ['start'], env);
    assert.equal(r.code, 0, r.out + sched.output());
    assert.ok(r.stdout.includes(`alice runs in the background: your console is at http://alice.localhost:${port}/`), r.out + sched.output());
    assert.deepEqual(sched.calls().map((c) => c.argv), [
      ['/end', '/tn', task],
      ['/create', '/tn', task, '/xml', file('.xml'), '/f'],
      ['/run', '/tn', task],
    ]);

    // the task: UTF-16 XML, at your logon, as you, only while you're logged on, least privileges,
    // no time limit, on battery too; its action wscript.exe with the JScript file
    const raw = fs.readFileSync(file('.xml'));
    assert.deepEqual([raw[0], raw[1]], [0xff, 0xfe], 'UTF-16 with its byte order mark');
    const xml = raw.subarray(2).toString('utf16le');
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">'));
    assert.match(xml, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>WORKSHOP\\sam<\/UserId>\s*<\/LogonTrigger>/);
    assert.match(xml, /<Principal id="Author">\s*<UserId>WORKSHOP\\sam<\/UserId>\s*<LogonType>InteractiveToken<\/LogonType>\s*<RunLevel>LeastPrivilege<\/RunLevel>/);
    for (const s of ['<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>', '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>', '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>', '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>', '<RestartOnFailure>'])
      assert.ok(xml.includes(s), s);
    assert.match(xml, /<Command>[A-Z]:\\Windows\\System32\\wscript\.exe<\/Command>/i);
    const esc = (s) => s.replace(/&/g, '&amp;');
    assert.ok(xml.includes(`<Arguments>//B //Nologo //E:JScript "${esc(file('.js'))}"</Arguments>`), 'the JScript file, quoted (its path has spaces)');
    assert.ok(xml.includes(`<WorkingDirectory>${esc(path.join(profiles, 'alice'))}</WorkingDirectory>`));

    // what the task runs: node with the supervisor, from the app's own folder, split back exactly
    const spec = readJson(file('.json'));
    const nodeBin = spec.args[0];
    if (node) assert.equal(nodeBin, node.bin, 'the node on PATH, its folder name with a space');
    assert.deepEqual(spec.args.slice(1), ['--preserve-symlinks-main', path.join(app, 'rep.mjs'), 'ui', '--serve', '--profile', 'alice', '--port', String(port)]);
    assert.equal(spec.env.OBYSPHERE_HOME, profiles);
    assert.equal(spec.cwd, path.join(profiles, 'alice'));
    assert.equal(spec.log, path.join(profiles, 'alice', 'logs', 'console.log'));
    assert.equal(spec.task, task);
    const js = fs.readFileSync(file('.js'), 'latin1');
    assert.match(js, /^var shell = WScript\.CreateObject\("WScript\.Shell"\);\nWScript\.Quit\(shell\.Run\(".*", 0, true\)\);\n$/m);
    const ranAs = sched.runs().at(-1);
    assert.equal(ranAs.ascii, true, 'the JScript file is plain ASCII (é as \\u00e9)');
    assert.ok(js.includes('\\u00e9'));
    assert.deepEqual(ranAs.flags, ['//B', '//Nologo', '//E:JScript']);
    assert.equal(ranAs.script, file('.js'));
    assert.deepEqual(ranAs.argv, [nodeBin, '--preserve-symlinks-main', cli, 'service-run', '--spec', file('.json')]);
    assert.equal(ranAs.cwd, path.join(profiles, 'alice'));

    // no key or token: not in an argument, a file or what the console was started with
    noSecret('the schtasks arguments', JSON.stringify(sched.calls().map((c) => c.argv)));
    noSecret('the command wscript.exe runs', JSON.stringify(sched.runs()));
    for (const ext of ['.xml', '.js', '.json']) noSecret(`the task's ${ext} file`, ext === '.xml' ? xml : fs.readFileSync(file(ext), 'utf8'));
    assert.ok(!Object.keys(spec.env).some((k) => /KEY|TOKEN|NODE_OPTIONS/.test(k)), Object.keys(spec.env).join(', '));

    // it runs: the console answers; its log is in <profile>/logs/
    assert.ok(await answers(port));
    await waitFor(() => fs.readFileSync(spec.log, 'utf8').includes('your console for'));
    assert.match(fs.readFileSync(spec.log, 'utf8'), /^\[[^\]]+\] obysphere: starting your console and Oby$/m);
    const status = JSON.parse((await run(cli, ['status', '--json'], env)).stdout).profiles[0];
    assert.deepEqual({ running: status.running, service: status.service }, { running: true, service: true });
    assert.match((await run(cli, ['status'], env)).stdout, /running at http:\/\/alice\.localhost:\d+\/ \(in the background\)/);
    const logs = await run(cli, ['logs', '-n', '20'], env);
    assert.equal(logs.code, 0, logs.out);
    assert.match(logs.stdout, /your console for/);
    const again = await run(cli, ['start'], env);
    assert.match(again.stdout, /alice already runs in the background/);
    assert.equal(sched.calls().length, 3, 'nothing asked of Task Scheduler');

    // restart: a new spec (the running supervisor sees it and stops), the task ended, made again, run
    const id = spec.id;
    const first = sched.tasks()[task].pid;
    const n = sched.calls().length;
    const rs = await run(cli, ['restart'], env);
    assert.equal(rs.code, 0, rs.out + sched.output());
    assert.match(rs.stdout, /alice runs in the background/);
    assert.deepEqual(sched.calls().slice(n).map((c) => c.argv), [
      ['/end', '/tn', task],
      ['/create', '/tn', task, '/xml', file('.xml'), '/f'],
      ['/run', '/tn', task],
    ]);
    assert.notEqual(readJson(file('.json')).id, id);
    assert.notEqual(sched.tasks()[task].pid, first);
    // the first wscript.exe is gone: the fake's own /end, checked where it can be (on Windows the
    // real Task Scheduler test covers ending a task)
    if (!WIN) await waitFor(() => !alive(first), 5000);
    assert.ok(await answers(port));
    // On macOS and Linux the first supervisor outlives its task and says it stops. On Windows a
    // process Node starts ends with its parent, as a task's processes end with the task: the first
    // supervisor goes at once, without a word. There, the second one has started and answers.
    const log = () => fs.readFileSync(spec.log, 'utf8');
    const restarted = WIN
      ? () => (log().match(/obysphere: starting your console and Oby/g) || []).length >= 2
      : () => /obysphere: (the service was changed or removed|its task ended): stopping/.test(log());
    await waitFor(restarted).catch((e) => {
      e.message += `: the restart didn't show in the log:\n${log()}\nThe fake Task Scheduler:\n${sched.output()}`;
      throw e;
    });
    assert.ok(await answers(port), 'the console answers after the restart');

    // stop: the spec goes (the supervisor stops with the console), the task is ended and deleted
    const m = sched.calls().length;
    const st = await run(cli, ['stop'], env);
    assert.equal(st.code, 0, st.out);
    assert.match(st.stdout, /alice stopped\. It won't start at login until you run obysphere start again\./);
    assert.deepEqual(sched.calls().slice(m).map((c) => c.argv), [
      ['/end', '/tn', task],
      ['/delete', '/tn', task, '/f'],
    ]);
    for (const ext of ['.xml', '.js', '.json']) assert.ok(!fs.existsSync(file(ext)), `no ${ext} file left`);
    assert.deepEqual(sched.tasks(), {});
    assert.equal(await answers(port), false, 'the console stopped');
    const gone = JSON.parse((await run(cli, ['status', '--json'], env)).stdout).profiles[0];
    assert.deepEqual({ running: gone.running, service: gone.service }, { running: false, service: false });
    assert.match((await run(cli, ['stop'], env)).stdout, /alice isn't running in the background/);
  });

  test('update restarts the task from the new version', { skip: WIN && "update's download and unpack are tested on macOS and Linux; its restart is the same here" }, async () => {
    const h = tmp('update');
    const profiles = path.join(h, 'profiles');
    fakeProfile(profiles, 'alice');
    const port = await freePort();
    fs.writeFileSync(path.join(profiles, 'alice', 'service.json'), JSON.stringify({ port }));
    const gh = await startFakeGitHub();
    cleanups.push(() => gh.close());
    gh.release = release('9.9.0', buildApp(tmp('builds'), '9.9.0'));
    const { sched, dirs } = fakes(h);
    const services = path.join(h, 'services');
    const env = envFor(h, { OBYSPHERE_HOME: profiles, OBYSPHERE_SERVICE_DIR: services, OBYSPHERE_TEST: '1', OBYSPHERE_RELEASES_API: gh.api, OBYSPHERE_DOWNLOAD_BASE: gh.download, path: dirs, ...sched.env });
    const cli = path.join(ROOT, 'obysphere.mjs');
    cleanups.push(() => run(cli, ['stop'], env));
    assert.equal((await run(cli, ['start'], env)).code, 0);
    assert.ok(await answers(port));

    const n = sched.calls().length;
    const runs = sched.runs().length;
    const up = await run(cli, ['update'], env);
    assert.equal(up.code, 0, up.out + sched.output());
    assert.match(up.stdout, /restarted alice/);
    assert.deepEqual(sched.calls().slice(n).map((c) => c.argv[0]), ['/end', '/create', '/run']);
    const current = path.join(h, 'app', 'current');
    assert.equal(readJson(path.join(services, 'obysphere-alice.json')).args[2], path.join(current, 'rep.mjs'));
    await waitFor(() => sched.runs().length > runs);
    assert.deepEqual(sched.runs().at(-1).argv.slice(1, 4), ['--preserve-symlinks-main', path.join(current, 'obysphere.mjs'), 'service-run']);
    await waitFor(() => answers(port));
    const v = await (await fetch(`http://127.0.0.1:${port}/local/version`, { headers: consoleAuth(path.join(profiles, 'alice'), port) })).json();
    assert.equal(v.current, '9.9.0', 'the console runs the new version');
    assert.equal((await run(cli, ['stop'], env)).code, 0);
    assert.equal(await answers(port), false);
  });

  test("refused, and nothing left: a path Windows would read as a variable; schtasks saying no", async () => {
    const h = tmp('refused');
    const { sched, dirs } = fakes(h);
    const services = path.join(h, 'services');
    const cli = path.join(ROOT, 'obysphere.mjs');

    // %HOME% in a path: WshShell.Run and Task Scheduler would put the variable's value there
    const odd = path.join(h, '%HOME%', 'profiles');
    fakeProfile(odd, 'alice');
    const r = await run(cli, ['start'], envFor(h, { OBYSPHERE_HOME: odd, OBYSPHERE_SERVICE_DIR: services, path: dirs, ...sched.env }));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Windows would read %HOME% in these paths as a variable, so a task can't run them: obysphere start --foreground/);
    assert.deepEqual(sched.calls(), []);
    assert.deepEqual(fs.existsSync(services) ? fs.readdirSync(services) : [], []);

    // schtasks refuses (as it does a logon task for anyone but you without admin rights): said, and undone
    const profiles = path.join(h, 'profiles');
    fakeProfile(profiles, 'alice');
    const port = await freePort();
    fs.writeFileSync(path.join(profiles, 'alice', 'service.json'), JSON.stringify({ port }));
    const env = envFor(h, { OBYSPHERE_HOME: profiles, OBYSPHERE_SERVICE_DIR: services, path: dirs, ...sched.env });
    cleanups.push(() => run(cli, ['stop'], env));
    sched.control({ fail: { create: 'ERROR: Access is denied.' } });
    const no = await run(cli, ['start'], env);
    assert.equal(no.code, 1);
    assert.match(no.stderr, /schtasks couldn't create the task Obysphere-alice-sam: ERROR: Access is denied\./);
    assert.deepEqual(fs.readdirSync(services), []);
    assert.equal(JSON.parse((await run(cli, ['status', '--json'], env)).stdout).profiles[0].service, false);

    // a restart (or an update) whose task can't be made again: the task from before goes too, so
    // nothing is left that obysphere stop couldn't find, and its console stops
    sched.control({});
    assert.equal((await run(cli, ['start'], env)).code, 0);
    assert.ok(await answers(port));
    assert.deepEqual(Object.keys(sched.tasks()), ['Obysphere-alice-sam']);
    sched.control({ fail: { create: 'ERROR: The Task Scheduler service is busy.' } });
    const rs = await run(cli, ['restart'], env);
    assert.equal(rs.code, 1);
    assert.match(rs.stderr, /schtasks couldn't create the task Obysphere-alice-sam: ERROR: The Task Scheduler service is busy\./);
    assert.deepEqual(sched.tasks(), {}, 'no task left registered');
    assert.deepEqual(fs.readdirSync(services), []);
    assert.equal(await answers(port), false, 'the console from before stopped');
    sched.control({});
    assert.match((await run(cli, ['stop'], env)).stdout, /alice isn't running in the background/);
  });

  test('a dry run, in %LOCALAPPDATA%\\obysphere\\services; help names the task', async () => {
    const h = tmp('dry');
    const profiles = path.join(h, 'profiles');
    fakeProfile(profiles, 'alice');
    const local = path.join(h, 'Local App Data');
    const env = envFor(h, { OBYSPHERE_HOME: profiles, LOCALAPPDATA: local, OBYSPHERE_SERVICE_DRYRUN: '1' });
    const cli = path.join(ROOT, 'obysphere.mjs');
    const r = await run(cli, ['start'], env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /dry run, so nothing was started/);
    const dir = path.join(local, 'obysphere', 'services');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['dryrun.jsonl', 'obysphere-alice.js', 'obysphere-alice.json', 'obysphere-alice.xml']);
    const written = () => fs.readFileSync(path.join(dir, 'dryrun.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(written().map((c) => [c.cmd, c.args[0]]), [['schtasks', '/end'], ['schtasks', '/create'], ['schtasks', '/run']]);
    assert.equal((await run(cli, ['stop'], env)).code, 0);
    assert.deepEqual(written().slice(3), [{ cmd: 'schtasks', args: ['/end', '/tn', 'Obysphere-alice-sam'] }, { cmd: 'schtasks', args: ['/delete', '/tn', 'Obysphere-alice-sam', '/f'] }]);
    assert.deepEqual(fs.readdirSync(dir), ['dryrun.jsonl']);
    assert.match((await run(cli, ['help'], env)).stdout, /a LaunchAgent on macOS, a systemd user unit on Linux, a scheduled task on Windows/);
  });
});

describe('the supervisor the task runs (obysphere.mjs service-run)', () => {
  test('starts it again 5 seconds after it stops, with the spec\'s environment; ends with its task, or when the spec changes', async () => {
    const h = tmp('supervisor');
    const pidsFile = path.join(h, 'pids');
    const child = path.join(h, 'child.cjs');
    fs.writeFileSync(child, `const fs = require('fs');
const runs = fs.existsSync(process.argv[2]) ? fs.readFileSync(process.argv[2], 'utf8').split('\\n').filter(Boolean).length : 0;
fs.appendFileSync(process.argv[2], process.pid + '\\n');
console.log('run ' + (runs + 1) + ' with ' + process.env.MARK + ' in ' + process.cwd());
if (runs === 0) process.exit(3);
setInterval(() => {}, 1000);
`);
    const specFile = path.join(h, 'spec.json');
    const log = path.join(h, 'logs', 'console.log');
    const writeSpec = (id) => fs.writeFileSync(specFile, JSON.stringify({ args: [process.execPath, child, pidsFile], env: { MARK: 'marked' }, cwd: h, log, id }));
    const pids = () => (fs.existsSync(pidsFile) ? fs.readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean).map(Number) : []);
    const env = envFor(h);
    delete env.OBYSPHERE_SERVICE_PLATFORM;
    // what wscript.exe does: start it, wait for it, end with its exit code
    const wscript = () => {
      const supervisorPid = path.join(h, `supervisor-${randomBytes(3).toString('hex')}`);
      const p = spawn(process.execPath, ['-e', `const c = require('child_process').spawn(process.execPath, [${JSON.stringify(path.join(ROOT, 'obysphere.mjs'))}, 'service-run', '--spec', ${JSON.stringify(specFile)}], { stdio: 'ignore' });
require('fs').writeFileSync(${JSON.stringify(supervisorPid)}, String(c.pid));
c.on('exit', (code) => process.exit(code === null ? 1 : code));`], { env, stdio: 'ignore' });
      cleanups.push(() => p.kill('SIGKILL'));
      return { p, supervisor: async () => (await waitFor(() => fs.existsSync(supervisorPid)), Number(fs.readFileSync(supervisorPid, 'utf8'))) };
    };

    writeSpec('one');
    const w = wscript();
    const sup = await w.supervisor();
    cleanups.push(() => alive(sup) && process.kill(sup, 'SIGKILL'));
    await waitFor(() => pids().length === 2, 20000);
    const text = fs.readFileSync(log, 'utf8');
    assert.ok(text.includes(`run 1 with marked in ${h}`), text);
    assert.match(text, /obysphere: it stopped \(exit code 3\); starting it again in 5 seconds/);
    await waitFor(() => fs.readFileSync(log, 'utf8').includes('run 2 with marked'));
    const [, second] = pids();
    assert.ok(alive(second));

    // the task ends (wscript.exe killed): the supervisor and what it runs end too
    w.p.kill('SIGKILL');
    await waitFor(() => !alive(sup) && !alive(second), 10000);
    if (!WIN) assert.match(fs.readFileSync(log, 'utf8'), /obysphere: its task ended: stopping/);

    // the spec changes (restart, stop): it ends, with what it runs
    const w2 = wscript();
    const sup2 = await w2.supervisor();
    cleanups.push(() => alive(sup2) && process.kill(sup2, 'SIGKILL'));
    await waitFor(() => pids().length === 3);
    const third = pids()[2];
    // a spec it can't read for a moment (another program holding it) isn't a change: it keeps
    // running. Where a file's mode can't make it unreadable (Windows, root), this part is skipped
    if (!WIN && process.getuid?.() !== 0) {
      fs.chmodSync(specFile, 0);
      await sleep(2500); // two of its checks, a second apart
      fs.chmodSync(specFile, 0o600);
      assert.ok(alive(sup2) && alive(third), 'still running after a spec it could not read');
    }
    writeSpec('two');
    await waitFor(() => !alive(sup2) && !alive(third), 10000);
    assert.match(fs.readFileSync(log, 'utf8'), /obysphere: the service was changed or removed: stopping/);
    await waitFor(() => w2.p.exitCode === 0, 5000);

    // not a spec: refused
    fs.writeFileSync(specFile, '{"args": "rm -rf /"}');
    const bad = await run(path.join(ROOT, 'obysphere.mjs'), ['service-run', '--spec', specFile], env);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /isn't a service spec/);
  });
});

test('splitWin reads a command line as Windows programs do', () => {
  assert.deepEqual(splitWin('"C:\\Program Files\\nodejs\\node.exe" a "b c" "d\\"e" f\\\\"g h" i\\j "k\\\\"'), ['C:\\Program Files\\nodejs\\node.exe', 'a', 'b c', 'd"e', 'f\\g h', 'i\\j', 'k\\']);
});

test('the real Task Scheduler takes the task, runs it if it can, and removes it', { skip: !(WIN && process.env.OBYSPHERE_TEST_REAL_SCHTASKS === '1') && 'only on Windows, with OBYSPHERE_TEST_REAL_SCHTASKS=1 (CI does)' }, async (t) => {
  const h = tmp('real');
  const profiles = path.join(h, "Sam's profiles");
  const name = `ci-${randomBytes(3).toString('hex')}`;
  fakeProfile(profiles, name);
  const port = await freePort();
  fs.writeFileSync(path.join(profiles, name, 'service.json'), JSON.stringify({ port }));
  // the real user (the task runs as you) and the real schtasks
  const env = envFor(h, { OBYSPHERE_HOME: profiles, OBYSPHERE_SERVICE_DIR: path.join(h, 'services'), OBYSPHERE_SERVICE_PLATFORM: undefined, USERDOMAIN: process.env.USERDOMAIN, USERNAME: process.env.USERNAME, USERPROFILE: process.env.USERPROFILE });
  const cli = path.join(ROOT, 'obysphere.mjs');
  const task = `Obysphere-${name}-${String(process.env.USERNAME).replace(/[^\w.-]+/g, '_').slice(0, 40)}`;
  const query = () => spawnSync('schtasks', ['/query', '/tn', task, '/xml'], { encoding: 'utf8' });
  cleanups.push(() => spawnSync('schtasks', ['/delete', '/tn', task, '/f']));
  const r = await run(cli, ['start'], env);
  if (r.code !== 0 && /Access is denied/i.test(r.stderr)) return t.skip(`Task Scheduler refused a task from this user here: ${r.stderr.trim()}`);
  assert.equal(r.code, 0, r.out);
  const q = query();
  assert.equal(q.status, 0, q.stderr);
  for (const s of ['InteractiveToken', 'wscript.exe', '//E:JScript', 'PT0S', '<LogonTrigger>']) assert.ok(q.stdout.includes(s), `the registered task has ${s}`);
  // least privileges: Windows leaves the default run level out of what it shows, so check it isn't raised
  assert.ok(!q.stdout.includes('HighestAvailable'), 'the registered task runs with least privileges');
  noSecret('the registered task', q.stdout);
  if (await answers(port)) {
    const s = JSON.parse((await run(cli, ['status', '--json'], env)).stdout).profiles[0];
    assert.deepEqual({ running: s.running, service: s.service }, { running: true, service: true });
    assert.match(fs.readFileSync(path.join(profiles, name, 'logs', 'console.log'), 'utf8'), /your console for/);
  } else t.diagnostic(`the task was registered but its console didn't answer here (no interactive session?): ${r.stdout.trim()}`);
  const st = await run(cli, ['stop'], env);
  assert.equal(st.code, 0, st.out);
  assert.notEqual(query().status, 0, 'the task is gone');
  assert.equal(await answers(port), false);
});
