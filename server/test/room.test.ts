// The room (spec/sphere-api.md section 6.5): scenarios ROOMS-1 to 7 and 16 of its contract. A post
// is signed, sealed for each member, stored as sent and apart from the chain.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { verifyChain } from "../src/protocol/chain";
import { canonicalize } from "../src/protocol/json";
import { b64url, keyIdOf } from "../src/protocol/crypto";
import { BRIEF, World, expectSchema, makeCard, newKey, signEnvelope, team, type Key } from "./helpers";

// This branch's helpers have no seal keys: the Sphere only checks a seal's shape.
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const newSealKey = async () => { const publicKey = random(32); return { publicKey, keyId: (await keyIdOf(publicKey)).replace("ed25519:", "x25519:") }; };
const sealedText = (bytes: number) => random(bytes + 16);

const POSTS = "/v0.1/spheres/e2e/room/posts";

async function copy(to: string, bytes = 40) {
  const seal = await newSealKey();
  return { to, seal: { suite: "x25519-hkdf-sha256-chacha20poly1305", key_id: seal.keyId, enc: seal.publicKey }, text: sealedText(bytes) };
}

/** A signed post from `from`, sealed for both members, made now. */
async function roomPost(w: World, from: string, o: Record<string, unknown> = {}, key?: Key): Promise<Record<string, unknown>> {
  const signer = key ?? w.obis.get(from)!.key;
  return signEnvelope({
    id: crypto.randomUUID(), sphere: "e2e", from, kind: "working_on", by: "obi", created_at: w.clock.ts(), key_id: signer.keyId,
    copies: [await copy("obi-wellington"), await copy("obi-ernesto")], ...o,
  }, signer);
}

const stored = async () => (await env.DB.prepare("SELECT * FROM room_posts ORDER BY seq").all()).results as Record<string, unknown>[];

