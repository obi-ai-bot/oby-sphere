#!/usr/bin/env node
// Obysphere: one command for your Oby and your Sphere.
//
// This file runs your Oby in the background, keeps it up to date, and runs Spheres:
//   start, stop, restart, status, logs, open, profiles   your console and Oby, as a per-user service
//   update, version, doctor                              the installed app, from GitHub
//   server start | deploy | update | status              a Sphere, on this machine or on Vercel
// Every other command (join, ask, settings, mcp, admin, notify, github, ...) goes to
// rep.mjs beside this file as it is: `obysphere join …` runs `node rep.mjs join …`.
//
// The app comes from GitHub only: a release, checked against its SHA256SUMS, or the
// tarball of main. Never from a Sphere. No key is printed, put on a command line or
// in a URL: a new Sphere's keys stay in a file only you can read, and reach the
// Vercel CLI on stdin.
//
// Zero dependencies. Node 22+.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const APP_DIR = path.dirname(SELF);
const REPO = 'obi-ai-bot/oby-sphere';
const VERSION = String(readJson(path.join(APP_DIR, 'package.json'), {}).version || '0.0.0');
// profiles: the folder that holds them (the same rule as rep.mjs)
const HOME = profilesHome();
// the app: <app home>/<version>/, with `current` (and `previous`, for --rollback) pointing at one
const APP_HOME = path.resolve(process.env.OBYSPHERE_APP_HOME || path.join(os.homedir(), '.local', 'share', 'obysphere'));
const BIN_DIR = path.resolve(process.env.OBYSPHERE_BIN_DIR || path.join(os.homedir(), '.local', 'bin'));
const RELEASES_API = trimSlash(process.env.OBYSPHERE_RELEASES_API || `https://api.github.com/repos/${REPO}`);
const DOWNLOAD_BASE = trimSlash(process.env.OBYSPHERE_DOWNLOAD_BASE || `https://github.com/${REPO}`);
const MAIN_TARBALL = process.env.OBYSPHERE_DOWNLOAD_BASE ? `${DOWNLOAD_BASE}/archive/refs/heads/main.tar.gz` : `https://codeload.github.com/${REPO}/tar.gz/refs/heads/main`;
// tests and dry runs: which system's service to write, and whether to run launchctl, systemctl and open
const PLATFORM = process.env.OBYSPHERE_SERVICE_PLATFORM || process.platform;
const DRY = /^(|0|false|no|off)$/i.test(process.env.OBYSPHERE_SERVICE_DRYRUN || '') ? null : process.env.OBYSPHERE_SERVICE_DRYRUN;
const NO_CHECK = /^(1|true|yes|on)$/i.test(process.env.OBYSPHERE_NO_UPDATE_CHECK || '');
const RESERVED = new Set([4848, 4849, 4850]); // the relay's, the console's and the demo's ports
const VER = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?(?:\+[0-9A-Za-z.-]{1,40})?$/;
const DAY = 24 * 3600e3;
const BOOL = new Set(['all', 'foreground', 'check', 'rollback', 'follow', 'json', 'help']);
const SHIM_MARK = '# obysphere shim';

const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c(2), bold = c(1), green = c(32), yellow = c(33), red = c(31), cyan = c(36);
const say = (s = '') => process.stdout.write(s + '\n');
const warn = (s) => process.stderr.write(s + '\n');

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const { pos, opt } = parseArgs(argv.slice(1));

// ================================================================ help

function help() {
  say(`obysphere: your Oby and your Sphere, from one command

Join and run your Oby
  obysphere join "<invite link>" --name <handle> --owner "<Your Name>" --cwd <the folder your Oby may read>
                 [--about "what your Oby knows"] [--profile <name>] [--insecure]
  obysphere start [--profile p | --all] [--foreground]
                                   run your console and Oby in the background; it starts again at login
  obysphere stop | restart [--profile p | --all]
  obysphere status [--json]        each profile: running or not, its console, its Sphere, versions, updates
  obysphere open [--profile p]     your console, in the browser
  obysphere logs [--profile p] [-f] [-n 50]
  obysphere profiles [--json]      your profiles, and the folder that holds them
  obysphere settings [--profile p] [--json]   where your Oby's settings are, and what they say

Ask and read
  obysphere ask <agent> "<message>" [--file <path>] [--channel <name>]
  obysphere post "<message>" [--channel <name>] [--file <path>]
  obysphere agents | whoami | inbox | read [channel]
  obysphere serve [--approve]      answer asks in this terminal (start does it in the background)
  obysphere ui [--port 4849] [--open]   your console, from this terminal

Claude Code and Cursor
  obysphere mcp-config             the line that adds the Sphere to Claude Code or Cursor
  obysphere mcp [--serve]          the MCP server itself
  obysphere inbox --hook           what waits for you, as JSON (the plugin's SessionStart hook)

Notifications
  obysphere notify test [--via desktop|slack|phone|all]

GitHub
  obysphere github status          how gh is signed in, and what your Oby may do on GitHub

Admins
  obysphere admin claim            make your Oby an admin (the key from a prompt or OBYSPHERE_ADMIN_KEY, never an argument)
  obysphere admin status | grant <handle> | revoke <handle> | rotate-key
  obysphere admin policy [--sealed on|off] [--max-depth N] [--max-file-bytes N] [--pause | --resume]

Keep it up to date
  obysphere update [--check] [--channel stable|main] [--rollback]
  obysphere version | doctor

Run a Sphere
  obysphere server start [--port 4848] [--name "Our Sphere"] [--data ./data] [...]   here, in this terminal
  obysphere server deploy vercel --project <name> [--scope <team>] [--name "<Sphere name>"]
  obysphere server deploy docker | railway                the exact steps
  obysphere server update [<name>]                        deploy the installed version again
  obysphere server status [<name> | <url>]

Profiles:  ${HOME}  (OBYSPHERE_HOME moves them)
The app:   ${APP_HOME}  (OBYSPHERE_APP_HOME)`);
}

// ================================================================ everything else: rep.mjs

// rep.mjs beside this file, with the same arguments and this terminal. Through the
// `current` link it keeps that path (--preserve-symlinks-main), so what it prints
// (mcp-config) still works after an update.
function runRep(args, env = {}) {
  const child = spawn(process.execPath, ['--preserve-symlinks-main', path.join(APP_DIR, 'rep.mjs'), ...args], { stdio: 'inherit', env: { ...process.env, OBYSPHERE_CLI: '1', ...env } });
  // Ctrl+C reaches the child from the terminal itself; a service manager's signals are passed on
  process.on('SIGINT', () => {});
  for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  child.on('error', (e) => die(`couldn't run rep.mjs: ${e.message}`));
  child.on('exit', (code, signal) => process.exit(code ?? 128 + (os.constants.signals[signal] || 1)));
}

// ================================================================ profiles

// OBYSPHERE_HOME; else whichever of ~/.obysphere and ~/.obysphere-mvp (made before the
// rename) holds a profile; else ~/.obysphere. Nothing here creates that folder.
function profilesHome() {
  if (process.env.OBYSPHERE_HOME) return path.resolve(process.env.OBYSPHERE_HOME);
  const home = os.homedir();
  for (const d of ['.obysphere', '.obysphere-mvp']) if (holdsProfile(path.join(home, d))) return path.join(home, d);
  return path.join(home, '.obysphere');
}
function holdsProfile(dir) {
  try {
    return fs.readdirSync(dir).some((d) => fs.existsSync(path.join(dir, d, 'profile.json')));
  } catch {
    return false;
  }
}
function homeWhy() {
  if (process.env.OBYSPHERE_HOME) return 'from OBYSPHERE_HOME';
  if (!holdsProfile(HOME)) return 'a new profile goes here';
  return path.basename(HOME) === '.obysphere-mvp' ? "it holds your profiles; ~/.obysphere doesn't" : 'it holds your profiles';
}

