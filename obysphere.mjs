#!/usr/bin/env node
// Obysphere: one command for your Oby and your Sphere.
//
// This file runs your Oby in the background, keeps it up to date, and runs Spheres:
//   start, stop, restart, status, logs, open, profiles   your console and Oby, as a per-user service
//   update, version, doctor                              the installed app, from GitHub
//   server start | deploy | update | status              a Sphere, on this machine, on Vercel or in Docker
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

// Windows looks for a program in the folder you're in before PATH, unless this says not to. Every
// program here is started by its full path anyway (programPath); this covers what they start.
process.env.NoDefaultCurrentDirectoryInExePath = '1';

const SELF = fileURLToPath(import.meta.url);
const APP_DIR = path.dirname(SELF);
const REPO = 'obi-ai-bot/oby-sphere';
const VERSION = String(readJson(path.join(APP_DIR, 'package.json'), {}).version || '0.0.0');
// profiles: the folder that holds them (the same rule as rep.mjs)
const HOME = profilesHome();
// the app: <app home>/<version>/, with `current` (and `previous`, for --rollback) pointing at one
const APP_HOME = path.resolve(process.env.OBYSPHERE_APP_HOME || path.join(os.homedir(), '.local', 'share', 'obysphere'));
const BIN_DIR = path.resolve(process.env.OBYSPHERE_BIN_DIR || path.join(os.homedir(), '.local', 'bin'));
// for tests only, with OBYSPHERE_TEST=1: OBYSPHERE_RELEASES_API and OBYSPHERE_DOWNLOAD_BASE send the
// update check and the downloads to a server on this machine, and OBYSPHERE_NOTIFIER_APP moves the
// menu bar's app. Without it they're refused (nothing is downloaded) or ignored, wherever they were
// set: a repository's settings or a CI job can set a variable. None goes into a service file.
const TEST = /^(1|true|yes|on)$/i.test(process.env.OBYSPHERE_TEST || '');
const RELEASES_API = trimSlash(process.env.OBYSPHERE_RELEASES_API || `https://api.github.com/repos/${REPO}`);
const DOWNLOAD_BASE = trimSlash(process.env.OBYSPHERE_DOWNLOAD_BASE || `https://github.com/${REPO}`);
const MAIN_TARBALL = process.env.OBYSPHERE_DOWNLOAD_BASE ? `${DOWNLOAD_BASE}/archive/refs/heads/main.tar.gz` : `https://codeload.github.com/${REPO}/tar.gz/refs/heads/main`;
const TEST_SERVER = !!(process.env.OBYSPHERE_RELEASES_API || process.env.OBYSPHERE_DOWNLOAD_BASE);
const NOT_FOR_YOU = TEST_SERVER && !TEST
  ? 'OBYSPHERE_RELEASES_API and OBYSPHERE_DOWNLOAD_BASE are for tests only (with OBYSPHERE_TEST=1, and a server on this machine), so nothing was downloaded. Unset them, and the app comes from GitHub.'
  : null;
// where the app may come from: GitHub, over https (tests: this machine too)
const GITHUB_HOSTS = new Set(['github.com', 'api.github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com']);
// for tests only: OBYSPHERE_SERVICE_PLATFORM (darwin, linux or win32) says which system's service
// to write, whatever this one is; OBYSPHERE_SERVICE_DRYRUN writes down the launchctl, systemctl,
// schtasks and open commands instead of running them
const PLATFORM = process.env.OBYSPHERE_SERVICE_PLATFORM || process.platform;
const DRY = /^(|0|false|no|off)$/i.test(process.env.OBYSPHERE_SERVICE_DRYRUN || '') ? null : process.env.OBYSPHERE_SERVICE_DRYRUN;
const NO_CHECK = /^(1|true|yes|on)$/i.test(process.env.OBYSPHERE_NO_UPDATE_CHECK || '');
const RESERVED = new Set([4848, 4849, 4850]); // the relay's, the console's and the demo's ports
const VER = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?(?:\+[0-9A-Za-z.-]{1,40})?$/;
const DAY = 24 * 3600e3;
const BOOL = new Set(['all', 'foreground', 'check', 'rollback', 'allow-downgrade', 'follow', 'json', 'help', 'clear']);
const SHIM_MARK = '# obysphere shim';
// profile names Obysphere keeps: com.obysphere.menubar is the menu bar icon's LaunchAgent
const KEPT_NAMES = new Set(['menubar']);

const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c(2), bold = c(1), green = c(32), yellow = c(33), red = c(31), cyan = c(36);
const say = (s = '') => process.stdout.write(s + '\n');
const warn = (s) => process.stderr.write(s + '\n');
// run from the menu bar icon, whose restart (update) or removal (the last stop, menubar off) closes
// what reads this output: the work goes on without anyone reading it
for (const out of [process.stdout, process.stderr]) out.on('error', () => {});

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
                                   (a LaunchAgent on macOS, a systemd user unit on Linux, a scheduled task on Windows)
  obysphere stop | restart [--profile p | --all]
  obysphere status [--json]        each profile: running or not, its console, its Sphere, versions, updates
  obysphere open [--profile p]     your console, in the browser
  obysphere logs [--profile p] [-f] [-n 50]
  obysphere profiles [--json]      your profiles, and the folder that holds them
  obysphere profiles use <name>    the profile commands and the Claude Code plugin use when you don't say (--clear forgets it)
  obysphere settings [--profile p] [--json]   where your Oby's settings are, and what they say

Ask and read
  obysphere ask <agent> "<message>" [--file <path>] [--channel <name>]
  obysphere post "<message>" [--channel <name>] [--file <path>]
  obysphere agents | whoami | inbox | read [channel]
  obysphere delete <message id>    delete one of your own messages, for everyone (read shows the ids)
  obysphere away [--until <when>] [--note "<words>"] | --off
                                   tell askers you're away until <when> (18:00, "Mon 9:00", 2h, 3d or a date);
                                   plain away says what they see now
  obysphere serve [--approve]      answer asks in this terminal (start does it in the background)
  obysphere ui [--port 4849] [--open]   your console, from this terminal

Claude Code and Cursor
  obysphere mcp-config             the line that adds the Sphere to Claude Code or Cursor
  obysphere mcp [--serve]          the MCP server itself
  obysphere inbox --hook           what waits for you, as JSON (the plugin's SessionStart hook)

Security
  obysphere security [--json]      what your Oby can reach, who may ask it, secrets in its folders, and what to do
  obysphere lockdown [--off]       every ask waits for you, and answers reach nothing but your folders, until --off
  obysphere token rotate           a new token for your Oby: the old one stops working at once

Notifications and the menu bar
  obysphere notify test [--via desktop|slack|phone|all]
  obysphere notify app             macOS: build the app that shows them again
  obysphere menubar [on | off]     macOS: the Obysphere icon in the menu bar (start puts it there)

GitHub
  obysphere github status          how gh is signed in, and what your Oby may do on GitHub

Instruments
  obysphere instruments new | list | check | remove   what your Oby offers the Sphere (INSTRUMENTS.md)

Admins
  obysphere admin claim            make your Oby an admin (the key from a prompt or OBYSPHERE_ADMIN_KEY, never an argument)
  obysphere admin status | grant <handle> | revoke <handle> | rotate-key
  obysphere admin policy [--sealed on|off] [--max-depth N] [--max-file-bytes N] [--keep-days N] [--pause | --resume]
  obysphere admin audit export [--out <file> | -] [--after <seq>] [--force]   the audit log, as JSON Lines
  obysphere admin audit verify [<file>] [--since <older export>] [--json]
                                   check it on this machine, with the admin key (never sent anywhere)

Keep it up to date
  obysphere update [--check] [--channel stable|main] [--rollback] [--allow-downgrade]
  obysphere version | doctor

Run a Sphere
  obysphere server start [--port 4848] [--name "Our Sphere"] [--data ./data] [...]   here, in this terminal
  obysphere server deploy vercel --project <name> [--scope <team>] [--name "<Sphere name>"]
  obysphere server deploy docker | railway                the exact steps
  obysphere server update [<name>]                        deploy the installed version again
  obysphere server update --docker <container> [--url <address>] [--tag <version>]
                                   a Sphere in Docker here: pull the image, run it again the same way, record it
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
    return fs.readdirSync(HOME).filter((d) => /^[a-z0-9-]{1,32}$/.test(d) && !KEPT_NAMES.has(d) && fs.existsSync(path.join(HOME, d, 'profile.json'))).sort();
  } catch {
    return [];
  }
}

