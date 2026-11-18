// Signing in (spec/sphere-api.md section 3.1) with any OpenID Connect provider the operator names:
// what lets an Obysphere be created without the operator token, and an invitation be for one
// domain's people. Google is one provider (GOOGLE_CLIENT_ID); any other comes from SIGNIN_PROVIDERS
// and its issuer's discovery document. The ID token is checked here (its issuer's keys, the
// issuer, the client id, the nonce). Only the account (`<provider>:<sub>`) and its domain are
// kept, never the email or the token.

import { knowsOrigin, ownOrigin } from "./auth.ts";
import type { Deps, Env } from "./env.ts";
import { apiError, json, rateLimited, readJson } from "./http.ts";
import { constantTimeEqual, fromB64url, randomToken, sha256, sha256Hex } from "./protocol/crypto.ts";
import { CLIENTS } from "./clients.ts";
import { utf8 } from "./protocol/json.ts";
import { schemaErrors } from "./protocol/schemas.ts";

const SIGN_IN_SECONDS = 10 * 60;
const MAX_PROVIDERS = 32;
const TOKEN_SKEW_SECONDS = 60;
const MAX_WAITING = 1000;
/// Where the browser goes back to when the client names nowhere: Oby's scheme, from before `return_to`.
const BACK = "obi-sphere://signin";
const DAY_S = 24 * 3600;

