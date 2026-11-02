#!/usr/bin/env node
// The conformance runner for the Obi-to-Obi protocol v0.1.
//
//   node conformance/run.mjs                    self-check: schemas, fixtures, reference verdicts
//   node conformance/run.mjs --impl "<cmd>"     judge an implementation: each case's {case, context,
//                                               input} on stdin (never its expected verdict),
//                                               exit 0 = accept, anything else = reject
//   node conformance/run.mjs --receiver "<cmd>" run the receiver track (receiver/README section): a
//                                               live implementation, enrolled through its adapter
//                                               command, against scripted adversarial peers
//   node conformance/run.mjs --badge <report.json>  write an SVG badge from a report to stdout
//   options: --kinds envelope,card,audit,wire,host_approval,a2a   only these case kinds (impl mode)
//            --verbose                     print every case, not only the failures
//            --report <file> --label <impl>   with --impl or --receiver: write/merge a per-class
//                                             report (conformance/report.mjs) an impl can publish
//            receiver track: --server <dir> (the Sphere server; default ../server),
//                            --sphere-url <loopback url> (a Sphere already running) with
//                            --operator-token <t>, --corpus <file>, --only <id,id>, --keep
//
// Exit status 0 when every check passes, 1 otherwise.

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixtures } from "./generate.mjs";
import { badgeSvg, classOfFixture, loadOrNew, recordImpl, recordReceiver, writeReport } from "./report.mjs";
import {
  ACTION_TYPES, REPLY_TYPES, SCHEMA_DIR, canonicalize, channelKeys, fromB64url, helloSigningInput, judge, openFrame, schemas, sealFrame,
  x25519FromPrivate, x25519Shared, SEAL_INFO_PREFIX, openBody, sealEnvelope, sealKey, sealKeyIdOf, sealNonce, schemaErrors, verifyChain,
} from "./lib/obi.mjs";
import { exchangeTask } from "./lib/a2a.mjs";
import { createPublicKey, verify } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const verbose = flag("--verbose");

// The commit the suite ran at, for a published report (best-effort): $GITHUB_SHA, else `git rev-parse`.
function suiteCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: here, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

function loadCases(kinds) {
  return listFiles(join(here, "fixtures"))
    .filter((p) => p.endsWith(".json"))
    .sort()
    .map((p) => ({ path: relative(here, p), data: JSON.parse(readFileSync(p, "utf8")) }))
    .filter((c) => !kinds || kinds.includes(c.data.case));
}

let failures = 0;
const failed = (section, message) => {
  failures++;
  console.log(`FAIL ${section}: ${message}`);
};
const section = (title) => console.log(`\n== ${title}`);

// ---------------------------------------------------------------------------------------------
// Implementation mode.

// What an implementation is given for a case: what to judge and what to judge it against, never
// the answer (`expect`, `reason`) or the words that describe it (`name`, `description`).
const IMPL_FIELDS = ["case", "context", "input"];
const implInput = (testCase) => Object.fromEntries(IMPL_FIELDS.filter((k) => k in testCase).map((k) => [k, testCase[k]]));

function runImpl(command, testCase) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, out, err: err + "\n(timed out after 20 seconds)" });
    }, 20000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(implInput(testCase)));
  });
}

async function implMode(command, kinds, label = "implementation") {
  const cases = loadCases(kinds);
  let passed = 0;
  const byClass = {}; // per conformance class, for a report (classOfFixture): {class: {ran, passed}}
  const tally = (cls, ok) => {
    const b = (byClass[cls] ??= { ran: 0, passed: 0 });
    b.ran++;
    if (ok) b.passed++;
  };
  const queue = [...cases];
  const workers = Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const c = queue.shift();
      const r = await runImpl(command, c.data);
      const got = r.code === 0 ? "accept" : r.code === null ? "error" : "reject";
      const ok = got === c.data.expect;
      tally(classOfFixture(c.data), ok);
      if (ok) {
        passed++;
        if (verbose) console.log(`ok   ${c.path} (${got})`);
      } else {
        failed(label, `${c.path}: expected ${c.data.expect}, got ${got} (exit ${r.code}) ${c.data.description}${r.out.trim() ? `\n     stdout: ${r.out.trim().slice(0, 300)}` : ""}${r.err.trim() ? `\n     stderr: ${r.err.trim().slice(0, 300)}` : ""}`);
      }
    }
  });
  await Promise.all(workers);
  console.log(`${label}: ${passed} of ${cases.length} cases as expected.`);
  return { ok: passed === cases.length, byClass };
}

