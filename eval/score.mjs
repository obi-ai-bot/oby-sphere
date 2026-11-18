#!/usr/bin/env node
// Scores the seats' records in eval/runs (eval/README.md, "How it is scored"): no model judges anything. A
// finding catches a case's bug when it names one of the files the later fix changed and its lines come within
// the window of a line the fix removed or changed; the clerk counts every panel's verdict. Writes
// eval/scores.json and prints the tables eval/RESULTS.md quotes.
//
//   node eval/score.mjs

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { count } from "../clerk/ts/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));
const W = spec.window;

const hits = (f, c) =>
  Object.entries(c.lines).some(
    ([file, lines]) => f.file === file && lines.some((l) => f.line - W <= l && l <= (f.end_line ?? f.line) + W),
  );
const near = (f, g) => f.file === g.file && Math.abs(f.line - g.line) <= W;

function load(c) {
  const dir = join(here, "runs", c.id);
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => [n.slice(0, -5), JSON.parse(readFileSync(join(dir, n), "utf8"))]));
}

/** One seat: whether it caught the bug, as anything and as a blocker, its false blockers, its cost. */
function seat(rec, c) {
  const blockers = rec.findings.filter((f) => f.severity === "blocker");
  return {
    ok: !rec.is_error && rec.outcome !== null,
    caught: rec.findings.some((f) => hits(f, c)),
    caught_blocking: blockers.some((f) => hits(f, c)),
    blockers: blockers.length,
    false_blockers: blockers.filter((f) => !hits(f, c)).length,
    findings: rec.findings.length,
    cost: rec.cost_usd ?? 0,
  };
}

/** A panel's verdict by the clerk: majority, a quorum of half the seats (rounded up), blocking findings veto, none challenged. */
function panel(recs, c) {
  const seats = recs.map((_, i) => `s${i + 1}`);
  const ballots = recs.flatMap((r, i) => (r.outcome ? [{ seat: seats[i], vote: r.outcome === "approved" ? "approve" : "reject" }] : []));
  const findings = recs.flatMap((r, i) =>
    r.findings.map((f, j) => ({ id: `${seats[i]}/${j}`, blocking: f.severity === "blocker", evidence: true, challenge: "none", hit: hits(f, c) })),
  );
  const verdict = count({
    rule: { kind: "majority" },
    quorum: Math.max(1, Math.ceil(recs.length / 2)),
    veto: true,
    seats,
    ballots,
    findings: findings.map(({ hit, ...f }) => f),
  });
  const blocked = new Set(verdict.blocked_by);
  return {
    outcome: verdict.outcome,
    caught: findings.some((f) => f.hit),
    stops_for_the_bug: verdict.outcome === "reject" && findings.some((f) => f.hit && blocked.has(f.id)),
    false_vetoes: findings.filter((f) => blocked.has(f.id) && !f.hit).length,
    cost: recs.reduce((s, r) => s + (r.cost_usd ?? 0), 0),
  };
}

function subsets(items, k) {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [first, ...rest] = items;
  return [...subsets(rest, k - 1).map((s) => [first, ...s]), ...subsets(rest, k)];
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (x) => (Number.isNaN(x) ? "–" : `${Math.round(x * 100)}%`);
const usd = (x) => (Number.isNaN(x) ? "–" : `$${x.toFixed(2)}`);

// The author's reading of each seat with a located finding (reading.json): `yes` when one of them describes the confirmed bug.
const reading = existsSync(join(here, "reading.json")) ? JSON.parse(readFileSync(join(here, "reading.json"), "utf8")).cases : {};
const described = (c, name) => reading[c.id]?.[name] === "yes";

const out = { window: W, cases: [] };
for (const c of spec.cases) {
  const recs = load(c);
  const blind = Object.keys(recs).filter((n) => n.startsWith("blind-")).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6))).map((n) => recs[n]);
  const openSeats = Object.keys(recs).filter((n) => n.startsWith("open-")).sort().map((n) => recs[n]);
  const seats = blind.map((r) => seat(r, c));
  const blindNames = Object.keys(recs).filter((n) => n.startsWith("blind-")).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
  const yes = blindNames.map((n) => described(c, n));
  const yes3 = subsets(yes, 3).map((s) => s.some(Boolean));
  const openNames = ["blind-1", ...Object.keys(recs).filter((n) => n.startsWith("open-")).sort()];
  const p3 = subsets(blind, 3).map((s) => panel(s, c));
  const p5 = subsets(blind, 5).map((s) => panel(s, c));
  const openPanel = blind.length && openSeats.length ? [blind[0], ...openSeats] : [];
  const op = openPanel.length >= 3 ? panel(openPanel.slice(0, 3), c) : null;
  // Herding: how many of an open seat's findings repeat a finding of a seat before it, against blind seats 2 and 3
  // measured against the seats before them in the same way.
  const repeats = (later, earlier) => later.findings.filter((f) => earlier.some((e) => e.findings.some((g) => near(f, g)))).length;
  const herd = (list) => {
    let rep = 0;
    let all = 0;
    for (let k = 1; k < list.length; k++) {
      rep += repeats(list[k], list.slice(0, k));
      all += list[k].findings.length;
    }
    return all ? rep / all : NaN;
  };
  out.cases.push({
    id: c.id,
    pr: c.pr,
    fixed_by: c.fixed_by.pr,
    seats,
    single: { answered_caught: mean(seats.filter((s) => s.ok).map((s) => +s.caught)), answered: seats.filter((s) => s.ok).length, caught: mean(seats.map((s) => +s.caught)), caught_blocking: mean(seats.map((s) => +s.caught_blocking)), false_blockers: mean(seats.map((s) => s.false_blockers)), cost: mean(seats.map((s) => s.cost)) },
    panel3: { n: p3.length, caught: mean(p3.map((p) => +p.caught)), stops: mean(p3.map((p) => +p.stops_for_the_bug)), false_vetoes: mean(p3.map((p) => p.false_vetoes)), cost: mean(p3.map((p) => p.cost)) },
    panel5: { n: p5.length, caught: mean(p5.map((p) => +p.caught)), stops: mean(p5.map((p) => +p.stops_for_the_bug)), false_vetoes: mean(p5.map((p) => p.false_vetoes)), cost: mean(p5.map((p) => p.cost)) },
    open3: op && { ...op, herding: herd(openPanel.slice(0, 3)), seats: openPanel.slice(0, 3).map((r) => seat(r, c)) },
    blind3_first: blind.length >= 3 ? { ...panel(blind.slice(0, 3), c), herding: herd(blind.slice(0, 3)) } : null,
    described: {
      single: mean(yes.map(Number)),
      panel3: mean(yes3.map(Number)),
      panel5: yes.length >= 5 ? +yes.some(Boolean) : NaN,
      blind3: yes.slice(0, 3).some(Boolean),
      open3: openNames.slice(0, 3).some((n) => described(c, n)),
    },
    runs: blind.length + openSeats.length,
    answered: [...blind, ...openSeats].filter((r) => r.outcome).length,
    out_of_budget: [...blind, ...openSeats].filter((r) => r.subtype === "error_max_budget_usd").length,
    failed: Object.keys(recs).filter((n) => n.startsWith("failed-")).length,
    run_cost: Object.values(recs).reduce((s, r) => s + (r.cost_usd ?? 0), 0),
  });
}
writeFileSync(join(here, "scores.json"), JSON.stringify(out, null, 1) + "\n");

