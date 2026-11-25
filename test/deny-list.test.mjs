// The files answers never read (#125). rep.mjs keeps that list in three forms: SECRET_DENY
// (Claude Code's Read deny rules), SECRET_GLOBS (the shell sandbox's denyRead) and
// SECRETISH (its own checks: what sphere_attach sends, which folders settings take), all
// made from one table. Here: the three agree on a table of sample paths (nested, upper and
// lower case, Windows separators, and ordinary files that look alike), nothing on the list
// before #125 was dropped, and, end to end with a test relay and a fake Claude Code, an
// answer gets every rule and the sandbox every glob, sphere_attach refuses the secret files
// and sends the rest, and settings refuse a folder of credentials. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { makeFakeRuntimes } from './fake-runtimes.mjs';
import { globMatches, ruleGlob, makeAttachingClaude } from './deny-list-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'rep.mjs'), 'utf8');
const KEY = 'join-key-deny-list-0123456789';
const ADMIN = 'admin-key-deny-list-0123456789';
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// rep.mjs is one file with no exports: its deny-list section and the three constants,
// evaluated from its source as they are written there
function lists(home) {
  const grab = (re, what) => {
    const m = SRC.match(re);
    assert.ok(m, `rep.mjs has ${what}`);
    return m[0];
  };
  const section = grab(/^\/\/ ===== deny-list[\s\S]*?^\/\/ ===== end of deny-list$/m, 'its deny-list section');
  const consts = ['SECRET_DENY', 'SECRETISH', 'SECRET_GLOBS'].map((n) => grab(new RegExp(`^const ${n} = [\\s\\S]*?;(?: *//.*)?$`, 'm'), n));
  return new Function('HOME', `${section}\n${consts.join('\n')}\nreturn { SECRET_FILES, SECRET_HOME, SECRET_DENY, SECRETISH, SECRET_GLOBS, denyListForms };`)(home);
}

// the list as it was before #125 (0.2.0)
const BEFORE = {
  globs: ['**/.env*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/id_ed25519*', '**/id_ecdsa*', '**/.npmrc', '**/.pypirc', '**/credentials*', '**/.ssh/**', '**/.aws/**', '**/.gnupg/**', '**/.git-credentials', '**/.netrc', '**/.docker/config.json', '**/.kube/**'],
  deny: ['Read(**/.env*)', 'Read(**/*.pem)', 'Read(**/*.key)', 'Read(**/id_rsa*)', 'Read(**/id_ed25519*)', 'Read(**/id_ecdsa*)', 'Read(**/.npmrc)', 'Read(**/.pypirc)', 'Read(**/credentials*)', 'Read(**/.ssh/**)', 'Read(**/.aws/**)', 'Read(**/.gnupg/**)', 'Read(**/.git-credentials)', 'Read(**/.netrc)', 'Read(**/.docker/config.json)', 'Read(**/.kube/**)'],
  regex: /(^|[\\/])(\.env[^\\/]*|\.ssh|\.aws|\.gnupg|\.kube|\.netrc|\.git-credentials|id_rsa[^\\/]*|id_ed25519[^\\/]*|id_ecdsa[^\\/]*|[^\\/]*\.pem|[^\\/]*\.key|credentials[^\\/]*|\.npmrc|\.pypirc)($|[\\/])|[\\/]\.docker[\\/]config\.json$/i,
};

