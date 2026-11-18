// Invitations, pairing, the directory, rotation and revocation (spec/sphere-api.md section 4,
// spec/identity.md section 3).

import { describe, expect, it } from "vitest";
import { verifyCard } from "../src/protocol/card";
import { World, expectSchema, makeCard, newKey, team } from "./helpers";

describe("invitations", () => {
  it("makes one for an Obi of an owner, with a 43-character secret and the Sphere's expiry", async () => {
    const w = new World();
    await w.create();
    const r = await w.invite("ernesto", "obi-ernesto", 3600);
    expect(r.status).toBe(201);
    expectSchema("invitationResponse", r.body);
    expect(r.body).toMatchObject({ sphere: "e2e", owner: "ernesto", obi: "obi-ernesto", expires_at: "2026-10-14T13:00:00Z" });
    expect(r.body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is admin only: an owner token without admin is 403 insufficient_scope, an Obi token too", async () => {
    const w = await team();
    const r = await w.call("POST", "/v0.1/spheres/e2e/invitations", { token: await w.ownerToken("ernesto", "directory:read"), body: { owner: "x", obi: "obi-x", expires_in: 3600 } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("insufficient_scope");
    const o = await w.call("POST", "/v0.1/spheres/e2e/invitations", { token: await w.obiToken("obi-ernesto"), body: { owner: "x", obi: "obi-x", expires_in: 3600 } });
    expect(o.status).toBe(403);
  });

  it("never reuses an Obi id: 409 conflict for a member, past or present", async () => {
    const w = await team();
    expect((await w.invite("ernesto", "obi-ernesto")).status).toBe(409);
    await w.call("DELETE", "/v0.1/spheres/e2e/members/obi-ernesto", { token: await w.ownerToken() });
    const again = await w.invite("ernesto", "obi-ernesto");
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("conflict");
  });

  it("checks its body: 400 bad_request", async () => {
    const w = new World();
    await w.create();
    const token = await w.ownerToken();
    for (const body of [{ owner: "x", obi: "obi-x" }, { owner: "x", obi: "obi-x", expires_in: 59 }, { owner: "x", obi: "obi-x", expires_in: 3600, note: "hi" }]) {
      expect((await w.call("POST", "/v0.1/spheres/e2e/invitations", { token, body })).status).toBe(400);
    }
  });
});

describe("redeeming (pairing an Obi)", () => {
  async function setup() {
    const w = new World();
    await w.create();
    const inv = (await w.invite("ernesto", "obi-ernesto")).body;
    const ownerKey = await w.ownerKey("ernesto");
    const obiKey = await newKey();
    const card = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey, obiKey, issuedAt: w.clock.ts() });
    const redeem = (body: unknown, id = inv.invitation_id) => w.call("POST", `/v0.1/spheres/e2e/invitations/${id}/redeem`, { body });
    return { w, inv, ownerKey, obiKey, card, redeem };
  }

  it("binds the owner key, makes the member active with its key valid from the next seq", async () => {
    const { w, inv, ownerKey, obiKey, card, redeem } = await setup();
    w.clock.advance(5);
    const r = await redeem({ secret: inv.secret, owner_key: ownerKey.publicKey, card });
    expect(r.status).toBe(201);
    expectSchema("member", r.body);
    expect(r.body).toEqual({
      obi: "obi-ernesto", owner: "ernesto", owner_key: ownerKey.publicKey, owner_key_id: ownerKey.keyId, status: "active", joined_at: "2026-10-14T12:00:05Z", card,
      keys: [{ key_id: obiKey.keyId, public_key: obiKey.publicKey, valid_from_seq: 1, valid_until_seq: null }],
    });
    expect(await verifyCard(r.body.card, { bound_owner_key: ownerKey.publicKey })).toEqual({ ok: true });
  });

  it("answers every invitation failure the same: unknown, wrong secret, used, expired", async () => {
    const { w, inv, ownerKey, card, redeem } = await setup();
    const body = { secret: inv.secret, owner_key: ownerKey.publicKey, card };
    const messages = new Set<string>();
    for (const r of [
      await redeem(body, crypto.randomUUID()),
      await redeem({ ...body, secret: "A".repeat(43) }),
    ]) {
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("invitation_invalid");
      messages.add(r.body.error.message);
    }
    expect((await redeem(body)).status).toBe(201);
    const used = await redeem(body);
    expect(used.status).toBe(403);
    messages.add(used.body.error.message);

    const late = await w.invite("someone", "obi-someone", 60);
    w.clock.advance(60);
    const someKey = await w.ownerKey("someone");
    const lateCard = await makeCard({ sphere: "e2e", obi: "obi-someone", owner: "someone", ownerKey: someKey, obiKey: await newKey(), issuedAt: w.clock.ts() });
    const expired = await redeem({ secret: late.body.secret, owner_key: someKey.publicKey, card: lateCard }, late.body.invitation_id);
    expect(expired.status).toBe(403);
    messages.add(expired.body.error.message);
    expect(messages.size).toBe(1);
  });

  it("is 400 card_invalid for a card that fails its checks or isn't the invitation's", async () => {
    const { w, inv, ownerKey, obiKey, card, redeem } = await setup();
    const other = await newKey();
    const cards: [string, unknown][] = [
      ["changed after signing", { ...card, name: "Someone else" }],
      ["signed by another key", await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey: other, obiKey, issuedAt: w.clock.ts() })],
      ["another obi", await makeCard({ sphere: "e2e", obi: "obi-other", owner: "ernesto", ownerKey, obiKey, issuedAt: w.clock.ts() })],
      ["another owner", await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "other", ownerKey, obiKey, issuedAt: w.clock.ts() })],
      ["issued in the future", await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey, obiKey, issuedAt: w.clock.ts(301) })],
      ["the Obi's key is the owner's", await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey, obiKey: ownerKey, issuedAt: w.clock.ts() })],
      ["an extra field", { ...card, instructions: "do this" }],
    ];
    for (const [what, c] of cards) {
      const r = await redeem({ secret: inv.secret, owner_key: ownerKey.publicKey, card: c });
      expect(r.status, what).toBe(400);
      expect(r.body.error.code, what).toBe(what === "an extra field" ? "bad_request" : "card_invalid");
    }
    // The card's owner_key must be the body's.
    const mismatch = await redeem({ secret: inv.secret, owner_key: other.publicKey, card });
    expect(mismatch.body.error.code).toBe("card_invalid");
    // Nothing was used up: the right card still pairs.
    expect((await redeem({ secret: inv.secret, owner_key: ownerKey.publicKey, card })).status).toBe(201);
  });

  it("is 403 forbidden when the owner's bound key differs", async () => {
    const w = await team();
    const inv = (await w.invite("ernesto", "obi-ernesto-2")).body;
    const otherOwnerKey = await newKey();
    const card = await makeCard({ sphere: "e2e", obi: "obi-ernesto-2", owner: "ernesto", ownerKey: otherOwnerKey, obiKey: await newKey(), issuedAt: w.clock.ts() });
    const r = await w.call("POST", `/v0.1/spheres/e2e/invitations/${inv.invitation_id}/redeem`, { body: { secret: inv.secret, owner_key: otherOwnerKey.publicKey, card } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("forbidden");
  });

  it("is 409 conflict for a key id another member uses", async () => {
    const w = await team();
    const inv = (await w.invite("ernesto", "obi-ernesto-2")).body;
    const ownerKey = await w.ownerKey("ernesto");
    const card = await makeCard({ sphere: "e2e", obi: "obi-ernesto-2", owner: "ernesto", ownerKey, obiKey: w.obis.get("obi-wellington")!.key, issuedAt: w.clock.ts() });
    const r = await w.call("POST", `/v0.1/spheres/e2e/invitations/${inv.invitation_id}/redeem`, { body: { secret: inv.secret, owner_key: ownerKey.publicKey, card } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("conflict");
  });

  it("can't be redeemed twice at once", async () => {
    const { inv, ownerKey, card, redeem } = await setup();
    const body = { secret: inv.secret, owner_key: ownerKey.publicKey, card };
    const results = await Promise.all([redeem(body), redeem(body), redeem(body)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 403, 403]);
  });
});

describe("open invitations (one link for a team)", () => {
  async function setup(maxUses = 2, expiresIn = 3600) {
    const w = await team();
    const r = await w.call("POST", "/v0.1/spheres/e2e/invitations", { token: await w.ownerToken(), body: { expires_in: expiresIn, max_uses: maxUses } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const inv = r.body;
    const redeem = (body: unknown, id = inv.invitation_id) => w.call("POST", `/v0.1/spheres/e2e/invitations/${id}/redeem`, { body });
    const preview = (secret = inv.secret, id = inv.invitation_id) => w.call("POST", `/v0.1/spheres/e2e/invitations/${id}/preview`, { body: { secret } });
    // A redeem whose card names its own Obi and owner.
    const joinAs = async (owner: string, obi: string, ownerKey?: Awaited<ReturnType<typeof newKey>>) => {
      const key = ownerKey ?? (await w.ownerKey(owner));
      const card = await makeCard({ sphere: "e2e", obi, owner, ownerKey: key, obiKey: await newKey(), issuedAt: w.clock.ts() });
      return redeem({ secret: inv.secret, owner_key: key.publicKey, card });
    };
    return { w, inv, redeem, preview, joinAs };
  }

  it("leaves owner and obi out and says how many may use it", async () => {
    const { inv } = await setup(50, 604800);
    expectSchema("invitationResponse", inv);
    expect(inv).toMatchObject({ sphere: "e2e", max_uses: 50, expires_at: "2026-10-21T12:00:00Z" });
    expect(inv).not.toHaveProperty("owner");
    expect(inv).not.toHaveProperty("obi");
  });

  it("is used once when max_uses is left out, and a named one says max_uses 1", async () => {
    const w = await team();
    const token = await w.ownerToken();
    const open = await w.call("POST", "/v0.1/spheres/e2e/invitations", { token, body: { expires_in: 3600 } });
    expect(open.body.max_uses).toBe(1);
    const named = await w.invite("someone", "obi-someone");
    expectSchema("invitationResponse", named.body);
    expect(named.body.max_uses).toBe(1);
  });

  it("checks its body: owner and obi come together, a named one takes no max_uses, max_uses is 1 to 1,000", async () => {
    const w = await team();
    const token = await w.ownerToken();
    for (const body of [{ owner: "x", expires_in: 3600 }, { obi: "obi-x", expires_in: 3600 }, { owner: "x", obi: "obi-x", expires_in: 3600, max_uses: 2 }, { expires_in: 3600, max_uses: 0 }, { expires_in: 3600, max_uses: 1001 }, { expires_in: 3600, email_domain: "deskree.com" }]) {
      const r = await w.call("POST", "/v0.1/spheres/e2e/invitations", { token, body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.code).toBe("bad_request");
    }
  });

  it("pairs up to max_uses Obis, each card naming its own Obi and owner, binding each new owner's key", async () => {
    const { w, joinAs } = await setup(2);
    const a = await joinAs("ana", "obi-ana");
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expectSchema("member", a.body);
    expect(a.body).toMatchObject({ obi: "obi-ana", owner: "ana", owner_key: (await w.ownerKey("ana")).publicKey, status: "active" });
    expect((await joinAs("bo", "obi-bo")).status).toBe(201);
    const third = await joinAs("cy", "obi-cy");
    expect(third.status).toBe(403);
    expect(third.body.error.code).toBe("invitation_invalid");
  });

  it("never reuses an Obi id, and a refused redeem uses nothing", async () => {
    const { w, joinAs } = await setup(1);
    await w.call("DELETE", "/v0.1/spheres/e2e/members/obi-ernesto", { token: await w.ownerToken() });
    for (const obi of ["obi-wellington", "obi-ernesto"]) {
      const r = await joinAs("dee", obi);
      expect(r.status, obi).toBe(409);
      expect(r.body.error.code).toBe("conflict");
    }
    expect((await joinAs("dee", "obi-dee")).status).toBe(201);
  });

  it("can't take a bound owner's id with another key, and lets a bound owner add an Obi with theirs", async () => {
    const { w, joinAs } = await setup(2);
    const squat = await joinAs("ernesto", "obi-not-ernesto", await newKey());
    expect(squat.status).toBe(403);
    expect(squat.body.error.code).toBe("forbidden");
    const admin = await joinAs("wellington", "obi-wellington-laptop", await newKey());
    expect(admin.body.error.code).toBe("forbidden");
    const own = await joinAs("ernesto", "obi-ernesto-laptop");
    expect(own.status).toBe(201);
    expect(own.body.owner_key).toBe((await w.ownerKey("ernesto")).publicKey);
  });

  it("can't be used past max_uses at once", async () => {
    const { joinAs } = await setup(1);
    const results = await Promise.all([joinAs("p1", "obi-p1"), joinAs("p2", "obi-p2"), joinAs("p3", "obi-p3")]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 403, 403]);
  });

  it("is withdrawn by the admin at once: preview and redeem are invalid from then on", async () => {
    const { w, inv, preview, joinAs } = await setup(5);
    const path = `/v0.1/spheres/e2e/invitations/${inv.invitation_id}`;
    expect((await joinAs("ana", "obi-ana")).status).toBe(201);
    for (const token of [await w.ownerToken("ernesto", "directory:read"), await w.obiToken("obi-ernesto")]) {
      const r = await w.call("DELETE", path, { token });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("insufficient_scope");
    }
    expect((await w.call("DELETE", path, { token: await w.ownerToken() })).status).toBe(204);
    expect((await preview()).body.error.code).toBe("invitation_invalid");
    expect((await joinAs("bo", "obi-bo")).body.error.code).toBe("invitation_invalid");
    const again = await w.call("DELETE", path, { token: await w.ownerToken() });
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe("not_found");
  });

  it("is withdrawn before a redeem lands, or after it, never both", async () => {
    const { w, inv, joinAs } = await setup(5);
    const withdraw = w.call("DELETE", `/v0.1/spheres/e2e/invitations/${inv.invitation_id}`, { token: await w.ownerToken() });
    const [gone, joined] = await Promise.all([withdraw, joinAs("ana", "obi-ana")]);
    expect(gone.status).toBe(204);
    const member = await w.call("GET", "/v0.1/spheres/e2e/members/obi-ana", { token: await w.ownerToken() });
    expect(joined.status === 201 ? member.status : joined.body.error.code).toBe(joined.status === 201 ? 200 : "invitation_invalid");
    expect((await joinAs("bo", "obi-bo")).body.error.code).toBe("invitation_invalid");
  });

  it("is 400 card_invalid for a card for another Sphere", async () => {
    const { w, inv, redeem } = await setup();
    const key = await w.ownerKey("eve");
    const card = await makeCard({ sphere: "other", obi: "obi-eve", owner: "eve", ownerKey: key, obiKey: await newKey(), issuedAt: w.clock.ts() });
    const r = await redeem({ secret: inv.secret, owner_key: key.publicKey, card });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("card_invalid");
  });
});

describe("previewing an invitation (the Join screen)", () => {
  it("says the Sphere's name, its active members and the expiry, and uses nothing up", async () => {
    const w = await team();
    await w.call("DELETE", "/v0.1/spheres/e2e/members/obi-ernesto", { token: await w.ownerToken() });
    const inv = (await w.call("POST", "/v0.1/spheres/e2e/invitations", { token: await w.ownerToken(), body: { expires_in: 3600 } })).body;
    for (let i = 0; i < 2; i++) {
      const r = await w.call("POST", `/v0.1/spheres/e2e/invitations/${inv.invitation_id}/preview`, { body: { secret: inv.secret } });
      expect(r.status).toBe(200);
      expectSchema("invitationPreviewResponse", r.body);
      expect(r.body).toEqual({ sphere: "e2e", name: "E2E sphere", member_count: 1, expires_at: inv.expires_at });
    }
    const key = await w.ownerKey("ana");
    const card = await makeCard({ sphere: "e2e", obi: "obi-ana", owner: "ana", ownerKey: key, obiKey: await newKey(), issuedAt: w.clock.ts() });
    expect((await w.call("POST", `/v0.1/spheres/e2e/invitations/${inv.invitation_id}/redeem`, { body: { secret: inv.secret, owner_key: key.publicKey, card } })).status).toBe(201);
  });

  it("answers every invitation failure the same: unknown, wrong secret, used up, expired", async () => {
    const w = await team();
    const token = await w.ownerToken();
    const inv = (await w.call("POST", "/v0.1/spheres/e2e/invitations", { token, body: { expires_in: 60 } })).body;
    const used = (await w.invite("ana", "obi-ana")).body;
    const key = await w.ownerKey("ana");
    const card = await makeCard({ sphere: "e2e", obi: "obi-ana", owner: "ana", ownerKey: key, obiKey: await newKey(), issuedAt: w.clock.ts() });
    expect((await w.call("POST", `/v0.1/spheres/e2e/invitations/${used.invitation_id}/redeem`, { body: { secret: used.secret, owner_key: key.publicKey, card } })).status).toBe(201);
    const preview = (id: string, secret: string) => w.call("POST", `/v0.1/spheres/e2e/invitations/${id}/preview`, { body: { secret } });
    const answers = [await preview(crypto.randomUUID(), inv.secret), await preview(inv.invitation_id, "A".repeat(43)), await preview(used.invitation_id, used.secret)];
    w.clock.advance(60);
    answers.push(await preview(inv.invitation_id, inv.secret));
    for (const r of answers) {
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("invitation_invalid");
    }
    expect(new Set(answers.map((r) => r.body.error.message)).size).toBe(1);
  });

  it("checks its body: 400 bad_request", async () => {
    const w = await team();
    const inv = (await w.call("POST", "/v0.1/spheres/e2e/invitations", { token: await w.ownerToken(), body: { expires_in: 3600 } })).body;
    for (const body of [{}, { secret: "short" }, { secret: inv.secret, extra: 1 }]) {
      const r = await w.call("POST", `/v0.1/spheres/e2e/invitations/${inv.invitation_id}/preview`, { body });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("bad_request");
    }
  });
});

describe("the directory", () => {
  it("lists every member by joined_at then obi, each with its card and keys", async () => {
    const w = new World();
    await w.create();
    await w.join("wellington", "obi-wellington");
    await w.join("ernesto", "obi-ernesto");
    w.clock.advance(1);
    await w.join("ernesto", "obi-a-later");
    const token = await w.obiToken("obi-ernesto");
    const r = await w.call("GET", "/v0.1/spheres/e2e/members", { token });
    expect(r.status).toBe(200);
    expectSchema("membersResponse", r.body);
    expect(r.body.members.map((m: { obi: string }) => m.obi)).toEqual(["obi-ernesto", "obi-wellington", "obi-a-later"]);
    for (const m of r.body.members) expect(m.keys).toEqual([{ key_id: w.obis.get(m.obi)!.key.keyId, public_key: w.obis.get(m.obi)!.key.publicKey, valid_from_seq: 1, valid_until_seq: null }]);
    const one = await w.call("GET", "/v0.1/spheres/e2e/members/obi-wellington", { token });
    expect(one.status).toBe(200);
    expect(one.body).toEqual(r.body.members[1]);
    expect((await w.call("GET", "/v0.1/spheres/e2e/members/nobody", { token })).status).toBe(404);
  });

  it("needs directory:read", async () => {
    const w = await team();
    const r = await w.call("GET", "/v0.1/spheres/e2e/members", { token: await w.obiToken("obi-ernesto", "receive") });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("insufficient_scope");
  });
});

describe("rotation", () => {
  it("closes the old key at the head, opens the new one after it, and revokes the Obi's tokens", async () => {
    const w = await team();
    const token = await w.obiToken("obi-ernesto");
    const old = w.obis.get("obi-ernesto")!.key;
    const ownerKey = await w.ownerKey("ernesto");
    const fresh = await newKey();
    const card = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey, obiKey: fresh, cardSeq: 2, issuedAt: w.clock.ts() });
    const r = await w.call("PUT", "/v0.1/spheres/e2e/members/obi-ernesto/card", { token, body: { card } });
    expect(r.status).toBe(200);
    expectSchema("member", r.body);
    expect(r.body.keys).toEqual([
      { key_id: old.keyId, public_key: old.publicKey, valid_from_seq: 1, valid_until_seq: 0 },
      { key_id: fresh.keyId, public_key: fresh.publicKey, valid_from_seq: 1, valid_until_seq: null },
    ]);
    // The token used for it is revoked; a new exchange must prove the new key.
    expect((await w.call("GET", "/v0.1/spheres/e2e/members", { token })).status).toBe(401);
    expect((await w.exchangeObi("obi-ernesto")).body.error).toBe("invalid_grant");
    w.obis.get("obi-ernesto")!.key = fresh;
    expect((await w.exchangeObi("obi-ernesto")).status).toBe(200);
  });

  it("needs a higher card_seq, the same identity and the Obi's own token; the same key changes no key", async () => {
    const w = await team();
    const token = await w.obiToken("obi-ernesto");
    const ownerKey = await w.ownerKey("ernesto");
    const key = w.obis.get("obi-ernesto")!.key;
    const same = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey, obiKey: key, cardSeq: 1, issuedAt: w.clock.ts() });
    expect((await w.call("PUT", "/v0.1/spheres/e2e/members/obi-ernesto/card", { token, body: { card: same } })).body.error.code).toBe("conflict");
    const other = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey: await newKey(), obiKey: key, cardSeq: 2, issuedAt: w.clock.ts() });
    expect((await w.call("PUT", "/v0.1/spheres/e2e/members/obi-ernesto/card", { token, body: { card: other } })).body.error.code).toBe("card_invalid");
    const wellingtonToken = await w.obiToken("obi-wellington");
    const next = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey, obiKey: key, cardSeq: 2, accepts: ["review_request", "question"], issuedAt: w.clock.ts() });
    expect((await w.call("PUT", "/v0.1/spheres/e2e/members/obi-ernesto/card", { token: wellingtonToken, body: { card: next } })).body.error.code).toBe("forbidden");
    const taken = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey, obiKey: w.obis.get("obi-wellington")!.key, cardSeq: 2, issuedAt: w.clock.ts() });
    expect((await w.call("PUT", "/v0.1/spheres/e2e/members/obi-ernesto/card", { token, body: { card: taken } })).body.error.code).toBe("conflict");
    const r = await w.call("PUT", "/v0.1/spheres/e2e/members/obi-ernesto/card", { token, body: { card: next } });
    expect(r.status).toBe(200);
    expect(r.body.card).toEqual(next);
    expect(r.body.keys).toHaveLength(1);
    expect((await w.call("GET", "/v0.1/spheres/e2e/members", { token })).status).toBe(200);
  });
});