// the profile chosen with `obysphere profiles use <name>`, kept in <profiles>/.default-profile
// (rep.mjs and the plugin read the same file); null when none is chosen, or it's gone
const DEFAULT_PROFILE_FILE = '.default-profile';
function defaultProfile() {
  try {
    const n = slug(fs.readFileSync(path.join(HOME, DEFAULT_PROFILE_FILE), 'utf8').trim());
    return n && listProfiles().includes(n) ? n : null;
  } catch {
    return null;
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

// --profile (or OBYSPHERE_PROFILE), --all, or the only profile there is. `one`: a command
// that takes one profile (logs, open), so --all isn't offered
function targets({ one = false, all = !one && !!opt.all } = {}) {
  const names = listProfiles();
  const want = typeof opt.profile === 'string' ? opt.profile : process.env.OBYSPHERE_PROFILE || (all ? null : defaultProfile());
  if (want) {
    const n = slug(want);
    if (KEPT_NAMES.has(n)) die(keptName(n));
    if (!names.includes(n)) die(`no profile "${n}" in ${HOME}${names.length ? ` (there: ${names.join(', ')})` : ''}`);
    return [n];
  }
  if (!names.length) die(notJoined());
  if (all || names.length === 1) return names;
  die(`several profiles here (${names.join(', ')}): pass --profile <name>${!one && opt.all === undefined ? ', or --all' : ''}, or choose one for every command: obysphere profiles use <name>`);
}
const keptName = (n) => `"${n}" is the menu bar icon's name, so a profile can't have it: rename that profile's folder in ${HOME}, then use the new name.`;

// obysphere profiles use <name>: the profile every command (and the Claude Code plugin) uses
// when nothing else says; --clear forgets it. --profile and OBYSPHERE_PROFILE still win.
function useProfile(name) {
  const file = path.join(HOME, DEFAULT_PROFILE_FILE);
  if (opt.clear || name === '--clear') {
    fs.rmSync(file, { force: true });
    return say(`${green('✓')} No default profile now: with several, pass --profile <name>.`);
  }
  if (!name) die('usage: obysphere profiles use <name> | profiles use --clear');
  const n = slug(name);
  if (KEPT_NAMES.has(n)) die(keptName(n));
  const names = listProfiles();
  if (!names.includes(n)) die(`no profile "${n}" in ${HOME}${names.length ? ` (there: ${names.join(', ')})` : ''}`);
  fs.writeFileSync(file, n + '\n', { mode: 0o644 });
  const p = publicProfile(n);
  say(`${green('✓')} ${bold(n)} is your default profile: ${p.owner}'s Oby in ${p.sphereName}.
  Commands without --profile use it, and so does the Claude Code plugin (restart Claude Code, or reconnect the obysphere server in /mcp).`);
}

function profiles() {
  if (pos[0] === 'use') return useProfile(pos[1]);
  if (pos.length) die('usage: obysphere profiles [--json] | profiles use <name> | profiles use --clear');
  const names = listProfiles();
  const chosen = defaultProfile();
  if (opt.json) return say(JSON.stringify({ home: HOME, default: chosen, profiles: names.map((n) => ({ ...publicProfile(n), port: savedPort(n), service: serviceInstalled(n) })) }, null, 2));
  say(`${bold('Profiles')} in ${HOME} ${dim(`(${homeWhy()})`)}`);
  if (!names.length) return say(`  none yet.\n\n${notJoined()}`);
  for (const n of names) {
    const p = publicProfile(n);
    const port = savedPort(n);
    say(`  ${bold(n)}${n === chosen ? green('  (default)') : ''}  ${p.owner}'s Oby in ${p.sphereName}  ${dim(p.sphere || '')}${port ? dim(`  · console ${consoleUrl(n, port)}`) : ''}`);
  }
  if (names.length > 1 && !chosen) say(dim(`\nChoose the one commands and Claude Code use when you don't say: obysphere profiles use <name>`));
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
  if (PLATFORM === 'win32') return taskDir();
  if (PLATFORM === 'darwin') return path.join(os.homedir(), 'Library', 'LaunchAgents');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
}
const label = (name) => `com.obysphere.${name}`;
const unitName = (name) => `obysphere-${name}.service`;
function serviceFile(name) {
  if (PLATFORM === 'darwin') return path.join(serviceDir(), `${label(name)}.plist`);
  if (PLATFORM === 'linux') return path.join(serviceDir(), unitName(name));
  if (PLATFORM === 'win32') return taskFile(name, '.xml');
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

// what the service runs: `rep.mjs ui --serve`, with the profiles folder fixed and your PATH's full
// folders (so it finds claude, codex, cursor-agent and gh; an empty, `.` or other relative entry
// would find them in whatever folder they run in). No keys: the token stays in profile.json. No
// test variable either: a service outlives whatever set one.
function serviceEnv() {
  // OBYSPHERE_CLI: it runs for `obysphere`, so what the console says to type names it (as run() does)
  const env = { OBYSPHERE_HOME: HOME, PATH: fullPath(process.env.PATH || '') || '/usr/local/bin:/usr/bin:/bin', OBYSPHERE_CLI: '1' };
  for (const k of ['OBYSPHERE_APP_HOME', 'OBYSPHERE_DOWNLOADS', 'OBYSPHERE_NO_UPDATE_CHECK']) if (process.env[k]) env[k] = process.env[k];
  return env;
}
function serviceSpec(name, port, app = appForService()) {
  return {
    profile: name,
    label: label(name),
    args: [stableNode(), '--preserve-symlinks-main', path.join(app, 'rep.mjs'), 'ui', '--serve', '--profile', name, '--port', String(port)],
    env: serviceEnv(),
    cwd: path.join(HOME, name),
    log: logFile(name),
  };
}

function plist(s) {
  const x = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const str = (v) => `<string>${x(v)}</string>`;
  // the menu bar's: started again only when it fails (Hide this icon ends it for good: menubar off),
  // in your login session only; and what it runs (obysphere stop, update) outlives it when they end it
  const keep = s.menu
    ? `<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>AbandonProcessGroup</key><true/>`
    : '<key>KeepAlive</key><true/>';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Obysphere: ${s.menu ? 'its menu bar icon' : 'a console and Oby'}, written by obysphere start. obysphere stop removes it. -->
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
  ${keep}
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key>${str(s.log)}
  <key>StandardErrorPath</key>${str(s.log)}
</dict>
</plist>
`;
}

function unit(s) {
  // quoted for systemd: % is a specifier everywhere; $ is expanded in ExecStart only ($$ is a
  // plain $ there), while in Environment= it means nothing and $$ would stay two
  const pct = (v) => String(v).replace(/%/g, '%%');
  const q = (v) => `"${pct(String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"'))}"`;
  const qExec = (v) => q(v).replace(/\$/g, '$$$$');
  return `# Obysphere: a console and Oby, written by obysphere start. obysphere stop removes it.
[Unit]
Description=Obysphere: ${s.profile}'s console and Oby

[Service]
Type=simple
ExecStart=${s.args.map(qExec).join(' ')}
${Object.entries(s.env).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`).join('\n')}
WorkingDirectory=${pct(s.cwd)}
Restart=always
RestartSec=5
StandardOutput=append:${pct(s.log)}
StandardError=append:${pct(s.log)}

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
  const exe = programPath(bin);
  if (!exe) return { status: 1, stdout: '', stderr: `${bin} isn't on your PATH` };
  if (detach) {
    try {
      spawn(exe, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
      return { status: 0, stdout: '', stderr: '' };
    } catch (e) {
      return { status: 1, stdout: '', stderr: e.message };
    }
  }
  const r = spawnSync(exe, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30e3 });
  return { status: r.error ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || r.error?.message || '' };
}
const uid = () => (typeof process.getuid === 'function' ? process.getuid() : 0);

async function installService(name, port, app = appForService()) {
  const s = serviceSpec(name, port, app);
  fs.mkdirSync(path.dirname(s.log), { recursive: true, mode: 0o700 });
  rotate(s.log);
  const file = serviceFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (PLATFORM === 'win32') return installTask(name, port, s, app);
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
  if (PLATFORM === 'win32') return removeTask(name);
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
  if (opt.foreground || !serviceHere()) {
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
  await ensureMenubar();
  say(dim('obysphere status · obysphere logs -f · obysphere stop'));
}

async function stop() {
  if (!serviceHere()) die('Here your console runs in a terminal: stop it there with Ctrl+C.');
  for (const n of targets()) {
    if (!serviceInstalled(n)) {
      const port = savedPort(n);
      say(port && (await consoleAnswers(port)) ? `${n} runs in a terminal, not in the background: stop it there (Ctrl+C).` : `${n} isn't running in the background.`);
      continue;
    }
    await removeService(n);
    say(`${dim('○')} ${bold(n)} stopped. It won't start at login until you run obysphere start again.`);
  }
  // the menu bar icon shows while an Oby runs in the background: with the last one stopped, it goes
  if (!listProfiles().some(serviceInstalled) && removeMenubar()) say(dim('  The menu bar icon goes with it: obysphere start brings both back.'));
}

async function restart() {
  if (!serviceHere()) die('Here your console runs in a terminal: stop it there with Ctrl+C, then obysphere start.');
  for (const n of targets()) {
    const port = await consolePort(n);
    // a console in a terminal holds the port: a service started now would only fail to listen, again and again
    if (!serviceInstalled(n) && (await consoleAnswers(port))) {
      warn(`${yellow('!')} ${n}'s console runs at ${consoleUrl(n, port)}, in a terminal: stop it there (Ctrl+C), then obysphere start.`);
      process.exitCode = 1;
      continue;
    }
    await installService(n, port);
    await announce(n, port);
  }
  await ensureMenubar();
}

// after an update or a rollback: every service again, from `current`; and the menu bar icon, built
// again when that version's app is newer
async function restartServices() {
  if (!serviceHere()) return;
  const names = listProfiles().filter(serviceInstalled);
  for (const n of names) await installService(n, await consolePort(n), path.join(APP_HOME, 'current'));
  if (names.length) {
    say(`${green('✓')} restarted ${names.join(', ')} ${dim("(asks that came in meanwhile are picked up when it's back)")}`);
    await ensureMenubar({ app: path.join(APP_HOME, 'current') });
  }
}

// ================================================================ the menu bar (macOS)
//
// Obysphere.app, the small app that shows notifications (rep.mjs builds it in ~/Applications),
// also puts an icon in the menu bar: your Oby's state, what waits for you, away, start and stop,
// and an update when one is out. Its own LaunchAgent opens it while an Oby runs in the background:
// obysphere start writes it, and stopping the last one removes it. obysphere menubar off hides it
// for good (menubar.json in the profiles folder), and on brings it back.
//
// What it shows comes from `obysphere menubar model` (JSON), which it runs every 30 seconds and
// when you open it; what you choose runs `obysphere <words>` or opens a page of your console.

const MENU_LABEL = 'com.obysphere.menubar';
const menuFile = () => path.join(serviceDir(), `${MENU_LABEL}.plist`);
const menuPrefs = () => path.join(HOME, 'menubar.json');
const menubarWanted = () => PLATFORM === 'darwin' && readJson(menuPrefs(), {}).on !== false;
// where rep.mjs builds the app (OBYSPHERE_NOTIFIER_APP moves it, for tests only: a LaunchAgent
// would run whatever program is there at every login). rep.mjs checks it's the one it built.
const menuApp = () => (TEST && process.env.OBYSPHERE_NOTIFIER_APP ? path.resolve(process.env.OBYSPHERE_NOTIFIER_APP) : path.join(os.homedir(), 'Applications', 'Obysphere.app'));

function menuSpec(app) {
  return {
    menu: true,
    label: MENU_LABEL,
    args: [path.join(menuApp(), 'Contents', 'MacOS', 'Obysphere'), '--menu', '--node', stableNode(), '--cli', path.join(app, 'obysphere.mjs')],
    env: serviceEnv(),
    cwd: HOME,
    log: path.join(HOME, 'menubar.log'),
  };
}

// the app built (when it's older than this version's) and its agent written and started (when
// either changed, or force). Never fails start: without the Xcode command line tools, no icon.
async function ensureMenubar({ app = appForService(), force = false } = {}) {
  if (!menubarWanted()) return false;
  let built = false;
  if (!DRY) {
    const r = spawnSync(stableNode(), ['--preserve-symlinks-main', path.join(app, 'rep.mjs'), 'notify', 'app', '--if-needed', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'], // "building…" shows as it happens
      timeout: 300e3,
      env: { ...process.env, OBYSPHERE_HOME: HOME, OBYSPHERE_CLI: '1' },
    });
    let j = null;
    try {
      j = JSON.parse(r.stdout);
    } catch {}
    if (r.status !== 0 || !j?.app) {
      say(dim(`  No menu bar icon: ${clean(j?.error || r.stdout || r.error?.message || 'the app for it was not built', 300)}`));
      return false;
    }
    built = !!j.built;
  }
  const s = menuSpec(app);
  const file = menuFile();
  const text = plist(s);
  let same = false;
  try {
    same = fs.readFileSync(file, 'utf8') === text;
  } catch {}
  if (same && !built && !force) return true;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  rotate(s.log);
  fs.writeFileSync(file, text, { mode: 0o644 });
  const domain = `gui/${uid()}`;
  runOs('launchctl', ['bootout', `${domain}/${MENU_LABEL}`]);
  let r;
  for (let i = 0; i < 4; i++) {
    r = runOs('launchctl', ['bootstrap', domain, file]);
    if (r.status === 0) break;
    await sleep(500);
  }
  if (r.status !== 0) {
    warn(`${yellow('!')} the menu bar icon didn't start: ${clean(r.stderr, 300)}`);
    return false;
  }
  if (!same && !DRY) say(`${green('●')} Obysphere is in your menu bar too: what waits for you, away, start and stop. ${dim('obysphere menubar off hides it.')}`);
  return true;
}

// its agent stopped and removed; true when there was one
function removeMenubar() {
  const file = menuFile();
  if (PLATFORM !== 'darwin' || !fs.existsSync(file)) return false;
  runOs('launchctl', ['bootout', `gui/${uid()}/${MENU_LABEL}`]);
  fs.rmSync(file, { force: true });
  return true;
}

async function menubar() {
  const sub = pos[0] || '';
  if (sub === 'model') return say(JSON.stringify(await menuModel()));
  if (PLATFORM !== 'darwin') die('The menu bar icon is for macOS. Here: obysphere status, and your console (obysphere open).');
  if (sub === 'off') {
    fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
    writeSecret(menuPrefs(), { on: false });
    removeMenubar();
    return say(`${dim('○')} The menu bar icon is off. Your Oby keeps running. ${dim('obysphere menubar on brings it back.')}`);
  }
  if (sub === 'on') {
    fs.rmSync(menuPrefs(), { force: true });
    if (!listProfiles().some(serviceInstalled)) return say(`The menu bar icon is on: it shows while your Oby runs in the background ${dim('(obysphere start)')}.`);
    if ((await ensureMenubar({ force: true })) && DRY) say(`${dim('○')} the menu bar icon is written ${dim(`(${menuFile()})`)}; dry run, so nothing was started.`);
    return;
  }
  if (sub) die('usage: obysphere menubar [on | off]');
  if (!menubarWanted()) return say(`${dim('○')} The menu bar icon is off. ${dim('obysphere menubar on brings it back.')}`);
  if (fs.existsSync(menuFile())) return say(`${green('●')} The menu bar icon is on. ${dim('obysphere menubar off hides it; your Oby keeps running.')}`);
  say(`${dim('○')} The menu bar icon is on, and shows while your Oby runs in the background ${dim('(obysphere start)')}.`);
}

// ---- what the menu shows: { icon: { state: on|away|off, count, tip }, items: [...] }. An item is
// { kind: header|line|open|run|menu|separator, title, dot (line), url (open: your console only),
// args (run: obysphere's own words), busy, confirm: { title, text, button } (run), items (menu) }.
// Every 30 seconds: GitHub is asked at most once a day (latestKnown), and a Sphere only while an Oby
// of yours that's in it runs (the menu shows nothing of it otherwise).
async function menuModel(now = new Date()) {
  const client = clientVersion();
  const [latest, rows] = await Promise.all([
    latestKnown(),
    Promise.all(
      listProfiles().map(async (n) => {
        const r = await statusOf(n, client, { runningOnly: true });
        return { ...r, ...(r.running ? await consoleState(r.port) : {}), held: heldCount(n) };
      }),
    ),
  ]);
  return menuOf(rows, { update: latest.latest && cmpVersion(latest.latest, client) > 0 ? latest.latest : null, now });
}

// what waits for you and your away, from the console's local API (this machine only, its header)
async function consoleState(port) {
  const get = async (route) => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { 'x-obysphere-console': '1' }, signal: AbortSignal.timeout(3000), redirect: 'error' });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  };
  const [p, a] = await Promise.all([get('/local/pending'), get('/local/away')]);
  const w = a?.away;
  const iso = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
  const away = w && (w.by === 'owner' || w.by === 'pause') && (w.until === null || iso(w.until)) ? { by: w.by, until: w.until } : null;
  return { waiting: Array.isArray(p?.pending) ? p.pending.length : 0, away };
}