// [path, never read?, how it's spelled]. "case": a case people don't usually write, which
// only SECRETISH is sure to catch (below). Everything else is spelled as such files are.
const SECRET = true;
const READABLE = false;
const SAMPLES = [
  // environment files
  ['/home/sam/app/.env', SECRET],
  ['/home/sam/app/.env.local', SECRET],
  ['app/.env.example', SECRET], // as before #125: .env* includes the examples
  ['/home/sam/app/.envrc', SECRET],
  ['/home/sam/app/config/prod.env', SECRET],
  ['C:\\Users\\sam\\app\\config\\staging.env', SECRET],
  ['C:\\Users\\sam\\app\\config\\PROD.ENV', SECRET, 'case'],
  ['/home/sam/app/.ENV', SECRET, 'case'],
  ['/home/sam/worker/.dev.vars', SECRET],
  ['/home/sam/app/.secrets', SECRET],
  ['/home/sam/app/.env.d/base.txt', SECRET], // a folder that matches hides what's inside, as before
  // keys, keystores and certificates
  ['/home/sam/app/certs/server.pem', SECRET],
  ['/home/sam/app/certs/server.key', SECRET],
  ['/home/sam/.ssh/id_rsa', SECRET],
  ['/home/sam/backup/id_rsa.pub', SECRET], // as before #125: id_rsa* includes the public half
  ['/home/sam/backup/id_dsa', SECRET],
  ['/home/sam/backup/ID_ED25519', SECRET, 'case'],
  ['/home/sam/.ssh/id_ecdsa_sk', SECRET],
  ['/home/sam/app/certs/client.p12', SECRET],
  ['C:\\Users\\sam\\certs\\server.pfx', SECRET],
  ['/home/sam/ios/AuthKey_ABC123.p8', SECRET],
  ['/home/sam/android/release.jks', SECRET],
  ['/home/sam/android/debug.keystore', SECRET],
  ['/home/sam/putty/server.ppk', SECRET],
  ['/home/sam/vault/passwords.kdbx', SECRET],
  ['/home/sam/vpn/office.ovpn', SECRET],
  ['/home/sam/.gnupg/pubring.kbx', SECRET],
  ['/home/sam/.password-store/email.gpg', SECRET],
  // registries, build tools and CLIs
  ['/home/sam/.npmrc', SECRET],
  ['app/.pypirc', SECRET],
  ['app/.yarnrc.yml', SECRET],
  ['/home/sam/.netrc', SECRET],
  ['C:\\Users\\sam\\_netrc', SECRET],
  ['/home/sam/.git-credentials', SECRET],
  ['/home/sam/.gitcookies', SECRET],
  ['/home/sam/.docker/config.json', SECRET],
  ['C:\\Users\\sam\\.docker\\config.json', SECRET],
  ['/home/sam/.dockercfg', SECRET],
  ['/home/sam/.config/gh/hosts.yml', SECRET],
  ['/home/sam/.composer/auth.json', SECRET],
  ['/home/sam/.config/composer/auth.json', SECRET],
  ['/home/sam/.m2/settings.xml', SECRET],
  ['/home/sam/.m2/settings-security.xml', SECRET],
  ['/home/sam/.gradle/gradle.properties', SECRET],
  ['/home/sam/app/.m2/settings.xml', SECRET], // in a .m2 folder anywhere, as CI setups keep one
  ['/home/sam/.cargo/credentials.toml', SECRET],
  ['/home/sam/.gem/credentials', SECRET],
  // clouds and clusters
  ['/home/sam/.aws/credentials', SECRET],
  ['/home/sam/.aws/config', SECRET],
  ['/home/sam/.azure/msal_token_cache.json', SECRET],
  ['C:\\Users\\sam\\.azure\\accessTokens.json', SECRET],
  ['/home/sam/.config/gcloud/configurations/config_default', SECRET],
  ['/home/sam/app/gcp/application_default_credentials.json', SECRET],
  ['/home/sam/.boto', SECRET],
  ['/home/sam/.s3cfg', SECRET],
  ['/home/sam/downloads/sam_accessKeys.csv', SECRET],
  ['/home/sam/downloads/rootkey.csv', SECRET],
  ['/home/sam/app/gcp/service-account-prod.json', SECRET],
  ['/home/sam/app/gcp/service_account.json', SECRET],
  ['/home/sam/app/firebase/serviceAccountKey.json', SECRET],
  ['/home/sam/.kube/config', SECRET],
  ['/home/sam/app/deploy/kubeconfig', SECRET],
  ['/home/sam/app/deploy/staging.kubeconfig', SECRET],
  ['/home/sam/app/deploy/kubeconfig-prod.yaml', SECRET],
  ['/home/sam/app/deploy/kubeconfig.yml', SECRET],
  ['/home/sam/app/deploy/KUBECONFIG', SECRET, 'case'],
  // infrastructure
  ['/home/sam/app/infra/terraform.tfstate', SECRET],
  ['/home/sam/app/infra/terraform.tfstate.backup', SECRET],
  ['/home/sam/app/infra/terraform.tfstate.d/prod/terraform.tfstate', SECRET],
  ['/home/sam/app/infra/prod.tfvars', SECRET],
  ['/home/sam/app/infra/prod.auto.tfvars.json', SECRET],
  ['C:\\Users\\sam\\app\\infra\\dev.tfvars', SECRET],
  ['/home/sam/.terraformrc', SECRET],
  ['C:\\Users\\sam\\AppData\\Roaming\\terraform.rc', SECRET],
  ['/home/sam/.terraform.d/credentials.tfrc.json', SECRET],
  ['/home/sam/.vault-token', SECRET],
  // databases and web servers
  ['/home/sam/.pgpass', SECRET],
  ['C:\\Users\\sam\\AppData\\Roaming\\postgresql\\pgpass.conf', SECRET],
  ['/home/sam/.my.cnf', SECRET],
  ['/home/sam/.mylogin.cnf', SECRET],
  ['/srv/www/.htpasswd', SECRET],
  // names that say so, in config formats
  ['/home/sam/app/k8s/db-secret.yaml', SECRET],
  ['/home/sam/app/config/secrets.yml', SECRET],
  ['/home/sam/app/config/secrets.json', SECRET],
  ['/home/sam/app/config/Secrets.JSON', SECRET, 'case'],
  ['/home/sam/app/config/secrets.toml', SECRET],
  ['/home/sam/app/client_secret_123.apps.googleusercontent.com.json', SECRET],
  ['/home/sam/android/secrets.properties', SECRET],
  ['/home/sam/android/res/values/secrets.xml', SECRET],
  ['/home/sam/app/config/db-credentials.ini', SECRET],
  ['/home/sam/app/config/credentials.yml', SECRET],
  ['/home/sam/.claude/.credentials.json', SECRET],
  ['/home/sam/work/credentials-service/src/index.ts', SECRET], // as before #125: a folder named credentials* hides what's inside
  ['/home/sam/app/docs/credentials.md', SECRET], // as before #125: a name that starts with credentials, in any format
  ['/home/sam/app/src/credentials.go', SECRET],
  // folders, as settings check them (with a separator at the end)
  ['/home/sam/work/.azure/', SECRET],
  ['/home/sam/work/.config/gcloud/', SECRET],
  ['C:\\Users\\sam\\work\\.kube\\', SECRET],
  // ordinary files that look alike: readable
  ['/home/sam/app/docs/secrets.md', READABLE],
  ['/home/sam/app/docs/SECRETS.MD', READABLE],
  ['/home/sam/app/src/secret_test.go', READABLE],
  ['/home/sam/app/src/secrets/manager.go', READABLE],
  ['/home/sam/app/src/environment.ts', READABLE],
  ['C:\\Users\\sam\\app\\src\\environment.ts', READABLE],
  ['/home/sam/app/src/env.ts', READABLE],
  ['/home/sam/app/config/environment.yml', READABLE],
  ['/home/sam/app/src/keys.go', READABLE],
  ['/home/sam/app/src/apikey.go', READABLE],
  ['/home/sam/app/src/tokenizer.py', READABLE],
  ['/home/sam/app/src/kubeconfig.go', READABLE],
  ['/home/sam/app/src/service_account.py', READABLE],
  ['/home/sam/app/src/credential_helper.go', READABLE],
  ['/home/sam/app/infra/main.tf', READABLE],
  ['/home/sam/app/infra/terraform.tfvars.example', READABLE],
  ['/home/sam/app/android/gradle.properties', READABLE], // only the one in ~/.gradle holds your credentials
  ['/home/sam/app/settings.xml', READABLE], // only the one in ~/.m2
  ['/home/sam/app/inventory/hosts.yml', READABLE], // only the one in ~/.config/gh
  ['/home/sam/app/auth.json', READABLE], // only the one in Composer's folders
  ['/home/sam/app/.secrets.baseline', READABLE],
  ['/home/sam/app/certs/ca.crt', READABLE],
  ['/home/sam/app/.dockerignore', READABLE],
  ['/home/sam/app/.docker/php/Dockerfile', READABLE],
  ['/home/sam/app/docker-compose.yml', READABLE],
  ['/home/sam/app/.github/workflows/ci.yml', READABLE],
  ['/home/sam/app/README.md', READABLE],
  ['/home/sam/app/package.json', READABLE],
  ['/home/sam/work/app/', READABLE],
];

