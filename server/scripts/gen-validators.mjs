#!/usr/bin/env node
// Compiles the spec's JSON Schemas (../spec/schemas/v0.1) into one standalone ES module of
// validators, src/protocol/validators.generated.js, so the Worker validates without generating
// code at run time (Workers refuse eval and new Function).
//
//   node scripts/gen-validators.mjs           write the module
//   node scripts/gen-validators.mjs --check   fail if the committed module differs from a fresh one
//
// The ajv options are the reference verifier's (spec/conformance/lib/obi.mjs, loadSchemas), plus
// the code options standalone output needs. Ajv's two runtime helpers (string length in code
// points, deep equality) are inlined, so the module imports nothing.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(here, "..", "..", "spec", "schemas", "v0.1");
const OUT = join(here, "..", "src", "protocol", "validators.generated.js");
const SCHEMA_BASE = "https://github.com/obi-ai-bot/obi-sphere/raw/main/spec/schemas/v0.1/";

// What the server validates, by the name it uses: everything it reads from a client, the
// documents it checks on its own (cards, chains, assertion headers), and what it answers.
const EXPORTS = {
  envelope: "envelope.schema.json",
  sealedEnvelope: "sealed/envelope.schema.json",
  runnerStatus: "runner-status.schema.json",
  agentCard: "agent-card.schema.json",
  auditEntry: "audit-entry.schema.json",
  createSphereRequest: "wire/create-sphere.request.schema.json",
  signinRequest: "wire/signin.request.schema.json",
  invitationRequest: "wire/invitation.request.schema.json",
  sphereUpdateRequest: "wire/sphere-update.request.schema.json",
  invitationPreviewRequest: "wire/invitation-preview.request.schema.json",
  redeemRequest: "wire/redeem.request.schema.json",
  cardUpdateRequest: "wire/card-update.request.schema.json",
  policyPutRequest: "wire/policy-put.request.schema.json",
  ackRequest: "wire/ack.request.schema.json",
  jwsHeader: "wire/jws-header.schema.json",
  delegationClaims: "wire/delegation.claims.schema.json",
  actorClaims: "wire/actor.claims.schema.json",
  // What the server answers: the tests check every answer against its schema.
  healthResponse: "wire/health.response.schema.json",
  featuresResponse: "wire/features.response.schema.json",
  sphere: "wire/sphere.schema.json",
  tokenResponse: "wire/token.response.schema.json",
  invitationResponse: "wire/invitation.response.schema.json",
  invitationsResponse: "wire/invitations.response.schema.json",
  signinResponse: "wire/signin.response.schema.json",
  signinProvidersResponse: "wire/signin-providers.response.schema.json",
  invitationPreviewResponse: "wire/invitation-preview.response.schema.json",
  member: "wire/member.schema.json",
  membersResponse: "wire/members.response.schema.json",
  policy: "wire/policy.schema.json",
  sendResponse: "wire/send.response.schema.json",
  deliveriesResponse: "wire/deliveries.response.schema.json",
  ackResponse: "wire/ack.response.schema.json",
  auditResponse: "wire/audit.response.schema.json",
  // The A2A binding (spec/a2a.md): what it reads, and what it answers.
  a2aSendRequest: "wire/a2a-send.request.schema.json",
  a2aSendResponse: "wire/a2a-send.response.schema.json",
  a2aTask: "wire/a2a-task.schema.json",
  a2aError: "wire/a2a-error.schema.json",
  relay: "wire/relay.schema.json",
  error: "wire/error.schema.json",
};

function schemaFiles(dir) {
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? schemaFiles(path) : name.endsWith(".schema.json") ? [path] : [];
  });
}

function build() {
  const ajv = new Ajv2020({
    strict: true,
    strictTypes: false,
    strictRequired: false,
    allErrors: true,
    validateFormats: false,
    code: { source: true, esm: true, lines: true },
  });
  ajv.addKeyword({ keyword: "x-obi-text", metaSchema: { enum: ["data", "sealed"] } });
  for (const path of schemaFiles(SCHEMA_DIR)) {
    const schema = JSON.parse(readFileSync(path, "utf8"));
    if (schema.$id !== SCHEMA_BASE + relative(SCHEMA_DIR, path)) throw new Error(`${path}: $id does not match its path`);
    ajv.addSchema(schema);
  }
  const refs = Object.fromEntries(Object.entries(EXPORTS).map(([name, file]) => [name, SCHEMA_BASE + file]));
  let code = standaloneCode(ajv, refs);

  // Inline ajv's runtime helpers instead of requiring them.
  const helpers = {
    ucs2length: `function __ucs2length(str) { let n = 0; for (const _ of str) n++; return n; }`,
    equal: `function __equal(a, b) {
  if (a === b) return true;
  if (a && b && typeof a === "object" && typeof b === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => __equal(v, b[i]));
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && __equal(a[k], b[k]));
  }
  return a !== a && b !== b;
}`,
  };
  const used = new Set();
  code = code.replace(/require\("ajv\/dist\/runtime\/(\w+)"\)\.default/g, (_, name) => {
    if (!helpers[name]) throw new Error(`ajv runtime helper ${name} has no inline version`);
    used.add(name);
    return `__${name}`;
  });
  if (/require\(/.test(code)) throw new Error("the generated code still requires a module");
  const prelude = [...used].sort().map((name) => helpers[name]).join("\n");
  return `// Generated by scripts/gen-validators.mjs from spec/schemas/v0.1. Do not edit: run \`pnpm run gen:validators\`.
/* eslint-disable */
${prelude}
${code}
`;
}

const fresh = build();
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {}
  if (current !== fresh) {
    console.error(`${relative(process.cwd(), OUT)} is out of date with spec/schemas: run \`pnpm run gen:validators\` and commit it.`);
    process.exit(1);
  }
  console.log(`${relative(process.cwd(), OUT)} matches spec/schemas/v0.1.`);
} else {
  writeFileSync(OUT, fresh);
  console.log(`wrote ${relative(process.cwd(), OUT)} (${Object.keys(EXPORTS).length} validators, ${fresh.length} bytes)`);
}