describe("the card's runtime and vendors (identity.md section 2.3)", () => {
  const RUNTIME = { features: ["card_runtime"], runtime: { id: "claude", version: "2.1.0" }, vendors: ["anthropic"] };

  it("takes a card that declares them, on redeem and on update, and serves it as the owner signed it", async () => {
    const w = new World();
    expect((await w.create()).status).toBe(201);
    const inv = await w.invite("ernesto", "obi-ernesto");
    const ownerKey = await w.ownerKey("ernesto");
    const key = await newKey();
    const card = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey, obiKey: key, issuedAt: w.clock.ts(), params: RUNTIME });
    const r = await w.call("POST", `/v0.1/spheres/e2e/invitations/${inv.body.invitation_id}/redeem`, { body: { secret: inv.body.secret, owner_key: ownerKey.publicKey, card } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.card).toEqual(card);
    w.obis.set("obi-ernesto", { owner: "ernesto", key, accepts: ["review_request"] });
    const token = await w.obiToken("obi-ernesto");
    const next = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey, obiKey: key, cardSeq: 2, issuedAt: w.clock.ts(), params: { ...RUNTIME, runtime: { id: "acme-agent", version: "0.0.1" }, vendors: ["openai", "acme-models"] } });
    const u = await w.call("PUT", "/v0.1/spheres/e2e/members/obi-ernesto/card", { token, body: { card: next } });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expectSchema("member", u.body);
    expect(u.body.card).toEqual(next);
    const dir = await w.call("GET", "/v0.1/spheres/e2e/members/obi-ernesto", { token });
    expect(dir.body.card.capabilities.extensions[0].params.vendors).toEqual(["openai", "acme-models"]);
  });

  it("is 400 bad_request for runtime or vendors without features, or a features list without card_runtime: the body's schema holds the card's", async () => {
    const w = await team();
    const token = await w.obiToken("obi-ernesto");
    const ownerKey = await w.ownerKey("ernesto");
    const key = w.obis.get("obi-ernesto")!.key;
    const bad: [string, Record<string, unknown>][] = [
      ["runtime without features", { runtime: RUNTIME.runtime }],
      ["vendors without features", { vendors: RUNTIME.vendors }],
      ["features without card_runtime", { ...RUNTIME, features: ["some_later_feature"] }],
      ["a vendor twice", { ...RUNTIME, vendors: ["anthropic", "anthropic"] }],
      ["a runtime named in words", { ...RUNTIME, runtime: { id: "Claude Code", version: "2.1.0" } }],
    ];
    for (const [what, params] of bad) {
      const card = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey, obiKey: key, cardSeq: 2, issuedAt: w.clock.ts(), params });
      const r = await w.call("PUT", "/v0.1/spheres/e2e/members/obi-ernesto/card", { token, body: { card } });
      expect(r.status, what).toBe(400);
      expect(r.body.error.code, what).toBe("bad_request");
    }
  });
});

