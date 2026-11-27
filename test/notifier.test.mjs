// macOS: Obysphere's own app for notifications (`rep.mjs notify app`), built into a folder of the
// test's own (OBYSPHERE_NOTIFIER_APP, with OBYSPHERE_TEST): its id, name, version, icon, no Dock
// icon, a signature that checks, and its program's hash kept to check it by (a changed program is
// built again). It's never opened here (that would show a notification). Elsewhere, `notify app`
// says it's for macOS. `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mac = process.platform === 'darwin';
const tools = mac && spawnSync('xcode-select', ['-p']).status === 0;
const rep = (args, env) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), ...args], { env: { ...process.env, ...env } });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', (code) => resolve({ code, out }));
  });

test('notify app builds Obysphere.app: one id, its name and icon, no Dock icon, signed for this Mac', { skip: !tools && 'macOS with the Xcode command line tools only', timeout: 180e3 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obysphere-notifier-'));
  try {
    const app = path.join(tmp, 'Applications', 'Obysphere.app');
    const r = await rep(['notify', 'app'], { OBYSPHERE_HOME: path.join(tmp, 'home'), OBYSPHERE_TEST: '1', OBYSPHERE_NOTIFIER_APP: app });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Obysphere's app for notifications and the menu bar is ready: .*Obysphere\.app/);
    const plist = JSON.parse(spawnSync('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).stdout);
    assert.equal(plist.CFBundleIdentifier, 'dev.oby.obysphere.test', 'built elsewhere: the test id, never the real one');
    assert.equal(plist.CFBundleName, 'Obysphere');
    assert.equal(plist.CFBundleExecutable, 'Obysphere');
    assert.equal(plist.LSUIElement, true, 'no Dock icon');
    assert.equal(plist.CFBundleIconFile, 'Obysphere');
    assert.ok(fs.statSync(path.join(app, 'Contents', 'Resources', 'Obysphere.icns')).size > 1000, "Obysphere's icon");
    assert.equal(spawnSync('codesign', ['-v', app]).status, 0, 'a signature that checks');
    assert.deepEqual(fs.readdirSync(path.dirname(app)), ['Obysphere.app'], 'nothing left from the build');
    // what was built, kept to check it by: the app, this version, its program's SHA-256 (0600)
    const program = path.join(app, 'Contents', 'MacOS', 'Obysphere');
    const record = path.join(tmp, 'home', 'notifier.json');
    const built = JSON.parse(fs.readFileSync(record, 'utf8'));
    assert.deepEqual({ app: built.app, version: built.version, sha256: built.sha256 }, { app, version: '2', sha256: createHash('sha256').update(fs.readFileSync(program)).digest('hex') });
    assert.equal(fs.statSync(record).mode & 0o777, 0o600);
    // built again: swapped in whole
    const again = await rep(['notify', 'app'], { OBYSPHERE_HOME: path.join(tmp, 'home'), OBYSPHERE_TEST: '1', OBYSPHERE_NOTIFIER_APP: app });
    assert.equal(again.code, 0, again.out);
    assert.deepEqual(fs.readdirSync(path.dirname(app)), ['Obysphere.app']);
    // what obysphere start asks (for the menu bar): only when it's missing or older
    const stamp = fs.statSync(path.join(app, 'Contents', 'MacOS', 'Obysphere')).mtimeMs;
    const ifNeeded = await rep(['notify', 'app', '--if-needed', '--json'], { OBYSPHERE_HOME: path.join(tmp, 'home'), OBYSPHERE_TEST: '1', OBYSPHERE_NOTIFIER_APP: app });
    assert.equal(ifNeeded.code, 0, ifNeeded.out);
    assert.deepEqual(JSON.parse(ifNeeded.out), { app, built: false });
    assert.equal(fs.statSync(path.join(app, 'Contents', 'MacOS', 'Obysphere')).mtimeMs, stamp, 'left as it was');
    // its program changed since: built again
    fs.appendFileSync(program, 'x');
    const changed = await rep(['notify', 'app', '--if-needed', '--json'], { OBYSPHERE_HOME: path.join(tmp, 'home'), OBYSPHERE_TEST: '1', OBYSPHERE_NOTIFIER_APP: app });
    assert.equal(changed.code, 0, changed.out);
    assert.deepEqual(JSON.parse(changed.out.split('\n').filter((l) => l.startsWith('{')).at(-1)), { app, built: true });
    assert.equal(createHash('sha256').update(fs.readFileSync(program)).digest('hex'), JSON.parse(fs.readFileSync(record, 'utf8')).sha256);
    fs.rmSync(app, { recursive: true });
    const missing = await rep(['notify', 'app', '--if-needed', '--json'], { OBYSPHERE_HOME: path.join(tmp, 'home'), OBYSPHERE_TEST: '1', OBYSPHERE_NOTIFIER_APP: app });
    assert.equal(missing.code, 0, missing.out);
    assert.deepEqual(JSON.parse(missing.out.split('\n').filter((l) => l.startsWith('{')).at(-1)), { app, built: true });
    assert.match(missing.out, /building Obysphere's app for notifications and the menu bar \(once\)/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('notify app elsewhere than macOS says so', { skip: mac }, async () => {
  const r = await rep(['notify', 'app'], { OBYSPHERE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'obysphere-home-')) });
  assert.equal(r.code, 1);
  assert.match(r.out, /notify app is for macOS/);
  const j = await rep(['notify', 'app', '--if-needed', '--json'], { OBYSPHERE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'obysphere-home-')) });
  assert.equal(j.code, 1);
  assert.deepEqual(JSON.parse(j.out), { app: null, error: 'notify app is for macOS' });
});

// the Swift holds both ways it runs: a notification, and the menu bar (whose menu obysphere fills)
test('the app has a menu bar mode: an icon of the Oby face, the menu from obysphere menubar model', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'rep.mjs'), 'utf8');
  const swift = src.slice(src.indexOf('const NOTIFIER_SWIFT'), src.indexOf('const notifierPath'));
  assert.match(src, /const NOTIFIER_VERSION = '2';/, 'a new version: every Mac builds it again');
  assert.match(swift, /argv\.contains\("--menu"\)/);
  assert.match(swift, /NSStatusBar\.system\.statusItem/);
  assert.match(swift, /run\(\["menubar", "model"\]/);
  assert.match(swift, /img\.isTemplate = true/, 'macOS colours the icon for the menu bar');
  // it opens only this machine's console, and runs only obysphere
  assert.match(swift, /u\.scheme == "http"/);
  assert.match(swift, /p\.arguments = \["--preserve-symlinks-main", cli\] \+ args/);
  assert.doesNotMatch(swift, /\/bin\/(ba|z)?sh/, 'no shell');
});
