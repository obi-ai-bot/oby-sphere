// Copied from client/src/jws.ts by server/scripts/sync-client.mjs: edit it there, then run `pnpm run sync:client`.
// Compact JWS with EdDSA (RFC 7515, RFC 8037): the owner and actor assertions of
// spec/identity.md section 4.1, made and read.

import { b64url, fromB64url, verifyEd25519, type SigningKey } from "./crypto.ts";
import { canonicalBytes, decodeUtf8Strict, isObject, parseStrict, utf8, type JsonObject } from "./json.ts";
import { matches } from "./schemas.ts";

export interface CompactJws {
  header: { alg: "EdDSA"; kid: string; typ: string };
  claims: JsonObject;
  signingInput: Uint8Array;
  signature: string;
}

const SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Splits and decodes a compact JWS whose header is {alg: EdDSA, kid, typ: JWT}; null when it isn't one. */
export function parseJwt(token: string): CompactJws | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) return null;
  const [h, c, s] = parts as [string, string, string];
  try {
    const header = parseStrict(decodeUtf8Strict(fromB64url(h)));
    const claims = parseStrict(decodeUtf8Strict(fromB64url(c)));
    if (!matches("wire/jws-header", header) || (header as JsonObject).typ !== "JWT" || !isObject(claims)) return null;
    if (fromB64url(s).length !== 64) return null;
    return { header: header as CompactJws["header"], claims, signingInput: utf8(`${h}.${c}`), signature: s };
  } catch {
    return null;
  }
}

export const verifyJws = (jws: CompactJws, publicKey: string): Promise<boolean> => verifyEd25519(publicKey, jws.signingInput, jws.signature);

// ---------------------------------------------------------------------------------------------
// Making assertions: identity.md section 4.1.

/** A compact JWT signed with `key`: header {alg: EdDSA, kid, typ: JWT}, the claims as canonical JSON. */
export async function signJwt(claims: JsonObject, key: SigningKey): Promise<string> {
  const head = b64url(canonicalBytes({ alg: "EdDSA", kid: key.keyId, typ: "JWT" }));
  const body = b64url(canonicalBytes(claims));
  return `${head}.${body}.${await key.sign(utf8(`${head}.${body}`))}`;
}

/** The audience of every assertion for `sphere`. */
export const audience = (sphere: string): string => `obi-sphere:${sphere}`;

/**
 * The audience that binds an assertion to the server too (identity.md section 4.1): the
 * Obysphere's own URL, `<server origin>/v0.1/spheres/<sphere>`. Send it only to a server that lists
 * `sphere_url_aud` in `GET /v0.1/features`; `audience(sphere)` stays valid everywhere.
 */
export const serverAudience = (base: string, sphere: string): string => `${new URL(base).origin}/v0.1/spheres/${sphere}`;

/** The longest a delegation lives (`exp − iat`): 30 days. */
export const MAX_DELEGATION_SECONDS = 2592000;
/** The longest an owner's own assertion or an actor assertion lives. */
export const MAX_ASSERTION_SECONDS = 300;

/**
 * An owner assertion, signed by the owner's key: with `mayAct`, a delegation to that Obi (at most
 * 30 days); without, the owner's own short assertion for admin calls (at most 300 seconds).
 */
export async function ownerAssertion(
  key: SigningKey,
  o: { owner: string; sphere: string; scope: string; mayAct?: string; lifetime?: number; now?: number; aud?: string },
): Promise<string> {
  const iat = o.now ?? Math.floor(Date.now() / 1000);
  const max = o.mayAct ? MAX_DELEGATION_SECONDS : MAX_ASSERTION_SECONDS;
  const lifetime = o.lifetime ?? max;
  if (lifetime < 1 || lifetime > max) throw new Error(`the assertion lives 1 to ${max} seconds`);
  const claims: JsonObject = { iss: o.owner, sub: o.owner, aud: o.aud ?? audience(o.sphere), iat, exp: iat + lifetime, jti: crypto.randomUUID(), scope: o.scope };
  if (o.mayAct) claims.may_act = { sub: o.mayAct };
  return signJwt(claims, key);
}

/** An actor assertion, signed by the Obi's current key: single-use, at most 300 seconds. */
export async function actorAssertion(key: SigningKey, o: { obi: string; sphere: string; lifetime?: number; now?: number; aud?: string }): Promise<string> {
  const iat = o.now ?? Math.floor(Date.now() / 1000);
  const lifetime = o.lifetime ?? MAX_ASSERTION_SECONDS;
  if (lifetime < 1 || lifetime > MAX_ASSERTION_SECONDS) throw new Error(`an actor assertion lives 1 to ${MAX_ASSERTION_SECONDS} seconds`);
  return signJwt({ iss: o.obi, sub: o.obi, aud: o.aud ?? audience(o.sphere), iat, exp: iat + lifetime, jti: crypto.randomUUID() }, key);
}
