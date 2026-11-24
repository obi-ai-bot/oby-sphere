// Your Oby's settings, end to end, with fake runtimes (no model, no network): the
// first settings.json, validation that names the field, routing to a runtime and
// model (and every flag it maps to), what the answering session may touch, access
// (decline, approve and each decision, topics, files, hops, both limits), the
// waiting queue across two processes, the console's local API and its checks, and
// that the relay never receives paths, rules, words or per-agent lists. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { makeFakeRuntimes } from './fake-runtimes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const KEY = 'join-key-settings-0123456789';
const ADMIN = 'admin-key-settings-0123456789';
const RULES = 'RULES-TOKEN-5521: never name customers.';
const KEYWORD_ONLY = 'kwonlytoken';
const TOPIC_ONLY = 'topiconlytoken';
const GHOST = 'ghost-agent-77';
const WAIT_SEC = 6;
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("your Oby's settings", () => {
  let relay, base, data, home, work, payments, web, cfg, fake, ids, uiBase, serveOut = '';
  const procs = [];
  const env = () => ({ ...process.env, OBYSPHERE_HOME: home, CLAUDE_CONFIG_DIR: cfg, OBYSPHERE_APPROVE_WAIT_SEC: String(WAIT_SEC), OBYSPHERE_CHROME: '1' });
  const rep = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), ...args], { env: env() });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      const t = setTimeout(() => p.kill(), 30000);
      p.on('close', (code) => {
        clearTimeout(t);
        resolve({ out, code });
      });
    });
  const token = (n) => JSON.parse(fs.readFileSync(path.join(home, n, 'profile.json'), 'utf8')).token;
  const call = async (method, url, { tok, key, body, at = base, headers = {} } = {}) => {
    const h = { ...headers };
    if (tok) h.authorization = `Bearer ${tok}`;
    if (key) h['x-sphere-key'] = key;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(at + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const local = (method, url, body, headers = { 'x-obysphere-console': '1' }) => call(method, url, { at: uiBase, body, headers });
  const settingsPath = () => path.join(home, 'bob', 'settings.json');
  const writeSettings = (s) => fs.writeFileSync(settingsPath(), JSON.stringify(s), { mode: 0o600 });
  const full = (over = {}) => ({
    version: 1,
    routing: {
      default: { runtime: 'claude', model: 'sonnet', effort: null, maxBudgetUsd: 0.5 },
      rules: [
        { name: 'Code reviews', when: { from: [], keywords: ['review', 'pull request', KEYWORD_ONLY], hasFiles: null, hop: null, channel: null }, use: { runtime: 'claude', model: 'opus', effort: 'high', maxBudgetUsd: 2 } },
        { name: 'Carol on Cursor', when: { from: ['carol'] }, use: { runtime: 'cursor', model: 'gpt-5' } },
        { name: 'Files', when: { hasFiles: true }, use: { runtime: 'claude', model: 'haiku' } },
        { name: 'Hops', when: { hop: true }, use: { runtime: 'claude', model: 'fable' } },
        { name: 'Ops', when: { channel: 'ops' }, use: { runtime: 'claude', model: 'claude-opus-5-5', effort: 'max' } },
      ],
    },
    access: { default: 'answer', agents: { [GHOST]: 'decline' }, acceptFiles: true, sendFiles: true, consultOthers: true, acceptHops: true, declineTopics: [TOPIC_ONLY], asksPerAgentPerDay: 0, budgetUsdPerDay: 0, rules: RULES, ...over.access },
    machine: { folders: [{ path: payments, write: false }, { path: web, write: true }], shell: 'read', web: { fetch: true, search: false }, browser: 'off', mcp: ['linear'], ...over.machine },
  });
  // an ask to bob over the relay's API; files are uploaded first
  const ask = async (from, text, { channel = 'general', files = [], cause } = {}) => {
    const tok = token(from);
    const up = [];
    for (const f of files) {
      const r = await fetch(base + '/api/files', { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'text/plain', 'x-file-name': f.name }, body: f.data });
      up.push({ id: (await r.json()).file.id });
    }
    const r = await call('POST', '/api/messages', { tok, body: { channel, text, to: [ids.bob], files: up, ...(cause ? { cause } : {}) } });
    assert.ok(r.message, JSON.stringify(r));
    return r.message;
  };
  const replyTo = async (m, from) => {
    for (let i = 0; i < 40; i++) {
      const r = await call('GET', `/api/messages/${m.id}/replies?wait=3`, { tok: token(from) });
      const x = (r.replies || []).find((y) => y.from === ids.bob);
      if (x) return x;
    }
    throw new Error(`no reply to ${m.id}\n${serveOut.slice(-3000)}`);
  };
  const lastCall = () => fake.calls().at(-1);
  const flagOf = (c, f) => {
    const i = c.argv.indexOf(f);
    return i >= 0 ? c.argv[i + 1] : undefined;
  };
  const answered = async (from, text, opts) => {
    const before = fake.calls().length;
    const r = await replyTo(await ask(from, text, opts), from);
    assert.ok(!r.meta?.declined, `answered, not declined: ${r.text}`);
    assert.equal(fake.calls().length, before + 1, 'one run of the runtime');
    return { reply: r, call: lastCall() };
  };
  const declined = async (from, text, words, opts) => {
    const before = fake.calls().length;
    const r = await replyTo(await ask(from, text, opts), from);
    assert.equal(r.meta?.declined, true, `declined: ${r.text}`);
    assert.match(r.text, /^Bob Test's Oby isn't taking this ask: /);
    if (words) assert.match(r.text, words);
    assert.equal(fake.calls().length, before, 'no runtime ran');
    return r;
  };

  before(async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-settings-')));
    data = path.join(tmp, 'relay');
    home = path.join(tmp, 'reps');
    work = path.join(tmp, 'work');
    payments = path.join(work, 'payments');
    web = path.join(work, 'web');
    cfg = path.join(tmp, 'claude-config');
    for (const d of [data, home, payments, web, cfg]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(payments, 'README.md'), '# payments\n');
    // the owner's own Claude Code MCP servers (user scope), with secrets that must stay put
    fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.example/mcp', headers: { Authorization: 'Bearer LINEAR-SECRET-123' } }, notes: { command: 'node', args: ['notes.js'], env: { NOTES_TOKEN: 'NOTES-SECRET-456' } } }, projects: {} }));
    fake = makeFakeRuntimes(path.join(tmp, 'bin'));
    fake.control({ cost: 0.01, cursorSignedIn: true });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    relay = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', data], {
      env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_STORE: 'fs', SPHERE_ASKS_PER_MIN: '1000', SPHERE_WRITES_PER_MIN: '1000' },
      stdio: process.env.SPHERE_TEST_DEBUG ? 'inherit' : 'ignore',
    });
    procs.push(relay);
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
      await sleep(100);
    }
  });
  after(() => {
    for (const p of procs) p.kill();
    if (!process.env.SPHERE_TEST_KEEP) fs.rmSync(path.dirname(data), { recursive: true, force: true });
  });

  test('joining writes settings.json (0600) from the flags', async () => {
    for (const [n, cwd] of [['alice', work], ['bob', payments], ['carol', work]]) {
      const { out } = await rep(['join', `${base}/#key=${KEY}`, '--name', n, '--owner', `${n[0].toUpperCase() + n.slice(1)} Test`, '--cwd', cwd]);
      assert.match(out, /joined/, out);
      assert.match(out, /Settings: .*settings\.json/);
    }
    const { agents } = await call('GET', '/api/agents', { key: KEY });
    ids = Object.fromEntries(agents.map((a) => [a.name, a.id]));
    const prof = JSON.parse(fs.readFileSync(path.join(home, 'bob', 'profile.json'), 'utf8'));
    fs.writeFileSync(path.join(home, 'bob', 'profile.json'), JSON.stringify({ ...prof, claudeBin: fake.claude, cursorBin: fake.cursor }), { mode: 0o600 });
    assert.equal(fs.statSync(settingsPath()).mode & 0o777, 0o600);
    const s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    assert.equal(s.version, 1);
    assert.deepEqual(s.machine.folders, [{ path: payments, write: false }]);
    assert.equal(s.routing.default.runtime, 'claude');
    assert.equal(s.machine.shell, 'off');
    const { out } = await rep(['settings', '--profile', 'bob']);
    assert.ok(out.includes(settingsPath()), out);
    assert.match(out, /Who answers[\s\S]*What other Obys may ask[\s\S]*What it may touch on this machine/);
  });

  test("an older profile's fields become its first settings.json", async () => {
    const { out } = await rep(['join', `${base}/#key=${KEY}`, '--name', 'dave', '--owner', 'Dave Test', '--cwd', work, '--runtime', 'cursor', '--model', 'gpt-5', '--rules', 'Be brief.', '--allow', 'Bash,WebFetch,Edit', '--approve']);
    assert.match(out, /joined/, out);
    fs.rmSync(path.join(home, 'dave', 'settings.json')); // as a profile from before settings
    const r = await rep(['settings', '--profile', 'dave', '--json']);
    const s = JSON.parse(r.out);
    assert.deepEqual(s.routing.default, { runtime: 'cursor', model: 'gpt-5', effort: null, maxBudgetUsd: null });
    assert.equal(s.access.default, 'approve');
    assert.equal(s.access.rules, 'Be brief.');
    assert.deepEqual(s.machine.folders, [{ path: work, write: true }]);
    assert.equal(s.machine.shell, 'full');
    assert.deepEqual(s.machine.web, { fetch: true, search: false });
    assert.ok(fs.existsSync(path.join(home, 'dave', 'settings.json')), 'written on first read');
    assert.equal(fs.statSync(path.join(home, 'dave', 'settings.json')).mode & 0o777, 0o600);
  });

  test("the console's local API: settings, environment, and only for this console", async () => {
    const port = await freePort();
    uiBase = `http://127.0.0.1:${port}`;
    const ui = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'ui', '--profile', 'bob', '--port', String(port)], { env: env(), stdio: 'ignore' });
    procs.push(ui);
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(uiBase + '/favicon.svg')).ok) break; } catch {}
      await sleep(100);
    }
    // the checks: header on GETs too, same site, own origin, own Host
    assert.equal((await local('GET', '/local/settings', undefined, {})).status, 403);
    assert.equal((await local('GET', '/local/settings', undefined, { 'x-obysphere-console': '1', 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await local('PUT', '/local/settings', { settings: full() }, { 'x-obysphere-console': '1', origin: 'http://evil.example' })).status, 403);
    assert.equal((await local('GET', '/local/pending', undefined, { 'x-obysphere-console': '1', 'sec-fetch-site': 'same-site' })).status, 403);
    const rebound = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => s.write(`GET /local/settings HTTP/1.1\r\nHost: evil.example:${port}\r\nx-obysphere-console: 1\r\nConnection: close\r\n\r\n`));
      let buf = '';
      s.on('data', (d) => (buf += d));
      s.on('end', () => resolve(buf));
    });
    assert.match(rebound, /^HTTP\/1\.1 421/);

    const g = await local('GET', '/local/settings');
    assert.equal(g.status, 200);
    assert.equal(g.path, settingsPath());
    assert.equal(g.settings.machine.folders[0].path, payments);

    // validation names the field, in plain words
    const bad = async (mut, field, words) => {
      const s = full();
      mut(s);
      const r = await local('PUT', '/local/settings', { settings: s });
      assert.equal(r.status, 400, JSON.stringify(r));
      assert.equal(r.field, field, JSON.stringify(r));
      if (words) assert.match(r.error, words);
    };
    await bad((s) => (s.machine.folders[0].path = os.homedir()), 'machine.folders[0].path', /home folder/);
    await bad((s) => (s.machine.folders[0].path = '/'), 'machine.folders[0].path', /whole disk/);
    await bad((s) => (s.machine.folders[0].path = path.dirname(os.homedir())), 'machine.folders[0].path', /home folder is inside it/);
    await bad((s) => (s.machine.folders[0].path = path.join(home, 'bob')), 'machine.folders[0].path', /profiles/);
    await bad((s) => (s.machine.folders[0].path = 'relative/folder'), 'machine.folders[0].path', /full path/);
    await bad((s) => (s.machine.folders[0].path = path.join(work, 'missing')), 'machine.folders[0].path', /no folder/);
    await bad((s) => (s.machine.folders = []), 'machine.folders', /at least one/);
    await bad((s) => (s.routing.default.runtime = 'copilot'), 'routing.default.runtime', /claude or cursor/);
    await bad((s) => (s.routing.rules[0].use.effort = 'extreme'), 'routing.rules[0].use.effort', /low, medium, high, xhigh, max/);
    await bad((s) => (s.access.asksPerAgentPerDay = -1), 'access.asksPerAgentPerDay', /negative/);
    await bad((s) => (s.access.budgetUsdPerDay = -5), 'access.budgetUsdPerDay', /negative/);
    await bad((s) => (s.routing.default.maxBudgetUsd = -1), 'routing.default.maxBudgetUsd', /negative/);
    await bad((s) => (s.access.default = 'maybe'), 'access.default', /answer, approve or decline/);
    await bad((s) => (s.machine.shell = 'root'), 'machine.shell', /off, read or full/);
    await bad((s) => (s.machine.mcp = ['nope']), 'machine.mcp[0]', /no MCP server named nope/);
    await bad((s) => (s.routing.default.modle = 'x'), 'routing.default.modle', /isn't a setting/);
    await bad((s) => (s.version = 2), 'version');
    const ok = await local('PUT', '/local/settings', { settings: full() });
    assert.equal(ok.status, 200, JSON.stringify(ok));
    assert.equal(ok.settings.machine.folders[1].write, true);
    assert.equal(fs.statSync(settingsPath()).mode & 0o777, 0o600);

    // this machine: runtimes, MCP servers by name and transport (never their settings), Chrome, home
    const e = await local('GET', '/local/environment');
    assert.equal(e.status, 200);
    const [claude, cursor] = e.runtimes;
    assert.deepEqual([claude.id, claude.installed, claude.version, claude.signedIn], ['claude', true, '9.9.9', true]);
    assert.deepEqual(claude.models.slice(0, 4).map((m) => m.id), ['opus', 'sonnet', 'haiku', 'fable']);
    assert.deepEqual(claude.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual([cursor.id, cursor.installed, cursor.signedIn], ['cursor', true, true]);
    assert.deepEqual(cursor.models.map((m) => m.id), ['gpt-5', 'sonnet-4']);
    assert.deepEqual(e.mcpServers, [{ name: 'linear', transport: 'http' }, { name: 'notes', transport: 'stdio' }]);
    assert.equal(e.chrome.available, true);
    assert.equal(e.home, os.homedir());
    const all = JSON.stringify(e);
    for (const secret of ['LINEAR-SECRET', 'NOTES-SECRET', 'never-shown@example.com', 'mcp.linear.example']) assert.ok(!all.includes(secret), `no ${secret}`);
  });

  test('routing: rules in order, then the default, and each flag they map to', async () => {
    const serve = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'serve', '--profile', 'bob'], { env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
    procs.push(serve);
    serve.stdout.on('data', (d) => (serveOut += d));
    serve.stderr.on('data', (d) => (serveOut += d));
    for (let i = 0; i < 100 && !/is online/.test(serveOut); i++) await sleep(100);
    assert.match(serveOut, /is online/, serveOut);

    let { reply, call: c } = await answered('alice', 'Could you review this diff?');
    assert.equal(c.bin, 'claude');
    assert.equal(flagOf(c, '--model'), 'opus');
    assert.equal(flagOf(c, '--effort'), 'high');
    assert.equal(flagOf(c, '--max-budget-usd'), '2');
    assert.deepEqual([reply.meta.runtime, reply.meta.model, reply.meta.answeredBy], ['claude', 'opus', 'agent']);
    assert.match(reply.text, /fake answer from opus/);
    // the machine: start folder, the others added, the built-in tools, permissions and sandbox
    assert.equal(c.cwd, payments);
    assert.ok(c.argv.includes('--add-dir') && c.argv[c.argv.indexOf('--add-dir') + 1] === web);
    assert.ok(c.argv.includes('--restricted'));
    assert.deepEqual(flagOf(c, '--tools').split(','), ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch']);
    assert.equal(flagOf(c, '--permission-mode'), 'dontAsk');
    assert.ok(c.argv.includes('--no-chrome'));
    const denied = flagOf(c, '--disallowedTools').split(',');
    for (const d of ['Read(**/.env*)', 'Read(**/.ssh/**)', 'Edit(**/.git/**)', 'Edit(**/.env*)', 'Bash(rg *--pre*)', 'Bash(find *-exec*)', 'Bash(git *--output*)', 'WebSearch']) assert.ok(denied.includes(d), `denies ${d}`);
    assert.ok(!denied.includes('Bash') && !denied.includes('Edit') && !denied.includes('WebFetch'));
    assert.equal(flagOf(c, '--allowedTools'), 'mcp__obysphere');
    const allow = c.settings.permissions.allow;
    for (const a of [`Edit(/${web}/**)`, 'Bash(ls:*)', 'Bash(git log:*)', 'Bash(git blame:*)', 'WebFetch', 'mcp__linear']) assert.ok(allow.includes(a), `allows ${a}`);
    assert.ok(!allow.some((a) => a.includes(payments)), 'the read-only folder is never writable');
    assert.ok(!allow.includes('Bash') && !allow.includes('WebSearch'));
    assert.equal(c.settings.permissions.blockReadsOutsideWorkingDirectories, true);
    assert.equal(c.settings.sandbox.enabled, true);
    assert.equal(c.settings.sandbox.failIfUnavailable, true);
    assert.equal(c.settings.sandbox.allowUnsandboxedCommands, false);
    assert.ok(c.settings.sandbox.filesystem.denyRead.includes('**/.env*') && c.settings.sandbox.filesystem.denyRead.includes(home));
    assert.deepEqual(c.settings.sandbox.network.allowedDomains, []);
    // only the named MCP server is copied, with its own settings; the Sphere's tools as allowed
    assert.deepEqual(Object.keys(c.mcp.mcpServers).sort(), ['linear', 'obysphere']);
    assert.equal(c.mcp.mcpServers.linear.headers.Authorization, 'Bearer LINEAR-SECRET-123');
    assert.deepEqual([c.mcp.mcpServers.obysphere.env.SPHERE_ATTACH, c.mcp.mcpServers.obysphere.env.SPHERE_CONSULT], ['1', '1']);
    assert.ok(c.system.includes(RULES), "the owner's rules reach the local model");
    assert.ok(!c.argv.join(' ').includes(RULES), 'never in argv');
    assert.ok(!c.envKeys.some((k) => /^(OBYSPHERE|SPHERE)_/.test(k)), 'the allowlisted environment');
    assert.match(c.prompt, /QUOTED-[0-9A-F]{12}/);
    // the session's files don't stay on disk (they held the MCP server's token)
    assert.ok(!fs.readdirSync(path.join(home, 'bob', 'asks')).some((d) => fs.existsSync(path.join(home, 'bob', 'asks', d, 'mcp.json'))));

    // rule order: carol matches rule 1 before her own rule 2
    ({ call: c } = await answered('carol', 'please look at this pull request'));
    assert.equal(flagOf(c, '--model'), 'opus');
    ({ reply, call: c } = await answered('carol', 'hello there'));
    assert.equal(c.bin, 'cursor');
    assert.deepEqual([flagOf(c, '--mode'), flagOf(c, '--model')], ['ask', 'gpt-5']);
    assert.equal(c.cwd, payments);
    assert.deepEqual([reply.meta.runtime, reply.meta.model], ['cursor', 'gpt-5']);
    ({ call: c } = await answered('alice', 'see attached', { files: [{ name: 'notes.txt', data: 'hello' }] }));
    assert.equal(flagOf(c, '--model'), 'haiku');
    ({ call: c } = await answered('alice', 'status?', { channel: 'ops' }));
    assert.deepEqual([flagOf(c, '--model'), flagOf(c, '--effort')], ['claude-opus-5-5', 'max']);
    ({ call: c } = await answered('alice', 'hello'));
    assert.deepEqual([flagOf(c, '--model'), flagOf(c, '--effort'), flagOf(c, '--max-budget-usd')], ['sonnet', undefined, '0.5']);
    // a hop: alice asks bob while answering carol's ask
    const carolAsk = await call('POST', '/api/messages', { tok: token('carol'), body: { channel: 'general', text: 'alice, ask bob for me', to: [ids.alice] } });
    ({ call: c } = await answered('alice', 'for carol: what do you think?', { cause: carolAsk.message.id }));
    assert.equal(flagOf(c, '--model'), 'fable');
  });

  test('the machine settings: nothing extra, then the browser and the full shell; tools hidden while answering', async () => {
    writeSettings(full({ machine: { folders: [{ path: payments, write: false }], shell: 'off', web: { fetch: false, search: false }, browser: 'chrome', mcp: [] }, access: { sendFiles: false, consultOthers: false } }));
    let { call: c } = await answered('alice', 'hello again');
    const denied = flagOf(c, '--disallowedTools').split(',');
    for (const d of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch']) assert.ok(denied.includes(d), `denies ${d}`);
    assert.deepEqual(flagOf(c, '--tools').split(','), ['Read', 'Glob', 'Grep']);
    assert.ok(c.argv.includes('--chrome') && !c.argv.includes('--no-chrome'));
    assert.ok(c.settings.permissions.allow.includes('mcp__claude-in-chrome'));
    assert.equal(c.settings.sandbox, undefined);
    assert.ok(!c.argv.includes('--add-dir') || c.argv.filter((a) => a === '--add-dir').length === 2, 'only the ask inbox and outbox');
    assert.deepEqual(Object.keys(c.mcp.mcpServers), ['obysphere']);
    assert.deepEqual([c.mcp.mcpServers.obysphere.env.SPHERE_ATTACH, c.mcp.mcpServers.obysphere.env.SPHERE_CONSULT], ['0', '0']);
    assert.match(c.system, /your owner's own Chrome/);
    assert.ok(!/sphere_ask|sphere_attach/.test(c.system));

    writeSettings(full({ machine: { shell: 'full', browser: 'off' } }));
    ({ call: c } = await answered('alice', 'run the tests'));
    assert.ok(c.settings.permissions.allow.includes('Bash'));
    assert.equal(c.settings.sandbox, undefined);
    assert.equal(c.settings.permissions.blockReadsOutsideWorkingDirectories, undefined);
    assert.ok(!flagOf(c, '--disallowedTools').split(',').includes('Bash'));

    // the answering session's own MCP server shows only the tools the settings allow
    const listTools = (extra) =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'mcp', '--profile', 'bob', '--as-session'], { env: { ...env(), SPHERE_OUTBOX: work, ...extra } });
        let buf = '';
        p.stdout.on('data', (d) => {
          buf += d;
          const line = buf.split('\n').find((l) => l.includes('"tools"'));
          if (line) {
            p.kill();
            resolve(JSON.parse(line).result.tools.map((t) => t.name));
          }
        });
        p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
      });
    assert.deepEqual(await listTools({ SPHERE_ATTACH: '0', SPHERE_CONSULT: '0' }), ['sphere_agents', 'sphere_read']);
    assert.deepEqual(await listTools({ SPHERE_ATTACH: '1', SPHERE_CONSULT: '1' }), ['sphere_agents', 'sphere_ask', 'sphere_read', 'sphere_attach']);
  });

  test('access: declined by Oby, topic, files and hops, before any model', async () => {
    writeSettings(full({ access: { agents: { carol: 'decline' }, declineTopics: ['salary', 'hiring plan'] } }));
    await declined('carol', 'hello', /it doesn't take asks from you\.$/);
    await declined('alice', "What's the SALARY band?", /on this topic/);
    await declined('alice', 'any news on the hiring   plan?', /on this topic/);
    await answered('alice', 'is there a nonsalary option?'); // inside another word: not the topic
    writeSettings(full({ access: { acceptFiles: false, acceptHops: false } }));
    await declined('alice', 'see attached', /with files/, { files: [{ name: 'a.txt', data: 'x' }] });
    const carolAsk = await call('POST', '/api/messages', { tok: token('carol'), body: { channel: 'general', text: 'alice, ask bob', to: [ids.alice] } });
    await declined('alice', 'for carol', /passed on from another ask/, { cause: carolAsk.message.id });
    // a settings file that doesn't pass: declined until it's fixed
    writeSettings({ ...full(), machine: { ...full().machine, folders: [{ path: '/' }] } });
    await declined('alice', 'hello', /settings need fixing/);
    const g = await local('GET', '/local/settings');
    assert.equal(g.field, 'machine.folders[0].path');
  });

  test('access: asks per Oby a day, and the day\'s budget (which also caps each answer)', async () => {
    const day = new Date();
    const usage = path.join(home, 'bob', 'usage', `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}.json`);
    fs.rmSync(usage, { force: true });
    writeSettings(full({ access: { asksPerAgentPerDay: 2 } }));
    await answered('carol', 'one');
    await answered('carol', 'two');
    await declined('carol', 'three', /reached its limit for today/);
    await answered('alice', 'alice still may');
    let u = await local('GET', '/local/usage');
    assert.equal(u.asksByAgent.carol, 2);
    assert.equal(u.limits.asksPerAgentPerDay, 2);

    fs.rmSync(usage, { force: true });
    fake.control({ cost: 0.4, cursorSignedIn: true });
    writeSettings(full({ access: { budgetUsdPerDay: 0.5 } }));
    let { call: c } = await answered('alice', 'first');
    assert.equal(flagOf(c, '--max-budget-usd'), '0.5');
    ({ call: c } = await answered('alice', 'second'));
    assert.equal(flagOf(c, '--max-budget-usd'), '0.1', 'capped at what the day has left');
    await declined('alice', 'third', /reached its limit for today/);
    u = await local('GET', '/local/usage');
    assert.equal(u.costUsd, 0.8);
    assert.equal(u.answers, 2);
    assert.equal(fs.statSync(usage).mode & 0o777, 0o600);
    fake.control({ cost: 0.01, cursorSignedIn: true });
    fs.rmSync(usage, { force: true });
  });

  test('approve: the ask waits in the console (another process); answer, decline, write, or no answer', async () => {
    writeSettings(full({ access: { agents: { alice: 'approve' } } }));
    const waiting = async (m) => {
      for (let i = 0; i < 50; i++) {
        const { pending } = await local('GET', '/local/pending');
        const w = (pending || []).find((x) => x.askId === m.id);
        if (w) return w;
        await sleep(100);
      }
      throw new Error('not waiting\n' + serveOut.slice(-2000));
    };
    const runs = () => fake.calls().length;

    // let the Oby answer
    let before = runs();
    let m = await ask('alice', 'may I see the roadmap?', { files: [{ name: 'q.txt', data: 'question' }] });
    let w = await waiting(m);
    assert.equal(w.text, 'may I see the roadmap?');
    assert.deepEqual(w.from, { name: 'alice', owner: 'Alice Test' });
    assert.deepEqual(w.files, [{ name: 'q.txt', size: 8 }]);
    assert.match(w.reason, /alice/);
    assert.equal(runs(), before, 'nothing runs while it waits');
    assert.deepEqual(await local('POST', `/local/pending/${w.id}`, { decision: 'answer' }), { status: 200, ok: true });
    let r = await replyTo(m, 'alice');
    assert.equal(r.meta.answeredBy, 'agent');
    assert.equal(runs(), before + 1);
    assert.equal((await local('POST', `/local/pending/${w.id}`, { decision: 'decline' })).status, 404, 'decided once');

    // decline
    m = await ask('alice', 'and the salaries?');
    w = await waiting(m);
    assert.equal((await local('POST', `/local/pending/${w.id}`, { decision: 'nope' })).status, 400);
    await local('POST', `/local/pending/${w.id}`, { decision: 'decline' });
    r = await replyTo(m, 'alice');
    assert.equal(r.meta.declined, true);
    assert.equal(r.meta.answeredBy, 'owner');
    assert.match(r.text, /its owner declined it/);

    // write the answer yourself
    before = runs();
    m = await ask('alice', 'lunch?');
    w = await waiting(m);
    assert.equal((await local('POST', `/local/pending/${w.id}`, { decision: 'write' })).status, 400, 'write needs text');
    await local('POST', `/local/pending/${w.id}`, { decision: 'write', text: 'Yes, at noon. (Bob himself)' });
    r = await replyTo(m, 'alice');
    assert.equal(r.text, 'Yes, at noon. (Bob himself)');
    assert.equal(r.meta.answeredBy, 'owner');
    assert.equal(runs(), before);

    // no answer within the wait: declined
    m = await ask('alice', 'anyone home?');
    await waiting(m);
    const t0 = Date.now();
    r = await replyTo(m, 'alice');
    assert.match(r.text, /no answer from its owner/);
    assert.ok(Date.now() - t0 < (WAIT_SEC + 6) * 1000);
    assert.deepEqual((await local('GET', '/local/pending')).pending, []);
  });

  test('the relay never receives paths, rules, words or per-agent lists', async () => {
    writeSettings(full({ access: { agents: { [GHOST]: 'approve', carol: 'decline' } } }));
    await sleep(2500); // the representative tells the Sphere what changed
    const { agents } = await call('GET', '/api/agents', { key: KEY });
    const bob = agents.find((a) => a.name === 'bob');
    assert.deepEqual(bob.declared.folders, ['payments', 'web']);
    assert.equal(bob.declared.folder, 'payments');
    assert.deepEqual(bob.declared.tools, ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'shell:read', 'WebFetch', 'mcp']);
    assert.equal(bob.declared.approve, true);
    assert.deepEqual(bob.declared.runtimes, ['claude', 'cursor']);
    assert.equal(bob.declared.model, 'sonnet');
    // everything the relay keeps, and everything it serves about bob
    let all = JSON.stringify(agents);
    const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else all += fs.readFileSync(p, 'latin1'); } };
    walk(data);
    for (const s of [RULES.slice(0, 16), KEYWORD_ONLY, TOPIC_ONLY, GHOST, payments, work, web, home, 'LINEAR-SECRET', 'NOTES-SECRET', 'hiring plan'])
      assert.ok(!all.includes(s), `the relay never has ${JSON.stringify(s)}`);
  });
});

