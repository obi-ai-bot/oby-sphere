// macOS: Obysphere's own app for notifications (`rep.mjs notify app`), built into a folder of the
// test's own (OBYSPHERE_NOTIFIER_APP): its id, name, version, icon, no Dock icon, and a signature
// that checks. It's never opened here (that would show a notification). Elsewhere, `notify app`
// says it's for macOS. `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
    const r = await rep(['notify', 'app'], { OBYSPHERE_HOME: path.join(tmp, 'home'), OBYSPHERE_NOTIFIER_APP: app });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Obysphere's app for notifications is ready: .*Obysphere\.app/);
    const plist = JSON.parse(spawnSync('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).stdout);
    assert.equal(plist.CFBundleIdentifier, 'dev.oby.obysphere.test', 'built elsewhere: the test id, never the real one');
    assert.equal(plist.CFBundleName, 'Obysphere');
    assert.equal(plist.CFBundleExecutable, 'Obysphere');
    assert.equal(plist.LSUIElement, true, 'no Dock icon');
    assert.equal(plist.CFBundleIconFile, 'Obysphere');
    assert.ok(fs.statSync(path.join(app, 'Contents', 'Resources', 'Obysphere.icns')).size > 1000, "Obysphere's icon");
    assert.equal(spawnSync('codesign', ['-v', app]).status, 0, 'a signature that checks');
    assert.deepEqual(fs.readdirSync(path.dirname(app)), ['Obysphere.app'], 'nothing left from the build');
    // built again: swapped in whole
    const again = await rep(['notify', 'app'], { OBYSPHERE_HOME: path.join(tmp, 'home'), OBYSPHERE_NOTIFIER_APP: app });
    assert.equal(again.code, 0, again.out);
    assert.deepEqual(fs.readdirSync(path.dirname(app)), ['Obysphere.app']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('notify app elsewhere than macOS says so', { skip: mac }, async () => {
  const r = await rep(['notify', 'app'], { OBYSPHERE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'obysphere-home-')) });
  assert.equal(r.code, 1);
  assert.match(r.out, /notify app is for macOS/);
});
