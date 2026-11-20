#!/usr/bin/env node
// Artifacts end to end (spec/protocol.md sections 5.20 to 5.24, spec/sphere-api.md sections 10 and
// 11), against a real local Sphere started as the harness starts one (`node scripts/local.mjs`),
// with real cryptography on both sides: two agents whose cards' seal keys are X25519 keys, words
// sealed by the spec's reference code (spec/conformance/lib/obi.mjs), and artifacts as real age
// files (e2e/age.mjs), opened by the receiver with its seal key.
//
//   pnpm run artifacts              (node e2e/artifacts.mjs)
//   ARTIFACTS_E2E_KEEP=1            leave the Sphere running afterwards, and print the public link
//                                   to open in a browser: the viewer decrypts it there
//
// Steps, each PASS or FAIL:
//   1  a Sphere that takes artifacts; ana and ben join, their cards accepting artifact_offer
//   2  ana packs a page, seals it to ben's seal key, uploads it once and offers it, its words sealed
//   3  ben fetches it, checks the hashes the offer names, opens it with his seal key, and comments
//   4  cleo, who isn't named, can't fetch it; ana takes the share back, and ben can't any more
//   5  ben's signed receipt; the chain verifies, and holds no title, no ask, no file and no key
//   6  a public link: the ciphertext only, sealed to the link's own key, opened here with it
// Exit 0 only when every step passes.

import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decrypt, encrypt, newIdentity, tar } from "./age.mjs";
import { Obi, Owner, SphereClient, directoryKeys, nowSeconds, spec, timestamp } from "./client.mjs";

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEEP = process.env.ARTIFACTS_E2E_KEEP === "1";
const SCOPES = "send:artifact_offer reply receive directory:read audit:read";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

let failed = 0;
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    console.log(`  PASS  ${name} [${((Date.now() - t) / 1000).toFixed(1)}s]`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}
const assert = (ok, what) => {
  if (!ok) throw new Error(what);
};
const expectStatus = (r, status, what) => assert(r.status === status, `${what}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on("error", rej);
  });

// ---------------------------------------------------------------------------------------------

const run = mkdtempSync(join(tmpdir(), "obi-sphere-artifacts-"));
const operatorToken = randomBytes(32).toString("base64url");
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = { SPHERE_OPERATOR_TOKEN: operatorToken, HOME: run, TMPDIR: run, WRANGLER_SEND_METRICS: "false", PATH: process.env.PATH };
const sphereProcess = spawn(process.execPath, ["scripts/local.mjs", "--port", String(port), "--persist-to", join(run, "state")], { cwd: SERVER_DIR, env, detached: true, stdio: "ignore" });
const stop = () => {
  try {
    process.kill(-sphereProcess.pid, "SIGTERM");
  } catch {}
};
process.on("exit", () => {
  stop();
  if (!KEEP) rmSync(run, { recursive: true, force: true });
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(130));

const client = new SphereClient(base, "e2e-artifacts");
const ana = { owner: new Owner(client, "ana"), seal: newIdentity() };
const ben = { owner: new Owner(client, "ben"), seal: newIdentity() };
const cleo = { owner: new Owner(client, "cleo"), seal: newIdentity() };
for (const m of [ana, ben, cleo]) m.obi = new Obi(client, `obi-${m.owner.id}`, m.owner);
const bodySeal = (to) => to.seal.publicRaw;
/** A signed envelope from `from` to `to`, its words sealed to `to`'s seal key (protocol.md section 9.1). */
const sealed = (from, to, type, body, reply) => {
  const created = nowSeconds();
  const id = randomUUID();
  const unsigned = {
    protocol: "obi/0.1", id, type, from: from.obi.id, to: to.obi.id, sphere: client.sphere, correlation_id: reply ? reply.id : id,
    ...(reply ? { in_reply_to: reply.id } : {}), created_at: timestamp(created), expires_at: timestamp(created + 3600), key_id: from.obi.key.keyId, body,
  };
  return spec.signEnvelope(spec.sealEnvelope(unsigned, bodySeal(to)), from.obi.key.privateKey);
};
const upload = async (who, query, bytes, path = "/blobs") => {
  const res = await fetch(`${base}/v0.1/spheres/${client.sphere}${path}${query}`, {
    method: path === "/blobs" ? "POST" : "PUT",
    headers: { Authorization: `Bearer ${who.obi.accessToken}`, "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length) },
    body: bytes,
  });
  return { status: res.status, body: await res.json() };
};
const fetchBytes = async (path, token) => {
  const res = await fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
};

const FILES = {
  "index.html": '<!doctype html><title>Checkout, second pass</title><link rel="stylesheet" href="style.css"><h1 id="hi">Checkout, second pass</h1><p>Shared end to end.</p>',
  "style.css": "h1{color:#2a7}",
};
const TITLE = "Checkout, second pass";
const ASK = "Does the header still work on a phone?";
const ARTIFACT_ID = randomUUID();
const ctx = {};

console.log(`Artifacts end to end, against ${base}`);

await step("1  a Sphere that takes artifacts; ana and ben join, their cards accepting artifact_offer", async () => {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/v0.1/health`)).ok) break;
    } catch {}
    if (i > 240) throw new Error("the Sphere didn't come up");
    await new Promise((r) => setTimeout(r, 250));
  }
  const features = await client.call("GET", "/v0.1/features");
  assert(features.body.features.includes("artifacts"), `features: ${JSON.stringify(features.body)}`);
  expectStatus(await client.call("POST", "/v0.1/spheres", { token: operatorToken, body: { sphere: client.sphere, name: "Artifacts", admin: { owner: "ana", owner_key: ana.owner.key.publicKey } } }), 201, "create");
  const admin = (await ana.owner.token()).access_token;
  for (const m of [ana, ben, cleo]) {
    const inv = await client.call("POST", client.spherePath("/invitations"), { token: admin, body: { owner: m.owner.id, obi: m.obi.id, expires_in: 3600 } });
    expectStatus(inv, 201, `invite ${m.obi.id}`);
    // The card: accepts artifact_offer, takes the feature, and publishes the X25519 key artifacts are sealed to.
    const card = m.owner.card(m.obi, { name: `${m.owner.id}'s agent`, accepts: ["artifact_offer"] });
    const p = card.capabilities.extensions[0].params;
    Object.assign(p, { features: ["artifacts", "card_runtime"], seal_key_id: spec.sealKeyIdOf(m.seal.publicRaw), seal_public_key: spec.b64url(m.seal.publicRaw) });
    card.skills = [{ id: "artifact_offer", name: "Take a shared artifact", description: "Keeps what a teammate shares, set apart.", tags: ["obi-action"] }];
    delete card.signatures;
    const signedCard = spec.signCard(card, m.owner.key.privateKey, m.owner.key.keyId);
    expectStatus(await client.call("POST", client.spherePath(`/invitations/${inv.body.invitation_id}/redeem`), { body: { secret: inv.body.secret, owner_key: m.owner.key.publicKey, card: signedCard } }), 201, `redeem ${m.obi.id}`);
    m.obi.delegation = m.owner.assertion(SCOPES, { lifetime: 3600, mayAct: m.obi.id });
    await m.obi.exchange();
  }
  const policy = await client.call("PUT", client.spherePath("/policy"), { token: admin, body: { expected_version: 0, rules: [{ id: "sharing", from_owner: "*", to_owner: "*", actions: ["artifact_offer"], repos: ["*"] }] } });
  expectStatus(policy, 200, "policy");
});

