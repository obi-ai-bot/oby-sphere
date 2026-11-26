// The Claude Code plugin and its marketplace (.claude-plugin/, plugins/obysphere/):
// every JSON file parses; the marketplace entry matches the plugin and its source
// exists; the channel is bound to the plugin's MCP server; each skill has its
// frontmatter, and every `obysphere <command>` the skills and docs mention is one
// the CLI has (the contract from the wave 3 plan, hard-coded below); the MCP
// launcher serves its setup tool when no CLI is found, and passes stdio, arguments
// and the exit code through to a fake CLI when one is; the SessionStart hook passes
// on `inbox --hook` JSON and is silent otherwise, within its time limit; and, when
// `claude` is installed, `claude plugin validate` passes on the plugin and the
// marketplace. No network: every home, install and profile folder is a temp folder.
// `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which, findCli, hasProfile, chosenProfile, profileUnclear, profileMissing } from '../plugins/obysphere/scripts/find-cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PLUGIN = path.join(ROOT, 'plugins', 'obysphere');
const SCRIPTS = path.join(PLUGIN, 'scripts');
const MCP = path.join(SCRIPTS, 'mcp.mjs');
const HOOK = path.join(SCRIPTS, 'session-start.mjs');
const POSIX = process.platform !== 'win32';
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================================================================ the CLI contract (plan: wave 3)
// Every command the skills may name, with its subcommands and flags. `--profile`
// goes with every command. Positional arguments (handles, messages, links) aren't checked.
const GLOBAL_FLAGS = ['--profile', '--help'];
const CONTRACT = {
  // rep.mjs, as now
  join: { flags: ['--name', '--owner', '--about', '--cwd', '--insecure', '--runtime', '--model', '--rules', '--allow', '--force', '--bot'] },
  ask: { flags: ['--channel', '--file', '--wait'] },
  post: { flags: ['--channel', '--file'] },
  read: { flags: ['--channel', '--limit'] },
  inbox: { flags: ['--hook'] },
  agents: {},
  whoami: {},
  settings: { flags: ['--json'] },
  mcp: { flags: ['--serve'] },
  'mcp-config': {},
  // rep.mjs, new in wave 3 (notify, admin, github)
  notify: { subs: { test: ['--via'] } },
  admin: { subs: { claim: [], status: [], grant: [], revoke: [], policy: ['--sealed', '--max-depth', '--max-file-bytes', '--keep-days', '--yes', '--pause', '--resume'], 'rotate-key': [], audit: ['--out', '--after', '--force', '--since', '--json'] } }, // audit: #141
  github: { subs: { status: [] } },
  // added during the build (instruments)
  instruments: { subs: { new: [], list: [], check: [], remove: [] } },
  // when an Oby can't answer (#160)
  away: { flags: ['--until', '--note', '--off'] },
  // the menu bar icon (#163)
  menubar: { subs: { on: [], off: [] } },
  // security: the check, lockdown, a new token
  security: { flags: ['--json', '--no-scan'] },
  lockdown: { flags: ['--off', '--note'] },
  token: { subs: { rotate: ['--yes'] } },
  // deleting your own message (#139)
  delete: {},
  // obysphere.mjs (cli)
  start: {},
  stop: {},
  restart: {},
  status: {},
  logs: { flags: ['-f'] },
  open: {},
  profiles: { flags: ['--json'], subs: { use: ['--clear'] } },
  update: { flags: ['--check', '--channel', '--rollback'] },
  version: {},
  doctor: {},
  server: { subs: { start: [], deploy: ['--project', '--scope'], update: ['--docker', '--url', '--tag'], status: [] } }, // docker-image (#133): update --docker
};

// the code in a Markdown file: fenced blocks (backslash continuations joined) and inline spans
function codeIn(md) {
  const out = [];
  const rest = md.replace(/^(```|~~~)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm, (_, _f, body) => {
    out.push(...body.replace(/\\\n\s*/g, ' ').split('\n'));
    return '';
  });
  for (const m of rest.matchAll(/`([^`\n]+)`/g)) out.push(m[1]);
  return out;
}

// every `obysphere <command> ...` in some code, checked against the contract
function checkCommands(codes, where) {
  const problems = [];
  const seen = new Set();
  for (const code of codes) {
    for (const segment of code.split(/&&|\|\||;|\|/)) {
      // `obysphere`, or a bin folder's (~/.local/bin/obysphere), then a word
      const m = /(?:^|\s)(?:[~.\w/-]*\/bin\/)?obysphere\s+([a-z][\w-]*)(.*)$/.exec(segment);
      if (!m) continue;
      const [, cmd, tail] = m;
      const tokens = tail.match(/"[^"]*"|'[^']*'|\S+/g) || [];
      const spec = CONTRACT[cmd];
      if (!spec) {
        problems.push(`${where}: "obysphere ${cmd}" isn't a command the CLI has`);
        continue;
      }
      seen.add(cmd);
      const allowed = new Set([...GLOBAL_FLAGS, ...(spec.flags || [])]);
      if (spec.subs) {
        const sub = tokens[0];
        if (sub && /^[a-z][\w-]*$/.test(sub)) {
          if (!(sub in spec.subs)) problems.push(`${where}: "obysphere ${cmd} ${sub}" isn't a command the CLI has`);
          else {
            seen.add(`${cmd} ${sub}`);
            for (const f of spec.subs[sub]) allowed.add(f);
          }
        }
      }
      for (const t of tokens) {
        const flag = /^\[?(-{1,2}[a-z][\w-]*)/.exec(t);
        if (flag && !allowed.has(flag[1])) problems.push(`${where}: "obysphere ${cmd}" has no flag ${flag[1]}`);
      }
    }
  }
  return { problems, seen };
}

// "---" on line 1, then simple `key: value` lines, then "---"
function frontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(md);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2];
  }
  return fm;
}

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

