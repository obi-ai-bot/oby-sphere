// The A2A binding's known answers (spec/conformance/a2a-vectors.json, spec/a2a.md section 5),
// judged by the server's own task view (src/protocol/a2a.ts): for each vector, the request and
// replies its SQL would read (src/routes/a2a.ts, readTask), and the task it builds from them.
// `pnpm run conformance` runs it after the case kinds. Exits 1 on any difference.
//
// Node 22.18 or later runs this file as it is (type stripping).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exchangeTask, historyKept, type ExchangeEntry } from "../src/protocol/a2a.ts";
import type { Envelope } from "../src/protocol/envelope.ts";
import { canonicalize } from "../src/protocol/json.ts";

interface Vector {
  name: string;
  id: string;
  caller: string;
  member: string;
  history_length?: number;
  task: unknown;
}

const file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "spec", "conformance", "a2a-vectors.json");
const { chain, vectors } = JSON.parse(readFileSync(file, "utf8")) as { chain: { entries: (ExchangeEntry & { envelope: Envelope })[] }; vectors: Vector[] };
const REPLY = (e: Envelope) => typeof e.in_reply_to === "string";

let ok = 0;
for (const v of vectors) {
  // The request: this id, a request, between the caller and the URL's member, either way round.
  const request = chain.entries.find((e) => e.envelope.id === v.id && !REPLY(e.envelope) && ((e.envelope.from === v.caller && e.envelope.to === v.member) || (e.envelope.from === v.member && e.envelope.to === v.caller)));
  // Its replies, the latest max(kept, 1) of them in the chain's order, as the query reads them.
  const replies = request ? chain.entries.filter((e) => REPLY(e.envelope) && e.envelope.in_reply_to === v.id).slice(-Math.max(historyKept(v.history_length), 1)) : [];
  const task = request ? exchangeTask(request, replies, v.caller, v.history_length) : null;
  if (canonicalize(task as never) === canonicalize(v.task as never)) ok++;
  else console.log(`  FAIL  ${v.name}: the server's task differs from the known answer`);
}
console.log(`a2a-vectors: ${ok} of ${vectors.length} tasks as the known answers say, by the server's own task view.`);
process.exit(ok === vectors.length ? 0 : 1);
