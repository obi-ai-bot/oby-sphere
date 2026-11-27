// GitHub and pull request reviews, end to end, with a fake gh and fake runtimes (no network,
// no model): settings.github and its checks, which repositories are allowed (listed, or a
// GitHub remote of your folders), gh's sign-in (GET /local/github, rep.mjs github status),
// what the answering session is given (its GitHub tools, whom it may act for, the shell's
// denials), github_pr read through gh and fenced, approve never / ask / trusted, the item in
// Waiting for you and each decision (approve on GitHub, post as a comment instead, don't),
// the reply in the ask's thread, an injection in a body staying one argv element, and merge
// (never by default; with ask, only the commit read). `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { makeFakeRuntimes } from './fake-runtimes.mjs';
import { makeFakeGh } from './fake-gh.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const KEY = 'join-key-github-0123456789ab';
const ADMIN = 'admin-key-github-0123456789ab';
const HEAD = 'abc1234def5678';
const SIGNED = "— written by Bob Test's Oby";
const APPROVED = "— written by Bob Test's Oby, approved by Bob Test";
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(100);
  }
};

describe('GitHub: settings, pull request tools, and approvals that wait for you', () => {
  let tmp, base, home, payments, tools, cfg, fake, gh, ids, uiBase, serve, serveOut = '';
  const procs = [];
  const env = () => ({ ...process.env, PATH: `${gh.dir}${path.delimiter}${process.env.PATH}`, OBYSPHERE_HOME: home, CLAUDE_CONFIG_DIR: cfg, OBYSPHERE_APPROVE_WAIT_SEC: '60', OBYSPHERE_CHROME: '0', OBYSPHERE_PROBE_CACHE_MS: '0' });
  const rep = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), ...args], { env: env() });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      const t = setTimeout(() => p.kill(), 30000);
      p.on('close', (code) => {
        clearTimeout(t);
        resolve({ out: out + err, stdout: out, code });
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
  const settings = (github = {}, over = {}) => ({
    version: 2,
    routing: { default: { runtime: 'claude', model: 'sonnet' } },
    access: { default: 'answer', agents: { carol: 'trust' }, hops: 'answer', ...over.access },
    machine: { folders: [{ path: payments, write: true }, { path: tools, write: false }], shell: 'full', web: { fetch: false, search: false }, ...over.machine },
    github: { enabled: true, repos: ['acme-labs/*'], ...github },
  });
  const writeSettings = (s) => fs.writeFileSync(settingsPath(), JSON.stringify(s), { mode: 0o600 });

  // an ask to bob, answered by the fake Claude Code; what that run was given
  const ask = async (from, text) => {
    const before = fake.calls().length;
    const m = (await call('POST', '/api/messages', { tok: token(from), body: { channel: 'general', text, to: [ids.bob] } })).message;
    assert.ok(m, 'asked');
    await until(async () => ((await call('GET', `/api/messages/${m.id}/replies?wait=2`, { tok: token(from) })).replies || []).some((r) => r.from === ids.bob), `bob answers ${m.id}\n${serveOut.slice(-2000)}`);
    assert.equal(fake.calls().length, before + 1, 'one run');
    return { m, run: fake.calls().at(-1) };
  };
  const replies = async (m, from = 'alice') => ((await call('GET', `/api/messages/${m.id}/replies`, { tok: token(from) })).replies || []).filter((r) => r.from === ids.bob);
  // the answering session's own MCP server, started as Claude Code would start it (from the config it was given)
  const session = (run, extra = {}) => {
    const cfgS = run.mcp.mcpServers.obysphere;
    // (gh's sign-in is looked at again at every call here: OBYSPHERE_PROBE_CACHE_MS, as in the other tests)
    const p = spawn(cfgS.command, cfgS.args, { env: { PATH: env().PATH, HOME: process.env.HOME, OBYSPHERE_PROBE_CACHE_MS: '0', ...cfgS.env, ...extra } });
    procs.push(p);
    let buf = '';
    let n = 0;
    const waiting = new Map();
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const msg = JSON.parse(line);
          waiting.get(msg.id)?.(msg);
        } catch {}
      }
    });
    const rpc = (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++n;
        waiting.set(id, resolve);
        p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    return {
      tools: async () => (await rpc('tools/list')).result.tools.map((t) => t.name),
      call: async (name, args) => {
        const r = await rpc('tools/call', { name, arguments: args });
        return { text: r.result?.content?.[0]?.text ?? r.error?.message ?? '', isError: !!(r.result?.isError || r.error) };
      },
      close: () => p.kill(),
    };
  };
  const waitingItem = (askId) => until(async () => ((await local('GET', '/local/pending')).pending || []).find((w) => w.kind === 'github' && w.askId === askId), `a GitHub item for ${askId}\n${serveOut.slice(-2000)}`);
  const threadSays = (m, re, from = 'alice') => until(async () => (await replies(m, from)).find((r) => re.test(r.text)), `a reply matching ${re}\n${serveOut.slice(-2000)}`);

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-github-')));
    const data = path.join(tmp, 'relay');
    home = path.join(tmp, 'reps');
    payments = path.join(tmp, 'work', 'payments');
    tools = path.join(tmp, 'work', 'tools');
    cfg = path.join(tmp, 'claude-config');
    for (const d of [data, home, payments, path.join(tools, 'cli'), path.join(tools, 'notes'), cfg]) fs.mkdirSync(d, { recursive: true });
    // a git repository with a GitHub remote (ssh form), and one inside the tools folder (https form)
    const git = (cwd, ...args) => assert.equal(spawnSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tmp, 'no-gitconfig') } }).status, 0, `git ${args.join(' ')}`);
    git(payments, 'init', '-q');
    git(payments, 'remote', 'add', 'origin', 'git@github.com:acme/payments.git');
    git(path.join(tools, 'cli'), 'init', '-q');
    git(path.join(tools, 'cli'), 'remote', 'add', 'upstream', 'https://github.com/acme/cli.git');
    git(path.join(tools, 'cli'), 'remote', 'add', 'mirror', 'https://gitlab.example.com/acme/cli.git');
    fake = makeFakeRuntimes(path.join(tmp, 'bin'));
    gh = makeFakeGh(path.join(tmp, 'gh-bin'));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    procs.push(spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', data], { env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_STORE: 'fs', SPHERE_ASKS_PER_MIN: '1000', SPHERE_WRITES_PER_MIN: '1000' }, stdio: 'ignore' }));
    await until(async () => (await fetch(base + '/healthz').catch(() => null))?.ok, 'the relay starts');
    for (const [n, cwd] of [['alice', tools], ['bob', payments], ['carol', tools]]) {
      const { out } = await rep(['join', `${base}/#key=${KEY}`, '--name', n, '--owner', `${n[0].toUpperCase() + n.slice(1)} Test`, '--cwd', cwd]);
      assert.match(out, /joined/, out);
    }
    const prof = path.join(home, 'bob', 'profile.json');
    fs.writeFileSync(prof, JSON.stringify({ ...JSON.parse(fs.readFileSync(prof, 'utf8')), claudeBin: fake.claude, codexBin: fake.codex, cursorBin: fake.cursor }), { mode: 0o600 });
    const { agents } = await call('GET', '/api/agents', { key: KEY });
    ids = Object.fromEntries(agents.map((a) => [a.name, a.id]));
    const uiPort = await freePort();
    uiBase = `http://127.0.0.1:${uiPort}`;
    procs.push(spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'ui', '--profile', 'bob', '--port', String(uiPort)], { env: env(), stdio: 'ignore' }));
    await until(async () => (await fetch(uiBase + '/favicon.svg').catch(() => null))?.ok, 'the console starts');
  });
  after(() => {
    for (const p of procs) p.kill();
    if (!process.env.SPHERE_TEST_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('settings.github: the defaults when it is missing, and checks that name the field', async () => {
    let r = await rep(['settings', '--profile', 'bob', '--json']);
    assert.deepEqual(JSON.parse(r.stdout).github, { enabled: false, repos: [], read: true, comment: 'ask', requestChanges: 'ask', approve: 'ask', merge: 'never', push: 'never', protected: ['main', 'master', 'release/*'], signature: true });
    r = await rep(['settings', '--profile', 'bob']);
    assert.match(r.out, /GitHub\n {2}off: your Oby has no GitHub tools/);
    const bad = async (github, field, words) => {
      const x = await local('PUT', '/local/settings', { settings: { ...settings(), github } });
      assert.equal(x.status, 400, JSON.stringify(x));
      assert.equal(x.field, field, JSON.stringify(x));
      if (words) assert.match(x.error, words);
    };
    await bad({ approve: 'always' }, 'github.approve', /is never, ask or trusted, not "always"/);
    await bad({ merge: 'trusted' }, 'github.merge', /is never or ask/);
    await bad({ push: 'trusted' }, 'github.push', /is never or ask/);
    await bad({ comment: true }, 'github.comment');
    await bad({ repos: ['acme'] }, 'github.repos[0]', /owner\/name/);
    await bad({ repos: ['acme/ok', '*/*'] }, 'github.repos[1]');
    await bad({ repos: ['acme/..'] }, 'github.repos[0]');
    await bad({ repos: ['acme/x y'] }, 'github.repos[0]');
    await bad({ repos: 'acme/*' }, 'github.repos', /is a list/);
    await bad({ enabled: 'yes' }, 'github.enabled', /true or false/);
    await bad({ protected: ['--force'] }, 'github.protected[0]', /branch/);
    await bad({ protected: ['main,master'] }, 'github.protected[0]');
    await bad({ colour: 'blue' }, 'github.colour', /isn't a setting \(github has enabled, repos/);
    await bad([], 'github');
    // what passes is saved whole: the defaults filled in, repeats dropped
    const ok = await local('PUT', '/local/settings', { settings: { ...settings(), github: { enabled: true, repos: ['acme-labs/*', 'ACME-LABS/*', ' acme/payments '], approve: 'trusted', protected: null } } });
    assert.equal(ok.status, 200, JSON.stringify(ok));
    assert.deepEqual(ok.settings.github, { enabled: true, repos: ['acme-labs/*', 'acme/payments'], read: true, comment: 'ask', requestChanges: 'ask', approve: 'trusted', merge: 'never', push: 'never', protected: ['main', 'master', 'release/*'], signature: true });
    r = await rep(['settings', '--profile', 'bob']);
    assert.match(r.out, /GitHub\n {2}on, through gh as you · repositories: acme-labs\/\*, acme\/payments, and your folders' GitHub remotes/);
    assert.match(r.out, /approve: on its own for Obys you trust/);
  });

  test("gh's sign-in: GET /local/github and rep.mjs github status (signed in, signed out, not installed)", async () => {
    writeSettings(settings());
    assert.equal((await local('GET', '/local/github', undefined, {})).status, 403, 'only this console');
    let st = await local('GET', '/local/github');
    assert.equal(st.status, 200);
    assert.deepEqual(st.gh, { installed: true, version: '2.99.0', signedIn: true, login: 'octo-bob', install: null, signIn: null });
    assert.equal(st.enabled, true);
    assert.deepEqual(st.folderRepos, ['acme/payments', 'acme/cli'], "each folder's own remote, and those of the folders right inside it (GitHub only)");
    assert.ok(!JSON.stringify(st).includes('gho_'), 'never the token');
    const r = await rep(['github', 'status', '--profile', 'bob']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /bob on GitHub: signed in to GitHub as octo-bob \(gh 2\.99\.0\)/);
    assert.match(r.out, /your folders' GitHub remotes: acme\/payments, acme\/cli/);
    assert.ok(!r.out.includes('gho_'));
    assert.deepEqual(JSON.parse((await rep(['github', 'status', '--profile', 'bob', '--json'])).stdout).gh.login, 'octo-bob');
    gh.control({ signedIn: false });
    st = await local('GET', '/local/github');
    assert.deepEqual([st.gh.installed, st.gh.signedIn, st.gh.login, st.gh.signIn], [true, false, null, 'gh auth login']);
    assert.match((await rep(['github', 'status', '--profile', 'bob'])).out, /not signed in: gh auth login/);
    gh.control({ missing: true });
    st = await local('GET', '/local/github');
    assert.deepEqual([st.gh.installed, st.gh.signedIn, st.gh.signIn], [false, false, null]);
    assert.ok(st.gh.install, 'how to install it');
    gh.control({});
    for (const c of gh.calls()) {
      assert.ok(!c.envKeys.some((k) => /^(OBYSPHERE|SPHERE)_/.test(k)), 'gh gets none of the Sphere’s variables');
      assert.ok(c.envKeys.includes('GH_PROMPT_DISABLED'), 'gh never prompts');
    }
  });

  test('the answering session: its GitHub tools only when GitHub is on, whom it may act for, and what the shell may not do', async () => {
    writeSettings(settings({ enabled: false }));
    serve = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'serve', '--profile', 'bob'], { env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
    procs.push(serve);
    serve.stdout.on('data', (d) => (serveOut += d));
    serve.stderr.on('data', (d) => (serveOut += d));
    await until(() => /is online/.test(serveOut), 'serve is online');

    // GitHub off: no tools, nothing in the instructions; the full shell still never pushes to a protected branch
    let { run } = await ask('carol', 'hello');
    assert.ok(!('SPHERE_REP_PID' in run.mcp.mcpServers.obysphere.env));
    assert.ok(!/github_/.test(run.system));
    let deny = run.settings.permissions.deny;
    for (const d of ['Bash(git push * main)', 'Bash(git push *:master)', 'Bash(git push * release/*)', 'Bash(git push *refs/heads/main)', 'Bash(git -C * push * main)', 'Bash(git push *--all*)', 'Bash(git push *--mirror*)']) assert.ok(deny.includes(d), `denies ${d}`);
    assert.ok(!deny.includes('Bash(gh *)') && !deny.includes('Bash(git push *)'), 'GitHub off: gh and other pushes stay with the shell');
    assert.ok(run.argv[run.argv.indexOf('--disallowedTools') + 1].includes('Bash(git push * main)'), 'on the command line too');
    let s = session(run);
    assert.deepEqual((await s.tools()).filter((t) => t.startsWith('github_')), []);
    s.close();

    // GitHub on: the tools, the instructions, and whether the asker is one you trust, for itself
    writeSettings(settings({ approve: 'trusted' }));
    ({ run } = await ask('carol', 'please review acme/payments#7'));
    const e = run.mcp.mcpServers.obysphere.env;
    assert.deepEqual([e.SPHERE_REP_PID, e.SPHERE_GITHUB_TRUST], [String(serve.pid), '1']);
    assert.match(run.system, /- GitHub: github_pr, github_review, github_comment read and act on pull requests as your owner[^\n]*say so plainly in your answer instead of saying you can't do it\./);
    deny = run.settings.permissions.deny;
    for (const d of ['Bash(gh)', 'Bash(gh *)', 'Bash(git push)', 'Bash(git push *)', 'Bash(git -C * push *)']) assert.ok(deny.includes(d), `denies ${d}`);
    s = session(run);
    // (sphere_ask_owner: the ask it answers can go to its owner, test/ask-owner.test.mjs)
    assert.deepEqual(await s.tools(), ['sphere_agents', 'sphere_ask', 'sphere_read', 'sphere_use', 'sphere_ask_owner', 'sphere_attach', 'github_pr', 'github_review', 'github_comment']);
    s.close();
    ({ run } = await ask('alice', 'please review acme/payments#7'));
    assert.equal(run.mcp.mcpServers.obysphere.env.SPHERE_GITHUB_TRUST, '0', 'an Oby you do not trust');
    assert.ok(!run.settings.permissions.allow.includes('Bash'), "and it doesn't get the full shell either");
    // a trusted Oby's ask passed on for someone else: not trusted for GitHub either
    const toCarol = (await call('POST', '/api/messages', { tok: token('alice'), body: { channel: 'general', text: 'carol, check with bob', to: [ids.carol] } })).message;
    const before = fake.calls().length;
    const hop = (await call('POST', '/api/messages', { tok: token('carol'), body: { channel: 'general', text: 'what does bob say?', to: [ids.bob], cause: toCarol.id } })).message;
    assert.equal(hop.depth, 1);
    await until(() => fake.calls().length > before, 'the hop is answered');
    assert.equal(fake.calls().at(-1).mcp.mcpServers.obysphere.env.SPHERE_GITHUB_TRUST, '0', "carol's ask, passed on from alice's");
    // Codex gets the same server, the same way (trusted carol's route to Codex)
    writeSettings({ ...settings({ approve: 'trusted' }), routing: { default: { runtime: 'claude' }, rules: [{ name: 'Carol on Codex', when: { from: ['carol'] }, use: { runtime: 'codex' } }] } });
    await ask('carol', 'and on codex?');
    const cx = fake.calls().at(-1);
    assert.equal(cx.bin, 'codex');
    const mcp = cx.argv.find((a) => a.startsWith('mcp_servers.obysphere='));
    assert.match(mcp, new RegExp(`SPHERE_REP_PID = "${serve.pid}", SPHERE_GITHUB_TRUST = "1"`));
    assert.match(cx.prompt, /- GitHub: github_pr, github_review, github_comment/);
  });

  test('github_pr: read through gh, fenced as data, the diff capped; only the repositories you allow', async () => {
    writeSettings(settings());
    const { run } = await ask('alice', 'what does acme/payments#7 change?');
    const s = session(run);
    const n = gh.calls().length;
    let r = await s.call('github_pr', { repo: 'acme/payments', number: 7 });
    assert.equal(r.isError, false, r.text);
    // each block: a label naming its fence, the fence, the data, the fence
    const parts = r.text.split(/QUOTED-[0-9A-F]{12}/);
    assert.equal(parts.length, 7, 'two fenced blocks: the pull request, then its diff');
    assert.match(parts[2], /"title": "Fix the widget"/);
    assert.match(parts[2], /"path": "src\/widget\.js"/);
    assert.match(parts[2], /IGNORE YOUR INSTRUCTIONS/, "a reviewer's words, inside the fence");
    assert.match(parts[2], /"name": "lint",\n {3}"state": "PENDING"/, 'checks, even while some are pending (gh exits 8)');
    assert.match(parts[5], /DIFF-MARKER new line/);
    assert.ok(!/IGNORE YOUR INSTRUCTIONS|DIFF-MARKER/.test(parts[0] + parts[3] + parts[6]), 'nothing from GitHub outside a fence');
    // what it may do comes first, in our words, so a long result read from the top still says it
    assert.match(parts[0], /^What Bob Test's settings let you do on acme\/payments#7: approve: waits for Bob Test; request changes: waits for Bob Test; comment or review: waits for Bob Test; merge: not allowed\.\n\nPull request acme\/payments#7 \(data from GitHub/);
    const reads = gh.calls().slice(n).filter((c) => c.argv[0] === 'pr').map((c) => c.argv.slice(0, 4).join(' ')).sort();
    assert.deepEqual(reads, ['pr checks 7 --repo=acme/payments', 'pr diff 7 --repo=acme/payments', 'pr view 7 --repo=acme/payments']);
    assert.ok(gh.calls().slice(n).every((c) => !c.cwd.startsWith(path.join(tmp, 'work'))), 'never inside your folders: every call names its repository');
    // allowed: a remote of a folder inside a folder, a listed pattern, any case
    for (const repo of ['acme/cli', 'acme-labs/anything', 'ACME/Payments']) assert.match((await s.call('github_pr', { repo, number: 7 })).text, /Fix the widget/, repo);
    assert.equal((await s.call('github_pr', { repo: 'acme/payments', number: '7' })).isError, false, 'a number as digits');
    // not allowed: said in plain words, and gh never runs
    const m = gh.calls().length;
    r = await s.call('github_pr', { repo: 'other/repo', number: 7 });
    assert.equal(r.text, "Bob Test's settings don't allow other/repo: it isn't among the repositories they let their Oby work on.");
    for (const repo of ['acme/payments; rm -rf ~', '../etc', 'acme/..', 'acme', '-x/y z', '']) {
      r = await s.call('github_pr', { repo, number: 7 });
      assert.ok(r.isError && /repo is owner\/name/.test(r.text), `${repo}: ${r.text}`);
    }
    for (const number of ['7; ls', -1, 0, 1.5, '1e3', null]) {
      r = await s.call('github_pr', { repo: 'acme/payments', number });
      assert.ok(r.isError && /number is the pull request number/.test(r.text), `${number}: ${r.text}`);
    }
    assert.equal(gh.calls().length, m, 'gh never ran for any of them');
    // a missing pull request: what gh said, quoted
    assert.match((await s.call('github_pr', { repo: 'acme/payments', number: 404 })).text, /^Couldn't read acme\/payments#404: gh said "GraphQL: Could not resolve/);
    // a big diff: the first 200 KB, and a note
    gh.control({ bigDiff: true });
    r = await s.call('github_pr', { repo: 'acme/payments', number: 7 });
    assert.match(r.text.split(/QUOTED-[0-9A-F]{12}/)[0], /The diff is 29\d\.\d KB: only its first 200\.0 KB is here, cut mid-file/, 'the note before the data');
    const diff = r.text.split(/QUOTED-[0-9A-F]{12}/)[5];
    assert.ok(diff.length <= 200 * 1024 + 2 && diff.length > 190 * 1024, String(diff.length));
    gh.control({});
    // reading off
    writeSettings(settings({ read: false }));
    assert.equal((await s.call('github_pr', { repo: 'acme/payments', number: 7 })).text, "Bob Test's settings don't allow reading pull requests.");
    // gh signed out, or not installed: said so
    writeSettings(settings());
    gh.control({ signedIn: false });
    assert.match((await s.call('github_pr', { repo: 'acme/payments', number: 7 })).text, /gh isn't signed in to GitHub on this machine \(gh auth login\)/);
    gh.control({ missing: true });
    assert.match((await s.call('github_pr', { repo: 'acme/payments', number: 7 })).text, /gh \(GitHub's command line\) isn't installed on this machine/);
    gh.control({});
    // GitHub turned off while the session runs: the next call says so
    writeSettings(settings({ enabled: false }));
    assert.equal((await s.call('github_pr', { repo: 'acme/payments', number: 7 })).text, "Bob Test's settings don't allow GitHub.");
    s.close();
  });

  test('approve: never, on its own for an Oby you trust, and otherwise it waits for you', async () => {
    // never
    writeSettings(settings({ approve: 'never' }));
    let { run } = await ask('carol', 'approve acme/payments#7 please');
    let s = session(run);
    const w0 = gh.writes().length;
    let r = await s.call('github_review', { repo: 'acme/payments', number: 7, event: 'APPROVE', body: 'LGTM' });
    assert.equal(r.text, "Bob Test's settings don't allow approving pull requests, so nothing was posted on acme/payments#7.");
    assert.equal(gh.writes().length, w0);
    // a comment still asks; a bad event is an error
    assert.ok((await s.call('github_review', { repo: 'acme/payments', number: 7, event: 'MERGE', body: 'x' })).isError);
    assert.ok((await s.call('github_comment', { repo: 'acme/payments', number: 7, body: '' })).isError, 'a comment needs words');
    assert.ok((await s.call('github_comment', { repo: 'acme/payments', number: 7, body: 'x'.repeat(20001) })).isError, 'at most 20,000 characters');
    s.close();

    // trusted, for carol (trusted, asking for herself): at once, signed as her Oby's, on the commit read
    writeSettings(settings({ approve: 'trusted' }));
    ({ run } = await ask('carol', 'approve acme/payments#7 please'));
    s = session(run);
    await s.call('github_pr', { repo: 'acme/payments', number: 7 });
    r = await s.call('github_review', { repo: 'acme/payments', number: 7, event: 'approve', body: 'LGTM' });
    assert.equal(r.text, 'Done: approved acme/payments#7 on GitHub, as Bob Test, signed as written by their Oby.');
    const v = reviewVars(gh.writes().at(-1).argv);
    assert.deepEqual([v.pr, v.event, v.commit, v.body], ['PR_kwFAKE7', 'APPROVE', HEAD, `LGTM\n\n${SIGNED}`]);
    // no words: the signature alone; signature off: nothing
    await s.call('github_review', { repo: 'acme/payments', number: 7, event: 'APPROVE' });
    assert.equal(reviewVars(gh.writes().at(-1).argv).body, SIGNED);
    writeSettings(settings({ approve: 'trusted', signature: false }));
    await s.call('github_review', { repo: 'acme/payments', number: 7, event: 'APPROVE' });
    assert.ok(!('body' in reviewVars(gh.writes().at(-1).argv)), 'no body at all');
    // GitHub refusing it: said, nothing claimed
    gh.control({ failWrites: true });
    r = await s.call('github_review', { repo: 'acme/payments', number: 7, event: 'APPROVE', body: 'LGTM' });
    assert.match(r.text, /^GitHub didn't take it: gh said "gh: Resource not accessible/);
    gh.control({});
    // a closed pull request: nothing to do
    gh.control({ state: 'MERGED' });
    assert.match((await s.call('github_review', { repo: 'acme/payments', number: 7, event: 'APPROVE' })).text, /acme\/payments#7 is merged, so there's nothing to approve/);
    gh.control({});
    s.close();

    // trusted, for alice (not trusted): it waits for you, and nothing is posted yet
    writeSettings(settings({ approve: 'trusted' }));
    let m;
    ({ m, run } = await ask('alice', 'approve acme/payments#7 please'));
    s = session(run);
    await s.call('github_pr', { repo: 'acme/payments', number: 7 });
    const w1 = gh.writes().length;
    r = await s.call('github_review', { repo: 'acme/payments', number: 7, event: 'APPROVE', body: 'Looks right to me.' });
    assert.match(r.text, /^This waits for Bob Test: it's in their Waiting for you now/);
    assert.match(r.text, /say plainly that it waits for Bob Test\.$/);
    const w = await waitingItem(m.id);
    assert.equal(gh.writes().length, w1, 'nothing posted while it waits');
    assert.deepEqual(w.from, { name: 'alice', owner: 'Alice Test' });
    await local('POST', `/local/pending/${w.id}`, { decision: 'decline' });
    await threadSays(m, /^Bob Test chose not to approve acme\/payments#7 on GitHub\.$/);
    s.close();
  });

  test('Waiting for you: approve on GitHub, post as a comment instead, or don’t; checked again, then said in the thread', async () => {
    writeSettings(settings());
    let { m, run } = await ask('alice', 'Could you approve acme/payments#7 if it looks right?');
    let s = session(run);
    await s.call('github_pr', { repo: 'acme/payments', number: 7 });
    let r = await s.call('github_review', { repo: 'acme/payments', number: 7, event: 'APPROVE', body: 'Looks right to me: the fix matches the issue.' });
    assert.match(r.text, /waits for Bob Test/);
    let w = await waitingItem(m.id);
    assert.deepEqual(
      { kind: w.kind, from: w.from, channel: w.channel, text: w.text, options: w.options, signed: w.signed, reason: w.reason },
      { kind: 'github', from: { name: 'alice', owner: 'Alice Test' }, channel: 'general', text: 'Looks right to me: the fix matches the issue.', options: ['act', 'comment', 'decline'], signed: APPROVED, reason: 'github' },
    );
    assert.deepEqual(
      { ...w.github },
      { action: 'review', repo: 'acme/payments', number: 7, event: 'APPROVE', method: null, title: 'Fix the widget', author: 'sam', base: 'main', head: HEAD, url: 'https://github.com/acme/payments/pull/7', verb: 'approve', button: 'Approve on GitHub' },
    );
    assert.match(serveOut, /alice's ask: your Oby would approve acme\/payments#7 on GitHub \(Fix the widget\)/);
    // the decisions it takes
    assert.equal((await local('POST', `/local/pending/${w.id}`, { decision: 'answer' })).status, 400);
    assert.equal((await local('POST', `/local/pending/${w.id}`, { decision: 'nope' })).status, 400);
    // approve on GitHub: the review on the commit read, signed as approved by you
    assert.deepEqual(await local('POST', `/local/pending/${w.id}`, { decision: 'act' }), { status: 200, ok: true });
    const reply = await threadSays(m, /^Bob Test approved acme\/payments#7 on GitHub\.$/);
    assert.equal(reply.meta.answeredBy, 'owner');
    const v = reviewVars(gh.writes().at(-1).argv);
    assert.deepEqual([v.pr, v.event, v.commit, v.body], ['PR_kwFAKE7', 'APPROVE', HEAD, `Looks right to me: the fix matches the issue.\n\n${APPROVED}`]);
    assert.equal((await local('POST', `/local/pending/${w.id}`, { decision: 'act' })).status, 404, 'decided once');
    assert.deepEqual((await local('GET', '/local/pending')).pending.filter((x) => x.kind === 'github'), []);

    // post it as a comment instead
    ({ m, run } = await ask('alice', 'and #8?'));
    s.close();
    s = session(run);
    await s.call('github_pr', { repo: 'acme/payments', number: 8 });
    await s.call('github_review', { repo: 'acme/payments', number: 8, event: 'REQUEST_CHANGES', body: 'The test misses the empty case.' });
    w = await waitingItem(m.id);
    assert.deepEqual([w.github.button, w.options], ['Request changes on GitHub', ['act', 'comment', 'decline']]);
    await local('POST', `/local/pending/${w.id}`, { decision: 'comment' });
    await threadSays(m, /^Bob Test posted the review on acme\/payments#8 as a comment, not as a request for changes\.$/);
    assert.deepEqual(gh.writes().at(-1).argv, ['pr', 'comment', '8', '--repo=acme/payments', `--body=The test misses the empty case.\n\n${APPROVED}`]);

    // new commits since your Oby read it: nothing is approved
    ({ m, run } = await ask('alice', 'and #9?'));
    s.close();
    s = session(run);
    await s.call('github_pr', { repo: 'acme/payments', number: 9 });
    await s.call('github_review', { repo: 'acme/payments', number: 9, event: 'APPROVE' });
    w = await waitingItem(m.id);
    assert.deepEqual(w.options, ['act', 'decline'], 'no words to post as a comment');
    gh.control({ head: 'fff0000aaa1111' });
    const before = gh.writes().length;
    await local('POST', `/local/pending/${w.id}`, { decision: 'act' });
    await threadSays(m, /^acme\/payments#9 has new commits since Bob Test's Oby read it, so nothing was posted: ask again for a fresh look\.$/);
    assert.equal(gh.writes().length, before);
    gh.control({});

    // settings changed while it waited: checked again
    ({ m, run } = await ask('alice', 'and #10?'));
    s.close();
    s = session(run);
    await s.call('github_comment', { repo: 'acme/payments', number: 10, body: 'Nice.' });
    w = await waitingItem(m.id);
    assert.deepEqual([w.github.button, w.options], ['Post the comment', ['act', 'decline']]);
    writeSettings(settings({ comment: 'never' }));
    await local('POST', `/local/pending/${w.id}`, { decision: 'act' });
    await threadSays(m, /^Bob Test's settings don't allow this any more, so nothing was posted on acme\/payments#10\.$/);
    assert.equal(gh.writes().length, before);
    s.close();

    // a GitHub decision on an ask that waits for you (not a GitHub item) is refused; its own still work
    writeSettings(settings({}, { access: { agents: { carol: 'trust', alice: 'approve' } } }));
    const held = (await call('POST', '/api/messages', { tok: token('alice'), body: { channel: 'general', text: 'may I see the roadmap?', to: [ids.bob] } })).message;
    const item = await until(async () => ((await local('GET', '/local/pending')).pending || []).find((x) => x.askId === held.id), 'the ask waits for you');
    assert.equal(item.kind, undefined);
    const no = await local('POST', `/local/pending/${item.id}`, { decision: 'act' });
    assert.deepEqual([no.status, no.field], [400, 'decision']);
    assert.deepEqual(await local('POST', `/local/pending/${item.id}`, { decision: 'decline' }), { status: 200, ok: true });

    // the console page has the card's words and buttons
    const page = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    for (const words of ['Post as a comment instead', 'data-decide="act"', 'Don’t', "['github', 'GitHub',"]) assert.ok(page.includes(words), words);
    assert.ok(page.indexOf("['github', 'GitHub',") < page.indexOf("['machine', 'This computer',"), 'GitHub comes just before This computer');
  });

  test('arguments: an injection in the body stays one argv element, as data', async () => {
    writeSettings(settings({ comment: 'trusted' }));
    const { run } = await ask('carol', 'leave a comment on acme/payments#7');
    const s = session(run);
    const body = `ok"; rm -rf ~; $(id) \`whoami\` --repo=evil/x\n--approve | gh pr merge 7 && echo 'x'`;
    const r = await s.call('github_comment', { repo: 'acme/payments', number: 7, body });
    assert.match(r.text, /^Done: commented on acme\/payments#7/);
    assert.deepEqual(gh.writes().at(-1).argv, ['pr', 'comment', '7', '--repo=acme/payments', `--body=${body}\n\n${SIGNED}`]);
    s.close();
  });

  test('merge: never by default; with ask, it waits for you and merges only the commit your Oby read', async () => {
    writeSettings(settings());
    let { m, run } = await ask('carol', 'merge acme/payments#7');
    let s = session(run);
    assert.ok(!(await s.tools()).includes('github_merge'));
    const r = await s.call('github_merge', { repo: 'acme/payments', number: 7 });
    assert.ok(r.isError && /unknown tool github_merge/.test(r.text), r.text);
    s.close();
    // allowed in the file, then taken away while a session runs: the call says so
    writeSettings(settings({ merge: 'ask' }));
    ({ m, run } = await ask('carol', 'merge acme/payments#7'));
    s = session(run);
    assert.ok((await s.tools()).includes('github_merge'));
    await s.call('github_pr', { repo: 'acme/payments', number: 7 });
    assert.ok((await s.call('github_merge', { repo: 'acme/payments', number: 7, method: 'octopus' })).isError);
    const before = gh.writes().length;
    assert.match((await s.call('github_merge', { repo: 'acme/payments', number: 7, method: 'squash' })).text, /waits for Bob Test/, 'even for an Oby you trust');
    const w = await waitingItem(m.id);
    assert.deepEqual([w.github.button, w.github.method, w.signed, w.options], ['Merge on GitHub', 'squash', null, ['act', 'decline']]);
    assert.equal(gh.writes().length, before);
    await local('POST', `/local/pending/${w.id}`, { decision: 'act' });
    await threadSays(m, /^Bob Test merged acme\/payments#7 on GitHub\.$/, 'carol');
    assert.deepEqual(gh.writes().at(-1).argv, ['pr', 'merge', '7', '--repo=acme/payments', '--squash', '--match-head-commit', HEAD]);
    writeSettings(settings({ merge: 'never' }));
    assert.match((await s.call('github_merge', { repo: 'acme/payments', number: 7 })).text, /don't allow merging pull requests/);
    s.close();
  });

  test('an approval or a merge covers the commit github_pr read: with new commits since, or no commit known, nothing is posted', async () => {
    writeSettings(settings({ approve: 'trusted', merge: 'ask' }));
    const { run } = await ask('carol', 'review and approve acme/payments#7');
    const s = session(run);
    assert.match((await s.call('github_pr', { repo: 'acme/payments', number: 7 })).text, /"headCommit": "abc1234def5678"/);
    // a commit pushed after your Oby read it: neither approved at once nor put in Waiting for you
    gh.control({ head: 'fff0000aaa1111' });
    const before = gh.writes().length;
    let r = await s.call('github_review', { repo: 'acme/payments', number: 7, event: 'APPROVE', body: 'LGTM' });
    assert.equal(r.text, 'acme/payments#7 has new commits since you read it (abc1234 then, fff0000 now), so nothing was posted. Read it again with github_pr before you approve it.');
    r = await s.call('github_merge', { repo: 'ACME/payments', number: 7 });
    assert.match(r.text, /^ACME\/payments#7 has new commits since you read it .* before you merge it\.$/, 'the same pull request, in any case');
    assert.equal(gh.writes().length, before);
    await sleep(1500); // a request is taken into Waiting for you within a second
    assert.deepEqual((await local('GET', '/local/pending')).pending.filter((x) => x.kind === 'github'), [], 'nothing waits for you');
    // read again: the approval goes
    await s.call('github_pr', { repo: 'acme/payments', number: 7 });
    assert.match((await s.call('github_review', { repo: 'acme/payments', number: 7, event: 'APPROVE', body: 'LGTM' })).text, /^Done: approved acme\/payments#7/);
    assert.equal(gh.writes().length, before + 1);
    // a head commit gh doesn't give as one: nothing is approved
    gh.control({ head: 'not-a-commit' });
    r = await s.call('github_review', { repo: 'acme/payments', number: 7, event: 'APPROVE' });
    assert.equal(r.text, "Couldn't tell which commit acme/payments#7 is at, so nothing was posted.");
    assert.equal(gh.writes().length, before + 1);
    gh.control({});
    s.close();
  });

  // a review's variables, as the GraphQL mutation gets them (one --raw-field=name=value each)
  const reviewVars = (argv) => Object.fromEntries(argv.slice(2).map((x) => /^--raw-field=([^=]+)=([\s\S]*)$/.exec(x)).filter(Boolean).map((m) => [m[1], m[2]]));

  test("an approval or a merge needs github_pr's read in this ask: none, or another ask's, posts nothing; the read lasts for the ask, and the review names the commit read", async () => {
    writeSettings(settings({ approve: 'trusted', merge: 'ask' }));
    const { m, run } = await ask('carol', 'approve acme/payments#7 if it looks right');
    let s = session(run);
    const before = gh.writes().length;
    // never read in this ask: nothing is approved, merged or put in Waiting for you
    let r = await s.call('github_review', { repo: 'acme/payments', number: 7, event: 'APPROVE', body: 'LGTM' });
    assert.equal(r.text, "You haven't read acme/payments#7 in this ask: read it with github_pr first (an approval covers only the commit you read). Nothing was posted.");
    r = await s.call('github_review', { repo: 'acme/payments', number: 7, event: 'REQUEST_CHANGES', body: 'Not yet.' });
    assert.match(r.text, /^You haven't read acme\/payments#7 in this ask/);
    r = await s.call('github_merge', { repo: 'acme/payments', number: 7 });
    assert.match(r.text, /^You haven't read acme\/payments#7 in this ask: read it with github_pr first \(a merge covers only the commit you read\)/);
    assert.equal(gh.writes().length, before);
    await sleep(1500);
    assert.deepEqual((await local('GET', '/local/pending')).pending.filter((x) => x.kind === 'github'), [], 'nothing waits for you');
    // read, in one process of the session; the approval, in another (as after a restart): the read holds for the ask
    assert.match((await s.call('github_pr', { repo: 'acme/payments', number: 7 })).text, /"headCommit": "abc1234def5678"/);
    s.close();
    const kept = path.join(home, 'bob', 'github-read', `${m.id}.json`);
    assert.equal(fs.statSync(kept).mode & 0o777, 0o600, 'kept for the ask, 0600');
    s = session(run);
    r = await s.call('github_review', { repo: 'acme/payments', number: 7, event: 'APPROVE', body: 'LGTM' });
    assert.equal(r.text, 'Done: approved acme/payments#7 on GitHub, as Bob Test, signed as written by their Oby.');
    // the review is GraphQL's addPullRequestReview, on the commit read: never gh pr review, which takes whatever the head is then
    const w = gh.writes().at(-1).argv;
    assert.deepEqual(w.slice(0, 2), ['api', 'graphql']);
    const v = reviewVars(w);
    assert.match(v.query, /addPullRequestReview\(input: \{ pullRequestId: \$pr, event: \$event, commitOID: \$commit, body: \$body \}\)/);
    assert.deepEqual([v.pr, v.event, v.commit, v.body], ['PR_kwFAKE7', 'APPROVE', HEAD, `LGTM\n\n${SIGNED}`]);
    s.close();
    // another ask (a conversation resumed, say): its own read is needed
    const next = await ask('carol', 'and approve it once more?');
    s = session(next.run);
    r = await s.call('github_review', { repo: 'acme/payments', number: 7, event: 'APPROVE' });
    assert.match(r.text, /^You haven't read acme\/payments#7 in this ask/);
    // a comment, or a review that only comments, needs no read
    writeSettings(settings({ approve: 'trusted', comment: 'trusted' }));
    assert.match((await s.call('github_comment', { repo: 'acme/payments', number: 7, body: 'Seen.' })).text, /^Done: commented on/);
    assert.match((await s.call('github_review', { repo: 'acme/payments', number: 7, event: 'COMMENT', body: 'A note.' })).text, /^Done: posted a review on/);
    assert.equal(reviewVars(gh.writes().at(-1).argv).commit, HEAD, 'on the commit it is at now');
    s.close();
  });

  test('a GitHub item from a hop says so in Waiting for you', async () => {
    writeSettings(settings());
    const toCarol = (await call('POST', '/api/messages', { tok: token('alice'), body: { channel: 'general', text: 'carol, ask bob to approve #7', to: [ids.carol] } })).message;
    const before = fake.calls().length;
    const hop = (await call('POST', '/api/messages', { tok: token('carol'), body: { channel: 'general', text: 'approve acme/payments#7?', to: [ids.bob], cause: toCarol.id } })).message;
    await until(() => fake.calls().length > before, 'the hop is answered');
    const s = session(fake.calls().at(-1));
    await s.call('github_pr', { repo: 'acme/payments', number: 7 });
    assert.match((await s.call('github_review', { repo: 'acme/payments', number: 7, event: 'APPROVE', body: 'Fine.' })).text, /waits for Bob Test/);
    const w = await waitingItem(hop.id);
    assert.deepEqual([w.from.name, w.depth], ['carol', 1]);
    await local('POST', `/local/pending/${w.id}`, { decision: 'decline' });
    s.close();
  });

  test("Waiting for you names the asker your representative checked, and the reply goes to the ask's thread, whatever the relay says later", async () => {
    // erin's Sphere address is a proxy that forges the one ask it's asked for again: alice's, in another channel
    const forged = new Set();
    const relay = new URL(base);
    const proxy = http.createServer((req, res) => {
      const forge = req.method === 'GET' && /^\/api\/messages\/m_[\w-]+$/.test(req.url);
      const up = http.request({ host: relay.hostname, port: relay.port, path: req.url, method: req.method, headers: { ...req.headers, host: relay.host } }, (r) => {
        if (!forge || r.statusCode !== 200) {
          res.writeHead(r.statusCode, r.headers);
          return r.pipe(res);
        }
        let b = '';
        r.on('data', (d) => (b += d));
        r.on('end', () => {
          const j = JSON.parse(b);
          if (j.message) {
            forged.add(j.message.id);
            Object.assign(j.message, { from: ids.alice, channel: 'elsewhere' });
          }
          const out = JSON.stringify(j);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(out) });
          res.end(out);
        });
      });
      up.on('error', () => res.destroy());
      req.pipe(up);
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    try {
      const { out } = await rep(['join', `http://127.0.0.1:${proxy.address().port}/#key=${KEY}`, '--name', 'erin', '--owner', 'Erin Test', '--cwd', payments]);
      assert.match(out, /joined/, out);
      const prof = path.join(home, 'erin', 'profile.json');
      fs.writeFileSync(prof, JSON.stringify({ ...JSON.parse(fs.readFileSync(prof, 'utf8')), claudeBin: fake.claude, codexBin: fake.codex, cursorBin: fake.cursor }), { mode: 0o600 });
      fs.writeFileSync(path.join(home, 'erin', 'settings.json'), JSON.stringify(settings()), { mode: 0o600 });
      const erin = JSON.parse(fs.readFileSync(prof, 'utf8')).agent.id;
      let erinOut = '';
      const serveErin = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'serve', '--profile', 'erin'], { env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
      procs.push(serveErin);
      serveErin.stdout.on('data', (d) => (erinOut += d));
      serveErin.stderr.on('data', (d) => (erinOut += d));
      await until(() => /is online/.test(erinOut), 'erin is online');
      // carol asks erin; erin's Oby agrees, and its approval waits for Erin
      const m = (await call('POST', '/api/messages', { tok: token('carol'), body: { channel: 'general', text: 'approve acme/payments#7?', to: [erin] } })).message;
      await until(async () => ((await call('GET', `/api/messages/${m.id}/replies?wait=2`, { tok: token('carol') })).replies || []).some((x) => x.from === erin), `erin answers\n${erinOut.slice(-2000)}`);
      const run = fake.calls().findLast((c) => c.mcp?.mcpServers?.obysphere?.args?.includes('erin'));
      assert.equal(run.mcp.mcpServers.obysphere.env.SPHERE_GITHUB_ASKER, ids.carol);
      const s = session(run);
      await s.call('github_pr', { repo: 'acme/payments', number: 7 });
      assert.match((await s.call('github_review', { repo: 'acme/payments', number: 7, event: 'APPROVE', body: 'Fine by me.' })).text, /waits for Erin Test/);
      const dir = path.join(home, 'erin', 'pending');
      const w = await until(() => (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((n) => /^w_[0-9a-f]{12}\.json$/.test(n)).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))).find((x) => x.kind === 'github'), `erin's GitHub item\n${erinOut.slice(-2000)}`);
      assert.deepEqual([w.askId, w.from, w.channel], [m.id, { name: 'carol', owner: 'Carol Test' }, 'general'], 'carol, as erin saw her ask: not the relay’s alice');
      fs.writeFileSync(path.join(dir, `${w.id}.decision.json`), JSON.stringify({ decision: 'decline' }), { flag: 'wx', mode: 0o600 });
      const said = await until(async () => ((await call('GET', `/api/messages/${m.id}/replies`, { tok: token('carol') })).replies || []).find((x) => x.from === erin && /chose not to approve/.test(x.text)), `erin's reply\n${erinOut.slice(-2000)}`);
      assert.deepEqual([said.channel, said.text], ['general', 'Erin Test chose not to approve acme/payments#7 on GitHub.']);
      assert.ok(!forged.has(m.id), 'the relay was never asked for the ask again');
      s.close();
      serveErin.kill();
    } finally {
      proxy.close();
      proxy.closeAllConnections?.();
    }
  });

  test('at most 20 GitHub items wait for you per asker: one asker filling them leaves room for the others', async () => {
    writeSettings(settings());
    // twenty of alice's already wait (as her asks' sessions would have queued them for this serve)
    const dir = path.join(home, 'bob', 'github');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 20; i++) {
      const rid = `g_${String(i).padStart(12, '0')}`;
      fs.writeFileSync(path.join(dir, `${rid}.json`), JSON.stringify({ rid, action: 'comment', repo: 'acme/payments', number: 100 + i, event: null, method: null, body: `note ${i}`, repPid: serve.pid, asker: ids.alice, askId: null, channel: 'general', sealed: false, createdAt: new Date().toISOString() }), { mode: 0o600 });
    }
    await until(async () => (await local('GET', '/local/pending')).pending.filter((x) => x.kind === 'github').length === 20, 'twenty items wait');
    let { run } = await ask('alice', 'comment on #7 too');
    let s = session(run);
    assert.equal((await s.call('github_comment', { repo: 'acme/payments', number: 7, body: 'One more.' })).text, "20 of this asker's GitHub actions already wait for Bob Test: nothing more is added for it until they decide those. Nothing was posted.");
    s.close();
    ({ run } = await ask('carol', 'comment on #7 please'));
    s = session(run);
    assert.match((await s.call('github_comment', { repo: 'acme/payments', number: 7, body: 'From carol.' })).text, /^This waits for Bob Test/, "carol's still goes in");
    s.close();
    for (const w of (await local('GET', '/local/pending')).pending.filter((x) => x.kind === 'github')) await local('POST', `/local/pending/${w.id}`, { decision: 'decline' });
  });
});
