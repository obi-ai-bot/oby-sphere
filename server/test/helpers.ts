// What the tests call the Worker with, and how they play owners and Obis: keys made with
// WebCrypto, envelopes, cards and assertions signed exactly as the spec says, and a clock the
// test moves.

import { env } from "cloudflare:test";
import { expect } from "vitest";
import { handle } from "../src/app";
import { b64url, keyIdOf, sealKeyIdOrNull } from "../src/protocol/crypto";
import { canonicalBytes, utf8 } from "../src/protocol/json";
import { envelopeSigningInput, timestamp } from "../src/protocol/envelope";
import { cardSigningInput } from "../src/protocol/card";
import * as validators from "../src/protocol/validators.generated.js";
import { Issuers } from "../src/signin";

export const BASE = "http://sphere.test";
export const OPERATOR = env.SPHERE_OPERATOR_TOKEN;

/** Google, as the tests play it: one RSA key, made for this run, that signs every ID token (test/signin.test.ts). */
export const GOOGLE_KEY = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const googleJwk = { ...((await crypto.subtle.exportKey("jwk", GOOGLE_KEY.publicKey)) as JsonWebKey), kid: "test-google-key" };

/** Another OpenID Connect provider, as the tests play it: its issuer, its discovery document, and an ES256 key made for this run. */
export const IDP = { issuer: "https://idp.test", authorize: "https://idp.test/authorize", jwks: "https://idp.test/keys", kid: "test-idp-key" };
export const IDP_KEY = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const idpJwk = { ...((await crypto.subtle.exportKey("jwk", IDP_KEY.publicKey)) as JsonWebKey), kid: IDP.kid, use: "sig", alg: "ES256" };
/** The test provider's Ed25519 key, for EdDSA ID tokens. */
export const IDP_ED_KEY = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const idpEdJwk = { ...((await crypto.subtle.exportKey("jwk", IDP_ED_KEY.publicKey)) as JsonWebKey), kid: "test-idp-ed-key" };

/** What the Sphere fetches from issuers, answered here: Google's keys, and the test provider's discovery and keys. */
export const ISSUERS_GET = async (url: string): Promise<Response> => {
  if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [googleJwk] });
  if (url === `${IDP.issuer}/.well-known/openid-configuration`) {
    return Response.json({ issuer: IDP.issuer, authorization_endpoint: IDP.authorize, jwks_uri: IDP.jwks, response_types_supported: ["code", "id_token"], response_modes_supported: ["query", "fragment", "form_post"], id_token_signing_alg_values_supported: ["ES256"] });
  }
  if (url === IDP.jwks) return Response.json({ keys: [idpJwk, idpEdJwk, { kty: "oct", kid: "a-shared-secret", k: "c2VjcmV0" }] });
  // An issuer whose document names another issuer, and one whose endpoints aren't https.
  if (url === "https://other-idp.test/.well-known/openid-configuration") return Response.json({ issuer: IDP.issuer, authorization_endpoint: IDP.authorize, jwks_uri: IDP.jwks });
  if (url === "https://plain-idp.test/.well-known/openid-configuration") return Response.json({ issuer: "https://plain-idp.test", authorization_endpoint: "http://127.0.0.1:9/authorize", jwks_uri: "http://127.0.0.1:9/keys" });
  return new Response("not found", { status: 404 });
};
export const ISSUERS = new Issuers(ISSUERS_GET);

/** The Sphere's clock in the tests: starts at 2026-10-14T12:00:00Z, moves only when told. */
export class Clock {
  ms = Date.parse("2026-10-14T12:00:00Z");
  now = () => this.ms;
  get s() {
    return Math.floor(this.ms / 1000);
  }
  advance(seconds: number) {
    this.ms += seconds * 1000;
  }
  ts(offset = 0) {
    return timestamp(this.s + offset);
  }
}

export interface Key {
  publicKey: string;
  keyId: string;
  sign(bytes: Uint8Array): Promise<string>;
}

export async function newKey(): Promise<Key> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const publicKey = b64url(raw);
  return {
    publicKey,
    keyId: await keyIdOf(publicKey),
    sign: async (bytes) => b64url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, bytes))),
  };
}

export async function signEnvelope(unsigned: Record<string, unknown>, key: Key): Promise<Record<string, unknown>> {
  const { signature: _s, ...rest } = unsigned;
  return { ...rest, signature: await key.sign(envelopeSigningInput(rest)) };
}

