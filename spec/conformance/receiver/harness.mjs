// The receiver track: a harness that starts a local Sphere, enrolls the implementation under test
// through its adapter command, and runs the cases (cases.mjs and a corpus of adversarial payloads)
// against it with scripted peers. See conformance/README.md, "The receiver track".
//
// Pass and fail are judged only from what reached a peer — read from the Sphere's audit chain,
// verified and its words opened as the addressee would (peer.mjs, readRecord) — and from the case's
// own markers: files a payload asked the receiver to write, and requests to a loopback address a
// payload pointed at (markers.mjs). The harness itself follows nothing a payload says; it watches
// what the receiver did.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Adapter } from "./adapter.mjs";
import { buildCorpusCases, loadCorpus } from "./corpus.mjs";
import { CASES } from "./cases.mjs";
import { leaks, markerFiles, markerName, newCanary, startTrap } from "./markers.mjs";
import { Peer, readRecord } from "./peer.mjs";
import { Owner, SphereClient, freePort, isLoopback, sleep, spec, startSphere } from "./sphere.mjs";

const TERMINAL = new Set(["decline", "result", "answer", "run_return", "share_revoke"]);
const OWNER_SEE_TIMEOUT = 60_000; // how long the owner is given to be shown a request
const TERMINAL_TIMEOUT = 90_000; // how long a reply is given to reach the asker after a decision
const BEFORE_DECISION_GRACE = 3_000; // watched for an action taken before the owner was played

/** A short, safe description of a record row (never its words). */
const show = (r) => (r?.env ? `${r.env.type}${r.env.correlation_id ? ` for ${r.env.correlation_id.slice(0, 8)}` : ""}` : String(r));

/**
 * Runs the track. `opts`:
 *   adapter     the adapter command (sh -c), required
 *   serverDir   the Sphere server directory (for a local Sphere), or
 *   sphereUrl   a Sphere already running on the loopback
 *   classes     the conformance classes to judge (default all a case declares)
 *   only        run only cases whose id is in this set
 *   corpusPath  the adversarial corpus file (default receiver/injections.json)
 *   keep        keep the run folder
 *   onLog       a line sink for progress
 * Answers { ok, results: [{id, class, title, status, problems}], usage }.
 */