await step("2  ana packs a page, seals it to ben's seal key, uploads it once and offers it, its words sealed", async () => {
  ctx.tar = tar(FILES);
  ctx.cipher = encrypt(ctx.tar, [ben.seal.publicRaw]);
  const expires = timestamp(nowSeconds() + 7 * 86400);
  const r = await upload(ana, `?to=${ben.obi.id}&expires_at=${expires}`, ctx.cipher);
  expectStatus(r, 201, "upload");
  assert(r.body.sha256 === sha256(ctx.cipher) && r.body.bytes === ctx.cipher.length, "the Sphere hashed what it was sent");
  ctx.blob = { id: r.body.id, sha256: r.body.sha256, bytes: r.body.bytes, expires: r.body.expires };
  const bytes = Object.values(FILES).reduce((n, f) => n + Buffer.byteLength(f), 0);
  ctx.offer = sealed(ana, ben, "artifact_offer", { artifact: { id: ARTIFACT_ID, title: TITLE, kind: "html", version: 1, bytes, files: 2, sha256: sha256(ctx.tar) }, blob: ctx.blob, access: "comment", latest: true, ask: ASK });
  expectStatus(await ana.obi.send(ctx.offer), 202, "offer");
});

await step("3  ben fetches it, checks the hashes the offer names, opens it with his seal key, and comments", async () => {
  const [d] = await ben.obi.waitFor(1);
  const offer = d.envelope;
  assert(offer.type === "artifact_offer" && offer.seal, "a sealed offer");
  const body = spec.openBody(offer, ben.seal.raw);
  assert(body.artifact.title === TITLE && body.ask === ASK, "the words open with ben's seal key");
  const got = await fetchBytes(`/v0.1/spheres/${client.sphere}/blobs/${body.blob.id}`, ben.obi.accessToken);
  assert(got.status === 200, `fetch: ${got.status}`);
  assert(sha256(got.bytes) === body.blob.sha256 && got.bytes.length === body.blob.bytes, "the ciphertext is the one offered");
  const plain = decrypt(got.bytes, ben.seal.raw);
  assert(sha256(plain) === body.artifact.sha256, "the tar is the one offered");
  assert(plain.toString("latin1").includes("Shared end to end."), "the page is in it");
  expectStatus(await ben.obi.ack([d.delivery_id]), 200, "ack");
  const comment = sealed(ben, ana, "answer", { by: "owner", text: "The header wraps at 320 pixels.", refs: [{ kind: "artifact", artifact: ARTIFACT_ID, version: 1 }] }, offer);
  expectStatus(await ben.obi.send(comment), 202, "comment");
  // A version back needs edit, and this share gives comment.
  const back = sealed(ben, ana, "artifact_version", { artifact: { ...body.artifact, version: 2 }, blob: ctx.blob }, offer);
  const refused = await ben.obi.send(back);
  assert(refused.status === 409 && refused.body.error.code === "bad_reply", `a version without edit: ${refused.status}`);
});

