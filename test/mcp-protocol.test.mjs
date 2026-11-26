// `rep.mjs mcp`, spoken to the way MCP apps speak it, over stdio, against a test relay: the
// initialize handshake for every version it speaks (2024-11-05 to 2025-11-25) and its version
// negotiation; the 2026-07-28 protocol, with a version on every request (server/discover,
// resultType, caching hints, -32022, -32602); JSON-RPC batches; notifications/cancelled; a clean
// exit when stdin closes or the app stops reading; lines that aren't requests; and every tool's
// input schema, in your session, in an answering one (with GitHub on too), and in the plugin's
// setup server. No network beyond 127.0.0.1, no model, no desktop: every home, profile and app
// folder is a temp folder, and PATH holds only node and fake notifiers. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { mcpSession, toolProblems } from './mcp-protocol-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const REP = path.join(ROOT, 'rep.mjs');
const PLUGIN_MCP = path.join(ROOT, 'plugins', 'obysphere', 'scripts', 'mcp.mjs');
const KEY = 'join-key-mcp-protocol-0123456789';
const ADMIN = 'admin-key-mcp-protocol-0123456789';
const LEGACY = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const MODERN = '2026-07-28';
const SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
const CLIENT = { name: 'test-host', version: '1.0.0' };
const META = (v = MODERN, caps = {}) => ({ 'io.modelcontextprotocol/protocolVersion': v, 'io.modelcontextprotocol/clientInfo': CLIENT, ...(caps ? { 'io.modelcontextprotocol/clientCapabilities': caps } : {}) });
const YOUR_TOOLS = ['sphere_agents', 'sphere_ask', 'sphere_read', 'sphere_use', 'sphere_check', 'sphere_post', 'sphere_inbox', 'sphere_get_file'];
const ANSWERING_TOOLS = ['sphere_agents', 'sphere_ask', 'sphere_read', 'sphere_use', 'sphere_attach'];
const GITHUB_TOOLS = ['github_pr', 'github_review', 'github_comment', 'github_merge'];
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (res) => res.result?.content?.map((c) => c.text).join('\n') ?? '';
const init = (s, id, version = '2025-11-25') => s.request(id, 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: CLIENT });
// an exit, or a failure after ms
const exitWithin = (s, ms = 5000) => Promise.race([s.exited, sleep(ms).then(() => ({ code: 'still running', at: Date.now() }))]);

