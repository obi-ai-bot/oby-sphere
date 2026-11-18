// Getting back in with a sign-in (spec/sphere-api.md section 3.2, `owner_rebind`): a new owner key
// for an owner who lost theirs, the old key's agents revoked, and the owner events.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { b64url } from "../src/protocol/crypto";
import { utf8 } from "../src/protocol/json";
import { BASE, GOOGLE_KEY, World, expectSchema, makeCard, newKey, team, type Key } from "./helpers";

async function idToken(claims: Record<string, unknown>): Promise<string> {
  const head = b64url(utf8(JSON.stringify({ alg: "RS256", kid: "test-google-key", typ: "JWT" })));
  const body = b64url(utf8(JSON.stringify(claims)));
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", GOOGLE_KEY.privateKey, utf8(`${head}.${body}`)));
  return `${head}.${body}.${b64url(signature)}`;
}

/** A finished Google sign-in for `key`, as account `sub` of Workspace `hd` (null: a personal account). */
async function signIn(w: World, key: Key, sub: string, hd: string | null = "example.com"): Promise<{ state: string; code: string }> {
  const start = await w.call("POST", "/v0.1/signin/google", { body: { owner_key: key.publicKey } });
  expect(start.status, JSON.stringify(start.body)).toBe(201);
  const nonce = new URL(start.body.url).searchParams.get("nonce");
  const token = await idToken({
    iss: "https://accounts.google.com", aud: env.GOOGLE_CLIENT_ID, sub, email: "someone@example.com", email_verified: true,
    ...(hd ? { hd } : {}), nonce, iat: w.clock.s, exp: w.clock.s + 3600,
  });
  const back = await w.call("POST", "/v0.1/signin/google/callback", {
    raw: new URLSearchParams({ state: start.body.state, id_token: token }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  expect(back.status).toBe(303);
  return { state: start.body.state, code: new URL(back.headers.get("Location")!).searchParams.get("code")! };
}

const rebind = (w: World, owner: string, body: Record<string, unknown>) => w.call("POST", `/v0.1/spheres/e2e/owners/${owner}/rebind`, { body });
const ownerRow = (owner: string) => env.DB.prepare("SELECT owner_key, account, admin FROM owners WHERE sphere = 'e2e' AND owner = ?1").bind(owner).first<{ owner_key: string; account: string | null; admin: number }>();

/** ernesto loses their key and gets back in as Google account `sub`: the answer, and the new key. */
async function getBackIn(w: World, owner: string, sub: string, hd: string | null = "example.com", card = false) {
  const key = await newKey();
  const signin = await signIn(w, key, sub, hd);
  const obiKey = await newKey();
  const body: Record<string, unknown> = { owner_key: key.publicKey, signin };
  if (card) body.card = await makeCard({ sphere: "e2e", obi: `obi-${owner}-new`, owner, ownerKey: key, obiKey, issuedAt: w.clock.ts() });
  return { r: await rebind(w, owner, body), key, obiKey };
}

describe("getting back in with a sign-in (owner_rebind)", () => {
  it("is listed in /v0.1/features by a server that signs people in", async () => {
    const r = await new World().call("GET", "/v0.1/features");
    expect(r.body.features).toContain("owner_rebind");
  });

  it("is not offered by a server with no sign-in: not listed, and its paths are 404", async () => {
    const plain = { ...env, GOOGLE_CLIENT_ID: "", SIGNIN_PROVIDERS: undefined };
    const features = await (await handle(new Request(`${BASE}/v0.1/features`), plain, { now: () => 0 })).json<{ features: string[] }>();
    expect(features.features).not.toContain("owner_rebind");
    const r = await handle(new Request(`${BASE}/v0.1/spheres/e2e/owners/ernesto/rebind`, { method: "POST", body: "{}" }), plain, { now: () => 0 });
    expect(r.status).toBe(404);
  });

  it("binds a new key for an owner with no linked account, from an allowed domain, and links the account", async () => {
    const w = await team();
    const oldKey = await w.ownerKey("ernesto");
    const oldObiToken = await w.obiToken("obi-ernesto");
    const oldOwnerToken = await w.ownerToken("ernesto", "directory:read");
    const { r, key } = await getBackIn(w, "ernesto", "2001");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expectSchema("ownerRebindResponse", r.body);
    expect(r.body).toMatchObject({ sphere: "e2e", owner: "ernesto", owner_key: key.publicKey, owner_key_id: key.keyId, admin: false });
    expect(r.body.event).toMatchObject({ owner: "ernesto", kind: "rebound", old_key_id: oldKey.keyId, new_key_id: key.keyId, account_linked: true, revoked: ["obi-ernesto"] });
    expect(r.body).not.toHaveProperty("member");
    expect(await ownerRow("ernesto")).toMatchObject({ owner_key: key.publicKey, account: "google:2001" });

    // The old key's agent is really revoked: its entry, its key, its tokens, its exchanges.
    const reader = await w.obiToken("obi-wellington");
    const entry = await w.call("GET", "/v0.1/spheres/e2e/members/obi-ernesto", { token: reader });
    expect(entry.body.status).toBe("revoked");
    expect(entry.body.keys[0].valid_until_seq).not.toBeNull();
    // Its entry keeps the owner key that signed its card.
    expect(entry.body).toMatchObject({ owner_key: oldKey.publicKey, owner_key_id: oldKey.keyId });
    expect((await w.call("GET", "/v0.1/spheres/e2e/members", { token: oldObiToken })).status).toBe(401);
    expect((await w.call("GET", "/v0.1/spheres/e2e/members", { token: oldOwnerToken })).status).toBe(401);
    expect((await w.exchangeObi("obi-ernesto")).body.error).toBe("invalid_grant");
    // The old key opens nothing; the new one does.
    expect((await w.exchangeOwner("ernesto", "directory:read")).body.error).toBe("invalid_grant");
    w.owners.set("ernesto", key);
    expect((await w.exchangeOwner("ernesto", "directory:read")).status).toBe(200);
  });

  it("keeps an admin's admin flag", async () => {
    const w = await team();
    const { r, key } = await getBackIn(w, "wellington", "3001");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.admin).toBe(true);
    expect((await ownerRow("wellington"))!.admin).toBe(1);
    w.owners.set("wellington", key);
    const admin = await w.ownerToken("wellington");
    expect((await w.call("GET", "/v0.1/spheres/e2e/invitations", { token: admin })).status).toBe(200);
  });

  it("refuses another account for an owner whose account is linked: a stolen or someone else's sign-in", async () => {
    const w = await team();
    expect((await getBackIn(w, "ernesto", "2001")).r.status).toBe(200);
    const before = await ownerRow("ernesto");
    const other = await getBackIn(w, "ernesto", "6666");
    expect(other.r.status).toBe(403);
    expect(other.r.body.error.message).toBe("the owner is bound to another account");
    expect(await ownerRow("ernesto")).toEqual(before);
    // The linked account itself gets back in again.
    expect((await getBackIn(w, "ernesto", "2001")).r.status).toBe(200);
  });

  it("refuses a sign-in from a domain the Sphere doesn't allow, or with no domain, for an owner with none linked", async () => {
    const w = await team();
    const before = await ownerRow("ernesto");
    const wrong = await getBackIn(w, "ernesto", "4001", "elsewhere.test");
    expect(wrong.r.status).toBe(403);
    expect(wrong.r.body.error.message).toBe("a sign-in from elsewhere.test can't claim an owner here");
    const personal = await getBackIn(w, "ernesto", "4002", null);
    expect(personal.r.status).toBe(403);
    expect(await ownerRow("ernesto")).toEqual(before);
    const entry = await w.call("GET", "/v0.1/spheres/e2e/members/obi-ernesto", { token: await w.obiToken("obi-wellington") });
    expect(entry.body.status).toBe("active");
  });

  it("allows a domain an invitation of this Sphere was made for", async () => {
    const w = await team();
    const inv = await w.call("POST", "/v0.1/spheres/e2e/invitations", { token: await w.ownerToken(), body: { expires_in: 3600, max_uses: 5, domain: "partner.test" } });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect((await getBackIn(w, "ernesto", "5001", "partner.test")).r.status).toBe(200);
  });

  it("refuses an account linked to another owner, the same key, a sign-in for another key, a used sign-in, and an unknown owner", async () => {
    const w = await team();
    expect((await getBackIn(w, "wellington", "7001")).r.status).toBe(200);
    // google:7001 is wellington's now.
    expect((await getBackIn(w, "ernesto", "7001")).r.status).toBe(409);
    // The key bound already.
    const same = await w.ownerKey("ernesto");
    expect((await rebind(w, "ernesto", { owner_key: same.publicKey, signin: await signIn(w, same, "7002") })).status).toBe(409);
    // A sign-in started for one key, sent with another.
    const a = await newKey(), b = await newKey();
    const forA = await signIn(w, a, "7003");
    expect((await rebind(w, "ernesto", { owner_key: b.publicKey, signin: forA })).status).toBe(403);
    // Used once, refused the second time.
    expect((await rebind(w, "ernesto", { owner_key: a.publicKey, signin: forA })).status).toBe(200);
    const c = await newKey();
    expect((await rebind(w, "ernesto", { owner_key: c.publicKey, signin: forA })).status).toBe(403);
    expect((await rebind(w, "nobody", { owner_key: c.publicKey, signin: await signIn(w, c, "7004") })).status).toBe(404);
    expect((await rebind(w, "ernesto", { owner_key: c.publicKey })).status).toBe(400);
  });

  it("joins a new agent in the same step when the request carries its card", async () => {
    const w = await team();
    const { r, key, obiKey } = await getBackIn(w, "ernesto", "8001", "example.com", true);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.member).toMatchObject({ obi: "obi-ernesto-new", owner: "ernesto", owner_key: key.publicKey, status: "active" });
    w.owners.set("ernesto", key);
    w.obis.set("obi-ernesto-new", { owner: "ernesto", key: obiKey, accepts: ["review_request"] });
    const token = await w.obiToken("obi-ernesto-new");
    const list = await w.call("GET", "/v0.1/spheres/e2e/members", { token });
    expect(list.status).toBe(200);
    const status = Object.fromEntries(list.body.members.map((m: { obi: string; status: string }) => [m.obi, m.status]));
    expect(status).toMatchObject({ "obi-ernesto": "revoked", "obi-ernesto-new": "active", "obi-wellington": "active" });
  });

  it("refuses a card for another owner and changes nothing", async () => {
    const w = await team();
    const key = await newKey();
    const card = await makeCard({ sphere: "e2e", obi: "obi-x", owner: "wellington", ownerKey: key, obiKey: await newKey(), issuedAt: w.clock.ts() });
    const r = await rebind(w, "ernesto", { owner_key: key.publicKey, signin: await signIn(w, key, "9001"), card });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("card_invalid");
    expect((await ownerRow("ernesto"))!.account).toBeNull();
  });

  it("deletes a Sphere's owner events with it", async () => {
    const w = await team();
    expect((await getBackIn(w, "ernesto", "1201")).r.status).toBe(200);
    expect((await w.call("DELETE", "/v0.1/spheres/e2e", { token: await w.ownerToken() })).status).toBe(204);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM owner_events WHERE sphere = 'e2e'").first<{ n: number }>())!.n).toBe(0);
  });

  it("lists owner events to any member with directory:read, after an id", async () => {
    const w = await team();
    const reader = await w.obiToken("obi-wellington");
    const empty = await w.call("GET", "/v0.1/spheres/e2e/owner-events", { token: reader });
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ sphere: "e2e", events: [] });
    const first = (await getBackIn(w, "ernesto", "1101")).r.body.event;
    const r = await w.call("GET", "/v0.1/spheres/e2e/owner-events", { token: reader });
    expectSchema("ownerEventsResponse", r.body);
    expect(r.body.events).toEqual([first]);
    expect((await w.call("GET", `/v0.1/spheres/e2e/owner-events?after=${first.id}`, { token: reader })).body.events).toEqual([]);
    expect((await w.call("GET", "/v0.1/spheres/e2e/owner-events", { token: await w.obiToken("obi-wellington", "receive") })).status).toBe(403);
    expect((await w.call("GET", "/v0.1/spheres/e2e/owner-events")).status).toBe(401);
  });
});