// asks held while its runtime can't answer: the files rep.mjs keeps (reading them through the
// console would fetch each ask from the Sphere)
function heldCount(name) {
  try {
    return fs.readdirSync(path.join(HOME, name, 'held')).filter((f) => /^m_[A-Za-z0-9_-]{1,32}\.json$/.test(f)).length;
  } catch {
    return 0;
  }
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// a time as the console says it: 18:00, Mon 9:00, Dec 3, 9:00 (this machine's time zone)
function whenWords(iso, now = new Date()) {
  const d = new Date(iso);
  const t = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return t;
  if (Math.abs(d - now) < 6 * DAY) return `${DAYS[d.getDay()]} ${t}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${t}`;
}

function awayItems(flag, now, page) {
  // the next working day at 9:00 (Monday after a Friday), as the console offers it
  const nine = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0);
  while ([0, 6].includes(nine.getDay())) nine.setDate(nine.getDate() + 1);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toDateString() === nine.toDateString();
  const away = (title, words) => ({ kind: 'run', title, args: ['away', ...words, ...flag], busy: 'Telling askers you’re away…' });
  return [
    away('For an hour', ['--until', '1h']),
    away('For 3 hours', ['--until', '3h']),
    away(`Until ${tomorrow ? 'tomorrow' : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][nine.getDay()]} 9:00`, ['--until', nine.toISOString()]),
    away('Until I’m back', ['--note=']),
    { kind: 'separator' },
    { kind: 'open', title: 'Another time, or a note…', url: page },
  ];
}

function menuOf(all, { update = null, now = new Date() } = {}) {
  const items = [];
  const states = [];
  let count = 0;
  const running = all.filter((r) => r.service).length;
  // a profile that isn't running, and isn't meant to (no service), is only a Start in a submenu
  // while another one runs
  const active = all.filter((r) => r.service || r.running);
  const rows = active.length ? active : all;
  const idle = active.length ? all.filter((r) => !active.includes(r)) : [];
  const many = all.length > 1;
  for (const r of rows) {
    if (items.length) items.push({ kind: 'separator' });
    const flag = ['--profile', r.profile];
    const page = (hash) => `${r.console}${hash ? `#${hash}` : ''}`;
    const until = (w) => (w.until ? ` until ${whenWords(w.until, now)}` : '');
    let state = 'on';
    let line = r.service ? 'Running' : 'Running in a terminal';
    if (!r.running) [state, line] = ['off', r.service ? 'Not answering: obysphere logs shows why' : 'Stopped'];
    else if (!r.relay?.reachable) [state, line] = ['off', 'Running, but it can’t reach the Sphere'];
    else if (r.away?.by === 'owner') [state, line] = ['away', r.away.until ? `Away${until(r.away)}` : 'Away until you’re back'];
    else if (r.away?.by === 'pause') [state, line] = ['away', `Paused${until(r.away)}: your runtime can’t answer`];
    states.push(state);
    items.push({ kind: 'header', title: many ? `${r.sphereName}: @${r.name}` : `${r.owner}’s Oby in ${r.sphereName}` });
    items.push({ kind: 'line', title: line, dot: state });
    if (r.running && r.console) {
      if (r.waiting) {
        count += r.waiting;
        items.push({ kind: 'open', title: r.waiting === 1 ? '1 ask waits for you' : `${r.waiting} asks wait for you`, url: page('page=you') });
      }
      if (r.held) items.push({ kind: 'open', title: r.held === 1 ? '1 ask held until your runtime can answer' : `${r.held} asks held until your runtime can answer`, url: page('page=you') });
      items.push({ kind: 'open', title: 'Open console', url: page('') });
      if (r.away?.by === 'owner') {
        items.push({ kind: 'run', title: 'I’m back', args: ['away', '--off', ...flag], busy: 'Telling askers you’re back…' });
        items.push({ kind: 'open', title: 'Change away…', url: page('page=you') });
      } else items.push({ kind: 'menu', title: 'Away', items: awayItems(flag, now, page('page=you')) });
    }
    const where = many ? ` in ${r.sphereName}` : '';
    if (r.service && r.running)
      items.push({
        kind: 'run',
        title: 'Stop',
        args: ['stop', ...flag],
        busy: 'Stopping your Oby…',
        confirm: {
          title: `Stop your Oby${where}?`,
          text: running > 1 ? 'It stops answering asks until you start it again.' : 'It stops answering asks, and this icon goes too, until you run obysphere start.',
          button: 'Stop',
        },
      });
    else if (r.service) items.push({ kind: 'run', title: 'Restart', args: ['restart', ...flag], busy: 'Starting your Oby…' });
    else if (!r.running) items.push({ kind: 'run', title: 'Start', args: ['start', ...flag], busy: 'Starting your Oby…' });
  }
  if (idle.length) {
    items.push({ kind: 'separator' });
    items.push({ kind: 'menu', title: 'Start another Oby', items: idle.map((r) => ({ kind: 'run', title: `${r.sphereName}: @${r.name}`, args: ['start', '--profile', r.profile], busy: 'Starting your Oby…' })) });
  }
  if (!all.length) {
    states.push('off');
    items.push({ kind: 'line', title: 'No profile here yet: obysphere join', dot: 'off' });
  }
  items.push({ kind: 'separator' });
  // the release it names, whichever channel you installed from (main isn't checksummed)
  if (update) items.push({ kind: 'run', title: `Update to ${update}`, args: ['update', '--channel', 'stable'], busy: `Updating to ${update}…` });
  items.push({ kind: 'run', title: 'Hide this icon', args: ['menubar', 'off'], confirm: { title: 'Hide the Obysphere icon?', text: 'Your Oby keeps running. obysphere menubar on brings the icon back.', button: 'Hide' } });
  const state = states.includes('away') ? 'away' : states.includes('on') ? 'on' : 'off';
  const say = rows.length > 1 ? `${states.filter((s) => s !== 'off').length} of ${rows.length} Obys running` : items.find((i) => i.kind === 'line').title;
  const tip = ['Obysphere', say, count ? (count === 1 ? '1 ask waits for you' : `${count} asks wait for you`) : null, update ? `${update} is out` : null].filter(Boolean).join(' · ');
  return { icon: { state, count, tip }, items };
}

