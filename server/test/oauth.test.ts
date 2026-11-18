// The token exchange (spec/identity.md section 4): assertions, checks in order, scopes.

import { describe, expect, it } from "vitest";
import { FORM, JWT_TYPE, TOKEN_EXCHANGE, World, expectSchema, form, newKey, signJwt, team } from "./helpers";

const exchange = (w: World, params: Record<string, string>, headers: Record<string, string> = FORM) =>
  w.call("POST", "/v0.1/oauth/token", { raw: form(params), headers });

describe("owner tokens", () => {
  it("gives the admin `admin directory:read audit:read`, in canonical order whatever the assertion's order", async () => {
    const w = new World();
    await w.create();
    const r = await w.exchangeOwner("wellington", "audit:read admin directory:read admin");
    expect(r.status).toBe(200);
    expectSchema("tokenResponse", r.body);
    expect(r.body.scope).toBe("admin directory:read audit:read");
    expect(r.body.token_type).toBe("Bearer");
    expect(r.body.issued_token_type).toBe("urn:ietf:params:oauth:token-type:access_token");
    expect(r.body.access_token).toMatch(/^[A-Za-z0-9._~-]{32,512}$/);
    // Never past the assertion's exp (300 seconds).
    expect(r.body.expires_in).toBe(300);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  });

  it("never gives admin to an owner who isn't the Sphere's admin, and only directory:read and audit:read to owners", async () => {
    const w = await team();
    const r = await w.exchangeOwner("ernesto", "admin directory:read audit:read send:review_request");
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe("directory:read audit:read");
    const none = await w.exchangeOwner("ernesto", "admin reply");
    expect(none.status).toBe(400);
    expect(none.body.error).toBe("invalid_scope");
  });

  it("uses an owner's own assertion once", async () => {
    const w = new World();
    await w.create();
    const key = await w.ownerKey("wellington");
    const jwt = await signJwt({ iss: "wellington", sub: "wellington", aud: "obi-sphere:e2e", iat: w.clock.s, exp: w.clock.s + 300, jti: crypto.randomUUID(), scope: "admin" }, key);
    const params = { grant_type: TOKEN_EXCHANGE, subject_token: jwt, subject_token_type: JWT_TYPE };
    expect((await exchange(w, params)).status).toBe(200);
    const again = await exchange(w, params);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("invalid_grant");
  });

  it("refuses an own assertion that lives over 300 seconds, is expired or issued in the future", async () => {
    const w = new World();
    await w.create();
    for (const extra of [{ exp: w.clock.s + 301 }, { iat: w.clock.s - 400, exp: w.clock.s - 100 }, { iat: w.clock.s + 301, exp: w.clock.s + 500 }, { exp: w.clock.s }]) {
      const r = await w.exchangeOwner("wellington", "admin", extra);
      expect(r.status, JSON.stringify(extra)).toBe(400);
      expect(r.body.error).toBe("invalid_grant");
    }
    // 300 seconds of skew on iat is allowed.
    expect((await w.exchangeOwner("wellington", "admin", { iat: w.clock.s + 300, exp: w.clock.s + 400 })).status).toBe(200);
  });

  it("refuses an assertion not signed by the owner's bound key", async () => {
    const w = new World();
    await w.create();
    const other = await newKey();
    const jwt = await signJwt({ iss: "wellington", sub: "wellington", aud: "obi-sphere:e2e", iat: w.clock.s, exp: w.clock.s + 60, jti: crypto.randomUUID(), scope: "admin" }, other);
    const r = await exchange(w, { grant_type: TOKEN_EXCHANGE, subject_token: jwt, subject_token_type: JWT_TYPE });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_grant");
    // An owner the Sphere never bound.
    const stranger = await w.exchangeOwner("stranger", "directory:read");
    expect(stranger.body.error).toBe("invalid_grant");
  });

  it("refuses a delegation (may_act) without an actor", async () => {
    const w = await team();
    const r = await exchange(w, { grant_type: TOKEN_EXCHANGE, subject_token: await w.delegation("obi-ernesto"), subject_token_type: JWT_TYPE });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_grant");
  });
});

