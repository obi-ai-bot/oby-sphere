#!/usr/bin/env node
// Runs the evaluation's seats (eval/README.md, "Running it"): for each case, `--blind` seats that each review
// alone, then an open panel whose seats 2 to `--open` each see the findings of the seats before them (its seat 1
// is blind seat 1: a first seat sees nothing either way). Each seat's record goes to eval/runs/<case>/<seat>.json;
// a seat whose record exists is not run again.
//
//   node eval/run.mjs --oby ../oby [--cases secret-names,blocking-none] [--blind 5] [--open 3]
//                     [--model sonnet] [--budget 1.5] [--parallel 3]

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runSeat } from "./seat.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({
  options: {
    oby: { type: "string" },
    cases: { type: "string" },
    blind: { type: "string", default: "5" },
    open: { type: "string", default: "3" },
    model: { type: "string", default: "sonnet" },
    budget: { type: "string", default: "1.5" },
    parallel: { type: "string", default: "3" },
  },
});
if (!a.oby) throw new Error("--oby <path to an obi-ai-bot/oby checkout> is required");

const all = JSON.parse(readFileSync(join(here, "cases.json"), "utf8")).cases;
const cases = a.cases ? all.filter((c) => a.cases.split(",").includes(c.id)) : all;
const blind = Number(a.blind);
const open = Number(a.open);
const opts = { oby: a.oby, model: a.model, budget: Number(a.budget) };

const recordPath = (c, name) => join(here, "runs", c.id, `${name}.json`);
const load = (c, name) => JSON.parse(readFileSync(recordPath(c, name), "utf8"));

async function seat(c, name, earlier) {
  const path = recordPath(c, name);
  if (existsSync(path)) return load(c, name);
  const rec = await runSeat({ ...opts, c, name, earlier });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(rec, null, 1) + "\n");
  const cost = rec.cost_usd === null ? "?" : rec.cost_usd.toFixed(3);
  console.log(`${c.id} ${name}: ${rec.outcome ?? rec.subtype}, ${rec.findings.length} findings, $${cost}, ${rec.turns} turns`);
  return rec;
}

// The blind seats, a few at a time.
const jobs = cases.flatMap((c) => Array.from({ length: blind }, (_, i) => [c, `blind-${i + 1}`]));
const queue = [...jobs];
await Promise.all(
  Array.from({ length: Number(a.parallel) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) await seat(job[0], job[1], null);
  }),
);

// The open panels, one seat after another within a case.
await Promise.all(
  cases.map(async (c) => {
    const seen = [...(blind >= 1 ? load(c, "blind-1").findings : [])];
    for (let k = 2; k <= open; k++) {
      const rec = await seat(c, `open-${k}`, seen.map(({ file, line, end_line, severity, title, detail }) => ({ file, line, end_line, severity, title, detail })));
      seen.push(...rec.findings);
    }
  }),
);
