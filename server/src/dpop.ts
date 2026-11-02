// Tokens bound to a key (DPoP, RFC 9449; spec/identity.md section 4.6). A client that sends a DPoP
// proof to the token endpoint gets a token bound to the proof's key, which works only with a new
// proof from that key on every call: a token copied out of a log or a store is useless alone.

import { b64url, fromB64url, sha256 } from "./protocol/crypto.ts";
import { canonicalBytes, utf8 } from "./protocol/json.ts";

/** How far ahead of the Obysphere's clock a proof's `iat` may be. */
export const PROOF_AHEAD = 60;
/** How old a proof may be on an API call, and at the token endpoint (which remembers every proof it takes). */
export const PROOF_BEHIND = 120;
export const TOKEN_PROOF_BEHIND = 300;
const MAX_PROOF = 4096;

/** The keys a proof may be signed with, and how WebCrypto checks each. */
const ALGORITHMS: Record<string, { kty: string; crv: string; importAs: { name: string; namedCurve?: string }; verifyAs: { name: string; hash?: string }; members: string[] }> = {
  EdDSA: { kty: "OKP", crv: "Ed25519", importAs: { name: "Ed25519" }, verifyAs: { name: "Ed25519" }, members: ["crv", "kty", "x"] },
  ES256: { kty: "EC", crv: "P-256", importAs: { name: "ECDSA", namedCurve: "P-256" }, verifyAs: { name: "ECDSA", hash: "SHA-256" }, members: ["crv", "kty", "x", "y"] },
};

/** A proof that passed: its key's thumbprint, and what the token endpoint remembers it by. */
export interface Proof {
  jkt: string;
  jti: string;
  iat: number;
}

/** The RFC 7638 thumbprint of a public key: SHA-256 of its required members as canonical JSON, base64url. */
export async function thumbprint(jwk: Record<string, unknown>): Promise<string> {
  const alg = Object.values(ALGORITHMS).find((a) => a.kty === jwk.kty && a.crv === jwk.crv);
  if (!alg) throw new Error("not an Ed25519 or P-256 key");
  return b64url(await sha256(canonicalBytes(Object.fromEntries(alg.members.map((m) => [m, jwk[m]])))));
}

const decode = (part: string): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fromB64url(part)));

/**
 * The DPoP proof in `header` for a `method` call to `url`, and with `accessToken` for any call but
 * the token endpoint's: checked, or why it isn't one (a line for the error, never the proof).
 */
export async function checkProof(header: string | null, method: string, url: string, nowS: number, o: { accessToken?: string; behind?: number } = {}): Promise<Proof | string> {
  const { accessToken, behind = PROOF_BEHIND } = o;
  if (header === null) return "a DPoP proof is needed: the DPoP header";
  const parts = header.split(".");
  if (header.length > MAX_PROOF || parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return "the DPoP header isn't one proof";
  const [head, body, signature] = parts as [string, string, string];
  let h: Record<string, unknown>, claims: Record<string, unknown>;
  try {
    h = decode(head) as Record<string, unknown>;
    claims = decode(body) as Record<string, unknown>;
  } catch {
    return "the DPoP proof is unreadable";
  }
  if (typeof h !== "object" || h === null || typeof claims !== "object" || claims === null) return "the DPoP proof is unreadable";
  if (h.typ !== "dpop+jwt") return "a DPoP proof's typ is dpop+jwt";
  const alg = typeof h.alg === "string" && Object.hasOwn(ALGORITHMS, h.alg) ? ALGORITHMS[h.alg]! : null;
  if (!alg) return "a DPoP proof is signed with EdDSA (Ed25519) or ES256";
  const jwk = h.jwk as Record<string, unknown> | undefined;
  if (typeof jwk !== "object" || jwk === null || jwk.kty !== alg.kty || jwk.crv !== alg.crv || "d" in jwk) return "a DPoP proof carries its public key, of its algorithm, as jwk";
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("jwk", Object.fromEntries(alg.members.map((m) => [m, jwk[m]])) as unknown as JsonWebKey, alg.importAs, false, ["verify"]);
  } catch {
    return "the DPoP proof's key isn't one";
  }
  if (!(await crypto.subtle.verify(alg.verifyAs, key, fromB64url(signature), utf8(`${head}.${body}`)))) return "the DPoP proof's signature doesn't verify";
  if (typeof claims.jti !== "string" || !/^[\x21-\x7e]{1,128}$/.test(claims.jti)) return "a DPoP proof has a jti";
  if (claims.htm !== method) return `the DPoP proof is for another method than ${method}`;
  if (typeof claims.htu !== "string") return "a DPoP proof's htu is a URL";
  let htu: URL;
  try {
    htu = new URL(claims.htu);
  } catch {
    return "the DPoP proof's htu isn't a URL";
  }
  // A WebSocket's proof may name its ws: or wss: URL: it is the http: or https: one.
  if (htu.protocol === "ws:" || htu.protocol === "wss:") htu = new URL(htu.href.replace(/^ws/, "http"));
  const target = new URL(url);
  if (htu.origin !== target.origin || htu.pathname !== target.pathname) return "the DPoP proof is for another URL";
  if (typeof claims.iat !== "number" || !Number.isInteger(claims.iat) || claims.iat > nowS + PROOF_AHEAD || claims.iat < nowS - behind) return `a DPoP proof's iat is at most ${PROOF_AHEAD} seconds ahead of the Obysphere's clock and ${behind} behind it`;
  if (accessToken !== undefined && claims.ath !== b64url(await sha256(utf8(accessToken)))) return "the DPoP proof is for another access token (ath)";
  return { jkt: await thumbprint(jwk), jti: claims.jti, iat: claims.iat };
}