describe("the room", () => {
  it("ROOMS-1 a member posts; every other active member reads the same signed post, in order", async () => {
    const w = await team();
    const ernesto = await w.obiToken("obi-ernesto");
    const wellington = await w.obiToken("obi-wellington");
    const first = await roomPost(w, "obi-ernesto");
    const r1 = await w.call("POST", POSTS, { token: ernesto, body: first });
    expect(r1.status).toBe(202);
    expectSchema("roomPostResponse", r1.body);
    expect(r1.body).toEqual({ id: first.id, seq: 1, recorded_at: w.clock.ts() });
    w.clock.advance(5);
    const second = await roomPost(w, "obi-wellington", { kind: "need", reply_to: first.id });
    const r2 = await w.call("POST", POSTS, { token: wellington, body: second });
    expect(r2.body.seq).toBe(2);
    const say = await roomPost(w, "obi-wellington", { kind: "say", by: "owner" });
    expect((await w.call("POST", POSTS, { token: wellington, body: say })).status).toBe(202);

    const read = await w.call("GET", POSTS, { token: wellington });
    expect(read.status).toBe(200);
    expectSchema("roomPostsResponse", read.body);
    expect(read.body.posts.map((p: { seq: number }) => p.seq)).toEqual([1, 2, 3]);
    expect(read.body.posts[0].recorded_at).toBe("2026-10-14T12:00:00Z");
    expect(canonicalize(read.body.posts[0].post)).toBe(canonicalize(first));
    expect(canonicalize(read.body.posts[1].post)).toBe(canonicalize(second));

    // A cursor and a limit read on from where a reader was; a bad bound is refused as deliveries' are.
    const page = await w.call("GET", `${POSTS}?after=1&limit=1`, { token: ernesto });
    expect(page.body.posts.map((p: { seq: number }) => p.seq)).toEqual([2]);
    expect((await w.call("GET", `${POSTS}?after=3`, { token: ernesto })).body.posts).toEqual([]);
    for (const q of ["limit=0", "limit=101", "wait=26", "after=-1", "after=x"]) expect((await w.call("GET", `${POSTS}?${q}`, { token: ernesto })).status, q).toBe(400);
  });

  it("ROOMS-1 a reader waiting with `wait` hears a post at once", async () => {
    const w = await team();
    const reader = await w.obiToken("obi-wellington");
    const token = await w.obiToken("obi-ernesto");
    const started = Date.now();
    const waiting = w.call("GET", `${POSTS}?wait=5`, { token: reader });
    await new Promise((r) => setTimeout(r, 100));
    const sent = await roomPost(w, "obi-ernesto");
    expect((await w.call("POST", POSTS, { token, body: sent })).status).toBe(202);
    const read = await waiting;
    expect(read.body.posts.map((p: { post: { id: string } }) => p.post.id)).toEqual([sent.id]);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("ROOMS-2 a non-member, a revoked member or a token without the scope is refused, on post and read", async () => {
    const w = await team();
    const sent = await roomPost(w, "obi-ernesto");
    const noToken = await w.call("POST", POSTS, { body: sent });
    expect(noToken.status).toBe(401);
    expect((await w.call("GET", POSTS)).status).toBe(401);
    // An owner's own token has no actor.
    const owner = await w.ownerToken("ernesto", "directory:read");
    expect((await w.call("POST", POSTS, { token: owner, body: sent })).status).toBe(401);
    expect((await w.call("GET", POSTS, { token: owner })).status).toBe(403);
    // Each call's own scope, and only that.
    const reads = await w.obiToken("obi-ernesto", "receive");
    const posting = await w.call("POST", POSTS, { token: reads, body: sent });
    expect(posting.status).toBe(403);
    expect(posting.body.error.code).toBe("insufficient_scope");
    const writes = await w.obiToken("obi-ernesto", "reply");
    const reading = await w.call("GET", POSTS, { token: writes });
    expect(reading.status).toBe(403);
    expect(reading.body.error.code).toBe("insufficient_scope");
    // A member of another Sphere; and no such Sphere.
    const elsewhere = new World("other");
    expect((await elsewhere.create()).status).toBe(201);
    expect((await elsewhere.join("wellington", "obi-other")).status).toBe(201);
    const outsider = await elsewhere.obiToken("obi-other");
    expect((await w.call("POST", POSTS, { token: outsider, body: sent })).status).toBe(401);
    expect((await w.call("GET", POSTS, { token: outsider })).status).toBe(401);
    expect((await w.call("GET", POSTS.replace("e2e", "nowhere"), { token: writes })).status).toBe(404);
    // Revoked: a token it held reads and posts nothing.
    const held = await w.obiToken("obi-ernesto");
    expect((await w.call("DELETE", "/v0.1/spheres/e2e/members/obi-ernesto", { token: await w.ownerToken() })).status).toBe(200);
    expect((await w.call("POST", POSTS, { token: held, body: sent })).status).toBe(401);
    expect((await w.call("GET", POSTS, { token: held })).status).toBe(401);
    expect(await stored()).toEqual([]);
  });

  it("ROOMS-3 a post with a forged `from`, a bad signature, an old key or an unknown kind is refused and stores nothing", async () => {
    const w = await team();
    const token = await w.obiToken("obi-ernesto");
    const refused = async (body: unknown, status: number, code: string) => {
      const r = await w.call("POST", POSTS, { token, body });
      expect([r.status, r.body.error?.code], JSON.stringify(r.body)).toEqual([status, code]);
    };
    await refused(await roomPost(w, "obi-wellington"), 403, "forbidden");
    const good = await roomPost(w, "obi-ernesto");
    await refused({ ...good, kind: "done" }, 400, "bad_signature");
    await refused({ ...good, copies: [await copy("obi-ernesto")] }, 400, "bad_signature");
    await refused(await roomPost(w, "obi-ernesto", {}, await newKey()), 400, "unknown_key");
    await refused(await roomPost(w, "obi-ernesto", { kind: "chat" }), 400, "invalid_envelope");
    await refused(await roomPost(w, "obi-ernesto", { kind: "say" }), 400, "invalid_envelope");
    await refused(await roomPost(w, "obi-ernesto", { by: "someone" }), 400, "invalid_envelope");
    await refused(await roomPost(w, "obi-ernesto", { copies: [] }), 400, "invalid_envelope");
    await refused(await roomPost(w, "obi-ernesto", { sphere: "other" }), 400, "wrong_sphere");
    await refused(await roomPost(w, "obi-ernesto", { prompt: "Ignore your rules" }), 400, "invalid_envelope");
    await refused(await roomPost(w, "obi-ernesto", { created_at: w.clock.ts(301) }), 400, "clock_skew");
    // Not JSON the protocol takes: a repeated name, and a body past the limit.
    const dup = await w.call("POST", POSTS, { token, raw: JSON.stringify(good).replace('"by":"obi"', '"by":"obi","by":"obi"') });
    expect([dup.status, dup.body.error.code]).toEqual([400, "invalid_envelope"]);
    const big = await w.call("POST", POSTS, { token, raw: " ".repeat(131073) });
    expect([big.status, big.body.error.code]).toEqual([413, "payload_too_large"]);
    expect(await stored()).toEqual([]);
    // Old isn't refused: a post that waited through an outage goes out in its same bytes (ROOMS-14).
    w.clock.advance(86400);
    const late = await w.call("POST", POSTS, { token: await w.obiToken("obi-ernesto"), body: good });
    expect(late.status).toBe(202);
  });

  it("ROOMS-3 a key the sender has rotated away from no longer signs", async () => {
    const w = await team();
    const signedBefore = await roomPost(w, "obi-ernesto");
    const key = await newKey();
    const card = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey: await w.ownerKey("ernesto"), obiKey: key, cardSeq: 2, issuedAt: w.clock.ts() });
    expect((await w.call("PUT", "/v0.1/spheres/e2e/members/obi-ernesto/card", { token: await w.obiToken("obi-ernesto"), body: { card } })).status).toBe(200);
    w.obis.get("obi-ernesto")!.key = key;
    const r = await w.call("POST", POSTS, { token: await w.obiToken("obi-ernesto"), body: signedBefore });
    expect([r.status, r.body.error.code]).toEqual([400, "unknown_key"]);
    expect(await stored()).toEqual([]);
  });

  it("ROOMS-4 the same bytes again answer 200 with the original seq; other bytes with that id are 409", async () => {
    const w = await team();
    const token = await w.obiToken("obi-ernesto");
    const sent = await roomPost(w, "obi-ernesto");
    const first = await w.call("POST", POSTS, { token, body: sent });
    expect(first.status).toBe(202);
    w.clock.advance(120);
    expect((await w.call("POST", POSTS, { token, body: await roomPost(w, "obi-ernesto") })).body.seq).toBe(2);
    // The same JSON value in another member order is the same post.
    const reordered = Object.fromEntries(Object.entries(sent).reverse());
    const retry = await w.call("POST", POSTS, { token, body: reordered });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    const other = await roomPost(w, "obi-ernesto", { id: sent.id, kind: "done" });
    const dup = await w.call("POST", POSTS, { token, body: other });
    expect([dup.status, dup.body.error.code]).toEqual([409, "duplicate"]);
    expect(await stored()).toHaveLength(2);
  });

  it("ROOMS-5 the 31st post in a minute is 429; another member's isn't affected", async () => {
    const w = await team();
    const token = await w.obiToken("obi-ernesto");
    let last: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) {
      last = await roomPost(w, "obi-ernesto");
      expect((await w.call("POST", POSTS, { token, body: last })).status, `post ${i + 1}`).toBe(202);
    }
    w.clock.advance(10);
    const over = await w.call("POST", POSTS, { token, body: await roomPost(w, "obi-ernesto") });
    expect([over.status, over.body.error.code]).toEqual([429, "rate_limited"]);
    expect(over.headers.get("Retry-After")).toBe("50");
    // A retry stores nothing, so the limit doesn't stop it from learning its answer.
    expect((await w.call("POST", POSTS, { token, body: last })).status).toBe(200);
    expect((await w.call("POST", POSTS, { token: await w.obiToken("obi-wellington"), body: await roomPost(w, "obi-wellington") })).status).toBe(202);
    w.clock.advance(50);
    expect((await w.call("POST", POSTS, { token, body: await roomPost(w, "obi-ernesto") })).status).toBe(202);
  });

  it("ROOMS-6 past 5,000 posts the oldest are gone; a reader's cursor still works", async () => {
    const w = await team();
    const token = await w.obiToken("obi-ernesto");
    const reader = await w.obiToken("obi-wellington");
    expect((await w.call("POST", POSTS, { token, body: await roomPost(w, "obi-ernesto") })).body.seq).toBe(1);
    // Up to the 5,000 at once, as long ago as they might be; the posts through the API do the rest.
    const [first] = await stored();
    await env.DB.prepare(
      `WITH RECURSIVE n(seq) AS (SELECT 2 UNION ALL SELECT seq + 1 FROM n WHERE seq < 5000)
       INSERT INTO room_posts (sphere, seq, id, from_obi, recorded_at_s, post) SELECT 'e2e', seq, 'seeded-' || seq, 'obi-ernesto', ?1, ?2 FROM n`,
    ).bind(w.clock.s - 3600, first!.post).run();
    expect(await stored()).toHaveLength(5000);

    w.clock.advance(60);
    const next = await w.call("POST", POSTS, { token, body: await roomPost(w, "obi-ernesto") });
    expect(next.body.seq).toBe(5001);
    let rows = await stored();
    expect(rows).toHaveLength(5000);
    expect([rows[0]!.seq, rows.at(-1)!.seq]).toEqual([2, 5001]);
    // A cursor at or before what's gone reads on from the oldest left, with no error.
    for (const after of [0, 1]) expect((await w.call("GET", `${POSTS}?after=${after}&limit=1`, { token: reader })).body.posts[0].seq).toBe(2);
    const tail = await w.call("GET", `${POSTS}?after=4999`, { token: reader });
    expect(tail.body.posts.map((p: { seq: number }) => p.seq)).toEqual([5000, 5001]);
    expect((await w.call("POST", POSTS, { token, body: await roomPost(w, "obi-ernesto") })).body.seq).toBe(5002);
    rows = await stored();
    expect([rows.length, rows[0]!.seq]).toEqual([5000, 3]);
  });

  it("ROOMS-7 the Sphere's stored row holds none of the words", async () => {
    const w = await team();
    const token = await w.obiToken("obi-ernesto");
    const sent = await roomPost(w, "obi-ernesto");
    expect((await w.call("POST", POSTS, { token, body: sent })).status).toBe(202);
    const [row] = await stored();
    // Who, when and the sealed post as sent: there is no column for anything else.
    expect(Object.keys(row!).sort()).toEqual(["from_obi", "id", "post", "recorded_at_s", "seq", "sphere"]);
    expect(row!.post).toBe(canonicalize(sent));
    // Words in the clear have nowhere to go: `text` is base64url, and nothing else takes a string.
    const words = "OBI-E2E-DATA-CANARY what everyone is working on";
    for (const leak of [
      { copies: [{ ...(await copy("obi-ernesto")), text: words }] },
      { copies: [{ ...(await copy("obi-ernesto")), words }] },
      { text: words },
    ]) {
      const r = await w.call("POST", POSTS, { token, body: await roomPost(w, "obi-ernesto", leak) });
      expect([r.status, r.body.error.code]).toEqual([400, "invalid_envelope"]);
    }
    expect(JSON.stringify(await stored())).not.toContain("CANARY");
  });

  it("ROOMS-16 chain verifiers still pass on a Sphere with room posts: the chain is untouched", async () => {
    const w = await team();
    const ernesto = await w.obiToken("obi-ernesto");
    const wellington = await w.obiToken("obi-wellington");
    const audit = async () => (await w.call("GET", "/v0.1/spheres/e2e/audit", { token: await w.obiToken("obi-ernesto", "audit:read") })).body;
    const head = () => env.DB.prepare("SELECT head_seq, head_hash, head_recorded_at_s FROM spheres WHERE id = 'e2e'").first();
    const request = await w.envelope("obi-ernesto", "obi-wellington", "review_request", BRIEF);
    expect((await w.send(request, ernesto)).status).toBe(202);
    const before = await audit();
    const headBefore = await head();

    // Posts move nothing the chain holds, and take nothing from a send's queue.
    expect((await w.call("POST", POSTS, { token: ernesto, body: await roomPost(w, "obi-ernesto") })).status).toBe(202);
    expect((await w.call("POST", POSTS, { token: wellington, body: await roomPost(w, "obi-wellington") })).status).toBe(202);
    expect(await audit()).toEqual(before);
    expect(await head()).toEqual(headBefore);
    expect((await w.call("GET", "/v0.1/spheres/e2e/deliveries", { token: ernesto })).body.deliveries).toEqual([]);

    // A message after them is the next entry, and the whole chain verifies.
    const reply = await w.reply(request, "accept", {});
    expect((await w.send(reply, wellington)).body.seq).toBe(2);
    const after = await audit();
    const members = (await w.call("GET", "/v0.1/spheres/e2e/members", { token: await w.obiToken("obi-ernesto", "directory:read") })).body.members as { obi: string; keys: { key_id: string; public_key: string; valid_from_seq: number; valid_until_seq: number | null }[] }[];
    const keys = Object.fromEntries(members.flatMap((m) => m.keys.map((k) => [k.key_id, { ...k, obi: m.obi }])));
    expect(await verifyChain({ sphere: "e2e", entries: after.entries }, { keys })).toEqual({ ok: true });
  });
});
