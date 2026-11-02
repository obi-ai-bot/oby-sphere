// The library against the spec's vectors and its reference implementation (spec/conformance/lib/obi.mjs):
// the same keys, the same signatures byte for byte, and each verifies what the other signs.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  Owner, SealKey, SigningKey, actorAssertion, appendEntry, b64url, canonicalize, envelopeSigningInput, fromB64url, newCard, newReply, newRequest,
  openBody, ownerAssertion, parseJwt, rollbackProblem, sealEnvelope, signCard, signEnvelope, verifyAndOpen, verifyCard, verifyChain, verifyEnvelope,
  verifyJws, type Envelope,
} from "../src/index.ts";
// @ts-expect-error: the spec's reference implementation is JavaScript with no types.
import * as ref from "../../spec/conformance/lib/obi.mjs";

const CONFORMANCE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "spec", "conformance");
const read = (name: string) => JSON.parse(readFileSync(join(CONFORMANCE, name), "utf8"));

test("canonical JSON matches every RFC 8785 vector", () => {
  for (const v of read("jcs-vectors.json").vectors) assert.equal(canonicalize(v.input), v.canonical, v.name);
});

test("a key from a conformance seed is the spec's key", async () => {
  const keys = read("keys.json").keys;
  for (const [name, k] of Object.entries(keys) as [string, { seed_string: string; public_key: string; key_id: string }][]) {
    const key = await SigningKey.fromSeedString(k.seed_string);
    assert.equal(key.publicKey, k.public_key, name);
    assert.equal(key.keyId, k.key_id, name);
    const again = await SigningKey.fromSeed(fromB64url(key.seed));
    assert.equal(again.publicKey, key.publicKey);
  }
});

const sphere = "conf-sphere";

async function pair() {
  const a = await SigningKey.fromSeedString("client-test-a");
  const b = await SigningKey.fromSeedString("client-test-b");
  return { a, b, refA: ref.keyFromSeedString("client-test-a"), refB: ref.keyFromSeedString("client-test-b") };
}

test("an envelope the library signs is the reference's, byte for byte, and each verifies the other's", async () => {
  const { a, refA } = await pair();
  const unsigned = newRequest({ sphere, from: "obi-a", to: "obi-b", type: "question", keyId: a.keyId, body: { text: "Is PR 7 ready?" }, now: 1_800_000_000, expiresIn: 3600 });
  const ours = await signEnvelope(unsigned, a);
  const theirs = ref.signEnvelope(unsigned, refA.privateKey);
  assert.equal(ours.signature, theirs.signature);
  assert.deepEqual(Buffer.from(envelopeSigningInput(ours)), ref.envelopeSigningInput(theirs));
  const ctx = { now: "2027-01-15T08:00:00Z", sphere, receiver: "obi-b", keys: { [a.keyId]: { obi: "obi-a", public_key: a.publicKey } } };
  assert.deepEqual(await verifyEnvelope(theirs, ctx), { ok: true });
  assert.deepEqual(ref.verifyEnvelope(ours, ctx), { ok: true });
  const tampered = { ...ours, body: { text: "Is PR 8 ready?" } };
  assert.equal((await verifyEnvelope(tampered, ctx)).ok, false);
  await assert.rejects(signEnvelope({ ...unsigned, key_id: "ed25519:" + "A".repeat(43) }, a), /names/);
});

test("a reply goes to the request's sender and keeps its exchange", async () => {
  const { a, b } = await pair();
  const request = await signEnvelope(newRequest({ sphere, from: "obi-a", to: "obi-b", type: "question", keyId: a.keyId, body: { text: "Ready?" } }), a);
  const reply = newReply(request, { from: "obi-b", type: "answer", keyId: b.keyId, body: { by: "obi", text: "Yes." } });
  assert.equal(reply.to, "obi-a");
  assert.equal(reply.correlation_id, request.id);
  assert.equal(reply.in_reply_to, request.id);
  assert.throws(() => newReply(request, { from: "obi-b", type: "question", keyId: b.keyId, body: {} }), /not a reply/);
  assert.throws(() => newRequest({ sphere, from: "obi-a", to: "obi-b", type: "question", keyId: a.keyId, body: {}, expiresIn: 2592001 }), /expiresIn/);
});

