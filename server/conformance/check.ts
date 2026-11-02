// The Sphere server's conformance checker: the conformance runner's --impl contract
// (spec/conformance/README.md) with the server's own protocol code (src/protocol/), the same code
// the Worker runs. Reads one case ({case, context, input}) on stdin, prints one JSON line, and
// exits 0 to accept, 1 to reject, 2 when stdin is not a case.
//
//   node ../spec/conformance/run.mjs --impl "node <abs path>/server/conformance/check.ts"
//
// Node 22.18 or later runs this file as it is (type stripping); `pnpm run conformance` does the above.

import { readFileSync } from "node:fs";
import { agreementProblem, sendRequestProblem, type SendMessage } from "../src/protocol/a2a.ts";
import { verifyCard } from "../src/protocol/card.ts";
import { verifyChain } from "../src/protocol/chain.ts";
import { checkEnvelopeShape, verifyEnvelope, type ReceiverContext, type Verdict } from "../src/protocol/envelope.ts";
import * as validators from "../src/protocol/validators.generated.js";
import { schemaErrors, type SchemaName } from "../src/protocol/schemas.ts";
// @ts-expect-error: the spec's reference implementation is JavaScript with no types.
import { openedProblem } from "../../spec/conformance/lib/obi.mjs";

/** A wire case's schema (`wire/invitation-preview.request`) by the name the server compiles it under (`invitationPreviewRequest`). */
const wireSchema = (schema: unknown): SchemaName | undefined => {
  const m = typeof schema === "string" ? /^wire\/([a-z.-]+)$/.exec(schema) : null;
  const name = m?.[1]!.replace(/[-.]([a-z])/g, (_, c: string) => c.toUpperCase());
  return name && Object.hasOwn(validators, name) ? (name as SchemaName) : undefined;
};

let testCase: { case?: unknown; context?: unknown; input?: unknown };
try {
  testCase = JSON.parse(readFileSync(0, "utf8"));
} catch (e) {
  console.log(JSON.stringify({ verdict: "error", message: `stdin is not JSON: ${(e as Error).message}` }));
  process.exit(2);
}

let verdict: Verdict;
switch (testCase.case) {
  case "envelope":
    verdict = await verifyEnvelope(testCase.input, testCase.context as ReceiverContext);
    // Check 11 (protocol.md section 9.1) is the receiving Obi's: a Sphere holds no seal key and
    // never opens anything. The checker makes it with the reference implementation's.
    if (verdict.ok) verdict = openedProblem(testCase.input, testCase.context) ?? verdict;
    break;
  case "card":
    verdict = await verifyCard(testCase.input, (testCase.context ?? {}) as { now?: string; bound_owner_key?: string });
    break;
  case "audit":
    verdict = await verifyChain(testCase.input, (testCase.context ?? { keys: {} }) as { keys: Record<string, never> });
    break;
  case "a2a": {
    // The A2A binding's checks (spec/a2a.md section 4, checks 5 to 9), then the envelope as an envelope case.
    const ctx = testCase.context as ReceiverContext;
    const problem = sendRequestProblem(testCase.input);
    if (problem) {
      verdict = { ok: false, code: problem.code, message: problem.message };
      break;
    }
    const { message } = testCase.input as SendMessage;
    const shape = checkEnvelopeShape(message.parts[0].data);
    const disagreement = shape.ok ? agreementProblem(message, shape.envelope, ctx.receiver) : null;
    if (!shape.ok) verdict = { ok: false, code: shape.code, message: shape.message };
    else if (disagreement) verdict = { ok: false, code: disagreement.code, message: disagreement.message };
    else {
      verdict = await verifyEnvelope(shape.envelope, ctx);
      if (verdict.ok) verdict = openedProblem(shape.envelope, ctx) ?? verdict;
    }
    break;
  }
  case "wire": {
    const name = wireSchema((testCase.context as { schema?: unknown } | undefined)?.schema);
    const errors = name ? schemaErrors(name, testCase.input) : ["the server compiles no such wire schema"];
    verdict = errors.length ? { ok: false, code: "bad_request", message: errors.join("; ") } : { ok: true };
    break;
  }
  default:
    console.log(JSON.stringify({ verdict: "error", message: "not a conformance case" }));
    process.exit(2);
}

console.log(JSON.stringify(verdict.ok ? { verdict: "accept" } : { verdict: "reject", code: verdict.code, message: verdict.message }));
process.exit(verdict.ok ? 0 : 1);