describe('MCP protocol', () => {
  let tmp, relay, base, home, solo, work, outbox, bin, userHome, appHome, logFile, downloads, cfg;
  const sessions = [];
  // a child's environment: only these folders, node and the fake notifiers
  const envFor = (h, extra = {}) => ({
    PATH: bin,
    HOME: userHome,
    USERPROFILE: userHome,
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
    OBYSPHERE_HOME: h,
    OBYSPHERE_APP_HOME: appHome,
    OBYSPHERE_NOTIFY_LOG: logFile,
    OBYSPHERE_NO_UPDATE_CHECK: '1',
    OBYSPHERE_DOWNLOADS: downloads,
    OBYSPHERE_CHROME: '0',
    CLAUDE_CONFIG_DIR: cfg,
    ...extra,
  });
  const rep = (args, h = home) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [REP, ...args], { env: envFor(h) });
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
  const track = (s) => (sessions.push(s), s);
  const session = (args = ['--profile', 'alice'], extra = {}, h = home) => track(mcpSession([REP, 'mcp', ...args], envFor(h, extra)));
  const done = async (s) => {
    s.end();
    const ex = await exitWithin(s);
    assert.equal(ex.code, 0, `exits with 0 when stdin closes\n${s.stderr().slice(-1000)}`);
    assert.ok(s.msgs.every((x) => !x.m.notJson), `nothing but MCP on stdout: ${JSON.stringify(s.msgs.filter((x) => x.m.notJson))}`);
  };

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-mcp-protocol-')));
    const data = path.join(tmp, 'relay');
    home = path.join(tmp, 'reps');
    solo = path.join(tmp, 'reps-solo');
    work = path.join(tmp, 'work');
    outbox = path.join(tmp, 'outbox');
    bin = path.join(tmp, 'bin');
    userHome = path.join(tmp, 'home');
    appHome = path.join(tmp, 'app');
    downloads = path.join(tmp, 'downloads');
    cfg = path.join(tmp, 'claude-config');
    logFile = path.join(tmp, 'notify.jsonl');
    for (const d of [data, home, solo, work, outbox, bin, userHome, appHome, downloads, cfg]) fs.mkdirSync(d, { recursive: true });
    // PATH: node, and notifiers that do nothing (nothing reaches the desktop: OBYSPHERE_NOTIFY_LOG)
    try {
      fs.symlinkSync(process.execPath, path.join(bin, process.platform === 'win32' ? 'node.exe' : 'node'));
    } catch {
      bin = `${bin}${path.delimiter}${path.dirname(process.execPath)}`;
    }
    for (const n of ['osascript', 'terminal-notifier', 'notify-send']) fs.writeFileSync(path.join(tmp, 'bin', n), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    relay = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', data], {
      env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_SEALED: '1', SPHERE_STORE: 'fs', SPHERE_ASKS_PER_MIN: '1000', SPHERE_WRITES_PER_MIN: '1000' },
      stdio: process.env.SPHERE_TEST_DEBUG ? 'inherit' : 'ignore',
    });
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(base + '/healthz')).ok) break;
      } catch {}
      await sleep(100);
    }
    for (const [n, h] of [['alice', home], ['bob', home], ['sam', solo]]) {
      const r = await rep(['join', `${base}/#key=${KEY}`, '--name', n, '--owner', `${n[0].toUpperCase()}${n.slice(1)} Test`, '--cwd', work], h);
      assert.match(r.out, /joined/, r.out + r.err);
    }
    // sam's Oby has GitHub on, merging included: its answering session lists every GitHub tool.
    // Its channel is off (notify.claude), so its own session answers server/discover; alice's
    // channel is on, the default.
    fs.writeFileSync(path.join(solo, 'sam', 'settings.json'), JSON.stringify({ version: 2, machine: { folders: [{ path: work, write: false }] }, github: { enabled: true, repos: ['octo-org/*'], merge: 'ask' }, notify: { desktop: false, claude: false } }), { mode: 0o600 });
  });

  after(async () => {
    for (const s of sessions) s.kill();
    relay?.kill();
    await sleep(200);
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------- the initialize handshake

  for (const version of LEGACY) {
    test(`a session with the initialize handshake, ${version}`, async () => {
      const s = session();
      const r = await init(s, 1, version);
      assert.equal(r.result.protocolVersion, version, 'the version it asked for');
      assert.ok(r.result.capabilities.tools, 'tools');
      assert.equal(r.result.serverInfo.name, 'obysphere');
      assert.match(r.result.instructions, /"alice"/);
      // 0.3.0's channel, as before: declared with the handshake, and said in the instructions
      assert.deepEqual(r.result.capabilities.experimental, { 'claude/channel': {} });
      assert.match(r.result.instructions, /<channel source="obysphere"/);
      assert.equal(r.result.resultType, undefined, 'no 2026-07-28 fields in the handshake era');
      s.notify('notifications/initialized');
      const list = await s.request(2, 'tools/list', {});
      const names = list.result.tools.map((t) => t.name);
      for (const n of YOUR_TOOLS) assert.ok(names.includes(n), n);
      assert.equal(list.result.resultType, undefined);
      assert.equal(list.result.ttlMs, undefined);
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
      assert.deepEqual((await s.request('p', 'prompts/list', {})).result, { prompts: [] });
      const t0 = Date.now();
      await done(s);
      assert.ok((await s.exited).at - t0 < 3000, 'promptly');
    });
  }

  test('version negotiation: a version it does not speak gets its newest handshake version', async () => {
    const s = session();
    for (const [id, asked] of [[1, '2099-01-01'], [2, MODERN], [3, undefined], [4, 20250618], [5, '2025-06-18 '], [6, '2024-11-05']]) {
      const r = await s.request(id, 'initialize', { ...(asked === undefined ? {} : { protocolVersion: asked }), capabilities: {}, clientInfo: CLIENT });
      assert.equal(r.result.protocolVersion, asked === '2024-11-05' ? '2024-11-05' : '2025-11-25', String(asked));
    }
    s.send({ jsonrpc: '2.0', id: 7, method: 'initialize', params: null });
    assert.equal((await s.waitFor(s.answerTo(7))).result.protocolVersion, '2025-11-25', 'params: null too');
    await done(s);
  });

  test('a line that is not a request gets no answer, and stops nothing', async () => {
    const s = session();
    const bad = { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'a request id is a string or a number' } };
    for (const line of ['null', '42', '"hi"', '[1', 'not json', JSON.stringify({ jsonrpc: '2.0', id: 3, result: {} }), JSON.stringify({ jsonrpc: '2.0', id: 4, error: { code: 1, message: 'x' } }), JSON.stringify({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' }), JSON.stringify({ jsonrpc: '2.0', id: true, method: 'ping' }), JSON.stringify({ jsonrpc: '2.0', method: 'notifications/nope' })]) s.send(line);
    s.send({ jsonrpc: '2.0', id: 8, method: 'ping', params: null });
    assert.deepEqual((await s.waitFor(s.answerTo(8))).result, {}, 'params: null is no params');
    assert.deepEqual((await s.request(9, 'ping')).result, {});
    const others = s.msgs.map((x) => x.m).filter((m) => m.id !== 8 && m.id !== 9);
    assert.deepEqual(others, [bad, bad], 'only the bad ids are told');
    await done(s);
  });

  // ---------------------------------------------------------------- batches (2025-03-26)

  test('2025-03-26: a JSON-RPC batch gets one array back', async () => {
    const s = session();
    await init(s, 1, '2025-03-26');
    s.send([
      { jsonrpc: '2.0', id: 'b1', method: 'tools/list' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 'b2', method: 'tools/call', params: { name: 'sphere_agents', arguments: {} } },
      { jsonrpc: '2.0', id: 'b3', method: 'ping' },
    ]);
    const arr = await s.waitFor((m) => Array.isArray(m));
    assert.deepEqual(arr.map((r) => r.id).sort(), ['b1', 'b2', 'b3']);
    assert.match(text(arr.find((r) => r.id === 'b2')), /"handle": "bob"/);
    assert.ok(arr.find((r) => r.id === 'b1').result.tools.length >= YOUR_TOOLS.length);
    // what isn't a request gets its error in the array; a response in it, nothing
    s.send([1, { jsonrpc: '2.0', id: 'c1', method: 'ping' }, { jsonrpc: '2.0', id: { x: 1 }, method: 'ping' }, { jsonrpc: '2.0', id: 'c2', result: {} }]);
    const mixed = await s.waitFor((m) => Array.isArray(m) && m.some((r) => r.id === 'c1'));
    assert.equal(mixed.length, 3, JSON.stringify(mixed));
    assert.deepEqual(mixed.find((r) => r.id === 'c1').result, {});
    assert.deepEqual(mixed.filter((r) => r.id === null).map((r) => r.error.code), [-32600, -32600]);
    // 1 and "1" are two ids
    s.send([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: '1', method: 'resources/list' }]);
    const two = await s.waitFor((m) => Array.isArray(m) && m.some((r) => r.id === '1'));
    assert.deepEqual(two.find((r) => r.id === 1).result, {});
    assert.deepEqual(two.find((r) => r.id === '1').result, { resources: [] });
    s.send([{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
    s.send([]);
    assert.equal((await s.waitFor((m) => !Array.isArray(m) && m.id === null && m.error)).error.code, -32600, 'an empty batch is an invalid request');
    await s.request(9, 'ping');
    assert.equal(s.msgs.filter((x) => Array.isArray(x.m)).length, 3, 'a batch of notifications gets nothing back');
    await done(s);
  });

  // ---------------------------------------------------------------- 2026-07-28: a version on every request

  // sam's own session: the channel is off, so it answers server/discover
  const samSession = () => session(['--profile', 'sam'], {}, solo);

  test('2026-07-28: server/discover, a version on every request, resultType, caching hints', async () => {
    const s = samSession();
    const d = await s.request('d', 'server/discover', { _meta: META() });
    assert.equal(d.result.resultType, 'complete');
    assert.deepEqual(d.result.supportedVersions, [MODERN, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
    assert.deepEqual(d.result.capabilities, { tools: {} }, 'no channel: 2026-07-28 has none');
    assert.deepEqual(d.result._meta[SERVER_INFO], { name: 'obysphere', version: '0.1.0' });
    assert.match(d.result.instructions, /"sam"/);
    assert.doesNotMatch(d.result.instructions, /channel source/);
    const list = await s.request(1, 'tools/list', { _meta: META() });
    assert.equal(list.result.resultType, 'complete');
    assert.equal(list.result._meta[SERVER_INFO].name, 'obysphere');
    for (const n of YOUR_TOOLS) assert.ok(list.result.tools.some((t) => t.name === n), n);
    // server/discover and the lists say how long they may be cached (server/utilities/caching)
    const hints = { ttlMs: 0, cacheScope: 'private' };
    for (const [what, r] of [['server/discover', d], ['tools/list', list], ['resources/list', await s.request('rl', 'resources/list', { _meta: META() })], ['prompts/list', await s.request('pl', 'prompts/list', { _meta: META() })]]) {
      assert.deepEqual({ ttlMs: r.result.ttlMs, cacheScope: r.result.cacheScope }, hints, what);
      assert.equal(r.result.resultType, 'complete', what);
    }
    const old = await s.request('rl0', 'resources/list', {});
    assert.deepEqual(old.result, { resources: [] }, 'nothing added in the handshake era');
    const agents = await s.request(2, 'tools/call', { name: 'sphere_agents', arguments: {}, _meta: META() });
    assert.equal(agents.result.resultType, 'complete');
    assert.equal(agents.result.ttlMs, undefined, 'a tool call is not cached');
    assert.equal(agents.result._meta[SERVER_INFO].name, 'obysphere');
    assert.match(text(agents), /"handle": "bob"/);
    const use = await s.request('u', 'tools/call', { name: 'sphere_use', arguments: {}, _meta: META() });
    assert.ok(!use.result.isError, text(use));
    assert.equal(use.result.resultType, 'complete', "0.3.0's sphere_use, the 2026-07-28 way");
    assert.equal((await s.request(3, 'ping', { _meta: META() })).error.code, -32601, '2026-07-28 has no ping');
    const unsupported = await s.request(4, 'tools/list', { _meta: META('1900-01-01') });
    assert.deepEqual(unsupported.error, { code: -32022, message: 'Unsupported protocol version', data: { supported: d.result.supportedVersions, requested: '1900-01-01' } });
    assert.equal((await s.request(5, 'tools/list', { _meta: META(20260728) })).error.code, -32602, 'a version is a string');
    assert.equal((await s.request(6, 'tools/list', { _meta: META(MODERN, null) })).error.code, -32602, 'clientCapabilities is required');
    assert.equal((await s.request(7, 'server/discover', { _meta: META(MODERN, null) })).error.code, -32602);
    assert.equal((await s.request(8, 'tools/call', { name: 'sphere_nope', arguments: {}, _meta: META() })).error.code, -32602);
    // a request that names a handshake version is served the way that version is
    const legacy = await s.request(9, 'tools/list', { _meta: META('2025-11-25') });
    assert.equal(legacy.result.resultType, undefined);
    assert.ok(legacy.result.tools.length >= YOUR_TOOLS.length);
    await done(s);
  });

  test('a client of both eras: no version, no server/discover; then the handshake, and both at once', async () => {
    const s = samSession();
    assert.equal((await s.request(1, 'server/discover', {})).error.code, -32601, 'a probe without a version falls back');
    const r = await init(s, 2);
    assert.equal(r.result.protocolVersion, '2025-11-25');
    assert.equal(r.result.capabilities.experimental, undefined, "sam's channel is off");
    const d = await s.request(3, 'server/discover', { _meta: META() });
    assert.equal(d.result.resultType, 'complete');
    await done(s);
  });

  test("with the channel on, server/discover isn't answered, so an app of both eras starts with initialize and gets the channel", async () => {
    // An app that speaks both eras probes with server/discover and stays on 2026-07-28 when it's
    // answered, or when it gets a 2026-07-28 error (-32022, -32602). Claude Code then turns the
    // channel off. "Method not found" sends it to initialize, as 0.3.0 did.
    const s = session();
    for (const [id, meta] of [['d1', META()], ['d2', META('1900-01-01')], ['d3', META(MODERN, null)], ['d4', META(20260728)]]) {
      const r = await s.request(id, 'server/discover', { _meta: meta });
      assert.equal(r.error?.code, -32601, `${id}: ${JSON.stringify(r)}`);
      assert.equal(r.result, undefined);
    }
    const r = await init(s, 1);
    assert.equal(r.result.protocolVersion, '2025-11-25');
    assert.deepEqual(r.result.capabilities.experimental, { 'claude/channel': {} }, 'the channel, as in 0.3.0');
    assert.match(r.result.instructions, /<channel source="obysphere"/);
    // a request that names 2026-07-28 without the probe is still served that way
    const list = await s.request(2, 'tools/list', { _meta: META() });
    assert.equal(list.result.resultType, 'complete');
    assert.equal(list.result.cacheScope, 'private');
    for (const n of YOUR_TOOLS) assert.ok(list.result.tools.some((t) => t.name === n), n);
    await done(s);
  });

  // ---------------------------------------------------------------- tool schemas

  test('every tool schema passes the strict checks: your session, an answering one, GitHub, the plugin', async () => {
    const pluginDir = path.join(tmp, 'plugin');
    for (const d of ['bin', 'home', 'app', 'profiles']) fs.mkdirSync(path.join(pluginDir, d), { recursive: true });
    const pluginEnv = { PATH: path.join(pluginDir, 'bin'), HOME: path.join(pluginDir, 'home'), USERPROFILE: path.join(pluginDir, 'home'), OBYSPHERE_APP_HOME: path.join(pluginDir, 'app'), OBYSPHERE_HOME: path.join(pluginDir, 'profiles'), ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) };
    const answering = { SPHERE_OUTBOX: outbox, SPHERE_DEPTH: '1' };
    const cases = [
      ['your session', session(), YOUR_TOOLS],
      ['an answering session', session(['--profile', 'alice', '--as-session'], answering), ANSWERING_TOOLS],
      ['an answering session with GitHub on', session(['--profile', 'sam', '--as-session'], answering, solo), [...ANSWERING_TOOLS, ...GITHUB_TOOLS]],
      ["the plugin's setup server", track(mcpSession([PLUGIN_MCP], pluginEnv)), ['obysphere_setup']],
    ];
    for (const [what, s, want] of cases) {
      let id = 0;
      for (const params of [{}, { _meta: META() }]) {
        const r = await s.request(++id, 'tools/list', params);
        assert.ok(r.result, `${what}: ${JSON.stringify(r)}`);
        const { tools } = r.result;
        for (const n of want) assert.ok(tools.some((t) => t.name === n), `${what}: ${n}`);
        assert.equal(new Set(tools.map((t) => t.name)).size, tools.length, `${what}: names are different`);
        for (const t of tools) assert.deepEqual(toolProblems(t), [], `${what}: ${t.name}`);
      }
      await done(s);
    }
  });

  test('the strict checks catch what the apps refuse', () => {
    const ok = { name: 'x', description: 'd', inputSchema: { type: 'object', properties: { a: { type: 'string', description: 'a' } }, required: ['a'] } };
    assert.deepEqual(toolProblems(ok), []);
    const broken = [
      { ...ok, name: 'has space' },
      { ...ok, name: 'a'.repeat(60) },
      { ...ok, description: '' },
      { ...ok, extra: 1 },
      { ...ok, inputSchema: { type: 'object' } },
      { ...ok, inputSchema: { type: 'string', properties: {} } },
      { ...ok, inputSchema: { type: 'object', properties: { a: { type: 'array', description: 'a' } } } },
      { ...ok, inputSchema: { type: 'object', properties: { a: { description: 'a' } } } },
      { ...ok, inputSchema: { type: 'object', properties: { a: { type: ['string', 'null'], description: 'a' } } } },
      { ...ok, inputSchema: { type: 'object', properties: { a: { anyOf: [{ type: 'string' }], description: 'a' } } } },
      { ...ok, inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {} } },
      { ...ok, inputSchema: { type: 'object', properties: {}, required: ['b'] } },
      { ...ok, inputSchema: { type: 'object', properties: { a: { type: 'string' } } } },
      { ...ok, inputSchema: { type: 'object', properties: { a: { type: 'string', enum: [], description: 'a' } } } },
      { ...ok, inputSchema: { type: 'object', properties: { a: { type: 'string', enum: [1], description: 'a' } } } },
    ];
    for (const t of broken) assert.notDeepEqual(toolProblems(t), [], JSON.stringify(t));
  });

  // ---------------------------------------------------------------- cancelling, and the end of a session

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

    const ask = (s, id, { token, wait = 10 } = {}) => s.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'sphere_ask', arguments: { agent: 'bob', message: `still there? (${id})`, wait_seconds: wait }, ...(token ? { _meta: { progressToken: token } } : {}) } });

    test('notifications/cancelled: no answer and no progress for that request, and its id is free again', async () => {
      const s = session();
      await init(s, 1, '2025-06-18');
      s.notify('notifications/initialized');
      ask(s, 7, { token: 'progress-7' }); // cancelled, and it reports progress
      ask(s, 11); // cancelled, no progress asked for
      ask(s, 9, { token: 'progress-9' }); // not cancelled
      await sleep(600);
      s.notify('notifications/cancelled', { requestId: 7, reason: 'the person pressed Esc' });
      s.notify('notifications/cancelled', { requestId: 11 });
      s.notify('notifications/cancelled', { requestId: '9' }); // a string: not request 9
      s.notify('notifications/cancelled', { requestId: 12345, reason: 'never sent' });
      const cancelledAt = Date.now();
      assert.deepEqual((await s.request(7, 'ping')).result, {}, 'a new request may use id 7 at once');
      const nine = await s.waitFor(s.answerTo(9), 25000);
      assert.match(text(nine), /No reply from @bob after 10s/);
      assert.ok(s.msgs.some((x) => x.m.method === 'notifications/progress' && x.m.params.progressToken === 'progress-9'), 'the other one reports progress');
      await sleep(1500);
      assert.equal(s.msgs.filter((x) => x.m.id === 7).length, 1, "only the ping's answer has id 7");
      assert.ok(!s.msgs.some((x) => x.m.id === 11), 'no answer for the cancelled one without progress');
      assert.ok(!s.msgs.some((x) => x.at > cancelledAt && x.m.method === 'notifications/progress' && x.m.params.progressToken === 'progress-7'), 'no progress after cancelling');
      await done(s);
    });

    test('a cancelled request in a batch: the array comes without it, at once', async () => {
      const s = session();
      await init(s, 1, '2025-03-26');
      s.send([
        { jsonrpc: '2.0', id: 'b1', method: 'tools/call', params: { name: 'sphere_ask', arguments: { agent: 'bob', message: 'in a batch', wait_seconds: 30 } } },
        { jsonrpc: '2.0', id: 'b2', method: 'ping' },
      ]);
      await sleep(600);
      assert.ok(!s.msgs.some((x) => Array.isArray(x.m)), 'the batch waits for b1');
      const t0 = Date.now();
      s.notify('notifications/cancelled', { requestId: 'b1' });
      const arr = await s.waitFor((m) => Array.isArray(m), 5000);
      assert.deepEqual(arr, [{ jsonrpc: '2.0', id: 'b2', result: {} }]);
      assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
      await done(s);
    });

    test('stdin closing ends the session at once, even with an ask still waiting', async () => {
      const s = session();
      await init(s, 1);
      ask(s, 2, { wait: 30 });
      await sleep(600);
      const t0 = Date.now();
      s.end();
      const ex = await exitWithin(s);
      assert.equal(ex.code, 0);
      assert.ok(ex.at - t0 < 3000, `${ex.at - t0} ms`);
    });

    test('the app no longer reading ends the session with 0', async () => {
      const s = session();
      await init(s, 1);
      ask(s, 2, { wait: 30 });
      await sleep(300);
      s.p.stdout.destroy();
      s.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
      const ex = await exitWithin(s);
      assert.equal(ex.code, 0, s.stderr().slice(-1000));
    });
  });
});