test("a card the owner signs is the reference's and passes both verifiers", async () => {
  const owner = await SigningKey.fromSeedString("client-test-owner");
  const obi = await SigningKey.fromSeedString("client-test-a");
  const unsigned = newCard({
    base: "http://127.0.0.1:8792", sphere, obi_id: "obi-a", owner: "ada", owner_key: owner.publicKey, public_key: obi.publicKey, key_id: obi.keyId,
    accepts: ["question", "review_request"], card_seq: 1, issued_at: "2026-10-14T12:00:00Z", name: "Ada's agent", description: "A delegate.", version: "0.1.0",
  });
  const card = await signCard(unsigned, owner);
  const theirs = ref.signCard(unsigned, ref.keyFromSeedString("client-test-owner").privateKey, owner.keyId);
  assert.deepEqual(card, theirs);
  assert.deepEqual(await verifyCard(card, { now: "2026-10-14T12:00:00Z", bound_owner_key: owner.publicKey }), { ok: true });
  assert.deepEqual(ref.verifyCard(card, { now: "2026-10-14T12:00:00Z" }), { ok: true });
  const other = await SigningKey.generate();
  assert.equal((await verifyCard(card, { bound_owner_key: other.publicKey })).ok, false);
});

test("assertions are the reference's JWTs and verify", async () => {
  const { a, refA } = await pair();
  const owner = await Owner.generate("ada");
  const delegation = await owner.delegation(sphere, "obi-a", { lifetime: 600 });
  const jws = parseJwt(delegation)!;
  assert.equal(jws.claims.iss, "ada");
  assert.deepEqual(jws.claims.may_act, { sub: "obi-a" });
  assert.equal(jws.claims.scope, "send:review_request send:question send:handoff reply receive directory:read audit:read");
  assert.ok(await verifyJws(jws, owner.key.publicKey));
  const actor = await actorAssertion(a, { obi: "obi-a", sphere, now: 1_800_000_000 });
  const claims = parseJwt(actor)!.claims;
  assert.equal(actor, ref.signJwt(claims, refA.privateKey, a.keyId));
  await assert.rejects(ownerAssertion(owner.key, { owner: "ada", sphere, scope: "admin", lifetime: 301 }), /lives/);
});

test("sealing gives the spec's known answers, and opening them gives the words back", async () => {
  const v = read("seal-vectors.json");
  const sealed = await sealEnvelope(v.plain, v.recipient.seal_public_key, fromB64url(v.sender_x25519_private));
  assert.deepEqual(sealed.body, v.sealed.body);
  assert.deepEqual(sealed.seal, v.sealed.seal);
  const key = await SealKey.fromPrivate(fromB64url(v.recipient.x25519_private));
  assert.equal(key.keyId, v.recipient.seal_key_id);
  assert.deepEqual(await openBody(sealed as Envelope, key), v.plain.body);
  const other = await SealKey.generate();
  await assert.rejects(openBody(sealed as Envelope, other));
});

test("a sealed envelope verifies and opens for its receiver only, and both seal or neither", async () => {
  const { a } = await pair();
  const bSeal = await SealKey.generate();
  const unsigned = newRequest({ sphere, from: "obi-a", to: "obi-b", type: "question", keyId: a.keyId, body: { text: "Sealed?", choices: ["yes", "no"] } });
  const env = await signEnvelope(await sealEnvelope(unsigned, bSeal.publicKey), a);
  assert.notEqual((env.body as { text: string }).text, "Sealed?");
  const ctx = { now: Math.floor(Date.now() / 1000), sphere, receiver: "obi-b", keys: { [a.keyId]: { obi: "obi-a", public_key: a.publicKey } } };
  const opened = await verifyAndOpen(env, { ...ctx, seal_keys: { [bSeal.keyId]: bSeal } });
  assert.ok(opened.ok);
  assert.deepEqual((opened as { body: unknown }).body, { text: "Sealed?", choices: ["yes", "no"] });
  assert.equal(ref.verifyEnvelope(env, { ...ctx, now: new Date().toISOString().replace(/\.\d+Z$/, "Z"), seal_keys: { [bSeal.keyId]: bSeal.privateKey } }).ok, true);
  const notMine = await verifyAndOpen(env, { ...ctx, seal_keys: { [(await SealKey.generate()).keyId]: await SealKey.generate() } });
  assert.equal((notMine as { code: string }).code, "seal_invalid");
  const clear = await signEnvelope(unsigned, a);
  const refused = await verifyAndOpen(clear, { ...ctx, seal_keys: { [bSeal.keyId]: bSeal }, sender_seals: true });
  assert.equal((refused as { code: string }).code, "not_sealed");
});

