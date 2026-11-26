// Finds the obysphere CLI on this computer, for the plugin's MCP server and its
// SessionStart hook. It only looks: at PATH and a few folders. It runs nothing and
// reads no profile's contents (only whether a profile.json exists).
//
// No dependencies, and nothing newer than Node 18, so on an older Node it can still
// say "Obysphere needs Node 22".

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NODE_MIN = 22;
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const realpath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

export const nodeMajor = () => Number(String(process.versions.node).split('.')[0]) || 0;

// the home folder, from the environment given (so a test's HOME is the one used)
const homeDir = (env) => (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();

// a command on PATH, as the shell would find it
export function which(name, env = process.env) {
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const win = process.platform === 'win32';
  const exts = win ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (!isFile(p)) continue;
      if (!win) {
        try {
          fs.accessSync(p, fs.constants.X_OK);
        } catch {
          continue;
        }
      }
      return p;
    }
  }
  return null;
}

// where install.sh puts versions and `current`: $OBYSPHERE_APP_HOME, then ~/.local/share/obysphere
export function appHomes(env = process.env) {
  const homes = [];
  if (env.OBYSPHERE_APP_HOME) homes.push(path.resolve(env.OBYSPHERE_APP_HOME));
  homes.push(path.join(homeDir(env), '.local', 'share', 'obysphere'));
  return [...new Set(homes)];
}

// The installed CLI:
//   { rep, bin }  its rep.mjs is known: run it with this Node
//   { rep: null, bin }  only the `obysphere` command is known: run that
//   null  not installed
export function findCli(env = process.env) {
  const bin = which('obysphere', env);
  if (bin) {
    // a symlink into an install, or an npm bin: rep.mjs sits beside the real file
    const beside = path.join(path.dirname(realpath(bin)), 'rep.mjs');
    if (isFile(beside)) return { rep: beside, bin };
  }
  for (const home of appHomes(env)) {
    const rep = path.join(home, 'current', 'rep.mjs');
    if (isFile(rep)) return { rep, bin };
  }
  if (bin) {
    // a shim in <prefix>/bin for an install in <prefix>/share/obysphere
    const shared = path.resolve(path.dirname(bin), '..', 'share', 'obysphere', 'current', 'rep.mjs');
    if (isFile(shared)) return { rep: shared, bin };
    return { rep: null, bin };
  }
  return null;
}

// where profiles may be: $OBYSPHERE_HOME, else both ~/.obysphere and ~/.obysphere-mvp
export function profileHomes(env = process.env) {
  if (env.OBYSPHERE_HOME) return [path.resolve(env.OBYSPHERE_HOME)];
  return [path.join(homeDir(env), '.obysphere'), path.join(homeDir(env), '.obysphere-mvp')];
}

// the profiles in the first of those folders that holds any (a folder with a profile.json)
export function profiles(env = process.env) {
  for (const dir of profileHomes(env)) {
    try {
      const names = fs.readdirSync(dir).filter((d) => isFile(path.join(dir, d, 'profile.json')));
      if (names.length) return names.sort();
    } catch {}
  }
  return [];
}

// has this computer joined a Sphere?
export const hasProfile = (env = process.env) => profiles(env).length > 0;

// a profile name as rep.mjs reads it (its slug())
const slug = (s) => String(s || '').toLowerCase().replace(/^[@#]/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

// the profile named by --profile (or --profile=) in these arguments, else by OBYSPHERE_PROFILE;
// undefined when neither names one
export function chosenProfile(args = [], env = process.env) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--profile') return String(args[i + 1] ?? '');
    if (String(args[i]).startsWith('--profile=')) return String(args[i]).slice('--profile='.length);
  }
  return env.OBYSPHERE_PROFILE || undefined;
}

// the default profile, chosen with `obysphere profiles use <name>`: the name in .default-profile in
// the folder that holds the profiles, when it names one of them; else null
export function defaultProfile(env = process.env) {
  for (const dir of profileHomes(env)) {
    const names = profiles({ ...env, OBYSPHERE_HOME: dir });
    if (!names.length) continue;
    try {
      const n = slug(fs.readFileSync(path.join(dir, '.default-profile'), 'utf8').trim());
      return names.includes(n) ? n : null;
    } catch {
      return null;
    }
  }
  return null;
}

// several profiles, and nothing says which one (no --profile, OBYSPHERE_PROFILE or default):
// the CLI would stop and ask
export function profileUnclear(args = [], env = process.env) {
  if (chosenProfile(args, env) !== undefined) return false;
  if (defaultProfile(env)) return false;
  return profiles(env).length > 1;
}

// a profile is named, but this computer has none by that name: the CLI would stop with "no profile"
export function profileMissing(args = [], env = process.env) {
  const name = chosenProfile(args, env);
  if (name === undefined || !hasProfile(env)) return false;
  return !profiles(env).includes(slug(name));
}

// how to run the CLI with these arguments
export function cliCommand(cli, args) {
  if (cli.rep) return { cmd: process.execPath, args: [cli.rep, ...args], shell: false };
  // Node refuses to spawn a .cmd or .bat without a shell (Windows)
  const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli.bin);
  return { cmd: viaShell ? `"${cli.bin}"` : cli.bin, args, shell: viaShell };
}
