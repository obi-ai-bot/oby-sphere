// Following up, calling a request off and introductions (spec/protocol.md sections 5.17 to 5.19),
// and the Obysphere's rule that a message using an addition needs every active member to take it
// (spec/sphere-api.md section 6.1, checks 11 and 12).

import { describe, expect, it } from "vitest";
import { BRIEF, World, makeCard, newKey } from "./helpers";

const FEATURES = ["cancel", "card_runtime", "card_topics", "follow_up", "introduction"];
const SCOPE = "send:review_request send:question send:introduction reply receive directory:read audit:read";

const RULES = [
  { id: "reviews", from_owner: "*", to_owner: "*", actions: ["review_request"], repos: ["obi-e2e/fixture-app"] },
  { id: "talk", from_owner: "*", to_owner: "*", actions: ["question", "introduction"], repos: ["*"] },
];

/** A team whose members' cards all take #53's features and accept introductions, and a policy
 *  that names introduction; `extra` members, whose cards list no features, join after it. */
async function talking(extra: string[] = []): Promise<World> {
  const w = new World();
  expect((await w.create()).status).toBe(201);
  for (const [owner, obi] of [["wellington", "obi-wellington"], ["ernesto", "obi-ernesto"], ["sangam", "obi-sangam"]] as const) await join(w, owner, obi, FEATURES);
  expect((await w.putPolicy(RULES)).status).toBe(200);
  for (const [owner, obi] of extra.map((o) => [o, `obi-${o}`] as const)) await join(w, owner, obi, null);
  return w;
}

/** Redeems an invitation with a first card that lists `features`, and accepts introductions when they include it. */
async function redeem(w: World, owner: string, obi: string, features: string[] | null) {
  const inv = await w.invite(owner, obi);
  const ownerKey = await w.ownerKey(owner);
  const key = await newKey();
  const accepts = features?.includes("introduction") ? ["review_request", "question", "introduction"] : ["review_request", "question"];
  const card = await makeCard({ sphere: w.sphere, obi, owner, ownerKey, obiKey: key, accepts, issuedAt: w.clock.ts(), ...(features ? { params: { features } } : {}) });
  const r = await w.call("POST", `/v0.1/spheres/${w.sphere}/invitations/${inv.body.invitation_id}/redeem`, { body: { secret: inv.body.secret, owner_key: ownerKey.publicKey, card } });
  if (r.status === 201) w.obis.set(obi, { owner, key, accepts });
  return r;
}

