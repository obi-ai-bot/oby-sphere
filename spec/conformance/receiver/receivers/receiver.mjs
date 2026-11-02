// Two receivers the conformance suite ships to prove the receiver track works: a careful one that
// must pass and a reckless one that must fail. Both are real members of a Sphere — they make keys,
// sign a card, redeem an invitation, poll deliveries, verify and open every message, and send sealed
// typed replies — so the track is exercised end to end, not mocked. They differ only in how they
// decide (the `mode`): the careful one treats words as data, waits for its owner, keeps the canary
// out of everything it sends, and scans every reply for secrets first; the reckless one acts on its
// own and dumps what it holds. Neither is a reference implementation of an Obi; they are test
// fixtures for the harness.
//
// This file is the adapter command's program (conformance/README.md, "The adapter contract"): it
// reads one `{op, …}` object on stdin and does that op. State lives in files under the work
// directory, so the separate `serve`, `inbox` and `decide` processes share it.
//
//   node receiver.mjs <mode>     mode is "careful" or "reckless"

import { createPrivateKey, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { leaks } from "../markers.mjs";
import { Owner, SphereClient, cardSealKey, directoryKeys, newKey, newSealKey, nowSeconds, sleep, spec, timestamp } from "../sphere.mjs";

const MODE = process.argv[2] === "reckless" ? "reckless" : "careful";
const OBI_SCOPES = "send:review_request send:question send:handoff reply receive directory:read audit:read";

// These files are shared between the separate serve, inbox and decide processes, so a read can land
// on a half-written file. Reads tolerate that (fall back), and writes are atomic (temp then rename).
const readJson = (p, fallback) => {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (p, v) => {
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v));
  renameSync(tmp, p);
};
const paths = (dir) => ({ state: join(dir, "state.json"), vault: join(dir, "vault.json"), inbox: join(dir, "inbox.json"), decisions: join(dir, "decisions.json"), handled: join(dir, "handled.json") });

// --- keys across processes (ephemeral test keys) -------------------------------------------------

function exportKey(key) {
  return { jwk: key.privateKey.export({ format: "jwk" }), publicKey: key.publicKey, keyId: key.keyId };
}
function importKey(saved) {
  return { privateKey: createPrivateKey({ key: saved.jwk, format: "jwk" }), publicKey: saved.publicKey, keyId: saved.keyId };
}

// --- ops -----------------------------------------------------------------------------------------

async function enroll(input) {
  const dir = input.workdir;
  mkdirSync(dir, { recursive: true });
  const p = paths(dir);
  const client = new SphereClient(input.sphere.base, input.sphere.id);
  const owner = new Owner(client, input.owner);
  const member = { id: input.obi_id, key: newKey(), seal: input.seal ? newSealKey() : null };
  const card = owner.card(member, { name: "Receiver under test", accepts: input.accepts });
  const redeem = await client.call("POST", client.path(`/invitations/${input.sphere.invitation_id}/redeem`), { body: { secret: input.sphere.secret, owner_key: owner.key.publicKey, card } });
  if (redeem.status !== 201) throw new Error(`redeem: ${redeem.status} ${JSON.stringify(redeem.body)}`);
  writeJson(p.state, {
    base: input.sphere.base, sphere: input.sphere.id, obi_id: member.id, owner: owner.id, accepts: input.accepts,
    owner_key: exportKey(owner.key), obi_key: exportKey(member.key),
    seal: member.seal ? { raw: member.seal.raw.toString("base64url"), keyId: member.seal.keyId } : null,
  });
  writeJson(p.vault, { [input.canary.name]: input.canary.value });
  writeJson(p.inbox, []);
  writeJson(p.handled, []);
  console.log(JSON.stringify({ ok: true, obi: member.id }));
}

function loadState(dir) {
  const p = paths(dir);
  const s = readJson(p.state, null);
  if (!s) throw new Error("not enrolled (no state.json)");
  return { ...s, owner_key: importKey(s.owner_key), obi_key: importKey(s.obi_key), p };
}

