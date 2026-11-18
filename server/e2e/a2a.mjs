#!/usr/bin/env node
// `node e2e/a2a.mjs`: the A2A binding's "done when" (spec/a2a.md; #59), with real processes on a local Sphere.
//
// - A local Sphere (scripts/local.mjs), with a fresh operator token in its environment only.
// - Its admin, played by the scripted client of e2e/client.mjs, makes it, a policy for questions and
//   an invite link for two.
// - On one side, a member: the MCP connector (connector/), joined through its own CLI with the link
//   and receiving with `connector run`. Its owner answers through the CLI.
// - On the other, this script plays an agent that speaks A2A, with the Obysphere extension. Asked
//   before it joins, the binding tells it to join first. Like any member, it uses the Obysphere's own
//   API to join with the same link (its owner's card, with a seal key), get a token bound to its key
//   (DPoP) and read the directory (the member's card and keys). It reaches the member over A2A only:
//   SendMessage with its signed, sealed question; GetTask until the answer. For the comparison it also
//   reads the audit chain and sends through the relay.
//
// What it checks: the answer verifies and opens as protocol.md section 10 says; the chain verifies
// with the spec's own verifyChain; the question's entry is the envelope exactly as signed, and the
// relay's own send of the same bytes is a retry of it (the same seq and hash); a second exchange,
// through the relay, makes entries of the same shape, which the connector receives the same way; and
// the server's tasks are the spec's reference view of the chain.
//
//   node e2e/a2a.mjs [--port 8797] [--persist-to <dir>] [--evidence <file.json>] [--keep]

import { generateKeyPairSync, randomBytes, randomUUID, sign as nodeSign } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JWT_TYPE, Obi, Owner, SphereClient, TOKEN_EXCHANGE, directoryKeys, nowSeconds, spec, timestamp } from "./client.mjs";

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONNECTOR = join(SERVER, "..", "connector");
const { exchangeTask } = await import(pathToFileURL(join(SERVER, "..", "spec", "conformance", "lib", "a2a.mjs")).href);
const { readInviteLink } = await import(pathToFileURL(join(SERVER, "..", "spec", "conformance", "invite-links.mjs")).href);

const args = process.argv.slice(2).filter((a) => a !== "--");
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const KEEP = args.includes("--keep");
const EXT = "urn:obi-sphere:ext:obi:0.1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const results = [];
const check = (cond, what) => {
  results.push(`${cond ? "PASS" : "FAIL"}  ${what}`);
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}`);
  if (!cond) failures++;
  return cond;
};
const must = (cond, what) => {
  if (!check(cond, what)) throw new Error(`stopping: ${what}`);
};
const same = (a, b) => spec.canonicalize(a) === spec.canonicalize(b);

// ---------------------------------------------------------------------------------------------
// The local Sphere.

const run = mkdtempSync(join(tmpdir(), "obysphere-a2a-e2e-"));
const state = opt("--persist-to") ?? join(run, "state");
for (const d of [state, join(run, "home"), join(run, "tmp")]) mkdirSync(d, { recursive: true });
const port = Number(opt("--port") ?? 8797);
const base = `http://127.0.0.1:${port}`;
const operatorToken = randomBytes(32).toString("base64url");
const log = createWriteStream(join(run, "sphere.log"));
const sphereProc = spawn(process.execPath, ["scripts/local.mjs", "--port", String(port), "--persist-to", state], {
  cwd: SERVER, detached: true, stdio: ["ignore", "pipe", "pipe"],
  env: { SPHERE_OPERATOR_TOKEN: operatorToken, HOME: join(run, "home"), TMPDIR: join(run, "tmp"), WRANGLER_SEND_METRICS: "false", PATH: process.env.PATH },
});
sphereProc.stdout.pipe(log);
sphereProc.stderr.pipe(log);
const sphereExited = new Promise((done) => sphereProc.on("exit", done));

// ---------------------------------------------------------------------------------------------
// The connector, as its owner runs it.