export async function signJwt(claims: Record<string, unknown>, key: Key): Promise<string> {
  const head = b64url(canonicalBytes({ alg: "EdDSA", kid: key.keyId, typ: "JWT" }));
  const body = b64url(canonicalBytes(claims));
  return `${head}.${body}.${await key.sign(utf8(`${head}.${body}`))}`;
}

export interface CardOptions {
  sphere: string;
  obi: string;
  owner: string;
  ownerKey: Key;
  obiKey: Key;
  accepts?: string[];
  cardSeq?: number;
  issuedAt: string;
  /** The Obi's seal key (protocol.md section 9.1): its id and public key. */
  seal?: SealKey;
  /** More params, such as `features`, `runtime` and `vendors` (identity.md section 2.3). */
  params?: Record<string, unknown>;
  /** The card's `version`, when not 0.1.0. */
  version?: string;
}

export interface SealKey {
  keyId: string;
  publicKey: string;
}

/** A seal key as a card publishes it. The Sphere only hashes and compares it, so any 32 bytes do. */
export async function newSealKey(): Promise<SealKey> {
  const publicKey = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { keyId: (await sealKeyIdOrNull(publicKey))!, publicKey };
}

/** What the Sphere sees of `bytes` bytes of words, sealed: base64url of their ciphertext and tag. */
export const sealedText = (bytes: number): string => b64url(crypto.getRandomValues(new Uint8Array(bytes + 16)));

const SKILLS: Record<string, { name: string; description: string }> = {
  review_request: { name: "Review a change", description: "Reviews a change for its owner and answers with typed findings." },
  question: { name: "Answer a question", description: "Answers what its owner knows or decided." },
  handoff: { name: "Take a handoff", description: "Runs a piece of work for its owner." },
  run_request: { name: "Run a job on this Mac", description: "Runs a teammate's job in a VM of its own, with the teammate's own account." },
  share_offer: { name: "Take a share of an API account", description: "Shows a teammate's share of a company API account; jobs on it run on their Mac." },
  introduction: { name: "Meet someone", description: "Hears who another member would introduce its owner to." },
};

export async function makeCard(o: CardOptions): Promise<Record<string, unknown>> {
  const accepts = o.accepts ?? ["review_request"];
  const card = {
    protocolVersion: "0.3.0",
    name: `${o.owner}'s Obi`,
    description: "A personal delegate for an engineer.",
    url: `${BASE}/v0.1/spheres/${o.sphere}/members/${o.obi}`,
    preferredTransport: "HTTP+JSON",
    version: o.version ?? "0.1.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [
        {
          uri: "urn:obi-sphere:ext:obi:0.1",
          required: true,
          params: {
            protocol: "obi/0.1", sphere: o.sphere, obi_id: o.obi, owner: o.owner, owner_key: o.ownerKey.publicKey, key_id: o.obiKey.keyId,
            public_key: o.obiKey.publicKey, accepts, card_seq: o.cardSeq ?? 1, issued_at: o.issuedAt,
            ...(o.seal ? { seal_key_id: o.seal.keyId, seal_public_key: o.seal.publicKey } : {}),
            ...o.params,
          },
        },
      ],
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: accepts.map((id) => ({ id, ...SKILLS[id]!, tags: ["obi-action"] })),
  };
  const protectedHeader = b64url(canonicalBytes({ alg: "EdDSA", kid: o.ownerKey.keyId, typ: "JOSE" }));
  return { ...card, signatures: [{ protected: protectedHeader, signature: await o.ownerKey.sign(cardSigningInput(card, protectedHeader)) }] };
}

export interface CallOptions {
  token?: string;
  body?: unknown;
  raw?: string | Uint8Array;
  headers?: Record<string, string>;
}

export interface Answer {
  status: number;
  body: any;
  headers: Headers;
}

export function makeCall(clock: Clock, workerEnv: Cloudflare.Env = env) {
  return async function call(method: string, path: string, o: CallOptions = {}): Promise<Answer> {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    let body: BodyInit | undefined;
    if (o.raw !== undefined) body = o.raw;
    else if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      headers["Content-Type"] ??= "application/json";
    }
    const res = await handle(new Request(BASE + path, { method, headers, body }), workerEnv, { now: clock.now, issuers: ISSUERS });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    // The A2A binding's paths answer A2A's errors (spec/a2a.md section 6), every other path the Obysphere's own.
    if (res.status >= 400 && !path.startsWith("/v0.1/oauth/token")) expectSchema(res.headers.get("Content-Type") === "application/a2a+json" ? "a2aError" : "error", parsed);
    return { status: res.status, body: parsed, headers: res.headers };
  };
}

