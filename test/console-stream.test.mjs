// The console's live stream ends on the relay when the browser leaves, however it leaves: a page
// closed while the console was passing on what the relay said (a tab closed, a browser context
// closed in a test) used to keep the console reading the relay's stream for nobody, holding one of
// the member's 8 open streams there until the console stopped. Real relay, real console. `npm test`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { consoleSecret } from './console-auth-helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'join-key-console-stream-0123456789';
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'console-stream-')));
const procs = [];
after(() => {
  for (const p of procs) p.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a browser that leaves as its stream connects leaves no stream open on the relay', async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  procs.push(spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', path.join(tmp, 'relay')], { env: { ...process.env, SPHERE_KEY: KEY, SPHERE_STORE: 'fs', SPHERE_SEALED: '0', SPHERE_STREAM_OPENS_PER_MIN: '1000' }, stdio: 'ignore' }));
  for (let i = 0; i < 80 && !(await fetch(base + '/healthz').then((r) => r.ok, () => false)); i++) await sleep(100);
  const env = { ...process.env, OBYSPHERE_HOME: path.join(tmp, 'reps'), OBYSPHERE_NO_UPDATE_CHECK: '1', CLAUDE_CONFIG_DIR: path.join(tmp, 'cfg') };
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const joined = await new Promise((r) => spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'join', `${base}/#key=${KEY}`, '--name', 'alice', '--owner', 'Alice Test', '--cwd', tmp], { env, stdio: 'ignore' }).on('close', r));
  assert.equal(joined, 0);
  const cport = await freePort();
  procs.push(spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'ui', '--profile', 'alice', '--port', String(cport)], { env, stdio: 'ignore' }));
  const dir = path.join(tmp, 'reps', 'alice');
  let secret;
  for (let i = 0; i < 100 && !secret; i++) {
    try {
      secret = consoleSecret(dir, cport);
    } catch {
      await sleep(100);
    }
  }
  assert.ok(secret, 'the console started');
  const request = `GET /api/stream HTTP/1.1\r\nHost: alice.localhost:${cport}\r\nx-obysphere-auth: ${secret}\r\naccept: text/event-stream\r\n\r\n`;
  // twelve browsers that leave a second or two after their stream connects, while the console is
  // passing on what the relay says (each one that opens tells the others alice's presence)
  for (let i = 0; i < 12; i++) {
    const status = await new Promise((resolve, reject) => {
      const s = net.connect(cport, '127.0.0.1', () => s.write(request));
      let got = '';
      s.on('data', (d) => (got += d));
      s.on('error', reject);
      setTimeout(() => {
        s.destroy();
        resolve(got.split('\r\n')[0]);
      }, 800 + 100 * i);
    });
    assert.match(status, / 200 /);
  }
  await sleep(1500);
  // all twelve are gone from the relay (a member may hold 8): eight more connect
  const held = [];
  try {
    for (let i = 0; i < 8; i++) {
      const ac = new AbortController();
      held.push(ac);
      const r = await fetch(`http://127.0.0.1:${cport}/api/stream`, { headers: { 'x-obysphere-auth': secret, accept: 'text/event-stream' }, signal: ac.signal });
      assert.equal(r.status, 200, `stream ${i + 1} of 8 after twelve that left`);
    }
  } finally {
    held.forEach((ac) => ac.abort());
  }
});
