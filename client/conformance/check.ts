// The client library's conformance checker: the conformance runner's --impl contract
// (spec/conformance/README.md) with nothing but the library. Reads one case ({case, context,
// input}) on stdin, prints one JSON line, and exits 0 to accept, 1 to reject, 2 when stdin is not
// a case it judges.
//
//   node ../spec/conformance/run.mjs --impl "node <abs path>/client/conformance/check.ts" --kinds envelope,card,audit,wire
//
// `pnpm run conformance` does that. host_approval cases are a receiving member's decision about a
// code host, not the library's.

import { readFileSync } from "node:fs";
import { SealKey, fromB64url, isSchemaName, schemaErrors, verifyAndOpen, verifyCard, verifyChain, type OpeningContext, type Verdict } from "../src/index.ts";

let testCase: { case?: unknown; context?: unknown; input?: unknown };
try {
  testCase = JSON.parse(readFileSync(0, "utf8"));
} catch (e) {
  console.log(JSON.stringify({ verdict: "error", message: `stdin is not JSON: ${(e as Error).message}` }));
  process.exit(2);
}

const context = (testCase.context ?? {}) as Record<string, unknown>;
let verdict: Verdict;
switch (testCase.case) {
  case "envelope": {
    // The fixtures give the receiver's seal keys as {key_id: base64url of the 32 private bytes}.
    const sealKeys: Record<string, SealKey> = {};
    for (const [id, priv] of Object.entries((context.seal_keys ?? {}) as Record<string, string>)) sealKeys[id] = await SealKey.fromPrivate(fromB64url(priv));
    const v = await verifyAndOpen(testCase.input, { ...(context as unknown as OpeningContext), seal_keys: sealKeys });
    verdict = v.ok ? { ok: true } : v;
    break;
  }
  case "card":
    verdict = await verifyCard(testCase.input, context as { now?: string; bound_owner_key?: string });
    break;
  case "audit":
    verdict = await verifyChain(testCase.input, (testCase.context ?? { keys: {} }) as { keys: Record<string, never> });
    break;
  case "wire": {
    const name = context.schema;
    const errors = typeof name === "string" && name.startsWith("wire/") && isSchemaName(name) ? schemaErrors(name, testCase.input) : [`no wire schema ${String(name)}`];
    verdict = errors.length ? { ok: false, code: "bad_request", message: errors.join("; ") } : { ok: true };
    break;
  }
  default:
    console.log(JSON.stringify({ verdict: "error", message: "not a case kind this checker judges" }));
    process.exit(2);
}

console.log(JSON.stringify(verdict.ok ? { verdict: "accept" } : { verdict: "reject", code: verdict.code, message: verdict.message }));
process.exit(verdict.ok ? 0 : 1);
