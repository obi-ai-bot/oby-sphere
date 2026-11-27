// What the relay-hardening tests share: a relay process on either store, calls to it, a live
// stream's events, and sealed envelopes signed as a representative signs them (the relay can't
// open them, so random bytes stand in for the content).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER = path.join(HERE, '..', 'server.mjs');
export const KEY = 'join-key-hardening-0123456789abcdef';
export const ADMIN = 'admin-key-hardening-0123456789abcdef';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a free port, never the ones a person's own Spheres use (4848 to 4851)
export const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p >= 4848 && p <= 4851 ? freePort() : p));
    });
  });

export async function until(fn, ms = 8000) {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t > ms) return v;
    await sleep(100);
  }
}

export function tempDir(name) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sphere-${name}-`)));
  return { dir, remove: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

// a relay process: { base, port, pid, errs, stop }. `env` is passed whole to the child, never
// through a shell.
export async function relay(env, { tmp, procs, wait = true } = {}) {
  const port = await freePort();
  const p = spawn(process.execPath, [SERVER, '--port', String(port), '--host', '127.0.0.1'], {
    env: { ...process.env, HOME: path.join(tmp, 'home'), TMPDIR: tmp, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_SEALED: '0', SPHERE_POLL_MS: '150', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs?.add(p);
  let errs = '';
  p.stderr.on('data', (d) => (errs += d));
  p.stdout.on('data', (d) => (errs += d));
  const exited = new Promise((r) => p.on('exit', (code) => r(code)));
  const base = `http://127.0.0.1:${port}`;
  const handle = {
    base,
    port,
    pid: p.pid,
    exited,
    errs: () => errs,
    stop: async () => {
      if (p.exitCode === null) p.kill();
      await exited;
      procs?.delete(p);
    },
  };
  if (!wait) return handle;
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(base + '/healthz')).ok) return handle;
    } catch {}
    if (p.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error(`the relay did not start: ${errs}`);
}

export const call = async (base, method, url, { token, key, admin, body, headers: more } = {}) => {
  const headers = { ...(more || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['x-sphere-key'] = key;
  if (admin) headers['x-admin-key'] = admin;
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};

export const audit = async (base) => (await call(base, 'GET', '/api/audit?limit=1000', { admin: ADMIN })).events;

// the live events one stream gets, as [event, data]; `ready` once the relay holds the stream
export function listen(base, headers, query = '') {
  const got = [];
  const ac = new AbortController();
  const open = fetch(base + '/api/stream' + query, { headers, signal: ac.signal });
  open
    .then(async (r) => {
      const dec = new TextDecoder();
      let buf = '';
      for await (const c of r.body) {
        buf += dec.decode(c, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (\S+)/m.exec(block)?.[1];
          const data = block.split('\n').find((l) => l.startsWith('data: '));
          if (ev && data) got.push([ev, JSON.parse(data.slice(6))]);
        }
      }
    })
    .catch(() => {});
  return { got, ready: open.then((r) => assert.equal(r.status, 200)), close: () => ac.abort() };
}

// ---- sealing, as rep.mjs does it (API.md, "Sealing")

const b64 = (b) => Buffer.from(b).toString('base64url');

// an X25519 and an Ed25519 key pair; `pub` is what POST /api/join {keys} takes
export function sealKeys() {
  const seal = crypto.generateKeyPairSync('x25519');
  const sign = crypto.generateKeyPairSync('ed25519');
  return { sign, pub: { seal: seal.publicKey.export({ format: 'jwk' }).x, sign: sign.publicKey.export({ format: 'jwk' }).x } };
}

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}

// a sealed envelope from `from` (its keys `k`), `ctBytes` of ciphertext, for `readers` (agent ids)
export function envelope(k, { from, channel = 'general', to = [], replyTo = null, cause = null, depth = 0, readers, ctBytes = 64 }) {
  const s = { v: 1, epk: b64(crypto.randomBytes(32)), iv: b64(crypto.randomBytes(12)), ct: b64(crypto.randomBytes(ctBytes)), tag: b64(crypto.randomBytes(16)), to: {} };
  for (const id of readers) s.to[id] = { iv: b64(crypto.randomBytes(12)), ct: b64(crypto.randomBytes(32)), tag: b64(crypto.randomBytes(16)) };
  const digest = crypto
    .createHash('sha256')
    .update(canonical({ v: 1, from, channel, to: [...to].sort(), replyTo, cause, depth, epk: s.epk, iv: s.iv, ct: s.ct, tag: s.tag, readers: [...readers].sort() }))
    .digest();
  s.sig = b64(crypto.sign(null, digest, k.sign.privateKey));
  return s;
}

// joins `names` (Alice Test, Bob Test, …) with sealing keys: { name: { token, agent, keys } }
export async function members(base, names) {
  const out = {};
  for (const n of names) {
    const keys = sealKeys();
    const j = await call(base, 'POST', '/api/join', { key: KEY, body: { name: n, owner: `${n[0].toUpperCase()}${n.slice(1)} Test`, keys: keys.pub } });
    assert.ok(j.token, JSON.stringify(j));
    out[n] = { ...j, keys, id: j.agent.id };
  }
  return out;
}