function listProfiles() {
  try {
    return fs.readdirSync(HOME).filter((d) => /^[a-z0-9-]{1,32}$/.test(d) && fs.existsSync(path.join(HOME, d, 'profile.json'))).sort();
  } catch {
    return [];
  }
}

// what a profile says, without its token
function publicProfile(name) {
  const j = readJson(path.join(HOME, name, 'profile.json'), {});
  return {
    profile: name,
    name: clean(j.agent?.name, 40) || name,
    owner: clean(j.agent?.owner, 60) || name,
    sphere: typeof j.sphere === 'string' ? clean(j.sphere, 300) : null,
    sphereName: clean(j.sphereName, 80) || 'Obysphere',
  };
}

function notJoined() {
  return `Not joined yet. Join with the invite link someone sent you:
  obysphere join "<invite link>" --name <handle> --owner "<Your Name>" --cwd <the folder your Oby may read>`;
}

// --profile (or OBYSPHERE_PROFILE), --all, or the only profile there is
function targets({ all = !!opt.all } = {}) {
  const names = listProfiles();
  const want = typeof opt.profile === 'string' ? opt.profile : process.env.OBYSPHERE_PROFILE;
  if (want) {
    const n = slug(want);
    if (!names.includes(n)) die(`no profile "${n}" in ${HOME}${names.length ? ` (there: ${names.join(', ')})` : ''}`);
    return [n];
  }
  if (!names.length) die(notJoined());
  if (all || names.length === 1) return names;
  die(`several profiles here (${names.join(', ')}): pass --profile <name>${opt.all === undefined ? ', or --all' : ''}`);
}

function profiles() {
  const names = listProfiles();
  if (opt.json) return say(JSON.stringify({ home: HOME, profiles: names.map((n) => ({ ...publicProfile(n), port: savedPort(n), service: serviceInstalled(n) })) }, null, 2));
  say(`${bold('Profiles')} in ${HOME} ${dim(`(${homeWhy()})`)}`);
  if (!names.length) return say(`  none yet.\n\n${notJoined()}`);
  for (const n of names) {
    const p = publicProfile(n);
    const port = savedPort(n);
    say(`  ${bold(n)}  ${p.owner}'s Oby in ${p.sphereName}  ${dim(p.sphere || '')}${port ? dim(`  · console ${consoleUrl(n, port)}`) : ''}`);
  }
  const other = path.join(os.homedir(), path.basename(HOME) === '.obysphere' ? '.obysphere-mvp' : '.obysphere');
  if (!process.env.OBYSPHERE_HOME && other !== HOME && holdsProfile(other)) say(dim(`\nMore profiles are in ${other}: OBYSPHERE_HOME=${other} obysphere … uses them.`));
}

// ================================================================ the background service

// the console's port: chosen once per profile, kept in <profile>/service.json
function savedPort(name) {
  const p = readJson(path.join(HOME, name, 'service.json'), {}).port;
  return Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : null;
}
async function consolePort(name) {
  const saved = savedPort(name);
  if (saved) return saved;
  const taken = new Set(listProfiles().map(savedPort).filter(Boolean));
  let port = null;
  for (let p = 4851; p < 4900 && !port; p++) if (!taken.has(p) && !RESERVED.has(p) && (await portFree(p))) port = p;
  if (!port) port = await anyPort();
  writeSecret(path.join(HOME, name, 'service.json'), { port, chosenAt: new Date().toISOString() });
  return port;
}
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}
function anyPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
const consoleUrl = (name, port) => `http://${name}.localhost:${port}/`;
const logFile = (name) => path.join(HOME, name, 'logs', 'console.log');