// ---------------------------------------------------------------------------------------------
// Self-check.

const TEXT_DEFS = new Set(["line_text", "block_text"]);
const SEALED_TEXT_DEF = "sealed_text";

function lintSchemas() {
  section("Schemas");
  const { schemas: all } = schemas();
  let objects = 0, strings = 0, texts = 0;
  const walk = (name, node, path, parentHasTextAnnotation = false) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(name, n, `${path}/${i}`));
    if (!node || typeof node !== "object") return;
    // if/then/else/not only refine the object they sit in; they don't define one.
    const refiner = ["if", "then", "else", "not"].includes(path.split("/").pop());
    if (node.properties && !refiner) {
      objects++;
      if (node.additionalProperties !== false) failed("schemas", `${name}${path}: an object with properties must set additionalProperties: false`);
    }
    if (node.type === "string") {
      strings++;
      const last = path.split("/").pop();
      const isTextDef = (TEXT_DEFS.has(last) || last === SEALED_TEXT_DEF) && path.startsWith("/$defs/");
      if (!isTextDef && node.maxLength === undefined) failed("schemas", `${name}${path}: a string needs maxLength`);
      if (!isTextDef && node.pattern === undefined && node.enum === undefined && node.const === undefined) failed("schemas", `${name}${path}: a string that isn't data text needs a pattern, enum or const`);
    }
    if (typeof node.$ref === "string") {
      const target = node.$ref.split("#/$defs/")[1];
      if (TEXT_DEFS.has(target)) {
        texts++;
        if (node["x-obi-text"] !== "data") failed("schemas", `${name}${path}: human-written text must be annotated x-obi-text: data`);
        if (node.maxLength === undefined || node.minLength === undefined) failed("schemas", `${name}${path}: data text sets its own minLength and maxLength`);
      } else if (target === SEALED_TEXT_DEF) {
        if (!name.startsWith("sealed/") || node["x-obi-text"] !== "sealed") failed("schemas", `${name}${path}: sealed text is only in the sealed schemas, annotated x-obi-text: sealed`);
        if (node.maxLength === undefined || node.minLength === undefined) failed("schemas", `${name}${path}: sealed text sets its own minLength and maxLength`);
      } else if (node["x-obi-text"] !== undefined) {
        failed("schemas", `${name}${path}: x-obi-text belongs only on line_text, block_text or sealed_text`);
      }
    } else if (node["x-obi-text"] !== undefined) {
      failed("schemas", `${name}${path}: x-obi-text belongs only on line_text or block_text`);
    }
    for (const [k, v] of Object.entries(node)) if (k !== "enum" && k !== "const") walk(name, v, `${path}/${k}`);
  };
  for (const [name, schema] of Object.entries(all)) walk(name, schema, "");
  const types = all.common.$defs.action_type.enum;
  if (canonicalize([...types].sort()) !== canonicalize([...ACTION_TYPES].sort())) failed("schemas", `the action types are ${types.join(", ")}`);
  for (const t of types) if (!all[`actions/${t}`]) failed("schemas", `no body schema for ${t}`);
  for (const t of types) if (/message|chat|text|prompt/.test(t)) failed("schemas", `${t} looks like a free-text type`);
  console.log(`${Object.keys(all).length} schemas compiled (draft 2020-12). ${objects} objects closed, ${strings} strings bounded, ${texts} data-text fields annotated x-obi-text: data. Action types: ${types.join(", ")}.`);
}

function checkJcs() {
  section("Canonical JSON (RFC 8785)");
  const vectors = JSON.parse(readFileSync(join(here, "jcs-vectors.json"), "utf8")).vectors;
  let ok = 0;
  for (const v of vectors) {
    const got = canonicalize(v.input);
    if (got === v.canonical) ok++;
    else failed("jcs", `${v.name}: got ${got}`);
  }
  console.log(`${ok} of ${vectors.length} vectors canonicalize as expected.`);
}

