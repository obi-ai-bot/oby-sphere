// Who is calling: the operator (creating Spheres) or the holder of an access token
// (spec/sphere-api.md section 1, "Authentication"; spec/identity.md section 4).

import { ApiError, apiError } from "./http.ts";
import type { Env } from "./env.ts";
import type { SphereRow } from "./db.ts";
import { PROOF_BEHIND, checkProof } from "./dpop.ts";
import { constraintFailure } from "./db.ts";
import { constantTimeEqual, sha256Hex } from "./protocol/crypto.ts";
import { utf8 } from "./protocol/json.ts";

/** Every scope, in the canonical order the Sphere writes them in (identity.md 4.2). */
export const SCOPES = ["admin", "send:review_request", "send:question", "send:handoff", "send:run_request", "send:share_offer", "send:introduction", "reply", "receive", "directory:read", "audit:read"] as const;
export type Scope = (typeof SCOPES)[number];
export const isScope = (s: string): s is Scope => (SCOPES as readonly string[]).includes(s);

/** Scopes as the Sphere writes them: each once, one space apart, in the canonical order. */
export const canonicalScope = (scopes: Iterable<string>): string => {
  const set = new Set(scopes);
  return SCOPES.filter((s) => set.has(s)).join(" ");
};

export interface Caller {
  /** The Sphere the token is for. */
  sphere: string;
  /** The owner the token is for. */
  subject: string;
  /** The Obi acting for the owner, or null for an owner's own token. */
  actor: string | null;
  scopes: Set<string>;
}

/** The scheme is case-insensitive (RFC 9110 section 11.1). */
const PRESENTED = /^(Bearer|DPoP) ([A-Za-z0-9._~-]{1,512})$/i;

export const tokenHash = (token: string): Promise<string> => sha256Hex(utf8(token));

/**
 * This server's origin: SPHERE_URL's when it is set; on a Worker, which leaves it unset, the
 * request's (Cloudflare routes only the Worker's own hosts to it). Null when SPHERE_URL is set but
 * empty or not a URL (the Node build without one): the server doesn't know its own address, so
 * nothing that must name it is taken, and it is never read from a request's Host.
 */
export function ownOrigin(env: Env, request: Request): string | null {
  return env.SPHERE_URL === undefined ? new URL(request.url).origin : configuredOrigin(env.SPHERE_URL);
}

/** SPHERE_URL's origin: an https URL, or http on this machine, with a host; null for anything else (`localhost:8787` parses, as a scheme). */
export function configuredOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    const ok = u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname));
    return ok && u.host && u.origin !== "null" ? u.origin : null;
  } catch {
    return null;
  }
}

/** Whether this server knows its own origin: always on a Worker (SPHERE_URL unset), else when SPHERE_URL is a valid address. */
export const knowsOrigin = (env: Env): boolean => env.SPHERE_URL === undefined || configuredOrigin(env.SPHERE_URL) !== null;

/** The URL a DPoP proof for `request` must name: this server's origin and the request's path; null when it doesn't know its origin. */
export function ownUrl(env: Env, request: Request): string | null {
  const origin = ownOrigin(env, request);
  return origin === null ? null : origin + new URL(request.url).pathname;
}

/** The access token in `Authorization`, as `Bearer <token>` or, for a token bound to a key, `DPoP <token>`; null for neither. */
export function presented(request: Request): { scheme: "Bearer" | "DPoP"; token: string } | null {
  const m = PRESENTED.exec(request.headers.get("Authorization") ?? "");
  return m ? { scheme: m[1]!.toLowerCase() === "dpop" ? "DPoP" : "Bearer", token: m[2]! } : null;
}

/**
 * The caller behind `Authorization: Bearer <access token>`, for `sphere` (which exists), or for
 * whichever Sphere the token is for when `sphere` is null (the phone relay's paths name none). An
 * unknown, expired or revoked token, one for another Sphere, or one whose Obi was revoked, is
 * 401 unauthorized.
 */