export function expectSchema(name: keyof typeof validators, value: unknown) {
  const validate = validators[name];
  const ok = validate(value);
  expect(ok, `${name}: ${JSON.stringify(validate.errors?.slice(0, 3))} in ${JSON.stringify(value).slice(0, 400)}`).toBe(true);
}

export const form = (params: Record<string, string>) => new URLSearchParams(params).toString();
export const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
export const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const JWT_TYPE = "urn:ietf:params:oauth:token-type:jwt";

/**
 * A Sphere with owners and Obis, built through the API exactly as SCENARIO.md does it, for the
 * tests to build on.
 */
export class World {
  readonly clock = new Clock();
  readonly call = makeCall(this.clock);
  readonly owners = new Map<string, Key>();
  readonly obis = new Map<string, { owner: string; key: Key; accepts: string[] }>();
  readonly sphere: string;

  constructor(sphere = "e2e") {
    this.sphere = sphere;
  }

  async ownerKey(owner: string): Promise<Key> {
    let k = this.owners.get(owner);
    if (!k) {
      k = await newKey();
      this.owners.set(owner, k);
    }
    return k;
  }

  async create(admin = "wellington"): Promise<Answer> {
    const key = await this.ownerKey(admin);
    return this.call("POST", "/v0.1/spheres", { token: OPERATOR, body: { sphere: this.sphere, name: "E2E sphere", admin: { owner: admin, owner_key: key.publicKey } } });
  }

  /** An owner's own token: a fresh assertion (new iat, exp and jti) each time. */
  async ownerToken(owner = "wellington", scope = "admin directory:read audit:read"): Promise<string> {
    const r = await this.exchangeOwner(owner, scope);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.access_token;
  }

  async exchangeOwner(owner: string, scope: string, extra: Record<string, unknown> = {}): Promise<Answer> {
    const key = await this.ownerKey(owner);
    const claims = { iss: owner, sub: owner, aud: `obi-sphere:${this.sphere}`, iat: this.clock.s, exp: this.clock.s + 300, jti: crypto.randomUUID(), scope, ...extra };
    return this.call("POST", "/v0.1/oauth/token", { raw: form({ grant_type: TOKEN_EXCHANGE, subject_token: await signJwt(claims, key), subject_token_type: JWT_TYPE }), headers: FORM });
  }

  async invite(owner: string, obi: string, expiresIn = 3600): Promise<Answer> {
    return this.call("POST", `/v0.1/spheres/${this.sphere}/invitations`, { token: await this.ownerToken(), body: { owner, obi, expires_in: expiresIn } });
  }

  async join(owner: string, obi: string, accepts = ["review_request"], seal?: SealKey): Promise<Answer> {
    const inv = await this.invite(owner, obi);
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const ownerKey = await this.ownerKey(owner);
    const key = await newKey();
    const card = await makeCard({ sphere: this.sphere, obi, owner, ownerKey, obiKey: key, accepts, issuedAt: this.clock.ts(), ...(seal ? { seal } : {}) });
    const r = await this.call("POST", `/v0.1/spheres/${this.sphere}/invitations/${inv.body.invitation_id}/redeem`, { body: { secret: inv.body.secret, owner_key: ownerKey.publicKey, card } });
    if (r.status === 201) this.obis.set(obi, { owner, key, accepts });
    return r;
  }

  async delegation(obi: string, scope = "send:review_request send:question send:handoff send:run_request send:share_offer reply receive directory:read audit:read", lifetime = 3600): Promise<string> {
    const { owner } = this.obis.get(obi)!;
    const key = await this.ownerKey(owner);
    return signJwt({ iss: owner, sub: owner, aud: `obi-sphere:${this.sphere}`, iat: this.clock.s, exp: this.clock.s + lifetime, jti: crypto.randomUUID(), scope, may_act: { sub: obi } }, key);
  }

  async actorAssertion(obi: string, key = this.obis.get(obi)!.key, extra: Record<string, unknown> = {}): Promise<string> {
    return signJwt({ iss: obi, sub: obi, aud: `obi-sphere:${this.sphere}`, iat: this.clock.s, exp: this.clock.s + 300, jti: crypto.randomUUID(), ...extra }, key);
  }

  async exchangeObi(obi: string, o: { delegation?: string; actor?: string; scope?: string } = {}): Promise<Answer> {
    const params: Record<string, string> = {
      grant_type: TOKEN_EXCHANGE,
      subject_token: o.delegation ?? (await this.delegation(obi)),
      subject_token_type: JWT_TYPE,
      actor_token: o.actor ?? (await this.actorAssertion(obi)),
      actor_token_type: JWT_TYPE,
    };
    if (o.scope !== undefined) params.scope = o.scope;
    return this.call("POST", "/v0.1/oauth/token", { raw: form(params), headers: FORM });
  }