/** The job channel's known answers (channel-vectors.json), recomputed from their inputs. */
function checkChannel() {
  section("Job channel known answers (protocol.md section 13)");
  const v = JSON.parse(readFileSync(join(here, "channel-vectors.json"), "utf8"));
  const eq = (what, got, want) => (Buffer.from(got).equals(fromB64url(want)) ? 1 : (failed("channel", `${what} differs`), 0));
  let ok = 0;
  const sides = {};
  for (const role of ["guest", "host"]) {
    const s = v[role];
    const x = x25519FromPrivate(fromB64url(s.x25519_private));
    ok += eq(`${role}'s X25519 public key`, x.publicRaw, s.hello.x25519);
    ok += eq(`${role}'s hello bytes`, Buffer.from(canonicalize(s.hello), "utf8"), s.hello_bytes);
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: s.public_key }, format: "jwk" });
    if (verify(null, helloSigningInput(s.hello), pub, fromB64url(s.hello.signature))) ok++;
    else failed("channel", `${role}'s hello signature doesn't verify`);
    sides[role] = x;
  }
  const shared = x25519Shared(sides.guest.privateKey, sides.host.publicRaw);
  ok += eq("the shared secret", shared, v.shared);
  const k = channelKeys(shared, fromB64url(v.guest.hello_bytes), fromB64url(v.host.hello_bytes));
  ok += eq("the salt", k.salt, v.salt) + eq("guest>host key", k.guestToHost, v.guest_to_host) + eq("host>guest key", k.hostToGuest, v.host_to_guest);
  for (const f of v.frames) {
    const key = f.direction === "guest>host" ? k.guestToHost : k.hostToGuest;
    ok += eq(`the ${f.direction} frame`, sealFrame(key, f.counter, f.stream, f.kind, fromB64url(f.payload)), f.wire);
    const opened = openFrame(key, f.counter, fromB64url(f.wire));
    if (opened.stream === f.stream && opened.kind === f.kind) ok++;
    else failed("channel", `the ${f.direction} frame opens wrong`);
  }
  console.log(`${ok} channel answers as expected.`);
}

/** Sealing's known answers (seal-vectors.json), recomputed from their inputs. */
function checkSeal() {
  section("Sealing known answers (protocol.md section 9.1)");
  const v = JSON.parse(readFileSync(join(here, "seal-vectors.json"), "utf8"));
  const eq = (what, got, want) => (Buffer.from(got).equals(fromB64url(want)) ? 1 : (failed("seal", `${what} differs`), 0));
  let ok = 0;
  const recipient = x25519FromPrivate(fromB64url(v.recipient.x25519_private));
  ok += eq("the recipient's seal key", recipient.publicRaw, v.recipient.seal_public_key);
  if (sealKeyIdOf(recipient.publicRaw) === v.recipient.seal_key_id) ok++;
  else failed("seal", "seal_key_id differs");
  const sender = x25519FromPrivate(fromB64url(v.sender_x25519_private));
  ok += eq("enc", sender.publicRaw, v.enc);
  const shared = x25519Shared(sender.privateKey, recipient.publicRaw);
  ok += eq("the X25519 secret", shared, v.shared) + eq("the X25519 secret, from the recipient's side", x25519Shared(recipient.privateKey, sender.publicRaw), v.shared);
  ok += eq("info", Buffer.concat([Buffer.from(SEAL_INFO_PREFIX, "utf8"), Buffer.from(canonicalize({ sphere: v.plain.sphere, id: v.plain.id, from: v.plain.from, to: v.plain.to, type: v.plain.type }), "utf8")]), v.info);
  ok += eq("the HKDF output", sealKey(shared, sender.publicRaw, recipient.publicRaw, v.plain), v.hkdf_output);
  const resealed = sealEnvelope(v.plain, recipient.publicRaw, fromB64url(v.sender_x25519_private));
  const { signature: _signature, ...sealedUnsigned } = v.sealed;
  if (canonicalize(resealed) === canonicalize(sealedUnsigned)) ok++;
  else failed("seal", "sealing the plain envelope gives another sealed one");
  for (const value of v.values) {
    ok += eq(`${value.pointer}'s nonce`, sealNonce(value.pointer), value.nonce);
    const sealedValue = value.pointer.split("/").slice(1).reduce((x, t) => x[t], v.sealed.body);
    if (sealedValue === value.sealed) ok++;
    else failed("seal", `${value.pointer}'s sealed value differs`);
  }
  if (canonicalize(openBody(v.sealed, fromB64url(v.recipient.x25519_private))) === canonicalize(v.plain.body)) ok++;
  else failed("seal", "the sealed envelope opens to another body");
  console.log(`${ok} sealing answers as expected.`);
}