async function logs() {
  const [name] = targets({ one: true });
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
  const [name] = targets({ one: true });
  const port = savedPort(name);
  if (!port || !(await consoleAnswers(port))) die(`${name}'s console isn't running: obysphere start${listProfiles().length > 1 ? ` --profile ${name}` : ''}`);
  const url = consoleUrl(name, port);
  const [bin, args] = PLATFORM === 'darwin' ? ['open', [url]] : PLATFORM === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  const r = runOs(bin, args, { detach: true });
  if (r.status !== 0) die(`couldn't open a browser: open ${url} yourself`);
  say(`Opening ${cyan(url)}`);
}

// ================================================================ the background service on Windows
//
// A scheduled task of your own, made from an XML file as a LaunchAgent is from its plist. It
// starts when you log on, runs only while you're logged on (InteractiveToken) and with the least
// privileges, so it needs no admin rights and no UAC prompt. A task name belongs to the whole
// computer, and a user without admin rights can't count on making a folder in Task Scheduler's
// library, so yours sits in its root folder as Obysphere-<profile>-<your user name>, the way
// per-user updaters name theirs.
//
// Its action is wscript.exe with a small JScript file, because Windows Script Host is a part of
// Windows that can start a console program with no window at all (WshShell.Run, window style 0)
// and wait for it. A .cmd file, or node.exe itself, opens a console window; PowerShell's
// -WindowStyle Hidden still flashes one; `conhost --headless` is undocumented and security tools
// flag it; Node's windowsHide hides only the windows of the programs Node starts; and VBScript is
// being removed from Windows, while JScript stays.
//
// The JScript file runs `obysphere.mjs service-run`, a small supervisor that does what launchd
// and systemd do on the other systems: it runs `rep.mjs ui --serve` as the plist and the unit
// say (the same spec), writes its output to <profile>/logs/, starts it again 5 seconds after it
// stops, and ends (with it) when the task is ended (schtasks /end), or when its spec changes or
// goes (restart, stop). Task Scheduler's own restart on failure is only a backstop.
//
// What `schtasks /query` shows of the task is wscript.exe and that file's path. Nothing in the
// three files (the task's XML, the JScript file, the spec) is secret: the profile, with its
// token, is read from disk.

const SERVICE_SYSTEMS = new Set(['darwin', 'linux', 'win32']);
function serviceHere() {
  return SERVICE_SYSTEMS.has(PLATFORM);
}

// %LOCALAPPDATA%\obysphere\services: the task's XML, its JScript file and the spec, per profile
function taskDir() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'obysphere', 'services');
}
const taskFile = (name, ext) => path.join(serviceDir(), `obysphere-${name}${ext}`);
function winUserName() {
  if (process.env.USERNAME) return process.env.USERNAME;
  try {
    return os.userInfo().username;
  } catch {
    return 'me';
  }
}
// who the task runs as, and whose logon starts it: you (DOMAIN\user)
const winUser = () => (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${winUserName()}` : winUserName());
const taskName = (name) => `Obysphere-${name}-${winUserName().replace(/[^\w.-]+/g, '_').slice(0, 40)}`;

// one argument as Windows programs read their command line (the C runtime's rules): quoted when
// it has a space or a quote, with the backslashes before a quote, or before the closing one, doubled
function winArg(a) {
  const s = String(a);
  if (s && !/[\s"]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}
// a JScript string literal in plain ASCII: Windows Script Host reads a .js file in the system's
// code page, so anything else is a \u escape
const jsString = (s) => JSON.stringify(String(s)).replace(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);

function taskScript(name, command) {
  return `// Obysphere: ${name}'s console and Oby. The scheduled task ${taskName(name)} runs this with
// wscript.exe when you log on. Written by obysphere start; obysphere stop removes it.
// Node starts with no window (0), and this waits for it (true) and ends with its exit code.
var shell = WScript.CreateObject("WScript.Shell");
WScript.Quit(shell.Run(${jsString(command)}, 0, true));
`;
}

function taskXml(name, s, script) {
  const x = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); // text only, no attributes
  const wscript = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${x(`Obysphere: ${name}'s console and Oby, written by obysphere start. obysphere stop removes it.`)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${x(winUser())}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${x(winUser())}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${x(wscript)}</Command>
      <Arguments>${x(`//B //Nologo //E:JScript ${winArg(script)}`)}</Arguments>
      <WorkingDirectory>${x(s.cwd)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

// schtasks: the one first on your PATH, never one in the folder you're in (which Windows would
// look in first); else Windows' own
function schtasks(args) {
  return runOs(DRY ? 'schtasks' : schtasksBin(), args);
}
function schtasksBin() {
  return programPath('schtasks') || (process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe') : 'schtasks');
}

async function untilQuiet(port) {
  for (let i = 0; i < 24 && !DRY && (await consoleAnswers(port)); i++) await sleep(250);
}

async function installTask(name, port, s, app) {
  const task = taskName(name);
  const [xmlFile, script, specFile] = ['.xml', '.js', '.json'].map((e) => taskFile(name, e));
  const command = [s.args[0], '--preserve-symlinks-main', path.join(app, 'obysphere.mjs'), 'service-run', '--spec', specFile].map(winArg).join(' ');
  // WshShell.Run and Task Scheduler both put a variable's value in place of %NAME%
  const word = `${command} ${script} ${s.cwd}`.split('%').slice(1, -1).find((v) => v && process.env[v] !== undefined);
  if (word !== undefined) throw new Error(`Windows would read %${word}% in these paths as a variable, so a task can't run them: obysphere start --foreground runs your console in this terminal.\n  ${command}`);
  // a new id: a supervisor still running from before sees it and stops
  writeSecret(specFile, { ...s, task, id: randomBytes(8).toString('hex') });
  fs.writeFileSync(script, taskScript(name, command), { mode: 0o644 });
  fs.writeFileSync(xmlFile, Buffer.from('\ufeff' + taskXml(name, s, script), 'utf16le'), { mode: 0o644 });
  schtasks(['/end', '/tn', task]); // not running: fine
  const made = schtasks(['/create', '/tn', task, '/xml', xmlFile, '/f']);
  if (made.status !== 0) {
    // nothing left behind: a task from before (a restart, an update) goes too, since without its
    // files obysphere stop couldn't find it; its supervisor saw the spec change and stops
    schtasks(['/delete', '/tn', task, '/f']); // none from before: fine
    for (const f of [xmlFile, script, specFile]) fs.rmSync(f, { force: true });
    await untilQuiet(port);
    throw new Error(`schtasks couldn't create the task ${task}: ${clean(made.stderr || made.stdout, 300) || `exit code ${made.status}`}`);
  }
  await untilQuiet(port); // the one from before lets go of the port
  const ran = schtasks(['/run', '/tn', task]);
  if (ran.status !== 0) throw new Error(`schtasks couldn't start the task ${task}: ${clean(ran.stderr || ran.stdout, 300) || `exit code ${ran.status}`}`);
}

async function removeTask(name) {
  const task = taskName(name);
  fs.rmSync(taskFile(name, '.json'), { force: true }); // its supervisor stops within a second
  schtasks(['/end', '/tn', task]);
  schtasks(['/delete', '/tn', task, '/f']);
  for (const e of ['.js', '.xml']) fs.rmSync(taskFile(name, e), { force: true });
  await untilQuiet(savedPort(name));
}

// the spec's environment over this one's; on Windows, where PATH and Path are one name, without twins
function specEnv(base, add) {
  const env = { ...base };
  const names = new Set(Object.keys(add).map((k) => k.toUpperCase()));
  if (process.platform === 'win32') for (const k of Object.keys(env)) if (names.has(k.toUpperCase())) delete env[k];
  return { ...env, ...add };
}

// obysphere.mjs service-run --spec <file>: what the task's JScript file starts, not a command for people
async function serviceRun() {
  if (typeof opt.spec !== 'string') die('usage: obysphere service-run --spec <file> (the Windows task runs it)');
  const file = path.resolve(opt.spec);
  const s = readJson(file, null);
  const strings = (a) => Array.isArray(a) && a.length > 0 && a.every((v) => typeof v === 'string');
  const ok = s && strings(s.args) && typeof s.cwd === 'string' && typeof s.log === 'string' && typeof s.id === 'string' && s.env && typeof s.env === 'object' && Object.values(s.env).every((v) => typeof v === 'string');
  if (!ok) die(`${file} isn't a service spec`);
  const note = (m) => {
    try {
      fs.appendFileSync(s.log, `[${new Date().toISOString()}] obysphere: ${m}\n`);
    } catch {}
  };
  let child = null;
  let done = false;
  const end = (why) => {
    if (done) return;
    done = true;
    note(why);
    try {
      child?.kill();
    } catch {}
    process.exit(0);
  };
  // the task ended: wscript.exe, which waits for this, is gone (on Windows a parent's id stays put)
  const parent = process.ppid;
  const parentGone = () => {
    if (process.ppid !== parent) return true;
    try {
      process.kill(parent, 0);
      return false;
    } catch (e) {
      return e.code !== 'EPERM';
    }
  };
  // the spec's id now: null when it's gone, undefined when it can't be read just now (another
  // program holding it open, say), which is no reason to stop
  const specId = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))?.id ?? null;
    } catch (e) {
      return e.code === 'ENOENT' ? null : undefined;
    }
  };
  setInterval(() => {
    const id = specId();
    if (id !== undefined && id !== s.id) end('the service was changed or removed: stopping');
    else if (parentGone()) end('its task ended: stopping');
  }, 1000);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => end(`${sig}: stopping`));
  const env = specEnv(process.env, s.env);
  fs.mkdirSync(path.dirname(s.log), { recursive: true, mode: 0o700 });
  while (!done) {
    rotate(s.log);
    note('starting your console and Oby');
    const fd = fs.openSync(s.log, 'a');
    const why = await new Promise((resolve) => {
      // its own console, with no window; the runtimes it starts share it, so they open none either
      child = spawn(s.args[0], s.args.slice(1), { cwd: s.cwd, env, stdio: ['ignore', fd, fd], windowsHide: true });
      child.once('error', (e) => resolve(e.message));
      child.once('exit', (code, signal) => resolve(signal || `exit code ${code}`));
    });
    fs.closeSync(fd);
    child = null;
    if (done) break;
    note(`it stopped (${clean(why, 200)}); starting it again in 5 seconds`);
    await sleep(5000);
  }
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

