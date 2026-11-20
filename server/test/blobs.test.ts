// Artifacts' blobs (spec/sphere-api.md section 10): ciphertext only, in the ARTIFACTS bucket,
// fetched only by a member it is for and only until it expires, never after its share was taken
// back, and deleted only by its uploader; and an offer that names one only when it is the
// sender's, for the receiver, as the offer says (section 6.1, check 12).

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { World, ageFile, expectSchema, makeCall, makeCard, newKey, newSealKey, sealedText, uploadBlob, type SealKey } from "./helpers";

const FEATURES = ["artifacts", "card_runtime"];
const SCOPE = "send:artifact_offer reply receive directory:read audit:read";
const SHARING = { id: "sharing", from_owner: "*", to_owner: "*", actions: ["artifact_offer"], repos: ["*"] };
const MIB64 = 67108864;

const seals = new Map<string, SealKey>();
const sealFor = (obi: string) => ({ suite: "x25519-hkdf-sha256-chacha20poly1305", key_id: seals.get(obi)!.keyId, enc: sealedText(16) });

/** ana (the admin), ben and cleo, each card taking artifacts, and a rule that lets them share. */
async function sharing(): Promise<World> {
  const w = new World();
  expect((await w.create("ana")).status).toBe(201);
  for (const owner of ["ana", "ben", "cleo"]) {
    const obi = `obi-${owner}`;
    const inv = await w.call("POST", `/v0.1/spheres/${w.sphere}/invitations`, { token: await w.ownerToken("ana"), body: { owner, obi, expires_in: 3600 } });
    const ownerKey = await w.ownerKey(owner);
    const key = await newKey();
    const seal = await newSealKey();
    seals.set(obi, seal);
    const accepts = ["artifact_offer"];
    const card = await makeCard({ sphere: w.sphere, obi, owner, ownerKey, obiKey: key, accepts, seal, issuedAt: w.clock.ts(), params: { features: FEATURES } });
    const r = await w.call("POST", `/v0.1/spheres/${w.sphere}/invitations/${inv.body.invitation_id}/redeem`, { body: { secret: inv.body.secret, owner_key: ownerKey.publicKey, card } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    w.obis.set(obi, { owner, key, accepts });
  }
  const policy = await w.call("PUT", `/v0.1/spheres/${w.sphere}/policy`, { token: await w.ownerToken("ana"), body: { expected_version: 0, rules: [SHARING] } });
  expect(policy.status).toBe(200);
  return w;
}

const token = async (w: World, obi: string, scope = SCOPE) => {
  const r = await w.exchangeObi(obi, { delegation: await w.delegation(obi, scope) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.access_token as string;
};
const tokens = async (w: World) => ({ ana: await token(w, "obi-ana"), ben: await token(w, "obi-ben"), cleo: await token(w, "obi-cleo") });

const fetchBlob = (w: World, id: string, t: string) => w.call("GET", `/v0.1/spheres/${w.sphere}/blobs/${id}`, { token: t });
const deleteBlob = (w: World, id: string, t: string) => w.call("DELETE", `/v0.1/spheres/${w.sphere}/blobs/${id}`, { token: t });
/** What the bucket holds under this Sphere's blobs: their keys. */
const held = async (w: World) => (await env.ARTIFACTS!.list({ prefix: `blobs/${w.sphere}/` })).objects.map((o) => o.key);
const hex = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

const ARTIFACT = "8a6c1f4e-5d2b-4c7a-9e3f-1b2c3d4e5f60";
const artifact = (version: number) => ({ id: ARTIFACT, title: sealedText(30), kind: "html", version, bytes: 48213, files: 4, sha256: "c".repeat(64) });
const ref = (b: { id: string; sha256: string; bytes: number; expires: string }) => ({ id: b.id, sha256: b.sha256, bytes: b.bytes, expires: b.expires });
const offerOf = (blob: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ artifact: artifact(3), blob, access: "edit", latest: true, ...extra });
const sendOffer = async (w: World, from: string, to: string, body: Record<string, unknown>, t: string) => {
  const env_ = await w.envelope(from, to, "artifact_offer", body, { seal: sealFor(to) });
  return { env: env_, r: await w.send(env_, t) };
};
const fromSender = (w: World, request: Record<string, unknown>, type: string, body: Record<string, unknown>) =>
  w.envelope(request.from as string, request.to as string, type, body, { correlation_id: request.id, in_reply_to: request.id, seal: sealFor(request.to as string) });

describe("blobs (sphere-api.md section 10)", () => {
  it("keeps one upload for every member it names, byte for byte, and answers its id, hash, size and expiry", async () => {
    const w = await sharing();
    const t = await tokens(w);
    const bytes = ageFile(2, 5000);
    const r = await uploadBlob(w, t.ana, ["obi-cleo", "obi-ben"], bytes);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expectSchema("blobResponse", r.body);
    expect(r.body).toMatchObject({ sha256: await hex(bytes), bytes: bytes.length, expires: w.clock.ts(7 * 86400), to: ["obi-ben", "obi-cleo"] });
    expect(await held(w)).toEqual([`blobs/${w.sphere}/${r.body.id}`]);
    for (const reader of [t.ben, t.cleo]) {
      const got = await w.call("GET", `/v0.1/spheres/${w.sphere}/blobs/${r.body.id}`, { token: reader });
      expect(got.status).toBe(200);
      expect(got.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(got.headers.get("Cache-Control")).toBe("no-store");
      expect(got.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
    // The bytes come back exactly as they went up.
    const raw = await env.ARTIFACTS!.get(`blobs/${w.sphere}/${r.body.id}`);
    expect(new Uint8Array(await raw!.arrayBuffer())).toEqual(bytes);
  });

  it("refuses what isn't ciphertext for every member it names, and keeps nothing of it", async () => {
    const w = await sharing();
    const t = await tokens(w);
    const plaintext = new TextEncoder().encode("<html><title>Checkout page, second pass</title></html>");
    const notAge = await uploadBlob(w, t.ana, ["obi-ben"], plaintext);
    expect(notAge.status).toBe(400);
    expect(notAge.body.error.code).toBe("bad_request");
    expect(notAge.body.error.message).toContain("age file");
    // Two members named, one key wrapped: the other couldn't open it.
    const oneKey = await uploadBlob(w, t.ana, ["obi-ben", "obi-cleo"], ageFile(1, 100));
    expect(oneKey.status).toBe(400);
    expect(oneKey.body.error.message).toContain("1 X25519 key(s) for 2 recipient(s)");
    // An age header that never ends.
    const endless = await uploadBlob(w, t.ana, ["obi-ben"], new TextEncoder().encode("age-encryption.org/v1\n-> X25519 aaaa\nbbbb\n"));
    expect(endless.status).toBe(400);
    expect(await held(w)).toEqual([]);
    // A later part of a ciphertext over 64 MiB has no header of its own.
    const second = await uploadBlob(w, t.ana, ["obi-ben"], crypto.getRandomValues(new Uint8Array(1000)), { query: "&part=2" });
    expect(second.status).toBe(201);
    expect((await uploadBlob(w, t.ana, ["obi-ben"], ageFile(1, 10), { query: "&part=9" })).status).toBe(400);
  });

  it("takes a blob of 64 MiB and refuses one byte more, before reading it", async () => {
    const w = await sharing();
    const t = await tokens(w);
    const full = ageFile(1, MIB64 - 200);
    const big = new Uint8Array(MIB64);
    big.set(full.subarray(0, MIB64));
    const ok = await uploadBlob(w, t.ana, ["obi-ben"], big);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.bytes).toBe(MIB64);
    const over = await uploadBlob(w, t.ana, ["obi-ben"], new Uint8Array(10), { length: String(MIB64 + 1) });
    expect(over.status).toBe(413);
    expect(over.body.error.code).toBe("payload_too_large");
    // A body longer or shorter than it says.
    expect((await uploadBlob(w, t.ana, ["obi-ben"], ageFile(1, 100), { length: "50" })).status).toBe(400);
    expect((await uploadBlob(w, t.ana, ["obi-ben"], ageFile(1, 100), { length: "5000" })).status).toBe(400);
    expect(await held(w)).toHaveLength(1);
  });

  it("checks who uploads, for whom and until when", async () => {
    const w = await sharing();
    const t = await tokens(w);
    const file = ageFile(1, 100);
    const code = async (r: Promise<{ status: number; body: { error?: { code: string } } }>) => (await r).body.error?.code;
    expect(await code(uploadBlob(w, t.ana, ["obi-nobody"], file))).toBe("unknown_recipient");
    expect(await code(uploadBlob(w, t.ana, ["obi-ana"], file))).toBe("bad_request");
    expect(await code(uploadBlob(w, t.ana, ["obi-ben", "obi-ben"], ageFile(2, 10)))).toBe("bad_request");
    expect(await code(uploadBlob(w, t.ana, [], file))).toBe("bad_request");
    expect(await code(uploadBlob(w, t.ana, ["obi-ben"], file, { expiresIn: 2592001 }))).toBe("bad_request");
    expect(await code(uploadBlob(w, t.ana, ["obi-ben"], file, { expiresIn: 0 }))).toBe("bad_request");
    expect(await code(uploadBlob(w, t.ana, ["obi-ben"], file, { contentType: "text/html" }))).toBe("bad_request");
    expect(await code(uploadBlob(w, t.ana, ["obi-ben"], file, { query: "&public=1" }))).toBe("bad_request");
    expect(await code(uploadBlob(w, await token(w, "obi-ana", "receive"), ["obi-ben"], file))).toBe("insufficient_scope");
    expect(await code(uploadBlob(w, await w.ownerToken("ana"), ["obi-ben"], file))).toBe("forbidden");
    // reply alone uploads too: a version sent back is a reply.
    expect((await uploadBlob(w, await token(w, "obi-ben", "reply"), ["obi-ana"], file)).status).toBe(201);
  });

  it("serves a blob only to a member it is for, and only until it expires, then deletes it", async () => {
    const w = await sharing();
    const t = await tokens(w);
    const r = await uploadBlob(w, t.ana, ["obi-ben"], ageFile(1, 100), { expiresIn: 600 });
    // cleo isn't named, and its uploader doesn't fetch it either: both get the same 404 as for nothing.
    for (const other of [t.cleo, t.ana]) {
      const got = await fetchBlob(w, r.body.id, other);
      expect(got.status).toBe(404);
      expect(got.body.error.code).toBe("not_found");
    }
    expect((await fetchBlob(w, crypto.randomUUID(), t.ben)).status).toBe(404);
    expect((await fetchBlob(w, r.body.id, await token(w, "obi-ben", "reply"))).body.error.code).toBe("insufficient_scope");
    expect((await fetchBlob(w, r.body.id, t.ben)).status).toBe(200);
    w.clock.advance(600);
    const late = await fetchBlob(w, r.body.id, t.ben);
    expect(late.status).toBe(400);
    expect(late.body.error.code).toBe("expired");
    expect(await held(w)).toEqual([]);
  });

  it("lets only its uploader delete a blob", async () => {
    const w = await sharing();
    const t = await tokens(w);
    const r = await uploadBlob(w, t.ana, ["obi-ben"], ageFile(1, 100));
    const byRecipient = await deleteBlob(w, r.body.id, t.ben);
    expect(byRecipient.status).toBe(403);
    expect(byRecipient.body.error.code).toBe("forbidden");
    expect((await deleteBlob(w, r.body.id, t.cleo)).status).toBe(404);
    expect(await held(w)).toHaveLength(1);
    expect((await deleteBlob(w, r.body.id, t.ana)).status).toBe(204);
    expect(await held(w)).toEqual([]);
    expect((await fetchBlob(w, r.body.id, t.ben)).status).toBe(404);
    expect((await deleteBlob(w, r.body.id, t.ana)).status).toBe(404);
  });

  it("relays an offer only for a blob its sender uploaded for its receiver, as the offer says", async () => {
    const w = await sharing();
    const t = await tokens(w);
    const forBen = (await uploadBlob(w, t.ana, ["obi-ben"], ageFile(1, 100))).body;
    const forCleo = (await uploadBlob(w, t.ana, ["obi-cleo"], ageFile(1, 100))).body;
    const bensOwn = (await uploadBlob(w, t.ben, ["obi-cleo"], ageFile(1, 100))).body;
    const refused = async (blob: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const { r } = await sendOffer(w, "obi-ana", "obi-ben", offerOf(blob, extra), t.ana);
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      return r.body.error.code;
    };
    expect(await refused(ref(forCleo))).toBe("conflict");
    expect(await refused(ref(bensOwn))).toBe("conflict");
    expect(await refused({ ...ref(forBen), id: crypto.randomUUID() })).toBe("conflict");
    expect(await refused({ ...ref(forBen), sha256: "0".repeat(64) })).toBe("conflict");
    expect(await refused({ ...ref(forBen), bytes: forBen.bytes + 1 })).toBe("conflict");
    expect(await refused({ ...ref(forBen), expires: w.clock.ts(86400) })).toBe("conflict");
    expect((await sendOffer(w, "obi-ana", "obi-ben", offerOf(ref(forBen)), t.ana)).r.status).toBe(202);
    // An expired blob can't be offered any more.
    const brief = (await uploadBlob(w, t.ana, ["obi-ben"], ageFile(1, 100), { expiresIn: 600 })).body;
    w.clock.advance(600);
    expect(await refused(ref(brief))).toBe("conflict");
  });

  it("takes a ciphertext over 64 MiB as its parts, each the sender's for the receiver", async () => {
    const w = await sharing();
    const t = await tokens(w);
    const one = (await uploadBlob(w, t.ana, ["obi-ben"], ageFile(1, 1000))).body;
    const two = (await uploadBlob(w, t.ana, ["obi-ben"], crypto.getRandomValues(new Uint8Array(500)), { query: "&part=2" })).body;
    const whole = { id: one.id, sha256: "e".repeat(64), bytes: one.bytes + two.bytes, expires: one.expires };
    const parts = [one, two].map((p) => ({ id: p.id, sha256: p.sha256, bytes: p.bytes }));
    expect((await sendOffer(w, "obi-ana", "obi-ben", offerOf(whole, { blobs: parts }), t.ana)).r.status).toBe(202);
    const notBens = (await uploadBlob(w, t.ana, ["obi-cleo"], crypto.getRandomValues(new Uint8Array(500)), { query: "&part=2" })).body;
    const mixed = [parts[0], { id: notBens.id, sha256: notBens.sha256, bytes: notBens.bytes }];
    const r = (await sendOffer(w, "obi-ana", "obi-ben", offerOf({ ...whole, bytes: one.bytes + notBens.bytes }, { blobs: mixed }), t.ana)).r;
    expect(r.body.error.code).toBe("conflict");
  });

  it("cuts a receiver off from its share's blobs once the share is taken back, and only that receiver", async () => {
    const w = await sharing();
    const t = await tokens(w);
    // One upload for both.
    const both = (await uploadBlob(w, t.ana, ["obi-ben", "obi-cleo"], ageFile(2, 100))).body;
    const { env: toBen } = await sendOffer(w, "obi-ana", "obi-ben", offerOf(ref(both)), t.ana);
    const { env: toCleo } = await sendOffer(w, "obi-ana", "obi-cleo", offerOf(ref(both)), t.ana);
    expect((await fetchBlob(w, both.id, t.ben)).status).toBe(200);
    // A newer version for ben, then the share taken back: neither blob reaches ben any more.
    const v4 = (await uploadBlob(w, t.ana, ["obi-ben"], ageFile(1, 100))).body;
    expect((await w.send(await fromSender(w, toBen, "artifact_update", { artifact: artifact(4), blob: ref(v4), latest: true }), t.ana)).status).toBe(202);
    expect((await w.send(await fromSender(w, toBen, "artifact_revoke", {}), t.ana)).status).toBe(202);
    expect((await fetchBlob(w, both.id, t.ben)).status).toBe(404);
    expect((await fetchBlob(w, v4.id, t.ben)).status).toBe(404);
    // cleo's share still holds.
    expect((await fetchBlob(w, both.id, t.cleo)).status).toBe(200);
    expect((await w.send(await fromSender(w, toCleo, "artifact_deleted", {}), t.ana)).status).toBe(202);
    expect((await fetchBlob(w, both.id, t.cleo)).status).toBe(404);
    // The uploader deletes what nobody's share names now.
    for (const b of [both, v4]) expect((await deleteBlob(w, b.id, t.ana)).status).toBe(204);
    expect(await held(w)).toEqual([]);
  });

  it("deletes a Sphere's blobs with it", async () => {
    const w = await sharing();
    const t = await tokens(w);
    await uploadBlob(w, t.ana, ["obi-ben"], ageFile(1, 100));
    expect(await held(w)).toHaveLength(1);
    expect((await w.call("DELETE", `/v0.1/spheres/${w.sphere}`, { token: await w.ownerToken("ana") })).status).toBe(204);
    expect(await held(w)).toEqual([]);
  });

  it("isn't offered without a bucket: no feature, no paths, no artifact", async () => {
    const { ARTIFACTS: _bucket, ...bare } = env;
    const call = makeCall(new World().clock, bare as Cloudflare.Env);
    const features = await call("GET", "/v0.1/features");
    expect(features.body.features).not.toContain("artifacts");
    const w = await sharing();
    const t = await tokens(w);
    const bareCall = makeCall(w.clock, bare as Cloudflare.Env);
    expect((await bareCall("POST", `/v0.1/spheres/${w.sphere}/blobs?to=obi-ben&expires_at=${w.clock.ts(3600)}`, { token: t.ana, raw: ageFile(1, 10), headers: { "Content-Type": "application/octet-stream", "Content-Length": "200" } })).status).toBe(404);
    const offer = await w.envelope("obi-ana", "obi-ben", "artifact_offer", offerOf({ id: crypto.randomUUID(), sha256: "d".repeat(64), bytes: 10, expires: w.clock.ts(3600) }), { seal: sealFor("obi-ben") });
    const r = await bareCall("POST", `/v0.1/spheres/${w.sphere}/messages`, { token: t.ana, body: offer });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("feature_not_taken");
    expect(r.body.error.message).toContain("doesn't take artifacts");
  });
});