// running: the console answers at its port with its own favicon (a service, or one in a terminal)
async function consoleAnswers(port) {
  if (!port) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/favicon.svg`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    return r.ok && (await r.text()).includes('viewBox="0 0 64 64"');
  } catch {
    return false;
  }
}

function serviceDir() {
  if (process.env.OBYSPHERE_SERVICE_DIR) return path.resolve(process.env.OBYSPHERE_SERVICE_DIR);
  if (PLATFORM === 'darwin') return path.join(os.homedir(), 'Library', 'LaunchAgents');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
}
const label = (name) => `com.obysphere.${name}`;
const unitName = (name) => `obysphere-${name}.service`;
function serviceFile(name) {
  if (PLATFORM === 'darwin') return path.join(serviceDir(), `${label(name)}.plist`);
  if (PLATFORM === 'linux') return path.join(serviceDir(), unitName(name));
  return null;
}
function serviceInstalled(name) {
  const f = serviceFile(name);
  return !!f && fs.existsSync(f);
}

// the installed app's `current` when this runs from it (so an update takes effect), else this folder
function runsInstalled() {
  try {
    const here = fs.realpathSync(APP_DIR);
    const home = fs.realpathSync(APP_HOME);
    return here === home || here.startsWith(home + path.sep);
  } catch {
    return false;
  }
}
function appForService() {
  const cur = path.join(APP_HOME, 'current');
  return runsInstalled() && fs.existsSync(path.join(cur, 'rep.mjs')) ? cur : APP_DIR;
}

// what the service runs: `rep.mjs ui --serve`, with the profiles folder fixed and your PATH
// (so it finds claude, codex, cursor-agent and gh). No keys: the token stays in profile.json.
function serviceSpec(name, port, app = appForService()) {
  const env = { OBYSPHERE_HOME: HOME, PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' };
  for (const k of ['OBYSPHERE_APP_HOME', 'OBYSPHERE_DOWNLOADS', 'OBYSPHERE_NO_UPDATE_CHECK', 'OBYSPHERE_RELEASES_API']) if (process.env[k]) env[k] = process.env[k];
  return {
    profile: name,
    label: label(name),
    args: [stableNode(), '--preserve-symlinks-main', path.join(app, 'rep.mjs'), 'ui', '--serve', '--profile', name, '--port', String(port)],
    env,
    cwd: path.join(HOME, name),
    log: logFile(name),
  };
}

function plist(s) {
  const x = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const str = (v) => `<string>${x(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Obysphere: a console and Oby, written by obysphere start. obysphere stop removes it. -->
<plist version="1.0">
<dict>
  <key>Label</key>${str(s.label)}
  <key>ProgramArguments</key>
  <array>
${s.args.map((a) => `    ${str(a)}`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(s.env).map(([k, v]) => `    <key>${x(k)}</key>${str(v)}`).join('\n')}
  </dict>
  <key>WorkingDirectory</key>${str(s.cwd)}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key>${str(s.log)}
  <key>StandardErrorPath</key>${str(s.log)}
</dict>
</plist>
`;
}

function unit(s) {
  const q = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
  return `# Obysphere: a console and Oby, written by obysphere start. obysphere stop removes it.
[Unit]
Description=Obysphere: ${s.profile}'s console and Oby

[Service]
Type=simple
ExecStart=${s.args.map(q).join(' ')}
${Object.entries(s.env).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`).join('\n')}
WorkingDirectory=${s.cwd}
Restart=always
RestartSec=5
StandardOutput=append:${s.log}
StandardError=append:${s.log}

[Install]
WantedBy=default.target
`;
}

// launchctl, systemctl, open: run, or with OBYSPHERE_SERVICE_DRYRUN only written down
function runOs(bin, args, { detach = false } = {}) {
  if (DRY) {
    const file = path.isAbsolute(DRY) ? DRY : path.join(serviceDir(), 'dryrun.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ cmd: bin, args }) + '\n');
    return { status: 0, stdout: '', stderr: '' };
  }
  if (detach) {
    try {
      spawn(bin, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
      return { status: 0, stdout: '', stderr: '' };
    } catch (e) {
      return { status: 1, stdout: '', stderr: e.message };
    }
  }
  const r = spawnSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30e3 });
  return { status: r.error ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || r.error?.message || '' };
}
const uid = () => (typeof process.getuid === 'function' ? process.getuid() : 0);

async function installService(name, port, app = appForService()) {
  const s = serviceSpec(name, port, app);
  fs.mkdirSync(path.dirname(s.log), { recursive: true, mode: 0o700 });
  rotate(s.log);
  const file = serviceFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (PLATFORM === 'darwin') {
    fs.writeFileSync(file, plist(s), { mode: 0o644 });
    const domain = `gui/${uid()}`;
    runOs('launchctl', ['bootout', `${domain}/${s.label}`]); // not loaded yet: fine
    let r;
    // launchd can take a moment to let go of the old one
    for (let i = 0; i < 4; i++) {
      r = runOs('launchctl', ['bootstrap', domain, file]);
      if (r.status === 0) break;
      await sleep(500);
    }
    if (r.status !== 0) throw new Error(`launchctl couldn't start it: ${clean(r.stderr, 300)}`);
  } else {
    fs.writeFileSync(file, unit(s), { mode: 0o644 });
    for (const a of [['daemon-reload'], ['enable', unitName(name)], ['restart', unitName(name)]]) {
      const r = runOs('systemctl', ['--user', ...a]);
      if (r.status !== 0) throw new Error(`systemctl --user ${a.join(' ')} failed: ${clean(r.stderr, 300)}`);
    }
  }
}

function removeService(name) {
  const file = serviceFile(name);
  if (PLATFORM === 'darwin') runOs('launchctl', ['bootout', `gui/${uid()}/${label(name)}`]);
  else runOs('systemctl', ['--user', 'disable', '--now', unitName(name)]);
  fs.rmSync(file, { force: true });
  if (PLATFORM === 'linux') runOs('systemctl', ['--user', 'daemon-reload']);
}

// a log over 5 MB starts again; the last one is kept as console.log.1
function rotate(file) {
  try {
    if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + '.1');
  } catch {}
}

async function announce(name, port) {
  const url = consoleUrl(name, port);
  let up = false;
  for (let i = 0; i < 30 && !up && !DRY; i++) {
    up = await consoleAnswers(port);
    if (!up) await sleep(300);
  }
  if (DRY) say(`${dim('○')} ${name}: the service is written ${dim(`(${serviceFile(name)})`)}; dry run, so nothing was started.`);
  else if (up) say(`${green('●')} ${bold(name)} runs in the background: your console is at ${cyan(url)}\n  It answers asks while this computer is on, and starts again when you log in.`);
  else say(`${yellow('○')} ${bold(name)} is starting but doesn't answer yet at ${url}. ${dim(`obysphere logs --profile ${name} shows why.`)}`);
  if (PLATFORM === 'linux') say(dim('  To keep it running while you are logged out: loginctl enable-linger $USER'));
}

async function start() {
  const names = targets();
  if (opt.foreground || (PLATFORM !== 'darwin' && PLATFORM !== 'linux')) {
    if (names.length > 1) die('In the foreground it runs one profile at a time: pass --profile <name>.');
    if (!opt.foreground) say(dim("There's no background service on this system yet: your console runs in this terminal. Keep it open; Ctrl+C stops it."));
    const port = await consolePort(names[0]);
    return runRep(['ui', '--serve', '--profile', names[0], '--port', String(port)], { OBYSPHERE_HOME: HOME });
  }
  for (const n of names) {
    const port = await consolePort(n);
    const answers = await consoleAnswers(port);
    if (answers && serviceInstalled(n)) {
      say(`${green('●')} ${bold(n)} already runs in the background: ${cyan(consoleUrl(n, port))}`);
      continue;
    }
    if (answers) {
      warn(`${yellow('!')} ${n}'s console already runs at ${consoleUrl(n, port)}, in a terminal: stop it there (Ctrl+C), then obysphere start again.`);
      process.exitCode = 1;
      continue;
    }
    await installService(n, port);
    await announce(n, port);
  }
  say(dim('obysphere status · obysphere logs -f · obysphere stop'));
}

async function stop() {
  if (PLATFORM !== 'darwin' && PLATFORM !== 'linux') die('Here your console runs in a terminal: stop it there with Ctrl+C.');
  for (const n of targets()) {
    if (!serviceInstalled(n)) {
      const port = savedPort(n);
      say(port && (await consoleAnswers(port)) ? `${n} runs in a terminal, not in the background: stop it there (Ctrl+C).` : `${n} isn't running in the background.`);
      continue;
    }
    removeService(n);
    say(`${dim('○')} ${bold(n)} stopped. It won't start at login until you run obysphere start again.`);
  }
}

async function restart() {
  if (PLATFORM !== 'darwin' && PLATFORM !== 'linux') die('Here your console runs in a terminal: stop it there with Ctrl+C, then obysphere start.');
  for (const n of targets()) {
    const port = await consolePort(n);
    await installService(n, port);
    await announce(n, port);
  }
}

// after an update or a rollback: every service again, from `current`
async function restartServices() {
  if (PLATFORM !== 'darwin' && PLATFORM !== 'linux') return;
  const names = listProfiles().filter(serviceInstalled);
  for (const n of names) await installService(n, await consolePort(n), path.join(APP_HOME, 'current'));
  if (names.length)
    say(`${green('✓')} restarted ${names.join(', ')} ${dim("(asks that came in meanwhile are picked up when it's back)")}`);
}

async function logs() {
  const [name] = targets();
  const file = logFile(name);
  const n = Math.max(1, Math.min(10000, Number(opt.n) || 50));
  if (fs.existsSync(file)) process.stdout.write(lastLines(file, n));
  else if (!opt.follow) die(`No log for ${name} yet (${file}): it's written while it runs in the background (obysphere start).`);
  if (!opt.follow) return;
  let at = size(file);
  setInterval(() => {
    const now = size(file);
    if (now < at) at = 0; // started again
    if (now > at) {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(Math.min(now - at, 4 * 1024 * 1024));
      fs.readSync(fd, buf, 0, buf.length, at);
      fs.closeSync(fd);
      process.stdout.write(printable(buf.toString('utf8')));
      at += buf.length;
    }
  }, 500);
}
function size(f) {
  try {
    return fs.statSync(f).size;
  } catch {
    return 0;
  }
}
function lastLines(file, n) {
  const sz = size(file);
  const len = Math.min(sz, 512 * 1024);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, sz - len);
  fs.closeSync(fd);
  const lines = printable(buf.toString('utf8')).split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-n).join('\n') + (lines.length ? '\n' : '');
}

async function openCmd() {
  const [name] = targets();
  const port = savedPort(name);
  if (!port || !(await consoleAnswers(port))) die(`${name}'s console isn't running: obysphere start${listProfiles().length > 1 ? ` --profile ${name}` : ''}`);
  const url = consoleUrl(name, port);
  const [bin, args] = PLATFORM === 'darwin' ? ['open', [url]] : PLATFORM === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  const r = runOs(bin, args, { detach: true });
  if (r.status !== 0) die(`couldn't open a browser: open ${url} yourself`);
  say(`Opening ${cyan(url)}`);
}

// ================================================================ status, version, doctor

async function relayHealth(base) {
  let u;
  try {
    u = new URL('/healthz', base);
  } catch {
    return { ok: false, error: 'not a link' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'not a link' };
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(5000), redirect: 'error', headers: { 'user-agent': 'obysphere' } });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = await r.json().catch(() => ({}));
    const v = String(j.version || '').replace(/^obysphere\//, '');
    return { ok: j.ok === true, version: /^\d{1,6}(\.\d{1,6}){0,2}$/.test(v) ? v : null, store: clean(j.store, 10) || null, sealed: !!j.sealed, paused: !!j.paused };
  } catch (e) {
    return { ok: false, error: clean(netWhy(e), 80) };
  }
}