// The tables.
const cs = out.cases.filter((c) => c.seats.length);
const best = cs.length ? Math.max(...cs[0].seats.map((_, i) => cs.filter((c) => c.seats[i]?.caught).length)) : 0;
console.log(`### Caught, per case (a finding within ${W} lines of the fixed lines)\n`);
console.log("| Case | Single seat (all five blind seats) | Single seat (seats that answered) | Caught as a blocker | Panel of 3 (all subsets) | Panel of 5 | Panel of 3 stops it for the bug |");
console.log("|---|---|---|---|---|---|---|");
for (const c of cs) console.log(`| ${c.id} (#${c.pr}, fixed by #${c.fixed_by}) | ${pct(c.single.caught)} | ${pct(c.single.answered_caught)} (${c.single.answered} of ${c.seats.length}) | ${pct(c.single.caught_blocking)} | ${pct(c.panel3.caught)} | ${pct(c.panel5.caught)} | ${pct(c.panel3.stops)} |`);
console.log(`\nBest single seat (the blind seat number that caught the most cases): ${best} of ${cs.length} cases.\n`);
console.log("### Caught, by the author's reading: the finding's words describe the confirmed bug (reading.json)\n");
console.log("| Case | Single seat | Panel of 3 (all subsets) | Panel of 5 | Blind 1–3 | Open 1–3 |");
console.log("|---|---|---|---|---|---|");
for (const c of cs) console.log(`| ${c.id} | ${pct(c.described.single)} | ${pct(c.described.panel3)} | ${pct(c.described.panel5)} | ${c.described.blind3 ? "yes" : "no"} | ${c.described.open3 ? "yes" : "no"} |`);
const bestDescribed = cs.length ? Math.max(...cs[0].seats.map((_, i) => cs.filter((c) => described(c, `blind-${i + 1}`)).length)) : 0;
console.log(`\nBest single seat, by that reading: ${bestDescribed} of ${cs.length} cases; the panel of five: ${cs.filter((c) => c.described.panel5).length} of ${cs.length}.\n`);
console.log("### Blind against open, three seats each (seat 1 is the same run in both)\n");
console.log("| Case | Blind 1–3 caught | Open 1–3 caught | Blind repeats | Open repeats | Blind false vetoes | Open false vetoes |");
console.log("|---|---|---|---|---|---|---|");
for (const c of cs) if (c.open3 && c.blind3_first) console.log(`| ${c.id} | ${c.blind3_first.caught ? "yes" : "no"} | ${c.open3.caught ? "yes" : "no"} | ${pct(c.blind3_first.herding)} | ${pct(c.open3.herding)} | ${c.blind3_first.false_vetoes} | ${c.open3.false_vetoes} |`);
console.log("\n### False alarms and cost\n");
console.log("| Case | False blockers per seat | False vetoes, panel of 3 | False vetoes, panel of 5 | Cost per seat | Panel of 3 | Panel of 5 | Seat runs: answered, out of budget | Failed and run again | Spent, failed runs included |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const c of cs) console.log(`| ${c.id} | ${c.single.false_blockers.toFixed(1)} | ${c.panel3.false_vetoes.toFixed(1)} | ${c.panel5.false_vetoes.toFixed(1)} | ${usd(c.single.cost)} | ${usd(c.panel3.cost)} | ${usd(c.panel5.cost)} | ${c.runs}: ${c.answered}, ${c.out_of_budget} | ${c.failed} | ${usd(c.run_cost)} |`);
const total = cs.reduce((s, c) => s + c.run_cost, 0);
const sum = (k) => cs.reduce((s, c) => s + c[k], 0);
console.log(`\nTotal: ${sum("runs")} seat runs, ${sum("answered")} answered and ${sum("out_of_budget")} out of budget; ${sum("failed")} more failed on the account's usage limit and were run again; ${usd(total)} in all.`);