/** GetTask's known answers (a2a-vectors.json): a valid chain, each task as the reference shows it, each matching its schema. */
function checkA2aVectors() {
  section("A2A binding known answers (a2a.md section 5)");
  const v = JSON.parse(readFileSync(join(here, "a2a-vectors.json"), "utf8"));
  const chain = verifyChain(v.chain, { keys: v.keys });
  if (!chain.ok) failed("a2a", `the vectors' chain doesn't verify: ${chain.message}`);
  let ok = 0;
  for (const t of v.vectors) {
    const got = exchangeTask(v.chain.entries, t.id, t.caller, t.member, { historyLength: t.history_length });
    if (canonicalize(got) !== canonicalize(t.task)) failed("a2a", `${t.name}: the task differs`);
    else if (t.task !== null && schemaErrors("wire/a2a-task", t.task).length) failed("a2a", `${t.name}: ${schemaErrors("wire/a2a-task", t.task).join("; ")}`);
    else ok++;
  }
  console.log(`${ok} of ${v.vectors.length} tasks as expected, each matching wire/a2a-task; the chain verifies.`);
}

function checkDeterminism() {
  section("Fixtures are reproducible");
  const expected = buildFixtures();
  const onDisk = new Set(listFiles(join(here, "fixtures")).map((p) => relative(here, p)));
  onDisk.add("keys.json");
  onDisk.add("channel-vectors.json");
  onDisk.add("seal-vectors.json");
  let same = 0;
  for (const [path, content] of Object.entries(expected)) {
    let actual = null;
    try {
      actual = readFileSync(join(here, path), "utf8");
    } catch {}
    if (actual === content) same++;
    else failed("fixtures", `${path} differs from what generate.mjs produces: run \`pnpm run generate\``);
    onDisk.delete(path);
  }
  for (const path of onDisk) failed("fixtures", `${path} is not produced by generate.mjs: remove it or generate it`);
  console.log(`${same} of ${Object.keys(expected).length} generated files match the committed ones.`);
  if (/PRIVATE KEY|"d":/.test(Object.values(expected).join(""))) failed("fixtures", "a private key appears in the fixtures");
}

// The repository's .gitleaks.toml allowlists the test keys' public keys, which the generic
// API-key rule mistakes for secrets. It must name exactly keys.json's public keys: a new test key
// would otherwise make a secret scan refuse the fixtures, and a stale entry would hide a value
// that is no longer a known public key.
function checkSecretScanAllowlist() {
  section("Secret-scan allowlist");
  const path = join(here, "..", "..", ".gitleaks.toml");
  let toml = "";
  try {
    toml = readFileSync(path, "utf8");
  } catch {
    failed("allowlist", "no .gitleaks.toml at the repository's root");
    return;
  }
  const listed = [...toml.matchAll(/^\s*'''([A-Za-z0-9_-]{43})''',?\s*$/gm)].map((m) => m[1]).sort();
  const keys = Object.values(JSON.parse(readFileSync(join(here, "keys.json"), "utf8")).keys).map((k) => k.public_key).sort();
  if (canonicalize(listed) !== canonicalize(keys)) failed("allowlist", `.gitleaks.toml allowlists ${listed.join(", ") || "nothing"}; keys.json's public keys are ${keys.join(", ")}`);
  else console.log(`.gitleaks.toml allowlists exactly the ${keys.length} public keys in keys.json, only under spec/conformance/.`);
}