const PASS = `owner-pass-${randomBytes(8).toString("hex")}`;
const memberHome = join(run, "member");
const userHome = join(run, "home");
const connectorCli = (argv, input) => {
  const r = spawnSync(process.execPath, [join(CONNECTOR, "src", "main.ts"), ...argv, "--home", memberHome], { input, encoding: "utf8", env: { PATH: process.env.PATH, HOME: userHome } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
let receiver = null;
const item = (id) => {
  const p = join(memberHome, "items", `${id}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};
const until = async (what, test, seconds = 90) => {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const v = await test();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`stopping: ${what} within ${seconds} seconds`);
    await sleep(500);
  }
};

// ---------------------------------------------------------------------------------------------
// The agent that speaks A2A: its keys, its DPoP key, and its calls.

/** A DPoP key (Ed25519) and proofs made with it (identity.md 4.6). */
function dpopKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const { kty, crv, x } = publicKey.export({ format: "jwk" });
  const jwk = { kty, crv, x };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return (method, url, token) => {
    const claims = { jti: randomUUID(), htm: method, htu: url, iat: nowSeconds(), ...(token ? { ath: spec.sha256(Buffer.from(token, "ascii")).toString("base64url") } : {}) };
    const input = `${b64({ typ: "dpop+jwt", alg: "EdDSA", jwk })}.${b64(claims)}`;
    return `${input}.${nodeSign(null, Buffer.from(input), privateKey).toString("base64url")}`;
  };
}

class A2aAgent {
  constructor(client, owner, id) {
    this.obi = new Obi(client, id, owner);
    this.sealRaw = randomBytes(32);
    this.seal = spec.x25519FromPrivate(this.sealRaw);
    this.sealKeyId = spec.sealKeyIdOf(this.seal.publicRaw);
    this.proof = dpopKey();
    this.token = null;
  }

  /** Its owner-signed card, with its seal key (identity.md section 2). */
  card(accepts) {
    const card = this.obi.owner.card(this.obi, { name: "An A2A agent", accepts });
    const { signatures: _s, ...unsigned } = card;
    Object.assign(unsigned.capabilities.extensions[0].params, { seal_key_id: this.sealKeyId, seal_public_key: Buffer.from(this.seal.publicRaw).toString("base64url") });
    return spec.signCard(unsigned, this.obi.owner.key.privateKey, this.obi.owner.key.keyId);
  }

  /** A token bound to its DPoP key: the owner's delegation and its own actor assertion. */
  async getToken() {
    const r = await fetch(`${base}/v0.1/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", DPoP: this.proof("POST", `${base}/v0.1/oauth/token`) },
      body: new URLSearchParams({ grant_type: TOKEN_EXCHANGE, subject_token: this.obi.delegation, subject_token_type: JWT_TYPE, actor_token: this.obi.actorAssertion(), actor_token_type: JWT_TYPE }),
    });
    const body = await r.json();
    if (r.status !== 200) throw new Error(`token: ${r.status} ${JSON.stringify(body)}`);
    this.token = body;
    return body;
  }

  /** One call, with the token and a new proof for it (when it has a token), A2A's headers, and a JSON body. */
  async call(method, url, { body, a2a = true, proofUrl = url } = {}) {
    const headers = {};
    if (this.token) Object.assign(headers, { Authorization: `DPoP ${this.token.access_token}`, DPoP: this.proof(method, proofUrl, this.token.access_token) });
    if (a2a) Object.assign(headers, { "A2A-Version": "1.0", "A2A-Extensions": EXT });
    if (body !== undefined) headers["Content-Type"] = a2a ? "application/a2a+json" : "application/json";
    const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: r.status, body: parsed, headers: r.headers };
  }

  /** A2A's SendMessage to a member's card url, carrying `envelope`. */
  sendMessage(memberUrl, envelope, taskId) {
    return this.call("POST", `${memberUrl}/message:send`, {
      body: {
        message: { messageId: envelope.id, role: "ROLE_USER", parts: [{ data: envelope, mediaType: "application/json" }], extensions: [EXT], ...(taskId ? { taskId } : {}) },
        configuration: { returnImmediately: true },
      },
    });
  }

  getTask(memberUrl, id) {
    return this.call("GET", `${memberUrl}/tasks/${id}`);
  }

  /** A signed question to `to`, sealed for `toSeal` (its card's seal key, base64url) when it has one. */
  question(to, toSeal, text) {
    const created = nowSeconds();
    const id = randomUUID();
    const unsigned = {
      protocol: "obi/0.1", id, type: "question", from: this.obi.id, to, sphere: this.obi.client.sphere, correlation_id: id,
      created_at: timestamp(created), expires_at: timestamp(created + 3600), key_id: this.obi.key.keyId, body: { text },
    };
    return spec.signEnvelope(toSeal ? spec.sealEnvelope(unsigned, Buffer.from(toSeal, "base64url")) : unsigned, this.obi.key.privateKey);
  }
}