await step("4  cleo, who isn't named, can't fetch it; ana takes the share back, and ben can't any more", async () => {
  assert((await fetchBytes(`/v0.1/spheres/${client.sphere}/blobs/${ctx.blob.id}`, cleo.obi.accessToken)).status === 404, "cleo fetched it");
  // Nor can anyone decrypt it who isn't ben.
  let opened = false;
  try {
    decrypt(ctx.cipher, cleo.seal.raw);
    opened = true;
  } catch {}
  assert(!opened, "cleo's key opened it");
  expectStatus(await ana.obi.send(sealed(ana, ben, "artifact_revoke", {}, ctx.offer)), 202, "revoke");
  assert((await fetchBytes(`/v0.1/spheres/${client.sphere}/blobs/${ctx.blob.id}`, ben.obi.accessToken)).status === 404, "ben still fetches it after the revoke");
  const del = await fetch(`${base}/v0.1/spheres/${client.sphere}/blobs/${ctx.blob.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${ana.obi.accessToken}` } });
  assert(del.status === 204, `ana deletes it: ${del.status}`);
});

await step("5  ben's signed receipt; the chain verifies, and holds no title, no ask, no file and no key", async () => {
  expectStatus(await ben.obi.send(sealed(ben, ana, "artifact_receipt", {}, ctx.offer)), 202, "receipt");
  const audit = await client.call("GET", client.spherePath("/audit?from_seq=1&limit=100"), { token: ana.obi.accessToken });
  expectStatus(audit, 200, "audit");
  const members = await client.call("GET", client.spherePath("/members"), { token: ana.obi.accessToken });
  const verdict = spec.verifyChain({ sphere: client.sphere, entries: audit.body.entries }, { keys: directoryKeys(members.body.members) });
  assert(verdict.ok, `the chain: ${JSON.stringify(verdict)}`);
  const types = audit.body.entries.map((e) => e.envelope.type).join(",");
  assert(types === "artifact_offer,answer,artifact_revoke,artifact_receipt", `the chain holds ${types}`);
  const text = JSON.stringify(audit.body);
  for (const secret of [TITLE, ASK, "Shared end to end.", "The header wraps", ben.seal.secret, ana.seal.secret]) assert(!text.includes(secret), `the chain holds "${secret.slice(0, 20)}…"`);
});

await step("6  a public link: the ciphertext only, sealed to the link's own key, opened here with it", async () => {
  const link = newIdentity();
  ctx.linkId = `l-${randomBytes(8).toString("hex")}`;
  const cipher = encrypt(ctx.tar, [link.publicRaw]);
  const r = await upload(ana, "", cipher, `/public/${ctx.linkId}`);
  expectStatus(r, 201, "put the link");
  assert(!JSON.stringify(r.body).includes(link.secret), "the answer holds the key");
  const blob = await fetchBytes(`/a/${ctx.linkId}/blob`);
  assert(blob.status === 200 && blob.bytes.equals(cipher), "the link serves the ciphertext as it went up");
  assert(blob.headers.get("cache-control") === "no-store", "never cached");
  assert(decrypt(blob.bytes, link.raw).equals(ctx.tar), "the link's key opens it");
  const page = await fetchBytes(`/a/${ctx.linkId}`);
  assert(page.status === 200 && (page.headers.get("content-security-policy") ?? "").includes("connect-src 'self'"), "the page and its policy");
  ctx.link = `${base}/a/${ctx.linkId}#${link.secret}`;
});

console.log(failed ? `\n${failed} step(s) failed.` : "\nAll steps passed.");
if (KEEP && !failed) {
  console.log(`\nThe Sphere stays up at ${base} (Ctrl-C stops it). Open the public link in a browser:\n\n  ${ctx.link}\n\nIts page decrypts the page above there; window.__OBY_PUBLIC says what it showed.`);
  await new Promise(() => {});
}
process.exit(failed ? 1 : 0);
