// A sealed Sphere for hostile-relay tests: a real server.mjs behind test/hostile-relay.mjs, real
// rep.mjs members (Alice Test, Bob Test, Carol Test, Mallory) joined through it, fake runtimes
// first on PATH (no model, no network). Everything lives in a temp folder; ports are free ones on
// 127.0.0.1 (never the demo's 4848-4851).
//
//   const s = await sealedSphere('name', { members: ['alice', 'bob'] });
//   s.h.json / s.h.request / s.h.event / s.h.inject   the hostile relay (test/hostile-relay.mjs)
//   await s.rep([...args])            one rep.mjs run: { out, code }
//   const bob = await s.serve('bob')  its representative: { proc, out }
//   await s.mcpTool('alice', 'sphere_read', {})   one tool call through `rep.mjs mcp`
//   await s.close()
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeFakeRuntimes } from './fake-runtimes.mjs';
import { startHostileRelay } from './hostile-relay.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, '..');
export const KEY = 'join-key-sealing-hostile-0123456789';
const ADMIN = 'admin-key-sealing-hostile-012345678';
const RESERVED = new Set([4848, 4849, 4850, 4851]); // the demo's ports
export const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  }).then((p) => (RESERVED.has(p) ? freePort() : p));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const waitFor = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
export const stop = (p) =>
  new Promise((resolve) => {
    if (!p || p.exitCode !== null || p.signalCode !== null) return resolve();
    const t = setTimeout(resolve, 3000);
    p.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    p.kill('SIGTERM');
  });

// ---- envelopes as API.md describes them, made here (a relay can make all but the signature)
export const b64 = (b) => Buffer.from(b).toString('base64url');
export const unb64 = (s) => Buffer.from(String(s), 'base64url');
const gcm = (key, data) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(data), c.final()]);
  return { iv, ct, tag: c.getAuthTag() };
};
export const canonical = (v) => {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
};
// an envelope as a relay from before v2 takes it
export const asV1 = (s) => ({ v: 1, epk: s.epk, iv: s.iv, ct: s.ct, tag: s.tag, to: s.to, sig: s.sig });
// readers: { agentId: its seal key (x) }; inner: { text, files, meta? }; sign: { d, x } (the sender's
// Ed25519 key) or nothing (a signature that can't verify); v: 1 or 2
export function envelope({ readers, inner, sign = null, m, v = 1, sent = new Date().toISOString(), nonce = b64(crypto.randomBytes(16)) }) {
  const cek = crypto.randomBytes(32);
  const body = gcm(cek, Buffer.from(JSON.stringify(inner), 'utf8'));
  const eph = crypto.generateKeyPairSync('x25519');
  const epkRaw = unb64(eph.publicKey.export({ format: 'jwk' }).x);
  const to = {};
  for (const [id, x] of Object.entries(readers)) {
    const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' }) });
    const kek = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([epkRaw, unb64(x)]), 'obysphere/seal/v1', 32));
    const w = gcm(kek, cek);
    to[id] = { iv: b64(w.iv), ct: b64(w.ct), tag: b64(w.tag) };
  }
  const s = { v, epk: b64(epkRaw), iv: b64(body.iv), ct: b64(body.ct), tag: b64(body.tag), to, sig: b64(crypto.randomBytes(64)) };
  const fields = { from: m.from, channel: m.channel, to: [...m.to].sort(), replyTo: m.replyTo ?? null, cause: m.cause ?? null, depth: m.depth ?? 0, epk: s.epk, iv: s.iv, ct: s.ct, tag: s.tag, readers: Object.keys(to).sort() };
  const key = sign && crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: sign.d, x: sign.x }, format: 'jwk' });
  if (key) s.sig = b64(crypto.sign(null, crypto.createHash('sha256').update(canonical({ v: 1, ...fields })).digest(), key));
  if (v === 2) {
    Object.assign(s, { nonce, sent, commit: b64(crypto.createHash('sha256').update('obysphere/commit/v2\0').update(cek).digest()), sig2: b64(crypto.randomBytes(64)) });
    if (key) s.sig2 = b64(crypto.sign(null, crypto.createHash('sha256').update(canonical({ v: 2, ...fields, nonce: s.nonce, sent: s.sent, commit: s.commit })).digest(), key));
  }
  return s;
}

