// `rep.mjs mcp` in the apps that run it (MCP-HOSTS.md), without any of them: the setup
// `mcp-config --host <app>` prints for each one parses, points at this rep.mjs, names the
// profile only when it must and holds no secret; and an MCP session over stdio works the
// way those apps drive it, for every protocol version they send, against a test relay:
// the initialize handshake and its version negotiation, the 2026-07-28 per-request
// protocol (server/discover), batches, cancellation, strict tool schemas, and a clean exit.
// `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { mcpSession, parseYamlSubset, shellWords, toolProblems } from './mcp-hosts-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const REP = fs.realpathSync(path.join(ROOT, 'rep.mjs'));
const NODE = fs.realpathSync(process.execPath);
const KEY = 'join-key-mcp-hosts-0123456789';
const ADMIN = 'admin-key-mcp-hosts-0123456789';
const HOSTS = ['claude-code', 'cursor', 'claude-desktop', 'vscode', 'gemini', 'goose'];
const LEGACY = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const MODERN = '2026-07-28';
const META = (v = MODERN, caps = {}) => ({ 'io.modelcontextprotocol/protocolVersion': v, 'io.modelcontextprotocol/clientInfo': { name: 'test-host', version: '1.0.0' }, ...(caps ? { 'io.modelcontextprotocol/clientCapabilities': caps } : {}) });
const MAIN_TOOLS = ['sphere_agents', 'sphere_ask', 'sphere_read', 'sphere_check', 'sphere_post', 'sphere_inbox', 'sphere_get_file'];
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('MCP hosts', () => {
  let relay, base, data, home, solo, work, outbox;
  const procs = [];
  const sessions = [];
  // a child's environment: these profiles, and none of the variables that move an app's files
  const envFor = (h, extra = {}) => {
    const e = { ...process.env, OBYSPHERE_HOME: h, ...extra };
    for (const k of ['COPILOT_HOME', 'GEMINI_CLI_HOME', 'XDG_CONFIG_HOME', 'OBYSPHERE_PROFILE']) if (!(k in extra)) delete e[k];
    return e;
  };
  const rep = (args, { h = home, env = {} } = {}) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [REP, ...args], { env: envFor(h, env) });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      const t = setTimeout(() => p.kill(), 30000);
      p.on('close', (code) => {
        clearTimeout(t);
        resolve({ code, out, err });
      });
    });
  const setup = async (host, args = [], opts) => {
    const r = await rep(['mcp-config', '--host', host, '--json', ...args], opts);
    assert.equal(r.code, 0, r.err);
    return JSON.parse(r.out);
  };
  const session = (args = ['--profile', 'alice'], extra = {}) => {
    const s = mcpSession(REP, args, envFor(home, extra));
    sessions.push(s);
    return s;
  };
  const text = (res) => res.result?.content?.map((c) => c.text).join('\n') ?? '';
  // the server process's own entry, whatever the app's format
  const launch = (s) => (s.host === 'goose' ? { command: s.entry.cmd, args: s.entry.args, env: s.entry.envs } : s.entry);

  before(async () => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-hosts-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-hosts-reps-'));
    solo = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-hosts-solo-'));
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-hosts-work-'));
    outbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-hosts-outbox-'));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    relay = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', data], {
      env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_SEALED: '1', SPHERE_STORE: 'fs' },
      stdio: process.env.SPHERE_TEST_DEBUG ? 'inherit' : 'ignore',
    });
    procs.push(relay);
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
      await sleep(100);
    }
    for (const [n, h] of [['alice', home], ['bob', home], ['carol', solo]]) {
      const r = await rep(['join', `${base}/#key=${KEY}`, '--name', n, '--owner', `${n[0].toUpperCase()}${n.slice(1)} Test`, '--cwd', work], { h });
      assert.match(r.out, /joined/, r.out + r.err);
    }
  });

  after(async () => {
    for (const s of sessions) s.kill();
    for (const p of procs) p.kill();
    for (const d of [data, home, solo, work, outbox]) fs.rmSync(d, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- the setup for each app

  test("each app's entry parses, in its own format, and runs this rep.mjs with this node", async () => {
    for (const host of HOSTS) {
      const s = await setup(host, ['--profile', 'alice']);
      assert.equal(s.host, host);
      if (s.format === 'json') assert.deepEqual(JSON.parse(s.snippet), { mcpServers: { obysphere: s.entry } }, host);
      else if (s.format === 'yaml') assert.deepEqual(parseYamlSubset(s.snippet), { extensions: { obysphere: s.entry } }, host);
      else {
        const w = shellWords(s.snippet);
        assert.deepEqual(w.slice(0, 3), ['claude', 'mcp', 'add']);
        assert.equal(w[w.indexOf('--') - 1], 'obysphere');
        assert.deepEqual(w.slice(w.indexOf('--') + 1), [s.entry.command, ...s.entry.args]);
        assert.equal(w[w.indexOf('--scope') + 1], 'user');
        assert.equal(w[w.indexOf('--env') + 1], `OBYSPHERE_HOME=${home}`);
      }
      const l = launch(s);
      assert.equal(l.command, NODE, `${host}: node, by its absolute path`);
      assert.ok(path.isAbsolute(l.args[0]) && l.args[0] === REP, `${host}: this rep.mjs`);
      assert.equal(l.args[1], 'mcp');
      assert.deepEqual(l.args.slice(2, 4), ['--profile', 'alice'], `${host}: two profiles here, so it names one`);
      assert.equal(l.env.OBYSPHERE_HOME, home, `${host}: the app finds the moved profiles`);
      assert.equal(s.checked, '2026-11-25');
      assert.match(s.docs, /^https:\/\//);
    }
  });

  test("each app's own keys and settings, as its docs give them", async () => {
    const by = {};
    for (const host of HOSTS) by[host] = await setup(host, ['--profile', 'alice']);
    assert.equal(by.cursor.entry.type, 'stdio');
    assert.equal(by['claude-desktop'].entry.type, undefined);
    assert.equal(by.vscode.entry.type, 'stdio');
    assert.deepEqual(by.vscode.entry.tools, ['*']);
    assert.match(by.vscode.alternative, /^code --add-mcp '/);
    const added = JSON.parse(shellWords(by.vscode.alternative)[2]);
    assert.deepEqual(added, { name: 'obysphere', type: 'stdio', command: NODE, args: by.vscode.entry.args, env: { OBYSPHERE_HOME: home } });
    assert.equal(by.gemini.entry.timeout, 960000, 'longer than sphere_ask waits');
    const g = shellWords(by.gemini.command);
    assert.deepEqual(g.slice(0, 3), ['gemini', 'mcp', 'add']);
    assert.equal(g[g.indexOf('--scope') + 1], 'user');
    assert.equal(g[g.indexOf('--timeout') + 1], '960000');
    assert.equal(g[g.indexOf('-e') + 1], `OBYSPHERE_HOME=${home}`);
    assert.deepEqual(g.slice(g.indexOf('obysphere'), g.indexOf('--') + 1), ['obysphere', NODE, '--'], 'the server args after --, so gemini keeps them');
    assert.deepEqual(g.slice(g.indexOf('--') + 1), by.gemini.entry.args);
    const goose = by.goose.entry;
    assert.equal(goose.type, 'stdio');
    assert.equal(goose.name, 'obysphere');
    assert.equal(goose.enabled, true);
    assert.equal(goose.timeout, 960, 'seconds, longer than sphere_ask waits');
    assert.deepEqual(goose.env_keys, []);
    for (const host of HOSTS) assert.equal(launch(by[host]).args.includes('--serve'), host === 'claude-code' || host === 'cursor', `${host}: --serve`);
  });

  test('where each file is, on this computer', async () => {
    const h = os.homedir();
    const plat = process.platform;
    const appData = process.env.APPDATA || path.join(h, 'AppData', 'Roaming');
    const want = {
      'claude-code': path.join(h, '.claude.json'),
      cursor: path.join(h, '.cursor', 'mcp.json'),
      'claude-desktop': plat === 'darwin' ? path.join(h, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') : plat === 'win32' ? path.join(appData, 'Claude', 'claude_desktop_config.json') : path.join(h, '.config', 'Claude', 'claude_desktop_config.json'),
      vscode: path.join(h, '.copilot', 'mcp-config.json'),
      gemini: path.join(h, '.gemini', 'settings.json'),
      goose: plat === 'win32' ? path.join(appData, 'Block', 'goose', 'config', 'config.yaml') : path.join(h, '.config', 'goose', 'config.yaml'),
    };
    for (const host of HOSTS) {
      const s = await setup(host, ['--profile', 'alice']);
      assert.equal(s.file.here, want[host], host);
      const r = await rep(['mcp-config', '--host', host, '--profile', 'alice']);
      assert.equal(r.code, 0, r.err);
      for (const part of [s.snippet, s.file.here, s.next, 'MCP-HOSTS.md', s.docs]) assert.ok(r.out.includes(part), `${host} prints ${part}`);
      if (s.command) assert.ok(r.out.includes(s.command), `${host} prints its command`);
      if (s.file.byOs) for (const f of Object.values(s.file.byOs)) assert.ok(r.out.includes(f), `${host}: every OS`);
    }
    assert.ok((await setup('claude-desktop', ['--profile', 'alice'])).file.byOs.Windows.includes('claude_desktop_config.json'));
    assert.equal((await setup('vscode', ['--profile', 'alice'], { env: { COPILOT_HOME: work } })).file.here, path.join(work, 'mcp-config.json'), 'COPILOT_HOME moves it');
    assert.equal((await setup('gemini', ['--profile', 'alice'], { env: { GEMINI_CLI_HOME: work } })).file.here, path.join(work, '.gemini', 'settings.json'), 'GEMINI_CLI_HOME moves it');
  });

  test('the profile is named only when there is more than one, or you named one', async () => {
    for (const host of HOSTS) {
      const alone = launch(await setup(host, [], { h: solo }));
      assert.ok(!alone.args.includes('--profile'), `${host}: one profile, none named`);
      const named = launch(await setup(host, ['--profile', 'carol'], { h: solo }));
      assert.deepEqual(named.args.slice(2, 4), ['--profile', 'carol'], `${host}: --profile given`);
      const byEnv = launch(await setup(host, [], { h: solo, env: { OBYSPHERE_PROFILE: 'carol' } }));
      assert.deepEqual(byEnv.args.slice(2, 4), ['--profile', 'carol'], `${host}: OBYSPHERE_PROFILE, which the app won't have`);
    }
    const r = await rep(['mcp-config', '--host', 'vscode']);
    assert.equal(r.code, 1);
    assert.match(r.err, /several profiles here \((alice, bob|bob, alice)\): pass --profile/);
  });

  test('--serve on request, for the apps that leave it out', async () => {
    for (const host of ['claude-desktop', 'vscode', 'gemini', 'goose']) {
      const s = await setup(host, ['--profile', 'alice', '--serve']);
      assert.equal(s.serve, true);
      assert.equal(launch(s).args.at(-1), '--serve', host);
    }
  });

  test('nothing printed holds a token, a key or the invite', async () => {
    const secrets = [KEY, ADMIN];
    for (const n of ['alice', 'bob']) {
      secrets.push(JSON.parse(fs.readFileSync(path.join(home, n, 'profile.json'), 'utf8')).token);
      const walk = (v) => (typeof v === 'string' ? v.length >= 16 && secrets.push(v) : v && typeof v === 'object' && Object.values(v).forEach(walk));
      walk(JSON.parse(fs.readFileSync(path.join(home, n, 'keys.json'), 'utf8')));
    }
    assert.ok(secrets.length > 6);
    for (const host of HOSTS)
      for (const args of [['--profile', 'alice'], ['--profile', 'bob', '--json'], ['--profile', 'alice', '--serve', '--json']]) {
        const r = await rep(['mcp-config', '--host', host, ...args]);
        assert.equal(r.code, 0, r.err);
        for (const sec of secrets) assert.ok(!r.out.includes(sec) && !r.err.includes(sec), `${host} ${args.join(' ')}: a secret`);
        assert.doesNotMatch(r.out, /tok_|Bearer|authorization|api[_-]?key/i);
      }
  });

  test('an app it does not know gets the list of apps', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-hosts-none-'));
    try {
      for (const args of [['--host', 'zed'], ['--host'], ['--host', '--profile', 'alice']]) {
        const r = await rep(['mcp-config', ...args], { h: empty });
        assert.equal(r.code, 1, args.join(' '));
        assert.match(r.err, /Use one of: claude-code, cursor, claude-desktop, vscode, gemini, goose\./, 'before it needs a profile');
      }
      assert.match((await rep(['mcp-config', '--host', 'Gemini', '--json'], { h: empty })).err, /not joined yet/, 'names in any case');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test('mcp-config without --host, and the help, point at the other apps', async () => {
    const r = await rep(['mcp-config', '--profile', 'alice']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /claude mcp add obysphere --scope user -- .+ mcp --profile alice --serve/, "today's Claude Code line");
    assert.match(r.out, /"mcpServers"/);
    assert.match(r.out, /mcp-config --host claude-desktop\|vscode\|gemini\|goose \(MCP-HOSTS\.md\)/);
    assert.match((await rep(['help'])).out, /mcp-config --host <app>.+claude-desktop, vscode, gemini or goose/);
  });

  // ---------------------------------------------------------------- the protocol, as the apps speak it

  for (const version of LEGACY) {
    test(`a session with the initialize handshake, ${version}`, async () => {
      const s = session();
      const init = await s.request(1, 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test-host', version: '1.0.0' } });
      assert.equal(init.result.protocolVersion, version, 'the version it asked for');
      assert.ok(init.result.capabilities.tools, 'tools');
      assert.equal(init.result.serverInfo.name, 'obysphere');
      assert.match(init.result.instructions, /"alice"/);
      assert.equal(init.result.resultType, undefined, 'no 2026-07-28 fields in the handshake era');
      s.notify('notifications/initialized');
      const list = await s.request(2, 'tools/list', {});
      const names = list.result.tools.map((t) => t.name);
      for (const n of MAIN_TOOLS) assert.ok(names.includes(n), n);
      assert.equal(list.result.resultType, undefined);
      const agents = await s.request(3, 'tools/call', { name: 'sphere_agents', arguments: {} });
      assert.ok(!agents.result.isError, text(agents));
      assert.match(text(agents), /"handle": "bob"/);
      const post = await s.request(4, 'tools/call', { name: 'sphere_post', arguments: { message: `hello from ${version}` } });
      assert.match(text(post), /^Posted in #general/, text(post));
      const read = await s.request(5, 'tools/call', { name: 'sphere_read', arguments: {} });
      assert.ok(text(read).includes(`hello from ${version}`), 'read back, opened on this machine');
      assert.equal((await s.request(6, 'tools/call', { name: 'sphere_nope', arguments: {} })).error.code, -32602);
      assert.equal((await s.request(7, 'nope/nope', {})).error.code, -32601);
      assert.deepEqual((await s.request(8, 'ping')).result, {});
      assert.deepEqual((await s.request('r', 'resources/list', {})).result, { resources: [] });
      const t0 = Date.now();
      s.end();
      const ex = await s.exited;
      assert.equal(ex.code, 0, 'exits cleanly when stdin closes');
      assert.ok(ex.at - t0 < 3000, `promptly (${ex.at - t0} ms)`);
      assert.ok(s.msgs.every((x) => !x.m.notJson), 'nothing but MCP on stdout');
    });
  }

  test('version negotiation: a version it does not speak gets its newest handshake version', async () => {
    const s = session();
    for (const [id, asked] of [[1, '2099-01-01'], [2, MODERN], [3, undefined], [4, 20250618]]) {
      const r = await s.request(id, 'initialize', { ...(asked === undefined ? {} : { protocolVersion: asked }), capabilities: {}, clientInfo: { name: 'x', version: '1' } });
      assert.equal(r.result.protocolVersion, '2025-11-25', String(asked));
    }
    s.end();
    assert.equal((await s.exited).code, 0);
  });

  test('a line that is not a request gets no answer, and stops nothing', async () => {
    const s = session();
    for (const line of ['null', '42', '"hi"', 'not json', JSON.stringify({ jsonrpc: '2.0', id: 3, result: {} }), JSON.stringify({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' })]) s.send(line);
    assert.deepEqual((await s.request(9, 'ping')).result, {});
    const others = s.msgs.map((x) => x.m).filter((m) => m.id !== 9);
    assert.deepEqual(others, [{ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'a request id is a string or a number' } }], 'only the bad id is told');
    s.end();
    assert.equal((await s.exited).code, 0);
  });

  test('2025-03-26: a JSON-RPC batch gets one array back', async () => {
    const s = session();
    await s.request(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
    s.send([
      { jsonrpc: '2.0', id: 'b1', method: 'tools/list' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 'b2', method: 'tools/call', params: { name: 'sphere_agents', arguments: {} } },
      { jsonrpc: '2.0', id: 'b3', method: 'ping' },
    ]);
    const arr = await s.waitFor((m) => Array.isArray(m));
    assert.deepEqual(arr.map((r) => r.id).sort(), ['b1', 'b2', 'b3']);
    assert.match(text(arr.find((r) => r.id === 'b2')), /"handle": "bob"/);
    s.send([{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
    s.send([]);
    assert.equal((await s.waitFor((m) => m.id === null && m.error)).error.code, -32600, 'an empty batch is an invalid request');
    s.send({ jsonrpc: '2.0', id: 9, method: 'ping' });
    await s.waitFor(s.answerTo(9));
    assert.equal(s.msgs.filter((x) => Array.isArray(x.m)).length, 1, 'a batch of notifications gets nothing back');
    s.end();
    assert.equal((await s.exited).code, 0);
  });

  test('2026-07-28: server/discover, a version on every request, resultType (as goose probes)', async () => {
    const s = session();
    const d = await s.request('d', 'server/discover', { _meta: META() });
    assert.equal(d.result.resultType, 'complete');
    assert.deepEqual(d.result.supportedVersions, [MODERN, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
    assert.ok(d.result.capabilities.tools, 'tools');
    assert.equal(d.result._meta['io.modelcontextprotocol/serverInfo'].name, 'obysphere');
    assert.match(d.result.instructions, /"alice"/);
    const list = await s.request(1, 'tools/list', { _meta: META() });
    assert.equal(list.result.resultType, 'complete');
    assert.equal(list.result._meta['io.modelcontextprotocol/serverInfo'].name, 'obysphere');
    for (const n of MAIN_TOOLS) assert.ok(list.result.tools.some((t) => t.name === n), n);
    const agents = await s.request(2, 'tools/call', { name: 'sphere_agents', arguments: {}, _meta: META() });
    assert.equal(agents.result.resultType, 'complete');
    assert.match(text(agents), /"handle": "bob"/);
    assert.equal((await s.request(3, 'ping', { _meta: META() })).result.resultType, 'complete');
    const old = await s.request(4, 'tools/list', { _meta: META('1900-01-01') });
    assert.equal(old.error.code, -32022);
    assert.deepEqual(old.error.data, { supported: d.result.supportedVersions, requested: '1900-01-01' });
    assert.equal((await s.request(5, 'tools/list', { _meta: META(MODERN, null) })).error.code, -32602, 'clientCapabilities is required');
    assert.equal((await s.request(6, 'tools/call', { name: 'sphere_nope', arguments: {}, _meta: META() })).error.code, -32602);
    s.end();
    assert.equal((await s.exited).code, 0);
  });

  test('a client of both eras falls back: no version, no server/discover; then the handshake', async () => {
    const s = session();
    assert.equal((await s.request(1, 'server/discover', {})).error.code, -32601);
    const init = await s.request(2, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-11-25');
    s.end();
    assert.equal((await s.exited).code, 0);
  });

  test('every tool schema passes the strict checks, in your session and in an answering one', async () => {
    const mine = session();
    const answering = session(['--profile', 'alice', '--as-session'], { SPHERE_OUTBOX: outbox, SPHERE_DEPTH: '1' });
    for (const [s, want] of [[mine, MAIN_TOOLS], [answering, ['sphere_agents', 'sphere_ask', 'sphere_read', 'sphere_attach']]]) {
      for (const params of [{}, { _meta: META() }]) {
        const { tools } = (await s.request(Math.random(), 'tools/list', params)).result;
        for (const n of want) assert.ok(tools.some((t) => t.name === n), n);
        assert.equal(new Set(tools.map((t) => t.name)).size, tools.length, 'names are different');
        for (const t of tools) assert.deepEqual(toolProblems(t), [], t.name);
      }
      s.end();
      assert.equal((await s.exited).code, 0);
    }
  });

  test('the strict checks catch what the apps refuse', () => {
    const ok = { name: 'x', description: 'd', inputSchema: { type: 'object', properties: { a: { type: 'string', description: 'a' } }, required: ['a'] } };
    assert.deepEqual(toolProblems(ok), []);
    const broken = [
      { ...ok, name: 'has space' },
      { ...ok, name: 'a'.repeat(60) },
      { ...ok, description: '' },
      { ...ok, inputSchema: { type: 'object' } },
      { ...ok, inputSchema: { type: 'string', properties: {} } },
      { ...ok, inputSchema: { type: 'object', properties: { a: { type: 'array', description: 'a' } } } },
      { ...ok, inputSchema: { type: 'object', properties: { a: { description: 'a' } } } },
      { ...ok, inputSchema: { type: 'object', properties: { a: { type: ['string', 'null'], description: 'a' } } } },
      { ...ok, inputSchema: { type: 'object', properties: { a: { anyOf: [{ type: 'string' }], description: 'a' } } } },
      { ...ok, inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {} } },
      { ...ok, inputSchema: { type: 'object', properties: {}, required: ['b'] } },
      { ...ok, inputSchema: { type: 'object', properties: { a: { type: 'string' } } } },
    ];
    for (const t of broken) assert.notDeepEqual(toolProblems(t), [], JSON.stringify(t));
  });

  describe('with bob online and not answering', () => {
    let bob;
    before(async () => {
      // bob's representative is "online" while a rep stream is open; this one never answers
      const token = JSON.parse(fs.readFileSync(path.join(home, 'bob', 'profile.json'), 'utf8')).token;
      bob = new AbortController();
      const res = await fetch(`${base}/api/stream?role=rep`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, signal: bob.signal });
      assert.equal(res.status, 200);
      res.body.pipeTo(new WritableStream()).catch(() => {});
      for (let i = 0; i < 50; i++) {
        const { agents } = await (await fetch(`${base}/api/agents`, { headers: { 'x-sphere-key': KEY } })).json();
        if (agents.find((a) => a.name === 'bob')?.online) return;
        await sleep(100);
      }
      throw new Error('bob never came online');
    });
    after(() => bob?.abort());

    test('notifications/cancelled stops a waiting sphere_ask: no answer, no progress, and its id is free again', async () => {
      const s = session();
      await s.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gemini-like', version: '1' } });
      s.notify('notifications/initialized');
      const ask = (id, token) => s.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'sphere_ask', arguments: { agent: 'bob', message: `still there? (${id})`, wait_seconds: 10 }, _meta: { progressToken: token } } });
      ask(7, 'progress-7');
      ask(9, 'progress-9'); // the same ask, not cancelled
      await sleep(600);
      s.notify('notifications/cancelled', { requestId: 7, reason: 'the person pressed Esc' });
      s.notify('notifications/cancelled', { requestId: 12345, reason: 'never sent' });
      const cancelledAt = Date.now();
      assert.deepEqual((await s.request(8, 'ping')).result, {}, 'still answering');
      const nine = await s.waitFor(s.answerTo(9), 25000);
      assert.match(text(nine), /No reply from .bob after 10s/);
      assert.ok(s.msgs.some((x) => x.m.method === 'notifications/progress' && x.m.params.progressToken === 'progress-9'), 'the other one reports progress');
      await sleep(1500);
      assert.ok(!s.msgs.some((x) => x.m.id === 7), 'no answer for the cancelled one');
      assert.ok(!s.msgs.some((x) => x.at > cancelledAt && x.m.method === 'notifications/progress' && x.m.params.progressToken === 'progress-7'), 'no progress after cancelling');
      assert.deepEqual((await s.request(7, 'ping')).result, {}, 'a later request may use id 7 again');
      s.end();
      assert.equal((await s.exited).code, 0);
    });

    test('stdin closing ends the session at once, even with an ask still waiting', async () => {
      const s = session();
      await s.request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
      s.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sphere_ask', arguments: { agent: 'bob', message: 'one more?', wait_seconds: 30 } } });
      await sleep(600);
      const t0 = Date.now();
      s.end();
      const ex = await s.exited;
      assert.equal(ex.code, 0);
      assert.ok(ex.at - t0 < 3000, `${ex.at - t0} ms`);
    });
  });
});