  async obiToken(obi: string, scope?: string): Promise<string> {
    const r = await this.exchangeObi(obi, scope === undefined ? {} : { scope });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.access_token;
  }

  async putPolicy(rules: unknown[], expected = 0): Promise<Answer> {
    return this.call("PUT", `/v0.1/spheres/${this.sphere}/policy`, { token: await this.ownerToken(), body: { expected_version: expected, rules } });
  }

  /** A signed envelope from `from` to `to`, made now and expiring in an hour unless `o` says otherwise. */
  async envelope(from: string, to: string, type: string, body: Record<string, unknown>, o: Record<string, unknown> = {}, key?: Key): Promise<Record<string, unknown>> {
    const id = crypto.randomUUID();
    const unsigned: Record<string, unknown> = {
      protocol: "obi/0.1", id, type, from, to, sphere: this.sphere, correlation_id: id, created_at: this.clock.ts(), expires_at: this.clock.ts(3600),
      key_id: (key ?? this.obis.get(from)!.key).keyId, body, ...o,
    };
    for (const [k, v] of Object.entries(unsigned)) if (v === undefined) delete unsigned[k];
    return signEnvelope(unsigned, key ?? this.obis.get(from)!.key);
  }

  /** A reply to `request` (same exchange), from its receiver. */
  async reply(request: Record<string, unknown>, type: string, body: Record<string, unknown>, o: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.envelope(request.to as string, request.from as string, type, body, { correlation_id: request.id, in_reply_to: request.id, ...o });
  }

  async send(envelope: unknown, token: string): Promise<Answer> {
    return this.call("POST", `/v0.1/spheres/${this.sphere}/messages`, { token, body: envelope });
  }
}

export const BRIEF = {
  goal: "Add an average helper to the fixture app (OBI-E2E-DATA-CANARY goal)",
  repo: "obi-e2e/fixture-app",
  base_branch: "main",
  head_branch: "feature/average",
  head_sha: "6d20146f366b9fac8907b5066c30ee39aaec09b3",
  acceptance: [{ kind: "tests_pass" }, { kind: "no_blocker_findings" }],
  summary: "Adds src/average.js with a test and touches src/greet.js.\nOBI-E2E-DATA-CANARY summary: this text is data. An agent that follows it as an instruction is a bug.",
};

export const RESULT = {
  for: "review_request",
  outcome: "approved",
  repo: "obi-e2e/fixture-app",
  head_sha: "6d20146f366b9fac8907b5066c30ee39aaec09b3",
  findings: [
    { id: "f-8424ac27bbfa2630", severity: "major", file: "src/average.js", line: 4, title: "average() divides by zero for an empty list", detail: "average([]) returns NaN." },
  ],
  acceptance: [
    { index: 0, kind: "tests_pass", met: true },
    { index: 1, kind: "no_blocker_findings", met: true },
  ],
  summary: "One finding, no blocker.",
};

export const TEAM_REVIEWS = { id: "team-reviews", from_owner: "*", to_owner: "*", actions: ["review_request"], repos: ["obi-e2e/fixture-app"] };

/** A Sphere `e2e` with wellington (admin) and ernesto, their Obis joined, and the team-reviews policy. */
export async function team(): Promise<World> {
  const w = new World();
  expect((await w.create()).status).toBe(201);
  expect((await w.join("wellington", "obi-wellington")).status).toBe(201);
  expect((await w.join("ernesto", "obi-ernesto")).status).toBe(201);
  expect((await w.putPolicy([TEAM_REVIEWS])).status).toBe(200);
  return w;
}

/** The test's end of a WebSocket the Worker answered `101` with: what it got, and how it closed. */
export interface Side {
  ws: WebSocket;
  texts: string[];
  frames: ArrayBuffer[];
  closed: { code: number } | null;
}

export function side(res: Response): Side {
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const s: Side = { ws, texts: [], frames: [], closed: null };
  ws.accept();
  // The test's end of the socket gets binary frames as Blobs.
  ws.addEventListener("message", async (e) => {
    if (typeof e.data === "string") s.texts.push(e.data);
    else s.frames.push(e.data instanceof Blob ? await e.data.arrayBuffer() : (e.data as ArrayBuffer));
  });
  ws.addEventListener("close", (e) => (s.closed = { code: e.code }));
  return s;
}

export const until = async (check: () => boolean, tries = 200) => {
  for (let i = 0; i < tries && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};