test("a chain the library appends verifies with both verifiers, and a rollback is caught", async () => {
  const { a, b } = await pair();
  const keys = { [a.keyId]: { obi: "obi-a", public_key: a.publicKey, valid_from_seq: 1, valid_until_seq: null }, [b.keyId]: { obi: "obi-b", public_key: b.publicKey, valid_from_seq: 1, valid_until_seq: null } };
  const now = 1_800_000_000;
  const q = await signEnvelope(newRequest({ sphere, from: "obi-a", to: "obi-b", type: "question", keyId: a.keyId, body: { text: "Ready?" }, now }), a);
  const ans = await signEnvelope(newReply(q, { from: "obi-b", type: "answer", keyId: b.keyId, body: { by: "obi", text: "Yes." }, now: now + 5 }), b);
  let entries = await appendEntry([], sphere, q, "2027-01-15T08:00:01Z");
  entries = await appendEntry(entries, sphere, ans, "2027-01-15T08:00:06Z");
  assert.deepEqual(await verifyChain({ sphere, entries }, { keys }), { ok: true });
  assert.deepEqual(ref.verifyChain({ sphere, entries }, { keys }), { ok: true });
  const twice = await appendEntry(entries, sphere, await signEnvelope(newReply(q, { from: "obi-b", type: "answer", keyId: b.keyId, body: { by: "obi", text: "Again." }, now: now + 9 }), b), "2027-01-15T08:00:10Z");
  assert.equal((await verifyChain({ sphere, entries: twice }, { keys })).ok, false);
  assert.equal(rollbackProblem(entries, { head: { seq: 2, hash: entries[1]!.hash }, sends: [{ seq: 1, hash: entries[0]!.hash }] }), null);
  assert.match(rollbackProblem(entries.slice(0, 1), { head: { seq: 2, hash: entries[1]!.hash } })!, /lower/);
  assert.match(rollbackProblem(entries, { sends: [{ seq: 2, hash: entries[0]!.hash }] })!, /send/);
  assert.equal(b64url(new Uint8Array([255])), "_w");
});

test("a card may say what runs its agent (identity.md 2.3), and whether it takes card_runtime", async () => {
  const { takesFeature } = await import("../src/index.ts");
  const owner = await SigningKey.fromSeedString("client-test-owner");
  const obi = await SigningKey.fromSeedString("client-test-a");
  const base = {
    base: "http://127.0.0.1:8792", sphere, obi_id: "obi-a", owner: "ada", owner_key: owner.publicKey, public_key: obi.publicKey, key_id: obi.keyId,
    accepts: ["question"], card_seq: 2, issued_at: "2026-10-14T12:00:00Z", name: "Ada's agent", description: "A delegate.",
  };
  const declared = await signCard(newCard({ ...base, version: "0.1.0", features: ["card_runtime"], runtime: { id: "claude", version: "2.1.204" }, vendors: ["anthropic"] }), owner);
  assert.deepEqual(await verifyCard(declared, { now: "2026-10-14T12:00:00Z" }), { ok: true });
  assert.ok(takesFeature(declared, "card_runtime"));
  const byVersion = await signCard(newCard({ ...base, version: "0.1.0+build.card-runtime" }), owner);
  assert.ok(takesFeature(byVersion, "card_runtime"));
  assert.equal(takesFeature(byVersion, "something_else"), false);
  const plain = await signCard(newCard({ ...base, version: "0.1.0-card-runtime" }), owner);
  assert.equal(takesFeature(plain, "card_runtime"), false);
  const noFeatures = await signCard(newCard({ ...base, version: "0.1.0", runtime: { id: "claude", version: "1" } }), owner);
  assert.equal((await verifyCard(noFeatures, {})).ok, false);
});