function checkVerdicts() {
  section("Reference verdicts");
  const cases = loadCases();
  const counts = {};
  for (const c of cases) {
    const verdict = judge(c.data);
    const got = verdict.ok ? "accept" : "reject";
    const key = `${c.data.case} ${c.data.expect}`;
    counts[key] = (counts[key] ?? 0) + 1;
    if (got !== c.data.expect) failed("verdict", `${c.path}: expected ${c.data.expect}, got ${got}${verdict.ok ? "" : ` (${verdict.code}: ${verdict.message})`}`);
    else if (!verdict.ok && c.data.reason && verdict.code !== c.data.reason) failed("verdict", `${c.path}: rejected as ${verdict.code} (${verdict.message}), expected ${c.data.reason}`);
    else if (verbose) console.log(`ok   ${c.path} (${got}${verdict.ok ? "" : `: ${verdict.code}`})`);
  }
  console.log(`${cases.length} cases: ${Object.entries(counts).sort().map(([k, n]) => `${n} ${k}`).join(", ")}.`);
  return cases;
}

function checkCoverage(cases) {
  section("Coverage");
  const names = new Set(cases.map((c) => `${c.data.case}/${c.data.name}`));
  const need = [];
  for (const t of ACTION_TYPES) need.push(`envelope/valid-${t === "result" ? "result-review" : t}`);
  need.push("envelope/valid-result-handoff");
  for (const f of ["protocol", "id", "type", "from", "to", "sphere", "correlation_id", "created_at", "expires_at", "key_id", "body", "signature"]) need.push(`envelope/invalid-missing-envelope-${f.replaceAll("_", "-")}`);
  const { schemas: all } = schemas();
  for (const t of ACTION_TYPES.filter((t) => t !== "result")) for (const f of all[`actions/${t}`].required) need.push(`envelope/invalid-missing-${t.replaceAll("_", "-")}-${f.replaceAll("_", "-")}`);
  for (const [i, key] of [[0, "result"], [1, "result-handoff"]]) for (const f of all["actions/result"].oneOf[i].required) need.push(`envelope/invalid-missing-${key}-${f.replaceAll("_", "-")}`);
  for (const t of REPLY_TYPES) need.push(`envelope/invalid-reply-without-in-reply-to-${t}`);
  for (const n of ["bad-signature-flipped-bit", "expired", "unknown-type-message", "extra-envelope-field", "smuggle-body-instructions", "smuggle-body-prompt", "smuggle-body-message", "oversize-goal", "oversize-envelope"]) need.push(`envelope/invalid-${n}`);
  for (const n of ["valid-chain", "valid-chain-status-before-accept", "invalid-chain-accepted-twice", "invalid-chain-tampered-entry", "invalid-chain-reordered", "invalid-chain-broken-link"]) need.push(`audit/${n}`);
  for (const n of ["invalid-chain-review-result-without-accept", "invalid-chain-handoff-result-without-accept", "valid-chain-handoff-accepted", "valid-chain-question-answered-directly", "valid-chain-question-accepted-then-answered", "invalid-chain-result-for-another-kind", "valid-chain-decline-after-accept", "invalid-chain-reply-after-result"]) need.push(`audit/${n}`);
  // Questions and answers: words are data (an injection attempt in text is a valid question), fields
  // and kinds outside the schema are not, and only an answer answers a question.
  for (const n of ["valid-answer-by-obi", "valid-question-about-refs", "valid-question-injection-is-data", "invalid-smuggle-question-instructions", "invalid-smuggle-answer-action", "invalid-result-for-question", "invalid-ref-unknown-kind", "invalid-answer-by-owner-with-rule", "invalid-ref-repeated-other-case", "invalid-answer-refs-repeated-other-case"]) need.push(`envelope/${n}`);
  // Text in any language, in one-line text and in block text alike.
  need.push("envelope/valid-text-with-newlines-and-unicode");
  for (const n of ["valid-chain-question-asked-owner", "invalid-chain-answer-to-review-request", "invalid-chain-reply-after-answer", "invalid-chain-answered-twice"]) need.push(`audit/${n}`);
  for (const n of ["valid-key-rotated-after-relay", "invalid-key-not-valid-at-seq", "invalid-key-not-current-at-send", "invalid-wrong-recipient", "invalid-wrong-recipient-reply"]) need.push(`envelope/${n}`);
  need.push("card/valid-card", "card/invalid-card-changed-after-signing");
  // The card's runtime, vendors and features (#54, identity.md section 2.3): each is declared behind
  // the card_runtime feature, and a card listing an addition's members without its feature is invalid.
  for (const n of ["valid-card-with-runtime-and-vendors", "valid-card-with-features-only", "valid-card-with-an-unknown-feature", "valid-card-runtime-nobody-listed", "invalid-card-features-without-card-runtime", "invalid-card-runtime-without-features", "invalid-card-vendors-without-features", "invalid-card-features-empty", "invalid-card-vendors-empty", "invalid-card-runtime-without-version", "invalid-card-feature-repeated", "invalid-card-vendor-repeated"]) need.push(`card/${n}`);
  // The Obysphere's features (sphere-api.md, GET /v0.1/features; health stays closed).
  for (const n of ["valid-features-card-runtime", "valid-features-takes-none", "valid-features-unknown-id", "invalid-features-list-missing", "invalid-features-id-repeated", "invalid-health-lists-features"]) need.push(`wire/${n}`);
  // A policy rule may require a conformance class (sphere-api.md section 5, the policy_classes feature).
  for (const n of ["valid-policy-put", "valid-policy-put-classes", "valid-policy-classes-response", "invalid-policy-put-class-not-an-id", "invalid-policy-put-classes-empty", "invalid-policy-put-classes-repeated", "invalid-policy-put-seventeen-classes"]) need.push(`wire/${n}`);
  // The A2A binding (a2a.md section 4): the envelope is all that travels, and the message agrees with it.
  for (const n of ["valid-question", "valid-answer", "invalid-text-part-beside-envelope", "invalid-message-metadata", "invalid-message-id-not-envelope-id", "invalid-task-id-on-request", "invalid-reply-without-task-id", "invalid-blocking", "invalid-envelope-bad-signature", "invalid-to-another-member"]) need.push(`a2a/${n}`);
  // Invitations, named and open (sphere-api.md section 4).
  for (const n of ["valid-invitation-named", "valid-invitation-open", "invalid-invitation-owner-without-obi", "invalid-invitation-named-max-uses", "invalid-invitation-email-domain", "valid-invitation-preview-response"]) need.push(`wire/${n}`);
  // Approving on the code host (protocol.md section 11): the owner's confirmation counts only for
  // this exchange, at this commit, fresh and once; a standing permission alone never does.
  for (const n of ["valid-owner-confirmed", "invalid-no-owner-confirmation", "invalid-owner-confirmed-other-exchange", "invalid-owner-confirmed-older-head", "invalid-owner-confirmation-stale", "invalid-owner-confirmation-used", "invalid-owner-confirmation-not-from-device", "invalid-owner-confirmed-request-expired", "invalid-standing-permission-alone", "valid-code-owners-approved", "invalid-code-owners-approved-no-standing-permission", "invalid-code-owner-approved-older-head", "invalid-code-owner-review-by-an-obi", "invalid-receivers-own-owner-is-not-a-code-owner-here", "invalid-not-every-file-approved", "invalid-file-with-no-owners", "invalid-code-owner-review-obi-verdict", "invalid-code-owner-without-write-access", "invalid-team-in-another-org", "valid-logins-in-any-case", "valid-owner-confirmation-device-clock-ahead", "invalid-owner-confirmation-from-the-future"]) need.push(`host_approval/${n}`);
  let ok = 0;
  for (const n of need) {
    if (names.has(n)) ok++;
    else failed("coverage", `no fixture ${n}`);
  }
  console.log(`${ok} of ${need.length} required fixtures present.`);
}