describe("the request's form", () => {
  it("answers unsupported_grant_type for another grant, invalid_request for a malformed request", async () => {
    const w = new World();
    await w.create();
    const key = await w.ownerKey("wellington");
    const jwt = await signJwt({ iss: "wellington", sub: "wellington", aud: "obi-sphere:e2e", iat: w.clock.s, exp: w.clock.s + 60, jti: crypto.randomUUID(), scope: "admin" }, key);
    const good = { grant_type: TOKEN_EXCHANGE, subject_token: jwt, subject_token_type: JWT_TYPE };
    expect((await exchange(w, { ...good, grant_type: "client_credentials" })).body.error).toBe("unsupported_grant_type");
    const cases: [string, string, Record<string, string>?][] = [
      ["missing grant_type", form({ subject_token: jwt, subject_token_type: JWT_TYPE })],
      ["missing subject_token", form({ grant_type: TOKEN_EXCHANGE, subject_token_type: JWT_TYPE })],
      ["wrong subject_token_type", form({ ...good, subject_token_type: "urn:ietf:params:oauth:token-type:access_token" })],
      ["unknown parameter", form({ ...good, audience: "x" })],
      ["repeated parameter", form(good) + "&scope=admin&scope=admin"],
      ["actor_token without its type", form({ ...good, actor_token: jwt })],
      ["actor_token_type without the token", form({ ...good, actor_token_type: JWT_TYPE })],
      ["not a JWT", form({ ...good, subject_token: "abc.def" })],
      ["a JWT with another header", form({ ...good, subject_token: jwt.replace(/^[^.]+/, btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })).replace(/=+$/, "")) })],
      ["another Sphere", form({ ...good, subject_token: await signJwt({ iss: "wellington", sub: "wellington", aud: "obi-sphere:nope", iat: w.clock.s, exp: w.clock.s + 60, jti: crypto.randomUUID(), scope: "admin" }, key) })],
      ["claims outside the schema", form({ ...good, subject_token: await signJwt({ iss: "wellington", sub: "wellington", aud: "obi-sphere:e2e", iat: w.clock.s, exp: w.clock.s + 60, jti: crypto.randomUUID(), scope: "admin", prompt: "x" }, key) })],
      ["JSON, not a form", JSON.stringify(good), { "Content-Type": "application/json" }],
    ];
    for (const [what, raw, headers] of cases) {
      const r = await w.call("POST", "/v0.1/oauth/token", { raw, headers: headers ?? FORM });
      expect(r.status, what).toBe(400);
      expect(r.body.error, what).toBe("invalid_request");
      expect(typeof r.body.error_description).toBe("string");
    }
  });

  it("answers invalid_scope for a scope it doesn't know", async () => {
    const w = new World();
    await w.create();
    expect((await w.exchangeOwner("wellington", "admin root")).body.error).toBe("invalid_scope");
    const key = await w.ownerKey("wellington");
    const jwt = await signJwt({ iss: "wellington", sub: "wellington", aud: "obi-sphere:e2e", iat: w.clock.s, exp: w.clock.s + 60, jti: crypto.randomUUID(), scope: "admin" }, key);
    expect((await exchange(w, { grant_type: TOKEN_EXCHANGE, subject_token: jwt, subject_token_type: JWT_TYPE, scope: "admin everything" })).body.error).toBe("invalid_scope");
  });
});