// runningOnly: the Sphere is asked only when the console runs (the menu bar, every 30 seconds)
async function statusOf(name, client, { runningOnly = false } = {}) {
  const p = publicProfile(name);
  const port = savedPort(name);
  const health = async () => (p.sphere ? relayHealth(p.sphere) : { ok: false, error: 'no Sphere address' });
  const [running, relay] = runningOnly
    ? await consoleAnswers(port).then(async (up) => [up, up ? await health() : { ok: false, error: 'not asked: not running' }])
    : await Promise.all([consoleAnswers(port), health()]);
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
  if (PLATFORM === 'darwin' && !menubarWanted()) note('the menu bar icon is off', 'obysphere menubar on brings it back');
  else if (PLATFORM === 'darwin' && fs.existsSync(menuFile())) ok('the menu bar icon is on', menuApp());

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
  if (NOT_FOR_YOU) no('OBYSPHERE_RELEASES_API or OBYSPHERE_DOWNLOAD_BASE is set, so nothing is checked or downloaded', NOT_FOR_YOU);
  if (latest.latest && cmpVersion(latest.latest, client) > 0) note(`${latest.latest} is out (you have ${client})`, 'obysphere update');
  else if (latest.latest) ok(`up to date (${client})`);
  else say(dim(`  ${NO_CHECK ? 'not checked (OBYSPHERE_NO_UPDATE_CHECK)' : 'no release found yet'}`));
  process.exitCode = bad ? 1 : 0;
}

// ================================================================ update

// the update check's cache: in the app home, else (run from a checkout) beside your profiles, so the
// menu bar's look every 30 seconds doesn't ask GitHub each time; none when neither folder is there
// (a check from nowhere makes no folder)
function cacheFile() {
  for (const dir of [APP_HOME, HOME]) if (fs.existsSync(dir)) return path.join(dir, 'update-check.json');
  return null;
}
// the newest release, as last checked: once a day at most, not again within an hour of a check that
// failed, and never with OBYSPHERE_NO_UPDATE_CHECK
async function latestKnown({ force = false } = {}) {
  const file = cacheFile();
  const c = file ? readJson(file, {}) : {};
  const cached = { latest: VER.test(String(c.latest)) ? c.latest : null, checkedAt: typeof c.checkedAt === 'string' ? c.checkedAt : null };
  const ago = (t) => (typeof t === 'string' ? Date.now() - Date.parse(t) : Infinity);
  const fresh = ago(cached.checkedAt) < DAY || ago(c.failedAt) < 3600e3;
  if (!force && (fresh || NO_CHECK)) return cached;
  try {
    const r = await latestRelease();
    return saveCache(r.version);
  } catch (e) {
    if (e.noRelease) return saveCache(null);
    if (file) writeSecret(file, { ...cached, failedAt: new Date().toISOString() });
    return cached;
  }
}
function saveCache(latest) {
  const rec = { latest, checkedAt: new Date().toISOString() };
  const file = cacheFile();
  if (file) writeSecret(file, rec);
  return rec;
}

