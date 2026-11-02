// The receiver track's side of a Sphere: starting a local one, and the calls its owners and peers
// make (sphere-api.md), signed with the spec's reference code (../lib/obi.mjs). Keys are made in
// memory for each run and never written anywhere.

import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import * as spec from "../lib/obi.mjs";

export { spec };

export const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const JWT_TYPE = "urn:ietf:params:oauth:token-type:jwt";
export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const timestamp = (s = nowSeconds()) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A free TCP port on the loopback. */
export function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

/** Whether `url` is on this machine: the track never talks to a Sphere anywhere else. */
export function isLoopback(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return (protocol === "http:" || protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

/**
 * Starts the reference Sphere in `serverDir` (`node scripts/local.mjs`, sphere-api.md section 8) on
 * `port`, its state under `root`, and waits for its health. Answers {base, operatorToken, stop}.
 */
export async function startSphere({ serverDir, root, port }) {
  if (!existsSync(join(serverDir, "scripts", "local.mjs"))) throw new Error(`no Sphere server in ${serverDir} (scripts/local.mjs): pass --server <dir> or --sphere-url`);
  if (!existsSync(join(serverDir, "node_modules"))) throw new Error(`the server's packages aren't installed: run \`pnpm install --frozen-lockfile\` in ${serverDir}`);
  const operatorToken = randomBytes(32).toString("base64url");
  const dirs = { state: join(root, "state"), home: join(root, "home"), tmp: join(root, "tmp") };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const log = createWriteStream(join(root, "sphere.log"), { flags: "a" });
  // Only what the Sphere needs from this environment: never the caller's tokens.
  const env = { SPHERE_OPERATOR_TOKEN: operatorToken, HOME: dirs.home, TMPDIR: dirs.tmp, WRANGLER_SEND_METRICS: "false", PATH: process.env.PATH };
  const child = spawn(process.execPath, ["scripts/local.mjs", "--port", String(port), "--persist-to", dirs.state], { cwd: serverDir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const exited = new Promise((res) => child.on("exit", (code, signal) => res({ code, signal })));
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    if (!(await Promise.race([exited, sleep(10_000).then(() => null)]))) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  };
  const deadline = Date.now() + 90_000;
  for (;;) {
    const ok = await fetch(`${base}/v0.1/health`).then((r) => r.ok, () => false);
    if (ok) break;
    if (child.exitCode !== null || Date.now() > deadline) {
      await stop();
      throw new Error(`the Sphere didn't come up (see ${join(root, "sphere.log")})`);
    }
    await sleep(250);
  }
  return { base, operatorToken, stop, log: join(root, "sphere.log") };
}

export class SphereClient {
  constructor(base, sphere) {
    this.base = base;
    this.sphere = sphere;
  }

  /** One HTTP call; answers {status, body}. `form` sends a form body, `body` a JSON one. */
  async call(method, path, { token, body, form } = {}) {
    const headers = {};
    let payload;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      payload = new URLSearchParams(form).toString();
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.base + path, { method, headers, body: payload, signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: res.status, body: parsed };
  }

  path(rest = "") {
    return `/v0.1/spheres/${this.sphere}${rest}`;
  }

  async must(method, path, options, status) {
    const r = await this.call(method, path, options);
    if (r.status !== status) throw new Error(`${method} ${path}: expected ${status}, got ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body;
  }
}

/** A fresh Ed25519 key, in memory only. */
export function newKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "jwk" }).x;
  return { privateKey, publicKey: pub, keyId: spec.keyIdOf(pub) };
}

/** A fresh X25519 seal key: {raw (32 private bytes), publicRaw, keyId}. */
export function newSealKey() {
  const raw = randomBytes(32);
  const { publicRaw } = spec.x25519FromPrivate(raw);
  return { raw, publicRaw, keyId: spec.sealKeyIdOf(publicRaw) };
}

/** An owner: a key the Sphere binds, the cards and delegations it signs. */
export class Owner {
  constructor(client, id) {
    this.client = client;
    this.id = id;
    this.key = newKey();
  }

  assertion(scope, { lifetime = 300, mayAct } = {}) {
    const iat = nowSeconds();
    const claims = { iss: this.id, sub: this.id, aud: `obi-sphere:${this.client.sphere}`, iat, exp: iat + lifetime, jti: randomUUID(), scope };
    if (mayAct) claims.may_act = { sub: mayAct };
    return spec.signJwt(claims, this.key.privateKey, this.key.keyId);
  }

  async token(scope = "admin directory:read audit:read") {
    const r = await this.client.call("POST", "/v0.1/oauth/token", { form: { grant_type: TOKEN_EXCHANGE, subject_token: this.assertion(scope), subject_token_type: JWT_TYPE } });
    if (r.status !== 200) throw new Error(`owner token for ${this.id}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.access_token;
  }

  /** The card of `member` (identity.md 2.1), signed by this owner. */
  card(member, { name, accepts }) {
    const params = {
      protocol: "obi/0.1", sphere: this.client.sphere, obi_id: member.id, owner: this.id, owner_key: this.key.publicKey, key_id: member.key.keyId,
      public_key: member.key.publicKey,
      ...(member.seal ? { seal_key_id: member.seal.keyId, seal_public_key: spec.b64url(member.seal.publicRaw) } : {}),
      accepts, card_seq: 1, issued_at: timestamp(),
    };
    const card = {
      protocolVersion: "0.3.0",
      name,
      description: "A scripted peer of the conformance suite's receiver track.",
      url: `${this.client.base}/v0.1/spheres/${this.client.sphere}/members/${member.id}`,
      preferredTransport: "HTTP+JSON",
      version: "0.2.0",
      capabilities: { streaming: false, pushNotifications: false, extensions: [{ uri: spec.CARD_EXTENSION_URI, required: true, params }] },
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      skills: accepts.map((id) => ({ id, name: id, description: "Takes this request type.", tags: ["obi-action"] })),
    };
    return spec.signCard(card, this.key.privateKey, this.key.keyId);
  }
}

/** Every member's keys, as the spec's verifiers take them. */
export function directoryKeys(members) {
  const keys = {};
  for (const m of members) for (const k of m.keys) keys[k.key_id] = { obi: m.obi, public_key: k.public_key, valid_from_seq: k.valid_from_seq, valid_until_seq: k.valid_until_seq };
  return keys;
}

/** The seal key a member's card publishes, as 32 raw bytes, or null. */
export function cardSealKey(card) {
  const p = card?.capabilities?.extensions?.[0]?.params;
  return p?.seal_public_key ? spec.fromB64url(p.seal_public_key) : null;
}