export async function sealedSphere(name, { members = ['alice', 'bob', 'carol', 'mallory'] } = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sphere-${name}-`)));
  const home = path.join(tmp, 'reps');
  const homeDir = path.join(tmp, 'home');
  const work = path.join(tmp, 'work');
  const cfg = path.join(tmp, 'claude-config');
  const notifyLog = path.join(tmp, 'notify.jsonl');
  for (const d of [home, homeDir, work, cfg]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ mcpServers: {}, projects: {} }));
  const fake = makeFakeRuntimes(path.join(tmp, 'bin'));
  fake.control({});
  const procs = [];
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const relay = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port), '--host', '127.0.0.1', '--data', path.join(tmp, 'relay')], {
    env: { ...process.env, HOME: homeDir, SPHERE_KEY: KEY, SPHERE_ADMIN_KEY: ADMIN, SPHERE_STORE: 'fs', SPHERE_SEALED: '1', SPHERE_ASKS_PER_MIN: '1000', SPHERE_WRITES_PER_MIN: '1000' },
    stdio: process.env.SPHERE_TEST_DEBUG ? 'inherit' : 'ignore',
  });
  procs.push(relay);
  await waitFor(async () => {
    try {
      return (await fetch(base + '/healthz')).ok;
    } catch {
      return false;
    }
  }, 8000, 'the relay');
  const h = await startHostileRelay(base);
  const env = (extra = {}) => ({
    ...process.env,
    HOME: homeDir,
    OBYSPHERE_HOME: home,
    OBYSPHERE_APP_HOME: path.join(tmp, 'app-home'),
    OBYSPHERE_DOWNLOADS: path.join(tmp, 'downloads'),
    OBYSPHERE_NOTIFY_LOG: notifyLog,
    OBYSPHERE_NOTIFY_COALESCE_MS: '100',
    OBYSPHERE_NO_UPDATE_CHECK: '1',
    OBYSPHERE_APPROVE_WAIT_SEC: '600',
    OBYSPHERE_PROBE_CACHE_MS: '0',
    OBYSPHERE_RETRY_MS: '100',
    OBYSPHERE_CHROME: '0',
    CLAUDE_CONFIG_DIR: cfg,
    PATH: `${path.dirname(fake.claude)}${path.delimiter}${process.env.PATH}`,
    ...extra,
  });
  const rep = (args, extra = {}) =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), ...args], { env: env(extra) });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.stderr.on('data', (d) => (out += d));
      const t = setTimeout(() => c.kill(), 90000);
      c.on('close', (code) => {
        clearTimeout(t);
        resolve({ out, code });
      });
    });
  const profile = (n) => JSON.parse(fs.readFileSync(path.join(home, n, 'profile.json'), 'utf8'));
  const keysOf = (n) => JSON.parse(fs.readFileSync(path.join(home, n, 'keys.json'), 'utf8'));
  const peersOf = (n) => JSON.parse(fs.readFileSync(path.join(home, n, 'peers.json'), 'utf8'));
  const tokenOf = (req) => String(req.headers.authorization || '').replace(/^Bearer /, '');
  const isFrom = (req, n) => tokenOf(req) === profile(n).token;
  const call = async (method, url, { tok, body } = {}) => {
    const hd = {};
    if (tok) hd.authorization = `Bearer ${tok}`;
    if (body !== undefined) hd['content-type'] = 'application/json';
    const r = await fetch(base + url, { method, headers: hd, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  for (const n of members) {
    const { out } = await rep(['join', `${h.url}/#key=${KEY}`, '--name', n, '--owner', n === 'mallory' ? 'Mallory' : `${n[0].toUpperCase() + n.slice(1)} Test`, '--cwd', work]);
    if (!/joined/.test(out)) throw new Error(out);
  }
  const ids = Object.fromEntries(members.map((n) => [n, profile(n).agent.id]));
  const settingsFor = (n, agents, { access = {}, machine = {}, ...more } = {}) =>
    fs.writeFileSync(
      path.join(home, n, 'settings.json'),
      JSON.stringify({
        version: 2,
        routing: { default: { runtime: 'claude', model: null, effort: null, timeLimitMin: 10 }, rules: [] },
        access: { default: 'approve', agents, ...access },
        machine: { folders: [{ path: work, write: false }], shell: 'full', web: { fetch: false, search: false }, browser: 'off', mcp: [], ...machine },
        ...more,
      }),
      { mode: 0o600 },
    );
  const withFakeBins = (n) => fs.writeFileSync(path.join(home, n, 'profile.json'), JSON.stringify({ ...profile(n), claudeBin: fake.claude, codexBin: fake.codex, cursorBin: fake.cursor }), { mode: 0o600 });
  const serve = async (n) => {
    const s = { out: '' };
    s.proc = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'serve', '--profile', n], { env: env() });
    procs.push(s.proc);
    s.proc.stdout.on('data', (d) => (s.out += d));
    s.proc.stderr.on('data', (d) => (s.out += d));
    await waitFor(() => /is online/.test(s.out), 20000, `${n} online\n${s.out}`);
    await sleep(800); // its catch-up
    return s;
  };
  const mcpTool = (n, tool, args, extra = {}) =>
    new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [path.join(ROOT, 'rep.mjs'), 'mcp', '--profile', n], { env: env(extra) });
      procs.push(c);
      let buf = '';
      const t = setTimeout(() => (c.kill(), reject(new Error('no answer from rep.mjs mcp'))), 60000);
      c.stdout.on('data', (d) => {
        buf += d;
        for (const line of buf.split('\n').slice(0, -1)) {
          let m;
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          if (m.id === 2) {
            clearTimeout(t);
            stop(c);
            resolve(m.result);
          }
        }
        buf = buf.slice(buf.lastIndexOf('\n') + 1);
      });
      c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
      c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }) + '\n');
    });
  const runsWith = (words) => fake.calls().filter((c) => c.bin === 'claude' && String(c.prompt || '').includes(words));
  // the relay's own messages: served for their ids, claimable, with no replies; replies to them kept
  const forged = new Map();
  const forgedReplies = [];
  const serveForged = async (req, url, body) => {
    const mm = /^\/api\/messages\/(m_[\w-]+)(\/replies|\/claim|\/waiting)?$/.exec(url.pathname);
    if (mm && forged.has(mm[1])) {
      if (!mm[2]) return { json: { message: forged.get(mm[1]), replies: [] } };
      if (mm[2] === '/replies') return { json: { replies: [] } };
      return { json: { ok: true } };
    }
    if (req.method === 'POST' && url.pathname === '/api/messages') {
      const b = JSON.parse(body.toString('utf8') || '{}');
      if (b.replyTo && forged.has(b.replyTo)) {
        forgedReplies.push(b);
        const from = Object.entries(ids).find(([n]) => isFrom(req, n))?.[1] ?? null;
        return { json: { message: { id: 'm_fr' + crypto.randomBytes(5).toString('hex'), ts: new Date().toISOString(), channel: b.channel, from, kind: 'reply', to: [], text: b.text || '', replyTo: b.replyTo, cause: null, files: [], depth: 0, meta: b.meta || {}, ...(b.sealed ? { sealed: b.sealed } : {}) } } };
      }
    }
    return undefined;
  };
  const forge = (m) => (forged.set(m.id, m), m);
  const reset = () => {
    h.json = null;
    h.event = null;
    h.request = serveForged;
  };
  reset();
  const close = async () => {
    for (const p of procs) await stop(p);
    await h.close();
    if (!process.env.SPHERE_TEST_KEEP) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  return { tmp, home, homeDir, work, cfg, notifyLog, fake, base, h, env, rep, profile, keysOf, peersOf, isFrom, call, ids, settingsFor, withFakeBins, serve, mcpTool, runsWith, forge, forged, forgedReplies, serveForged, reset, close, procs };
}