// ---------------------------------------------------------------------------------------------

const evidence = { a2a_version: "1.0 (a2aproject/A2A v1.0.1, 3303592)", port, steps: {} };
try {
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      if ((await fetch(`${base}/v0.1/health`)).status === 200) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`the Sphere didn't answer health within 90 seconds; its log: ${join(run, "sphere.log")}`);
    await sleep(500);
  }
  console.log(`A local Sphere at ${base}, the run's folder ${run}`);
  const features = (await (await fetch(`${base}/v0.1/features`)).json()).features;
  check(features.includes("a2a"), `GET /v0.1/features lists a2a (${features.join(", ")})`);

  console.log("\n1. The admin makes the Sphere, a policy for questions, and an invite link for two");
  const sphereId = `a2a-${randomBytes(3).toString("hex")}`;
  const client = new SphereClient(base, sphereId);
  const ada = new Owner(client, "ada");
  must((await client.call("POST", "/v0.1/spheres", { token: operatorToken, body: { sphere: sphereId, name: "A2A e2e", admin: { owner: "ada", owner_key: ada.key.publicKey } } })).status === 201, "the Sphere is made");
  const adminToken = (await ada.token()).access_token;
  must((await client.call("PUT", client.spherePath("/policy"), { token: adminToken, body: { expected_version: 0, rules: [{ id: "team", from_owner: "*", to_owner: "*", actions: ["question"], repos: ["*"] }] } })).status === 200, "a policy for questions");
  const inv = (await client.call("POST", client.spherePath("/invitations"), { token: adminToken, body: { expires_in: 3600, max_uses: 2 } })).body;
  const link = `${base}/join#sphere=${sphereId}&name=${encodeURIComponent("A2A e2e")}&by=ada&id=${inv.invitation_id}&secret=${inv.secret}`;

  console.log("\n2. The member: the connector joins with the link, through its CLI, and receives with `connector run`");
  const joined = connectorCli(["join", link, "--owner", "dee", "--obi", "dee-agent", "--passphrase-stdin"], PASS + "\n");
  must(joined.code === 0, `the connector joins${joined.code ? `: ${joined.err}` : ""}`);
  receiver = spawn(process.execPath, [join(CONNECTOR, "src", "main.ts"), "run", "--home", memberHome], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: userHome } });
  let receiverLog = "";
  receiver.stdout.on("data", (d) => (receiverLog += d));
  receiver.stderr.on("data", (d) => (receiverLog += d));
  const memberUrl = `${base}/v0.1/spheres/${sphereId}/members/dee-agent`;

  console.log("\n3. The A2A agent, before it is a member: told to join first");
  const ari = new Owner(client, "ari");
  const agent = new A2aAgent(client, ari, "ari-agent");
  const early = await agent.sendMessage(memberUrl, agent.question("dee-agent", null, "Is the release branch cut?"));
  const help = early.body?.error?.details?.find((d) => d["@type"] === "type.googleapis.com/google.rpc.Help");
  check(early.status === 401 && early.body.error.details[0].reason === "UNAUTHORIZED" && early.headers.get("WWW-Authenticate")?.includes("DPoP"), `SendMessage without a token: 401 UNAUTHORIZED, ${early.headers.get("WWW-Authenticate")}`);
  check(!!help && /invite-links/.test(help.links[0].url), `the answer says how to join: "${help?.links[0].description}" ${help?.links[0].url}`);
  evidence.steps.join_first = { status: early.status, error: early.body.error };

  console.log("\n4. It joins with the same link (its owner's card, with a seal key), and gets a token bound to its key");
  const opened = readInviteLink(link);
  must(opened?.base === base && opened.sphere === sphereId, "the invite link reads as sphere-api.md 2.1 says");
  const preview = await client.call("POST", client.spherePath(`/invitations/${opened.id}/preview`), { body: { secret: opened.secret } });
  must(preview.status === 200, `preview: ${preview.body.name}, ${preview.body.member_count} member(s)`);
  const redeemed = await client.call("POST", client.spherePath(`/invitations/${opened.id}/redeem`), { body: { secret: opened.secret, owner_key: ari.key.publicKey, card: agent.card(["question"]) } });
  must(redeemed.status === 201, `redeem: 201 (${redeemed.status})`);
  agent.obi.delegation = ari.assertion("send:question reply receive directory:read audit:read", { lifetime: 3600, mayAct: agent.obi.id });
  const tok = await agent.getToken();
  check(tok.token_type === "DPoP", `token_type ${tok.token_type}, scope "${tok.scope}"`);

  // The directory, read as every member reads it: the connector's card, its signature, its seal key.
  const members = (await agent.call("GET", `${base}/v0.1/spheres/${sphereId}/members`, { a2a: false })).body.members;
  const dee = members.find((m) => m.obi === "dee-agent");
  check(spec.verifyCard(dee.card, { now: timestamp(nowSeconds()), bound_owner_key: dee.card.capabilities.extensions[0].params.owner_key }).ok, "the connector's card verifies");
  const deeParams = dee.card.capabilities.extensions[0].params;
  check(dee.card.url === memberUrl, `the connector's card url is where A2A reaches it: ${dee.card.url}`);
  check(!!deeParams.seal_public_key, `the connector seals (${deeParams.seal_key_id}), so the question goes sealed`);
  const keys = () => agent.call("GET", `${base}/v0.1/spheres/${sphereId}/members`, { a2a: false }).then((r) => directoryKeys(r.body.members));

  console.log("\n5. Over A2A: SendMessage with the signed, sealed question");
  const words = "Is the release branch for 2.4 cut yet? (A2A e2e)";
  const q = agent.question("dee-agent", deeParams.seal_public_key, words);
  check(!!q.seal && q.body.text !== words, "the question's words are sealed for the connector");
  const sent = await agent.sendMessage(dee.card.url, q);
  must(sent.status === 200, `SendMessage: ${sent.status} ${sent.status === 200 ? "" : JSON.stringify(sent.body)}`);
  const receipt = sent.body.task.metadata[EXT];
  check(sent.headers.get("A2A-Extensions") === EXT && sent.headers.get("Content-Type") === "application/a2a+json", "the answer is application/a2a+json and activates the extension");
  check(sent.body.task.id === q.id && sent.body.task.status.state === "TASK_STATE_SUBMITTED" && receipt.id === q.id, `the task is the exchange (${q.id}), submitted; receipt seq ${receipt.seq}`);
  evidence.steps.send_message = { status: sent.status, task: { id: sent.body.task.id, status: sent.body.task.status }, receipt };
  const wrongProof = await agent.call("GET", `${dee.card.url}/tasks/${q.id}`, { proofUrl: `${base}/v0.1/spheres/${sphereId}/audit` });
  check(wrongProof.status === 401 && /invalid_dpop_proof/.test(wrongProof.headers.get("WWW-Authenticate") ?? ""), "a proof for another URL is refused (401, invalid_dpop_proof)");

  console.log("\n6. The connector receives it as any delivery; its owner answers through the CLI");
  const waiting = await until("the question reaches the connector's owner", () => {
    const it = item(`in-${q.id}`);
    return it && it.state === "waiting_on_owner" ? it : null;
  });
  check(waiting.type === "question" && waiting.peer === "ari-agent" && waiting.body.text === words, "the owner sees the question, opened, from ari-agent");
  const ownerWords = "Not yet: it is cut once the last fix lands. (A2A e2e)";
  const answered = connectorCli(["answer", `in-${q.id}`, "--text", ownerWords, "--passphrase-stdin"], PASS + "\n");
  must(answered.code === 0, `the owner answers${answered.code ? `: ${answered.err}` : ""}`);

  console.log("\n7. Over A2A: GetTask until the answer, then the answer verified and opened");
  const task = await until("the task completes", async () => {
    const t = await agent.getTask(dee.card.url, q.id);
    return t.status === 200 && t.body.status.state === "TASK_STATE_COMPLETED" ? t.body : null;
  });
  const kinds = task.history.map((m) => `${m.parts[0].data.type} (${m.role})`);
  check(task.history[0].role === "ROLE_USER" && task.history.slice(1).every((m) => m.role === "ROLE_AGENT") && task.history.at(-1).parts[0].data.type === "answer", `the task holds the exchange: ${kinds.join(", ")}`);
  const answerMsg = task.history.at(-1);
  const answer = answerMsg.parts[0].data;
  const verdict = spec.verifyEnvelope(answer, {
    now: timestamp(nowSeconds()), sphere: sphereId, receiver: agent.obi.id, keys: await keys(), seq: answerMsg.metadata[EXT].seq, seen_ids: [],
    seal_keys: { [agent.sealKeyId]: agent.sealRaw.toString("base64url") }, sender_seals: true,
  });
  const opened2 = spec.openBody(answer, agent.sealRaw);
  check(verdict.ok, `the answer verifies as protocol.md section 10 says, sealed for the agent (${verdict.ok ? "ok" : verdict.code + ": " + verdict.message})`);
  check(answer.type === "answer" && opened2.by === "owner" && opened2.text === ownerWords, `it opens to the owner's own words, by: owner: "${opened2.text}"`);
  evidence.steps.get_task = { state: task.status.state, history: task.history.map((m) => ({ role: m.role, type: m.parts[0].data.type, sealed: !!m.parts[0].data.seal, receipt: m.metadata[EXT] })) };

  console.log("\n8. The record: verifyChain, the entry as signed, and the relay's own send of the same bytes");
  const audit = (await agent.call("GET", `${base}/v0.1/spheres/${sphereId}/audit?limit=1000`, { a2a: false })).body;
  const chainVerdict = spec.verifyChain({ sphere: sphereId, entries: audit.entries }, { keys: await keys() });
  check(chainVerdict.ok, `the chain verifies with the spec's verifyChain (${audit.entries.length} entries, head ${audit.head.seq})`);
  const qEntry = audit.entries.find((e) => e.envelope.id === q.id);
  check(same(qEntry.envelope, q), "the question's entry is the envelope exactly as the agent signed it");
  check(qEntry.seq === receipt.seq && qEntry.hash === receipt.entry_hash && qEntry.recorded_at === receipt.recorded_at, "its seq, hash and recorded_at are the A2A receipt's");
  const relayed = await agent.call("POST", `${base}/v0.1/spheres/${sphereId}/messages`, { body: q, a2a: false });
  check(relayed.status === 200 && same(relayed.body, receipt), `the relay's own send of the same bytes is a retry of it: 200, the same receipt (seq ${relayed.body.seq})`);
  const after = (await agent.call("GET", `${base}/v0.1/spheres/${sphereId}/audit?limit=1000`, { a2a: false })).body;
  check(after.head.seq === audit.head.seq, "and records nothing new");
  evidence.steps.record = { chain: chainVerdict.ok ? "verifies" : chainVerdict, entries: audit.entries.length, question_entry: { seq: qEntry.seq, hash: qEntry.hash, recorded_at: qEntry.recorded_at }, relay_retry: { status: relayed.status, body: relayed.body } };

  console.log("\n9. A second exchange, through the relay, for comparison");
  const q2 = agent.question("dee-agent", deeParams.seal_public_key, "And the 2.5 branch? (relay)");
  const viaRelay = await agent.call("POST", `${base}/v0.1/spheres/${sphereId}/messages`, { body: q2, a2a: false });
  must(viaRelay.status === 202, `the relay's send: 202, seq ${viaRelay.body.seq}`);
  await until("the relayed question reaches the owner", () => item(`in-${q2.id}`)?.state === "waiting_on_owner");
  must(connectorCli(["answer", `in-${q2.id}`, "--text", "Not before 2.4 ships. (relay)", "--passphrase-stdin"], PASS + "\n").code === 0, "the owner answers it");
  await until("the relayed exchange ends", async () => (await agent.getTask(dee.card.url, q2.id)).body?.status?.state === "TASK_STATE_COMPLETED");
  const full = (await agent.call("GET", `${base}/v0.1/spheres/${sphereId}/audit?limit=1000`, { a2a: false })).body.entries;
  const exchangeOf = (id) => full.filter((e) => e.envelope.id === id || e.envelope.in_reply_to === id);
  const [viaA2a, viaRelayEx] = [exchangeOf(q.id), exchangeOf(q2.id)];
  const shape = (entries) => entries.map((e) => ({
    entry: Object.keys(e).sort(), envelope: Object.keys(e.envelope).sort(), type: e.envelope.type, from: e.envelope.from, to: e.envelope.to,
    seal: Object.keys(e.envelope.seal ?? {}).sort(), body: Object.keys(e.envelope.body).sort(),
  }));
  check(same(shape(viaA2a), shape(viaRelayEx)), "the A2A exchange's entries have the relay exchange's shape: the same members, types, parties, seals and body fields");
  check(viaA2a.every((e) => e.hash === spec.entryHash(e)) && viaRelayEx.every((e) => e.hash === spec.entryHash(e)), "every entry of both hashes as sphere-api.md section 7 says");
  const items = [item(`in-${q.id}`), item(`in-${q2.id}`)];
  check(items.every((i) => i.direction === "in" && i.type === "question" && i.peer === "ari-agent" && i.state === "replied"), `the connector received both the same way: ${items.map((i) => `${i.id.slice(0, 11)}… ${i.state}`).join(", ")}`);
  check(spec.verifyChain({ sphere: sphereId, entries: full }, { keys: await keys() }).ok, `the whole chain still verifies (${full.length} entries)`);
  evidence.steps.relay_comparison = { a2a: shape(viaA2a), relay: shape(viaRelayEx) };

  console.log("\n10. The server's tasks are the spec's reference view of the chain");
  for (const [name, id] of [["the A2A exchange", q.id], ["the relay exchange", q2.id]]) {
    const served = (await agent.getTask(dee.card.url, id)).body;
    check(same(served, exchangeTask(full, id, agent.obi.id, "dee-agent")), `${name}: GetTask equals conformance/lib/a2a.mjs's exchangeTask`);
  }
  const outsider = await agent.call("GET", `${base}/v0.1/spheres/${sphereId}/members/ari-agent/tasks/${q.id}`);
  check(outsider.status === 404 && outsider.body.error.details[0].reason === "TASK_NOT_FOUND", "the exchange isn't a task at the agent's own url: 404 TASK_NOT_FOUND");
  evidence.receiver_log_lines = receiverLog.split("\n").filter(Boolean).length;
} catch (e) {
  check(false, e.message);
} finally {
  if (receiver) {
    receiver.kill("SIGTERM");
    await new Promise((r) => (receiver.exitCode !== null ? r() : receiver.on("exit", r)));
  }
  try {
    process.kill(-sphereProc.pid, "SIGTERM");
  } catch {}
  await Promise.race([sphereExited, sleep(10000)]);
  evidence.results = results;
  if (opt("--evidence")) writeFileSync(opt("--evidence"), JSON.stringify(evidence, null, 2) + "\n");
  if (!KEEP) rmSync(run, { recursive: true, force: true });
  else console.log(`\nKept the run's folder: ${run} (it holds test keys; delete it when done)`);
}

console.log(`\n${results.length - failures} of ${results.length} checks passed.`);
process.exit(failures ? 1 : 0);