// your Oby against the Sphere's relay, by major.minor: 'same', 'client-older' or 'relay-older'
function handshake(client, relay) {
  if (!client || !relay) return null;
  const mm = (v) => {
    const [a = 0, b = 0] = String(v).split(/[.+-]/).map(Number);
    return `${a}.${b}.0`;
  };
  const d = cmpVersion(mm(client), mm(relay));
  return d === 0 ? 'same' : d < 0 ? 'client-older' : 'relay-older';
}
const HANDSHAKE_WORDS = {
  same: 'they match',
  'client-older': 'your Oby is older than the Sphere: obysphere update',
  'relay-older': "the Sphere's relay is older than your Oby: whoever runs it updates it (obysphere server update)",
};

// the version your services run
function clientVersion() {
  return String(readJson(path.join(appForService(), 'package.json'), {}).version || VERSION);
}

async function statusOf(name, client) {
  const p = publicProfile(name);
  const port = savedPort(name);
  const [running, relay] = await Promise.all([consoleAnswers(port), p.sphere ? relayHealth(p.sphere) : { ok: false, error: 'no Sphere address' }]);
  return {
    ...p,
    console: port ? consoleUrl(name, port) : null,
    port,
    service: serviceInstalled(name),
    running,
    relay: { reachable: relay.ok, version: relay.version || null, sealed: relay.sealed ?? null, error: relay.error || null },
    versions: handshake(client, relay.version),
  };
}

async function status() {
  const names = typeof opt.profile === 'string' ? targets() : listProfiles();
  const client = clientVersion();
  const [latest, rows] = await Promise.all([latestKnown(), Promise.all(names.map((n) => statusOf(n, client)))]);
  const update = latest.latest && cmpVersion(latest.latest, client) > 0 ? latest.latest : null;
  if (opt.json) return say(JSON.stringify({ client, latest: latest.latest, checkedAt: latest.checkedAt, update, home: HOME, profiles: rows }, null, 2));
  say(`${bold('Obysphere')} ${client}  ${update ? yellow(`${update} is out: obysphere update`) : dim(latest.latest ? 'up to date' : NO_CHECK ? 'no update check (OBYSPHERE_NO_UPDATE_CHECK)' : 'not checked yet')}`);
  if (!rows.length) return say(`\n${notJoined()}`);
  for (const r of rows) {
    say(`\n${bold(r.profile)}  ${r.owner}'s Oby in ${r.sphereName}`);
    const where = r.service ? 'in the background' : 'in a terminal';
    const flag = names.length > 1 ? ` --profile ${r.profile}` : '';
    say(`  console   ${r.running ? `${green('●')} running at ${cyan(r.console)} ${dim(`(${where})`)}` : r.service ? `${yellow('○')} not answering, though its service is set up: obysphere logs${flag} shows why` : `${dim('○')} not running: obysphere start${flag}`}`);
    say(`  Sphere    ${r.sphere || '?'}  ${r.relay.reachable ? `${green('✓')} reachable${r.relay.version ? ` · relay ${r.relay.version}` : ''}${r.relay.sealed ? ' · sealed' : ''}` : `${red('✗')} unreachable${r.relay.error ? ` (${r.relay.error})` : ''}`}`);
    if (r.relay.version) say(`  versions  your Oby ${client}, the Sphere ${r.relay.version}: ${HANDSHAKE_WORDS[r.versions] || '?'}`);
  }
}

function version() {
  const cur = linkName(path.join(APP_HOME, 'current'));
  const channel = readJson(path.join(APP_HOME, 'install.json'), {}).channel === 'main' ? 'main' : 'stable';
  say(`obysphere ${VERSION}`);
  say(dim(`  app       ${APP_DIR}${runsInstalled() ? ` (installed, ${channel} channel${cur ? `, current: ${cur}` : ''})` : ' (not the installed app)'}`));
  say(dim(`  node      ${process.versions.node}`));
  say(dim(`  profiles  ${HOME}`));
}

