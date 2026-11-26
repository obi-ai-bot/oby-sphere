// Helpers for test/docker-image.test.mjs: no Docker, no network.
//   makeFakeDocker(dir, state)  a `docker` for the front of PATH. It keeps its containers and
//                               images in state.json and records each call to calls.jsonl: its
//                               argv, the Sphere variables in its environment (it must get none),
//                               and the --env-file and --label-file it was given (their lines and
//                               mode, read while they exist).
//                               state: { containers, images (by ref), registry (what pull finds),
//                               runExits (a new container stops at once), runEchoes (docker run
//                               fails and prints the variables it was given) }
//   settingsOf(container, image) what a container keeps across an update, to compare two
//   parseYaml(text)             a small reader for the YAML GitHub workflows use: block maps and
//                               lists, `|` blocks, [flow, lists], quoted and plain scalars. It
//                               throws on anything else (tabs, anchors, duplicate keys, bad indents).
import fs from 'node:fs';
import path from 'node:path';

const FAKE_DOCKER = `
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const here = __dirname, argv = process.argv.slice(2);
const stateFile = path.join(here, 'state.json');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const call = { argv, envKeys: Object.keys(process.env).filter((k) => /^SPHERE_|^OBYSPHERE_ADMIN_KEY$/.test(k)) };
const log = () => fs.appendFileSync(path.join(here, 'calls.jsonl'), JSON.stringify(call) + '\\n');
const fail = (msg, code = 1) => { log(); process.stderr.write(msg + '\\n'); process.exit(code); };
const ok = (out = '') => { log(); if (out) process.stdout.write(out + '\\n'); process.exit(0); };
const image = (ref) => state.images[ref] || Object.values(state.images).find((i) => i.Id === ref);
const container = (n) => state.containers[n] || fail('Error response from daemon: No such container: ' + n);
const running = () => ({ Status: 'running', Running: true, Restarting: false, ExitCode: 0 });
const readKv = (f) => {
  const lines = fs.readFileSync(f, 'utf8').split('\\n').filter(Boolean);
  return { path: f, lines, mode: fs.statSync(f).mode & 0o777 };
};
const [a, b] = argv;

// like docker, inspect finds a container by its name or by the start of its ID
const byId = (n) => (n && n.length >= 4 ? Object.values(state.containers).find((c) => c.Id.startsWith(n)) : undefined);
if (a === 'container' && b === 'inspect') ok(JSON.stringify([state.containers[argv[2]] || byId(argv[2]) || container(argv[2])], null, 2));
if (a === 'image' && b === 'inspect') { const i = image(argv[2]); if (!i) fail('Error response from daemon: No such image: ' + argv[2]); ok(JSON.stringify([i], null, 2)); }
if (a === 'pull') {
  const ref = argv[argv.length - 1];
  if (!state.registry[ref]) fail('Error response from daemon: manifest for ' + ref + ' not found: manifest unknown');
  state.images[ref] = state.registry[ref];
  save();
  ok(ref);
}
if (a === 'rename') {
  const c = container(argv[1]);
  if (state.containers[argv[2]]) fail('Error response from daemon: Conflict. The container name "/' + argv[2] + '" is already in use');
  delete state.containers[argv[1]];
  state.containers[argv[2]] = { ...c, Name: '/' + argv[2] };
  save();
  ok();
}
if (a === 'stop') { container(argv[1]).State = { Status: 'exited', Running: false, Restarting: false, ExitCode: 0 }; save(); ok(argv[1]); }
if (a === 'start') { container(argv[1]).State = running(); save(); ok(argv[1]); }
if (a === 'rm') {
  const n = argv[argv.length - 1];
  if (container(n).State.Running && !argv.includes('-f')) fail('Error response from daemon: cannot remove a running container');
  delete state.containers[n];
  save();
  ok(n);
}
if (a === 'logs') {
  // a careless server that prints its variables: the CLI must hide them
  const c = container(argv[argv.length - 1]);
  log();
  process.stdout.write('obysphere relay starting\\n');
  process.stderr.write('env: ' + c.Config.Env.join(' ') + '\\nfatal: something went wrong\\n');
  process.exit(0);
}
if (a === 'run') {
  const VALUE = new Set(['--name', '--restart', '--network', '--env-file', '--label-file', '--user', '--hostname', '--cap-add', '--cap-drop', '--security-opt', '--add-host', '--ulimit', '--memory', '--memory-swap', '--cpus', '--runtime', '--log-driver', '--log-opt', '-p', '-v']);
  const BOOL = new Set(['-d', '--read-only', '--init', '-P']);
  const o = {};
  let i = 1;
  for (; i < argv.length; i++) {
    const f = argv[i];
    if (BOOL.has(f)) o[f] = true;
    else if (VALUE.has(f)) (o[f] = o[f] || []).push(argv[++i]);
    else if (f.startsWith('-')) fail('unknown flag: ' + f, 125);
    else break;
  }
  const one = (f) => (o[f] || [])[0];
  const many = (f) => o[f] || [];
  const ref = argv[i];
  const cmd = argv.slice(i + 1);
  const envFile = one('--env-file') ? readKv(one('--env-file')) : null;
  const labelFile = one('--label-file') ? readKv(one('--label-file')) : null;
  call.envFile = envFile;
  call.labelFile = labelFile;
  if (state.runEchoes) fail('docker: invalid env file: ' + (envFile ? envFile.lines.join(' ') : ''), 125);
  const img = image(ref);
  if (!img) fail('Unable to find image ' + ref + ' locally', 125);
  const name = one('--name');
  if (state.containers[name]) fail('docker: Error response from daemon: Conflict. The container name "/' + name + '" is already in use.', 125);
  const lines = envFile ? envFile.lines : [];
  const names = new Set(lines.map((l) => l.split('=')[0]));
  const labels = { ...(img.Config.Labels || {}) };
  for (const l of labelFile ? labelFile.lines : []) labels[l.slice(0, l.indexOf('='))] = l.slice(l.indexOf('=') + 1);
  const ports = {};
  for (const spec of many('-p')) {
    const parts = spec.split(':');
    const to = parts.pop();
    const HostPort = parts.pop() || '';
    (ports[to] = ports[to] || []).push({ HostIp: parts.join(':').replace(/^\\[|\\]$/g, ''), HostPort });
  }
  const restart = (one('--restart') || 'no').split(':');
  const log = { Type: one('--log-driver') || 'json-file', Config: {} };
  for (const l of many('--log-opt')) log.Config[l.slice(0, l.indexOf('='))] = l.slice(l.indexOf('=') + 1);
  const id = crypto.randomBytes(32).toString('hex');
  state.containers[name] = {
    Id: id, Name: '/' + name, Image: img.Id,
    Config: {
      Image: ref, Hostname: one('--hostname') || id.slice(0, 12), User: one('--user') || img.Config.User || '',
      Env: [...img.Config.Env.filter((e) => !names.has(e.split('=')[0])), ...lines],
      Cmd: cmd.length ? cmd : img.Config.Cmd, Entrypoint: img.Config.Entrypoint, WorkingDir: img.Config.WorkingDir, Healthcheck: img.Config.Healthcheck, Labels: labels,
    },
    HostConfig: {
      PortBindings: ports, PublishAllPorts: !!o['-P'], NetworkMode: one('--network') || 'bridge',
      RestartPolicy: { Name: restart[0], MaximumRetryCount: Number(restart[1] || 0) },
      ReadonlyRootfs: !!o['--read-only'], Init: o['--init'] ? true : null, CapAdd: many('--cap-add'), CapDrop: many('--cap-drop'), SecurityOpt: many('--security-opt'), ExtraHosts: many('--add-host'),
      Ulimits: many('--ulimit').map((u) => { const [n, v] = u.split('='); const [s, h] = v.split(':'); return { Name: n, Soft: Number(s), Hard: Number(h) }; }),
      Memory: Number(one('--memory') || 0), MemorySwap: Number(one('--memory-swap') || 0), NanoCpus: Math.round(Number(one('--cpus') || 0) * 1e9),
      Runtime: one('--runtime') || 'runc', LogConfig: log, IpcMode: 'private',
    },
    Mounts: many('-v').map((v) => { const [src, Destination, mode] = v.split(':'); return src.startsWith('/') ? { Type: 'bind', Source: src, Destination, RW: mode !== 'ro' } : { Type: 'volume', Name: src, Source: '/var/lib/docker/volumes/' + src + '/_data', Destination, RW: mode !== 'ro' }; }),
    NetworkSettings: { Networks: { [one('--network') || 'bridge']: {} } },
    State: state.runExits ? { Status: 'exited', Running: false, Restarting: false, ExitCode: 1 } : running(),
  };
  save();
  ok(id);
}
fail('fake docker: no such command: ' + argv.join(' '), 2);
`;

