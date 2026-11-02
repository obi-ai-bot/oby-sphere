// Binding to the server (identity.md sections 4.1 and 4.6): assertions that name the server's URL,
// and tokens bound to a key of this process (DPoP), only with an Obysphere that lists them; and a
// sign-in's return_to (sphere-api.md section 3.1).

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DpopKey, Member, Owner, SigningKey, SphereApi, SphereError, b64url, fromB64url, keyIdOf, parseJwt, serverAudience, sha256, utf8, verifyEd25519 } from "../src/index.ts";

const BASE = "https://sphere.example.com";
const SPHERE = "team";

function decodeJwt(jwt: string) {
  const [h, c] = jwt.split(".") as [string, string, string];
  return { header: JSON.parse(new TextDecoder().decode(fromB64url(h))), claims: JSON.parse(new TextDecoder().decode(fromB64url(c))) };
}

test("a DPoP proof is a dpop+jwt signed by its key, for one method and URL, with the token's hash", async () => {
  const key = await DpopKey.generate();
  const proof = await key.proof("post", "https://sphere.example.com/v0.1/spheres/team/messages?x=1", "tok-123");
  const { header, claims } = decodeJwt(proof);
  assert.deepEqual(header, { alg: "EdDSA", jwk: key.jwk, typ: "dpop+jwt" });
  assert.equal(claims.htm, "POST");
  assert.equal(claims.htu, "https://sphere.example.com/v0.1/spheres/team/messages");
  assert.equal(claims.ath, b64url(await sha256(utf8("tok-123"))));
  assert.ok(Number.isInteger(claims.iat) && typeof claims.jti === "string");
  const [h, c, s] = proof.split(".") as [string, string, string];
  assert.ok(await verifyEd25519(key.jwk.x, utf8(`${h}.${c}`), s));
  assert.ok(!JSON.stringify(header).includes('"d"'));
  const other = await key.proof("POST", "https://sphere.example.com/v0.1/oauth/token");
  assert.equal(decodeJwt(other).claims.ath, undefined);
  assert.notEqual(decodeJwt(other).claims.jti, claims.jti);
});

async function fake(features: string[]) {
  const seen: { path: string; headers: Record<string, string>; body: string }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const p = new URL(url).pathname;
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    seen.push({ path: p, headers, body: String(init.body ?? "") });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (p === "/v0.1/features") return json(200, { features });
    if (p === "/v0.1/oauth/token") return json(200, { access_token: "t".repeat(40), issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: headers.DPoP ? "DPoP" : "Bearer", expires_in: 3600, scope: "receive" });
    if (p.endsWith("/deliveries")) return json(200, { deliveries: [] });
    if (p === "/v0.1/signin/google") return json(201, { url: "https://accounts.example.com/auth?x=1", state: "s".repeat(43) });
    return json(404, { error: { code: "not_found", message: "no" } });
  };
  const owner = await Owner.generate("ada");
  const key = await SigningKey.generate();
  // As join makes it: bound to the server when the server takes that.
  const delegation = await owner.delegation(SPHERE, "ada-agent", features.includes("sphere_url_aud") ? { aud: serverAudience(BASE, SPHERE) } : {});
  const m = new Member({ api: new SphereApi(BASE, { fetch }), sphere: SPHERE, obi: "ada-agent", owner: "ada", key, delegation });
  return { m, seen, fetch };
}

test("with sphere_url_aud and dpop, the actor assertion names the server and the token is bound to a key", async () => {
  const { m, seen } = await fake(["dpop", "sphere_url_aud"]);
  await m.receive();
  const token = seen.find((s) => s.path === "/v0.1/oauth/token")!;
  const actor = new URLSearchParams(token.body).get("actor_token")!;
  assert.equal(parseJwt(actor)!.claims.aud, `${BASE}/v0.1/spheres/${SPHERE}`);
  assert.equal(decodeJwt(token.headers.DPoP!).claims.htu, `${BASE}/v0.1/oauth/token`);
  const call = seen.find((s) => s.path.endsWith("/deliveries"))!;
  assert.equal(call.headers.Authorization, `DPoP ${"t".repeat(40)}`);
  assert.equal(decodeJwt(call.headers.DPoP!).claims.ath, b64url(await sha256(utf8("t".repeat(40)))));
});

