// Sealing end to end, without Claude, on both stores: representatives seal what
// they send, the relay stores and relays envelopes it can't read (checked on
// disk and in Redis), readers open them, others can't, forged or changed
// envelopes are refused, the owner's console shows plaintext, and peers' keys
// are pinned on first sight. `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startFakeUpstash } from './fake-upstash.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const KEY = 'join-key-sealed-0123456789ab';
const ADMIN = 'admin-key-sealed-0123456789ab';
const SECRET = 'PINEAPPLE-77';
const FILE_SECRET = 'TOP SECRET FILE CONTENT 42';
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const kind of ['fs', 'redis']) {
  describe(`sealing on the ${kind} store`, () => {
    let fake, relay, base, dir, home;
    const procs = [];
    // async, never spawnSync: the fake Upstash lives in this process and must keep answering
    const rep = (args) =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), ...args], { env: { ...process.env, OBYSPHERE_HOME: home } });
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (out += d));
        const t = setTimeout(() => p.kill(), 30000);
        p.on('close', () => {
          clearTimeout(t);
          resolve(out);
        });
      });
    const token = (n) => JSON.parse(fs.readFileSync(path.join(home, n, 'profile.json'), 'utf8')).token;
    const call = async (method, url, { tok, key, admin, body, at = base } = {}) => {
      const headers = {};
      if (tok) headers.authorization = `Bearer ${tok}`;
      if (key) headers['x-sphere-key'] = key;
      if (admin) headers['x-admin-key'] = admin;
      if (body) headers['content-type'] = 'application/json';
      const r = await fetch(at + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, ...(await r.json().catch(() => ({}))) };
    };
    // everything the relay keeps, as text: its data folder, or every value in Redis
    const stored = () => {
      if (kind === 'fs') {
        let all = '';
        const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else all += fs.readFileSync(p).toString('latin1'); } };
        walk(dir);
        return all;
      }
      return [...fake.kv.values()].map((e) => (Array.isArray(e.v) ? e.v.join('\n') : e.v instanceof Map ? [...e.v.keys()].join('\n') : Buffer.from(String(e.v), 'base64').toString('latin1') + String(e.v))).join('\n');
    };

    before(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-seal-'));
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-reps-'));
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      const env = { ...process.env, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_SEALED: '1', SPHERE_STORE: kind, SPHERE_POLL_MS: '150' };
      if (kind === 'redis') {
        fake = await startFakeUpstash();
        Object.assign(env, { KV_REST_API_URL: fake.url, KV_REST_API_TOKEN: fake.token }); // the Vercel deploy button's names
      }
      relay = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', dir], { env, stdio: process.env.SPHERE_TEST_DEBUG ? 'inherit' : 'ignore' });
      procs.push(relay);
      for (let i = 0; i < 80; i++) {
        try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
        await sleep(100);
      }
    });
    after(async () => {
      for (const p of procs) p.kill();
      // a relay saves its snapshot as it stops: let it finish before its folder goes
      await Promise.all(procs.map((p) => (p.exitCode !== null || p.signalCode !== null ? null : new Promise((r) => p.once('exit', r)))));
      await fake?.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    });

    test('joining makes keys and publishes them', async () => {
      for (const n of ['alice', 'bob', 'carol']) {
        const out = await rep(['join', `${base}/#key=${KEY}`, '--name', n, '--owner', `${n} Test`, '--cwd', os.tmpdir()]);
        assert.match(out, /joined/, out);
      }
      const { agents } = await call('GET', '/api/agents', { key: KEY });
      assert.equal(agents.length, 3);
      for (const a of agents) assert.ok(a.keys?.seal && a.keys?.sign, `${a.name} has keys`);
      assert.equal(fs.statSync(path.join(home, 'alice', 'keys.json')).mode & 0o777, 0o600);
      const info = await call('GET', '/api/info', { key: KEY });
      assert.equal(info.sphere.policy.sealed, true);
    });

    test('a sealed ask: the relay keeps and shows only the envelope', async () => {
      const f = path.join(home, 'secret.txt');
      fs.writeFileSync(f, FILE_SECRET);
      const out = await rep(['ask', 'bob', `The codeword is ${SECRET}`, '--file', f, '--profile', 'alice', '--wait', '10']);
      assert.match(out, /sealed for it and you/);
      await sleep(200);
      const all = stored();
      assert.ok(!all.includes(SECRET) && !all.includes(FILE_SECRET), 'no plaintext stored');
      const { messages } = await call('GET', '/api/messages', { key: KEY });
      const ask = messages.find((m) => m.kind === 'ask');
      assert.equal(ask.text, '');
      assert.equal(ask.sealed.v, 1);
      assert.deepEqual(Object.keys(ask.sealed.to).length, 2);
      assert.deepEqual(ask.files.map((x) => [x.name, x.mime]), [['sealed', 'application/octet-stream']]);
      const viewerFile = Buffer.from(await (await fetch(`${base}/api/files/${ask.files[0].id}`, { headers: { 'x-sphere-key': KEY } })).arrayBuffer()).toString('latin1');
      assert.ok(!viewerFile.includes(FILE_SECRET), 'a viewer downloads ciphertext');
      const au = await call('GET', '/api/audit?limit=1000', { key: KEY });
      assert.ok(!JSON.stringify(au).includes(SECRET), 'the audit log is content-free');
    });

    test('readers open it; others see who it is sealed for', async () => {
      assert.match(await rep(['read', '--profile', 'bob']), new RegExp(`${SECRET}.*\\[files: secret\\.txt`));
      assert.match(await rep(['read', '--profile', 'carol']), /\[sealed for alice, bob: not for you\]/);
    });

    test('plaintext is refused while sealing is on', async () => {
      const r = await call('POST', '/api/messages', { tok: token('alice'), body: { text: 'in the clear' } });
      assert.equal(r.status, 400);
      assert.equal(r.code, 'must_seal');
      const inline = await call('POST', '/api/messages', { tok: token('alice'), body: { text: '', files: [{ name: 'x.txt', data: Buffer.from('x').toString('base64') }] } });
      assert.equal(inline.code, 'must_seal');
    });

    test('changed, replayed or reader-less envelopes are refused', async () => {
      const { messages } = await call('GET', '/api/messages', { key: KEY });
      const ask = messages.find((m) => m.kind === 'ask');
      const s = ask.sealed;
      const ct = Buffer.from(s.ct, 'base64url');
      ct[0] ^= 1;
      const changed = await call('POST', '/api/messages', { tok: token('alice'), body: { text: '', to: ask.to, sealed: { ...s, ct: ct.toString('base64url') } } });
      assert.equal(changed.code, 'bad_signature');
      const stolen = await call('POST', '/api/messages', { tok: token('bob'), body: { text: '', to: [ask.from], sealed: s } });
      assert.equal(stolen.code, 'bad_signature');
      const { [ask.to[0]]: _, ...rest } = s.to;
      const noReader = await call('POST', '/api/messages', { tok: token('alice'), body: { text: '', to: ask.to, sealed: { ...s, to: rest } } });
      assert.equal(noReader.code, 'bad_envelope');
    });

    test("the owner's console opens what is theirs, and seals what the page sends", async () => {
      const ports = [await freePort(), await freePort()];
      const consoles = ['alice', 'carol'].map((n, i) => {
        const p = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'ui', '--profile', n, '--port', String(ports[i])], { env: { ...process.env, OBYSPHERE_HOME: home }, stdio: 'ignore' });
        procs.push(p);
        return `http://127.0.0.1:${ports[i]}`;
      });
      for (let i = 0; i < 50; i++) {
        try { if ((await fetch(consoles[1] + '/api/channels')).ok && (await fetch(consoles[0] + '/api/channels')).ok) break; } catch {}
        await sleep(100);
      }
      const mine = (await (await fetch(`${consoles[0]}/api/messages`)).json()).messages.find((m) => m.kind === 'ask');
      assert.equal(mine.open, true);
      assert.equal(mine.verified, true);
      assert.match(mine.text, new RegExp(SECRET));
      assert.ok(mine.sealed, 'the envelope stays, for the page to say it was sealed');
      assert.deepEqual(mine.files.map((f) => f.name), ['secret.txt']);
      const theirs = (await (await fetch(`${consoles[1]}/api/messages`)).json()).messages.find((m) => m.kind === 'ask');
      assert.equal(theirs.text, '');
      assert.ok(!theirs.open);
      const file = await fetch(`${consoles[0]}/api/files/${mine.files[0].id}`);
      assert.equal(await file.text(), FILE_SECRET);
      assert.match(file.headers.get('content-disposition'), /secret\.txt/);
      // the page sends plaintext and an inline file; the console seals both
      const sent = await (await fetch(`${consoles[0]}/api/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-obysphere-console': '1' },
        body: JSON.stringify({ channel: 'general', text: 'From the page: meet at 3', to: ['bob'], files: [{ name: 'agenda.md', mime: 'text/markdown', data: Buffer.from('# Agenda').toString('base64') }] }),
      })).json();
      assert.equal(sent.message.open, true);
      assert.equal(sent.message.text, 'From the page: meet at 3');
      await sleep(200);
      assert.ok(!stored().includes('meet at 3') && !stored().includes('# Agenda'));
      assert.match(await rep(['read', '--profile', 'bob']), /From the page: meet at 3/);
      // and live events come through opened
      const ac = new AbortController();
      const events = [];
      fetch(`${consoles[0]}/api/stream`, { signal: ac.signal }).then(async (r) => { for await (const c of r.body) events.push(Buffer.from(c).toString()); }).catch(() => {});
      await sleep(400);
      await rep(['post', 'live and sealed', '--profile', 'bob']);
      for (let i = 0; i < 30 && !events.join('').includes('live and sealed'); i++) await sleep(100);
      ac.abort();
      assert.match(events.join(''), /"text":"live and sealed".*"open":true/);
    });

    test("a peer's changed keys are not trusted", async () => {
      await rep(['post', 'carol, before', '--profile', 'carol']);
      assert.match(await rep(['read', '--profile', 'alice']), /carol, before/); // alice pins carol's keys
      // carol's keys change on the Sphere (as a relay or an impostor could make them)
      const k = (t) => crypto.generateKeyPairSync(t).publicKey.export({ format: 'jwk' }).x;
      assert.equal((await call('POST', '/api/me', { tok: token('carol'), body: { keys: { seal: k('x25519'), sign: k('ed25519') } } })).status, 200);
      const out = await rep(['ask', 'carol', 'still you?', '--profile', 'alice', '--wait', '10']);
      assert.match(out, /keys changed since you first saw them/);
      const au = await call('GET', '/api/audit?limit=1000', { key: KEY });
      assert.ok(au.events.some((e) => e.type === 'keys' && /new keys/.test(e.detail)));
    });

    test('the audit chain still verifies', async () => {
      const au = await call('GET', '/api/audit?limit=1', { key: KEY });
      assert.equal(au.verified, true);
    });
  });
}