export function makeFakeDocker(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'docker.cjs'), FAKE_DOCKER);
  fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/sh\nexec '${process.execPath}' '${path.join(dir, 'docker.cjs')}' "$@"\n`, { mode: 0o755 });
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ containers: {}, images: {}, registry: {}, runExits: false, runEchoes: false, ...state }, null, 2));
  return {
    dir,
    state: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    set: (patch) => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch }, null, 2)),
    calls: () => {
      try {
        return fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}

// what a container keeps across an update: its own variables and labels (not its image's), and
// how it runs
export function settingsOf(c, img) {
  const hc = c.HostConfig;
  const own = (list, base) => [...list].filter((x) => !base.includes(x)).sort();
  const labels = Object.entries(c.Config.Labels || {}).filter(([k, v]) => (img.Config.Labels || {})[k] !== v).map(([k, v]) => `${k}=${v}`);
  return {
    name: c.Name,
    env: own(c.Config.Env, img.Config.Env),
    labels: labels.sort(),
    cmd: JSON.stringify(c.Config.Cmd) === JSON.stringify(img.Config.Cmd) ? [] : c.Config.Cmd,
    ports: hc.PortBindings,
    mounts: c.Mounts.map((m) => [m.Type, m.Name || m.Source, m.Destination, m.RW]),
    restart: [hc.RestartPolicy.Name, hc.RestartPolicy.MaximumRetryCount],
    network: hc.NetworkMode,
    readOnly: !!hc.ReadonlyRootfs,
    caps: [hc.CapAdd || [], hc.CapDrop || []],
    securityOpt: hc.SecurityOpt || [],
    limits: [hc.Memory, hc.MemorySwap, hc.NanoCpus, hc.Ulimits || []],
    log: hc.LogConfig,
  };
}

// ---------------------------------------------------------------- a small YAML reader

export function parseYaml(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const fail = (m) => {
    throw new Error(`YAML, line ${i + 1}: ${m}`);
  };
  lines.forEach((l, n) => {
    if (/^ *\t/.test(l)) {
      i = n;
      fail('a tab in the indentation');
    }
  });
  const blank = (l) => /^\s*(#.*)?$/.test(l);
  const indent = (l) => /^ */.exec(l)[0].length;
  const more = () => {
    while (i < lines.length && blank(lines[i])) i++;
    return i < lines.length;
  };
  const item = (l, at) => /^-( |$)/.test(l.slice(at));
  const KEY = /^([A-Za-z_][\w-]*)[ ]*:(?:[ ]+(.*))?$/;

  function scalar(t) {
    if (t.startsWith("'")) {
      const m = /^'((?:[^']|'')*)'[ ]*(?:#.*)?$/.exec(t) || fail(`a bad quoted string: ${t}`);
      return m[1].replace(/''/g, "'");
    }
    if (t.startsWith('"')) {
      const m = /^("(?:[^"\\]|\\.)*")[ ]*(?:#.*)?$/.exec(t) || fail(`a bad quoted string: ${t}`);
      return JSON.parse(m[1]);
    }
    if (/^[{&*!%@`]/.test(t)) fail(`not supported here: ${t}`);
    const v = t.replace(/[ ]+#.*$/, '').trim();
    if (v === 'true' || v === 'false') return v === 'true';
    if (v === 'null' || v === '~' || v === '') return null;
    if (/^-?\d+$/.test(v)) return Number(v);
    return v;
  }
  function flow(t) {
    const m = /^\[(.*)\][ ]*(?:#.*)?$/.exec(t) || fail(`a flow list that doesn't end on its line: ${t}`);
    const parts = m[1].match(/'(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^,]+/g) || [];
    return parts.map((p) => p.trim()).filter((p) => p !== '' && p !== ',').map((p) => (p.startsWith('[') ? fail('nested flow lists') : scalar(p)));
  }
  function block(style, parent) {
    if (!/^\|[-+]?(?:[ ]+#.*)?$/.test(style)) fail(`only | blocks are supported: ${style}`);
    i++;
    const out = [];
    let at = null;
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') {
        out.push('');
        i++;
        continue;
      }
      if (indent(l) <= parent) break;
      if (at === null) at = indent(l);
      if (indent(l) < at) fail('a line less indented than its block');
      out.push(l.slice(at));
      i++;
    }
    while (out.length && out.at(-1) === '') out.pop();
    return out.join('\n') + (style[1] === '-' ? '' : '\n');
  }
  // the value after `key:` or `- `, whose own line is at column `col`
  function value(v, col) {
    v = v.trim();
    if (v === '' || v.startsWith('#')) {
      i++;
      if (!more()) return null;
      const n = indent(lines[i]);
      if (n > col) return node(n);
      if (n === col && item(lines[i], n)) return list(n);
      return null;
    }
    if (v.startsWith('|') || v.startsWith('>')) return block(v, col);
    i++;
    return v.startsWith('[') ? flow(v) : scalar(v);
  }
  function node(at) {
    return item(lines[i], at) ? list(at) : map(at);
  }
  function map(at) {
    const out = {};
    while (more() && indent(lines[i]) === at && !item(lines[i], at)) {
      const m = KEY.exec(lines[i].slice(at)) || fail(`not a "key: value" line: ${lines[i].trim()}`);
      if (Object.hasOwn(out, m[1])) fail(`the key ${m[1]} twice`);
      out[m[1]] = value(m[2] || '', at);
    }
    if (more() && indent(lines[i]) > at) fail('an unexpected indent');
    return out;
  }
  function list(at) {
    const out = [];
    while (more() && indent(lines[i]) === at && item(lines[i], at)) {
      const rest = lines[i].slice(at + 1).replace(/^ +/, '');
      const col = lines[i].length - rest.length;
      if (rest === '' || rest.startsWith('#')) out.push(value('', at));
      else if (KEY.test(rest) || item(rest, 0)) {
        lines[i] = ' '.repeat(col) + rest; // the item's content, as if on its own line
        out.push(node(col));
      } else out.push(value(rest, at));
    }
    if (more() && indent(lines[i]) > at) fail('an unexpected indent');
    return out;
  }
  if (!more()) return null;
  if (indent(lines[i]) !== 0) fail('the document must start at column 0');
  const doc = node(0);
  if (more()) fail('something after the document');
  return doc;
}
