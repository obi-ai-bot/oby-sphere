// Moving your Oby to a new computer (rep.mjs profile export and import), end to end, with a
// sealed relay and a fake Claude Code first on PATH (no model, no network): a round trip into a
// fresh OBYSPHERE_HOME (whoami, an ask answered there, peers' pins unchanged), a wrong
// passphrase, a changed byte in the header or the body, refusing to replace a profile, the
// passphrase never in argv or in the file, file modes, settings whose folders aren't on the new
// computer, and an export's contents checked as untrusted once opened. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeFakeRuntimes } from './fake-runtimes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const REP = path.join(ROOT, 'rep.mjs');
const KEY = 'join-key-profile-0123456789';
const ADMIN = 'admin-key-profile-0123456789';
const PASS = 'correct horse battery staple 42';
const BEFORE = 'ANSWER-FROM-THE-OLD-COMPUTER';
const AFTER = 'ANSWER-FROM-THE-NEW-COMPUTER';
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (b) => Buffer.from(b).toString('base64url');
const mode = (f) => fs.statSync(f).mode & 0o777;
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// the format as SECURITY.md describes it, written here on its own: header line, newline,
// base64url(ciphertext ‖ tag), newline; scrypt for the key, AES-256-GCM with the header as AAD
function openExport(buf, pass) {
  const nl = buf.indexOf(0x0a);
  const header = buf.subarray(0, nl);
  const h = JSON.parse(header.toString('utf8'));
  const body = Buffer.from(buf.subarray(nl + 1, -1).toString('latin1'), 'base64url');
  const key = crypto.scryptSync(Buffer.from(pass.normalize('NFC')), Buffer.from(h.kdf.salt, 'base64url'), 32, { N: h.kdf.N, r: h.kdf.r, p: h.kdf.p, maxmem: 256 * h.kdf.N * h.kdf.r });
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(h.cipher.nonce, 'base64url'));
  d.setAAD(header);
  d.setAuthTag(body.subarray(-16));
  return { header: h, payload: JSON.parse(Buffer.concat([d.update(body.subarray(0, -16)), d.final()]).toString('utf8')) };
}
function makeExport(payload, pass, { N = 2 ** 15, r = 8, p = 1 } = {}) {
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const header = Buffer.from(JSON.stringify({ format: 'obysphere-profile', version: 1, kdf: { name: 'scrypt', N, r, p, salt: b64(salt) }, cipher: { name: 'aes-256-gcm', nonce: b64(nonce) } }));
  const key = crypto.scryptSync(Buffer.from(pass), salt, 32, { N, r, p, maxmem: 256 * N * r });
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(header);
  const body = Buffer.concat([c.update(JSON.stringify(payload)), c.final(), c.getAuthTag()]);
  return Buffer.concat([header, Buffer.from('\n'), Buffer.from(b64(body)), Buffer.from('\n')]);
}

