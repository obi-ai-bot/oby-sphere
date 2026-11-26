// A fake `schtasks` for the Windows service tests, on any system: no Task Scheduler.
// Each run records its arguments (and the names of its environment) to calls.jsonl beside it
// and keeps the tasks it was given in tasks.json:
//   /create /tn <name> /xml <file> [/f]   reads the task's XML, which must be UTF-16 with its byte
//                                         order mark, as schtasks wants it; /f replaces one
//   /run /tn <name>                       starts what the task's action does, as Windows would:
//                                         wscript.exe, emulated (below); not again while it runs
//   /end /tn <name>                       kills that wscript.exe (the programs it started live on,
//                                         as they do on Windows)
//   /delete /tn <name> /f, /query /tn <name>
// The wscript.exe it emulates reads the JScript file the task names, takes the string in
// shell.Run("…", 0, true), puts variables' values in place of %NAME% as WshShell.Run does, splits
// it with Windows' rules (the program up to its closing quote, then the C runtime's), runs that,
// waits, and ends with its exit code (WScript.Quit). Each run is recorded to runs.jsonl, with
// whether the file is plain ASCII (Windows Script Host reads it in the system's code page); what
// the program writes goes to wscript-<pid>.log beside it.
// control.json beside it: { "fail": { "create": "ERROR: Access is denied." } } makes that
// operation fail with those words.
// On Windows a script can't be schtasks.exe, so there it's a copy of node.exe named
// schtasks.exe that runs the fake through NODE_OPTIONS=--require (`env` has it).
import fs from 'node:fs';
import path from 'node:path';

const SCHTASKS = `'use strict';
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const here = __dirname;
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(here, f), 'utf8')); } catch { return d; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// written and ended at once: on Windows, node would go on to load its first argument as a script
const out = (s, code = 0) => { fs.writeSync(code ? 2 : 1, s + '\\n'); process.exit(code); };
const text = (xml, tag) => {
  const m = new RegExp('<' + tag + '>([^<]*)</' + tag + '>').exec(xml);
  return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&') : null;
};
function main(argv) {
  fs.appendFileSync(path.join(here, 'calls.jsonl'), JSON.stringify({ argv, envKeys: Object.keys(process.env).sort() }) + '\\n');
  const control = read('control.json', {});
  const tasks = read('tasks.json', {});
  const save = () => fs.writeFileSync(path.join(here, 'tasks.json'), JSON.stringify(tasks, null, 2));
  const has = (f) => argv.some((a) => a.toLowerCase() === f);
  const flag = (f) => { const i = argv.findIndex((a) => a.toLowerCase() === f); return i >= 0 ? argv[i + 1] : undefined; };
  const op = String(argv[0] || '').toLowerCase().replace(/^\\//, '');
  const name = flag('/tn');
  if (control.fail && control.fail[op]) return out(control.fail[op], 1);
  if (!name) return out('ERROR: Invalid syntax.', 1);
  const t = tasks[name];
  if (op === 'create') {
    const buf = fs.readFileSync(flag('/xml'));
    if (buf[0] !== 0xff || buf[1] !== 0xfe) return out('ERROR: The task XML is malformed: not UTF-16 with a byte order mark.', 1);
    const xml = buf.subarray(2).toString('utf16le');
    if (!xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>')) return out('ERROR: The task XML is malformed.', 1);
    if (t && !has('/f')) return out('ERROR: Cannot create a file when that file already exists.', 1);
    tasks[name] = { xml, pid: t ? t.pid : null };
    save();
    return out('SUCCESS: The scheduled task "' + name + '" has successfully been created.');
  }
  if (!t) return out('ERROR: The system cannot find the file specified.', 1);
  if (op === 'run') {
    if (t.pid && alive(t.pid)) return out('SUCCESS: Attempted to run the scheduled task "' + name + '".');
    const command = text(t.xml, 'Command');
    if (!/\\\\wscript\\.exe$/i.test(command || '')) return out('ERROR: this fake runs only wscript.exe', 1);
    const child = spawn(read('config.json', {}).node, [path.join(here, 'fake-wscript.cjs'), text(t.xml, 'Arguments')], { cwd: text(t.xml, 'WorkingDirectory'), detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    t.pid = child.pid;
    save();
    return out('SUCCESS: Attempted to run the scheduled task "' + name + '".');
  }
  if (op === 'end') {
    if (!t.pid || !alive(t.pid)) return out('ERROR: The task is not running.', 1);
    process.kill(t.pid, 'SIGKILL');
    t.pid = null;
    save();
    return out('SUCCESS: The scheduled task "' + name + '" has been terminated successfully.');
  }
  if (op === 'delete') {
    if (!has('/f')) return out('ERROR: this fake deletes only with /f', 1);
    delete tasks[name];
    save();
    return out('SUCCESS: The scheduled task "' + name + '" was successfully deleted.');
  }
  if (op === 'query') return out('TaskName  Status\\n' + name + '  ' + (t.pid && alive(t.pid) ? 'Running' : 'Ready'));
  out('ERROR: Invalid argument/option - ' + argv[0], 1);
}
module.exports = { main };
// on Windows: node.exe copied to schtasks.exe, with this file from NODE_OPTIONS; node took the
// first argument (/create) for its script and made it absolute (C:\\create)
if (path.basename(process.execPath).toLowerCase() === 'schtasks.exe') main([String(process.argv[1] || '').replace(/^[A-Za-z]:\\\\/, '/'), ...process.argv.slice(2)]);
`;