describe("publishing a card with an addition (identity.md section 2.3)", () => {
  const RUNTIME = { features: ["card_runtime"], runtime: { id: "claude", version: "2.1.0" }, vendors: ["anthropic"] };

  it("is 409 conflict while another active member's card doesn't take card_runtime, and takes it once every one does", async () => {
    const w = await team();
    const token = await w.obiToken("obi-ernesto");
    const ownerKey = await w.ownerKey("ernesto");
    const key = w.obis.get("obi-ernesto")!.key;
    const early = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey, obiKey: key, cardSeq: 2, issuedAt: w.clock.ts(), params: RUNTIME });
    const refused = await w.call("PUT", "/v0.1/spheres/e2e/members/obi-ernesto/card", { token, body: { card: early } });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("feature_not_taken");
    expect(refused.body.error.message).toContain("obi-wellington");
    // obi-wellington's owner signs it a card whose version says it takes card_runtime.
    const wToken = await w.obiToken("obi-wellington");
    const wKey = w.obis.get("obi-wellington")!.key;
    const tagged = await makeCard({ sphere: "e2e", obi: "obi-wellington", owner: "wellington", ownerKey: await w.ownerKey("wellington"), obiKey: wKey, cardSeq: 2, issuedAt: w.clock.ts(), version: "0.3.0+card-runtime" });
    expect((await w.call("PUT", "/v0.1/spheres/e2e/members/obi-wellington/card", { token: wToken, body: { card: tagged } })).status).toBe(200);
    const now = await w.call("PUT", "/v0.1/spheres/e2e/members/obi-ernesto/card", { token, body: { card: early } });
    expect(now.status, JSON.stringify(now.body)).toBe(200);
    // A newcomer from before can still join (its card carries none), and holds back the next card that would.
    const inv = await w.invite("sangam", "obi-sangam");
    const sKey = await w.ownerKey("sangam");
    const plain = await makeCard({ sphere: "e2e", obi: "obi-sangam", owner: "sangam", ownerKey: sKey, obiKey: await newKey(), issuedAt: w.clock.ts() });
    expect((await w.call("POST", `/v0.1/spheres/e2e/invitations/${inv.body.invitation_id}/redeem`, { body: { secret: inv.body.secret, owner_key: sKey.publicKey, card: plain } })).status).toBe(201);
    const later = await makeCard({ sphere: "e2e", obi: "obi-wellington", owner: "wellington", ownerKey: await w.ownerKey("wellington"), obiKey: wKey, cardSeq: 3, issuedAt: w.clock.ts(), params: RUNTIME });
    expect((await w.call("PUT", "/v0.1/spheres/e2e/members/obi-wellington/card", { token: wToken, body: { card: later } })).body.error.code).toBe("feature_not_taken");
    // obi-ernesto's card carries them already: obi-sangam doesn't hold back its next card, a key rotation included.
    const rotated = await newKey();
    const kept = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey, obiKey: rotated, cardSeq: 3, issuedAt: w.clock.ts(), params: { ...RUNTIME, vendors: ["anthropic", "openai"] } });
    const r = await w.call("PUT", "/v0.1/spheres/e2e/members/obi-ernesto/card", { token: await w.obiToken("obi-ernesto"), body: { card: kept } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it("reads +card-runtime only as build metadata, and a features list as taking what it names", async () => {
    const { featuresTaken } = await import("../src/protocol/card");
    const card = (version: string, features?: string[]) => ({ version, capabilities: { extensions: [{ params: { accepts: [], ...(features ? { features } : {}) } }] } }) as never;
    for (const [version, takes] of [["1.0.0+card-runtime", true], ["1.0.0+sha.7.card-runtime", true], ["1.0.0-card-runtime", false], ["1.0.0+card-runtimes", false], ["1.0.0", false]] as const) {
      expect(featuresTaken(card(version)).has("card_runtime"), version).toBe(takes);
    }
    expect(featuresTaken(card("1.0.0", ["card_runtime", "some_later_feature"]))).toEqual(new Set(["card_runtime", "some_later_feature"]));
  });

  it("holds back classes until every other active member takes card_classes, not only card_runtime", async () => {
    const w = await team();
    const wToken = await w.obiToken("obi-wellington");
    const wKey = w.obis.get("obi-wellington")!.key;
    const wOwner = await w.ownerKey("wellington");
    // Both say they take card_runtime; obi-ernesto takes nothing more, and obi-wellington wants to claim a class.
    const wTagged = await makeCard({ sphere: "e2e", obi: "obi-wellington", owner: "wellington", ownerKey: wOwner, obiKey: wKey, cardSeq: 2, issuedAt: w.clock.ts(), version: "0.3.0+card-runtime" });
    expect((await w.call("PUT", "/v0.1/spheres/e2e/members/obi-wellington/card", { token: wToken, body: { card: wTagged } })).status).toBe(200);
    const wToken3 = await w.obiToken("obi-wellington");
    const eToken = await w.obiToken("obi-ernesto");
    const eKey = w.obis.get("obi-ernesto")!.key;
    const eCard = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey: await w.ownerKey("ernesto"), obiKey: eKey, cardSeq: 2, issuedAt: w.clock.ts(), version: "0.3.0+card-runtime" });
    expect((await w.call("PUT", "/v0.1/spheres/e2e/members/obi-ernesto/card", { token: eToken, body: { card: eCard } })).status).toBe(200);
    const claims = { features: ["card_classes", "card_runtime"], classes: ["participant"] };
    const early = await makeCard({ sphere: "e2e", obi: "obi-wellington", owner: "wellington", ownerKey: wOwner, obiKey: wKey, cardSeq: 3, issuedAt: w.clock.ts(), params: claims });
    const refused = await w.call("PUT", "/v0.1/spheres/e2e/members/obi-wellington/card", { token: wToken3, body: { card: early } });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("feature_not_taken");
    expect(refused.body.error.message).toContain("card_classes");
    // Once obi-ernesto's card lists card_classes, it goes in.
    const eNext = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey: await w.ownerKey("ernesto"), obiKey: eKey, cardSeq: 3, issuedAt: w.clock.ts(), params: { features: ["card_classes", "card_runtime"] } });
    expect((await w.call("PUT", "/v0.1/spheres/e2e/members/obi-ernesto/card", { token: await w.obiToken("obi-ernesto"), body: { card: eNext } })).status).toBe(200);
    const now = await w.call("PUT", "/v0.1/spheres/e2e/members/obi-wellington/card", { token: wToken3, body: { card: early } });
    expect(now.status, JSON.stringify(now.body)).toBe(200);
    // A newcomer from before card_classes joins: obi-wellington's card carries classes already, so it
    // can still change its claim; a member whose card carries none can't start one.
    const inv = await w.invite("sangam", "obi-sangam");
    const sKey = await w.ownerKey("sangam");
    const plain = await makeCard({ sphere: "e2e", obi: "obi-sangam", owner: "sangam", ownerKey: sKey, obiKey: await newKey(), issuedAt: w.clock.ts() });
    expect((await w.call("POST", `/v0.1/spheres/e2e/invitations/${inv.body.invitation_id}/redeem`, { body: { secret: inv.body.secret, owner_key: sKey.publicKey, card: plain } })).status).toBe(201);
    const changed = await makeCard({ sphere: "e2e", obi: "obi-wellington", owner: "wellington", ownerKey: wOwner, obiKey: wKey, cardSeq: 4, issuedAt: w.clock.ts(), params: { ...claims, classes: ["participant", "approver"] } });
    const kept = await w.call("PUT", "/v0.1/spheres/e2e/members/obi-wellington/card", { token: wToken3, body: { card: changed } });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    const eClaims = await makeCard({ sphere: "e2e", obi: "obi-ernesto", owner: "ernesto", ownerKey: await w.ownerKey("ernesto"), obiKey: eKey, cardSeq: 4, issuedAt: w.clock.ts(), params: claims });
    const held = await w.call("PUT", "/v0.1/spheres/e2e/members/obi-ernesto/card", { token: await w.obiToken("obi-ernesto"), body: { card: eClaims } });
    expect(held.status).toBe(409);
    expect(held.body.error.code).toBe("feature_not_taken");
  });

  it("is 409 conflict at redeem too, and counts only active members", async () => {
    const w = await team();
    const inv = await w.invite("sangam", "obi-sangam");
    const sKey = await w.ownerKey("sangam");
    const card = await makeCard({ sphere: "e2e", obi: "obi-sangam", owner: "sangam", ownerKey: sKey, obiKey: await newKey(), issuedAt: w.clock.ts(), params: RUNTIME });
    const r = await w.call("POST", `/v0.1/spheres/e2e/invitations/${inv.body.invitation_id}/redeem`, { body: { secret: inv.body.secret, owner_key: sKey.publicKey, card } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("feature_not_taken");
    // With both other members revoked, nothing holds it back.
    const admin = await w.ownerToken();
    for (const obi of ["obi-wellington", "obi-ernesto"]) expect((await w.call("DELETE", `/v0.1/spheres/e2e/members/${obi}`, { token: admin })).status).toBe(200);
    const again = await w.call("POST", `/v0.1/spheres/e2e/invitations/${inv.body.invitation_id}/redeem`, { body: { secret: inv.body.secret, owner_key: sKey.publicKey, card } });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });
});