describe('a decline on a sealed Sphere', () => {
  let relay, base, data, home, tmp;
  const procs = [];
  const env = () => ({ ...process.env, OBYSPHERE_HOME: home, OBYSPHERE_CHROME: '0' });
  const rep = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), ...args], { env: env() });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      const t = setTimeout(() => p.kill(), 30000);
      p.on('close', () => {
        clearTimeout(t);
        resolve(out);
      });
    });
  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-settings-sealed-')));
    data = path.join(tmp, 'relay');
    home = path.join(tmp, 'reps');
    for (const d of [data, home, path.join(tmp, 'work')]) fs.mkdirSync(d, { recursive: true });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    relay = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', data], { env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_SEALED: '1', SPHERE_STORE: 'fs' }, stdio: 'ignore' });
    procs.push(relay);
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
      await sleep(100);
    }
  });
  after(() => {
    for (const p of procs) p.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('is sealed for the asker, in neutral words, and says nothing the relay can read', async () => {
    for (const n of ['alice', 'bob']) assert.match(await rep(['join', `${base}/#key=${KEY}`, '--name', n, '--owner', `${n} Sealed`, '--cwd', path.join(tmp, 'work')]), /joined/);
    const f = path.join(home, 'bob', 'settings.json');
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    s.access.declineTopics = ['quarterly numbers'];
    fs.writeFileSync(f, JSON.stringify(s), { mode: 0o600 });
    const serve = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'serve', '--profile', 'bob'], { env: env(), stdio: 'ignore' });
    procs.push(serve);
    await sleep(1500);
    const out = await rep(['ask', 'bob', 'What were the quarterly numbers?', '--profile', 'alice', '--wait', '20']);
    assert.match(out, /"declined": true/, out);
    assert.match(out, /bob Sealed's Oby isn't taking this ask: it doesn't take asks on this topic\./);
    assert.match(out, /"sealed": true/);
    let all = '';
    for (const n of fs.readdirSync(data)) if (fs.statSync(path.join(data, n)).isFile()) all += fs.readFileSync(path.join(data, n), 'latin1');
    assert.ok(!all.includes("isn't taking") && !all.includes('quarterly'), 'the relay holds only envelopes');
  });
});