export async function bearer(request: Request, env: Env, sphere: SphereRow | null, nowS: number): Promise<Caller> {
  const given = presented(request);
  if (!given) throw unauthorized(env, "an access token is needed: Authorization: Bearer <token>");
  const row = await env.DB.prepare(
    `SELECT t.subject, t.actor, t.scope, t.expires_at_s, t.revoked, t.sphere, t.jkt, m.status AS actor_status
       FROM tokens t LEFT JOIN members m ON m.sphere = t.sphere AND m.obi = t.actor
      WHERE t.sha256 = ?1`,
  )
    .bind(await tokenHash(given.token))
    .first<{ subject: string; actor: string | null; scope: string; expires_at_s: number; revoked: number; sphere: string; jkt: string | null; actor_status: string | null }>();
  if (!row || row.revoked || row.expires_at_s <= nowS) throw unauthorized(env, "the access token is unknown, expired or revoked", "invalid_token");
  // A token bound to a key (identity.md 4.6) works only with a new proof from that key; a bearer
  // token only as Bearer.
  if (row.jkt === null && given.scheme === "DPoP") throw dpopRefused("invalid_token", "this access token isn't bound to a key: Authorization: Bearer <token>");
  if (row.jkt !== null) {
    if (given.scheme !== "DPoP") throw dpopRefused("invalid_token", "this access token is bound to a key: Authorization: DPoP <token>, with a DPoP proof");
    const url = ownUrl(env, request);
    if (url === null) throw dpopRefused("invalid_dpop_proof", "this server doesn't know its own address (SPHERE_URL), so it takes no DPoP proof");
    const proof = await checkProof(request.headers.get("DPoP"), request.method, url, nowS, { accessToken: given.token });
    if (typeof proof === "string") throw dpopRefused("invalid_dpop_proof", proof);
    if (proof.jkt !== row.jkt) throw dpopRefused("invalid_dpop_proof", "the DPoP proof is signed by another key than the token's");
    // A call that changes something, or opens a socket, takes each proof once (identity.md 4.6).
    if (request.method !== "GET" || (request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket") {
      try {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM dpop_proofs WHERE exp_s < ?1").bind(nowS),
          env.DB.prepare("INSERT INTO dpop_proofs (jkt, jti, exp_s) VALUES (?1, ?2, ?3)").bind(proof.jkt, proof.jti, proof.iat + PROOF_BEHIND),
        ]);
      } catch (e) {
        if (constraintFailure(e)?.startsWith("UNIQUE constraint failed: dpop_proofs.")) throw dpopRefused("invalid_dpop_proof", "this DPoP proof was used before");
        throw e;
      }
    }
  }
  if (sphere && row.sphere !== sphere.id) throw unauthorized(env, "the access token is for another Sphere", "invalid_token");
  if (row.actor !== null && row.actor_status !== "active") throw unauthorized(env, "the token's Obi is no longer an active member", "invalid_token");
  return { sphere: row.sphere, subject: row.subject, actor: row.actor, scopes: new Set(row.scope.split(" ")) };
}

/** The challenge on a 401 (RFC 6750 section 3, RFC 9449 section 7.1): Bearer, and DPoP where this server takes it. */
export function challenge(env: Env, error?: "invalid_token"): Record<string, string> {
  const e = error ? ` error="${error}"` : "";
  return { "WWW-Authenticate": knowsOrigin(env) ? `Bearer${e}, DPoP${error ? e + "," : ""} algs="EdDSA ES256"` : `Bearer${e}` };
}

/** A 401 with its challenge. */
export const unauthorized = (env: Env, message: string, error?: "invalid_token") => new ApiError("unauthorized", message, [], undefined, challenge(env, error));

/** A 401 for a DPoP token or proof, with the challenge RFC 9449 section 7.1 asks for. */
const dpopRefused = (error: "invalid_token" | "invalid_dpop_proof", message: string) =>
  new ApiError("unauthorized", message, [], undefined, { "WWW-Authenticate": `DPoP error="${error}", algs="EdDSA ES256"` });

export function requireScope(caller: Caller, ...anyOf: Scope[]): void {
  if (!anyOf.some((s) => caller.scopes.has(s))) throw apiError("insufficient_scope", `this call needs the scope ${anyOf.join(" or ")}`);
}

/** An Obi's token (with an actor); an owner's own token is 403 forbidden. */
export function requireActor(caller: Caller): string {
  if (caller.actor === null) throw apiError("forbidden", "this call needs an Obi's token, not an owner's own");
  return caller.actor;
}

/** An owner's own token (no actor); an Obi's token is 403 forbidden. */
export function requireOwnerToken(caller: Caller): void {
  if (caller.actor !== null) throw apiError("forbidden", "this call needs an owner's own token, not an Obi's");
}

/**
 * The operator: `Authorization: Bearer <SPHERE_OPERATOR_TOKEN>`, compared in constant time and
 * never logged; or, on a self-hosted Sphere that keeps only its hash, the token whose SHA-256 is
 * SPHERE_OPERATOR_TOKEN_SHA256. With neither configured (or a token under 32 characters), 403 forbidden.
 */
export async function requireOperator(request: Request, env: Env): Promise<void> {
  const configured = env.SPHERE_OPERATOR_TOKEN;
  const want = typeof configured === "string" && configured.length >= 32 ? await sha256Hex(utf8(configured)) : env.SPHERE_OPERATOR_TOKEN_SHA256;
  if (!want) throw apiError("forbidden", "this Sphere server has no operator token configured");
  const m = /^Bearer (.+)$/i.exec(request.headers.get("Authorization") ?? "");
  const given = m ? m[1]! : "";
  if (!constantTimeEqual(utf8(await sha256Hex(utf8(given))), utf8(want))) throw new ApiError("unauthorized", "the operator token is missing or wrong", [], undefined, { "WWW-Authenticate": "Bearer" });
}
