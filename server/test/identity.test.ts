// Tokens bound to a key (DPoP, spec/identity.md section 4.6), and assertions bound to one server
// (an `aud` that is the Obysphere's own URL, section 4.1).

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { checkProof, thumbprint } from "../src/dpop";
import { b64url, sha256 } from "../src/protocol/crypto";
import { utf8 } from "../src/protocol/json";
import { BASE, FORM, JWT_TYPE, TOKEN_EXCHANGE, World, expectSchema, form, makeCall, signJwt, team } from "./helpers";

/** A client's DPoP key, made for this test: Ed25519 or P-256. */
async function dpopKey(alg: "EdDSA" | "ES256" = "EdDSA") {
  const pair = (await crypto.subtle.generateKey(alg === "EdDSA" ? { name: "Ed25519" } : { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const { kty, crv, x, y } = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const jwk = alg === "EdDSA" ? { kty, crv, x } : { kty, crv, x, y };
  /** A proof for a `method` call to `url` (and `token`, past the token endpoint); `o` changes what it says. */
  const proof = async (method: string, url: string, token?: string, o: { claims?: Record<string, unknown>; header?: Record<string, unknown>; signer?: CryptoKey } = {}) => {
    const header = { typ: "dpop+jwt", alg, jwk, ...o.header };
    const claims = { jti: crypto.randomUUID(), htm: method, htu: url, iat: Math.floor(Date.parse("2026-10-14T12:00:00Z") / 1000), ...(token ? { ath: b64url(await sha256(utf8(token))) } : {}), ...o.claims };
    const input = `${b64url(utf8(JSON.stringify(header)))}.${b64url(utf8(JSON.stringify(claims)))}`;
    const sig = await crypto.subtle.sign(alg === "EdDSA" ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" }, o.signer ?? pair.privateKey, utf8(input));
    return `${input}.${b64url(new Uint8Array(sig))}`;
  };
  return { jwk, proof, jkt: await thumbprint(jwk), privateKey: pair.privateKey };
}

const TOKEN_URL = `${BASE}/v0.1/oauth/token`;

/** The admin's own token, bound to `key` with a proof at the token endpoint. */
async function boundOwnerToken(w: World, key: Awaited<ReturnType<typeof dpopKey>>, proof?: string) {
  const owner = await w.ownerKey("wellington");
  const claims = { iss: "wellington", sub: "wellington", aud: `obi-sphere:${w.sphere}`, iat: w.clock.s, exp: w.clock.s + 300, jti: crypto.randomUUID(), scope: "admin directory:read audit:read" };
  return w.call("POST", "/v0.1/oauth/token", {
    raw: form({ grant_type: TOKEN_EXCHANGE, subject_token: await signJwt(claims, owner), subject_token_type: JWT_TYPE }),
    headers: { ...FORM, DPoP: proof ?? (await key.proof("POST", TOKEN_URL)) },
  });
}

describe("tokens bound to a key (DPoP)", () => {
  it("binds a token to the proof's key, and takes it only with a new proof from that key", async () => {
    for (const alg of ["EdDSA", "ES256"] as const) {
      const w = new World(`e2e-${alg.toLowerCase()}`);
      await w.create();
      const key = await dpopKey(alg);
      const issued = await boundOwnerToken(w, key);
      expect(issued.status, JSON.stringify(issued.body)).toBe(200);
      expectSchema("tokenResponse", issued.body);
      expect(issued.body.token_type).toBe("DPoP");
      const token = issued.body.access_token as string;
      expect(await env.DB.prepare("SELECT jkt FROM tokens WHERE jkt IS NOT NULL ORDER BY rowid DESC LIMIT 1").first()).toEqual({ jkt: key.jkt });
      const url = `${BASE}/v0.1/spheres/${w.sphere}`;
      const get = (headers: Record<string, string>) => w.call("GET", `/v0.1/spheres/${w.sphere}`, { headers });
      expect((await get({ Authorization: `DPoP ${token}`, DPoP: await key.proof("GET", url, token) })).status, alg).toBe(200);
      // Alone, as a bearer token, it opens nothing.
      expect((await get({ Authorization: `Bearer ${token}` })).status).toBe(401);
      expect((await get({ Authorization: `DPoP ${token}` })).status).toBe(401);
      // Nor with a proof for another call, another token, another key, or from too long ago.
      const other = await dpopKey(alg);
      for (const [why, proof] of [
        ["another method", await key.proof("DELETE", url, token)],
        ["another URL", await key.proof("GET", `${BASE}/v0.1/spheres/other`, token)],
        ["another server", await key.proof("GET", `https://elsewhere.example/v0.1/spheres/${w.sphere}`, token)],
        ["another token", await key.proof("GET", url, "a".repeat(43))],
        ["no ath", await key.proof("GET", url)],
        ["another key", await other.proof("GET", url, token)],
        ["an old iat", await key.proof("GET", url, token, { claims: { iat: w.clock.s - 301 } })],
        ["a private key in jwk", await key.proof("GET", url, token, { header: { jwk: { ...key.jwk, d: "AAAA" } } })],
        ["typ JWT", await key.proof("GET", url, token, { header: { typ: "JWT" } })],
      ] as const) {
        const r = await get({ Authorization: `DPoP ${token}`, DPoP: proof });
        expect(r.status, `${alg}: ${why}`).toBe(401);
        expect(r.body.error.code).toBe("unauthorized");
      }
    }
  });

  it("gives one token per proof, and refuses a proof that doesn't pass with invalid_dpop_proof", async () => {
    const w = new World();
    await w.create();
    const key = await dpopKey();
    const proof = await key.proof("POST", TOKEN_URL);
    expect((await boundOwnerToken(w, key, proof)).status).toBe(200);
    const again = await boundOwnerToken(w, key, proof);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("invalid_dpop_proof");
    for (const bad of [await key.proof("GET", TOKEN_URL), await key.proof("POST", `${BASE}/v0.1/oauth/other`), await key.proof("POST", TOKEN_URL, undefined, { header: { alg: "RS256" } }), "not.a.proof"]) {
      const r = await boundOwnerToken(w, key, bad);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_dpop_proof");
    }
  });

  it("keeps bearer tokens as they were, and refuses one sent as DPoP", async () => {
    const w = new World();
    await w.create();
    const token = await w.ownerToken();
    expect((await w.call("GET", "/v0.1/spheres/e2e", { token })).status).toBe(200);
    expect((await w.call("GET", "/v0.1/spheres/e2e", { headers: { Authorization: `DPoP ${token}` } })).status).toBe(401);
  });

  it("binds an agent's token too, and its phone relay takes it with a proof", async () => {
    const w = await team();
    const key = await dpopKey();
    const r = await w.call("POST", "/v0.1/oauth/token", {
      raw: form({ grant_type: TOKEN_EXCHANGE, subject_token: await w.delegation("obi-wellington"), subject_token_type: JWT_TYPE, actor_token: await w.actorAssertion("obi-wellington"), actor_token_type: JWT_TYPE }),
      headers: { ...FORM, DPoP: await key.proof("POST", TOKEN_URL) },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const token = r.body.access_token as string;
    const relay = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const path = `/v0.1/relay/${relay}`;
    expect((await w.call("PUT", path, { headers: { Authorization: `DPoP ${token}`, DPoP: await key.proof("PUT", BASE + path, token) } })).status).toBe(201);
    expect((await w.call("PUT", path, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it("refuses a proof whose signature isn't its key's, one from too far ahead or too long ago, and answers with the challenge", async () => {
    const w = new World();
    await w.create();
    const key = await dpopKey();
    const token = (await boundOwnerToken(w, key)).body.access_token as string;
    const url = `${BASE}/v0.1/spheres/e2e`;
    const other = await dpopKey();
    for (const [why, proof] of [
      ["signed by another key, showing this one", await key.proof("GET", url, token, { signer: other.privateKey })],
      ["61 seconds ahead", await key.proof("GET", url, token, { claims: { iat: w.clock.s + 61 } })],
      ["121 seconds old", await key.proof("GET", url, token, { claims: { iat: w.clock.s - 121 } })],
    ] as const) {
      const r = await w.call("GET", "/v0.1/spheres/e2e", { headers: { Authorization: `DPoP ${token}`, DPoP: proof } });
      expect(r.status, why).toBe(401);
      expect(r.headers.get("WWW-Authenticate"), why).toBe('DPoP error="invalid_dpop_proof", algs="EdDSA ES256"');
    }
    expect((await w.call("GET", "/v0.1/spheres/e2e", { headers: { Authorization: `Bearer ${token}` } })).headers.get("WWW-Authenticate")).toBe('DPoP error="invalid_token", algs="EdDSA ES256"');
    // At the token endpoint a proof may be up to 300 seconds old.
    expect((await boundOwnerToken(w, key, await key.proof("POST", TOKEN_URL, undefined, { claims: { iat: w.clock.s - 299 } }))).status).toBe(200);
  });

  it("takes a proof once on a call that changes something, and on a socket's upgrade, which may name its ws: or wss: URL", async () => {
    const w = await team();
    const key = await dpopKey();
    const r = await w.call("POST", "/v0.1/oauth/token", {
      raw: form({ grant_type: TOKEN_EXCHANGE, subject_token: await w.delegation("obi-wellington"), subject_token_type: JWT_TYPE, actor_token: await w.actorAssertion("obi-wellington"), actor_token_type: JWT_TYPE }),
      headers: { ...FORM, DPoP: await key.proof("POST", TOKEN_URL) },
    });
    const token = r.body.access_token as string;
    const relay = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const path = `/v0.1/relay/${relay}`;
    const put = await key.proof("PUT", BASE + path, token);
    expect((await w.call("PUT", path, { headers: { Authorization: `DPoP ${token}`, DPoP: put } })).status).toBe(201);
    const again = await w.call("PUT", path, { headers: { Authorization: `DPoP ${token}`, DPoP: put } });
    expect(again.status).toBe(401);
    expect(again.body.error.message).toContain("used before");
    // A GET's proof isn't remembered: the same one reads again within its window (identity.md 4.6).
    const get = await key.proof("GET", `${BASE}/v0.1/spheres/e2e/members`, token);
    for (let i = 0; i < 2; i++) expect((await w.call("GET", "/v0.1/spheres/e2e/members", { headers: { Authorization: `DPoP ${token}`, DPoP: get } })).status).toBe(200);
    // The relay socket's upgrade, its proof naming the socket's ws: URL (wss: on an https server), and once only.
    const wss = await key.proof("GET", `ws://sphere.test${path}`, token);
    const open = () => handle(new Request(BASE + path, { headers: { Authorization: `DPoP ${token}`, DPoP: wss, Upgrade: "websocket" } }), env, { now: w.clock.now });
    const socket = await open();
    expect(socket.status).toBe(101);
    socket.webSocket?.accept();
    socket.webSocket?.close(1000);
    expect((await open()).status).toBe(401);
  });
});

describe("a proof's htu", () => {
  it("names a socket's wss: URL for its https: one, and the same origin and path after parsing", async () => {
    const key = await dpopKey();
    const now = Math.floor(Date.parse("2026-10-14T12:00:00Z") / 1000);
    const target = "https://sphere.example.com/v0.1/relay/abc";
    for (const htu of ["wss://sphere.example.com/v0.1/relay/abc", "https://SPHERE.example.com:443/v0.1/relay/abc?x=1", "https://sphere.example.com/v0.1/relay/abc#f"]) {
      expect(typeof (await checkProof(await key.proof("GET", htu), "GET", target, now)), htu).toBe("object");
    }
    for (const htu of ["ws://sphere.example.com/v0.1/relay/abc", "https://sphere.example.com/v0.1/relay/abc/", "https://sphere.example.com:8443/v0.1/relay/abc"]) {
      expect(typeof (await checkProof(await key.proof("GET", htu), "GET", target, now)), htu).toBe("string");
    }
  });
});

describe("DPoP's edges", () => {
  it("gives RFC 8037's thumbprint for its example key", async () => {
    expect(await thumbprint({ crv: "Ed25519", kty: "OKP", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" })).toBe("kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
  });

  it("refuses an htu that isn't a string, and takes the scheme in any case", async () => {
    const key = await dpopKey();
    const now = Math.floor(Date.parse("2026-10-14T12:00:00Z") / 1000);
    expect(typeof (await checkProof(await key.proof("GET", ["https://sphere.example.com/x"] as never), "GET", "https://sphere.example.com/x", now))).toBe("string");
    const w = new World();
    await w.create();
    const token = await w.ownerToken();
    expect((await w.call("GET", "/v0.1/spheres/e2e", { headers: { Authorization: `bearer ${token}` } })).status).toBe(200);
    expect((await w.call("GET", "/v0.1/spheres/e2e", { headers: {} })).headers.get("WWW-Authenticate")).toBe('Bearer, DPoP algs="EdDSA ES256"');
  });

  it("takes no proof, and lists neither dpop nor sphere_url_aud, where the server doesn't know its own address", async () => {
    const w = new World();
    await w.create();
    const unknown = makeCall(w.clock, { ...env, SPHERE_URL: "" } as never);
    const listed = (await unknown("GET", "/v0.1/features")).body.features as string[];
    expect(listed).not.toContain("dpop");
    expect(listed).not.toContain("sphere_url_aud");
    expect(listed).toContain("signin_providers");
    const key = await dpopKey();
    const owner = await w.ownerKey("wellington");
    const claims = { iss: "wellington", sub: "wellington", aud: "obi-sphere:e2e", iat: w.clock.s, exp: w.clock.s + 300, jti: crypto.randomUUID(), scope: "admin" };
    // The token endpoint ignores the proof (RFC 9449 section 5) and issues a bearer token.
    const r = await unknown("POST", "/v0.1/oauth/token", { raw: form({ grant_type: TOKEN_EXCHANGE, subject_token: await signJwt(claims, owner), subject_token_type: JWT_TYPE }), headers: { ...FORM, DPoP: await key.proof("POST", TOKEN_URL) } });
    expect(r.status).toBe(200);
    expect(r.body.token_type).toBe("Bearer");
    // A token bound while the server knew its address works nowhere once it doesn't.
    const bound = (await boundOwnerToken(w, key)).body.access_token as string;
    const refused = await unknown("GET", "/v0.1/spheres/e2e", { headers: { Authorization: `DPoP ${bound}`, DPoP: await key.proof("GET", `${BASE}/v0.1/spheres/e2e`, bound) } });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("WWW-Authenticate")).toContain('DPoP error="invalid_dpop_proof"');
    // A SPHERE_URL that isn't an http or https address is no address.
    const malformed = makeCall(w.clock, { ...env, SPHERE_URL: "localhost:8787" } as never);
    expect((await malformed("GET", "/v0.1/features")).body.features).not.toContain("dpop");
    expect((await malformed("GET", "/v0.1/spheres/e2e", { headers: {} })).headers.get("WWW-Authenticate")).toBe("Bearer");
  });
});

describe("assertions bound to one server", () => {
  it("takes the Obysphere's own URL as aud, and refuses another server's", async () => {
    const w = new World();
    await w.create();
    expect((await w.exchangeOwner("wellington", "admin", { aud: `${BASE}/v0.1/spheres/e2e` })).status).toBe(200);
    for (const aud of ["https://elsewhere.example/v0.1/spheres/e2e", "http://sphere.test:8080/v0.1/spheres/e2e", `${BASE}/v0.1/spheres/other`]) {
      const r = await w.exchangeOwner("wellington", "admin", { aud });
      expect(r.status, aud).toBe(400);
      expect(r.body.error, aud).toBe("invalid_request");
    }
    // A form the claims schema doesn't take.
    expect((await w.exchangeOwner("wellington", "admin", { aud: `${BASE}/v0.1/spheres/e2e/` })).body.error).toBe("invalid_request");
  });

  it("lets a delegation and an actor assertion name the Obysphere in either form, the same one", async () => {
    const w = await team();
    const url = `${BASE}/v0.1/spheres/e2e`;
    const mixed = await w.exchangeObi("obi-wellington", { actor: await w.actorAssertion("obi-wellington", undefined, { aud: url }) });
    expect(mixed.status, JSON.stringify(mixed.body)).toBe(200);
    const other = await w.exchangeObi("obi-wellington", { actor: await w.actorAssertion("obi-wellington", undefined, { aud: "https://elsewhere.example/v0.1/spheres/e2e" }) });
    expect(other.status).toBe(400);
    expect(other.body.error).toBe("invalid_request");
  });
  it("counts a default port as the same origin, never another scheme, and takes SPHERE_URL's origin when it is set", async () => {
    const w = new World();
    await w.create();
    expect((await w.exchangeOwner("wellington", "admin", { aud: "http://sphere.test:80/v0.1/spheres/e2e" })).status).toBe(200);
    expect((await w.exchangeOwner("wellington", "admin", { aud: "https://sphere.test/v0.1/spheres/e2e" })).body.error).toBe("invalid_request");
    // Configured: its own origin is SPHERE_URL's, whatever the request's Host says.
    const configured = makeCall(w.clock, { ...env, SPHERE_URL: "https://sphere.example.com" } as never);
    const exchange = async (call: typeof configured, aud: string) => {
      const key = await w.ownerKey("wellington");
      const claims = { iss: "wellington", sub: "wellington", aud, iat: w.clock.s, exp: w.clock.s + 300, jti: crypto.randomUUID(), scope: "admin" };
      return call("POST", "/v0.1/oauth/token", { raw: form({ grant_type: TOKEN_EXCHANGE, subject_token: await signJwt(claims, key), subject_token_type: JWT_TYPE }), headers: FORM });
    };
    expect((await exchange(configured, "https://sphere.example.com/v0.1/spheres/e2e")).status).toBe(200);
    expect((await exchange(configured, `${BASE}/v0.1/spheres/e2e`)).body.error).toBe("invalid_request");
    // Not known (the Node build without SPHERE_URL): the URL form names nothing, obi-sphere:<id> still works.
    const unknown = makeCall(w.clock, { ...env, SPHERE_URL: "" } as never);
    expect((await exchange(unknown, `${BASE}/v0.1/spheres/e2e`)).body.error).toBe("invalid_request");
    expect((await exchange(unknown, "obi-sphere:e2e")).status).toBe(200);
  });
});