const SLUG = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
const DOMAIN = /^(?=.{4,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** Hosts an issuer, or a `return_to`, may name over plain http: this machine only. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Schemes a browser handles itself, never a client's: an operator can't name them. */
const BROWSER_SCHEMES = new Set(["http", "https", "ws", "wss", "javascript", "vbscript", "data", "file", "filesystem", "blob", "about", "intent", "ftp", "mailto", "tel", "view-source", "microsoft-edge", "edge", "x-safari-https", "googlechrome", "googlechromes", "firefox", "opera"]);
/** Oby's scheme, where a sign-in returns when the client names nowhere: always one this server knows. */
const OBY_SCHEME = "obi-sphere";

// ---------------------------------------------------------------------------------------------
// The providers

/** One identity provider an Obysphere server trusts. */
export interface Provider {
  /** Its id: the sign-in's path (`/v0.1/signin/<id>`) and its accounts' prefix (`<id>:<sub>`). */
  id: string;
  /** Its name, for a client to show. */
  name: string;
  /** Its issuer, whose discovery document says where to sign in and its keys; and the `iss` of its ID tokens. */
  issuer: string;
  /** Every `iss` its ID tokens may carry (Google issues under two spellings). */
  issuers: string[];
  client_id: string;
  /** Where to sign in and its keys, when fixed rather than discovered (Google). */
  authorize?: string;
  jwks?: string;
  /** Every account's domain: for an issuer that signs in no one but one organisation's people. */
  domain?: string;
  /** Or the claim that names an account's domain, which the issuer itself sets (Google: `hd`). */
  domain_claim?: string;
  /** Whether an ID token must say `email_verified: true`. */
  email_verified: boolean;
}

/** Issuers that sign in anyone, or any organisation's people. */
const MULTI_TENANT = ["https://accounts.google.com", "accounts.google.com", "https://login.microsoftonline.com/common", "https://login.microsoftonline.com/organizations", "https://login.microsoftonline.com/consumers", "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad"];

const google = (client: string): Provider => ({
  id: "google",
  name: "Google",
  issuer: "https://accounts.google.com",
  issuers: ["https://accounts.google.com", "accounts.google.com"],
  client_id: client,
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  jwks: "https://www.googleapis.com/oauth2/v3/certs",
  domain_claim: "hd",
  email_verified: true,
});

/** An https URL, or http to this machine when `loopback` allows it; no user name, query or fragment. */
function webUrl(text: unknown, loopback = true): URL | null {
  if (typeof text !== "string" || text.length > 300) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const ok = url.protocol === "https:" || (loopback && url.protocol === "http:" && LOOPBACK.has(url.hostname));
  return ok && !url.username && !url.password && !url.search && !url.hash ? url : null;
}

/** Why `entry` isn't a provider SIGNIN_PROVIDERS may name, or the provider. */
function provider(entry: unknown): Provider | string {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return "not an object";
  const e = entry as Record<string, unknown>;
  const known = ["id", "name", "issuer", "client_id", "domain", "domain_claim", "email_verified"];
  const unknown = Object.keys(e).find((k) => !known.includes(k));
  if (unknown) return `an unknown setting, ${unknown}`;
  if (typeof e.id !== "string" || !SLUG.test(e.id)) return "id is 1 to 32 lower-case letters, digits and inner hyphens";
  if (typeof e.name !== "string" || !/^[^\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+$/.test(e.name) || [...e.name].length > 100) return "name is 1 to 100 characters on one line";
  if (!webUrl(e.issuer)) return "issuer is an https URL";
  if (typeof e.client_id !== "string" || !/^[\x21-\x7e]{1,512}$/.test(e.client_id)) return "client_id is 1 to 512 printable characters";
  if (e.domain !== undefined && (typeof e.domain !== "string" || !DOMAIN.test(e.domain))) return "domain is a lower-case domain";
  if (e.domain_claim !== undefined && (typeof e.domain_claim !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(e.domain_claim))) return "domain_claim names a claim";
  if (e.domain !== undefined && e.domain_claim !== undefined) return "domain and domain_claim don't go together";
  if (e.email_verified !== undefined && typeof e.email_verified !== "boolean") return "email_verified is true or false";
  // `google` is Google's, set up by GOOGLE_CLIENT_ID with Google's own endpoints and checks.
  if (e.id === "google") return "the id google is GOOGLE_CLIENT_ID's";
  // A domain is every account's only on an issuer that signs in no one else; these sign in anyone.
  if (e.domain !== undefined && MULTI_TENANT.some((m) => (e.issuer as string).startsWith(m))) return "domain can't be every account's on an issuer that signs in anyone: use domain_claim";
  return {
    id: e.id, name: e.name, issuer: e.issuer as string, issuers: [e.issuer as string], client_id: e.client_id,
    ...(e.domain !== undefined ? { domain: e.domain as string } : {}),
    ...(e.domain_claim !== undefined ? { domain_claim: e.domain_claim as string } : {}),
    email_verified: e.email_verified === true,
  };
}

/** SIGNIN_PROVIDERS, a JSON list (wrangler may hand it over parsed), and Google for GOOGLE_CLIENT_ID. A malformed entry is left out, and the log says why. */
export function providers(env: Env): Provider[] {
  let entries: unknown = env.SIGNIN_PROVIDERS ?? [];
  if (typeof entries === "string") {
    try {
      entries = entries.trim() ? JSON.parse(entries) : [];
    } catch {
      console.warn("sign-in: SIGNIN_PROVIDERS isn't JSON; no provider is taken from it");
      entries = [];
    }
  }
  const list: Provider[] = [];
  for (const [i, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    const p = provider(entry);
    if (typeof p === "string") console.warn(`sign-in: SIGNIN_PROVIDERS[${i}] is left out: ${p}`);
    else if (list.some((q) => q.id === p.id)) console.warn(`sign-in: SIGNIN_PROVIDERS[${i}] is left out: its id is taken`);
    else list.push(p);
  }
  const client = env.GOOGLE_CLIENT_ID?.trim();
  if (client) list.unshift(google(client));
  if (list.length > MAX_PROVIDERS) console.warn(`sign-in: only the first ${MAX_PROVIDERS} providers are taken`);
  return list.slice(0, MAX_PROVIDERS);
}

/** Whether this Obysphere server signs anyone in (an invitation with a `domain` needs it). */
export const signsIn = (env: Env): boolean => knowsOrigin(env) && providers(env).length > 0;

const named = (env: Env, id: string): Provider => {
  const p = providers(env).find((q) => q.id === id);
  if (!p) throw apiError("forbidden", `this Obysphere server has no sign-in ${id}`);
  return p;
};

/** CREATOR_WORKSPACES, lower case: the domains whose people may create an Obysphere by signing in. */
export const creatorWorkspaces = (env: Env): string[] =>
  (env.CREATOR_WORKSPACES ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);

// ---------------------------------------------------------------------------------------------
// Each issuer's discovery document and keys, kept for a day

type Jwk = JsonWebKey & { kid?: string; use?: string };

/** What an ID token may be signed with, and how WebCrypto checks each. */
const ALGORITHMS: Record<string, { kty: string; crv?: string; importAs: { name: string; hash?: string; namedCurve?: string }; verifyAs: { name: string; hash?: string } }> = {
  RS256: { kty: "RSA", importAs: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verifyAs: { name: "RSASSA-PKCS1-v1_5" } },
  ES256: { kty: "EC", crv: "P-256", importAs: { name: "ECDSA", namedCurve: "P-256" }, verifyAs: { name: "ECDSA", hash: "SHA-256" } },
  EdDSA: { kty: "OKP", crv: "Ed25519", importAs: { name: "Ed25519" }, verifyAs: { name: "Ed25519" } },
};

const usable = (k: Jwk): boolean =>
  typeof k.kid === "string" && (k.use === undefined || k.use === "sig") &&
  Object.values(ALGORITHMS).some((a) => a.kty === k.kty && (a.crv === undefined || a.crv === k.crv));

/// One issuer's keys, kept for a day and fetched again for a `kid` not among them, at most once a
/// minute. A fetch that fails keeps the keys there are.
export class KeyCache {
  private keys: Jwk[] = [];
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private triedAt = Number.NEGATIVE_INFINITY;
  private readonly fetchKeys: () => Promise<Jwk[]>;

  constructor(fetchKeys: () => Promise<Jwk[]>) {
    this.fetchKeys = fetchKeys;
  }

  async key(kid: string, nowS: number): Promise<Jwk | undefined> {
    const stale = nowS - this.fetchedAt > DAY_S;
    const unknown = !this.keys.some((k) => k.kid === kid) && nowS - this.fetchedAt > 60;
    if ((stale || unknown) && nowS - this.triedAt >= 60) {
      // At most one try a minute, whether or not it works.
      this.triedAt = nowS;
      try {
        const keys = (await this.fetchKeys()).filter(usable);
        if (keys.length) {
          this.keys = keys;
          this.fetchedAt = nowS;
        }
      } catch {
        console.warn("sign-in: an issuer's keys couldn't be read");
      }
    }
    return this.keys.find((k) => k.kid === kid);
  }
}

interface Endpoints {
  authorize: string;
  jwks: string;
}

/** Every issuer's discovery document and keys, fetched with `get` (the tests give their own issuer). */
export class Issuers {
  private readonly get: (url: string) => Promise<Response>;
  private readonly discovered = new Map<string, { at: number; endpoints: Endpoints }>();
  private readonly tried = new Map<string, number>();
  private readonly keyCaches = new Map<string, KeyCache>();

  constructor(get: (url: string) => Promise<Response> = (url) => fetch(url)) {
    this.get = get;
  }

  /** Where to sign in with `p`, and its keys: fixed, or from `<issuer>/.well-known/openid-configuration`. Null when it can't be read. */
  async endpoints(p: Provider, nowS: number): Promise<Endpoints | null> {
    if (p.authorize && p.jwks) return { authorize: p.authorize, jwks: p.jwks };
    const kept = this.discovered.get(p.issuer);
    if (kept && nowS - kept.at < DAY_S) return kept.endpoints;
    // At most one try a minute while an issuer can't be read.
    const tried = this.tried.get(p.issuer) ?? Number.NEGATIVE_INFINITY;
    if (nowS - tried < 60) return kept?.endpoints ?? null;
    this.tried.set(p.issuer, nowS);
    try {
      const r = await this.get(`${p.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const doc = (await r.json()) as Record<string, unknown>;
      if (doc.issuer !== p.issuer) throw new Error("its issuer is another");
      // http to this machine only for an issuer on this machine (one under test).
      const local = new URL(p.issuer).protocol === "http:";
      const authorize = webUrl(doc.authorization_endpoint, local), jwks = webUrl(doc.jwks_uri, local);
      if (!authorize || !jwks) throw new Error("no authorization endpoint or keys");
      const modes = doc.response_modes_supported, types = doc.response_types_supported;
      if (Array.isArray(modes) && !modes.includes("form_post")) throw new Error("no form_post");
      if (Array.isArray(types) && !types.includes("id_token")) throw new Error("no id_token response");
      const endpoints = { authorize: authorize.href, jwks: jwks.href };
      this.discovered.set(p.issuer, { at: nowS, endpoints });
      return endpoints;
    } catch (e) {
      console.warn(`sign-in: ${p.id}'s discovery couldn't be read: ${e instanceof Error ? e.message : "refused"}`);
      return kept?.endpoints ?? null;
    }
  }

  keys(jwks: string): KeyCache {
    let cache = this.keyCaches.get(jwks);
    if (!cache) {
      cache = new KeyCache(async () => {
        const r = await this.get(jwks);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const keys = ((await r.json()) as { keys?: unknown }).keys;
        return Array.isArray(keys) ? (keys as Jwk[]) : [];
      });
      this.keyCaches.set(jwks, cache);
    }
    return cache;
  }
}

const shared = new Issuers();

// ---------------------------------------------------------------------------------------------
// GET /v0.1/signin

export function listSignIns(_request: Request, env: Env): Response {
  // A server that doesn't know its own address signs nobody in, so it lists no provider.
  return json(200, { providers: knowsOrigin(env) ? providers(env).map((p) => ({ id: p.id, name: p.name })) : [] });
}

// ---------------------------------------------------------------------------------------------
// POST /v0.1/signin/{provider}

/**
 * Where a sign-in's code may go back to, normalised; or null. Only places on the person's own
 * machine: an http URL on 127.0.0.1, localhost or [::1], or a URL in a scheme this server knows,
 * Oby's (`obi-sphere`), a listed client's (src/clients.ts) or one the operator names
 * (SIGNIN_RETURN_SCHEMES). Any other scheme may belong to an app that opens a web address it
 * carries, and so hand the code to a server. Printable ASCII, at most 300, no query or fragment.
 */
export function returnTo(text: string, env: Env): string | null {
  if (!/^[\x21-\x7e]{3,300}$/.test(text) || /[#?]/.test(text)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(text)?.[1];
  if (!scheme) return null;
  if (scheme === "http") {
    const url = webUrl(text);
    return url && url.protocol === "http:" && LOOPBACK.has(url.hostname) ? url.href : null;
  }
  // Oby's scheme, and a listed client's, only to its sign-in page, where the client takes a code
  // back: never to another of its routes (`join`, `claim`) that would make it contact a host.
  if (scheme === OBY_SCHEME || CLIENTS.some((c) => c.scheme === scheme)) return text === `${scheme}://signin` ? text : null;
  return returnSchemes(env).has(scheme) ? text : null;
}

/** The schemes a sign-in may return to: Oby's, the listed clients', and SIGNIN_RETURN_SCHEMES (comma-separated). */
export function returnSchemes(env: Env): Set<string> {
  // An operator's scheme is reverse-DNS, as RFC 8252 section 7.1 asks of a native app's (`com.example.app`):
  // never a browser's, and never one with no dot.
  const named = (env.SIGNIN_RETURN_SCHEMES ?? "").split(",").map((x) => x.trim().toLowerCase()).filter((x) => {
    // The browser list is a backstop: none of its schemes has a dot.
    const ok = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(x) && !BROWSER_SCHEMES.has(x);
    if (x && !ok) console.warn(`sign-in: SIGNIN_RETURN_SCHEMES leaves out ${x}: a client's scheme is reverse-DNS, like com.example.app`);
    return ok;
  });
  return new Set([OBY_SCHEME, ...CLIENTS.flatMap((c) => (c.scheme ? [c.scheme] : [])), ...named]);
}

export async function startSignIn(request: Request, env: Env, deps: Deps, providerId: string): Promise<Response> {
  const p = named(env, providerId);
  const origin = ownOrigin(env, request);
  if (origin === null) throw apiError("forbidden", "this server doesn't know its own address (SPHERE_URL), so it signs nobody in");
  const body = await readJson(request);
  const errors = schemaErrors("signinRequest", body);
  if (errors.length) throw apiError("bad_request", "the body doesn't match signin.request", errors);
  const req = body as unknown as { owner_key: string; return_to?: string };
  const back = req.return_to === undefined ? null : returnTo(req.return_to, env);
  if (req.return_to !== undefined && !back) throw apiError("bad_request", "return_to is an http URL on this machine (127.0.0.1, localhost or [::1]), or a scheme this server knows, with no query");
  const nowS = Math.floor(deps.now() / 1000);
  const endpoints = await (deps.issuers ?? shared).endpoints(p, nowS);
  if (!endpoints) throw rateLimited(`${p.name} can't be reached now`, 60);
  await env.DB.prepare("DELETE FROM sign_ins WHERE expires_at_s <= ?1").bind(nowS).run();
  const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM sign_ins WHERE account IS NULL").first<{ n: number }>();
  if ((waiting?.n ?? 0) >= MAX_WAITING) throw rateLimited("too many sign-ins are waiting", 60);
  const state = randomToken(32);
  const nonce = randomToken(32);
  await env.DB.prepare("INSERT INTO sign_ins (state, owner_key, nonce_sha256, expires_at_s, provider, return_to) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(state, req.owner_key, await sha256Hex(utf8(nonce)), nowS + SIGN_IN_SECONDS, p.id, back)
    .run();
  const url = new URL(endpoints.authorize);
  for (const [k, v] of Object.entries({
    client_id: p.client_id,
    redirect_uri: `${origin}/v0.1/signin/${p.id}/callback`,
    response_type: "id_token",
    response_mode: "form_post",
    scope: "openid email",
    ...(p.id === "google" ? { prompt: "select_account" } : {}),
    state,
    nonce,
  })) url.searchParams.set(k, v);
  return json(201, { url: url.toString(), state });
}

// ---------------------------------------------------------------------------------------------
// POST /v0.1/signin/{provider}/callback: the provider's form post.

export async function finishSignIn(request: Request, env: Env, deps: Deps, providerId: string): Promise<Response> {
  const p = named(env, providerId);
  if (!knowsOrigin(env)) throw apiError("forbidden", "this server doesn't know its own address (SPHERE_URL), so it signs nobody in");
  const to = (where: string, state: string, query: string) =>
    new Response(null, { status: 303, headers: { Location: `${where}?state=${encodeURIComponent(state)}&${query}`, "Cache-Control": "no-store" } });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw apiError("bad_request", "send the provider's form");
  }
  const state = String(form.get("state") ?? "");
  const token = String(form.get("id_token") ?? "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw apiError("bad_request", "that sign-in isn't this Obysphere's");
  const nowS = Math.floor(deps.now() / 1000);
  const row = await env.DB.prepare("SELECT nonce_sha256, provider, return_to, account, expires_at_s FROM sign_ins WHERE state = ?1")
    .bind(state)
    .first<{ nonce_sha256: string; provider: string; return_to: string | null; account: string | null; expires_at_s: number }>();
  // A sign-in another provider's callback finishes, or one not waiting, fails; its code goes nowhere.
  const waiting = row !== null && row.provider === p.id && row.account === null && row.expires_at_s > nowS;
  // Only a waiting sign-in's browser goes back to its return_to; any other, to Oby's scheme.
  const where = waiting ? (row.return_to ?? BACK) : BACK;
  if (!waiting || !token) return to(where, state, "error=failed");
  let account: { sub: string; workspace: string | null };
  try {
    const issuers = deps.issuers ?? shared;
    const endpoints = await issuers.endpoints(p, nowS);
    if (!endpoints) throw new Error(`${p.id} can't be reached`);
    account = await verifyIdToken(token, p, issuers.keys(endpoints.jwks), row.nonce_sha256, nowS);
  } catch (e) {
    console.warn(`sign-in: ${e instanceof Error ? e.message : "refused"}`);
    return to(where, state, "error=failed");
  }
  const code = randomToken(32);
  const kept = await env.DB.prepare("UPDATE sign_ins SET account = ?2, workspace = ?3, code_sha256 = ?4 WHERE state = ?1 AND account IS NULL")
    .bind(state, `${p.id}:${account.sub}`, account.workspace, await sha256Hex(utf8(code)))
    .run();
  // Another post finished it first: this browser gets no code.
  if (kept.meta.changes !== 1) return to(BACK, state, "error=failed");
  return to(where, state, `code=${code}`);
}

/// `p`'s ID token for its client: its `sub`, and its domain (the provider's own, the one its claim
/// names, or null). Throws with a line for the log, never the token.
export async function verifyIdToken(token: string, p: Provider, cache: KeyCache, nonceHash: string, nowS: number): Promise<{ sub: string; workspace: string | null }> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error("not a JWT");
  const [head, body, signature] = parts as [string, string, string];
  const header = decode(head) as { alg?: unknown; kid?: unknown };
  const alg = typeof header.alg === "string" && Object.hasOwn(ALGORITHMS, header.alg) ? ALGORITHMS[header.alg]! : null;
  if (!alg || typeof header.kid !== "string") throw new Error("not RS256, ES256 or EdDSA with a kid");
  const jwk = await cache.key(header.kid, nowS);
  if (!jwk) throw new Error(`signed by a key ${p.id} doesn't list`);
  if (jwk.kty !== alg.kty || (alg.crv !== undefined && jwk.crv !== alg.crv) || (jwk.alg !== undefined && jwk.alg !== header.alg)) throw new Error("signed with another kind of key");
  const publicJwk: JsonWebKey = jwk.kty === "RSA" ? { kty: "RSA", n: jwk.n, e: jwk.e } : jwk.kty === "EC" ? { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y } : { kty: "OKP", crv: jwk.crv, x: jwk.x };
  const key = await crypto.subtle.importKey("jwk", publicJwk, alg.importAs, false, ["verify"]);
  if (!(await crypto.subtle.verify(alg.verifyAs, key, fromB64url(signature), utf8(`${head}.${body}`)))) throw new Error("bad signature");
  const claims = decode(body) as Record<string, unknown>;
  if (typeof claims.iss !== "string" || !p.issuers.includes(claims.iss)) throw new Error(`not issued by ${p.id}`);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(p.client_id)) throw new Error("for another client");
  if (audiences.length > 1 && claims.azp !== p.client_id) throw new Error("for several clients, and not authorized for this one");
  if (typeof claims.exp !== "number" || claims.exp <= nowS) throw new Error("expired");
  if (typeof claims.iat !== "number" || claims.iat > nowS + TOKEN_SKEW_SECONDS || claims.iat < nowS - SIGN_IN_SECONDS) throw new Error("issued at the wrong time");
  if (typeof claims.nonce !== "string" || (await sha256Hex(utf8(claims.nonce))) !== nonceHash) throw new Error("for another sign-in");
  if (typeof claims.sub !== "string" || !/^[\x21-\x7e]{1,255}$/.test(claims.sub)) throw new Error("no account");
  if (p.email_verified && claims.email_verified !== true) throw new Error("no verified email");
  if (p.domain) return { sub: claims.sub, workspace: p.domain };
  const said = p.domain_claim === undefined ? undefined : claims[p.domain_claim];
  const domain = said === undefined ? null : typeof said === "string" ? said.toLowerCase() : "";
  if (domain !== null && !DOMAIN.test(domain)) throw new Error(`a ${p.domain_claim} that isn't a domain`);
  return { sub: claims.sub, workspace: domain };
}

function decode(part: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(fromB64url(part)));
  } catch {
    throw new Error("unreadable");
  }
}

// ---------------------------------------------------------------------------------------------
// Using a sign-in (section 3.1, step 3)

export interface SignIn {
  state: string;
  account: string;
  workspace: string | null;
}

/** A finished, unexpired, unused sign-in started for `ownerKey` whose code matches; else 403 forbidden, the same for all. */
export async function checkSignIn(db: D1Database, given: { state: string; code: string }, ownerKey: string, nowS: number): Promise<SignIn> {
  const row = await db.prepare("SELECT * FROM sign_ins WHERE state = ?1").bind(given.state).first<{
    state: string; owner_key: string; expires_at_s: number; account: string | null; workspace: string | null; code_sha256: string | null; used: number;
  }>();
  const codeOk = constantTimeEqual(await sha256(utf8(given.code)), hexBytes(row?.code_sha256 ?? "0".repeat(64)));
  if (!row || !row.account || !row.code_sha256 || row.used || row.expires_at_s <= nowS || row.owner_key !== ownerKey || !codeOk) {
    throw apiError("forbidden", "the sign-in is unknown, unfinished, used, expired, or for another owner key");
  }
  return { state: row.state, account: row.account, workspace: row.workspace };
}

/** Uses the sign-in up, in the caller's batch: a second use fails the batch's check. */
export const useSignIn = (db: D1Database, state: string): D1PreparedStatement => db.prepare("UPDATE sign_ins SET used = used + 1 WHERE state = ?1").bind(state);

const hexBytes = (h: string): Uint8Array => new Uint8Array((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));