// GitHub over https, and nothing else; with the test variables, a server on this machine (by its
// name or address) and nothing else, so they can't name another repository on GitHub either
function checkedUrl(u) {
  const url = new URL(u);
  if (!TEST_SERVER && url.protocol === 'https:' && GITHUB_HOSTS.has(url.hostname) && !url.port && !url.username && !url.password) return url;
  if (TEST_SERVER && TEST && /^https?:$/.test(url.protocol) && /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/.test(url.hostname)) return url;
  throw new Error(`refusing to download from ${url.origin}: the app comes from GitHub only`);
}
// GitHub sends a release's files on to where it keeps them: each redirect is checked before it's followed
async function get(u, { timeoutMs = 60e3, accept } = {}) {
  if (NOT_FOR_YOU) throw new Error(NOT_FOR_YOU);
  let url = checkedUrl(u);
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hops = 0; ; hops++) {
    let r;
    try {
      r = await fetch(url, { signal, redirect: 'manual', headers: { 'user-agent': 'obysphere', ...(accept ? { accept } : {}) } });
    } catch (e) {
      throw new Error(`couldn't reach ${url.host} (${clean(netWhy(e), 80)}): check your network and try again`);
    }
    const to = [301, 302, 303, 307, 308].includes(r.status) ? r.headers.get('location') : null;
    if (!to) return r;
    await r.body?.cancel().catch(() => {});
    if (hops >= 5) throw new Error(`${url.host} sent the download on too many times`);
    url = checkedUrl(new URL(to, url));
  }
}
// read as it comes, and stopped at 64 MB (the app is far smaller): never held whole first
const DOWNLOAD_MAX = 64 * 1024 * 1024;
async function download(u) {
  const r = await get(u);
  if (!r.ok) throw new Error(`${u} answered ${r.status}`);
  const big = () => new Error(`${u} is larger than expected`);
  if (Number(r.headers.get('content-length')) > DOWNLOAD_MAX) {
    await r.body?.cancel().catch(() => {});
    throw big();
  }
  const parts = [];
  let size = 0;
  for await (const part of r.body || []) {
    size += part.length;
    if (size > DOWNLOAD_MAX) throw big(); // leaving the loop cancels the rest
    parts.push(part);
  }
  return Buffer.concat(parts);
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
    const tar = programPath('tar');
    if (!tar) throw new Error("couldn't unpack it: there's no tar on your PATH");
    const r = spawnSync(tar, ['-xzf', tgz, '-C', x], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 120e3 });
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
// ours: a plain file (never a link, whose target would be written) with the mark on its second line.
// A new one is written beside it and renamed over it.
function ensureShim() {
  if (process.platform === 'win32') return;
  const shim = path.join(BIN_DIR, 'obysphere');
  const st = fs.lstatSync(shim, { throwIfNoEntry: false });
  let now = null;
  try {
    if (st?.isFile()) now = fs.readFileSync(shim, 'utf8');
  } catch {}
  if (now === shimText()) return;
  if (st && !String(now ?? '').split('\n')[1]?.startsWith(SHIM_MARK)) return warn(`${yellow('!')} ${shim} isn't ours, so it's left as it is.`);
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const tmp = `${shim}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, shimText(), { mode: 0o755, flag: 'wx' });
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, shim);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
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
  // an older release is never taken by surprise (one made latest again by mistake, or by someone who shouldn't)
  if (cmpVersion(rel.version, have) < 0 && !opt['allow-downgrade'])
    die(`The latest release is ${rel.version}, older than the ${have} you have: nothing changed. To go back to it on purpose: obysphere update --allow-downgrade`);
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
  die('usage: obysphere server start [flags] | deploy vercel|docker|railway | update [<name> | --docker <container>] | status [<name> | <url>]');
}

// server.mjs beside this file, in this terminal, with its own flags
function serverStart() {
  const child = spawn(process.execPath, [path.join(APP_DIR, 'server.mjs'), ...argv.slice(2)], { stdio: 'inherit' });
  child.on('error', (e) => die(`couldn't run server.mjs: ${e.message}`));
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
  if (!all.length) die(`No deployed Sphere is recorded here. Deploy one: obysphere server deploy vercel --project <name>${DOCKER_HINT}`);
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
  const git = programPath('git');
  if (git && fs.existsSync(path.join(src, '.git'))) {
    const r = spawnSync(git, ['-C', src, 'ls-files', '-z'], { encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(src) }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 30e3 });
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

// a Sphere's keys: made once, 24 random bytes each, kept in a file only you can read. The file
// holds only the keys this command sets on Vercel: never a new one for a key Vercel already has
// (one set by hand), which would only send you to the wrong key.
const goodKey = (keys, n) => String(keys?.[n] || '').length >= 22;
function ensureKeys(file, names) {
  const have = readJson(file, {});
  const keys = { ...have };
  for (const n of names) if (!goodKey(keys, n)) keys[n] = randomBytes(24).toString('base64url');
  if (names.some((n) => !goodKey(have, n))) writeSecret(file, { ...keys, createdAt: have.createdAt || new Date().toISOString() });
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
    if (missing.length) {
      const lost = missing.filter((n) => !goodKey(readJson(keysFile, {}), n));
      if (isUpdate && lost.length)
        throw new Error(`${lost.join(' and ')} ${lost.length > 1 ? "aren't" : "isn't"} set on Vercel any more, and ${lost.length > 1 ? "they aren't" : "it isn't"} in the keys for ${project} here. Set ${lost.length > 1 ? 'them' : 'it'} again with the value${lost.length > 1 ? 's' : ''} the Sphere had (vercel env add <NAME> production --sensitive): new keys would lock its data.`);
      const keys = ensureKeys(keysFile, missing);
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
    // which key is where: the file has the ones this command set; the others were set on Vercel by hand
    const known = readJson(keysFile, {});
    if (goodKey(known, 'SPHERE_KEY') || goodKey(known, 'SPHERE_ADMIN_KEY')) say(`  Keys:    ${keysFile} ${dim('(only you can read it; never printed)')}`);
    say(`  Invite:  ${url}/#key=${goodKey(known, 'SPHERE_KEY') ? '<SPHERE_KEY from that file>' : '<the join key set on Vercel>'}`);
    say(`  Admin:   OBYSPHERE_ADMIN_KEY=${goodKey(known, 'SPHERE_ADMIN_KEY') ? '<SPHERE_ADMIN_KEY from that file>' : '<the admin key set on Vercel>'} obysphere admin claim, once you've joined`);
    say(dim(`  Later:   obysphere server update ${project} deploys the installed version again`));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function serverUpdate() {
  if (opt.docker !== undefined) return dockerServerUpdate(opt.docker); // ===== docker-image
  const rec = pickRecord(pos[1]);
  if (rec.provider === 'docker') return dockerServerUpdate(rec.container, rec); // ===== docker-image
  if (rec.provider !== 'vercel') die(`${rec.name} isn't on Vercel: update it where it runs.`);
  await deployVercel({ project: rec.project, scope: rec.scope || undefined, sphereName: undefined, isUpdate: true });
}

async function serverStatus() {
  const arg = pos[1];
  const list = arg && /^https?:\/\//.test(arg) ? [{ name: arg, url: arg }] : arg ? [pickRecord(arg)] : records();
  if (!list.length) return say(`No deployed Sphere is recorded here. Deploy one: obysphere server deploy vercel --project <name>${DOCKER_HINT}`);
  const installed = String(readJson(path.join(appSource(), 'package.json'), {}).version || VERSION);
  let bad = 0;
  for (const r of list) {
    if (!r.url && r.provider === 'docker') { // ===== docker-image: a container with no published port
      say(`${bold(r.name)}  ${dim(`the container ${r.container}`)}\n  ${dim('○')} no address recorded: obysphere server update ${r.name} --url https://<its address>`);
      continue;
    }
    const h = await relayHealth(r.url);
    say(r.name === r.url ? bold(r.url) : `${bold(r.name)}  ${r.url}`);
    if (!h.ok) {
      bad++;
      say(`  ${red('✗')} doesn't answer${h.error ? ` (${h.error})` : ''}`);
      continue;
    }
    say(`  ${green('✓')} up · relay ${h.version || '?'} · ${h.store || '?'} store${h.sealed ? ' · sealed' : ''}${h.paused ? ' · paused' : ''}${r.version ? dim(` · deployed ${r.version}${r.deployedAt ? ` on ${r.deployedAt.slice(0, 10)}` : ''}`) : ''}`);
    if ((r.provider === 'vercel' || r.provider === 'docker') && h.version && handshake(installed, h.version) === 'relay-older') say(`  ${yellow('!')} you have ${installed}: obysphere server update ${r.name}`);
  }
  process.exitCode = bad ? 1 : 0;
}

function dockerSteps() {
  const v = String(readJson(path.join(appSource(), 'package.json'), {}).version || VERSION);
  return `A Sphere in Docker, on any machine with Docker:

  # the two keys, made once and kept in a file only you can read
  (umask 077; printf 'SPHERE_KEY=%s\\nSPHERE_ADMIN_KEY=%s\\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > ~/obysphere.env)

  # the published image, for your version (${v}), for linux/amd64 and linux/arm64.
  # To build it yourself instead: docker build -t obysphere ${shq(appSource())}
  # and run obysphere in place of the image's name below.
  docker run -d --name obysphere --restart unless-stopped -p 8080:8080 \\
    -v obysphere-data:/data --env-file ~/obysphere.env -e SPHERE_NAME="Our Sphere" \\
    ${DOCKER_IMAGE}:${v}
  curl -fs http://localhost:8080/healthz

Put it behind HTTPS (a reverse proxy or your platform's). Add -e SPHERE_TRUST_PROXY=1 only
when a proxy you control sets X-Forwarded-For.
Your invite link: https://<your host>/#key=<SPHERE_KEY from ~/obysphere.env>
To update: obysphere update, then obysphere server update --docker obysphere. It pulls the image
for your new version and runs the container again with the same name, port, volume and variables
(the data stays in the obysphere-data volume). From then on, obysphere server update finds it.`;
}

function railwaySteps() {
  return `A Sphere on Railway (one process, a disk, always on):

In one click, from the template: https://railway.com/deploy/oby-sphere
Then check it: obysphere server status https://<its domain>

Or by hand:
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

// ===== docker-image: a Sphere in Docker, updated in place
//
// `obysphere server update --docker <container>` updates a Sphere that runs in Docker here: it
// pulls the published image for the installed version (or --tag) and runs it as that container
// again, with the same name, ports, volumes, variables, labels, restart policy, network,
// arguments and limits. Then it records the Sphere in servers/<name>.json (no secrets), so
// `server update` and `server status` find it later. A container that isn't a Sphere, one that
// Docker Compose runs, or a setting this can't carry over is refused before anything changes.
// The variables hold the keys. They're read from `docker container inspect` into memory and
// reach `docker run` in a file only you can read (--env-file; labels in a --label-file), removed
// as soon as docker has read it: never in an argument, never printed, and what docker says is
// shown with their values hidden. The old container waits, stopped, as <name>-previous until
// the new one runs and answers; if it doesn't, the old one comes back.

const DOCKER_IMAGE = `ghcr.io/${REPO}`;
const DOCKER_HINT = ', or update a Sphere in Docker here: obysphere server update --docker <container>';
const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const DOCKER_REPO = /^(?:[a-z0-9.-]+(?::\d{1,5})?\/)?[a-z0-9]+(?:[._-]+[a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*$/;
const DOCKER_WAIT_MS = 60e3;
// log drivers whose options are sizes and names, never credentials, so they may go in arguments
const DOCKER_LOGS = new Set(['json-file', 'local', 'journald', 'syslog', 'none']);

// the docker command, without the Sphere's variables in its environment. It resolves with what
// docker printed; a failure says what docker said on stderr (never stdout: inspect prints the
// variables there), with `secrets` hidden.
function docker(args, secrets = []) {
  const bin = which('docker') || die('This needs Docker: the docker command, on your PATH.');
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^SPHERE_/.test(k) || k === 'OBYSPHERE_ADMIN_KEY') delete env[k];
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => reject(new Error(`couldn't run docker: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const said = clean(hide(stderr, secrets), 2000, true);
      reject(new Error(`docker ${args[0]}${args[0] === 'container' || args[0] === 'image' ? ` ${args[1]}` : ''} failed${said ? `:\n${indentText(said)}` : ''}`));
    });
  });
}
// every value in `secrets` (8 characters or more) taken out of `s`
function hide(s, secrets) {
  return secrets.filter((v) => v.length >= 8).reduce((t, v) => t.split(v).join('<hidden>'), String(s ?? ''));
}
async function dockerInspect(kind, ref, secrets = []) {
  const { stdout } = await docker([kind, 'inspect', ref], secrets);
  let j;
  try {
    j = JSON.parse(stdout);
  } catch {}
  if (!Array.isArray(j) || !j[0] || typeof j[0] !== 'object') throw new Error(`docker ${kind} inspect ${ref} said something this doesn't understand.`);
  return j[0];
}

const splitVar = (e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)];
const argOf = (cmd, flag) => {
  const i = cmd.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
  return i < 0 ? undefined : cmd[i].includes('=') ? cmd[i].slice(flag.length + 1) : cmd[i + 1];
};
const listOf = (v) => (Array.isArray(v) ? v : []);
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// a Sphere's container: its image comes from this repository (or a fork), by its label or its
// name, or was built from its Dockerfile, which sets SPHERE_DATA
function runsSphere(c, img) {
  const source = String(img.Config?.Labels?.['org.opencontainers.image.source'] || '');
  return /\/oby-?sphere(?:\.git)?$/i.test(source) || /(?:^|\/)oby-?sphere(?:[:@]|$)/i.test(String(c.Config?.Image || '')) || listOf(img.Config?.Env).some((e) => e.startsWith('SPHERE_DATA='));
}