describe("Obi tokens (on behalf of the owner)", () => {
  it("gives what the delegation grants, never admin, in canonical order", async () => {
    const w = await team();
    const r = await w.exchangeObi("obi-ernesto", { delegation: await w.delegation("obi-ernesto", "audit:read directory:read receive reply send:review_request admin") });
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe("send:review_request reply receive directory:read audit:read");
    expect(r.body.expires_in).toBe(3600);
  });

  it("narrows to the scope asked for", async () => {
    const w = await team();
    const r = await w.exchangeObi("obi-ernesto", { scope: "receive" });
    expect(r.body.scope).toBe("receive");
    expect((await w.exchangeObi("obi-ernesto", { scope: "admin" })).body.error).toBe("invalid_scope");
  });

  it("never lives past the delegation's exp", async () => {
    const w = await team();
    const r = await w.exchangeObi("obi-ernesto", { delegation: await w.delegation("obi-ernesto", undefined, 1000) });
    expect(r.body.expires_in).toBe(1000);
  });

  it("refuses a delegation that lives over 2,592,000 seconds", async () => {
    const w = await team();
    expect((await w.exchangeObi("obi-ernesto", { delegation: await w.delegation("obi-ernesto", undefined, 2592001) })).body.error).toBe("invalid_grant");
    expect((await w.exchangeObi("obi-ernesto", { delegation: await w.delegation("obi-ernesto", undefined, 2592000) })).status).toBe(200);
  });

  it("presents the same delegation many times, but each actor assertion once", async () => {
    const w = await team();
    const delegation = await w.delegation("obi-ernesto");
    const actor = await w.actorAssertion("obi-ernesto");
    expect((await w.exchangeObi("obi-ernesto", { delegation, actor })).status).toBe(200);
    expect((await w.exchangeObi("obi-ernesto", { delegation })).status).toBe(200);
    const replay = await w.exchangeObi("obi-ernesto", { delegation, actor });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
  });

  it("refuses an actor the owner didn't name, one signed by another key, or one that lives too long", async () => {
    const w = await team();
    // ernesto's delegation names obi-ernesto; obi-wellington presents it.
    expect((await w.exchangeObi("obi-wellington", { delegation: await w.delegation("obi-ernesto") })).body.error).toBe("invalid_grant");
    // Signed by a key that isn't the Obi's current one.
    expect((await w.exchangeObi("obi-ernesto", { actor: await w.actorAssertion("obi-ernesto", await newKey()) })).body.error).toBe("invalid_grant");
    // Signed by the owner's key instead of the Obi's.
    expect((await w.exchangeObi("obi-ernesto", { actor: await w.actorAssertion("obi-ernesto", await w.ownerKey("ernesto")) })).body.error).toBe("invalid_grant");
    expect((await w.exchangeObi("obi-ernesto", { actor: await w.actorAssertion("obi-ernesto", undefined, { exp: w.clock.s + 301 }) })).body.error).toBe("invalid_grant");
    // An Obi owned by another owner than the delegation's.
    const key = await w.ownerKey("wellington");
    const foreign = await signJwt({ iss: "wellington", sub: "wellington", aud: "obi-sphere:e2e", iat: w.clock.s, exp: w.clock.s + 600, jti: crypto.randomUUID(), scope: "reply", may_act: { sub: "obi-ernesto" } }, key);
    expect((await w.exchangeObi("obi-ernesto", { delegation: foreign })).body.error).toBe("invalid_grant");
  });

  it("refuses a revoked Obi, and its tokens stop working", async () => {
    const w = await team();
    const token = await w.obiToken("obi-ernesto");
    expect((await w.call("GET", "/v0.1/spheres/e2e/members", { token })).status).toBe(200);
    const revoked = await w.call("DELETE", "/v0.1/spheres/e2e/members/obi-ernesto", { token: await w.ownerToken() });
    expect(revoked.status).toBe(200);
    expect((await w.call("GET", "/v0.1/spheres/e2e/members", { token })).status).toBe(401);
    expect((await w.exchangeObi("obi-ernesto")).body.error).toBe("invalid_grant");
  });

  it("says obi_error not_member, beside invalid_grant, for an Obi that was removed or never joined", async () => {
    const w = await team();
    // Revoked by the admin: the same error and description as before, and the reason a client acts on.
    expect((await w.call("DELETE", "/v0.1/spheres/e2e/members/obi-ernesto", { token: await w.ownerToken() })).status).toBe(200);
    const removed = await w.exchangeObi("obi-ernesto");
    expect(removed.status).toBe(400);
    expect(removed.body).toEqual({ error: "invalid_grant", error_description: "the actor is not an active member owned by the subject", obi_error: "not_member" });
    // Never joined: ernesto's own key delegates to an Obi this Sphere doesn't know.
    const ownerKey = await w.ownerKey("ernesto");
    const ghostKey = await newKey();
    const delegation = await signJwt({ iss: "ernesto", sub: "ernesto", aud: "obi-sphere:e2e", iat: w.clock.s, exp: w.clock.s + 600, jti: crypto.randomUUID(), scope: "reply", may_act: { sub: "obi-ghost" } }, ownerKey);
    const ghost = await w.exchangeObi("obi-ghost", { delegation, actor: await w.actorAssertion("obi-ghost", ghostKey) });
    expect(ghost.body).toMatchObject({ error: "invalid_grant", obi_error: "not_member" });
  });

  it("leaves obi_error out of every other refusal", async () => {
    const w = await team();
    // An active Obi of another owner than the delegation's: the delegation's fault, not a lost membership.
    const key = await w.ownerKey("wellington");
    const foreign = await signJwt({ iss: "wellington", sub: "wellington", aud: "obi-sphere:e2e", iat: w.clock.s, exp: w.clock.s + 600, jti: crypto.randomUUID(), scope: "reply", may_act: { sub: "obi-ernesto" } }, key);
    const other = await w.exchangeObi("obi-ernesto", { delegation: foreign });
    expect(other.body.error).toBe("invalid_grant");
    expect(other.body).not.toHaveProperty("obi_error");
    // A member signing with a key that isn't its current one.
    const wrongKey = await w.exchangeObi("obi-ernesto", { actor: await w.actorAssertion("obi-ernesto", await newKey()) });
    expect(wrongKey.body.error).toBe("invalid_grant");
    expect(wrongKey.body).not.toHaveProperty("obi_error");
  });

  it("tokens expire", async () => {
    const w = await team();
    const token = await w.obiToken("obi-ernesto");
    w.clock.advance(3599);
    expect((await w.call("GET", "/v0.1/spheres/e2e/members", { token })).status).toBe(200);
    w.clock.advance(1);
    const r = await w.call("GET", "/v0.1/spheres/e2e/members", { token });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("unauthorized");
  });
});
