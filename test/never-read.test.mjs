// Your own names of files answers never read (#125, machine.neverRead). They're checked like
// every setting (an error names the field), make the same three forms as the built-in list
// (Claude Code's Read rules, the shell sandbox's denyRead, rep.mjs's own regex) and add to it,
// never replace it. End to end, with a test relay behind a proxy that keeps everything bob's
// Oby sends it, a fake Claude Code that attaches files through the real sphere_attach, and bob's
// console: an answer's settings file and command line carry them, sphere_attach refuses what
// they hide, `rep.mjs settings` says them, the console's local API saves and reads them, and
// nothing that reached the relay carries them. No model, no network beyond this machine.
// `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { makeFakeRuntimes } from './fake-runtimes.mjs';
import { globMatches, ruleGlob, makeAttachingClaude } from './deny-list-helpers.mjs';
import { repSections, recordingProxy } from './never-read-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const KEY = 'join-key-never-read-0123456789';
const ADMIN = 'admin-key-never-read-0123456789';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a free port, never the demo's (4848-4850)
const freePort = async () => {
  for (;;) {
    const p = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); }); });
    if (p < 4848 || p > 4850) return p;
  }
};
const bad = (field, words) => Object.assign(new Error(`${field}: ${words}`), { field });

describe('your own names: checked, and made into the three forms', () => {
  const R = repSections();
  const FOLDERS = [{ path: '/home/sam/work/app', write: false }, { path: '/home/sam/notes', write: true }];
  const check = (v, folders = FOLDERS) => R.validateNeverRead(v, folders, bad);
  const refused = (v, field, words, folders) => {
    assert.throws(() => check(v, folders), (e) => {
      assert.equal(e.field, field, `${JSON.stringify(v)}: ${e.message}`);
      assert.match(e.message, words, `${JSON.stringify(v)}: ${e.message}`);
      assert.ok(e.message.startsWith(`${field}: `), 'the message names the field');
      return true;
    });
  };

  test('names that pass: kept as written, trimmed, without repeats', () => {
    assert.deepEqual(check(undefined), []);
    assert.deepEqual(check(null), []);
    assert.deepEqual(check([]), []);
    assert.deepEqual(check(['*.sqlite', 'customers/', 'notes/private-*.md']), ['*.sqlite', 'customers/', 'notes/private-*.md']);
    assert.deepEqual(check(['  *.sqlite ', '*.sqlite', 'customers/', 'customers/']), ['*.sqlite', 'customers/'], 'trimmed; a repeat is kept once');
    // another spelling stays: Claude Code's rules can go by case (on Linux), where rep.mjs's own checks don't
    assert.deepEqual(check(['*.sqlite', '*.SQLITE']), ['*.sqlite', '*.SQLITE']);
    assert.deepEqual(check(['My Exports/*.csv', 'exports/*-2026.csv', '.git/', 'build/cache/', 'réunion-*.md', 'a+b@c=d%e&f~g#h.txt']), ['My Exports/*.csv', 'exports/*-2026.csv', '.git/', 'build/cache/', 'réunion-*.md', 'a+b@c=d%e&f~g#h.txt']);
    // at the limits
    assert.equal(check(Array.from({ length: R.NEVER_READ_MAX }, (_, i) => `n${i}.db`)).length, R.NEVER_READ_MAX);
    assert.equal(check(['a'.repeat(R.NEVER_READ_LEN)]).length, 1);
    assert.equal(R.NEVER_READ_STARS, 4);
    assert.deepEqual(check(['*-*-*-*.csv']), ['*-*-*-*.csv']);
  });

  test('names that are refused, each with a message that names it', () => {
    const f = 'machine.neverRead';
    refused('*.sqlite', f, /is a list of names to hide/);
    refused({ a: 1 }, f, /is a list/);
    refused(Array.from({ length: R.NEVER_READ_MAX + 1 }, (_, i) => `n${i}.db`), f, new RegExp(`has at most ${R.NEVER_READ_MAX} names`));
    refused(['ok.db', ''], `${f}[1]`, /is a name to hide, such as \*\.sqlite or customers\//);
    refused(['   '], `${f}[0]`, /is a name to hide/);
    refused([42], `${f}[0]`, /is a name to hide/);
    refused([null], `${f}[0]`, /is a name to hide/);
    refused(['a'.repeat(R.NEVER_READ_LEN + 1)], `${f}[0]`, new RegExp(`is at most ${R.NEVER_READ_LEN} characters`));
    // each * is a loop in the regex: a few are plenty, and many could take ages on a long file name
    refused(['*-*-*-*-*.csv'], `${f}[0]`, /"\*-\*-\*-\*-\*\.csv" has at most 4 \*$/);
    refused(['a*/b*/c*/d*/e*/'], `${f}[0]`, /has at most 4 \*$/);
    // full paths
    for (const p of ['/home/sam/work/app/customers/', '/etc/passwd', '~/notes/', '~', 'C:/Users/sam/x', 'c:x', '\\\\server\\share']) refused([p], `${f}[0]`, /is a name inside your folders, not a full path/);
    // out of the folders
    for (const p of ['..', '../x', 'a/../b', 'a/..']) refused([p], `${f}[0]`, /can't use \.\./);
    refused(['./customers/'], `${f}[0]`, /can't use \. as a name/);
    // everything, or nearly
    for (const p of ['*', '*/', '*.*', '*.*/', '*/*', '*/*.*', '*/*/*']) refused([p], `${f}[0]`, /would hide every file, or nearly: name what to hide, such as \*\.sqlite or customers\//);
    for (const p of ['**', '**/', '**/*.sqlite', 'a/**/b', '***', '**.*']) refused([p], `${f}[0]`, /can't use \*\*/);
    // narrower ones pass: the names that start with a dot, or end in one, or have two dots
    assert.deepEqual(check(['.*', '*/.*', '*.', '*.*.*']), ['.*', '*/.*', '*.', '*.*.*']);
    // glob or rule syntax, which the three forms would read differently: and no "!" to take a name off the built-in list
    const esc = (s) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    for (const [p, ch] of [['!.env', '!'], ['a?.db', '?'], ['[ab].db', '['], ['{a,b}.db', '{'], ['a,b', ','], ['Read(x)', '('], ['notes:2026', ':'], ['"x"', '"'], ["it's", "'"], ['a$b', '$'], ['a|b', '|'], ['a;b', ';'], ['a<b', '<']])
      refused([p], `${f}[0]`, new RegExp(`can't have ${esc(JSON.stringify(ch))} in it: use \\* for any characters inside a name, and / between names`));
    // what can't be seen is named in words
    for (const [p, words] of [['tab\there', 'a tab'], ['new\nline', 'a line break'], ['nul\u0000', 'an invisible character (U+0000)'], ['bidi\u202e', 'an invisible character (U+202E)'], ['nbsp\u00a0x', 'an invisible character (U+00A0)'], ['zw\u200bx', 'an invisible character (U+200B)']])
      refused([p], `${f}[0]`, new RegExp(`can't have ${esc(words)} in it`));
    refused(['a\\b'], `${f}[0]`, /uses \/ between names/);
    refused(['a//b'], `${f}[0]`, /has an empty name between two \//);
    refused(['a /b'], `${f}[0]`, /has a space at the start or end of a name/);
    refused(['a/ b'], `${f}[0]`, /has a space at the start or end of a name/);
    // the message quotes the name, cut short when long
    assert.throws(() => check([`${'x'.repeat(80)}?`]), (e) => /"x{60}…" can't have/.test(e.message));
  });

  test('a name that would hide one of your folders whole is refused', () => {
    const f = 'machine.neverRead';
    // the folder itself, or a folder above it: a name matches anywhere in a path
    for (const p of ['app/', 'app', 'work/', 'sam/', 'notes', 'NOTES/', 'w*k/']) refused(['ok.db', p], `${f}[1]`, /would hide your whole folder \/home\/sam\/(work\/app|notes) \(it matches a name in its path\): name something inside it instead/);
    // names inside them are fine
    assert.deepEqual(check(['app/customers/', 'notes/private-*.md', 'work.db']), ['app/customers/', 'notes/private-*.md', 'work.db']);
    // and the folder in the message is the one that's hidden
    assert.throws(() => check(['notes/'], [{ path: '/home/sam/work/app' }, { path: '/home/sam/notes' }]), /\/home\/sam\/notes/);
  });

  test('the three forms carry your names, made as the built-in ones are', () => {
    const OWN = ['*.sqlite', 'customers/', 'notes/private-*.md', 'My Exports/*.csv'];
    const own = R.neverReadForms(OWN);
    assert.deepEqual(own.globs, ['**/*.sqlite', '**/customers/**', '**/notes/private-*.md', '**/My Exports/*.csv']);
    assert.deepEqual(own.deny, own.globs.map((g) => `Read(${g})`));
    assert.deepEqual(own.edit, own.globs.map((g) => `Edit(${g})`));
    assert.ok(own.regex.flags.includes('i'));
    // the built-in list is made by the very same code
    assert.deepEqual(R.denyListForms(R.SECRET_FILES).globs, R.SECRET_GLOBS);
    // no names, no rules, and no regex (an empty one would match every path)
    const none = R.neverReadForms([]);
    assert.deepEqual([none.deny, none.globs, none.edit, none.regex], [[], [], [], null]);
    // on Claude Code's command line the rules are joined with commas: never a comma or a parenthesis inside one
    for (const r of [...own.deny, ...own.edit]) assert.match(r, /^(Read|Edit)\([^,()]+\)$/);
  });

  test('the regex, the globs and the rules agree on sample paths', () => {
    const OWN = ['*.sqlite', 'customers/', 'notes/private-*.md', 'My Exports/*.csv', 'exports/*-2026.csv', 'Thumbs.db'];
    const own = R.neverReadForms(OWN);
    const HIDDEN = true;
    const SEEN = false;
    const SAMPLES = [
      ['/home/sam/work/app/db/app.sqlite', HIDDEN],
      ['/home/sam/work/app/app.sqlite', HIDDEN],
      ['C:\\Users\\sam\\work\\app\\db\\app.sqlite', HIDDEN],
      ['/home/sam/work/app/customers/list.csv', HIDDEN],
      ['/home/sam/work/app/src/customers/deep/x.ts', HIDDEN],
      ['/home/sam/work/app/customers/', HIDDEN],
      ['/home/sam/work/app/notes/private-2026.md', HIDDEN],
      ['/home/sam/work/app/My Exports/q3.csv', HIDDEN],
      ['/home/sam/work/app/exports/sales-2026.csv', HIDDEN],
      ['/home/sam/work/app/photos/Thumbs.db', HIDDEN],
      ['/home/sam/work/app/db/app.sqlite-journal', SEEN],
      ['/home/sam/work/app/db/app.sqlite3', SEEN],
      ['/home/sam/work/app/src/customers.ts', SEEN],
      ['/home/sam/work/app/my-customers/x.ts', SEEN],
      ['/home/sam/work/app/notes/public.md', SEEN],
      ['/home/sam/work/app/notes/private.md', SEEN],
      ['/home/sam/work/app/private-2026.md', SEEN], // not inside a notes folder
      ['/home/sam/work/app/My Exports/readme.txt', SEEN],
      ['/home/sam/work/app/exports/sales-2025.csv', SEEN],
      ['/home/sam/work/app/README.md', SEEN],
    ];
    for (const [p, hidden] of SAMPLES) {
      assert.equal(own.regex.test(p), hidden, `regex: ${p}`);
      assert.equal(own.globs.some((g) => globMatches(g, p)), hidden, `globs: ${p}`);
      assert.equal(own.deny.some((r) => globMatches(ruleGlob(r), p)), hidden, `rules: ${p}`);
    }
    // what case people don't usually write: the regex ignores it, as the rules do on macOS and Windows
    assert.ok(own.regex.test('/home/sam/work/app/DB/APP.SQLITE') && own.globs.some((g) => globMatches(g, '/home/sam/work/app/DB/APP.SQLITE')));
  });

  test('your names add to the built-in list: a secret file stays hidden, whatever you name', () => {
    // nothing you can write takes a file off the list: no "!", and the built-in regex is checked first, apart
    for (const p of ['!.env', '!*.pem']) assert.throws(() => check([p]), /can't have "!"/);
    for (const p of ['/home/sam/work/app/.env', '/home/sam/work/app/certs/server.pem']) {
      assert.ok(R.SECRETISH.test(p));
      assert.equal(R.neverReadForms(['*.sqlite']).regex.test(p), false, 'your names are a list of their own, beside the built-in one');
    }
  });
});

describe('end to end: an answer, sphere_attach, settings, the console, and the relay', () => {
  let relay, serve, ui, proxy, relayBase, base, uiBase, tmp, home, homeDir, work, cfg, fake, attacher, ids, serveOut = '', uiOut = '';
  const procs = [];
  // fakes first on PATH; HOME, the profiles and the app folder are this test's own; notifications only to a log
  const env = () => ({
    ...process.env,
    HOME: homeDir,
    OBYSPHERE_HOME: home,
    OBYSPHERE_APP_HOME: path.join(tmp, 'app-home'),
    OBYSPHERE_NOTIFY_LOG: path.join(tmp, 'notify.jsonl'),
    OBYSPHERE_NO_UPDATE_CHECK: '1',
    CLAUDE_CONFIG_DIR: cfg,
    OBYSPHERE_CHROME: '0',
    OBYSPHERE_MINUTE_MS: '3000',
    OBYSPHERE_PROBE_CACHE_MS: '0',
    PATH: `${path.dirname(attacher.claude)}${path.delimiter}${path.dirname(fake.claude)}${path.delimiter}${process.env.PATH}`,
  });
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
  const profile = (n) => JSON.parse(fs.readFileSync(path.join(home, n, 'profile.json'), 'utf8'));
  const call = async (method, url, { tok, body, at = relayBase, headers = {} } = {}) => {
    const h = { ...headers };
    if (tok) h.authorization = `Bearer ${tok}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(at + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const local = (method, url, body) => call(method, url, { at: uiBase, body, headers: { 'x-obysphere-console': '1' } });
  // alice asks bob's Oby to send files ("ATTACH <path>" a line, for the attaching fake); bob's reply
  const askBob = async (files) => {
    const tok = profile('alice').token;
    const text = `Please send me these files from your folder:\n${files.map((f) => `ATTACH ${f}`).join('\n')}`;
    const asked = await call('POST', '/api/messages', { tok, body: { channel: 'general', text, to: [ids.bob] } });
    assert.ok(asked.message, JSON.stringify(asked));
    let reply;
    for (let i = 0; i < 40 && !reply; i++) reply = ((await call('GET', `/api/messages/${asked.message.id}/replies?wait=3`, { tok })).replies || []).find((r) => r.from === ids.bob);
    assert.ok(reply, `bob replied\n${serveOut.slice(-3000)}`);
    assert.ok(!reply.meta?.error && !reply.meta?.declined, reply.text);
    return reply;
  };
  // what sphere_attach said for each file, from the attaching fake's reply
  const saidOf = (reply) => Object.fromEntries(reply.text.split('\n').map((l) => [l.slice(0, l.indexOf(': ')), l.slice(l.indexOf(': ') + 2)]));
  const settingsPath = () => path.join(home, 'bob', 'settings.json');
  const onDisk = () => JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  const writeSettings = (s) => fs.writeFileSync(settingsPath(), JSON.stringify(s), { mode: 0o600 });

  // bob's names: some for files alice will ask for, one she never mentions
  const OWN = ['*.sqlite', 'customers-zq7/', 'notes/private-*.md', 'My Exports/*.csv', 'vault-zq7-unasked/'];
  // bob trusts alice, so the folder is writable for her (Edit rules) and the shell is read-only (the sandbox)
  const bobSettings = (over = {}) => ({ version: 2, access: { default: 'answer', agents: { alice: 'trust' } }, machine: { folders: [{ path: work, write: true }], shell: 'read', neverRead: OWN, ...over } });
  const HIDDEN_FILES = ['data/app.sqlite', 'upper/DB.SQLITE', 'customers-zq7/list.csv', 'customers-zq7/deep/notes.txt', 'notes/private-2026.md'];
  const SECRET_FILES = ['.env', 'certs/server.pem']; // the built-in list still holds
  const READABLE_FILES = ['notes/public.md', 'README.md', 'src/customers.ts', 'data/app.sqlite-journal'];

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-never-read-')));
    home = path.join(tmp, 'reps');
    homeDir = path.join(tmp, 'home');
    work = path.join(tmp, 'work');
    cfg = path.join(tmp, 'claude-config');
    for (const d of [home, homeDir, work, cfg]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ mcpServers: {}, projects: {} }));
    for (const f of [...HIDDEN_FILES, ...SECRET_FILES, ...READABLE_FILES, 'My Exports/q3.csv', 'vault-zq7-unasked/x.txt']) {
      fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
      fs.writeFileSync(path.join(work, f), `contents of ${f}\n`);
    }
    fake = makeFakeRuntimes(path.join(tmp, 'bin'));
    fake.control({});
    attacher = makeAttachingClaude(path.join(tmp, 'bin-attach'), fake.claude);
    const port = await freePort();
    relayBase = `http://127.0.0.1:${port}`;
    relay = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', path.join(tmp, 'relay')], {
      env: { ...process.env, HOME: homeDir, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_STORE: 'fs', SPHERE_SEALED: '0' },
      stdio: process.env.SPHERE_TEST_DEBUG ? 'inherit' : 'ignore',
    });
    procs.push(relay);
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(relayBase + '/healthz')).ok) break;
      } catch {}
      await sleep(100);
    }
    // bob reaches the relay only through the proxy, which keeps all he sends it
    proxy = recordingProxy(relayBase);
    base = await proxy.listen();
    assert.match((await rep(['join', `${relayBase}/#key=${KEY}`, '--name', 'alice', '--owner', 'Alice Test', '--cwd', work])).out, /joined/);
    assert.match((await rep(['join', `${base}/#key=${KEY}`, '--name', 'bob', '--owner', 'Bob Test', '--cwd', work])).out, /joined/);
    fs.writeFileSync(path.join(home, 'bob', 'profile.json'), JSON.stringify({ ...profile('bob'), claudeBin: attacher.claude, codexBin: fake.codex, cursorBin: fake.cursor }), { mode: 0o600 });
    writeSettings(bobSettings());
    ids = { alice: profile('alice').agent.id, bob: profile('bob').agent.id };
    serve = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'serve', '--profile', 'bob'], { env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
    procs.push(serve);
    serve.stdout.on('data', (d) => (serveOut += d));
    serve.stderr.on('data', (d) => (serveOut += d));
    for (let i = 0; i < 100 && !/is online/.test(serveOut); i++) await sleep(100);
    assert.match(serveOut, /is online/, serveOut);
  });
  after(async () => {
    await Promise.all(procs.map((p) => (p.exitCode !== null || p.signalCode !== null ? null : new Promise((r) => { p.once('exit', r); p.kill(); }))));
    proxy?.close();
    if (!process.env.SPHERE_TEST_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('settings refuse a bad name, and say which', async () => {
    const cases = [
      [['*.sqlite', '*'], /machine\.neverRead\[1\]: "\*" would hide every file, or nearly/],
      [['/etc/hosts'], /machine\.neverRead\[0\]: "\/etc\/hosts" is a name inside your folders, not a full path/],
      [['../secrets.txt'], /machine\.neverRead\[0\]: "\.\.\/secrets\.txt" can't use \.\./],
      [[''], /machine\.neverRead\[0\]: is a name to hide/],
      [['work/'], /machine\.neverRead\[0\]: "work\/" would hide your whole folder .*work \(it matches a name in its path\)/],
      ['*.sqlite', /machine\.neverRead: is a list of names to hide/],
    ];
    try {
      for (const [v, words] of cases) {
        writeSettings(bobSettings({ neverRead: v }));
        const { out, code } = await rep(['settings', '--profile', 'bob']);
        assert.equal(code, 1, out);
        assert.match(out, words);
      }
      // an older key would be refused too: the setting is machine.neverRead, nothing else
      writeSettings({ ...bobSettings(), machine: { ...bobSettings().machine, neverReads: ['x'] } });
      assert.match((await rep(['settings', '--profile', 'bob'])).out, /machine\.neverReads: isn't a setting \(machine has folders, shell, web, browser, mcp, neverRead\)/);
    } finally {
      writeSettings(bobSettings());
    }
  });

  test('rep.mjs settings says your names, in words', async () => {
    const { out, code } = await rep(['settings', '--profile', 'bob']);
    assert.equal(code, 0, out);
    assert.ok(out.includes(`never reads: .env files, keys, credentials and similar, and yours: ${OWN.join(', ')} (the full shell, Codex and Cursor can still read them)`), out);
    // --json: the file, with them
    assert.deepEqual(JSON.parse((await rep(['settings', '--profile', 'bob', '--json'])).out).machine.neverRead, OWN);
    // none of your own: the built-in list only
    writeSettings(bobSettings({ neverRead: [] }));
    try {
      const { out: plain } = await rep(['settings', '--profile', 'bob']);
      assert.ok(plain.includes('never reads: .env files, keys, credentials and similar (the full shell, Codex and Cursor can still read them)'), plain);
    } finally {
      writeSettings(bobSettings());
    }
  });

  test("alice asks bob's Oby for files: the answer had bob's names, and sphere_attach refuses what they hide", async () => {
    const files = [...HIDDEN_FILES, ...SECRET_FILES, ...READABLE_FILES];
    const text = `Please send me these files from your folder:\n${files.map((f) => `ATTACH ${f}`).join('\n')}`;
    const tok = profile('alice').token;
    const asked = await call('POST', '/api/messages', { tok, body: { channel: 'general', text, to: [ids.bob] } });
    assert.ok(asked.message, JSON.stringify(asked));
    let reply;
    for (let i = 0; i < 40 && !reply; i++) reply = ((await call('GET', `/api/messages/${asked.message.id}/replies?wait=3`, { tok })).replies || []).find((r) => r.from === ids.bob);
    assert.ok(reply, `bob replied\n${serveOut.slice(-3000)}`);
    assert.ok(!reply.meta?.error && !reply.meta?.declined, reply.text);

    // what sphere_attach said for each file
    const said = Object.fromEntries(reply.text.split('\n').map((l) => [l.slice(0, l.indexOf(': ')), l.slice(l.indexOf(': ') + 2)]));
    for (const f of HIDDEN_FILES) assert.equal(said[f], 'Error: your owner keeps that file private; not attaching it', f);
    for (const f of SECRET_FILES) assert.equal(said[f], 'Error: that file looks like a secret; not attaching it', f);
    for (const f of READABLE_FILES) assert.match(said[f] || '', /^Attached /, f);
    assert.deepEqual(reply.files.map((f) => f.name).sort(), READABLE_FILES.map((f) => path.basename(f)).sort());

    // the answer's Claude Code: the built-in rules, then bob's, in its settings file and on its command line
    const R = repSections(home);
    const own = R.neverReadForms(OWN);
    const a = attacher.answers().at(-1);
    const flag = (f) => a.argv[a.argv.indexOf(f) + 1];
    const cli = flag('--disallowedTools').split(',');
    const file = a.settings.permissions.deny;
    assert.deepEqual(cli.filter((r) => r.startsWith('Read(')), [...R.SECRET_DENY, ...own.deny]);
    assert.deepEqual(file.filter((r) => r.startsWith('Read(')), [...R.SECRET_DENY, ...own.deny]);
    assert.ok(cli.includes('Read(**/My Exports/*.csv)'), 'a name with a space is one rule');
    // the folder is writable for alice, so bob's names are never written either
    for (const r of own.edit) assert.ok(cli.includes(r) && file.includes(r), r);
    // and the sandbox of the read-only shell: the built-in globs, then bob's
    const denyRead = a.settings.sandbox.filesystem.denyRead;
    assert.deepEqual(denyRead.slice(0, R.SECRET_GLOBS.length + own.globs.length), [...R.SECRET_GLOBS, ...own.globs]);
  });

  test("a change to bob's names starts alice's conversation afresh: an answer never carries on from one that read a file he now hides", async () => {
    const resumed = () => attacher.answers().at(-1).argv.includes('--resume');
    // with the names as they were, a follow-up carries on the conversation
    assert.match(saidOf(await askBob(['notes/public.md']))['notes/public.md'] || '', /^Attached /);
    assert.ok(resumed(), 'a follow-up carries on');
    // bob now hides that file: the next answer starts afresh (the last one read it), and the file stays home
    writeSettings(bobSettings({ neverRead: [...OWN, 'notes/public.md'] }));
    try {
      assert.equal(saidOf(await askBob(['notes/public.md']))['notes/public.md'], 'Error: your owner keeps that file private; not attaching it');
      assert.ok(!resumed(), 'no --resume after a change to the names');
      // and with the names as they are now, a follow-up carries on again
      assert.match(saidOf(await askBob(['README.md']))['README.md'] || '', /^Attached /);
      assert.ok(resumed(), 'a follow-up carries on again');
    } finally {
      writeSettings(bobSettings());
    }
  });

  test("bob's console: the local API saves and reads his names, and gives the built-in list", async () => {
    const port = await freePort();
    uiBase = `http://127.0.0.1:${port}`;
    ui = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'ui', '--profile', 'bob', '--port', String(port)], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(ui);
    ui.stdout.on('data', (d) => (uiOut += d));
    ui.stderr.on('data', (d) => (uiOut += d));
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(uiBase + '/favicon.svg')).ok) break;
      } catch {}
      await sleep(100);
    }
    const R = repSections(home);
    const got = await local('GET', '/local/settings');
    assert.equal(got.status, 200, JSON.stringify(got));
    assert.deepEqual(got.settings.machine.neverRead, OWN);
    assert.deepEqual(got.neverReadBuiltIn, R.SECRET_FILES, 'the built-in list, for the page to show');

    // saved as the page sends them: the whole settings, one name a line made a list
    const mine = ['*.sqlite', ' customers-zq7/ ', 'ledger-*.xlsx', '*.sqlite'];
    const put = await local('PUT', '/local/settings', { settings: { ...got.settings, machine: { ...got.settings.machine, neverRead: mine } } });
    assert.equal(put.status, 200, JSON.stringify(put));
    assert.deepEqual(put.settings.machine.neverRead, ['*.sqlite', 'customers-zq7/', 'ledger-*.xlsx'], 'trimmed, and a repeat kept once');
    assert.deepEqual(onDisk().machine.neverRead, ['*.sqlite', 'customers-zq7/', 'ledger-*.xlsx']);
    assert.deepEqual((await local('GET', '/local/settings')).settings.machine.neverRead, ['*.sqlite', 'customers-zq7/', 'ledger-*.xlsx']);

    // a bad one: 400 with the field, and the file as it was
    const refused = await local('PUT', '/local/settings', { settings: { ...got.settings, machine: { ...got.settings.machine, neverRead: ['*.sqlite', '**'] } } });
    assert.equal(refused.status, 400);
    assert.equal(refused.field, 'machine.neverRead[1]');
    assert.match(refused.error, /^machine\.neverRead\[1\]: "\*\*" can't use \*\*/);
    assert.deepEqual(onDisk().machine.neverRead, ['*.sqlite', 'customers-zq7/', 'ledger-*.xlsx']);

    // none: left out of the file, so an older rep.mjs still reads it
    const cleared = await local('PUT', '/local/settings', { settings: { ...got.settings, machine: { ...got.settings.machine, neverRead: [] } } });
    assert.equal(cleared.status, 200, JSON.stringify(cleared));
    assert.equal('neverRead' in onDisk().machine, false);
    assert.equal((await local('GET', '/local/settings')).settings.machine.neverRead, undefined);

    // a file that doesn't pass still gets the built-in list (the page shows the field to fix)
    writeSettings(bobSettings({ neverRead: ['*'] }));
    const broken = await local('GET', '/local/settings');
    assert.equal(broken.field, 'machine.neverRead[0]');
    assert.deepEqual(broken.settings.machine.neverRead, ['*']);
    assert.deepEqual(broken.neverReadBuiltIn, R.SECRET_FILES);
    writeSettings(bobSettings());
  });

  test('the page has the field, under This computer, with the built-in list folded', () => {
    const page = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)[1];
    assert.doesNotThrow(() => new vm.Script(script, { filename: 'index.html' }));
    // a declaration out of the page's script, by its body's braces (after its parameters, which
    // may have some); a one-line const by its name
    const fnSource = (name) => {
      const start = script.search(new RegExp(`\\n  (?:async )?function ${name}\\(`));
      assert.ok(start >= 0, `${name} is in the page`);
      let depth = 0;
      for (let i = script.indexOf(') {', start) + 2; i < script.length; i++) {
        if (script[i] === '{') depth++;
        else if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
      }
      throw new Error(`${name} has no end`);
    };
    const line = (name) => new RegExp(`^  const ${name} = .*$`, 'm').exec(script)?.[0] ?? assert.fail(`const ${name}`);
    const fn = fnSource('neverReadHtml');
    assert.match(fn, /const k = 'machine\.neverRead';/);
    assert.match(fn, />Never read</);
    // a list, so the page's own chips, as for "Decline asks about"; no field of its own kind
    assert.match(fn, /ctlChips\(\{ id: fid\(k\), values: m\.neverRead \|\| \[\], label: 'Never read', [^)]*max: NEVER_READ_MAX, each: NEVER_READ_LEN, attrs: `data-k="\$\{k\}"` \}\)/);
    assert.doesNotMatch(fn, /<textarea|data-t=/);
    assert.match(fn, /<details class="set-always"><summary>Always hidden: \.env files, keys, credentials and similar<\/summary>/);
    assert.match(fn, /Codex, Cursor and a shell set to Any command can still read them/);
    assert.match(fn, /the Sphere never sees them/);
    // the limits are rep.mjs's
    const R = repSections(home);
    assert.match(script, new RegExp(`const NEVER_READ_MAX = ${R.NEVER_READ_MAX}, NEVER_READ_LEN = ${R.NEVER_READ_LEN};`));
    assert.match(script, /SET\.neverReadBuiltIn = Array\.isArray\(s\.neverReadBuiltIn\)/);
    // an error names the field in words, and is put under it (fieldEl finds it by data-k)
    assert.match(line('FIELD_WORDS'), /neverRead: 'never read'/);
    // in "This computer", after the folders
    const machine = fnSource('machineHtml');
    assert.ok(machine.indexOf('${neverReadHtml()}') > machine.indexOf('data-part="folders"'));

    // rendered by the page's own functions: a chip for each name, escaped; the built-in list after
    // the field's row (an error shows right under the field, not under the list)
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(
      [
        ...['esc', 'CTL', 'ctlAttrs', 'CTL_X', 'fid', 'NEVER_READ_MAX'].map(line),
        ...['ctlChips', 'ctlChipsInner', 'ctlInfo', 'neverReadHtml'].map(fnSource),
        'let SET;',
        'this.render = (s) => { SET = s; return neverReadHtml(); };',
        'this.chips = (id) => CTL.data.get(id);',
      ].join('\n'),
      ctx,
    );
    const html = ctx.render({ settings: { machine: { neverRead: ['*.sqlite', 'a<b>/'] } }, neverReadBuiltIn: ['.env*', '*.pem'] });
    assert.match(html, /<div class="ctl-chips" id="set-machine-neverRead" data-ctl="chips" data-k="machine\.neverRead">/);
    assert.match(html, /<span class="ctl-chip-t">\*\.sqlite<\/span>[\s\S]*<span class="ctl-chip-t">a&lt;b&gt;\/<\/span>/);
    assert.match(html, /aria-label="Never read: add"/);
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.chips('set-machine-neverRead'))), { value: ['*.sqlite', 'a<b>/'], max: R.NEVER_READ_MAX, each: R.NEVER_READ_LEN });
    // the row, then the list: the row's own </div> comes before <details>
    const row = html.indexOf('<div class="set-row is-stack set-never">');
    assert.equal(row, 0);
    let depth = 0, rowEnd = -1;
    for (const m of html.matchAll(/<div\b|<\/div>/g)) {
      depth += m[0] === '</div>' ? -1 : 1;
      if (depth === 0) { rowEnd = m.index; break; }
    }
    assert.ok(rowEnd > 0 && html.indexOf('<details class="set-always">') > rowEnd, 'the list is below the row');
    assert.match(html, /<code>\.env\*<\/code> <code>\*\.pem<\/code>/);
    // no names yet: an empty field, and the list
    assert.match(ctx.render({ settings: { machine: {} }, neverReadBuiltIn: ['.env*'] }), /<span class="ctl-chips-list"><\/span>[\s\S]*set-always/);
    // an older rep.mjs (no built-in list, and no names): no field, since it would refuse one
    assert.equal(ctx.render({ settings: { machine: {} }, neverReadBuiltIn: null }), '');
    // a file that has names shows them even then, without the list
    const old = ctx.render({ settings: { machine: { neverRead: ['x.db'] } }, neverReadBuiltIn: null });
    assert.match(old, /<span class="ctl-chip-t">x\.db<\/span>/);
    assert.doesNotMatch(old, /set-always/);
    // a pasted list, one name a line: a name a line. A one-line field would run the lines together
    // into one name (Chrome puts spaces between them), which would hide none of the files
    assert.match(fnSource('ctlInit'), /addEventListener\('paste', \(e\) => \{[\s\S]*?if \(!\/\[\\r\\n\]\/\.test\(text\)\) return;[\s\S]*?e\.preventDefault\(\);\s*ctlChipsPaste\(t\.closest\('\[data-ctl\]'\), t, text\);/);
    vm.runInContext(
      [
        'class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } }',
        ...['ctlEmit', 'ctlChipsAdd', 'ctlChipsPaste'].map(fnSource),
        'this.paste = ctlChipsPaste;',
      ].join('\n'),
      ctx,
    );
    ctx.render({ settings: { machine: { neverRead: ['*.sqlite'] } }, neverReadBuiltIn: ['.env*'] });
    const sent = [];
    const list = { innerHTML: '' };
    const root = { id: 'set-machine-neverRead', querySelector: () => list, dispatchEvent: (ev) => sent.push(JSON.parse(JSON.stringify(ev.detail.value))) };
    // pasted at the caret, after "notes/" already typed; blank lines and a repeat left out
    const f = { value: 'notes/', selectionStart: 6, selectionEnd: 6 };
    ctx.paste(root, f, 'private-*.md\r\ncustomers/\n\n*.sqlite\nledger-*.xlsx\n');
    assert.deepEqual(sent, [['*.sqlite', 'notes/private-*.md', 'customers/', 'ledger-*.xlsx']]);
    assert.equal(f.value, '', 'the field is emptied');
    assert.match(list.innerHTML, /<span class="ctl-chip-t">ledger-\*\.xlsx<\/span>/);
    // adding a folder that a name would hide: taken back off, and said by the add field
    const add = fnSource('addFolder');
    assert.match(add, /\/\^machine\\\.neverRead\/\.test\(dotted\(SET\.error\.field \|\| ''\)\) && \/would hide your whole folder\//);
    assert.match(add, /`Under Never read, \$\{errorWords\(err\)/);
    // but not for an error Never read already had: that one is about the folders already there, so
    // the new folder stays and the error stays under Never read
    assert.match(add, /const neverReadBefore = !!SET\.error && \/\^machine\\\.neverRead\/\.test\(dotted\(SET\.error\.field \|\| ''\)\);\n\s*SET\.settings\.machine\.folders = \[\.\.\.fs, /);
    assert.match(add, /const hidden = !neverReadBefore && /);
  });

  test('serve --cwd into a folder your names hide is refused', async () => {
    const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'serve', '--profile', 'bob', '--cwd', path.join(work, 'customers-zq7')], { env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
    procs.push(p);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    for (let i = 0; i < 100 && !/--cwd: /.test(out); i++) await sleep(100);
    await new Promise((r) => { p.once('exit', r); p.kill(); });
    assert.match(out, /--cwd: is hidden by one of your own never-read names \(machine\.neverRead\)/, out);
  });

  test("nothing bob's Oby sent the relay carries his names, and a change to them alone tells it nothing", async () => {
    const posts = () => proxy.seen.filter((r) => r.method === 'POST' && r.url === '/api/me');
    // a change to the names alone: the summary is the same, so nothing is posted
    const before = posts().length;
    const s = (await local('GET', '/local/settings')).settings;
    assert.equal((await local('PUT', '/local/settings', { settings: { ...s, machine: { ...s.machine, neverRead: [...OWN, 'ledger-zq7-*.xlsx'] } } })).status, 200);
    for (let i = 0; i < 50 && !/settings changed/.test(serveOut.slice(-400)); i++) await sleep(100);
    await sleep(2500); // past serve's next look at the file
    assert.equal(posts().length, before, 'no POST /api/me for a change of names only');
    // with the web on too, the summary changes: posted, without them
    const s2 = (await local('GET', '/local/settings')).settings;
    assert.equal((await local('PUT', '/local/settings', { settings: { ...s2, machine: { ...s2.machine, web: { fetch: true, search: false } } } })).status, 200);
    for (let i = 0; i < 80 && posts().length === before; i++) await sleep(100);
    assert.ok(posts().length > before, `POST /api/me after the change\n${serveOut.slice(-1500)}`);
    const declared = JSON.parse(posts().at(-1).body).declared;
    assert.ok(declared.tools.includes('WebFetch'));
    assert.deepEqual(Object.keys(declared).sort(), ['approve', 'folder', 'folders', 'model', 'runtime', 'runtimes', 'tools'], 'names and kinds only');
    // and what the relay now shows of bob
    const agents = (await call('GET', '/api/agents', { tok: profile('alice').token })).agents;
    assert.deepEqual(agents.find((x) => x.id === ids.bob).declared, declared);

    // everything bob's Oby, its answers and its console sent the relay: never a name, in any form,
    // nor the setting's name. (Names alice asked about by file, like customers-zq7/, can be in
    // the reply's words; their rule and glob forms can't.)
    const all = [...OWN, 'ledger-zq7-*.xlsx', 'ledger-*.xlsx'];
    const forms = repSections(home).neverReadForms(all);
    const never = [...all.filter((n) => n.includes('*') || n.includes('unasked')), ...forms.globs, ...forms.deny, ...forms.edit, 'neverRead', 'never-read'];
    assert.ok(proxy.seen.length > 10, `the proxy saw bob's traffic (${proxy.seen.length})`);
    assert.ok(!proxy.seen.some((r) => r.url.startsWith('/local')), 'the local API never goes to the relay');
    for (const r of proxy.seen) for (const n of never) assert.ok(!r.url.includes(n) && !r.body.includes(n), `${r.method} ${r.url} carries ${n}`);
    // and so nothing the relay keeps, or shows, has them
    await sleep(1200); // the relay writes its snapshot within a second
    const kept = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : kept.push(fs.readFileSync(path.join(d, e.name), 'latin1')); };
    walk(path.join(tmp, 'relay'));
    const shown = JSON.stringify([agents, await call('GET', '/api/audit', { tok: profile('alice').token }), await call('GET', '/api/messages?channel=general&limit=50', { tok: profile('alice').token })]);
    for (const n of never) {
      assert.ok(!kept.some((t) => t.includes(n)), `the relay's data folder has ${n}`);
      assert.ok(!shown.includes(n), `the relay shows ${n}`);
    }
  });
});