const WSCRIPT = `'use strict';
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const here = __dirname;
${splitWin.toString()}
// %NAME% becomes the variable's value, in any case, as ExpandEnvironmentStrings does; else it stays
const env = {};
for (const [k, v] of Object.entries(process.env)) env[k.toUpperCase()] = v;
const expand = (s) => s.replace(/%([^%]+)%/g, (m, n) => (env[n.toUpperCase()] !== undefined ? env[n.toUpperCase()] : m));
const words = splitWin('wscript.exe ' + process.argv[2]).slice(1);
const script = words[words.length - 1];
const src = fs.readFileSync(script, 'latin1');
// the string literal after .Run(
let i = src.indexOf('.Run(') + 5;
let lit = '';
if (src[i] === '"') {
  lit += src[i++];
  while (i < src.length && src[i] !== '"') { if (src[i] === '\\\\') lit += src[i++]; lit += src[i++]; }
  lit += src[i++];
}
const after = src.slice(i, i + 10);
let command = null;
try { command = expand(JSON.parse(lit)); } catch {}
const argv = command === null ? null : splitWin(command);
fs.appendFileSync(path.join(here, 'runs.jsonl'), JSON.stringify({ pid: process.pid, flags: words.slice(0, -1), script, ascii: /^[\\x00-\\x7f]*$/.test(src), after, command, argv, cwd: process.cwd() }) + '\\n');
if (!argv || after !== ', 0, true)') process.exit(97);
const log = fs.openSync(path.join(here, 'wscript-' + process.pid + '.log'), 'a');
const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', log, log] });
child.on('error', () => process.exit(1));
child.on('exit', (code) => process.exit(code === null ? 1 : code));
`;

// a Windows command line, split as Windows programs do: the program up to its closing quote, or the
// first space (CommandLineToArgvW); then the C runtime's rules (2n backslashes and a quote: n and a
// toggle; 2n+1 and a quote: n and a quote; "" inside quotes: a quote; other backslashes as they are)
export function splitWin(cmd) {
  const out = [];
  let i = 0;
  while (cmd[i] === ' ' || cmd[i] === '\t') i++;
  let first = '';
  if (cmd[i] === '"') {
    i++;
    while (i < cmd.length && cmd[i] !== '"') first += cmd[i++];
    i++;
  } else while (i < cmd.length && cmd[i] !== ' ' && cmd[i] !== '\t') first += cmd[i++];
  out.push(first);
  for (;;) {
    while (cmd[i] === ' ' || cmd[i] === '\t') i++;
    if (i >= cmd.length) break;
    let arg = '';
    let quoted = false;
    while (i < cmd.length) {
      const ch = cmd[i];
      if (ch === '\\') {
        let n = 0;
        while (cmd[i] === '\\') {
          n++;
          i++;
        }
        if (cmd[i] === '"') {
          arg += '\\'.repeat(n >> 1);
          if (n % 2) {
            arg += '"';
            i++;
          }
        } else arg += '\\'.repeat(n);
      } else if (ch === '"') {
        if (quoted && cmd[i + 1] === '"') {
          arg += '"';
          i += 2;
        } else {
          quoted = !quoted;
          i++;
        }
      } else if (!quoted && (ch === ' ' || ch === '\t')) break;
      else {
        arg += ch;
        i++;
      }
    }
    out.push(arg);
  }
  return out;
}

// writes the fake into dir (its own folder, put first on PATH); `env` holds what else the
// environment needs (NODE_OPTIONS, on Windows)
export function makeFakeSchtasks(dir, node = process.execPath) {
  fs.mkdirSync(dir, { recursive: true });
  const cjs = path.join(dir, 'fake-schtasks.cjs');
  fs.writeFileSync(cjs, SCHTASKS);
  fs.writeFileSync(path.join(dir, 'fake-wscript.cjs'), WSCRIPT);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ node }));
  let env = {};
  if (process.platform === 'win32') {
    fs.copyFileSync(node, path.join(dir, 'schtasks.exe'));
    // NODE_OPTIONS reads a backslash in quotes as an escape: forward slashes
    env = { NODE_OPTIONS: `--require "${cjs.replace(/\\/g, '/')}"` };
  } else fs.writeFileSync(path.join(dir, 'schtasks'), `#!${node}\nrequire(${JSON.stringify(cjs)}).main(process.argv.slice(2));\n`, { mode: 0o755 });
  const lines = (f) => {
    try {
      return fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const tasks = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8'));
    } catch {
      return {};
    }
  };
  return {
    dir,
    env,
    calls: () => lines('calls.jsonl'),
    runs: () => lines('runs.jsonl'),
    tasks,
    control: (o) => fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify(o)),
    // what a wscript.exe it started wrote (the supervisor's own errors land here)
    output: () =>
      fs
        .readdirSync(dir)
        .filter((f) => /^wscript-\d+\.log$/.test(f))
        .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
        .join(''),
    // every wscript.exe still running, ended (for a test's cleanup)
    endAll: () => {
      for (const t of Object.values(tasks()))
        if (t.pid)
          try {
            process.kill(t.pid, 'SIGKILL');
          } catch {}
    },
  };
}