test("without them, the assertion names the Sphere alone and the token stays a bearer token", async () => {
  const { m, seen } = await fake([]);
  await m.receive();
  const token = seen.find((s) => s.path === "/v0.1/oauth/token")!;
  assert.equal(parseJwt(new URLSearchParams(token.body).get("actor_token")!)!.claims.aud, `obi-sphere:${SPHERE}`);
  assert.equal(token.headers.DPoP, undefined);
  assert.equal(seen.find((s) => s.path.endsWith("/deliveries"))!.headers.Authorization, `Bearer ${"t".repeat(40)}`);
});

test("a delegation can name the server, and a sign-in carries return_to", async () => {
  const owner = await Owner.generate("ada");
  const d = await owner.delegation(SPHERE, "ada-agent", { aud: `${BASE}/v0.1/spheres/${SPHERE}` });
  assert.equal(parseJwt(d)!.claims.aud, `${BASE}/v0.1/spheres/${SPHERE}`);
  const { fetch, seen } = await fake(["signin_providers"]);
  const api = new SphereApi(BASE, { fetch });
  const started = await api.signinStart("google", owner.key.publicKey, "http://127.0.0.1:41234/signin");
  assert.equal(started.state.length, 43);
  assert.deepEqual(JSON.parse(seen.at(-1)!.body), { owner_key: owner.key.publicKey, return_to: "http://127.0.0.1:41234/signin" });
  await assert.rejects(api.signinStart("Google!", owner.key.publicKey));
});

test("calls that overlap at the start share one DPoP key, and every proof is signed with the token's key", async () => {
  const { m, seen } = await fake(["dpop", "sphere_url_aud"]);
  await Promise.all([m.receive(), m.receive(), m.directory().catch(() => {})]);
  const keys = new Set(seen.filter((s) => s.headers.DPoP).map((s) => decodeJwt(s.headers.DPoP!).header.jwk.x));
  assert.equal(keys.size, 1);
  const token = "t".repeat(40);
  const headers = await m.api.authHeaders("GET", `${BASE}/v0.1/spheres/${SPHERE}/channels/x`, token);
  assert.equal(headers.Authorization, `DPoP ${token}`);
  assert.equal(decodeJwt(headers.DPoP!).header.jwk.x, [...keys][0]);
  assert.deepEqual(await m.api.authHeaders("GET", `${BASE}/x`, "another-token"), { Authorization: "Bearer another-token" });
});

test("join binds the delegation to the server it lists sphere_url_aud on, and nothing after the redeem throws", async () => {
  // features: listed, not listed, a 404 (an older server), a 503, or the call dropped. The token endpoint fails throughout: join never reaches it.
  for (const features of [["sphere_url_aud"], [], 404, 503, null] as const) {
    let exchanges = 0;
    let redeemed = false;
    const fetch = async (url: string, init: RequestInit) => {
      const p = new URL(url).pathname;
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
      if (p === "/v0.1/features") {
        if (features === null) throw new TypeError("fetch failed");
        if (typeof features === "number") return json(features, { error: { code: "not_found", message: "no" } });
        return json(200, { features });
      }
      if (p.endsWith("/redeem")) {
        redeemed = true;
        const body = JSON.parse(String(init.body));
        const params = body.card.capabilities.extensions[0].params;
        return json(201, {
          obi: "ada-agent", owner: "ada", owner_key: body.owner_key, owner_key_id: await keyIdOf(body.owner_key), status: "active", joined_at: "2026-10-28T00:00:00Z", card: body.card,
          keys: [{ key_id: params.key_id, public_key: params.public_key, valid_from_seq: 1, valid_until_seq: null }],
        });
      }
      if (p === "/v0.1/oauth/token") {
        exchanges++;
        throw new TypeError("fetch failed");
      }
      return json(404, { error: { code: "not_found", message: "no" } });
    };
    const owner = await Owner.generate("ada");
    const link = `${BASE}/join#sphere=${SPHERE}&id=9187a87a-3126-424c-8861-8811bba1a5ec&secret=${"A".repeat(43)}`;
    const joining = Member.join({ link, owner, obi: "ada-agent", key: await SigningKey.generate(), accepts: ["question"], name: "A", description: "a", version: "0.1.0", fetch });
    if (features === null || features === 503) {
      // Not knowing what the server takes, join stops before the redeem binds anything.
      await assert.rejects(joining, (e) => e instanceof SphereError && e.status === (features ?? 0));
      assert.equal(redeemed, false);
      continue;
    }
    const m = await joining;
    assert.equal(parseJwt(m.delegation)!.claims.aud, Array.isArray(features) && features.length ? serverAudience(BASE, SPHERE) : `obi-sphere:${SPHERE}`, `features: ${JSON.stringify(features)}`);
    assert.equal(exchanges, 0);
  }
});