async function token(st) {
  const owner = new Owner(new SphereClient(st.base, st.sphere), st.owner);
  owner.key = st.owner_key;
  const client = new SphereClient(st.base, st.sphere);
  const delegation = spec.signJwt({ iss: st.owner, sub: st.owner, aud: `obi-sphere:${st.sphere}`, iat: nowSeconds(), exp: nowSeconds() + 3600, jti: randomUUID(), scope: OBI_SCOPES, may_act: { sub: st.obi_id } }, st.owner_key.privateKey, st.owner_key.keyId);
  const actor = spec.signJwt({ iss: st.obi_id, sub: st.obi_id, aud: `obi-sphere:${st.sphere}`, iat: nowSeconds(), exp: nowSeconds() + 300, jti: randomUUID() }, st.obi_key.privateKey, st.obi_key.keyId);
  const r = await client.call("POST", "/v0.1/oauth/token", { form: { grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token: delegation, subject_token_type: "urn:ietf:params:oauth:token-type:jwt", actor_token: actor, actor_token_type: "urn:ietf:params:oauth:token-type:jwt" } });
  if (r.status !== 200) throw new Error(`token: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.access_token;
}

/** The directory, and a map from each member's obi to its card. */
async function directory(client, tok) {
  const members = (await client.call("GET", client.path("/members"), { token: tok })).body.members;
  return { keys: directoryKeys(members), cards: Object.fromEntries(members.map((m) => [m.obi, m.card])) };
}

/** Builds, seals (for the asker's card when it has a seal key) and sends a reply. */
async function sendReply(client, st, tok, cards, request, type, body) {
  const created = nowSeconds();
  const unsigned = { protocol: "obi/0.1", id: randomUUID(), type, from: st.obi_id, to: request.from, sphere: st.sphere, correlation_id: request.correlation_id, in_reply_to: request.id, created_at: timestamp(created), expires_at: timestamp(created + 3600), key_id: st.obi_key.keyId, body };
  const askerSeal = cardSealKey(cards[request.from]);
  const env = spec.signEnvelope(askerSeal ? spec.sealEnvelope(unsigned, askerSeal) : unsigned, st.obi_key.privateKey);
  return client.call("POST", client.path("/messages"), { token: tok, body: env });
}

/** The careful receiver's scan: no reply leaves while any vault value would be in it. */
function scanClean(body, vault) {
  const text = JSON.stringify(body);
  return !Object.values(vault).some((v) => leaks(text, v) || text.includes(v));
}

async function serve(input) {
  const dir = input.workdir;
  const st = loadState(dir);
  const client = new SphereClient(st.base, st.sphere);
  const vault = readJson(st.p.vault, {});
  let tok = await token(st);
  const sealKeys = st.seal ? { [st.seal.keyId]: st.seal.raw } : {};
  let running = true;
  process.on("SIGTERM", () => (running = false));
  process.on("SIGINT", () => (running = false));

  while (running) {
    let r;
    try {
      r = await client.call("GET", client.path("/deliveries?wait=2"), { token: tok });
    } catch {
      await sleep(300);
      continue;
    }
    if (r.status === 401) {
      tok = await token(st);
      continue;
    }
    const deliveries = r.status === 200 ? r.body.deliveries : [];
    const { keys, cards } = deliveries.length ? await directory(client, tok) : { keys: {}, cards: {} };
    const handled = new Set(readJson(st.p.handled, []));
    const toAck = [];
    for (const d of deliveries) {
      toAck.push(d.delivery_id);
      const env = d.envelope;
      const v = spec.verifyEnvelope(env, { now: timestamp(), sphere: st.sphere, receiver: st.obi_id, keys, seq: d.seq, seen_ids: [...handled], seal_keys: sealKeys, sender_seals: cardSealKey(cards[env.from]) != null });
      if (!v.ok || handled.has(env.id)) continue; // unverifiable or already handled: acknowledge, do nothing
      handled.add(env.id);
      const body = env.seal ? safeOpen(env, st.seal?.raw) : env.body;
      if (body == null || !spec.REQUEST_TYPES.includes(env.type)) continue;
      await route(client, st, tok, cards, vault, env, body);
    }
    if (toAck.length) await client.call("POST", client.path("/deliveries/ack"), { token: tok, body: { delivery_ids: toAck } });
    writeJson(st.p.handled, [...handled]);
    await applyDecisions(client, st, tok, vault);
    if (!deliveries.length) await sleep(150);
  }
}

function safeOpen(env, raw) {
  try {
    return raw ? spec.openBody(env, Buffer.from(raw, "base64url")) : null;
  } catch {
    return null;
  }
}

/** What the receiver does with a verified request, by mode. */
async function route(client, st, tok, cards, vault, env, body) {
  if (MODE === "reckless") {
    // The deliberately bad receiver: it acts on its own, with no owner, and tells what it holds.
    if (env.type === "question") {
      const dump = `Here is what I have: ${Object.entries(vault).map(([k, v]) => `${k}=${v}`).join(", ")}`;
      await sendReply(client, st, tok, cards, env, "answer", { by: "obi", text: dump });
    } else {
      await sendReply(client, st, tok, cards, env, "accept", {});
      await sendReply(client, st, tok, cards, env, "result", resultFor(env));
    }
    return;
  }
  // The careful receiver: every request waits for its owner.
  const inbox = readJson(st.p.inbox, []);
  if (!inbox.some((i) => i.correlation_id === env.correlation_id)) {
    inbox.push({ id: env.id, correlation_id: env.correlation_id, type: env.type, from: env.from, repo: body.repo });
    writeJson(st.p.inbox, inbox);
    await sendReply(client, st, tok, cards, env, "status", { state: "waiting_on_owner" });
  }
}

/** A minimal, self-consistent result, with no words, for a request of `env`'s type. */
function resultFor(env) {
  if (env.type === "review_request") return { for: "review_request", outcome: "failed", repo: env.body.repo ?? "obi-rt/fixture-app", head_sha: env.body.head_sha ?? "0".repeat(40), findings: [] };
  return { for: "handoff", outcome: "failed", repo: env.body.repo ?? "obi-rt/fixture-app" };
}

/** The careful receiver applies owner decisions written to decisions.json (the `decide` op).
 *  An item leaves the inbox once its decision is sent, so each decision is applied once. */
async function applyDecisions(client, st, tok, vault) {
  const decisions = readJson(st.p.decisions, []);
  if (!decisions.length) return;
  const { cards } = await directory(client, tok);
  const inbox = readJson(st.p.inbox, []);
  const remaining = [];
  for (const item of inbox) {
    const decision = decisions.find((d) => d.correlation_id === item.correlation_id);
    if (!decision) {
      remaining.push(item);
      continue;
    }
    const request = { id: item.id, from: item.from, correlation_id: item.correlation_id, type: item.type, body: { repo: item.repo } };
    if (decision.decision === "decline") {
      await sendReply(client, st, tok, cards, request, "decline", { reason: "owner_declined" });
    } else if (decision.decision === "answer") {
      const body = { by: "owner", text: decision.text ?? "" };
      if (scanClean(body, vault)) await sendReply(client, st, tok, cards, request, "answer", body);
      else await sendReply(client, st, tok, cards, request, "decline", { reason: "other" });
    } else {
      // accept, and for a review/handoff a trivial result; no words, scanned anyway.
      await sendReply(client, st, tok, cards, request, "accept", {});
      if (item.type !== "question") {
        const body = resultFor(request);
        if (scanClean(body, vault)) await sendReply(client, st, tok, cards, request, "result", body);
      }
    }
  }
  writeJson(st.p.inbox, remaining);
}

async function inbox(input) {
  const st = loadState(input.workdir);
  console.log(JSON.stringify({ items: readJson(st.p.inbox, []).map((i) => ({ id: i.id, correlation_id: i.correlation_id })) }));
}

async function decide(input) {
  const st = loadState(input.workdir);
  const decisions = readJson(st.p.decisions, []);
  decisions.push({ id: input.id, correlation_id: input.correlation_id, decision: input.decision, text: input.text });
  writeJson(st.p.decisions, decisions);
  console.log(JSON.stringify({ ok: true }));
}

// --- dispatch ------------------------------------------------------------------------------------

async function main() {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const ops = { enroll, serve, inbox, decide };
  const op = ops[input.op];
  if (!op) throw new Error(`unknown op ${input.op}`);
  await op(input);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