async function doctor() {
  let bad = 0;
  const ok = (w, more) => say(`  ${green('✓')} ${w}${more ? dim(`  ${more}`) : ''}`);
  const no = (w, fix) => {
    bad++;
    say(`  ${red('✗')} ${w}${fix ? `\n      ${fix}` : ''}`);
  };
  const note = (w, more) => say(`  ${yellow('!')} ${w}${more ? `\n      ${more}` : ''}`);

  say(bold('This computer'));
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) ok(`Node ${process.versions.node}`);
  else no(`Node ${process.versions.node}: the Obysphere needs Node 22 or later`, 'Install it from https://nodejs.org, then run this again.');
  const cur = linkName(path.join(APP_HOME, 'current'));
  if (cur && fs.existsSync(path.join(APP_HOME, cur, 'rep.mjs'))) {
    ok(`installed: ${cur}`, path.join(APP_HOME, 'current'));
    const shim = path.join(BIN_DIR, 'obysphere');
    if (!fs.existsSync(shim)) note(`no obysphere command in ${BIN_DIR}`, `obysphere update puts it back, or run: node ${path.join(APP_HOME, 'current', 'obysphere.mjs')}`);
    else if (!which('obysphere')) note(`${BIN_DIR} isn't on your PATH`, `Add it: echo 'export PATH="${BIN_DIR}:$PATH"' >> ~/.zshrc (or ~/.bashrc), then open a new terminal.`);
    else ok('obysphere is on your PATH', which('obysphere'));
  } else note(`not installed in ${APP_HOME}`, `This one runs from ${APP_DIR}. To install: curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | sh`);
  const claude = which('claude');
  if (claude) ok('Claude Code', claude);
  else no('Claude Code is not on your PATH: your Oby answers with it', 'Install it: https://docs.claude.com/en/docs/claude-code, then sign in with claude.');
  for (const [bin, what] of [['codex', 'Codex'], ['cursor-agent', 'Cursor']]) if (which(bin)) ok(what, which(bin));
  if (which('gh')) ok('GitHub CLI (for reviews on GitHub)', which('gh'));
  else note('GitHub CLI (gh) not found: your Oby needs it to read and review PRs', 'https://cli.github.com, then gh auth login');

  say(`\n${bold('Profiles')} in ${HOME} ${dim(`(${homeWhy()})`)}`);
  const names = listProfiles();
  if (!names.length) note('none yet', notJoined().split('\n')[1].trim());
  const other = path.join(os.homedir(), path.basename(HOME) === '.obysphere' ? '.obysphere-mvp' : '.obysphere');
  if (!process.env.OBYSPHERE_HOME && other !== HOME && holdsProfile(other)) note(`more profiles are in ${other}`, `They aren't used. OBYSPHERE_HOME=${other} obysphere … uses them.`);
  const client = clientVersion();
  for (const r of await Promise.all(names.map((n) => statusOf(n, client)))) {
    say(`  ${bold(r.profile)}  ${r.owner}'s Oby in ${r.sphereName}`);
    if (r.running) ok(`console running at ${r.console}`, r.service ? 'in the background' : 'in a terminal');
    else if (r.service) no('its service is set up but the console doesn\'t answer', `obysphere logs --profile ${r.profile}`);
    else note('not running', `obysphere start --profile ${r.profile}`);
    if (r.relay.reachable) ok(`the Sphere answers: ${r.sphere}`, r.relay.version ? `relay ${r.relay.version}` : '');
    else no(`can't reach the Sphere at ${r.sphere}${r.relay.error ? ` (${r.relay.error})` : ''}`, 'Check your network, or ask whoever runs it.');
    if (r.versions && r.versions !== 'same') note(HANDSHAKE_WORDS[r.versions]);
  }

  const latest = await latestKnown();
  say(`\n${bold('Updates')}`);
  if (latest.latest && cmpVersion(latest.latest, client) > 0) note(`${latest.latest} is out (you have ${client})`, 'obysphere update');
  else if (latest.latest) ok(`up to date (${client})`);
  else say(dim(`  ${NO_CHECK ? 'not checked (OBYSPHERE_NO_UPDATE_CHECK)' : 'no release found yet'}`));
  process.exitCode = bad ? 1 : 0;
}

// ================================================================ update

function cacheFile() {
  return path.join(APP_HOME, 'update-check.json');
}
// the newest release, as last checked (once a day at most; never with OBYSPHERE_NO_UPDATE_CHECK)
async function latestKnown({ force = false } = {}) {
  const c = readJson(cacheFile(), {});
  const cached = { latest: VER.test(String(c.latest)) ? c.latest : null, checkedAt: typeof c.checkedAt === 'string' ? c.checkedAt : null };
  const fresh = cached.checkedAt && Date.now() - Date.parse(cached.checkedAt) < DAY;
  if (!force && (fresh || NO_CHECK)) return cached;
  try {
    const r = await latestRelease();
    return saveCache(r.version);
  } catch (e) {
    if (e.noRelease) return saveCache(null);
    return cached;
  }
}
function saveCache(latest) {
  const rec = { latest, checkedAt: new Date().toISOString() };
  // kept only where the app is installed: checking from a checkout leaves no folder behind
  if (fs.existsSync(APP_HOME)) writeSecret(cacheFile(), rec);
  return rec;
}

