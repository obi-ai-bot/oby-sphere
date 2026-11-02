// POST /v0.1/oauth/token: OAuth 2.0 Token Exchange (RFC 8693), the subject an owner and the
// actor, when there is one, an Obi acting for them (spec/identity.md section 4.3).

import { SCOPES, canonicalScope, isScope, ownOrigin, ownUrl, tokenHash } from "./auth.ts";
import { constraintFailure, getMember, getOwner, getSphere, unforeseen } from "./db.ts";
import type { Deps, Env } from "./env.ts";
import { MAX_BODY_BYTES, json, readBody } from "./http.ts";
import { randomToken } from "./protocol/crypto.ts";
import { CLOCK_SKEW_SECONDS, MAX_LIFETIME_SECONDS } from "./protocol/envelope.ts";
import { parseJwt, verifyJws, type CompactJws } from "./protocol/jws.ts";
import { matches } from "./protocol/schemas.ts";
import { TOKEN_PROOF_BEHIND, checkProof, type Proof } from "./dpop.ts";

const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const JWT_TYPE = "urn:ietf:params:oauth:token-type:jwt";
const ISSUED_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const PARAMS = new Set(["grant_type", "subject_token", "subject_token_type", "actor_token", "actor_token_type", "scope"]);
const OWN_ASSERTION_MAX_SECONDS = 300;
const ACTOR_ASSERTION_MAX_SECONDS = 300;
const ACCESS_TOKEN_MAX_SECONDS = 3600;

type OAuthErrorCode = "invalid_request" | "invalid_grant" | "invalid_scope" | "unsupported_grant_type" | "invalid_dpop_proof";

class OAuthError extends Error {
  readonly error: OAuthErrorCode;
  constructor(error: OAuthErrorCode, description: string) {
    super(description);
    this.error = error;
  }
}

const oauthError = (e: OAuthError): Response =>
  json(400, { error: e.error, error_description: e.message.replace(/[^\x20-\x21\x23-\x5b\x5d-\x7e]/g, " ").slice(0, 300) });

interface Claims {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  scope?: string;
  may_act?: { sub: string };
}

function parseScopes(text: string, what: string): Set<string> {
  const scopes = new Set(text.split(" "));
  for (const s of scopes) if (!isScope(s)) throw new OAuthError("invalid_scope", `${what} names a scope this Sphere doesn't know`);
  return scopes;
}

/**
 * The Obysphere an assertion's `aud` names: `obi-sphere:<id>`, or `<origin>/v0.1/spheres/<id>` for
 * this server's own origin only (null for another's). The claims schema has checked its form.
 */
export function audSphere(aud: string, origin: string | null): string | null {
  if (aud.startsWith("obi-sphere:")) return aud.slice("obi-sphere:".length);
  const m = /^(https?:\/\/[^/]+)\/v0\.1\/spheres\/([a-z0-9-]+)$/.exec(aud);
  if (!m) return null;
  let named: string;
  try {
    named = new URL(m[1]!).origin;
  } catch {
    return null;
  }
  return origin !== null && named === origin ? m[2]! : null;
}

export async function tokenEndpoint(request: Request, env: Env, deps: Deps): Promise<Response> {
  try {
    return await exchange(request, env, deps);
  } catch (e) {
    if (e instanceof OAuthError) return oauthError(e);
    throw e;
  }
}

