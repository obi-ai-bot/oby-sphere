// Artifacts (spec/protocol.md sections 4, rule 11, and 5.20 to 5.24): the six actions behind the
// feature `artifacts`, the `artifact` reference, what an artifact_offer's exchange takes, the text
// limits, the members' rule, the scope `send:artifact_offer`, and a card that accepts them.

import { describe, expect, it } from "vitest";
import { World, ageFile, makeCard, newKey, newSealKey, sealedText, uploadBlob, type SealKey } from "./helpers";

const FEATURES = ["artifacts", "card_runtime"];
const SCOPE = "send:question send:artifact_offer reply receive directory:read audit:read";
const SHARING = { id: "sharing", from_owner: "*", to_owner: "*", actions: ["artifact_offer", "question"], repos: ["*"] };

const seals = new Map<string, SealKey>();
const sealFor = (obi: string) => ({ suite: "x25519-hkdf-sha256-chacha20poly1305", key_id: seals.get(obi)!.keyId, enc: sealedText(16) });

/** An invitation from ana, the Obysphere's admin. */
const invite = async (w: World, owner: string, obi: string) =>
  w.call("POST", `/v0.1/spheres/${w.sphere}/invitations`, { token: await w.ownerToken("ana"), body: { owner, obi, expires_in: 3600 } });

/** Redeems an invitation with a card that lists `features` and has a seal key; it accepts artifact_offer when they include artifacts. */
async function redeem(w: World, owner: string, obi: string, features: string[] | null, accepts?: string[]) {
  const inv = await invite(w, owner, obi);
  const ownerKey = await w.ownerKey(owner);
  const key = await newKey();
  const seal = await newSealKey();
  seals.set(obi, seal);
  const takes = accepts ?? (features?.includes("artifacts") ? ["question", "artifact_offer"] : ["question"]);
  const card = await makeCard({ sphere: w.sphere, obi, owner, ownerKey, obiKey: key, accepts: takes, seal, issuedAt: w.clock.ts(), ...(features ? { params: { features } } : {}) });
  const r = await w.call("POST", `/v0.1/spheres/${w.sphere}/invitations/${inv.body.invitation_id}/redeem`, { body: { secret: inv.body.secret, owner_key: ownerKey.publicKey, card } });
  if (r.status === 201) w.obis.set(obi, { owner, key, accepts: takes });
  return r;
}

/** ana, ben and cleo, every card taking artifacts, and a rule that lets them share; `extra` join after it with no features. */
async function sharing(extra: string[] = []): Promise<World> {
  const w = new World();
  expect((await w.create("ana")).status).toBe(201);
  for (const name of ["ana", "ben", "cleo"]) expect((await redeem(w, name, `obi-${name}`, FEATURES)).status).toBe(201);
  const policy = await w.call("PUT", `/v0.1/spheres/${w.sphere}/policy`, { token: await w.ownerToken("ana"), body: { expected_version: 0, rules: [SHARING] } });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);
  // The blobs the messages below name: ana's for ben and for cleo, and ben's for ana.
  uploaded.clear();
  for (const [from, to] of [["obi-ana", "obi-ben"], ["obi-ana", "obi-cleo"], ["obi-ben", "obi-ana"]] as const) {
    const r = await uploadBlob(w, await token(w, from), [to], ageFile(1, 4000));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    uploaded.set(`${from}>${to}`, r.body);
  }
  for (const name of extra) expect((await redeem(w, name, `obi-${name}`, null)).status).toBe(201);
  return w;
}
const uploaded = new Map<string, { id: string; sha256: string; bytes: number; expires: string }>();