async function join(w: World, owner: string, obi: string, features: string[] | null): Promise<void> {
  const r = await redeem(w, owner, obi, features);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

const token = async (w: World, obi: string) => {
  const r = await w.exchangeObi(obi, { delegation: await w.delegation(obi, SCOPE) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.access_token as string;
};

describe("following up (protocol.md section 5.19)", () => {
  it("takes a request that follows an earlier one between the same two members, either way, and nothing else", async () => {
    const w = await talking();
    const [tw, te, ts] = [await token(w, "obi-wellington"), await token(w, "obi-ernesto"), await token(w, "obi-sangam")];
    const q1 = await w.envelope("obi-wellington", "obi-ernesto", "question", { text: "Should average() round?" });
    expect((await w.send(q1, tw)).status).toBe(202);
    const q2 = await w.envelope("obi-wellington", "obi-ernesto", "question", { text: "And for an empty list?", follows: q1.id });
    expect((await w.send(q2, tw)).status).toBe(202);
    const back = await w.envelope("obi-ernesto", "obi-wellington", "question", { text: "Which list do you mean?", follows: q2.id });
    expect((await w.send(back, te)).status).toBe(202);
    const unknown = await w.envelope("obi-wellington", "obi-ernesto", "question", { text: "Again?", follows: crypto.randomUUID() });
    expect((await w.send(unknown, tw)).body.error.code).toBe("bad_reply");
    const others = await w.envelope("obi-sangam", "obi-ernesto", "question", { text: "Is it settled?", follows: q1.id });
    const r = await w.send(others, ts);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("bad_reply");
  });
});

describe("calling a request off (protocol.md section 5.17)", () => {
  it("lets the request's sender cancel it, ends the exchange, and refuses a cancel from its receiver", async () => {
    const w = await talking();
    const [tw, te] = [await token(w, "obi-wellington"), await token(w, "obi-ernesto")];
    const review = await w.envelope("obi-wellington", "obi-ernesto", "review_request", BRIEF);
    expect((await w.send(review, tw)).status).toBe(202);
    expect((await w.send(await w.reply(review, "accept", {}), te)).status).toBe(202);
    const cancel = await w.envelope("obi-wellington", "obi-ernesto", "cancel", {}, { correlation_id: review.id, in_reply_to: review.id });
    expect((await w.send(cancel, tw)).status).toBe(202);
    const late = await w.reply(review, "status", { state: "working" });
    expect((await w.send(late, te)).body.error.code).toBe("bad_reply");
    const q = await w.envelope("obi-wellington", "obi-ernesto", "question", { text: "Still needed?" });
    expect((await w.send(q, tw)).status).toBe(202);
    const wrong = await w.reply(q, "cancel", {});
    expect((await w.send(wrong, te)).body.error.code).toBe("bad_reply");
  });
});

describe("introductions (protocol.md section 5.18)", () => {
  it("introduces an active member, takes the receiver's accept, which ends it, and refuses a member who isn't one", async () => {
    const w = await talking();
    const [tw, te] = [await token(w, "obi-wellington"), await token(w, "obi-ernesto")];
    const intro = await w.envelope("obi-wellington", "obi-ernesto", "introduction", { member: "obi-sangam", note: "You both work on the fixture app's tests." });
    expect((await w.send(intro, tw)).status).toBe(202);
    expect((await w.send(await w.reply(intro, "accept", {}), te)).status).toBe(202);
    expect((await w.send(await w.reply(intro, "decline", { reason: "other" }), te)).body.error.code).toBe("bad_reply");
    const nobody = await w.envelope("obi-wellington", "obi-ernesto", "introduction", { member: "obi-nobody" });
    expect((await w.send(nobody, tw)).body.error.code).toBe("not_found");
    const self = await w.envelope("obi-wellington", "obi-ernesto", "introduction", { member: "obi-wellington" });
    expect((await w.send(self, tw)).body.error.code).toBe("invalid_envelope");
    // It needs send:introduction.
    const narrow = await w.obiToken("obi-wellington");
    const again = await w.envelope("obi-wellington", "obi-ernesto", "introduction", { member: "obi-sangam" });
    expect((await w.send(again, narrow)).body.error.code).toBe("insufficient_scope");
  });
});

describe("a message that uses an addition (sphere-api.md section 6.1, check 11)", () => {
  it("is 409 feature_not_taken while an active member's card doesn't take its feature, since every member verifies the chain", async () => {
    const w = await talking(["dana"]);
    const tw = await token(w, "obi-wellington");
    const q1 = await w.envelope("obi-wellington", "obi-ernesto", "question", { text: "Should average() round?" });
    expect((await w.send(q1, tw)).status).toBe(202);
    const followUp = await w.envelope("obi-wellington", "obi-ernesto", "question", { text: "And for an empty list?", follows: q1.id });
    const r = await w.send(followUp, tw);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("feature_not_taken");
    expect(r.body.error.message).toContain("obi-dana");
    const cancel = await w.envelope("obi-wellington", "obi-ernesto", "cancel", {}, { correlation_id: q1.id, in_reply_to: q1.id });
    expect((await w.send(cancel, tw)).body.error.code).toBe("feature_not_taken");
    const intro = await w.envelope("obi-wellington", "obi-ernesto", "introduction", { member: "obi-sangam" });
    expect((await w.send(intro, tw)).body.error.code).toBe("feature_not_taken");
    // Plain messages still go.
    const plain = await w.envelope("obi-wellington", "obi-ernesto", "question", { text: "Plain words still go." });
    expect((await w.send(plain, tw)).status).toBe(202);
  });
});

describe("a card or a policy that uses an addition (sphere-api.md sections 4 and 5)", () => {
  it("holds back topics, and a card that accepts introductions, until every other active member takes them", async () => {
    const w = await talking();
    // obi-dana takes card_runtime and nothing more.
    await join(w, "dana", "obi-dana", ["card_runtime"]);
    const early = await redeem(w, "kofi", "obi-kofi", ["card_runtime", "introduction"]);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("feature_not_taken");
    expect(early.body.error.message).toContain("obi-dana");
    expect(early.body.error.message).toContain("introduction");
    const wKey = w.obis.get("obi-wellington")!.key;
    const accepts = ["review_request", "question", "introduction"];
    const topics = await makeCard({ sphere: w.sphere, obi: "obi-wellington", owner: "wellington", ownerKey: await w.ownerKey("wellington"), obiKey: wKey, accepts, cardSeq: 2, issuedAt: w.clock.ts(), params: { features: FEATURES, topics: ["payments"] } });
    const r = await w.call("PUT", `/v0.1/spheres/${w.sphere}/members/obi-wellington/card`, { token: await w.obiToken("obi-wellington"), body: { card: topics } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("feature_not_taken");
    expect(r.body.error.message).toContain("obi-dana");
    expect(r.body.error.message).toContain("card_topics");
  });

  it("holds back a policy rule that names introduction until every active member takes it, unless the policy names it already", async () => {
    const w = new World();
    expect((await w.create()).status).toBe(201);
    await join(w, "wellington", "obi-wellington", FEATURES);
    await join(w, "dana", "obi-dana", null);
    const refused = await w.putPolicy(RULES);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("feature_not_taken");
    expect(refused.body.error.message).toContain("obi-dana");
    expect((await w.putPolicy(RULES.slice(0, 1))).status).toBe(200);
  });

  it("lets the admin keep a rule that names introduction when a member from before joins after it", async () => {
    const w = await talking(["dana"]);
    expect((await w.putPolicy(RULES, 1)).status).toBe(200);
  });
});