// http only for this machine (tests); the code comes from GitHub over https
function checkedUrl(u) {
  const url = new URL(u);
  if (url.protocol === 'https:' || (url.protocol === 'http:' && /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(url.hostname))) return url;
  throw new Error(`refusing to download from ${url.origin}: https only`);
}
async function get(u, { timeoutMs = 60e3, accept } = {}) {
  const url = checkedUrl(u);
  let r;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'obysphere', ...(accept ? { accept } : {}) } });
  } catch (e) {
    throw new Error(`couldn't reach ${url.host} (${clean(netWhy(e), 80)}): check your network and try again`);
  }
  if (r.url) checkedUrl(r.url); // and wherever it was sent
  return r;
}
async function download(u) {
  const r = await get(u);
  if (!r.ok) throw new Error(`${u} answered ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 64 * 1024 * 1024) throw new Error(`${u} is larger than expected`);
  return buf;
}
async function latestRelease() {
  const r = await get(`${RELEASES_API}/releases/latest`, { timeoutMs: 10e3, accept: 'application/vnd.github+json' });
  if (r.status === 404) {
    const e = new Error(`There's no release yet. For the newest code on main: obysphere update --channel main`);
    e.noRelease = true;
    throw e;
  }
  if (!r.ok) throw new Error(`GitHub answered ${r.status} when asked for the latest release`);
  const tag = String((await r.json().catch(() => ({}))).tag_name || '');
  const v = tag.replace(/^v/, '');
  if (!VER.test(v)) throw new Error(`the latest release's tag isn't a version: ${JSON.stringify(clean(tag, 40))}`);
  return { tag, version: v };
}
function sumFor(text, file) {
  for (const line of String(text).split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (m && m[2] === file) return m[1].toLowerCase();
  }
  return null;
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function linkName(at) {
  try {
    return path.basename(fs.readlinkSync(at));
  } catch {
    return null;
  }
}
// at -> <app home>/<version>, swapped in one rename
function link(version, at) {
  const tmp = `${at}.${process.pid}.${randomBytes(3).toString('hex')}`;
  if (process.platform === 'win32') fs.symlinkSync(path.join(APP_HOME, version), tmp, 'junction');
  else fs.symlinkSync(version, tmp);
  try {
    fs.renameSync(tmp, at);
  } catch {
    fs.rmSync(at, { force: true });
    fs.renameSync(tmp, at);
  }
}

// the download, unpacked with the system's tar into <app home>/<version>/
function unpack(bytes, { expect = null, main = null } = {}) {
  fs.mkdirSync(APP_HOME, { recursive: true, mode: 0o755 });
  const stage = fs.mkdtempSync(path.join(APP_HOME, '.unpack-'));
  try {
    const tgz = path.join(stage, 'app.tar.gz');
    fs.writeFileSync(tgz, bytes, { mode: 0o600 });
    const x = path.join(stage, 'x');
    fs.mkdirSync(x);
    const r = spawnSync('tar', ['-xzf', tgz, '-C', x], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 120e3 });
    if (r.error || r.status !== 0) throw new Error(`couldn't unpack it with tar: ${clean(r.stderr || r.error?.message, 300)}`);
    const tops = fs.readdirSync(x, { withFileTypes: true }).filter((d) => d.isDirectory());
    if (tops.length !== 1) throw new Error("the download isn't one app folder");
    const top = path.join(x, tops[0].name);
    for (const f of ['obysphere.mjs', 'rep.mjs', 'server.mjs', 'package.json', path.join('public', 'index.html')])
      if (!fs.existsSync(path.join(top, f))) throw new Error(`the download has no ${f}`);
    const v = String(readJson(path.join(top, 'package.json'), {}).version || '');
    if (expect && v !== expect) throw new Error(`the release is ${expect}, but its package.json says ${JSON.stringify(clean(v, 40))}`);
    const version = main ? `${v}+main.${main}` : v;
    if (!VER.test(version)) throw new Error(`its package.json has no usable version: ${JSON.stringify(clean(v, 40))}`);
    const dest = path.join(APP_HOME, version);
    if (!fs.existsSync(path.join(dest, 'rep.mjs'))) {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(top, dest);
    }
    return version;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// a small script in ~/.local/bin that runs the installed version
function shimText() {
  const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh\n${SHIM_MARK}: runs the installed version (obysphere update switches it)\nexec node --preserve-symlinks-main ${sq(path.join(APP_HOME, 'current', 'obysphere.mjs'))} "$@"\n`;
}
function ensureShim() {
  if (process.platform === 'win32') return;
  const shim = path.join(BIN_DIR, 'obysphere');
  let now = null;
  try {
    now = fs.readFileSync(shim, 'utf8');
  } catch {}
  if (now === shimText()) return;
  if (now !== null && !now.includes(SHIM_MARK)) return warn(`${yellow('!')} ${shim} isn't ours, so it's left as it is.`);
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(shim, shimText(), { mode: 0o755 });
  fs.chmodSync(shim, 0o755);
}

// current -> version (and previous -> what current was), then the services again
async function activate(version, channel) {
  const cur = path.join(APP_HOME, 'current');
  const before = linkName(cur);
  writeSecret(path.join(APP_HOME, 'install.json'), { channel, version, at: new Date().toISOString() });
  ensureShim();
  if (before === version) return say(`You have it already: ${version}.`);
  link(version, cur);
  if (before && fs.existsSync(path.join(APP_HOME, before))) link(before, path.join(APP_HOME, 'previous'));
  say(`${green('✓')} ${bold(version)} is installed ${dim(path.join(APP_HOME, version))}${before ? dim(`\n  ${before} is kept: obysphere update --rollback goes back to it`) : ''}`);
  await restartServices();
  prune();
}

// only current and previous are kept
function prune() {
  const keep = new Set([linkName(path.join(APP_HOME, 'current')), linkName(path.join(APP_HOME, 'previous'))].filter(Boolean));
  for (const d of fs.readdirSync(APP_HOME, { withFileTypes: true }))
    if (d.isDirectory() && VER.test(d.name) && !keep.has(d.name)) fs.rmSync(path.join(APP_HOME, d.name), { recursive: true, force: true });
}

async function update() {
  if (opt.rollback) return rollback();
  const state = readJson(path.join(APP_HOME, 'install.json'), {});
  const channel = typeof opt.channel === 'string' ? opt.channel : state.channel === 'main' ? 'main' : 'stable';
  if (channel !== 'stable' && channel !== 'main') die('--channel is stable or main');
  const cur = linkName(path.join(APP_HOME, 'current'));
  const have = cur ? String(readJson(path.join(APP_HOME, cur, 'package.json'), {}).version || VERSION) : VERSION;

  if (channel === 'main') {
    if (opt.check) return say(`main has no version to compare with: obysphere update --channel main takes the newest code on main (you have ${cur || VERSION}).`);
    warn(`${yellow('!')} main isn't checksummed: you get the code on main as it is now, from GitHub.`);
    const bytes = await download(MAIN_TARBALL);
    return activate(unpack(bytes, { main: sha256(bytes).slice(0, 8) }), 'main');
  }

  let rel;
  try {
    rel = await latestRelease();
  } catch (e) {
    if (e.noRelease) saveCache(null);
    die(e.message);
  }
  saveCache(rel.version);
  if (opt.check) return say(cmpVersion(rel.version, have) > 0 ? `${rel.version} is out (you have ${have}): obysphere update` : `You have the newest release (${have}).`);
  if (cur === rel.version) return activate(rel.version, 'stable');
  const file = `obysphere-${rel.version}.tar.gz`;
  const at = `${DOWNLOAD_BASE}/releases/download/${rel.tag}`;
  say(dim(`Downloading ${rel.version} from ${new URL(at).host}…`));
  const [bytes, sums] = await Promise.all([download(`${at}/${file}`), download(`${at}/SHA256SUMS`)]);
  const want = sumFor(sums.toString('utf8'), file);
  if (!want) die(`The release's SHA256SUMS has no line for ${file}, so it can't be checked. Nothing was changed.`);
  const got = sha256(bytes);
  if (got !== want) die(`${file} doesn't match the release's SHA256SUMS (expected ${want}, got ${got}). Nothing was changed.`);
  say(`${green('✓')} it matches the release's SHA256SUMS`);
  await activate(unpack(bytes, { expect: rel.version }), 'stable');
}

async function rollback() {
  const prev = linkName(path.join(APP_HOME, 'previous'));
  if (!prev || !fs.existsSync(path.join(APP_HOME, prev, 'rep.mjs'))) die('There is no earlier version to go back to.');
  const cur = linkName(path.join(APP_HOME, 'current'));
  link(prev, path.join(APP_HOME, 'current'));
  if (cur) link(cur, path.join(APP_HOME, 'previous'));
  say(`${green('✓')} back to ${bold(prev)}${cur ? dim(` (${cur} is kept: obysphere update --rollback switches again)`) : ''}`);
  await restartServices();
}

// ================================================================ server

async function server() {
  const [sub, where] = pos;
  if (sub === 'start') return serverStart();
  if (sub === 'deploy' && where === 'vercel') return deployVercel();
  if (sub === 'deploy' && where === 'docker') return say(dockerSteps());
  if (sub === 'deploy' && where === 'railway') return say(railwaySteps());
  if (sub === 'update') return serverUpdate();
  if (sub === 'status') return serverStatus();
  die('usage: obysphere server start [flags] | deploy vercel|docker|railway | update [<name>] | status [<name> | <url>]');
}

// server.mjs beside this file, in this terminal, with its own flags
function serverStart() {
  const child = spawn(process.execPath, [path.join(APP_DIR, 'server.mjs'), ...argv.slice(2)], { stdio: 'inherit' });
  process.on('SIGINT', () => {});
  for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => process.exit(code ?? 128 + (os.constants.signals[signal] || 1)));
}

const serversDir = () => path.join(APP_HOME, 'servers');
function records() {
  try {
    return fs
      .readdirSync(serversDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson(path.join(serversDir(), f), null))
      .filter((r) => r && typeof r.name === 'string' && typeof r.url === 'string');
  } catch {
    return [];
  }
}
function pickRecord(name) {
  const all = records();
  if (name) return all.find((r) => r.name === name) || die(`No deployed Sphere named ${JSON.stringify(name)} here${all.length ? ` (there: ${all.map((r) => r.name).join(', ')})` : ''}.`);
  if (all.length === 1) return all[0];
  if (!all.length) die('No deployed Sphere is recorded here. Deploy one: obysphere server deploy vercel --project <name>');
  die(`Several Spheres are recorded here (${all.map((r) => r.name).join(', ')}): name one.`);
}