describe("revocation", () => {
  it("closes the key, marks the member revoked, and answers the same when revoked again", async () => {
    const w = await team();
    const admin = await w.ownerToken();
    w.clock.advance(7);
    const r = await w.call("DELETE", "/v0.1/spheres/e2e/members/obi-ernesto", { token: admin });
    expect(r.status).toBe(200);
    expectSchema("member", r.body);
    expect(r.body.status).toBe("revoked");
    expect(r.body.revoked_at).toBe("2026-10-14T12:00:07Z");
    // Nothing was recorded since the key was opened: an empty range.
    expect(r.body.keys[0].valid_from_seq).toBe(1);
    expect(r.body.keys[0].valid_until_seq).toBe(0);
    w.clock.advance(5);
    const again = await w.call("DELETE", "/v0.1/spheres/e2e/members/obi-ernesto", { token: await w.ownerToken() });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(r.body);
    const active = await w.call("GET", "/v0.1/spheres/e2e/members/obi-wellington", { token: await w.ownerToken() });
    expect(active.body.revoked_at).toBeUndefined();
  });

  it("is for the admin or the Obi's own owner, with an owner token", async () => {
    const w = await team();
    const r = await w.call("DELETE", "/v0.1/spheres/e2e/members/obi-wellington", { token: await w.ownerToken("ernesto", "directory:read") });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("forbidden");
    expect((await w.call("DELETE", "/v0.1/spheres/e2e/members/obi-ernesto", { token: await w.obiToken("obi-ernesto") })).body.error.code).toBe("forbidden");
    const own = await w.call("DELETE", "/v0.1/spheres/e2e/members/obi-ernesto", { token: await w.ownerToken("ernesto", "directory:read") });
    expect(own.status).toBe(200);
    expect((await w.call("DELETE", "/v0.1/spheres/e2e/members/nobody", { token: await w.ownerToken() })).status).toBe(404);
  });
});