// how a container runs, as `docker run` arguments, from `docker container inspect` and its image's
// own inspect: only the variables and labels given to the container (not the image's own, like
// PATH), and only what can be carried over safely. Anything else is refused before something changes.
function dockerPlan(name, c, img) {
  const cfg = c.Config || {};
  const hc = c.HostConfig || {};
  const ic = img.Config || {};
  if (!runsSphere(c, img)) throw new Error(`${name} doesn't run a Sphere (its image: ${clean(cfg.Image, 120) || '?'}). Nothing changed.`);
  if (Object.keys(cfg.Labels || {}).some((k) => k.startsWith('com.docker.compose.')))
    throw new Error(`Docker Compose runs ${name}: update it there. Set its image to ${DOCKER_IMAGE}:<version>, then docker compose up -d. Nothing changed.`);

  const imageEnv = new Set(listOf(ic.Env));
  const env = listOf(cfg.Env).filter((e) => !imageEnv.has(e));
  if (env.some((e) => !/^[A-Za-z_][A-Za-z0-9_.-]*=/.test(e) || /[\r\n\0]/.test(e)))
    throw new Error(`One of ${name}'s variables has a name or a value (a line break) that can't be passed on safely: update it by hand.`);
  const labels = Object.entries(cfg.Labels || {}).filter(([k, v]) => ic.Labels?.[k] !== v).map(([k, v]) => `${k}=${v}`);
  if (labels.some((l) => !/^[^\s=#][^\s=]*=/.test(l) || /[\r\n\0]/.test(l))) throw new Error(`One of ${name}'s labels can't be passed on safely: update it by hand.`);
  const all = Object.fromEntries(listOf(cfg.Env).map(splitVar));
  const cmd = sameJson(cfg.Cmd, ic.Cmd) ? [] : listOf(cfg.Cmd).map(String);
  if (argOf(cmd, '--key') !== undefined || argOf(cmd, '--admin-key') !== undefined)
    throw new Error(`${name} has a key in its arguments (--key or --admin-key), where anyone on that machine can read it. Give it as a variable instead (SPHERE_KEY, SPHERE_ADMIN_KEY in an --env-file), then update.`);

  const network = hc.NetworkMode || 'default';
  const log = hc.LogConfig || {};
  const odd = [
    !sameJson(cfg.Entrypoint, ic.Entrypoint) && 'its entrypoint',
    (cfg.WorkingDir || '') !== (ic.WorkingDir || '') && 'its working folder',
    !sameJson(cfg.Healthcheck, ic.Healthcheck) && 'its health check',
    hc.Privileged && 'privileged',
    listOf(hc.Devices).length && 'devices',
    (hc.PidMode || hc.UTSMode || hc.UsernsMode || !['', 'private', 'shareable'].includes(hc.IpcMode || '')) && 'a pid, ipc, uts or user namespace mode',
    (listOf(hc.Links).length || listOf(hc.VolumesFrom).length) && 'links or volumes from another container',
    (listOf(hc.Dns).length || listOf(hc.DnsSearch).length || listOf(hc.DnsOptions).length) && 'DNS settings',
    Object.keys(hc.Tmpfs || {}).length && 'tmpfs',
    Object.keys(hc.Sysctls || {}).length && 'sysctls',
    // inspect shows a seccomp profile's contents, which docker run would read as a file name
    listOf(hc.SecurityOpt).some((x) => /^seccomp[=:]/.test(x) && !/^seccomp[=:]unconfined$/.test(x)) && 'a seccomp profile',
    listOf(hc.GroupAdd).length && 'extra groups',
    (hc.CpuShares > 0 || hc.CpuQuota > 0 || hc.CpuPeriod > 0 || hc.CpusetCpus || hc.MemoryReservation > 0 || hc.PidsLimit > 0) && 'CPU shares, a pids limit or a memory reservation',
    Object.keys(c.NetworkSettings?.Networks || {}).length > 1 && 'more than one network',
    /^container:/.test(network) && "another container's network",
    log.Type && !DOCKER_LOGS.has(log.Type) && `the ${log.Type} log driver`,
  ].filter(Boolean);
  if (odd.length) throw new Error(`${name} has settings this can't carry over: ${odd.join(', ')}. Nothing changed. Update it by hand: docker pull the new image, then run it again the same way.`);

  const args = [];
  const kept = [];
  const rp = hc.RestartPolicy || {};
  if (rp.Name && rp.Name !== 'no') args.push('--restart', rp.Name === 'on-failure' && rp.MaximumRetryCount > 0 ? `on-failure:${rp.MaximumRetryCount}` : rp.Name);
  if (!['default', 'bridge'].includes(network)) args.push('--network', network);
  const ports = [];
  if (network !== 'host')
    for (const [to, list] of Object.entries(hc.PortBindings || {}))
      for (const b of list || []) {
        const ip = b.HostIp ? (b.HostIp.includes(':') ? `[${b.HostIp}]` : b.HostIp) : '';
        ports.push(ip ? `${ip}:${b.HostPort || ''}:${to}` : b.HostPort ? `${b.HostPort}:${to}` : to);
      }
  for (const p of ports) args.push('-p', p);
  if (hc.PublishAllPorts) args.push('-P');
  const mounts = [];
  for (const m of c.Mounts || []) {
    const from = m.Type === 'volume' ? m.Name : m.Type === 'bind' ? m.Source : null;
    if (!from || !m.Destination || /[:,\n]/.test(from + m.Destination)) throw new Error(`${name} has a ${m.Type || 'kind of'} mount this can't carry over: update it by hand.`);
    args.push('-v', `${from}:${m.Destination}${m.RW === false ? ':ro' : ''}`);
    mounts.push(`${m.Type} ${from} at ${m.Destination}`);
  }
  // the rest, as it was: who it runs as, its limits, what it may do, its logs
  const flag = (f, v, what) => {
    args.push(f, ...(v === undefined ? [] : [String(v)]));
    if (what) kept.push(what);
  };
  if (cfg.User && cfg.User !== (ic.User || '')) flag('--user', cfg.User, `user ${cfg.User}`);
  if (cfg.Hostname && c.Id && !c.Id.startsWith(cfg.Hostname)) flag('--hostname', cfg.Hostname, `host name ${cfg.Hostname}`);
  if (hc.ReadonlyRootfs) flag('--read-only', undefined, 'read-only');
  if (hc.Init) flag('--init', undefined, 'init');
  for (const x of listOf(hc.CapAdd)) flag('--cap-add', x, `cap-add ${x}`);
  for (const x of listOf(hc.CapDrop)) flag('--cap-drop', x, `cap-drop ${x}`);
  for (const x of listOf(hc.SecurityOpt)) flag('--security-opt', x, x);
  for (const x of listOf(hc.ExtraHosts)) flag('--add-host', x, `host ${x}`);
  for (const u of listOf(hc.Ulimits)) flag('--ulimit', `${u.Name}=${u.Soft}:${u.Hard}`);
  if (hc.Memory > 0) flag('--memory', hc.Memory, 'a memory limit');
  if (hc.Memory > 0 && hc.MemorySwap) flag('--memory-swap', hc.MemorySwap);
  if (hc.NanoCpus > 0) flag('--cpus', hc.NanoCpus / 1e9, `${hc.NanoCpus / 1e9} CPUs`);
  if (hc.Runtime && hc.Runtime !== 'runc') flag('--runtime', hc.Runtime, `runtime ${hc.Runtime}`);
  if (log.Type) flag('--log-driver', log.Type);
  for (const [k, v] of Object.entries(log.Config || {})) flag('--log-opt', `${k}=${v}`);

  // its members and history: a new container must find them, unless they're in Redis
  const data = argOf(cmd, '--data') || all.SPHERE_DATA || '/data';
  const store = argOf(cmd, '--store') || all.SPHERE_STORE || 'fs';
  const under = (d) => (c.Mounts || []).some((m) => m.Destination && (d === m.Destination || d.startsWith(m.Destination.replace(/\/?$/, '/'))));
  if (store !== 'redis' && !under(data))
    throw new Error(`${name} keeps its data inside the container (no volume at ${data}), so a new container would start empty. Copy it out first (docker cp ${name}:${data} ./sphere-data), then run it again with a volume (-v obysphere-data:${data}).`);
  // --rm: Docker removes it when it stops, with any volume it made for it, so it couldn't come back
  if (hc.AutoRemove)
    throw new Error(`${name} runs with --rm: stopping it would remove it, and any volume Docker made for it, so it couldn't come back if the new one fails. Nothing changed. Copy its data out first (docker cp ${name}:${data} ./sphere-data), then run it again without --rm, with a named volume (-v obysphere-data:${data}).`);

  // where it answers: its published port, on this machine
  const port = `${argOf(cmd, '--port') || all.PORT || '8080'}/tcp`;
  const b = (hc.PortBindings?.[port] || []).find((x) => x.HostPort);
  const host = (ip) => (!ip || ip === '0.0.0.0' ? '127.0.0.1' : ip === '::' ? '[::1]' : ip.includes(':') ? `[${ip}]` : ip);
  const url = network === 'host' ? `http://127.0.0.1:${parseInt(port, 10)}` : b ? `http://${host(b.HostIp)}:${b.HostPort}` : '';

  const summary = [
    ports.length && `${ports.length > 1 ? 'ports' : 'port'} ${ports.join(', ')}`,
    ...mounts,
    env.length && `${env.length} ${env.length > 1 ? 'variables' : 'variable'} (not shown)`,
    labels.length && `${labels.length} ${labels.length > 1 ? 'labels' : 'label'}`,
    rp.Name && rp.Name !== 'no' && `restart ${rp.Name}`,
    !['default', 'bridge'].includes(network) && `network ${network}`,
    cmd.length && 'its arguments',
    ...kept,
  ].filter(Boolean);
  const secrets = [...env.map((e) => splitVar(e)[1]), ...labels.map((l) => splitVar(l)[1])];
  return { args, cmd, env, labels, secrets, url, kept: summary.join(', ') || 'nothing else' };
}

// docker run, with the variables and labels in files only you can read, in a folder of its own,
// removed at once
async function dockerRun(container, plan, ref) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obysphere-docker-'));
  try {
    const args = ['run', '-d', '--name', container, ...plan.args];
    for (const [what, lines, f] of [['env', plan.env, '--env-file'], ['labels', plan.labels, '--label-file']]) {
      if (!lines.length) continue;
      const file = path.join(dir, what);
      fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
      args.push(f, file);
    }
    await docker([...args, ref, ...plan.cmd], plan.secrets);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// the new container runs (and answers, when its address answered before)
async function dockerWait(container, url, byUrl, secrets) {
  const t0 = Date.now();
  for (;;) {
    const st = (await dockerInspect('container', container, secrets)).State || {};
    if (st.Restarting || (st.Status && !['created', 'running'].includes(st.Status))) throw new Error(`The new container stopped${st.ExitCode ? ` (exit code ${st.ExitCode})` : ''}.`);
    if (st.Running && (byUrl ? (await relayHealth(url)).ok : Date.now() - t0 >= 5000)) return;
    if (Date.now() - t0 > DOCKER_WAIT_MS) throw new Error(byUrl ? `The new container didn't answer at ${url}/healthz within a minute.` : "The new container didn't start within a minute.");
    await sleep(1000);
  }
}

async function dockerServerUpdate(container, rec = null) {
  const usage = 'usage: obysphere server update --docker <container> [--url <its address>] [--tag <version>]';
  if (typeof container !== 'string' || !DOCKER_NAME.test(container)) die(usage);
  // an address, with no name, password, query or fragment in it
  const plainUrl = (u) => {
    try {
      const x = new URL(u);
      return /^https?:$/.test(x.protocol) && !/\s/.test(u) && !x.username && !x.password && !x.search && !x.hash && !u.includes('@');
    } catch {
      return false;
    }
  };
  if (opt.url !== undefined && (typeof opt.url !== 'string' || !plainUrl(opt.url))) die(`${usage}\n  (--url: the Sphere's address, like https://sphere.example.com)`);
  const tag = typeof opt.tag === 'string' ? opt.tag.replace(/^v/, '') : opt.tag;
  if (tag !== undefined && (typeof tag !== 'string' || !VER.test(tag) || tag.includes('+'))) die(`${usage}\n  (--tag: a released version, like 0.4.0)`);
  const name = rec?.name || container.toLowerCase();
  const recFile = path.join(serversDir(), `${name}.json`);
  const before = rec || readJson(recFile, null);
  if (before && (before.provider !== 'docker' || before.container !== container))
    die(`${name} is already recorded here for ${before.provider === 'docker' ? `the container ${before.container}` : before.provider || 'another Sphere'}: rename this container (docker rename) to record it too.`);
  const image = DOCKER_REPO.test(before?.image || '') ? before.image : DOCKER_IMAGE;
  const installed = String(readJson(path.join(appSource(), 'package.json'), {}).version || VERSION);
  const version = tag || installed;
  const ref = `${image}:${version}`;
  const previous = `${container}-previous`;

  const c = await dockerInspect('container', container).catch((e) => die(`${e.message}\nIs ${container} the container's name? docker ps -a lists them.`));
  // docker also finds a container by its ID, but the new one takes the name given here
  const named = String(c.Name || '').replace(/^\//, '');
  if (named && named !== container) die(`${container} is the ID of the container ${named}. Name it, so it keeps its name: obysphere server update --docker ${named}. Nothing changed.`);
  const old = await dockerInspect('image', String(c.Image || ''));
  let plan;
  try {
    plan = dockerPlan(container, c, old);
  } catch (e) {
    die(e.message);
  }
  const was = [old.Config?.Labels?.['org.opencontainers.image.version'], /:([^/:@]+)$/.exec(c.Config?.Image || '')?.[1]].find((v) => v && VER.test(v)) || null;
  if (!tag && was && cmpVersion(was, version) > 0) die(`${container} runs ${was}, newer than your ${version}. Update the CLI first (obysphere update), or go back to ${version} on purpose: --tag ${version}.`);
  if (await dockerInspect('container', previous).then(() => true, () => false))
    die(`${previous} is still there from an earlier update. Nothing changed. Remove it (docker rm ${previous}), or bring it back (docker rm -f ${container}, then docker rename ${previous} ${container}), and run this again.`);
  const url = trimSlash(opt.url || before?.url || plan.url || '');
  const record = (v, at) =>
    writeSecret(recFile, { name, provider: 'docker', container, image, url, version: v, deployedAt: at, firstDeployedAt: before?.firstDeployedAt || before?.deployedAt || at });

  say(`${dim('·')} pulling ${ref}…`);
  try {
    await docker(['pull', '--quiet', ref]);
  } catch (e) {
    die(`Couldn't pull ${ref}. Each release publishes its image: is ${version} released? Update the CLI first (obysphere update), or name a version: --tag <version>. Nothing changed.\n${e.message}`);
  }
  const next = await dockerInspect('image', ref);
  if (next.Id && next.Id === c.Image) {
    record(version, before?.deployedAt || new Date().toISOString());
    say(`${green('✓')} ${bold(container)} already runs ${ref}: nothing to do.`);
    if (!before) say(dim(`  Recorded as ${name}: obysphere server update and server status find it from now on.`));
    return;
  }

  const answered = url ? (await relayHealth(url)).ok : false;
  say(`${dim('·')} ${container} runs ${was || clean(c.Config?.Image, 120) || 'an older image'}; it keeps ${plan.kept}`);
  try {
    await docker(['rename', container, previous]);
  } catch (e) {
    die(`${e.message}\nNothing changed.`);
  }
  try {
    if (c.State?.Running) await docker(['stop', previous]);
  } catch (e) {
    await docker(['rename', previous, container]).catch(() => {});
    die(`${e.message}\nNothing changed.`);
  }
  try {
    await dockerRun(container, plan, ref);
    await dockerWait(container, url, answered, plan.secrets);
  } catch (e) {
    const logs = await docker(['logs', '--tail', '20', container]).catch(() => null);
    await docker(['rm', '-f', container]).catch(() => {});
    let back = false;
    let renamed = false;
    let why = '';
    try {
      await docker(['rename', previous, container]);
      renamed = true;
      if (c.State?.Running) await docker(['start', container]);
      back = true;
    } catch (err) {
      why = hide(err.message, plan.secrets);
    }
    warn(`${red('✗')} ${hide(e.message, plan.secrets)}`);
    const said = logs && clean(hide(`${logs.stdout}\n${logs.stderr}`, plan.secrets), 3000, true);
    if (said) warn(dim(`  Its log:\n${indentText(said)}`));
    if (why) warn(dim(`  ${why}`));
    die(
      back
        ? `${container} is back on ${was || 'the image it had'}, as before.`
        : renamed // the old one has its name again, but didn't start
          ? `The old container is ${container} again, on ${was || 'the image it had'}, but it didn't start. Start it: docker start ${container}.`
          : `Couldn't bring the old container back: it's ${previous}, stopped. docker rename ${previous} ${container}, then docker start ${container}.`
    );
  }
  await docker(['rm', previous]).catch(() => warn(`${yellow('!')} the old container is still there, stopped: docker rm ${previous}`));
  record(version, new Date().toISOString());
  const h = url ? await relayHealth(url) : { ok: false };
  say(`\n${green('✓')} ${bold(container)} runs ${cyan(ref)}${c.State?.Running ? '' : ' (it was stopped; now it runs)'}`);
  if (h.ok) say(`  It answers: relay ${h.version || '?'}, ${h.store || '?'} store${h.sealed ? ', sealed' : ''}.`);
  else say(url ? `  It doesn't answer at ${url}/healthz yet: give it a moment, then obysphere server status ${name}.` : `  Give its address once, so status can check it: obysphere server update ${name} --url https://<its address>`);
  if (!before) say(dim(`  Recorded as ${name}: obysphere server update and server status find it from now on.`));
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

// a program on your PATH, as doctor shows it (on Windows a .cmd too); null when it isn't there
function which(bin) {
  return programPath(bin, { exts: process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : undefined }); // node.exe, as the file is named
}

// A program by its name, as a full path from your PATH's full folders: never the folder this runs
// in (where Windows looks first), nor an empty, `.` or other relative PATH entry, which name a folder
// relative to wherever a program runs (a shared repository, the temp folder). On Windows,
// name.com or name.exe, as Windows runs them. A full path is taken as it is, a relative one never.
// null when it's nowhere. (rep.mjs has the same.)
function programPath(name, { env = process.env, platform = process.platform, exts, isFile = isProgram } = {}) {
  const win = platform === 'win32';
  const full = (d) => (win ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(d) : d.startsWith('/'));
  const n = String(name || '');
  if (full(n)) return n;
  if (!n || /[\\/]/.test(n)) return null;
  const ends = exts || (win ? (/\.(com|exe)$/i.test(n) ? [''] : ['.com', '.exe']) : ['']);
  for (const entry of String(env.PATH ?? env.Path ?? '').split(win ? ';' : ':')) {
    const dir = win ? entry.replace(/^"(.*)"$/, '$1') : entry;
    if (!full(dir)) continue;
    for (const e of ends) {
      const f = (win ? path.win32 : path.posix).join(dir, n + e);
      if (isFile(f)) return f;
    }
  }
  return null;
}
function isProgram(f) {
  try {
    if (!fs.statSync(f).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(f, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// PATH with its full folders only, in their order: an empty, `.` or other relative entry names a
// folder relative to wherever a program runs. (rep.mjs has the same.)
function fullPath(value, platform = process.platform) {
  const win = platform === 'win32';
  const full = (d) => (win ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(d.replace(/^"(.*)"$/, '$1')) : d.startsWith('/'));
  return String(value || '').split(win ? ';' : ':').filter(full).join(win ? ';' : ':');
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
// a profile name: cut first (a name is 32 characters), then trimmed of its dashes in one pass
function slug(s) {
  const t = String(s || '').slice(0, 256).toLowerCase().replace(/^[@#]/, '').replace(/[^a-z0-9-]+/g, '-');
  let [a, b] = [0, t.length];
  while (a < b && t[a] === '-') a++;
  while (b > a && t[b - 1] === '-') b--;
  return t.slice(a, b).slice(0, 32);
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

const OWN = { start, stop, restart, status, logs, open: openCmd, profiles, menubar, update, version, doctor, server, help, 'service-run': serviceRun };
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
