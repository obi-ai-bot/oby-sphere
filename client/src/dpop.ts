// Tokens bound to a key (spec/identity.md section 4.6, DPoP, RFC 9449): a key this client makes and
// keeps for itself, and a proof signed with it for each request, so that a token copied out of a
// log or a store opens nothing alone. Used only with an Obysphere that lists `dpop` in
// `GET /v0.1/features`; a client that sends no proof gets a bearer token, as before.

import { SigningKey, b64url, sha256 } from "./crypto.ts";
import { canonicalBytes, utf8 } from "./json.ts";

export class DpopKey {
  readonly #key: SigningKey;

  private constructor(key: SigningKey) {
    this.#key = key;
  }

  /** A new Ed25519 key for proofs: never an owner's key nor the member's signing key. */
  static async generate(): Promise<DpopKey> {
    return new DpopKey(await SigningKey.generate());
  }

  /** Its public key as the proof's header carries it: `{kty, crv, x}`, never the private part. */
  get jwk(): { kty: "OKP"; crv: "Ed25519"; x: string } {
    return { kty: "OKP", crv: "Ed25519", x: this.#key.publicKey };
  }

  /**
   * A proof for one request: `htm` its method, `htu` its URL (origin and path; a query doesn't
   * count), and, on any call but the token endpoint's, `ath` the SHA-256 of the access token.
   */
  async proof(method: string, url: string, accessToken?: string): Promise<string> {
    const u = new URL(url);
    const claims: Record<string, unknown> = { jti: crypto.randomUUID(), htm: method.toUpperCase(), htu: `${u.origin}${u.pathname}`, iat: Math.floor(Date.now() / 1000) };
    if (accessToken !== undefined) claims.ath = b64url(await sha256(utf8(accessToken)));
    const head = b64url(canonicalBytes({ typ: "dpop+jwt", alg: "EdDSA", jwk: this.jwk }));
    const body = b64url(canonicalBytes(claims));
    return `${head}.${body}.${await this.#key.sign(utf8(`${head}.${body}`))}`;
  }
}