describe('the files answers never read', () => {
  const L = lists('/home/sam/.obysphere');
  const isRule = (p, opts) => L.SECRET_DENY.some((r) => globMatches(ruleGlob(r), p, opts));
  const isGlob = (p, opts) => L.SECRET_GLOBS.some((g) => globMatches(g, p, opts));

  test('one table makes all three lists', () => {
    assert.ok(L.SECRET_FILES.length >= 60, 'the table');
    assert.deepEqual(L.SECRET_GLOBS, L.SECRET_FILES.map((n) => (n.endsWith('/') ? `**/${n}**` : `**/${n}`)));
    assert.deepEqual(L.SECRET_DENY.slice(0, L.SECRET_GLOBS.length), L.SECRET_GLOBS.map((g) => `Read(${g})`), 'a Read rule for every glob, in the same order');
    // the rest are about this machine's Obysphere profiles (token, keys, pins), which isSecretPath checks apart
    const profiles = L.SECRET_DENY.slice(L.SECRET_GLOBS.length);
    assert.ok(profiles.length >= 6);
    for (const r of profiles) assert.match(r, /^Read\((\*\*\/\.obysphere\*|\/\/home\/sam\/\.obysphere)\/\*\/[^,\s()]+\)$/);
    assert.equal(new Set(L.SECRET_FILES).size, L.SECRET_FILES.length, 'no entry twice');
    // the rules go on Claude Code's command line joined with commas
    for (const r of L.SECRET_DENY) assert.match(r, /^Read\([^,\s()]+\)$/, `${r} has no comma, space or parenthesis`);
    assert.ok(L.SECRETISH.flags.includes('i'), 'SECRETISH ignores case');
  });

  test('the regex, the globs and the deny rules agree on every sample path', () => {
    for (const [p, secret, spelled] of SAMPLES) {
      assert.equal(L.SECRETISH.test(p), secret, `SECRETISH: ${p}`);
      // the rules and globs are lower case where the files are; matched ignoring case, as
      // macOS and Windows file systems do, they give SECRETISH's answer for every spelling
      assert.equal(isGlob(p), secret, `SECRET_GLOBS: ${p}`);
      assert.equal(isRule(p), secret, `SECRET_DENY: ${p}`);
      // and matched case by case, for the usual spelling
      if (spelled !== 'case') {
        assert.equal(isGlob(p, { ignoreCase: false }), secret, `SECRET_GLOBS, case by case: ${p}`);
        assert.equal(isRule(p, { ignoreCase: false }), secret, `SECRET_DENY, case by case: ${p}`);
      }
    }
    // every entry of the table is tried by at least one sample
    for (const g of L.SECRET_GLOBS) assert.ok(SAMPLES.some(([p, secret]) => secret && globMatches(g, p)) || /\*(secret|credential)\*\./.test(g), `a sample for ${g}`);
  });

  // never-read: an owner's own names (machine.neverRead) are made by the same code, and an answer
  // gets them after the table's, in each form (test/never-read.test.mjs has the rest)
  test("with an owner's own names added, the three forms still agree, and every secret stays", () => {
    const OWN = ['*.sqlite', 'customers/', 'notes/private-*.md'];
    const own = L.denyListForms(OWN);
    assert.deepEqual(L.denyListForms(L.SECRET_FILES).globs, L.SECRET_GLOBS, 'the same code makes the table');
    const regex = (p) => L.SECRETISH.test(p) || own.regex.test(p);
    const globs = [...L.SECRET_GLOBS, ...own.globs];
    const rules = [...L.SECRET_DENY, ...own.deny];
    const theirs = [
      ['/home/sam/app/db/app.sqlite', SECRET],
      ['C:\\Users\\sam\\app\\db\\APP.SQLITE', SECRET, 'case'],
      ['/home/sam/app/customers/2026/list.csv', SECRET],
      ['/home/sam/app/notes/private-q3.md', SECRET],
      ['/home/sam/app/notes/public.md', READABLE],
      ['/home/sam/app/src/customers.ts', READABLE],
      ['/home/sam/app/db/app.sqlite3', READABLE],
    ];
    for (const [p, secret, spelled] of [...SAMPLES, ...theirs]) {
      assert.equal(regex(p), secret, `SECRETISH and theirs: ${p}`);
      assert.equal(globs.some((g) => globMatches(g, p)), secret, `SECRET_GLOBS and theirs: ${p}`);
      assert.equal(rules.some((r) => globMatches(ruleGlob(r), p)), secret, `SECRET_DENY and theirs: ${p}`);
      if (spelled !== 'case') assert.equal(globs.some((g) => globMatches(g, p, { ignoreCase: false })), secret, `case by case: ${p}`);
    }
  });

  test("the files in your home folder that the sandbox names are on the list", () => {
    for (const h of L.SECRET_HOME) {
      const p = path.posix.join('/home/sam', h);
      assert.ok(L.SECRETISH.test(p) && isGlob(p, { ignoreCase: false }) && isRule(p, { ignoreCase: false }), `~/${h} is on the list`);
    }
  });

  test('nothing on the list before #125 was dropped', () => {
    for (const g of BEFORE.globs) assert.ok(L.SECRET_GLOBS.includes(g), `still ${g}`);
    for (const r of BEFORE.deny) assert.ok(L.SECRET_DENY.includes(r), `still ${r}`);
    assert.deepEqual(L.SECRET_GLOBS.slice(0, BEFORE.globs.length).sort(), [...BEFORE.globs].sort(), 'the old list comes first');
    for (const [p] of SAMPLES) if (BEFORE.regex.test(p)) assert.ok(L.SECRETISH.test(p), `still secret: ${p}`);
    // the new entries, which weren't on it
    for (const p of ['/x/prod.env', '/x/terraform.tfstate', '/x/prod.tfvars', '/x/k8s/db-secret.yaml', '/x/secrets.json', '/x/a.p12', '/x/a.pfx', '/x/a.jks', '/x/kubeconfig', '/x/service-account.json'])
      assert.ok(!BEFORE.regex.test(p) && L.SECRETISH.test(p), `new: ${p}`);
  });
});