describe('moving your Oby to a new computer', () => {
  let tmp, relay, base, oldHome, newHome, userHome, work, fake, file;
  const procs = [];
  // every rep.mjs here: fake runtimes first on PATH, its own profiles, home and Claude Code config,
  // and no passphrase unless the test gives one
  const env = (home, extra = {}) => {
    const e = { ...process.env, PATH: `${path.join(tmp, 'bin')}${path.delimiter}${process.env.PATH}`, HOME: userHome, OBYSPHERE_HOME: home, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude-config'), OBYSPHERE_PROBE_CACHE_MS: '0', OBYSPHERE_DOWNLOADS: path.join(tmp, 'downloads') };
    delete e.OBYSPHERE_PASSPHRASE;
    delete e.OBYSPHERE_PROFILE;
    return { ...e, ...extra };
  };
  const rep = (home, args, extra) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [REP, ...args], { env: env(home, extra), stdio: ['pipe', 'pipe', 'pipe'] });
      p.stdin.end();
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.stderr.on('data', (d) => (stderr += d));
      const t = setTimeout(() => p.kill(), 60000);
      p.on('close', (code) => {
        clearTimeout(t);
        resolve({ code, out: stdout + stderr, stdout, stderr });
      });
    });
  const withPass = (pass = PASS) => ({ OBYSPHERE_PASSPHRASE: pass });
  const serve = async (home, profile) => {
    const p = spawn(process.execPath, [REP, 'serve', '--profile', profile], { env: env(home), stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    for (let i = 0; i < 150 && !/is online/.test(out); i++) await sleep(100);
    assert.match(out, /is online/, out);
    return {
      out: () => out,
      stop: () =>
        new Promise((resolve) => {
          if (p.exitCode !== null || p.signalCode !== null) return resolve();
          p.once('exit', resolve);
          p.kill();
        }),
    };
  };
  const askBob = (text) => rep(oldHome, ['ask', 'bob', text, '--profile', 'alice', '--wait', '30']);
  // nothing written by a refused import: not the profile, not even the profiles' folder
  const nothingImported = (r, home = newHome) => {
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /nothing was imported/i, r.out);
    assert.ok(!fs.existsSync(home), `nothing in ${home}: ${fs.existsSync(home) ? fs.readdirSync(home) : ''}`);
  };

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-profile-')));
    oldHome = path.join(tmp, 'old-computer');
    newHome = path.join(tmp, 'new-computer');
    userHome = path.join(tmp, 'home');
    work = path.join(tmp, 'work');
    for (const d of [path.join(tmp, 'relay'), userHome, path.join(work, 'alice'), path.join(work, 'bob'), path.join(work, 'carol'), path.join(tmp, 'claude-config')]) fs.mkdirSync(d, { recursive: true });
    fake = makeFakeRuntimes(path.join(tmp, 'bin'));
    fake.control({ text: BEFORE });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    relay = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', path.join(tmp, 'relay')], {
      env: { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_SEALED: '1', SPHERE_STORE: 'fs' },
      stdio: process.env.SPHERE_TEST_DEBUG ? 'inherit' : 'ignore',
    });
    procs.push(relay);
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
      await sleep(100);
    }
  });
  after(async () => {
    await Promise.all(procs.map((p) => (p.exitCode !== null || p.signalCode !== null ? null : new Promise((r) => { p.once('exit', r); p.kill(); }))));
    if (!process.env.SPHERE_TEST_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('on the old computer: alice and bob joined a sealed Sphere and pinned each other', async () => {
    for (const n of ['alice', 'bob', 'carol']) {
      const r = await rep(oldHome, ['join', `${base}/#key=${KEY}`, '--name', n, '--owner', `${n[0].toUpperCase()}${n.slice(1)} Test`, '--cwd', path.join(work, n)]);
      assert.match(r.out, /joined/, r.out);
    }
    const bob = await serve(oldHome, 'bob');
    const r = await askBob('hello, before the move');
    assert.match(r.out, new RegExp(BEFORE), r.out + bob.out());
    await bob.stop();
    const bobId = readJson(path.join(oldHome, 'bob', 'profile.json')).agent.id;
    const aliceId = readJson(path.join(oldHome, 'alice', 'profile.json')).agent.id;
    assert.ok(readJson(path.join(oldHome, 'alice', 'peers.json'))[bobId].sign, "alice pinned bob's keys");
    assert.ok(readJson(path.join(oldHome, 'bob', 'peers.json'))[aliceId].sign, "bob pinned alice's keys");
    // what stays on the old computer: today's usage and the local conversation
    assert.ok(fs.existsSync(path.join(oldHome, 'bob', 'usage')) && fs.existsSync(path.join(oldHome, 'bob', 'sessions.json')));
  });

  test('the passphrase never goes in argv; an empty, short or missing one writes nothing', async () => {
    const out = path.join(tmp, 'refused.obyprofile');
    let r = await rep(oldHome, ['profile', 'export', '--profile', 'bob', '--out', out, '--passphrase', PASS], withPass());
    assert.equal(r.code, 1);
    assert.match(r.out, /never goes on the command line/);
    assert.ok(!r.out.includes(PASS), 'not even echoed back');
    r = await rep(oldHome, ['profile', 'export', '--profile', 'bob', '--out', out], withPass('short'));
    assert.equal(r.code, 1);
    assert.match(r.out, /too short: use at least 12 characters/);
    r = await rep(oldHome, ['profile', 'export', '--profile', 'bob', '--out', out], withPass('   '));
    assert.match(r.out, /is empty/);
    // no variable and no terminal (stdin is a pipe here): says how to give it
    r = await rep(oldHome, ['profile', 'export', '--profile', 'bob', '--out', out]);
    assert.equal(r.code, 1);
    assert.match(r.out, /no passphrase: set OBYSPHERE_PASSPHRASE.*terminal/);
    assert.ok(!fs.existsSync(out), 'no file written by any of these');
    // nor inside a folder an Oby on this computer may read: another Oby could ask for it
    r = await rep(oldHome, ['profile', 'export', '--profile', 'bob', '--out', path.join(work, 'bob', 'bob.obyprofile')], withPass());
    assert.equal(r.code, 1);
    assert.match(r.out, /inside a folder an Oby on this computer may read/);
    assert.ok(!fs.existsSync(path.join(work, 'bob', 'bob.obyprofile')));
    // the same folder in another letter case, on a disk that ignores case (macOS, Windows)
    const otherCase = path.join(tmp, 'WORK', 'BOB');
    if (fs.existsSync(otherCase)) {
      r = await rep(oldHome, ['profile', 'export', '--profile', 'bob', '--out', path.join(otherCase, 'bob.obyprofile')], withPass());
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /inside a folder an Oby on this computer may read/);
      assert.ok(!fs.readdirSync(path.join(work, 'bob')).some((n) => n.endsWith('.obyprofile')));
    }
  });

  test('export: one file, 0600, with nothing readable in it', async () => {
    file = path.join(tmp, 'bob.obyprofile');
    const r = await rep(oldHome, ['profile', 'export', '--profile', 'bob', '--out', file], withPass());
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Exported bob/);
    assert.match(r.out, /It holds: +your token and the Sphere's address \(http:\/\/127\.0\.0\.1:\d+\), your private keys, the keys you pinned for 1 other Oby, your settings/);
    assert.match(r.out, /Left out: +usage counts, asks waiting for you, local conversations/);
    assert.match(r.out, /stop your Oby here/);
    assert.doesNotMatch(r.out, /had no keys/);
    assert.equal(mode(file), 0o600);
    const buf = fs.readFileSync(file);
    const text = buf.toString('latin1');
    const prof = readJson(path.join(oldHome, 'bob', 'profile.json'));
    const keys = readJson(path.join(oldHome, 'bob', 'keys.json'));
    for (const secret of [PASS, prof.token, keys.seal.d, keys.sign.d, keys.seal.x, prof.agent.id, 'Bob Test', 'profile.json', String(path.join(work, 'bob'))]) {
      assert.ok(!text.includes(secret), `the file never shows ${secret.slice(0, 12)}…`);
      assert.ok(!r.out.includes(secret) || secret === 'profile.json', `nor does the output: ${secret.slice(0, 12)}…`);
    }
    // the header, in the clear and authenticated: strong scrypt, a fresh salt and nonce
    const lines = text.split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[2], '');
    const h = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(h), ['format', 'version', 'kdf', 'cipher']);
    assert.equal(h.format, 'obysphere-profile');
    assert.equal(h.version, 1);
    assert.equal(h.kdf.name, 'scrypt');
    assert.ok(h.kdf.N >= 2 ** 17 && h.kdf.r >= 8 && h.kdf.p >= 1, JSON.stringify(h.kdf));
    assert.equal(Buffer.from(h.kdf.salt, 'base64url').length, 16);
    assert.equal(h.cipher.name, 'aes-256-gcm');
    assert.equal(Buffer.from(h.cipher.nonce, 'base64url').length, 12);
    // opened as SECURITY.md describes: exactly the Oby, and none of this computer's own
    const { payload } = openExport(buf, PASS);
    assert.deepEqual(Object.keys(payload.files).sort(), ['keys.json', 'peers.json', 'profile.json', 'settings.json']);
    assert.equal(payload.profile, 'bob');
    assert.equal(payload.files['profile.json'].token, prof.token);
    assert.deepEqual(payload.files['keys.json'].seal, keys.seal);
    assert.deepEqual(payload.files['peers.json'], readJson(path.join(oldHome, 'bob', 'peers.json')));
    assert.deepEqual(payload.files['settings.json'], readJson(path.join(oldHome, 'bob', 'settings.json')));
    // a second export over it needs --force; a fresh salt and nonce every time
    const again = await rep(oldHome, ['profile', 'export', '--profile', 'bob', '--out', file], withPass());
    assert.equal(again.code, 1);
    assert.match(again.out, /is there already: pick another --out, or add --force/);
    assert.deepEqual(fs.readFileSync(file), buf);
    const forced = await rep(oldHome, ['profile', 'export', '--profile', 'bob', '--out', file, '--force'], withPass());
    assert.equal(forced.code, 0, forced.out);
    assert.equal(mode(file), 0o600);
    const h2 = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
    assert.notEqual(h2.kdf.salt, h.kdf.salt);
    assert.notEqual(h2.cipher.nonce, h.cipher.nonce);
  });

  test('a wrong passphrase writes nothing', async () => {
    const r = await rep(newHome, ['profile', 'import', file], withPass('not the right passphrase'));
    nothingImported(r);
    assert.match(r.out, /wrong passphrase, or the file was changed or damaged/);
  });

  test('a changed byte in the header or the body fails, and writes nothing', async () => {
    const good = fs.readFileSync(file, 'utf8');
    const [header, body] = good.split('\n');
    const h = JSON.parse(header);
    const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
    const cases = {
      'a space in the header (it parses the same)': `${header.replace('{"format"', '{ "format"')}\n${body}\n`,
      'weaker scrypt in the header': `${header.replace(`"N":${h.kdf.N}`, `"N":${h.kdf.N / 2}`)}\n${body}\n`,
      'a byte of the salt': `${header.replace(h.kdf.salt, flip(h.kdf.salt, 3))}\n${body}\n`,
      'a byte of the nonce': `${header.replace(h.cipher.nonce, flip(h.cipher.nonce, 5))}\n${body}\n`,
      'a byte in the middle of the body': `${header}\n${flip(body, Math.floor(body.length / 2))}\n`,
      'the last byte of the body (the tag)': `${header}\n${body.slice(0, -1)}${body.at(-1) === 'A' ? 'B' : 'A'}\n`,
      'a byte cut off the end': `${header}\n${body.slice(0, -1)}\n`,
      'a byte added at the end': `${header}\n${body}A\n`,
      'the last newline gone': `${header}\n${body}`,
      'another format': `${header.replace('obysphere-profile', 'obysphere-profilf')}\n${body}\n`,
      'a newer version': `${header.replace('"version":1', '"version":2')}\n${body}\n`,
    };
    for (const [what, content] of Object.entries(cases)) {
      const f = path.join(tmp, 'tampered.obyprofile');
      fs.writeFileSync(f, content);
      const r = await rep(newHome, ['profile', 'import', f], withPass());
      nothingImported(r);
      assert.match(r.out, what === 'another format' ? /isn't an Oby's profile export/ : what === 'a newer version' ? /made by a newer rep\.mjs/ : /wrong passphrase, or the file was changed or damaged|is damaged/, `${what}: ${r.out}`);
    }
  });

  test('import: a new profile, 0700 with files 0600, holding the same Oby', async () => {
    const r = await rep(newHome, ['profile', 'import', file], withPass());
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Imported bob into .*new-computer.bob: bob, Bob Test's Oby/);
    assert.match(r.out, /still match, so they see no change/);
    assert.match(r.out, /Stop your Oby on the old computer.*\n.*same token: while both run, each ask goes to whichever takes it first/);
    assert.ok(!r.out.includes(PASS));
    const dir = path.join(newHome, 'bob');
    assert.equal(mode(dir), 0o700);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['keys.json', 'peers.json', 'profile.json', 'settings.json'], 'nothing of the old computer’s own');
    for (const n of fs.readdirSync(dir)) assert.equal(mode(path.join(dir, n)), 0o600, n);
    const was = (n) => readJson(path.join(oldHome, 'bob', n));
    const now = (n) => readJson(path.join(dir, n));
    for (const k of ['token', 'sphere', 'agent', 'sphereName', 'cwd']) assert.deepEqual(now('profile.json')[k], was('profile.json')[k], k);
    assert.equal(now('profile.json').profile, 'bob');
    assert.deepEqual(now('keys.json').seal, was('keys.json').seal);
    assert.deepEqual(now('keys.json').sign, was('keys.json').sign);
    assert.deepEqual(now('peers.json'), was('peers.json'));
    assert.deepEqual(now('settings.json'), was('settings.json'));
  });

  test("the imported Oby works: whoami, an ask answered there, and peers' pins unchanged", async () => {
    const alicePins = fs.readFileSync(path.join(oldHome, 'alice', 'peers.json'), 'utf8');
    const who = await rep(newHome, ['whoami']);
    assert.equal(who.code, 0, who.out);
    assert.match(who.out, /bob — representative of Bob Test/);
    assert.match(who.out, /sealing: on on this Sphere · your keys published/);
    fake.control({ text: AFTER });
    const bob = await serve(newHome, 'bob');
    const r = await askBob('hello, after the move');
    await bob.stop();
    assert.match(r.out, new RegExp(AFTER), r.out + bob.out());
    assert.doesNotMatch(r.out + bob.out(), /doesn't verify|keys changed|Not sealing/);
    assert.ok(fs.existsSync(path.join(newHome, 'bob', 'usage')), 'answered on the new computer');
    assert.equal(fs.readFileSync(path.join(oldHome, 'alice', 'peers.json'), 'utf8'), alicePins, "alice's pins didn't change");
  });

  test('refuses to replace a profile unless --force, and says what it replaces', async () => {
    const dir = path.join(newHome, 'bob');
    const before = fs.readFileSync(path.join(dir, 'profile.json'), 'utf8');
    let r = await rep(newHome, ['profile', 'import', file], withPass());
    assert.equal(r.code, 1);
    assert.match(r.out, /there's a profile "bob" here already .*--profile <name>, or add --force/);
    // with --profile, refused before any passphrase is asked for (none is given here)
    r = await rep(newHome, ['profile', 'import', file, '--profile', 'bob']);
    assert.equal(r.code, 1);
    assert.match(r.out, /here already/);
    assert.equal(fs.readFileSync(path.join(dir, 'profile.json'), 'utf8'), before);
    r = await rep(newHome, ['profile', 'import', file, '--force'], withPass());
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Replacing profile bob \(bob, Bob Test's Oby in .*\): its token, keys, pinned keys and settings/);
    assert.match(r.out, /The same keys: nothing changes for other Obys/);
    assert.equal(mode(dir), 0o700);
    for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) assert.equal(mode(path.join(dir, n)), 0o600, n);
    // under another name: the same Oby twice on one computer is flagged
    r = await rep(newHome, ['profile', 'import', file, '--profile', '../Bob Two'], withPass());
    assert.equal(r.code, 0, r.out);
    assert.ok(fs.existsSync(path.join(newHome, 'bob-two', 'profile.json')), 'a plain name, inside the profiles folder');
    assert.match(r.out, /Profile bob on this computer is the same Oby: run only one of them/);
  });

  test('when the keys do change, the output says so instead of "no change"', async () => {
    // a copy of bob's profile without its keys (keys lost): the export makes new ones, and says so
    const lost = path.join(tmp, 'lost-keys');
    fs.mkdirSync(path.join(lost, 'bob'), { recursive: true, mode: 0o700 });
    for (const n of ['profile.json', 'peers.json', 'settings.json']) fs.copyFileSync(path.join(oldHome, 'bob', n), path.join(lost, 'bob', n));
    const f = path.join(tmp, 'bob-new-keys.obyprofile');
    const ex = await rep(lost, ['profile', 'export', '--out', f], withPass());
    assert.equal(ex.code, 0, ex.out);
    assert.match(ex.out, /This profile had no keys, so new ones were made for it now/);
    // brought over bob with the keys he had: the same Oby, other keys
    const home = path.join(tmp, 'fifth-computer');
    let r = await rep(home, ['profile', 'import', file], withPass());
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /they see no change/);
    r = await rep(home, ['profile', 'import', f, '--force'], withPass());
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Its old keys are gone for good/);
    assert.match(r.out, /These aren't the keys this profile had.*\n.*any Oby that pinned the ones it had sees your keys change/);
    assert.doesNotMatch(r.out, /they see no change/);
  });

  test("settings that name folders this computer doesn't have are flagged", async () => {
    const f = path.join(tmp, 'carol.obyprofile');
    const ex = await rep(oldHome, ['profile', 'export', '--profile', 'carol', '--out', f], withPass());
    assert.equal(ex.code, 0, ex.out);
    fs.rmSync(path.join(work, 'carol'), { recursive: true });
    const home = path.join(tmp, 'third-computer');
    const r = await rep(home, ['profile', 'import', f], withPass());
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Your settings need fixing on this computer: machine\.folders\[0\]\.path: there's no folder at/);
    assert.match(r.out, /Until then your Oby declines asks/);
    assert.match(r.out, /no keys pinned for other Obys yet/);
  });

  test("an export's contents are checked once opened: names, types, sizes, keys", async () => {
    const { payload } = openExport(fs.readFileSync(file), PASS);
    const home = path.join(tmp, 'fourth-computer');
    const tryImport = async (p, args = []) => {
      const f = path.join(tmp, 'crafted.obyprofile');
      fs.writeFileSync(f, makeExport(p, PASS));
      return rep(home, ['profile', 'import', f, ...args], withPass());
    };
    const edit = (fn) => {
      const p = structuredClone(payload);
      fn(p);
      return p;
    };
    const otherKey = crypto.generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' }).d;
    const refused = {
      [`profile: "../escape" isn't a handle`]: edit((p) => (p.profile = '../escape')),
      [`isn't a file an export holds`]: edit((p) => (p.files['../../evil.json'] = {})),
      [`keys.json.seal: isn't a key pair`]: edit((p) => (p.files['keys.json'].seal.d = otherKey)),
      [`keys.json.sign.d: is a 32-byte key`]: edit((p) => (p.files['keys.json'].sign.d = 'x'.repeat(5000))),
      [`profile.json.token: isn't an agent token`]: edit((p) => (p.files['profile.json'].token = 'tok_abc\r\nx-evil: 1')),
      [`profile.json.sphere: is http:// on another machine`]: edit((p) => (p.files['profile.json'].sphere = 'http://sphere.example')),
      [`profile.json.sphere: is a Sphere address`]: edit((p) => (p.files['profile.json'].sphere = 'https://sphere.example/path')),
      [`profile.json.agent.id: isn't an Oby's id`]: edit((p) => (p.files['profile.json'].agent.id = '../a_x')),
      [`profile.json.rules: is at most 8000 characters`]: edit((p) => (p.files['profile.json'].rules = 'r'.repeat(9000))),
      [`peers.json.__proto__: isn't an Oby's id`]: edit((p) => (p.files['peers.json'] = JSON.parse('{"__proto__": {"name": "x"}}'))),
      [`settings.json: is a JSON object`]: edit((p) => (p.files['settings.json'] = ['not', 'an', 'object'])),
      [`keys.json: is missing`]: edit((p) => delete p.files['keys.json']),
    };
    for (const [why, p] of Object.entries(refused)) {
      const r = await tryImport(p);
      nothingImported(r, home);
      assert.ok(r.out.includes(why), `${why}: ${r.out}`);
    }
    assert.ok(!fs.existsSync(path.join(tmp, 'escape')) && !fs.existsSync(path.join(tmp, 'evil.json')));
    // scrypt parameters that would take too much memory are refused before any work
    const [header, body] = fs.readFileSync(file, 'utf8').split('\n');
    const f = path.join(tmp, 'greedy.obyprofile');
    fs.writeFileSync(f, `${header.replace(/"N":\d+/, `"N":${2 ** 24}`)}\n${body}\n`);
    const greedy = await rep(home, ['profile', 'import', f], withPass());
    nothingImported(greedy, home);
    assert.match(greedy.out, /is damaged \(its scrypt parameters\)/);
    // what this rep.mjs doesn't know in profile.json (a path to a runtime on the old computer) stays behind
    const r = await tryImport(edit((p) => Object.assign(p.files['profile.json'], { claudeBin: '/old/computer/bin/claude', somethingNew: 1 })));
    assert.equal(r.code, 0, r.out);
    const prof = readJson(path.join(home, 'bob', 'profile.json'));
    assert.equal(prof.claudeBin, undefined);
    assert.equal(prof.somethingNew, undefined);
    assert.equal(prof.token, payload.files['profile.json'].token);
  });

  test('help: what a backup keeps and leaves out', async () => {
    const r = await rep(oldHome, ['profile']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /The file holds your token and the Sphere's address, your private keys, the keys you pinned for other Obys, your settings/);
    assert.match(r.stdout, /It leaves out usage counts, asks waiting for you/);
    assert.match(r.stdout, /OBYSPHERE_PASSPHRASE/);
    const main = await rep(oldHome, ['--help']);
    assert.equal(main.code, 0);
    assert.match(main.stdout, /node rep\.mjs profile export \[--out <file>\] \| import <file>/);
    const wrong = await rep(oldHome, ['profile', 'backup']);
    assert.equal(wrong.code, 1);
    assert.match(wrong.out, /profile export or profile import/);
  });
});