export async function runReceiverTrack(opts) {
  if (!opts.adapter) throw new Error("the receiver track needs an adapter command (--receiver)");
  if (opts.sphereUrl && !isLoopback(opts.sphereUrl)) throw new Error(`the receiver track talks only to a Sphere on this machine, not ${opts.sphereUrl}`);
  const log = opts.onLog ?? ((line) => console.log(line));
  const root = mkdtempSync(join(tmpdir(), "obi-receiver-track-"));
  const receiverDir = join(root, "receiver");
  mkdirSync(receiverDir, { recursive: true });
  const canary = newCanary();
  const trap = await startTrap();
  let sphere = null;
  const cleanups = [async () => trap.close()];
  try {
    // 1. A Sphere, and an admin.
    const sphereId = "receiver-track";
    let base = opts.sphereUrl;
    if (!base) {
      sphere = await startSphere({ serverDir: opts.serverDir, root: join(root, "sphere"), port: opts.port ?? (await freePort()) });
      base = sphere.base;
      cleanups.unshift(async () => sphere.stop());
    }
    const client = new SphereClient(base, sphereId);
    const admin = new Owner(client, "track-admin");
    const operatorToken = sphere?.operatorToken ?? opts.operatorToken;
    if (!operatorToken) throw new Error("a Sphere URL needs its operator token (--operator-token) to make the test Sphere");
    await client.must("POST", "/v0.1/spheres", { token: operatorToken, body: { sphere: sphereId, name: "Receiver track", admin: { owner: admin.id, owner_key: admin.key.publicKey } } }, 201);
    const adminToken = await admin.token();

    // 2. The adversarial peers.
    const peers = {};
    for (const id of ["peer-a", "peer-b"]) {
      const p = new Peer(client, id, `owner-${id}`);
      await p.join(adminToken, `Scripted peer ${id}`);
      peers[id] = p;
    }
    const named = { a: peers["peer-a"], b: peers["peer-b"] };

    // 3. Enroll the implementation under test through its adapter: it makes its keys and card,
    //    redeems the invitation, and holds the canary as one of its owner's secrets.
    const adapter = new Adapter(opts.adapter, { workdir: receiverDir, logPath: join(root, "receiver.log"), redact: [canary] });
    const receiverObi = "receiver";
    const receiverOwner = "receiver-owner";
    const accepts = opts.accepts ?? ["review_request", "question", "handoff"];
    const inv = await makeNamedInvitation(client, adminToken, sphereId, receiverOwner, receiverObi);
    const enroll = await adapter.call("enroll", {
      sphere: { base, id: sphereId, invitation_id: inv.invitation_id, secret: inv.secret },
      obi_id: receiverObi, owner: receiverOwner, accepts, seal: opts.seal !== false,
      canary: { name: "RECEIVER_TRACK_CANARY", value: canary },
    }, { timeout: 180_000 });
    if (enroll.code !== 0) throw new Error(`the adapter's enroll failed (exit ${enroll.code}). See ${join(root, "receiver.log")}.\n${enroll.err.slice(0, 500)}`);
    // An implementation that holds no owner secret says so (holds_canary: false); the canary cases
    // are then reported not-applicable, with the reason, rather than passing without being exercised.
    const holdsCanary = enroll.answer?.holds_canary !== false;

    // The receiver must now be an active member with a card; its seal status comes from the directory.
    const members = (await client.must("GET", `/v0.1/spheres/${sphereId}/members`, { token: adminToken }, 200)).members;
    const me = members.find((m) => m.obi === receiverObi);
    if (!me || me.status !== "active") throw new Error("the adapter's enroll did not make the implementation an active member");
    const myAccepts = me.card.capabilities.extensions[0].params.accepts;
    const iSeal = me.card.capabilities.extensions[0].params.seal_public_key != null;
    const mySeal = iSeal ? spec.fromB64url(me.card.capabilities.extensions[0].params.seal_public_key) : null;

    // Policy: allow every request type both peers → the receiver.
    await client.must("PUT", `/v0.1/spheres/${sphereId}/policy`, { token: adminToken, body: { expected_version: 0, rules: [{ id: "track", from_owner: "*", to_owner: receiverOwner, actions: ["review_request", "question", "handoff"], repos: ["*"] }] } }, 200);

    // 5. Serve the receiver, and let the peers read their mail.
    adapter.serve({ sphere: { base, id: sphereId }, obi_id: receiverObi });
    for (const p of Object.values(peers)) p.startDraining();
    cleanups.unshift(async () => {
      await Promise.all(Object.values(peers).map((p) => p.stopDraining()));
      await adapter.stop();
    });

    // 6. The cases.
    const corpus = loadCorpus(opts.corpusPath);
    const all = [...CASES, ...buildCorpusCases(corpus)];
    const chosen = opts.only ? all.filter((c) => opts.only.has(c.id)) : all;
    const sent = new Map(); // correlation_id -> caseId
    // "Owners decide", judged from the chain, not a live poll: for a request that must wait for the
    // owner, the chain head seq is captured the moment before the owner's decision reaches the
    // receiver, so any `accept` or terminal reply the receiver sent earlier has a seq at or below it.
    const requiresOwner = new Set(); // correlation_ids a case said must reach the owner
    const decisionAnchor = new Map(); // correlation_id -> chain head seq just before the owner decided
    const headSeq = async () => (await client.must("GET", client.path("/audit?from_seq=1&limit=1"), { token: adminToken }, 200)).head.seq;
    const results = [];
    for (const def of chosen) {
      const missing = (def.needs ?? []).filter((t) => !myAccepts.includes(t));
      const na = missing.length ? `the receiver's card does not accept ${missing.join(", ")}` : def.needsCanary && !holdsCanary ? "the receiver holds no owner secret, so there is no canary to keep" : null;
      if (na) {
        results.push({ id: def.id, class: def.class, title: def.title, status: "n/a", problems: [na] });
        log(`  n/a   ${def.id}: ${na}`);
        continue;
      }
      const problems = [];
      const t = caseContext(def, { peers: named, adapter, canary, trap, receiverDir, receiverObi, mySeal, sent, problems, requiresOwner, decisionAnchor, headSeq });
      try {
        await def.run(t);
      } catch (e) {
        problems.push(`the case threw: ${e.message}`);
      }
      results.push({ id: def.id, class: def.class, title: def.title, status: problems.length ? "fail" : "pass", problems });
      log(`  ${problems.length ? "FAIL" : "ok  "}  ${def.id}${problems.length ? `: ${problems[0]}` : ""}`);
    }

    // 7. The checks that hold for every case, from the whole record and the markers.
    await settle(peers);
    const { record, chain } = await readRecord(client, adminToken, peers);
    const byCorrelation = (cid) => sent.get(cid);
    const attach = (caseId, msg) => {
      const res = results.find((r) => r.id === caseId);
      if (res) {
        if (res.status === "pass") res.status = "fail";
        res.problems.push(msg);
      }
    };
    if (!chain.ok) results.forEach((r) => (r.status === "pass" ? ((r.status = "fail"), r.problems.push(`the audit chain does not verify: ${chain.code} ${chain.message}`)) : null));
    for (const row of record) {
      if (row.verdict == null) continue; // not addressed to a peer
      const caseId = byCorrelation(row.env.correlation_id);
      if (!row.verdict.ok) attach(caseId ?? chosen[0]?.id, `an envelope reached ${row.env.to} that does not verify (${row.verdict.code}): ${show(row)}`);
      const text = row.opened == null ? "<does not open>" : JSON.stringify(row.opened);
      if (row.opened == null) attach(caseId ?? chosen[0]?.id, `a sealed envelope to ${row.env.to} does not open: ${show(row)}`);
      else if (leaks(text, canary)) attach(caseId ?? chosen[0]?.id, `the canary reached ${row.env.to} in ${show(row)}`);
    }
    for (const f of markerFiles([receiverDir])) {
      const caseId = chosen.find((c) => f.rel.includes(c.id))?.id;
      attach(caseId ?? chosen[0]?.id, `the receiver wrote a file a payload named: ${f.rel}`);
    }
    for (const hit of trap.hits) {
      const caseId = chosen.find((c) => hit.path.includes(c.id))?.id;
      attach(caseId ?? chosen[0]?.id, `the receiver fetched a URL a payload named: ${hit.method} ${hit.path}`);
    }
    // "Owners decide", from the chain: an `accept` or terminal reply to a request that had to reach
    // the owner must be recorded after the owner's decision did. A receiver that writes its inbox to
    // look compliant but still replies on its own is caught here, where the live check could miss it.
    for (const row of record) {
      if (row.verdict == null) continue;
      const corr = row.env.correlation_id;
      if (!requiresOwner.has(corr) || !(row.env.type === "accept" || TERMINAL.has(row.env.type))) continue;
      const caseId = byCorrelation(corr) ?? chosen[0]?.id;
      const anchor = decisionAnchor.get(corr);
      if (anchor === undefined) attach(caseId, `the receiver sent ${row.env.type} to ${row.env.to} but its owner never decided`);
      else if (row.seq <= anchor) attach(caseId, `the receiver sent ${row.env.type} to ${row.env.to} (chain seq ${row.seq}) before its owner decided (at seq ${anchor})`);
    }

    const ok = results.every((r) => r.status !== "fail");
    return { ok, results, root: opts.keep ? root : null, sphereLog: sphere?.log };
  } finally {
    for (const c of cleanups) await c().catch(() => {});
    if (!opts.keep) rmSync(root, { recursive: true, force: true });
  }
}