const SKILLS = ['obysphere', 'join-a-sphere', 'ask-a-teammate', 'review-a-pr', 'oby-settings', 'run-a-sphere', 'update-obysphere'];

// ================================================================ the files

describe('the plugin and its marketplace', () => {
  test('every JSON file in .claude-plugin/ and plugins/ parses', () => {
    const files = [...walk(path.join(ROOT, '.claude-plugin')), ...walk(path.join(ROOT, 'plugins'))].filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 4, `found only ${files.length} JSON files`);
    for (const f of files) assert.doesNotThrow(() => readJson(f), `${path.relative(ROOT, f)} isn't valid JSON`);
  });

  test('the marketplace lists the plugin by its own name, from a folder that exists', () => {
    const market = readJson(path.join(ROOT, '.claude-plugin', 'marketplace.json'));
    assert.equal(market.name, 'obysphere');
    assert.equal(market.owner?.name, 'Obysphere');
    assert.equal(market.plugins.length, 1);
    const [entry] = market.plugins;
    assert.equal(entry.source, './plugins/obysphere');
    assert.ok(!entry.source.includes('..'));
    const dir = path.join(ROOT, entry.source);
    assert.ok(fs.statSync(dir).isDirectory(), `${entry.source} is missing`);
    const manifest = readJson(path.join(dir, '.claude-plugin', 'plugin.json'));
    assert.equal(entry.name, manifest.name);
    assert.equal(entry.version, undefined, 'the version lives in plugin.json only');
  });

  test('plugin.json: name, version, links, license, icon and the channel', () => {
    const m = readJson(path.join(PLUGIN, '.claude-plugin', 'plugin.json'));
    assert.equal(m.name, 'obysphere');
    assert.equal(m.version, '0.3.0');
    assert.equal(m.license, 'Apache-2.0');
    assert.equal(m.homepage, 'https://github.com/obi-ai-bot/oby-sphere');
    assert.equal(m.repository, 'https://github.com/obi-ai-bot/oby-sphere');
    assert.ok(m.description && Array.isArray(m.keywords) && m.keywords.length);
    for (const k of ['documentationUrl', 'supportUrl', 'privacyPolicyUrl']) assert.match(m[k], /^https:\/\/github\.com\/obi-ai-bot\/oby-sphere\//);
    // the channel binds to the MCP server .mcp.json declares
    const servers = readJson(path.join(PLUGIN, '.mcp.json')).mcpServers;
    assert.deepEqual(m.channels.map((c) => c.server), ['obysphere']);
    assert.ok(servers[m.channels[0].server], 'the channel names a server the plugin has');
    // the directory's icon: a square PNG, 512 to 2048 px
    const png = fs.readFileSync(path.join(PLUGIN, m.icon));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
    assert.ok(w === h && w >= 512 && w <= 2048, `icon is ${w}x${h}`);
    // the MCP server says the same version
    assert.match(fs.readFileSync(MCP, 'utf8'), new RegExp(`const VERSION = '${m.version.replace(/\./g, '\\.')}'`));
  });

  test('.mcp.json and hooks.json run scripts the plugin has', () => {
    const resolve = (s) => s.replaceAll('${CLAUDE_PLUGIN_ROOT}', PLUGIN);
    const server = readJson(path.join(PLUGIN, '.mcp.json')).mcpServers.obysphere;
    assert.equal(server.command, 'node');
    assert.deepEqual(server.args, ['${CLAUDE_PLUGIN_ROOT}/scripts/mcp.mjs']);
    assert.ok(fs.existsSync(resolve(server.args[0])));
    const hooks = readJson(path.join(PLUGIN, 'hooks', 'hooks.json')).hooks;
    const starts = hooks.SessionStart.flatMap((g) => g.hooks);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].type, 'command');
    assert.ok(starts[0].timeout > 5 && starts[0].timeout <= 30, 'a short timeout, above the script’s own 5 s');
    // the interpreter in command, the file in args (no shell, so a folder with spaces works)
    assert.equal(starts[0].command, 'node');
    assert.deepEqual(starts[0].args, ['${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs']);
    assert.ok(fs.existsSync(resolve(starts[0].args[0])));
  });

  test('no top-level bin/ (organization sync refuses it), and scripts without dependencies', () => {
    assert.ok(!fs.existsSync(path.join(PLUGIN, 'bin')));
    for (const f of fs.readdirSync(SCRIPTS)) {
      const file = path.join(SCRIPTS, f);
      const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${f}: ${r.stderr}`);
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/^import .* from '([^']+)';$/gm)) assert.match(m[1], /^(node:|\.\/)/, `${f} imports ${m[1]}`);
    }
  });

  test('every skill has its frontmatter: a name that matches its folder, and when to use it', () => {
    const dirs = fs.readdirSync(path.join(PLUGIN, 'skills')).sort();
    assert.deepEqual(dirs, [...SKILLS].sort());
    for (const d of dirs) {
      const md = fs.readFileSync(path.join(PLUGIN, 'skills', d, 'SKILL.md'), 'utf8');
      const fm = frontmatter(md);
      assert.ok(fm, `${d}: no frontmatter on line 1`);
      assert.equal(fm.name, d);
      assert.ok(fm.description && fm.description.length >= 80 && fm.description.length <= 1024, `${d}: description length ${fm.description?.length}`);
      assert.match(fm.description, /\bUse when\b/, `${d}: the description says when to use it`);
      // plain YAML scalars break on ": " and " #"
      assert.ok(!/: | #/.test(fm.description), `${d}: description has ": " or " #"`);
      // only the keys claude.ai and the directory accept
      for (const k of Object.keys(fm)) assert.ok(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'].includes(k), `${d}: key ${k}`);
      assert.ok(md.split('\n').length < 500, `${d}: keep SKILL.md under 500 lines`);
    }
  });

  test('every `obysphere <command>` in the skills and docs is in the CLI contract', () => {
    const files = [...SKILLS.map((s) => path.join(PLUGIN, 'skills', s, 'SKILL.md')), path.join(PLUGIN, 'README.md'), path.join(ROOT, 'docs', 'directory-listing.md')];
    const all = new Set();
    const problems = [];
    for (const f of files) {
      const r = checkCommands(codeIn(fs.readFileSync(f, 'utf8')), path.relative(ROOT, f));
      problems.push(...r.problems);
      for (const s of r.seen) all.add(s);
    }
    assert.deepEqual(problems, []);
    // the checker sees what's there
    for (const c of ['join', 'start', 'open', 'status', 'update', 'settings', 'doctor', 'notify test', 'github status', 'admin claim', 'server deploy', 'server update']) assert.ok(all.has(c), `no skill mentions obysphere ${c}`);
  });

  // the plugin directory flags a download-and-run command anywhere in a plugin (skills and
  // README included): the plugin points at the README's install section instead
  // the directory reads a script that names a web address (even https://<sphere>) and one that
  // reads the environment as a credential that could leave the machine: the scripts name none
  // (skills and docs may link)
  test('no script in the plugin names a web address', () => {
    const found = walk(path.join(PLUGIN, 'scripts')).filter((f) => /https?:\/\//i.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(found.map((f) => path.relative(PLUGIN, f)), []);
  });

  // the directory reads the whole environment, read or passed on, as a credential the plugin
  // could send away: the scripts read each variable they need by name
  test('no script in the plugin reads the whole environment', () => {
    const found = walk(path.join(PLUGIN, 'scripts')).filter((f) => /process\.env(?!\.[A-Za-z_])/.test(fs.readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/^#!.*$/m, '')));
    assert.deepEqual(found.map((f) => path.relative(PLUGIN, f)), []);
  });

  // the directory flags a file that names plugin.json (which names the icon) as one that might
  // run the icon: the plugin's text calls it "the plugin's version"
  test("no text in the plugin names its own plugin.json", () => {
    const found = walk(PLUGIN).filter((f) => /\.(md|mjs|json)$/i.test(f) && !f.endsWith(path.join('.claude-plugin', 'plugin.json'))).filter((f) => /\.claude-plugin\/plugin\.json/.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(found.map((f) => path.relative(PLUGIN, f)), []);
  });

  test('no file in the plugin carries a download-and-run command', () => {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const found = walk(PLUGIN).filter((f) => !/\.(png|jpe?g|gif|webp|ico)$/i.test(f)).filter((f) => /(curl|wget)[^\n]*\|\s*(ba|z)?sh\b/.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(found.map((f) => path.relative(ROOT, f)), []);
  });

  test('the checker catches a made-up command, subcommand or flag', () => {
    const { problems } = checkCommands(['obysphere serve', 'obysphere admin promote x', 'obysphere update --force', 'obysphere join "x" --name a', 'claude mcp remove obysphere --scope user'], 't');
    assert.equal(problems.length, 3, problems.join('\n'));
  });

  // review: the privacy statement (and the directory listing) said the CLI talks only to the
  // Sphere, but wave 3's CLI also checks GitHub for updates, may use `gh`, and may post to
  // a Slack webhook or ntfy topic
  test('the privacy statements name everything the CLI may reach', () => {
    const privacy = (md) => /^## Privacy\n([\s\S]*?)(?=^## )/m.exec(md)?.[1] || '';
    const readme = fs.readFileSync(path.join(PLUGIN, 'README.md'), 'utf8');
    const listing = fs.readFileSync(path.join(ROOT, 'docs', 'directory-listing.md'), 'utf8');
    for (const [name, text] of [['README.md#privacy', privacy(readme)], ['LISTING.md#privacy', privacy(listing)], ['LISTING.md#what-it-accesses', /^## What it accesses\n([\s\S]*?)(?=^## )/m.exec(listing)?.[1] || '']]) {
      assert.ok(text.length > 100, `${name} is there`);
      assert.doesNotMatch(text, /talks only to the Sphere/, name);
      for (const w of [/Sphere you join/, /GitHub/, /`gh`/, /Slack/, /ntfy/]) assert.match(text, w, `${name} names ${w}`);
    }
  });

  test('the repository README tells how to install it', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.match(readme, /\/plugin marketplace add obi-ai-bot\/oby-sphere/);
    assert.match(readme, /\/plugin install obysphere@obysphere/);
    assert.match(readme, /--dangerously-load-development-channels plugin:obysphere@obysphere/);
  });
});

// ================================================================ a fake install

// a fake rep.mjs: for `inbox --hook`, what FAKE_MODE says; otherwise it says what it
// got and echoes each line of stdin, then exits with FAKE_EXIT
const FAKE_REP = `
import fs from 'node:fs';
const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE || '';
if (process.env.FAKE_PID) fs.writeFileSync(process.env.FAKE_PID, String(process.pid));
if (args[0] === 'inbox') {
  if (mode === 'json') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Waiting for you: 2 asks.' }, systemMessage: '2 asks wait for you' }, null, 1) + '\\n');
  else if (mode === 'text') process.stdout.write('2 asks wait for you\\n');
  else if (mode === 'array') process.stdout.write('[1, 2]\\n');
  else if (mode === 'fail') { process.stdout.write('{"systemMessage":"half"}\\n'); process.exit(1); }
  else if (mode === 'slow') setTimeout(() => process.stdout.write('{"systemMessage":"late"}\\n'), 60000);
  if (mode !== 'slow') process.exit(0);
} else {
  process.stdout.write(JSON.stringify({ fake: 'rep', self: process.argv[1], args, profile: process.env.OBYSPHERE_PROFILE || null }) + '\\n');
  process.stdin.setEncoding('utf8');
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      process.stdout.write('echo ' + buf.slice(0, i) + '\\n');
      buf = buf.slice(i + 1);
    }
  });
  process.stdin.on('end', () => process.exit(Number(process.env.FAKE_EXIT || 0)));
}
`;

const temps = [];
// a fresh computer: empty PATH (but for a `node`), home, install and profile folders
function computer() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'obysphere-plugin-')));
  temps.push(dir);
  const d = { dir, bin: path.join(dir, 'bin'), node: path.join(dir, 'node-bin'), home: path.join(dir, 'home'), app: path.join(dir, 'app'), profiles: path.join(dir, 'profiles') };
  for (const k of ['bin', 'node', 'home', 'app', 'profiles']) fs.mkdirSync(d[k], { recursive: true });
  d.env = { PATH: d.bin, HOME: d.home, USERPROFILE: d.home, OBYSPHERE_APP_HOME: d.app, OBYSPHERE_HOME: d.profiles };
  if (!POSIX) d.env.SystemRoot = process.env.SystemRoot;
  d.installApp = () => {
    fs.mkdirSync(path.join(d.app, 'current'), { recursive: true });
    fs.writeFileSync(path.join(d.app, 'current', 'rep.mjs'), FAKE_REP);
    return path.join(d.app, 'current', 'rep.mjs');
  };
  d.join = (name = 'alice') => {
    fs.mkdirSync(path.join(d.profiles, name), { recursive: true });
    fs.writeFileSync(path.join(d.profiles, name, 'profile.json'), '{}');
  };
  return d;
}
// every server a test started, so one that a failing test left running can't keep the suite from ending
const started = [];
after(() => {
  for (const p of started) {
    if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
    for (const s of [p.stdin, p.stdout, p.stderr]) s.destroy(); // and a CLI it ran sees its stdin end
  }
  for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
});

// the plugin's MCP server, spoken to as Claude Code would: one JSON-RPC message per line
function startMcp(env, args = []) {
  const p = spawn(process.execPath, [MCP, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  started.push(p);
  p.stdin.on('error', () => {}); // it may have exited already
  const lines = [];
  let waiters = [];
  let buf = '';
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(line);
      const hits = waiters.filter((w) => w.match(line));
      waiters = waiters.filter((w) => !hits.includes(w));
      for (const w of hits) w.resolve(line);
    }
  });
  const nextLine = (match, what) =>
    new Promise((resolve, reject) => {
      const hit = lines.find(match);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error(`no ${what} within 10 s; stdout: ${lines.join(' | ')}; stderr: ${err}`)), 10000);
      waiters.push({ match, resolve: (l) => (clearTimeout(t), resolve(l)) });
    });
  const send = (o) => p.stdin.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n');
  const request = async (id, method, params = {}) => {
    send({ jsonrpc: '2.0', id, method, params });
    return JSON.parse(await nextLine((l) => { try { return JSON.parse(l).id === id; } catch { return false; } }, `answer to ${method}`));
  };
  const exited = new Promise((resolve) => p.on('close', (code, signal) => resolve({ code, signal })));
  return { p, lines, send, request, nextLine, exited, end: () => p.stdin.end() };
}

// ================================================================ the MCP launcher

describe('the MCP server (scripts/mcp.mjs)', () => {
  test('with no CLI, it serves obysphere_setup over stdio', async () => {
    const c = computer();
    const m = startMcp(c.env);
    const init = await m.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.jsonrpc, '2.0');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'obysphere');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.match(init.result.instructions, /obysphere_setup/);
    m.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    m.send('not json');
    assert.deepEqual((await m.request(2, 'ping')).result, {});
    const list = await m.request(3, 'tools/list');
    assert.deepEqual(list.result.tools.map((t) => t.name), ['obysphere_setup']);
    assert.equal(list.result.tools[0].inputSchema.type, 'object');
    const call = await m.request(4, 'tools/call', { name: 'obysphere_setup', arguments: {} });
    const text = call.result.content[0].text;
    assert.match(text, /isn't installed/);
    assert.match(text, /obi-ai-bot\/oby-sphere repository\), under Get started › With the CLI/);
    assert.doesNotMatch(text, /curl[^\n]*\|\s*sh/, 'no download-and-run command in the plugin');
    assert.match(text, /obysphere join "<invite link>"/);
    assert.deepEqual(checkCommands(text.split('\n'), 'obysphere_setup').problems, []);
    assert.equal((await m.request(5, 'tools/call', { name: 'sphere_ask', arguments: {} })).error.code, -32602);
    assert.equal((await m.request(6, 'no/such/method')).error.code, -32601);
    assert.deepEqual((await m.request(7, 'resources/list')).result, { resources: [] });
    // only JSON-RPC on stdout: notifications and junk got no answer
    assert.equal(m.lines.length, 7);
    m.end();
    assert.equal((await m.exited).code, 0);
  });

  test('with the CLI but no profile, it says how to join, not how to install', async () => {
    const c = computer();
    const rep = c.installApp();
    const m = startMcp(c.env);
    await m.request(1, 'initialize', {});
    const text = (await m.request(2, 'tools/call', { name: 'obysphere_setup' })).result.content[0].text;
    assert.match(text, /installed .*hasn't joined a Sphere/);
    assert.ok(text.includes(rep));
    assert.doesNotMatch(text, /install\.sh/);
    assert.match(text, /obysphere start/);
    // joined meanwhile: the tool says to reconnect
    c.join();
    const again = (await m.request(3, 'tools/call', { name: 'obysphere_setup' })).result.content[0].text;
    assert.match(again, /has joined a Sphere\. Reconnect/);
    m.end();
    await m.exited;
  });

  test('with the CLI installed and joined, stdio, arguments and the exit code go straight through', async () => {
    const c = computer();
    const rep = c.installApp();
    c.join();
    const m = startMcp({ ...c.env, FAKE_EXIT: '7', OBYSPHERE_PROFILE: 'alice' }, ['--profile', 'alice']);
    const hello = JSON.parse(await m.nextLine((l) => l.startsWith('{'), 'the fake CLI'));
    assert.equal(hello.fake, 'rep');
    assert.equal(hello.self, rep);
    assert.deepEqual(hello.args, ['mcp', '--profile', 'alice']);
    assert.equal(hello.profile, 'alice');
    const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    m.send(line);
    assert.equal(await m.nextLine((l) => l.startsWith('echo '), 'the echo'), 'echo ' + line);
    m.end();
    assert.deepEqual(await m.exited, { code: 7, signal: null });
  });

  test('several profiles and none chosen: it says to set OBYSPHERE_PROFILE; once chosen, it passes through', async () => {
    const c = computer();
    c.installApp();
    c.join('alice');
    c.join('work');
    const m = startMcp(c.env);
    await m.request(1, 'initialize', {});
    const text = (await m.request(2, 'tools/call', { name: 'obysphere_setup' })).result.content[0].text;
    assert.match(text, /more than one Sphere \(profiles: alice, work\)/);
    assert.match(text, /OBYSPHERE_PROFILE/);
    m.end();
    await m.exited;
    assert.match(text, /obysphere profiles use <name>/);
    m.end();
    await m.exited;
    for (const [env, args] of [[{ ...c.env, OBYSPHERE_PROFILE: 'work' }, []], [c.env, ['--profile', 'work']], [c.env, ['--profile=work']]]) {
      const chosen = startMcp(env, args);
      const hello = JSON.parse(await chosen.nextLine((l) => l.startsWith('{'), 'the fake CLI'));
      assert.deepEqual(hello.args, ['mcp', ...args]);
      chosen.end();
      assert.equal((await chosen.exited).code, 0);
    }
  });

  test('a default profile (obysphere profiles use) settles several; one that is gone settles nothing', async () => {
    const c = computer();
    c.installApp();
    c.join('alice');
    c.join('work');
    const file = path.join(c.profiles, '.default-profile');
    fs.writeFileSync(file, 'work\n');
    const chosen = startMcp(c.env);
    const hello = JSON.parse(await chosen.nextLine((l) => l.startsWith('{'), 'the fake CLI'));
    assert.deepEqual(hello.args, ['mcp'], 'it passes through, and the CLI reads the default itself');
    chosen.end();
    assert.equal((await chosen.exited).code, 0);
    fs.writeFileSync(file, 'gone\n');
    const m = startMcp(c.env);
    await m.request(1, 'initialize', {});
    assert.match((await m.request(2, 'tools/call', { name: 'obysphere_setup' })).result.content[0].text, /more than one Sphere/);
    m.end();
    await m.exited;
  });

  test('a signal to it reaches the CLI', async () => {
    const c = computer();
    c.installApp();
    c.join();
    const m = startMcp(c.env);
    await m.nextLine((l) => l.startsWith('{'), 'the fake CLI');
    m.p.kill('SIGTERM');
    const { code } = await m.exited;
    // the CLI died of the signal; the launcher exits as a shell would say it
    if (POSIX) assert.equal(code, 128 + os.constants.signals.SIGTERM);
    else assert.notEqual(code, 0);
  });

  test('`obysphere` on PATH: the rep.mjs beside the file it links to', { skip: !POSIX && 'symlinks and modes' }, async () => {
    const c = computer();
    const pkg = path.join(c.dir, 'pkg');
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, 'obysphere.mjs'), '#!/usr/bin/env node\n', { mode: 0o755 });
    fs.writeFileSync(path.join(pkg, 'rep.mjs'), FAKE_REP);
    fs.symlinkSync(path.join(pkg, 'obysphere.mjs'), path.join(c.bin, 'obysphere'));
    c.join();
    assert.deepEqual(findCli(c.env), { rep: path.join(pkg, 'rep.mjs'), bin: path.join(c.bin, 'obysphere') });
    const m = startMcp(c.env);
    const hello = JSON.parse(await m.nextLine((l) => l.startsWith('{'), 'the fake CLI'));
    assert.equal(hello.self, path.join(pkg, 'rep.mjs'));
    assert.deepEqual(hello.args, ['mcp']);
    m.end();
    assert.equal((await m.exited).code, 0);
  });

  // review: a named profile that isn't here made `rep.mjs mcp` stop at once ("no profile"),
  // so the server just failed in /mcp, with nothing to say what to fix
  test('OBYSPHERE_PROFILE or --profile naming a profile this computer lacks: it says so, and lists them', async () => {
    const c = computer();
    c.installApp();
    c.join('alice');
    const pid = path.join(c.dir, 'pid');
    for (const [env, args] of [[{ ...c.env, OBYSPHERE_PROFILE: 'bob', FAKE_PID: pid }, []], [{ ...c.env, FAKE_PID: pid }, ['--profile', 'bob']], [{ ...c.env, FAKE_PID: pid }, ['--profile=bob']]]) {
      const m = startMcp(env, args);
      await m.request(1, 'initialize', {});
      const text = (await m.request(2, 'tools/call', { name: 'obysphere_setup' })).result.content[0].text;
      assert.match(text, /profile "bob" .*no profile by that name\. Its profiles: alice\./);
      assert.match(text, /OBYSPHERE_PROFILE/);
      assert.deepEqual(checkCommands(text.split('\n'), 'obysphere_setup').problems, []);
      m.end();
      assert.equal((await m.exited).code, 0);
    }
    assert.ok(!fs.existsSync(pid), 'the CLI is not run');
    // the same name in other letters is the same profile, as rep.mjs reads it
    const m = startMcp({ ...c.env, OBYSPHERE_PROFILE: 'Alice' });
    const hello = JSON.parse(await m.nextLine((l) => l.startsWith('{'), 'the fake CLI'));
    assert.equal(hello.profile, 'Alice');
    m.end();
    assert.equal((await m.exited).code, 0);
  });

  // review: after the CLI failed to start, the launcher had replaced the default SIGTERM with
  // "pass it to the CLI", so serving obysphere_setup it ignored SIGTERM until stdin closed
  test('the CLI is found but can’t start: obysphere_setup says why, and a signal still stops it', { skip: !POSIX && 'shebangs' }, async () => {
    const c = computer();
    fs.writeFileSync(path.join(c.bin, 'obysphere'), '#!/no/such/interpreter\n', { mode: 0o755 });
    c.join();
    const m = startMcp(c.env);
    await m.request(1, 'initialize', {});
    const text = (await m.request(2, 'tools/call', { name: 'obysphere_setup' })).result.content[0].text;
    assert.match(text, /was found \(.*obysphere\) but couldn't start: ENOENT/);
    assert.match(text, /obysphere doctor/);
    m.p.kill('SIGTERM');
    const ended = await Promise.race([m.exited, sleep(3000).then(() => 'still running')]);
    if (ended === 'still running') m.p.kill('SIGKILL');
    assert.deepEqual(ended, { code: 128 + os.constants.signals.SIGTERM, signal: null });
  });

  test('`obysphere` on PATH with no rep.mjs to be found: it runs `obysphere mcp`', { skip: !POSIX && 'shell scripts' }, async () => {
    const c = computer();
    fs.writeFileSync(path.join(c.bin, 'obysphere'), '#!/bin/sh\necho "{\\"shim\\":\\"$*\\"}"\nexit 3\n', { mode: 0o755 });
    c.join();
    const m = startMcp(c.env);
    assert.equal(await m.nextLine((l) => l.includes('shim'), 'the shim'), '{"shim":"mcp"}');
    assert.equal((await m.exited).code, 3);
  });
});

describe('finding the CLI (scripts/find-cli.mjs)', () => {
  test('PATH first, then $OBYSPHERE_APP_HOME, then ~/.local/share/obysphere; a file that is not executable is skipped', { skip: !POSIX && 'modes' }, () => {
    const c = computer();
    assert.equal(findCli(c.env), null);
    // in ~/.local/share/obysphere
    const shared = path.join(c.home, '.local', 'share', 'obysphere', 'current');
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'rep.mjs'), FAKE_REP);
    assert.equal(findCli(c.env).rep, path.join(shared, 'rep.mjs'));
    // $OBYSPHERE_APP_HOME comes before it
    const app = c.installApp();
    assert.equal(findCli(c.env).rep, app);
    // a non-executable `obysphere` on PATH isn't a command
    fs.writeFileSync(path.join(c.bin, 'obysphere'), 'x', { mode: 0o644 });
    assert.equal(which('obysphere', c.env), null);
    fs.chmodSync(path.join(c.bin, 'obysphere'), 0o755);
    assert.equal(which('obysphere', c.env), path.join(c.bin, 'obysphere'));
    assert.deepEqual(findCli(c.env), { rep: app, bin: path.join(c.bin, 'obysphere') });
  });

  test('a profile counts in $OBYSPHERE_HOME, or else in ~/.obysphere or ~/.obysphere-mvp', () => {
    const c = computer();
    assert.equal(hasProfile(c.env), false);
    fs.mkdirSync(path.join(c.profiles, 'empty-folder'));
    assert.equal(hasProfile(c.env), false);
    c.join();
    assert.equal(hasProfile(c.env), true);
    const noHome = { ...c.env, OBYSPHERE_HOME: '' };
    assert.equal(hasProfile(noHome), false);
    fs.mkdirSync(path.join(c.home, '.obysphere-mvp', 'bob'), { recursive: true });
    fs.writeFileSync(path.join(c.home, '.obysphere-mvp', 'bob', 'profile.json'), '{}');
    assert.equal(hasProfile(noHome), true);
  });

  test('which profile is chosen: --profile, then --profile=, then OBYSPHERE_PROFILE; and whether it is here', () => {
    const c = computer();
    c.join('alice');
    c.join('work');
    assert.equal(chosenProfile([], c.env), undefined);
    assert.equal(chosenProfile(['--profile', 'work'], { ...c.env, OBYSPHERE_PROFILE: 'alice' }), 'work');
    assert.equal(chosenProfile(['--serve', '--profile=work'], c.env), 'work');
    assert.equal(chosenProfile([], { ...c.env, OBYSPHERE_PROFILE: 'alice' }), 'alice');
    assert.equal(profileUnclear([], c.env), true);
    assert.equal(profileUnclear(['--profile', 'work'], c.env), false);
    assert.equal(profileMissing([], c.env), false);
    assert.equal(profileMissing(['--profile', 'work'], c.env), false);
    assert.equal(profileMissing(['--profile', '@Work'], c.env), false, 'read as rep.mjs reads it');
    assert.equal(profileMissing(['--profile', 'bob'], c.env), true);
    assert.equal(profileMissing(['--profile'], c.env), true, 'no name at all');
    assert.equal(profileMissing([], { ...c.env, OBYSPHERE_PROFILE: 'bob' }), true);
  });
});

// ================================================================ the SessionStart hook

describe('the SessionStart hook (scripts/session-start.mjs)', () => {
  const runHook = (env) =>
    new Promise((resolve) => {
      const started = Date.now();
      const p = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.stdin.on('error', () => {}); // the hook doesn't read its input, and may be gone
      p.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 's', cwd: os.tmpdir() }));
      p.on('close', (code) => resolve({ code, out, err, ms: Date.now() - started }));
    });

  test('no CLI: nothing, exit 0', async () => {
    const c = computer();
    assert.deepEqual(await runHook(c.env).then(({ code, out }) => ({ code, out })), { code: 0, out: '' });
  });

  test('a CLI but no profile: nothing, and the CLI is not run', async () => {
    const c = computer();
    c.installApp();
    const pid = path.join(c.dir, 'pid');
    const r = await runHook({ ...c.env, FAKE_MODE: 'json', FAKE_PID: pid });
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    assert.ok(!fs.existsSync(pid));
  });

  test('joined: the JSON of `inbox --hook`, as it is', async () => {
    const c = computer();
    c.installApp();
    c.join();
    const r = await runHook({ ...c.env, FAKE_MODE: 'json' });
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.out), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Waiting for you: 2 asks.' }, systemMessage: '2 asks wait for you' });
    assert.equal(r.err, '');
  });

  test('several profiles: nothing unless OBYSPHERE_PROFILE picks one', async () => {
    const c = computer();
    c.installApp();
    c.join('alice');
    c.join('work');
    const pid = path.join(c.dir, 'pid');
    const unclear = await runHook({ ...c.env, FAKE_MODE: 'json', FAKE_PID: pid });
    assert.deepEqual({ code: unclear.code, out: unclear.out }, { code: 0, out: '' });
    assert.ok(!fs.existsSync(pid), 'the CLI is not run');
    const chosen = await runHook({ ...c.env, FAKE_MODE: 'json', OBYSPHERE_PROFILE: 'work' });
    assert.equal(JSON.parse(chosen.out).systemMessage, '2 asks wait for you');
    const missing = await runHook({ ...c.env, FAKE_MODE: 'json', FAKE_PID: pid, OBYSPHERE_PROFILE: 'bob' });
    assert.deepEqual({ code: missing.code, out: missing.out }, { code: 0, out: '' });
    assert.ok(!fs.existsSync(pid), 'nor for a profile that isn’t here');
  });

  for (const mode of ['text', 'array', 'fail']) {
    test(`\`inbox --hook\` that ${mode === 'fail' ? 'fails' : `prints ${mode}`}: nothing, exit 0`, async () => {
      const c = computer();
      c.installApp();
      c.join();
      const r = await runHook({ ...c.env, FAKE_MODE: mode });
      assert.deepEqual({ code: r.code, out: r.out, err: r.err }, { code: 0, out: '', err: '' });
    });
  }

  test('too slow: nothing, within its time limit, and the CLI is stopped', async () => {
    const c = computer();
    c.installApp();
    c.join();
    const pid = path.join(c.dir, 'pid');
    const r = await runHook({ ...c.env, FAKE_MODE: 'slow', FAKE_PID: pid, OBYSPHERE_HOOK_TIMEOUT_MS: '400' });
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
    assert.ok(r.ms < 4000, `took ${r.ms} ms`);
    await sleep(200);
    assert.throws(() => process.kill(Number(fs.readFileSync(pid, 'utf8')), 0), 'the slow CLI was killed');
  });

  test('the time limit never goes above 5 seconds', () => {
    assert.match(fs.readFileSync(HOOK, 'utf8'), /Math\.min\(5000,/);
  });

  test('hooks.json’s command and args, run as Claude Code runs them (no shell)', { skip: !POSIX && 'a node on PATH' }, () => {
    const c = computer();
    c.installApp();
    c.join();
    fs.symlinkSync(process.execPath, path.join(c.node, 'node'));
    const { command, args } = readJson(path.join(PLUGIN, 'hooks', 'hooks.json')).hooks.SessionStart[0].hooks[0];
    const env = { ...c.env, PATH: `${c.node}:${c.bin}`, CLAUDE_PLUGIN_ROOT: PLUGIN, FAKE_MODE: 'json' };
    const r = spawnSync(path.join(c.node, command), args.map((a) => a.replaceAll('${CLAUDE_PLUGIN_ROOT}', PLUGIN)), { env, encoding: 'utf8', input: '{}' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).systemMessage, '2 asks wait for you');
  });
});

// ================================================================ Claude Code's own check

describe('claude plugin validate', () => {
  const claude = which('claude');
  let cfg;
  before(() => {
    cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'obysphere-plugin-claude-'));
    temps.push(cfg);
  });
  for (const [what, target] of [['the plugin', PLUGIN], ['the marketplace', ROOT]]) {
    test(`passes on ${what}`, { skip: !claude && 'claude is not installed', timeout: 180000 }, (t) => {
      const r = spawnSync(claude, ['plugin', 'validate', target], {
        // its own config folder, no updates, no network beyond what validation needs
        env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000,
      });
      t.diagnostic(`claude plugin validate ${path.relative(ROOT, target) || '.'} → exit ${r.status}\n${(r.stdout || '') + (r.stderr || '')}`);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /Validation passed/);
    });
  }
});