// what gets deployed: the installed app (or this folder), as a clean copy
function appSource() {
  const cur = path.join(APP_HOME, 'current');
  return fs.existsSync(path.join(cur, 'server.mjs')) ? fs.realpathSync(cur) : APP_DIR;
}
const SKIP = new Set(['.git', 'data', 'logs', 'node_modules', '.vercel', '.vercel-static', '.claude', '.DS_Store']);
const skipped = (name) => SKIP.has(name) || name.startsWith('.env') || name.endsWith('.log');
// tracked files only when it's a git checkout; otherwise everything but the skipped names. No symlinks.
function exportApp(src, dest) {
  let tracked = null;
  if (fs.existsSync(path.join(src, '.git'))) {
    const r = spawnSync('git', ['-C', src, 'ls-files', '-z'], { encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(src) }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 30e3 });
    if (!r.error && r.status === 0) tracked = r.stdout.split('\0').filter(Boolean);
  }
  const copy = (rel) => {
    if (rel.split(/[\\/]/).some(skipped)) return;
    const from = path.join(src, rel);
    const st = fs.lstatSync(from, { throwIfNoEntry: false });
    if (!st?.isFile()) return;
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.copyFileSync(from, path.join(dest, rel));
  };
  if (tracked) return tracked.forEach(copy);
  const walk = (rel) => {
    for (const d of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
      const r2 = path.join(rel, d.name);
      if (skipped(d.name)) continue;
      if (d.isDirectory()) walk(r2);
      else if (d.isFile()) copy(r2);
    }
  };
  walk('');
}

// a Sphere's keys: made once, 22+ random characters, kept in a file only you can read
function ensureKeys(file) {
  const have = readJson(file, null);
  if (have && String(have.SPHERE_KEY || '').length >= 22 && String(have.SPHERE_ADMIN_KEY || '').length >= 22) return have;
  const keys = { SPHERE_KEY: randomBytes(24).toString('base64url'), SPHERE_ADMIN_KEY: randomBytes(24).toString('base64url'), createdAt: new Date().toISOString() };
  writeSecret(file, keys);
  return keys;
}

// the Vercel CLI in the export folder; values go on stdin, never in its arguments
function vercel(bin, cwd, args, { input = '', show = false } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^SPHERE_/.test(k) || k === 'OBYSPHERE_ADMIN_KEY') delete env[k];
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => {
      err += d;
      if (show) process.stderr.write(dim(printable(String(d))));
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve({ stdout: out, stderr: err }) : reject(new Error(`vercel ${args.slice(0, 2).join(' ')} failed${err || out ? `:\n${indentText(clean(err || out, 2000, true))}` : ''}`))));
    child.stdin.end(input);
  });
}

async function deployVercel({ project = opt.project, scope = opt.scope, sphereName = opt.name, isUpdate = false } = {}) {
  const usage = 'usage: obysphere server deploy vercel --project <name> [--scope <team>] [--name "<Sphere name>"]';
  if (typeof project !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(project)) die(`${usage}\n  (--project: lowercase letters, digits, . _ and -)`);
  if (scope !== undefined && (typeof scope !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(scope))) die(usage);
  if (sphereName !== undefined && (typeof sphereName !== 'string' || !sphereName.trim())) die(usage);
  const bin = which('vercel') || die('This needs the Vercel CLI: npm i -g vercel, then vercel login.');
  const src = appSource();
  const version = String(readJson(path.join(src, 'package.json'), {}).version || VERSION);
  const scopeArgs = scope ? ['--scope', scope] : [];
  const keysFile = path.join(serversDir(), `${project}.keys`);
  const recFile = path.join(serversDir(), `${project}.json`);
  const before = readJson(recFile, null);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obysphere-deploy-'));
  try {
    exportApp(src, tmp);
    say(`${dim('·')} a clean copy of ${version} ${dim(`(no .git, data/ or .env files): ${tmp}`)}`);
    await vercel(bin, tmp, ['link', '--yes', '--project', project, ...scopeArgs], { show: true });
    say(`${dim('·')} linked to the Vercel project ${bold(project)}${scope ? ` in ${scope}` : ''}`);

    const listed = (await vercel(bin, tmp, ['env', 'ls', 'production', ...scopeArgs])).stdout;
    const has = (n) => new RegExp(`(^|\\s)${n}(\\s|$)`, 'm').test(listed);
    const missing = ['SPHERE_KEY', 'SPHERE_ADMIN_KEY'].filter((n) => !has(n));
    let madeKeys = fs.existsSync(keysFile);
    if (missing.length) {
      if (isUpdate && !fs.existsSync(keysFile))
        throw new Error(`${missing.join(' and ')} ${missing.length > 1 ? "aren't" : "isn't"} set on Vercel any more, and there are no keys for ${project} here. Set ${missing.length > 1 ? 'them' : 'it'} again with the value${missing.length > 1 ? 's' : ''} the Sphere had (vercel env add <NAME> production --sensitive): new keys would lock its data.`);
      const keys = ensureKeys(keysFile);
      madeKeys = true;
      for (const n of missing) await vercel(bin, tmp, ['env', 'add', n, 'production', '--sensitive', ...scopeArgs], { input: keys[n] });
      say(`${green('✓')} set ${missing.join(' and ')} on Vercel ${dim('(sensitive)')}`);
    }
    if (sphereName && !has('SPHERE_NAME')) {
      await vercel(bin, tmp, ['env', 'add', 'SPHERE_NAME', 'production', '--sensitive', ...scopeArgs], { input: sphereName.trim() });
      say(`${green('✓')} set SPHERE_NAME on Vercel`);
    }
    if (!has('KV_REST_API_URL') && !has('UPSTASH_REDIS_REST_URL')) {
      warn(`${red('✗')} No Redis store is connected to ${project} yet. On Vercel the Sphere keeps its state in Upstash Redis.
  Connect one: Vercel dashboard › ${project} › Storage › Create Database › Upstash for Redis, connected to Production
  (or: vercel integration add upstash). Then run this again: obysphere server ${isUpdate ? `update ${project}` : `deploy vercel --project ${project}${scope ? ` --scope ${scope}` : ''}`}`);
      process.exitCode = 1;
      return;
    }
    say(`${dim('·')} deploying to production… ${dim('(a minute or two)')}`);
    const d = await vercel(bin, tmp, ['deploy', '--prod', '--yes', ...scopeArgs], { show: true });
    const urls = (s) => [...String(s).matchAll(/https:\/\/[^\s"'<>\[\]]+|http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?[^\s"'<>\[\]]*/g)].map((m) => m[0].replace(/[.,]$/, ''));
    const aliased = /Aliased:\s*(\S+)/.exec(d.stderr + '\n' + d.stdout)?.[1];
    const deployment = urls(d.stdout).at(-1) || urls(d.stderr).at(-1) || null;
    const url = trimSlash((aliased && urls(aliased)[0]) || before?.url || deployment || '');
    if (!url) throw new Error('Vercel deployed it but printed no address. vercel ls shows it.');
    const rec = { name: project, provider: 'vercel', project, scope: scope || null, url, deployment, version, sphereName: sphereName?.trim() || before?.sphereName || null, deployedAt: new Date().toISOString(), firstDeployedAt: before?.firstDeployedAt || before?.deployedAt || new Date().toISOString() };
    writeSecret(recFile, rec);

    let h = { ok: false };
    for (let i = 0; i < 15 && !h.ok; i++) {
      h = await relayHealth(url);
      if (!h.ok) await sleep(2000);
    }
    say(`\n${green('✓')} ${bold(project)} is deployed: ${cyan(url)} ${dim(`(${version})`)}`);
    say(h.ok ? `  It answers: relay ${h.version || '?'}, ${h.store || '?'} store${h.sealed ? ', sealed' : ''}.` : `  It doesn't answer at ${url}/healthz yet: give it a minute, then obysphere server status ${project}.`);
    if (madeKeys) {
      say(`  Keys:    ${keysFile} ${dim('(only you can read it; never printed)')}`);
      say(`  Invite:  ${url}/#key=<SPHERE_KEY from that file>`);
      say(`  Admin:   OBYSPHERE_ADMIN_KEY=<SPHERE_ADMIN_KEY from that file> obysphere admin claim, once you've joined`);
    } else say(`  Invite:  ${url}/#key=<the join key set on Vercel>`);
    say(dim(`  Later:   obysphere server update ${project} deploys the installed version again`));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function serverUpdate() {
  const rec = pickRecord(pos[1]);
  if (rec.provider !== 'vercel') die(`${rec.name} isn't on Vercel: update it where it runs.`);
  await deployVercel({ project: rec.project, scope: rec.scope || undefined, sphereName: undefined, isUpdate: true });
}

async function serverStatus() {
  const arg = pos[1];
  const list = arg && /^https?:\/\//.test(arg) ? [{ name: arg, url: arg }] : arg ? [pickRecord(arg)] : records();
  if (!list.length) return say('No deployed Sphere is recorded here. Deploy one: obysphere server deploy vercel --project <name>');
  const installed = String(readJson(path.join(appSource(), 'package.json'), {}).version || VERSION);
  let bad = 0;
  for (const r of list) {
    const h = await relayHealth(r.url);
    say(r.name === r.url ? bold(r.url) : `${bold(r.name)}  ${r.url}`);
    if (!h.ok) {
      bad++;
      say(`  ${red('✗')} doesn't answer${h.error ? ` (${h.error})` : ''}`);
      continue;
    }
    say(`  ${green('✓')} up · relay ${h.version || '?'} · ${h.store || '?'} store${h.sealed ? ' · sealed' : ''}${h.paused ? ' · paused' : ''}${r.version ? dim(` · deployed ${r.version}${r.deployedAt ? ` on ${r.deployedAt.slice(0, 10)}` : ''}`) : ''}`);
    if (r.provider === 'vercel' && h.version && handshake(installed, h.version) === 'relay-older') say(`  ${yellow('!')} you have ${installed}: obysphere server update ${r.name}`);
  }
  process.exitCode = bad ? 1 : 0;
}

function dockerSteps() {
  return `A Sphere in Docker, on any machine with Docker:

  # the two keys, made once and kept in a file only you can read
  umask 077
  printf 'SPHERE_KEY=%s\\nSPHERE_ADMIN_KEY=%s\\n' "$(openssl rand -base64 24)" "$(openssl rand -base64 24)" > ~/obysphere.env

  docker build -t obysphere ${shq(appSource())}
  docker run -d --name obysphere --restart unless-stopped -p 8080:8080 \\
    -v obysphere-data:/data --env-file ~/obysphere.env -e SPHERE_NAME="Our Sphere" obysphere
  curl -fs http://localhost:8080/healthz

Put it behind HTTPS (a reverse proxy or your platform's). Add -e SPHERE_TRUST_PROXY=1 only
when a proxy you control sets X-Forwarded-For.
Your invite link: https://<your host>/#key=<SPHERE_KEY from ~/obysphere.env>
To update: build the new version the same way, then docker rm -f obysphere and run it again
(the data stays in the obysphere-data volume).`;
}

function railwaySteps() {
  return `A Sphere on Railway (one process, a disk, always on):

  1. Railway › New project › Deploy from GitHub repo › ${REPO} (or your fork).
     Railway builds the Dockerfile and reads railway.json: one replica, health check on /healthz.
  2. Variables: SPHERE_KEY and SPHERE_ADMIN_KEY (each from: openssl rand -base64 24; keep them
     somewhere safe), SPHERE_TRUST_PROXY=1, and SPHERE_NAME="Our Sphere".
  3. Volumes: add one mounted at /data, so the Sphere keeps its members and history across deploys.
  4. Networking: generate a domain.
  5. Check it: obysphere server status https://<that domain>

Your invite link: https://<that domain>/#key=<SPHERE_KEY>
To update: redeploy from Railway (it builds the newest commit of the branch you chose).`;
}

// ================================================================ plumbing

function parseArgs(list) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '-f') opt.follow = true;
    else if (a === '-h') opt.help = true;
    else if (a === '-n') opt.n = list[++i];
    else if (!a.startsWith('--')) pos.push(a);
    else {
      const eq = a.indexOf('=');
      const k = a.slice(2, eq > 0 ? eq : undefined);
      opt[k] = eq > 0 ? a.slice(eq + 1) : BOOL.has(k) ? true : list[i + 1] !== undefined && !list[i + 1].startsWith('--') ? list[++i] : true;
    }
  }
  return { pos, opt };
}

function which(bin) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const e of exts) {
      const f = path.join(dir, bin + e);
      try {
        fs.accessSync(f, fs.constants.X_OK);
        if (fs.statSync(f).isFile()) return f;
      } catch {}
    }
  }
  return null;
}