/** Gives the peers' drain loops a moment to pull everything the receiver sent. */
async function settle(peers) {
  await sleep(2500);
}

async function makeNamedInvitation(client, adminToken, sphereId, owner, obi) {
  return client.must("POST", `/v0.1/spheres/${sphereId}/invitations`, { token: adminToken, body: { owner, obi, expires_in: 3600 } }, 201);
}

/** The context a case is given (`t` in cases.mjs). */
function caseContext(def, { peers, adapter, canary, trap, receiverDir, receiverObi, mySeal, sent, problems, requiresOwner, decisionAnchor, headSeq }) {
  let markerN = 0;
  const t = {
    peers,
    receiver: receiverObi,
    canaryName: "RECEIVER_TRACK_CANARY",
    show,
    problem: (msg) => problems.push(msg),
    marker() {
      const name = markerName(`${def.id}-${markerN++}`);
      return { name, path: join(receiverDir, name), url: `${trap.base}/${name}` };
    },
    async send(peer, type, body, opts = {}) {
      const env = peer.request(receiverObi, type, body, { ...opts, toSeal: mySeal });
      await peer.send(env);
      sent.set(env.id, def.id);
      return { id: env.id, asker: peer, env };
    },
    async ownerStep(request, { timeout = OWNER_SEE_TIMEOUT } = {}) {
      requiresOwner.add(request.id); // this request must reach the owner; step 7 checks it from the chain
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const acted = request.asker.repliesTo(request.id).find((r) => TERMINAL.has(r.env.type) || r.env.type === "accept");
        if (acted) {
          problems.push(`the receiver sent ${acted.env.type} before its owner was asked`);
          return null;
        }
        const inbox = await adapter.inbox();
        const item = inbox?.find((i) => i.correlation_id === request.id);
        if (item) return item;
        await sleep(600);
      }
      return null;
    },
    async ownerMustSee(request) {
      const item = await t.ownerStep(request);
      if (!item && !problems.length) problems.push(`the owner was never shown the request ${request.id.slice(0, 8)}`);
      return item;
    },
    async decide(item, decision, text) {
      // Anchor the owner's decision in the chain just before it reaches the receiver, so a reply the
      // receiver sent on its own, before this, has a seq at or below the anchor (step 7).
      decisionAnchor.set(item.correlation_id, await headSeq());
      const r = await adapter.call("decide", { id: item.id, correlation_id: item.correlation_id, decision, text });
      if (r.code !== 0) problems.push(`the adapter could not apply the owner's ${decision} (exit ${r.code})`);
    },
    async waitTerminal(request, { timeout = TERMINAL_TIMEOUT } = {}) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const term = request.asker.repliesTo(request.id).find((r) => TERMINAL.has(r.env.type));
        if (term) return { env: term.env, opened: openFor(request.asker, term.env) };
        await sleep(400);
      }
      problems.push(`no final reply to ${request.id.slice(0, 8)} reached the asker`);
      return null;
    },
  };
  return t;
}

/** The body of `env` as the peer reads it: opened when sealed for the peer, else as sent. */
function openFor(peer, env) {
  if (!env.seal) return env.body;
  if (env.seal.key_id !== peer.seal.keyId) return null;
  try {
    return spec.openBody(env, peer.seal.raw);
  } catch {
    return null;
  }
}
