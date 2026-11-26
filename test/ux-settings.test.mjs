// The Settings page's usability pass (0.3.x): an Oby you haven't listed waits for you (Ask me
// first) by default, in a new profile and in a file without access.default; GET
// /local/github/repos offers the owner's repositories and their organisations', through a fake
// gh (argv arrays, a time limit, a cache, only checked names, this console only); and the page's
// own controls replace every native select, number, time and checkbox field in Settings. No
// model, no network beyond this machine. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { makeFakeGh } from './fake-gh.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const KEY = 'join-key-ux-settings-0123456789';
const ADMIN = 'admin-key-ux-settings-0123456789';
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(PAGE)[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a free port, never the demo's
const freePort = async () => {
  for (;;) {
    const p = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); }); });
    if (p < 4848 || p > 4851) return p;
  }
};
const until = async (fn, what, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(100);
  }
};
const stopAll = (procs) => Promise.all(procs.map((p) => (p.exitCode !== null || p.signalCode !== null ? null : new Promise((r) => { p.once('exit', r); p.kill(); }))));

describe('Settings, made lean: the default for Obys you haven’t listed, and your repositories from gh', () => {
  let tmp, home, work, base, gh;
  const procs = [];
  const env = (extra = {}) => ({ ...process.env, PATH: `${gh.dir}${path.delimiter}${process.env.PATH}`, OBYSPHERE_HOME: home, OBYSPHERE_CHROME: '0', OBYSPHERE_NO_UPDATE_CHECK: '1', OBYSPHERE_NOTIFY_LOG: path.join(tmp, 'notify.jsonl'), ...extra });
  const rep = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), ...args], { env: env() });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      const t = setTimeout(() => p.kill(), 30000);
      p.on('close', (code) => { clearTimeout(t); resolve({ out, code }); });
    });
  const settingsFile = (n = 'bob') => path.join(home, n, 'settings.json');
  // a console for bob; probe: OBYSPHERE_PROBE_CACHE_MS ('0': gh is asked again every time; unset: the real caches)
  const consoleFor = async (probe) => {
    const port = await freePort();
    const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'ui', '--profile', 'bob', '--port', String(port)], { env: env(probe === undefined ? {} : { OBYSPHERE_PROBE_CACHE_MS: probe }), stdio: 'ignore' });
    procs.push(p);
    const at = `http://127.0.0.1:${port}`;
    await until(async () => (await fetch(at + '/favicon.svg').catch(() => null))?.ok, 'the console starts');
    return async (method, url, body, headers = { 'x-obysphere-console': '1' }) => {
      const h = { ...headers };
      if (body !== undefined) h['content-type'] = 'application/json';
      const r = await fetch(at + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
      return { status: r.status, ...(await r.json().catch(() => ({}))) };
    };
  };
  const repoLists = () => gh.calls().filter((c) => c.argv[0] === 'repo' && c.argv[1] === 'list');

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-ux-settings-')));
    const data = path.join(tmp, 'relay');
    home = path.join(tmp, 'reps');
    work = path.join(tmp, 'work', 'payments');
    for (const d of [data, home, work]) fs.mkdirSync(d, { recursive: true });
    // a folder whose GitHub remote is always allowed
    const git = (...args) => assert.equal(spawnSync('git', args, { cwd: work, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tmp, 'no-gitconfig') } }).status, 0, `git ${args.join(' ')}`);
    git('init', '-q');
    git('remote', 'add', 'origin', 'git@github.com:acme/payments.git');
    gh = makeFakeGh(path.join(tmp, 'gh-bin'));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    procs.push(spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', data, '--name', 'UX Sphere'], { env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_STORE: 'fs', SPHERE_SEALED: '0' }, stdio: 'ignore' }));
    await until(async () => (await fetch(base + '/healthz').catch(() => null))?.ok, 'the relay starts');
  });
  after(async () => {
    await stopAll(procs);
    if (!process.env.SPHERE_TEST_KEEP) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test('a new profile: Obys you haven’t listed wait for you (Ask me first)', async () => {
    const { out, code } = await rep(['join', `${base}/#key=${KEY}`, '--name', 'bob', '--owner', 'Bob Test', '--cwd', work]);
    assert.equal(code, 0, out);
    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    assert.equal(s.access.default, 'approve', 'without --approve too');
    assert.deepEqual(s.access.agents, {});
    const shown = await rep(['settings', '--profile', 'bob']);
    assert.match(shown.out, /anyone not listed: waits for you/);
  });

  test('a file without access.default reads as Ask me first; one that says otherwise is kept', async () => {
    const local = await consoleFor('0');
    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    delete s.access.default;
    fs.writeFileSync(settingsFile(), JSON.stringify(s), { mode: 0o600 });
    let r = await local('GET', '/local/settings');
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(r.settings.access.default, 'approve');
    // saved from the console without one: the same
    const { default: _, ...access } = r.settings.access;
    r = await local('PUT', '/local/settings', { settings: { ...r.settings, access } });
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(r.settings.access.default, 'approve');
    assert.equal(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).access.default, 'approve');
    // a choice stays the owner's
    for (const v of ['answer', 'decline', 'trust', 'approve']) {
      r = await local('PUT', '/local/settings', { settings: { ...r.settings, access: { ...r.settings.access, default: v } } });
      assert.equal(r.settings.access.default, v);
    }
    r = await local('PUT', '/local/settings', { settings: { ...r.settings, access: { ...r.settings.access, default: 'maybe' } } });
    assert.deepEqual([r.status, r.field], [400, 'access.default']);
    // a version 1 file without one moves to version 2 with Ask me first
    const v1 = { version: 1, routing: { default: { runtime: 'claude', model: 'sonnet', maxBudgetUsd: 0 }, rules: [{ name: 'Reviews', when: { keywords: ['review'] }, use: { runtime: 'claude', model: 'opus' } }] }, access: { agents: { carol: 'trust' } }, machine: { folders: [{ path: work, write: false }] } };
    fs.writeFileSync(settingsFile(), JSON.stringify(v1), { mode: 0o600 });
    r = await local('GET', '/local/settings');
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.deepEqual([r.settings.version, r.settings.access.default, r.settings.access.agents], [2, 'approve', { carol: 'trust' }]);
  });

  test('GET /local/github/repos: you and your organisations, their repositories, your folders’ remotes', async () => {
    const local = await consoleFor('0');
    gh.control({ orgs: ['acme', 'acme-labs', '--help', 'bad name', 'ACME'], repos: { 'octo-bob': ['dotfiles', 'web'], acme: ['payments', 'web'], 'acme-labs': ['lab'] } });
    assert.equal((await local('GET', '/local/github/repos', undefined, {})).status, 403, 'only this console');
    assert.equal((await local('GET', '/local/github/repos', undefined, { 'x-obysphere-console': '1', 'sec-fetch-site': 'cross-site' })).status, 403, 'not another site');
    const before = repoLists().length;
    const r = await local('GET', '/local/github/repos');
    assert.equal(r.status, 200, JSON.stringify(r));
    // the signed-in owner first, then each organisation once; a name gh could read as an option, or that isn't a GitHub name, is dropped
    assert.deepEqual(r.owners, ['octo-bob', 'acme', 'acme-labs']);
    assert.deepEqual(r.repos, ['octo-bob/dotfiles', 'octo-bob/web', 'acme/payments', 'acme/web', 'acme-labs/lab']);
    assert.deepEqual(r.folderRepos, ['acme/payments']);
    assert.equal(r.partial, undefined);
    assert.equal(r.error, undefined);
    assert.ok(!Number.isNaN(Date.parse(r.checkedAt)));
    assert.ok(!JSON.stringify(r).includes('gho_'), 'never the token');
    // gh from an argv array: each owner one element, never an option
    const lists = repoLists().slice(before);
    // (several owners at once, so in any order)
    assert.deepEqual(lists.map((c) => c.argv).sort((x, y) => x[2].localeCompare(y[2])), ['acme', 'acme-labs', 'octo-bob'].map((o) => ['repo', 'list', o, '--json', 'nameWithOwner', '--limit', '200', '--no-archived']));
    assert.ok(gh.calls().some((c) => c.argv.join(' ') === 'api user/orgs?per_page=100'));
    assert.ok(!gh.calls().some((c) => c.argv.includes('--help') || c.argv.includes('bad name')));
    // run outside your folders, without the Sphere's variables
    for (const c of lists) {
      assert.ok(!c.cwd.startsWith(work), c.cwd);
      assert.ok(!c.envKeys.some((k) => /^(OBYSPHERE|SPHERE)_/.test(k)), c.envKeys.join(' '));
    }
  });

  test('GET /local/github/repos: what gh couldn’t list is said, never a failure of the page', async () => {
    const local = await consoleFor('0');
    // one owner's list fails: the rest, marked partial
    gh.control({ orgs: ['acme'], failList: 'acme', repos: { 'octo-bob': ['web'] } });
    let r = await local('GET', '/local/github/repos');
    assert.equal(r.status, 200);
    assert.deepEqual([r.owners, r.repos, r.partial], [['octo-bob', 'acme'], ['octo-bob/web'], true]);
    // not signed in, not installed: no list, and why
    gh.control({ signedIn: false });
    r = await local('GET', '/local/github/repos');
    assert.equal(r.status, 200);
    assert.deepEqual([r.owners, r.repos], [[], []]);
    assert.match(r.error, /gh isn't signed in to GitHub on this machine \(gh auth login\)/);
    gh.control({ missing: true });
    r = await local('GET', '/local/github/repos');
    assert.match(r.error, /gh isn't installed on this machine/);
    assert.deepEqual(r.folderRepos, ['acme/payments'], 'your folders’ remotes all the same');
    gh.control({});
  });

  test('GET /local/github/repos is kept: gh is asked once, not at every look', async () => {
    const local = await consoleFor(undefined);
    gh.control({ orgs: ['acme'], repos: { acme: ['web'] } });
    const before = repoLists().length;
    const a = await local('GET', '/local/github/repos');
    const b = await local('GET', '/local/github/repos');
    assert.deepEqual(a.repos, ['octo-bob/web', 'octo-bob/api', 'acme/web']);
    assert.deepEqual(b.repos, a.repos);
    assert.equal(b.checkedAt, a.checkedAt);
    assert.equal(repoLists().length - before, 2, 'one list for each owner, once');
  });
});

describe("the Settings page's controls", () => {
  // a declaration out of the page's script, by its braces
  const fnSource = (name) => {
    const start = SCRIPT.search(new RegExp(`\\n  (?:async )?function ${name}\\(`));
    assert.ok(start >= 0, `${name} is in the page`);
    let depth = 0;
    for (let i = SCRIPT.indexOf('{', start); i < SCRIPT.length; i++) {
      if (SCRIPT[i] === '{') depth++;
      else if (SCRIPT[i] === '}' && --depth === 0) return SCRIPT.slice(start, i + 1);
    }
    throw new Error(`${name} has no end`);
  };
  const settingsPart = () => {
    const a = SCRIPT.indexOf("// ---------------------------------------------------------------- your Oby's settings");
    const b = SCRIPT.indexOf('// an item in Waiting for you');
    assert.ok(a > 0 && b > a);
    return SCRIPT.slice(a, b);
  };

  test("the page's script parses", () => {
    assert.doesNotThrow(() => new vm.Script(SCRIPT, { filename: 'index.html' }));
  });

  test('one set of controls, ours: no native select, number, time or checkbox in Settings', () => {
    assert.match(SCRIPT, /\/\/ ={5,} controls\n/, 'a section of their own');
    assert.match(PAGE, /\/\* ===== controls:/, 'and their styles');
    for (const f of ['ctlDropdown', 'ctlSegmented', 'ctlSwitch', 'ctlStepper', 'ctlTime', 'ctlChips', 'ctlToggle', 'ctlInfo', 'ctlInit']) assert.ok(fnSource(f));
    const part = settingsPart();
    for (const bad of ['<select', 'type="number"', 'type="time"', 'type="checkbox"', 'set-select']) assert.ok(!part.includes(bad), `Settings has no ${bad}`);
    // keyboard and screen readers: the roles the controls speak in
    for (const role of ['role="combobox"', 'role="listbox"', 'role="option"', 'role="radiogroup"', 'role="radio"', 'role="switch"', 'role="spinbutton"', 'aria-activedescendant', 'aria-expanded', 'aria-pressed', 'aria-valuenow']) assert.ok(SCRIPT.includes(role), role);
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape', 'Enter', 'PageUp']) assert.ok(fnSource('ctlDdKey').includes(key) || fnSource('ctlStepKey').includes(key), key);
  });

  test('the sections, in order, with a list to jump between them', () => {
    const order = ['runtimes', 'answers', 'access', 'github', 'machine', 'notify'];
    const at = order.map((k) => SCRIPT.indexOf(`['${k}', '`));
    assert.ok(at.every((x, i) => x > 0 && (i === 0 || x > at[i - 1])), 'Runtimes, Answers, Who can ask, GitHub, This computer, Notifications');
    for (const t of ["'Runtimes'", "'Answers'", "'Who can ask'", "'GitHub'", "'This computer'", "'Notifications'"]) assert.ok(SCRIPT.includes(t), t);
    assert.match(fnSource('renderSettings'), /class="set-nav" aria-label="Settings sections"/);
    assert.match(PAGE, /\.set-nav \{ position: sticky; top: 0;/);
    // the words Dmytro asked to change
    for (const old of ['Tell you when', 'The first rule that applies decides', 'separated by commas']) assert.ok(!settingsPart().includes(old), old);
    for (const now of ['By default, your Oby answers with', 'Exceptions', 'Try an ask', 'What to notify you about', 'Make a private topic', 'How to make one']) assert.ok(settingsPart().includes(now), now);
  });

  test('the page’s default for Obys you haven’t listed is rep.mjs’s: Ask me first', () => {
    assert.match(SCRIPT, /const ACCESS_DEFAULT = 'approve';/);
    assert.match(fs.readFileSync(path.join(ROOT, 'rep.mjs'), 'utf8'), /const ACCESS_DEFAULT = 'approve';/);
  });

  test('Make a private topic: a long random ntfy.sh topic, made in the page', () => {
    const src = fnSource('privateTopic');
    assert.match(src, /crypto\.getRandomValues/);
    const ctx = { crypto: globalThis.crypto, Uint8Array };
    vm.createContext(ctx);
    vm.runInContext(`${src}; this.a = privateTopic(); this.b = privateTopic();`, ctx);
    assert.match(ctx.a, /^https:\/\/ntfy\.sh\/oby-[a-z2-9]{24}$/);
    assert.notEqual(ctx.a, ctx.b);
  });

  test('a repository typed in: owner/name, owner/*, or its GitHub address; anything else is refused', () => {
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(`${/const GH_REPO = [^\n]*/.exec(SCRIPT)[0]}\n${fnSource('repoOf')}; this.repoOf = repoOf;`, ctx);
    const { repoOf } = ctx;
    assert.equal(repoOf('acme/web'), 'acme/web');
    assert.equal(repoOf(' acme/* '), 'acme/*');
    assert.equal(repoOf('https://github.com/acme/web.git'), 'acme/web');
    for (const bad of ['acme', '*/web', '--help/x', 'acme/x y', 'a/b/c', '<b>/x']) assert.equal(repoOf(bad), null, bad);
  });
});