// Implementation mode gives an implementation only {case, context, input}: a checker that just
// echoed the fixture's `expect` would otherwise pass every case.
async function checkImplInput() {
  section("Implementation mode hides the expected verdicts");
  const cases = loadCases();
  const keys = `"${process.execPath}" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Object.keys(JSON.parse(s)).sort().join(",")))'`;
  const echo = `"${process.execPath}" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s).expect==="accept"?0:1))'`;
  let ok = 0;
  let echoRight = 0;
  for (const c of cases) {
    const r = await runImpl(keys, c.data);
    const got = r.out.trim();
    const want = IMPL_FIELDS.filter((k) => k in c.data).sort().join(",");
    if (r.code === 0 && got === want) ok++;
    else failed("impl input", `${c.path}: the implementation was given ${got || "nothing"} (exit ${r.code}), not ${want}`);
    const e = await runImpl(echo, c.data);
    if ((e.code === 0 ? "accept" : "reject") === c.data.expect) echoRight++;
  }
  if (echoRight === cases.length) failed("impl input", "a checker that only echoes the fixture's `expect` passed every case");
  console.log(`${ok} of ${cases.length} cases reach the implementation as {${IMPL_FIELDS.join(", ")}} only. A checker that echoes \`expect\` gets ${echoRight} of ${cases.length} right (it must not get all).`);
}

