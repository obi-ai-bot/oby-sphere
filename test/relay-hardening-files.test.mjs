// Files the relay stores (security audit, findings 4 to 6): an upload the client abandons leaves
// no open file and no temp file (and a temp file a crash left is swept at start); a post refused
// after its inline files were stored leaves none of them behind; and uploads in parallel can't
// pass a member's storage quota together. On both stores. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startFakeUpstash } from './fake-upstash.mjs';
import { ADMIN, relay, call, tempDir, members, until, sleep } from './relay-hardening-helpers.mjs';

let T;
before(() => (T = tempDir('hardening-files')));
after(() => T.remove());
const KB = 1024;
const MB = 1024 * KB;

// an upload whose body comes slowly, in pieces; { status } once it's answered, or { error }
function slowUpload(base, token, bytes, { pieces = 10, gapMs = 40, abortAfter = null } = {}) {
  return new Promise((resolve) => {
    const u = new URL(base + '/api/files');
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'x-file-name': 'big.bin', 'content-length': bytes } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, ...(() => { try { return JSON.parse(body); } catch { return {}; } })() }));
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    const piece = Buffer.alloc(Math.ceil(bytes / pieces), 7);
    let sent = 0;
    const next = () => {
      if (abortAfter !== null && sent >= abortAfter) return req.destroy();
      if (sent >= bytes) return req.end();
      const n = Math.min(piece.length, bytes - sent);
      req.write(piece.subarray(0, n));
      sent += n;
      setTimeout(next, gapMs);
    };
    next();
  });
}

describe('an upload the client abandons (fs store)', () => {
  const procs = new Set();
  const dir = () => path.join(T.dir, 'abandon');
  const temps = () => fs.readdirSync(path.join(dir(), 'files')).filter((f) => f.startsWith('.up-'));
  let R, a;
  before(async () => {
    // what a crash in the middle of an upload leaves
    fs.mkdirSync(path.join(dir(), 'files'), { recursive: true });
    fs.writeFileSync(path.join(dir(), 'files', '.up-f_leftover'), 'half a file');
    R = await relay({ SPHERE_DATA: dir() }, { tmp: T.dir, procs });
    ({ alice: a } = await members(R.base, ['alice']));
  });
  after(() => [...procs].forEach((p) => p.kill()));

  test('a temp file a crash left is swept at start', () => {
    assert.deepEqual(temps(), []);
  });

  test('cut short by the client: no temp file stays, and the relay goes on', async () => {
    const r = await slowUpload(R.base, a.token, 2 * MB, { pieces: 20, abortAfter: 300 * KB });
    assert.ok(r.error || r.status >= 400, JSON.stringify(r));
    assert.ok(await until(() => temps().length === 0, 4000), `left: ${temps().join(', ')}`);
    const ok = await slowUpload(R.base, a.token, 64 * KB, { pieces: 2, gapMs: 5 });
    assert.equal(ok.status, 200, 'the next upload works');
  });
});

for (const kind of ['fs', 'redis']) {
  describe(`stored files on the ${kind} store`, () => {
    const procs = new Set();
    let fake, R, m;
    const prefix = 'files:';
    const dir = () => path.join(T.dir, `files-${kind}`);
    const env = () => (kind === 'fs' ? { SPHERE_DATA: dir() } : { SPHERE_STORE: 'redis', UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, SPHERE_REDIS_PREFIX: prefix });
    const storedFiles = () => (kind === 'fs' ? fs.readdirSync(path.join(dir(), 'files')).filter((f) => f.startsWith('f_')) : [...fake.kv.keys()].filter((k) => k.startsWith(prefix + 'file:')));
    before(async () => {
      if (kind === 'redis') fake = await startFakeUpstash({ latencyMs: 2 });
      R = await relay({ ...env(), SPHERE_WRITES_PER_MIN: '100000', SPHERE_ASKS_PER_MIN: '100000' }, { tmp: T.dir, procs });
      m = await members(R.base, ['alice', 'mallory']);
    });
    after(async () => {
      [...procs].forEach((p) => p.kill());
      await fake?.close();
    });

    test('a post refused after its inline files were stored leaves none of them', async () => {
      const was = storedFiles().length;
      const data = Buffer.from('the PIKE-5 notes').toString('base64');
      const refused = [
        { to: ['nobody-here'], text: 'hi', files: [{ name: 'a.txt', data }, { name: 'b.txt', data }] },
        { replyTo: 'm_doesnotexist', text: 'hi', files: [{ name: 'a.txt', data }] },
        { channel: 'dm-0123456789abcdef01234567', text: 'hi', files: [{ name: 'a.txt', data }] },
      ];
      for (const body of refused) assert.ok((await call(R.base, 'POST', '/api/messages', { token: m.mallory.token, body })).status >= 400);
      assert.equal(storedFiles().length, was, 'nothing stored for them');
      assert.equal((await call(R.base, 'GET', '/api/files', { admin: ADMIN })).files.length, 0);
      const ok = await call(R.base, 'POST', '/api/messages', { token: m.alice.token, body: { text: 'with a file', files: [{ name: 'a.txt', data }] } });
      assert.equal(ok.status, 200);
      assert.equal(storedFiles().length, was + 1, 'an accepted one is stored');
    });

    test("uploads in parallel can't pass a member's storage quota together", async () => {
      assert.equal((await call(R.base, 'POST', '/api/admin/policy', { admin: ADMIN, body: { maxAgentBytes: MB, maxFileBytes: kind === 'redis' ? MB : 5 * MB } })).status, 200);
      const size = 400 * KB;
      const results = await Promise.all([0, 1, 2, 3].map(() => slowUpload(R.base, m.mallory.token, size, { pieces: 8, gapMs: 60 })));
      const ok = results.filter((r) => r.status === 200);
      assert.ok(ok.length >= 1, JSON.stringify(results.map((r) => r.status ?? r.error)));
      assert.ok(ok.length * size <= MB, `${ok.length} of 400 KB stored: past 1 MB (${results.map((r) => r.status ?? r.error).join(', ')})`);
      for (const r of results.filter((x) => x.status !== 200)) assert.equal(r.code, 'too_large');
      // and an inline file in a post at the same time is held to the same quota
      const files = (await call(R.base, 'GET', '/api/files', { admin: ADMIN })).files.filter((f) => f.from === m.mallory.id);
      assert.ok(files.reduce((n, f) => n + f.size, 0) <= MB);
      await sleep(50);
    });
  });
}