// the node a service runs with: the one on your PATH when it's this one and stays put
// (Homebrew's /opt/homebrew/bin/node outlives an upgrade; the versioned folder it points
// at doesn't), else this process's own (fnm puts node on a path that goes with the shell)
function stableNode() {
  const real = (f) => {
    try {
      return fs.realpathSync(f);
    } catch {
      return null;
    }
  };
  const onPath = which('node');
  if (onPath && !/fnm_multishells/.test(onPath) && real(onPath) === real(process.execPath)) return onPath;
  return real(process.execPath) || process.execPath;
}

function cmpVersion(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([^+]*))?/.exec(String(v || ''));
    return m ? { n: [+m[1], +(m[2] || 0), +(m[3] || 0)], pre: m[4] || '' } : { n: [0, 0, 0], pre: '' };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] - y.n[i];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1; // a release is newer than its pre-releases
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function readJson(f, dflt) {
  try {
    const v = JSON.parse(fs.readFileSync(f, 'utf8'));
    return v && typeof v === 'object' ? v : dflt;
  } catch {
    return dflt;
  }
}
// written whole, owner-only
function writeSecret(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function slug(s) {
  return String(s || '').toLowerCase().replace(/^[@#]/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}
// no terminal escapes or other control characters (newline and tab stay)
function printable(s) {
  return String(s ?? '').replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069\u061C]/g, '');
}
function clean(s, max, keepLines = false) {
  const t = printable(s);
  return (keepLines ? t.trim() : t.replace(/\s+/g, ' ').trim()).slice(0, max);
}
function indentText(s) {
  return String(s).split('\n').map((l) => '    ' + l).join('\n');
}
function trimSlash(s) {
  return String(s).replace(/\/+$/, '');
}
function shq(s) {
  return /^[\w./@:-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}
// why a request failed, in a word (ECONNREFUSED, ENOTFOUND, …)
function netWhy(e) {
  return e?.cause?.code || e?.cause?.errors?.[0]?.code || (e?.name === 'TimeoutError' ? 'timed out' : e?.cause?.message || e?.message) || 'failed';
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function die(m) {
  warn(red('error: ') + printable(m));
  process.exit(1);
}

// ================================================================ run (last, so every constant above exists)

const OWN = { start, stop, restart, status, logs, open: openCmd, profiles, update, version, doctor, server, help };
if (cmd === '--help' || cmd === '-h') help();
else if (cmd === '--version' || cmd === '-v') version();
else if (Object.hasOwn(OWN, cmd)) {
  if (opt.help) help();
  else
    Promise.resolve()
      .then(() => OWN[cmd]())
      .catch((e) => die(e?.message || String(e)));
}
else runRep(argv);