describe('end to end: an answer, sphere_attach and settings', () => {
  let relay, serve, base, tmp, home, work, cfg, fake, attacher, ids, serveOut = '';
  const procs = [];
  const env = () => ({ ...process.env, OBYSPHERE_HOME: home, CLAUDE_CONFIG_DIR: cfg, OBYSPHERE_CHROME: '0', OBYSPHERE_MINUTE_MS: '3000', OBYSPHERE_PROBE_CACHE_MS: '0', PATH: `${path.dirname(attacher.claude)}${path.delimiter}${path.dirname(fake.claude)}${path.delimiter}${process.env.PATH}` });
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
  const call = async (method, url, { tok, body } = {}) => {
    const h = {};
    if (tok) h.authorization = `Bearer ${tok}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(base + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const writeSettings = (folders) =>
    fs.writeFileSync(path.join(home, 'bob', 'settings.json'), JSON.stringify({ version: 2, access: { default: 'answer' }, machine: { folders: folders.map((f) => ({ path: f, write: false })), shell: 'read' } }), { mode: 0o600 });

  // bob's folder: secret files beside ordinary ones that look alike
  const SECRET_FILES = ['config/prod.env', '.envrc', '.env.example', 'upper/PROD.ENV', 'infra/terraform.tfstate', 'infra/terraform.tfstate.backup', 'infra/prod.tfvars', 'k8s/db-secret.yaml', 'config/secrets.json', 'certs/client.p12', 'certs/server.pfx', 'android/release.jks', 'android/debug.keystore', 'deploy/kubeconfig', 'gcp/service-account-prod.json', '.azure/msal_token_cache.json', 'keys/id_dsa', 'credentials-service/notes.txt'];
  const READABLE_FILES = ['docs/secrets.md', 'src/environment.ts', 'src/keys.go', 'src/tokenizer.py', 'src/secret_test.go', 'src/kubeconfig.go', 'infra/main.tf', 'android/gradle.properties', '.secrets.baseline', 'README.md'];

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-deny-list-')));
    home = path.join(tmp, 'reps');
    work = path.join(tmp, 'work');
    cfg = path.join(tmp, 'claude-config');
    for (const d of [home, work, cfg]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ mcpServers: {}, projects: {} }));
    for (const f of [...SECRET_FILES, ...READABLE_FILES]) {
      fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
      fs.writeFileSync(path.join(work, f), `contents of ${f}\n`);
    }
    fake = makeFakeRuntimes(path.join(tmp, 'bin'));
    fake.control({});
    attacher = makeAttachingClaude(path.join(tmp, 'bin-attach'), fake.claude);
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    relay = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', path.join(tmp, 'relay')], {
      env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_STORE: 'fs', SPHERE_SEALED: '0' },
      stdio: process.env.SPHERE_TEST_DEBUG ? 'inherit' : 'ignore',
    });
    procs.push(relay);
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(base + '/healthz')).ok) break;
      } catch {}
      await sleep(100);
    }
    for (const n of ['alice', 'bob']) {
      const { out } = await rep(['join', `${base}/#key=${KEY}`, '--name', n, '--owner', `${n[0].toUpperCase()}${n.slice(1)} Test`, '--cwd', work]);
      assert.match(out, /joined/, out);
    }
    fs.writeFileSync(path.join(home, 'bob', 'profile.json'), JSON.stringify({ ...profile('bob'), claudeBin: attacher.claude, codexBin: fake.codex, cursorBin: fake.cursor }), { mode: 0o600 });
    writeSettings([work]);
    ids = { alice: profile('alice').agent.id, bob: profile('bob').agent.id };
    serve = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'serve', '--profile', 'bob'], { env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
    procs.push(serve);
    serve.stdout.on('data', (d) => (serveOut += d));
    serve.stderr.on('data', (d) => (serveOut += d));
    for (let i = 0; i < 100 && !/is online/.test(serveOut); i++) await sleep(100);
    assert.match(serveOut, /is online/, serveOut);
  });
  after(() => {
    for (const p of procs) p.kill();
    if (!process.env.SPHERE_TEST_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("alice asks bob's Oby for every file: the secret ones stay, and the answer had every rule", async () => {
    const files = [...SECRET_FILES, ...READABLE_FILES];
    const text = `Please send me these files from your folder:\n${files.map((f) => `ATTACH ${f}`).join('\n')}`;
    const tok = profile('alice').token;
    const asked = await call('POST', '/api/messages', { tok, body: { channel: 'general', text, to: [ids.bob] } });
    assert.ok(asked.message, JSON.stringify(asked));
    let reply;
    for (let i = 0; i < 40 && !reply; i++) reply = ((await call('GET', `/api/messages/${asked.message.id}/replies?wait=3`, { tok })).replies || []).find((r) => r.from === ids.bob);
    assert.ok(reply, `bob replied\n${serveOut.slice(-3000)}`);
    assert.ok(!reply.meta?.error && !reply.meta?.declined, reply.text);

    // what sphere_attach said for each file, as the fake model reports it
    const said = Object.fromEntries(reply.text.split('\n').map((l) => [l.slice(0, l.indexOf(': ')), l.slice(l.indexOf(': ') + 2)]));
    for (const f of SECRET_FILES) assert.equal(said[f], "Error: that file looks like a secret; not attaching it", f);
    for (const f of READABLE_FILES) assert.match(said[f] || '', /^Attached /, f);
    // and what went out with the reply: the ordinary files only
    assert.deepEqual(reply.files.map((f) => f.name).sort(), READABLE_FILES.map((f) => path.basename(f).replace(/^\.+/, '')).sort());

    // the answer's Claude Code got every rule on its command line and in its settings file,
    // and the sandbox (shell: read) every glob and every file in your home folder on the list
    const a = attacher.answers().at(-1);
    const L = lists(path.resolve(home));
    const flag = (f) => a.argv[a.argv.indexOf(f) + 1];
    assert.deepEqual(flag('--disallowedTools').split(',').filter((r) => r.startsWith('Read(')), L.SECRET_DENY);
    assert.deepEqual(a.settings.permissions.deny.filter((r) => r.startsWith('Read(')), L.SECRET_DENY);
    const denyRead = a.settings.sandbox.filesystem.denyRead;
    assert.deepEqual(denyRead.slice(0, L.SECRET_GLOBS.length), L.SECRET_GLOBS);
    assert.ok(denyRead.includes(path.resolve(home)), 'your Obysphere profiles');
    for (const h of [...L.SECRET_HOME, '.ssh', '.aws', '.config/gh', '.claude/.credentials.json']) assert.ok(denyRead.includes(path.join(os.homedir(), h)), `~/${h}`);
  });

  test('settings refuse a folder of credentials', async () => {
    // a folder on the list, or inside one
    for (const d of ['.azure', '.config/gcloud', 'deploy.env', '.secrets/prod']) {
      const folder = path.join(tmp, 'creds', d);
      fs.mkdirSync(folder, { recursive: true });
      writeSettings([work, folder]);
      const { out, code } = await rep(['settings', '--profile', 'bob']);
      assert.equal(code, 1, out);
      assert.match(out, /machine\.folders\[1\]\.path: looks like a folder of keys or credentials/, out);
    }
    // an ordinary folder is fine
    const ok = path.join(tmp, 'creds', 'docs');
    fs.mkdirSync(ok, { recursive: true });
    writeSettings([work, ok]);
    const { out, code } = await rep(['settings', '--profile', 'bob']);
    assert.equal(code, 0, out);
  });
});