const token = async (w: World, obi: string, scope = SCOPE) => {
  const r = await w.exchangeObi(obi, { delegation: await w.delegation(obi, scope) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.access_token as string;
};

const ARTIFACT = "8a6c1f4e-5d2b-4c7a-9e3f-1b2c3d4e5f60";
/** What an offer says, its words sealed: the Obysphere sees only their size. */
const artifact = (version: number, title = sealedText(30)) => ({ id: ARTIFACT, title, kind: "html", version, bytes: 48213, files: 4, sha256: "c".repeat(64) });
/** The blob `from` uploaded for `to` (sharing() uploads them), or one the Obysphere doesn't have. */
const blob = (from = "obi-ana", to = "obi-ben") => {
  const b = uploaded.get(`${from}>${to}`);
  return b ? { id: b.id, sha256: b.sha256, bytes: b.bytes, expires: b.expires } : { id: crypto.randomUUID(), sha256: "d".repeat(64), bytes: 51900, expires: "2026-10-21T12:00:00Z" };
};
const offer = (access: string, extra: Record<string, unknown> = {}) => ({ artifact: artifact(3), blob: blob(), access, latest: true, ask: sealedText(60), ...extra });

async function offerFrom(w: World, from: string, to: string, body: Record<string, unknown>, t: string) {
  const env = await w.envelope(from, to, "artifact_offer", body, { seal: sealFor(to) });
  const r = await w.send(env, t);
  return { env, r };
}
const reply = (w: World, request: Record<string, unknown>, type: string, body: Record<string, unknown>) => w.reply(request, type, body, { seal: sealFor(request.from as string) });
const fromSender = (w: World, request: Record<string, unknown>, type: string, body: Record<string, unknown>) =>
  w.envelope(request.from as string, request.to as string, type, body, { correlation_id: request.id, in_reply_to: request.id, seal: sealFor(request.to as string) });
const comment = (version = 3) => ({ by: "owner", text: sealedText(40), refs: [{ kind: "artifact", artifact: ARTIFACT, version }] });

describe("artifacts (protocol.md sections 5.20 to 5.24)", () => {
  it("is a feature this Obysphere takes", async () => {
    const r = await new World().call("GET", "/v0.1/features");
    expect(r.body.features).toContain("artifacts");
  });

  it("relays a share to comment on: comments that don't end it, a new version, the share taken back and the receipt, then nothing", async () => {
    const w = await sharing();
    const [ta, tb] = [await token(w, "obi-ana"), await token(w, "obi-ben")];
    const { env: o, r } = await offerFrom(w, "obi-ana", "obi-ben", offer("comment"), ta);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect((await w.send(await reply(w, o, "answer", comment()), tb)).status).toBe(202);
    expect((await w.send(await fromSender(w, o, "artifact_update", { artifact: artifact(4), blob: blob(), latest: true }), ta)).status).toBe(202);
    expect((await w.send(await reply(w, o, "answer", comment(4)), tb)).status).toBe(202);
    // comment, not edit: no version back.
    const version = await w.send(await reply(w, o, "artifact_version", { artifact: artifact(1), blob: blob("obi-ben", "obi-ana") }), tb);
    expect(version.status).toBe(409);
    expect(version.body.error.code).toBe("bad_reply");
    // A receipt before anyone took it back says nothing true.
    expect((await w.send(await reply(w, o, "artifact_receipt", {}), tb)).body.error.code).toBe("bad_reply");
    expect((await w.send(await fromSender(w, o, "artifact_revoke", {}), ta)).status).toBe(202);
    // Taken back: no more versions, no more comments; one receipt, then nothing.
    expect((await w.send(await fromSender(w, o, "artifact_update", { artifact: artifact(5), blob: blob(), latest: true }), ta)).body.error.code).toBe("bad_reply");
    expect((await w.send(await reply(w, o, "answer", comment()), tb)).body.error.code).toBe("bad_reply");
    expect((await w.send(await reply(w, o, "artifact_receipt", {}), tb)).status).toBe(202);
    expect((await w.send(await reply(w, o, "artifact_receipt", {}), tb)).body.error.code).toBe("bad_reply");
  });

  it("takes a version back only on a share that gives edit, and a comment only on one that gives more than view", async () => {
    const w = await sharing();
    const [ta, tb] = [await token(w, "obi-ana"), await token(w, "obi-ben")];
    const { env: edit } = await offerFrom(w, "obi-ana", "obi-ben", offer("edit"), ta);
    expect((await w.send(await reply(w, edit, "artifact_version", { artifact: artifact(1), blob: blob("obi-ben", "obi-ana") }), tb)).status).toBe(202);
    // A version of another artifact is not this share's.
    const other = await w.send(await reply(w, edit, "artifact_version", { artifact: { ...artifact(2), id: crypto.randomUUID() }, blob: blob("obi-ben", "obi-ana") }), tb);
    expect(other.body.error.code).toBe("bad_reply");
    const { ask: _ask, ...viewOnly } = offer("view");
    const { env: view } = await offerFrom(w, "obi-ana", "obi-ben", viewOnly, ta);
    const r = await w.send(await reply(w, view, "answer", comment()), tb);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("bad_reply");
    // An update that gives edit lets a version come back; one that takes it away stops it.
    expect((await w.send(await fromSender(w, view, "artifact_update", { artifact: artifact(4), blob: blob(), latest: true, access: "edit" }), ta)).status).toBe(202);
    expect((await w.send(await reply(w, view, "artifact_version", { artifact: artifact(1), blob: blob("obi-ben", "obi-ana") }), tb)).status).toBe(202);
    expect((await w.send(await fromSender(w, view, "artifact_update", { artifact: artifact(5), blob: blob(), latest: true, access: "view" }), ta)).status).toBe(202);
    expect((await w.send(await reply(w, view, "artifact_version", { artifact: artifact(2), blob: blob("obi-ben", "obi-ana") }), tb)).body.error.code).toBe("bad_reply");
    // A pinned share takes no update; the receiver sends none; a decline ends it.
    const { env: pinned } = await offerFrom(w, "obi-ana", "obi-ben", offer("comment", { latest: false }), ta);
    expect((await w.send(await fromSender(w, pinned, "artifact_update", { artifact: artifact(4), blob: blob(), latest: true }), ta)).body.error.code).toBe("bad_reply");
    expect((await w.send(await reply(w, pinned, "artifact_update", { artifact: artifact(4), blob: blob(), latest: true }), tb)).body.error.code).toBe("bad_reply");
    expect((await w.send(await reply(w, pinned, "accept", {}), tb)).body.error.code).toBe("bad_reply");
    expect((await w.send(await reply(w, pinned, "decline", { reason: "owner_declined" }), tb)).status).toBe(202);
    expect((await w.send(await reply(w, pinned, "answer", comment()), tb)).body.error.code).toBe("bad_reply");
  });

  it("is 409 feature_not_taken while any active member's card doesn't take artifacts, naming it, since every member verifies the chain", async () => {
    const w = await sharing(["dana"]);
    const ta = await token(w, "obi-ana");
    // To ben, who takes it: dana, who doesn't, would read it in the chain.
    const { r } = await offerFrom(w, "obi-ana", "obi-ben", offer("comment"), ta);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("feature_not_taken");
    expect(r.body.error.message).toContain("obi-dana");
    expect(r.body.error.message).toContain("artifacts");
    // To dana: her card doesn't accept artifact_offer at all.
    const toDana = await w.send(await w.envelope("obi-ana", "obi-dana", "artifact_offer", offer("comment"), { seal: sealFor("obi-dana") }), ta);
    expect(toDana.status).toBe(403);
    expect(toDana.body.error.code).toBe("policy_denied");
    // A question that names an artifact uses the feature too; a plain one still goes.
    const about = await w.envelope("obi-ana", "obi-ben", "question", { text: sealedText(20), about: [{ kind: "artifact", artifact: ARTIFACT }] }, { seal: sealFor("obi-ben") });
    expect((await w.send(about, ta)).body.error.code).toBe("feature_not_taken");
    const plain = await w.envelope("obi-ana", "obi-ben", "question", { text: sealedText(20) }, { seal: sealFor("obi-ben") });
    expect((await w.send(plain, ta)).status).toBe(202);
  });

  it("needs a policy rule that names artifact_offer, which waits until every member takes the feature", async () => {
    const w = new World();
    expect((await w.create("ana")).status).toBe(201);
    for (const name of ["ana", "ben"]) expect((await redeem(w, name, `obi-${name}`, FEATURES)).status).toBe(201);
    const ta = await token(w, "obi-ana");
    const { r } = await offerFrom(w, "obi-ana", "obi-ben", offer("comment"), ta);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("policy_denied");
    expect((await redeem(w, "dana", "obi-dana", null)).status).toBe(201);
    const held = await w.call("PUT", `/v0.1/spheres/${w.sphere}/policy`, { token: await w.ownerToken("ana"), body: { expected_version: 0, rules: [SHARING] } });
    expect(held.status).toBe(409);
    expect(held.body.error.code).toBe("feature_not_taken");
    expect(held.body.error.message).toContain("obi-dana");
  });

  it("needs send:artifact_offer, which a token holds in its canonical place", async () => {
    const w = await sharing();
    const narrow = await token(w, "obi-ana", "send:question reply receive");
    const { r } = await offerFrom(w, "obi-ana", "obi-ben", offer("comment"), narrow);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("insufficient_scope");
    const t = await w.exchangeObi("obi-ana", { delegation: await w.delegation("obi-ana", "reply send:artifact_offer receive send:question") });
    expect(t.body.scope).toBe("send:question send:artifact_offer reply receive");
  });

  it("refuses text past its limits, words where there are none, and a key or a file in the message", async () => {
    const w = await sharing();
    const [ta, tb] = [await token(w, "obi-ana"), await token(w, "obi-ben")];
    const send = async (body: Record<string, unknown>, seal = true) =>
      (await w.send(await w.envelope("obi-ana", "obi-ben", "artifact_offer", body, seal ? { seal: sealFor("obi-ben") } : {}), ta)).body.error?.code;
    // 2,000 characters sealed is at most 10,688 base64url characters; one more is refused.
    expect(await send(offer("comment", { ask: "A".repeat(10688) }))).toBeUndefined();
    expect(await send(offer("comment", { ask: "A".repeat(10689) }))).toBe("invalid_envelope");
    expect(await send(offer("comment", { note: sealedText(20) }))).toBe("invalid_envelope");
    expect(await send(offer("comment", { key: "AGE-SECRET-KEY-1NOTAREALKEY" }))).toBe("invalid_envelope");
    expect(await send(offer("comment", { files: { "index.html": "<p>hi</p>" } }))).toBe("invalid_envelope");
    expect(await send(offer("comment", { artifact: { ...artifact(3), path: "/Users/ana" } }))).toBe("invalid_envelope");
    expect(await send(offer("comment", { blob: { ...blob(), bytes: 67108865 } }))).toBe("invalid_envelope");
    // A comment is at most 2,000 characters too.
    const { env: o } = await offerFrom(w, "obi-ana", "obi-ben", offer("comment"), ta);
    expect((await w.send(await reply(w, o, "answer", { ...comment(), text: "A".repeat(10689) }), tb)).body.error.code).toBe("invalid_envelope");
    expect((await w.send(await reply(w, o, "answer", { ...comment(), refs: [{ kind: "artifact", artifact: ARTIFACT, repo: "acme/app" }] }), tb)).body.error.code).toBe("invalid_envelope");
    // Between two members who seal, nothing goes in the clear.
    expect(await send(offer("comment", { ask: "Does the header work?", artifact: artifact(3, "Checkout") }), false)).toBe("not_sealed");
  });

  it("takes a card that accepts artifact_offer only with the feature and a seal key, and only once every member takes it", async () => {
    const w = new World();
    expect((await w.create("ana")).status).toBe(201);
    expect((await redeem(w, "ana", "obi-ana", FEATURES)).status).toBe(201);
    // No feature listed: the card doesn't match its schema, so neither does the redeem's body.
    const bad = await redeem(w, "ben", "obi-ben", ["card_runtime"], ["question", "artifact_offer"]);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("bad_request");
    expect((await redeem(w, "dana", "obi-dana", ["card_runtime"])).status).toBe(201);
    // dana takes card_runtime only: a card that accepts artifacts waits for her.
    const early = await redeem(w, "kofi", "obi-kofi", FEATURES);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("feature_not_taken");
    expect(early.body.error.message).toContain("obi-dana");
    // A card with no seal key can't accept artifacts: they are wrapped to it.
    const inv = await invite(w, "lee", "obi-lee");
    const ownerKey = await w.ownerKey("lee");
    const card = await makeCard({ sphere: w.sphere, obi: "obi-lee", owner: "lee", ownerKey, obiKey: await newKey(), accepts: ["question", "artifact_offer"], issuedAt: w.clock.ts(), params: { features: FEATURES } });
    const noSeal = await w.call("POST", `/v0.1/spheres/${w.sphere}/invitations/${inv.body.invitation_id}/redeem`, { body: { secret: inv.body.secret, owner_key: ownerKey.publicKey, card } });
    expect(noSeal.status).toBe(400);
    expect(noSeal.body.error.code).toBe("bad_request");
  });
});
