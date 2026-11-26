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

// The variables the plugin reads, each by name. It never reads, copies or passes on the whole
// environment: the plugin directory reads that as a credential that could leave the machine.
const named = () => ({
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  PATH: process.env.PATH,
  Path: process.env.Path,
  PATHEXT: process.env.PATHEXT,
  OBYSPHERE_APP_HOME: process.env.OBYSPHERE_APP_HOME,
  OBYSPHERE_HOME: process.env.OBYSPHERE_HOME,
  OBYSPHERE_PROFILE: process.env.OBYSPHERE_PROFILE,
});

// the home folder, from the environment given (so a test's HOME is the one used)
const homeDir = (vars) => (process.platform === 'win32' ? vars.USERPROFILE : vars.HOME) || os.homedir();

// a command on PATH, as the shell would find it
export function which(name, vars = named()) {
  const dirs = String(vars.PATH || vars.Path || '').split(path.delimiter).filter(Boolean);
  const win = process.platform === 'win32';
  const exts = win ? String(vars.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
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
export function appHomes(vars = named()) {
  const homes = [];
  if (vars.OBYSPHERE_APP_HOME) homes.push(path.resolve(vars.OBYSPHERE_APP_HOME));
  homes.push(path.join(homeDir(vars), '.local', 'share', 'obysphere'));
  return [...new Set(homes)];
}

// The installed CLI:
//   { rep, bin }  its rep.mjs is known: run it with this Node
//   { rep: null, bin }  only the `obysphere` command is known: run that
//   null  not installed
export function findCli(vars = named()) {
  const bin = which('obysphere', vars);
  if (bin) {
    // a symlink into an install, or an npm bin: rep.mjs sits beside the real file
    const beside = path.join(path.dirname(realpath(bin)), 'rep.mjs');
    if (isFile(beside)) return { rep: beside, bin };
  }
  for (const home of appHomes(vars)) {
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
export function profileHomes(vars = named()) {
  if (vars.OBYSPHERE_HOME) return [path.resolve(vars.OBYSPHERE_HOME)];
  return [path.join(homeDir(vars), '.obysphere'), path.join(homeDir(vars), '.obysphere-mvp')];
}

// the profiles in the first of those folders that holds any (a folder with a profile.json)
export function profiles(vars = named()) {
  for (const dir of profileHomes(vars)) {
    try {
      const names = fs.readdirSync(dir).filter((d) => isFile(path.join(dir, d, 'profile.json')));
      if (names.length) return names.sort();
    } catch {}
  }
  return [];
}

// has this computer joined a Sphere?
export const hasProfile = (vars = named()) => profiles(vars).length > 0;

// a profile name as rep.mjs reads it (its slug())
const slug = (s) => String(s || '').toLowerCase().replace(/^[@#]/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

// the profile named by --profile (or --profile=) in these arguments, else by OBYSPHERE_PROFILE;
// undefined when neither names one
export function chosenProfile(args = [], vars = named()) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--profile') return String(args[i + 1] ?? '');
    if (String(args[i]).startsWith('--profile=')) return String(args[i]).slice('--profile='.length);
  }
  return vars.OBYSPHERE_PROFILE || undefined;
}

// the default profile, chosen with `obysphere profiles use <name>`: the name in .default-profile in
// the folder that holds the profiles, when it names one of them; else null
export function defaultProfile(vars = named()) {
  for (const dir of profileHomes(vars)) {
    const names = profiles({ OBYSPHERE_HOME: dir });
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
export function profileUnclear(args = [], vars = named()) {
  if (chosenProfile(args, vars) !== undefined) return false;
  if (defaultProfile(vars)) return false;
  return profiles(vars).length > 1;
}

// a profile is named, but this computer has none by that name: the CLI would stop with "no profile"
export function profileMissing(args = [], vars = named()) {
  const name = chosenProfile(args, vars);
  if (name === undefined || !hasProfile(vars)) return false;
  return !profiles(vars).includes(slug(name));
}

// how to run the CLI with these arguments
export function cliCommand(cli, args) {
  if (cli.rep) return { cmd: process.execPath, args: [cli.rep, ...args], shell: false };
  // Node refuses to spawn a .cmd or .bat without a shell (Windows)
  const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli.bin);
  return { cmd: viaShell ? `"${cli.bin}"` : cli.bin, args, shell: viaShell };
}