async function exchange(request: Request, env: Env, deps: Deps): Promise<Response> {
  const now = Math.floor(deps.now() / 1000);
  const type = (request.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") throw new OAuthError("invalid_request", "the body must be application/x-www-form-urlencoded");
  let bytes: Uint8Array;
  try {
    bytes = await readBody(request);
  } catch {
    throw new OAuthError("invalid_request", `the body is over ${MAX_BODY_BYTES} bytes`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new OAuthError("invalid_request", "the body is not UTF-8");
  }
  const form = new URLSearchParams(text);
  const params = new Map<string, string>();
  for (const [k, v] of form) {
    if (!PARAMS.has(k)) throw new OAuthError("invalid_request", "an unknown parameter");
    if (params.has(k)) throw new OAuthError("invalid_request", `the parameter ${k} is repeated`);
    params.set(k, v);
  }
  const grantType = params.get("grant_type");
  if (grantType === undefined) throw new OAuthError("invalid_request", "grant_type is missing");
  if (grantType !== GRANT_TYPE) throw new OAuthError("unsupported_grant_type", "only token exchange is supported");
  const subjectToken = params.get("subject_token");
  if (!subjectToken) throw new OAuthError("invalid_request", "subject_token is missing");
  if (params.get("subject_token_type") !== JWT_TYPE) throw new OAuthError("invalid_request", `subject_token_type must be ${JWT_TYPE}`);
  const actorToken = params.get("actor_token");
  const actorType = params.get("actor_token_type");
  if ((actorToken === undefined) !== (actorType === undefined)) throw new OAuthError("invalid_request", "actor_token and actor_token_type go together");
  if (actorType !== undefined && actorType !== JWT_TYPE) throw new OAuthError("invalid_request", `actor_token_type must be ${JWT_TYPE}`);
  if (actorToken === "") throw new OAuthError("invalid_request", "actor_token is empty");
  const requested = params.get("scope");

  // 1. Well-formed assertions for an existing Sphere.
  const subject = parseJwt(subjectToken);
  if (!subject || !matches("delegationClaims", subject.claims)) throw new OAuthError("invalid_request", "subject_token is not a well-formed owner assertion");
  const sc = subject.claims as unknown as Claims;
  let actor: CompactJws | null = null;
  let ac: Claims | null = null;
  if (actorToken !== undefined) {
    actor = parseJwt(actorToken);
    if (!actor || !matches("actorClaims", actor.claims)) throw new OAuthError("invalid_request", "actor_token is not a well-formed Obi assertion");
    ac = actor.claims as unknown as Claims;
  }
  // `aud` names the Obysphere: `obi-sphere:<id>`, or its own URL, which binds the assertion to this
  // server (identity.md 4.1). Both assertions name the same one.
  // This server's own origin, as configured; null when it doesn't know it, and then only `obi-sphere:<id>` names it.
  const origin = ownOrigin(env, request);
  const sphereId = audSphere(sc.aud, origin);
  if (sphereId === null) throw new OAuthError("invalid_request", "subject_token's aud names an Obysphere on another server");
  if (ac && audSphere(ac.aud, origin) !== sphereId) throw new OAuthError("invalid_request", "the two assertions are for different Spheres");
  const sphere = await getSphere(env.DB, sphereId);
  if (!sphere) throw new OAuthError("invalid_request", "aud names no Sphere on this server");

  // 2. Times and lifetimes.
  const delegation = sc.may_act !== undefined;
  const lifetime = (c: Claims, max: number, what: string) => {
    if (c.iat > now + CLOCK_SKEW_SECONDS) throw new OAuthError("invalid_grant", `${what} is issued in the future`);
    if (!(c.exp > now)) throw new OAuthError("invalid_grant", `${what} has expired`);
    if (!(c.exp > c.iat) || c.exp - c.iat > max) throw new OAuthError("invalid_grant", `${what} may live at most ${max} seconds`);
  };
  lifetime(sc, delegation ? MAX_LIFETIME_SECONDS : OWN_ASSERTION_MAX_SECONDS, delegation ? "the delegation" : "the owner assertion");
  if (ac) lifetime(ac, ACTOR_ASSERTION_MAX_SECONDS, "the actor assertion");

  // 3. The owner assertion, by the key bound for its owner.
  if (sc.iss !== sc.sub) throw new OAuthError("invalid_grant", "an owner assertion's iss and sub are the owner");
  const owner = await getOwner(env.DB, sphere.id, sc.iss);
  if (!owner || subject.header.kid !== owner.owner_key_id || !(await verifyJws(subject, owner.owner_key))) {
    throw new OAuthError("invalid_grant", "the owner assertion doesn't verify with the owner's bound key");
  }

  // 4 and 5. The actor, or its absence; single-use ids.
  let actorObi: string | null = null;
  if (ac && actor) {
    if (!sc.may_act) throw new OAuthError("invalid_grant", "the owner assertion lets no Obi act for the owner");
    if (ac.iss !== ac.sub || sc.may_act.sub !== ac.sub) throw new OAuthError("invalid_grant", "the actor is not the Obi the owner lets act");
    const member = await getMember(env.DB, sphere.id, ac.sub);
    if (!member || member.status !== "active" || member.owner !== sc.iss) throw new OAuthError("invalid_grant", "the actor is not an active member owned by the subject");
    const key = await env.DB.prepare("SELECT public_key FROM member_keys WHERE sphere = ?1 AND obi = ?2 AND key_id = ?3 AND valid_until_seq IS NULL")
      .bind(sphere.id, ac.sub, actor.header.kid)
      .first<{ public_key: string }>();
    if (!key || !(await verifyJws(actor, key.public_key))) throw new OAuthError("invalid_grant", "the actor assertion doesn't verify with the Obi's current key");
    actorObi = ac.sub;
  } else if (delegation) {
    throw new OAuthError("invalid_grant", "a delegation is exchanged only with the Obi's actor assertion");
  }
  // The single-use id: the actor assertion's for an Obi's token (the delegation is presented again
  // each time), the owner assertion's otherwise. Owners and Obis are kept apart by a prefix.
  const single = ac ?? sc;
  const issuer = (ac ? "obi:" : "owner:") + single.iss;
  const used = await env.DB.prepare("SELECT 1 AS used FROM used_jtis WHERE sphere = ?1 AND iss = ?2 AND jti = ?3").bind(sphere.id, issuer, single.jti).first();
  if (used) throw new OAuthError("invalid_grant", "this assertion was used before");

  // 6. Scopes.
  const granted = parseScopes(sc.scope!, "the owner assertion");
  const wanted = requested === undefined ? granted : parseScopes(requested, "scope");
  const mayHold = (s: string) => (actorObi !== null ? s !== "admin" : s === "directory:read" || s === "audit:read" || (s === "admin" && owner.admin === 1));
  const scope = canonicalScope(SCOPES.filter((s) => wanted.has(s) && granted.has(s) && mayHold(s)));
  if (!scope) throw new OAuthError("invalid_scope", "no scope asked for can be granted");

  // 7. With a DPoP proof, a token bound to its key (identity.md 4.6); each proof gets one token.
  let proof: Proof | null = null;
  const dpop = request.headers.get("DPoP");
  if (dpop !== null) {
    // A server that doesn't take DPoP (it doesn't know its own address) ignores the header, as
    // RFC 9449 section 5 lets it: the token it issues is a bearer one, and token_type says so.
    const url = ownUrl(env, request);
    if (url !== null) {
      const checked = await checkProof(dpop, "POST", url, now, { behind: TOKEN_PROOF_BEHIND });
      if (typeof checked === "string") throw new OAuthError("invalid_dpop_proof", checked);
      proof = checked;
    }
  }

  const accessToken = randomToken(32);
  const expiresIn = Math.min(ACCESS_TOKEN_MAX_SECONDS, sc.exp - now);
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM used_jtis WHERE exp_s < ?1").bind(now),
      env.DB.prepare("DELETE FROM tokens WHERE expires_at_s < ?1").bind(now - 86400),
      env.DB.prepare("DELETE FROM dpop_proofs WHERE exp_s < ?1").bind(now),
      env.DB.prepare("INSERT INTO used_jtis (sphere, iss, jti, exp_s) VALUES (?1, ?2, ?3, ?4)").bind(sphere.id, issuer, single.jti, single.exp),
      ...(proof ? [env.DB.prepare("INSERT INTO dpop_proofs (jkt, jti, exp_s) VALUES (?1, ?2, ?3)").bind(proof.jkt, proof.jti, proof.iat + TOKEN_PROOF_BEHIND)] : []),
      env.DB.prepare("INSERT INTO tokens (sha256, sphere, subject, actor, scope, expires_at_s, jkt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(
        await tokenHash(accessToken), sphere.id, sc.iss, actorObi, scope, now + expiresIn, proof?.jkt ?? null,
      ),
    ]);
  } catch (e) {
    const failed = constraintFailure(e);
    if (failed?.startsWith("UNIQUE constraint failed: used_jtis.")) throw new OAuthError("invalid_grant", "this assertion was used before");
    if (failed?.startsWith("UNIQUE constraint failed: dpop_proofs.")) throw new OAuthError("invalid_dpop_proof", "this DPoP proof was used before");
    unforeseen(e, "issuing a token");
  }
  return json(200, { access_token: accessToken, issued_token_type: ISSUED_TYPE, token_type: proof ? "DPoP" : "Bearer", expires_in: expiresIn, scope });
}