async function selfCheck() {
  console.log("Obi-to-Obi protocol v0.1: conformance self-check");
  lintSchemas();
  checkJcs();
  checkChannel();
  checkSeal();
  checkA2aVectors();
  checkDeterminism();
  checkSecretScanAllowlist();
  const cases = checkVerdicts();
  checkCoverage(cases);
  section("Implementation mode, with the reference verifier");
  await implMode(`"${process.execPath}" "${join(here, "verify.mjs")}"`, undefined, "reference --impl");
  await checkImplInput();
  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
  return failures === 0;
}

// ---------------------------------------------------------------------------------------------
// The receiver track (receiver/harness.mjs): a live implementation against scripted peers.

async function receiverMode(command, reportPath, label) {
  const { runReceiverTrack } = await import("./receiver/harness.mjs");
  console.log("Obi-to-Obi protocol v0.1: conformance receiver track");
  const result = await runReceiverTrack({
    adapter: command,
    serverDir: option("--server") ?? join(here, "..", "..", "server"),
    sphereUrl: option("--sphere-url"),
    operatorToken: option("--operator-token"),
    corpusPath: option("--corpus"),
    only: option("--only") ? new Set(option("--only").split(",")) : undefined,
    keep: flag("--keep"),
    onLog: (line) => console.log(line),
  });
  for (const r of result.results.filter((r) => r.status === "fail")) {
    for (const p of r.problems) console.log(`      - ${r.id}: ${p}`);
  }
  const byClass = {};
  for (const r of result.results) {
    const c = (byClass[r.class] ??= { pass: 0, fail: 0, "n/a": 0 });
    c[r.status]++;
  }
  console.log("\nPer class:");
  for (const [cls, c] of Object.entries(byClass)) console.log(`  ${cls}: ${c.pass} passed, ${c.fail} failed, ${c["n/a"]} not applicable`);
  if (result.root) console.log(`Kept the run folder at ${result.root}`);
  if (reportPath) {
    const report = recordReceiver(loadOrNew(reportPath, label), result.results);
    report.commit = suiteCommit();
    writeReport(reportPath, report);
    console.log(`Wrote the behaviour part of the report to ${reportPath}.`);
  }
  console.log(result.ok ? "\nThe receiver track passed." : `\n${result.results.filter((r) => r.status === "fail").length} case(s) failed.`);
  return result.ok;
}

const impl = option("--impl");
const receiver = option("--receiver");
const badge = option("--badge");
const reportPath = option("--report");
const label = option("--label");
const kinds = option("--kinds")?.split(",");
if (badge) {
  // Print an SVG badge from an existing report file, and do nothing else.
  process.stdout.write(badgeSvg(JSON.parse(readFileSync(badge, "utf8"))) + "\n");
  process.exit(0);
}
if (args.includes("--impl") && !impl) {
  console.error('--impl needs a command, like --impl "node conformance/verify.mjs"');
  process.exit(64);
}
if (args.includes("--receiver") && !receiver) {
  console.error('--receiver needs an adapter command, like --receiver "node conformance/receiver/receivers/receiver.mjs careful"');
  process.exit(64);
}
let passed;
if (receiver) {
  passed = await receiverMode(receiver, reportPath, label);
} else if (impl) {
  const res = await implMode(impl, kinds);
  if (reportPath) {
    const report = recordImpl(loadOrNew(reportPath, label), res.byClass);
    report.commit = suiteCommit();
    writeReport(reportPath, report);
    console.log(`Wrote the message part of the report to ${reportPath}.`);
  }
  passed = res.ok;
} else {
  passed = await selfCheck();
}
process.exit(passed ? 0 : 1);
