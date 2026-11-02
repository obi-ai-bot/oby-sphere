// The clerk: a deterministic vote count.
//
// `count` takes a count request (JSON, clerk/README.md, "Input") and returns the count (JSON, "Output")
// or throws a ClerkError with the error code. `verify` says whether a recorded verdict is exactly the count
// of its input. Everything is integer arithmetic; the known-answer vectors in clerk/vectors/count.json pin
// every rule down, and the Rust crate in clerk/rust gives the same answers.

import { createHash } from "node:crypto";

export * from "./draw.ts";
export * from "./review.ts";

/** The largest integer an input may hold: 2^53 − 1. */
export const MAX_INT = Number.MAX_SAFE_INTEGER;

export type ErrorCode =
  | "bad_input"
  | "bad_rule"
  | "bad_options"
  | "bad_seats"
  | "bad_quorum"
  | "bad_finding"
  | "unknown_seat"
  | "duplicate_ballot"
  | "wrong_ballot"
  | "bad_ranking";

export class ClerkError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(code);
    this.code = code;
  }
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

type Rule =
  | { kind: "majority" | "unanimity" | "schulze" | "borda" | "median" }
  | { kind: "supermajority"; num: number; den: number };

type Choice = { vote: string } | { ranking: string[] } | { value: number };
type Ballot = { seat: string; choice: Choice };
type Finding = { id: string; blocking: boolean; evidence: boolean; challenge: string };

const fail = (code: ErrorCode): never => {
  throw new ClerkError(code);
};

const isObj = (v: Json | undefined): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: Json | undefined): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_INT;
const isId = (v: Json | undefined): v is string => typeof v === "string" && v.length > 0;
const isIds = (v: Json | undefined): v is string[] => Array.isArray(v) && v.every(isId);
const hasOnly = (o: Obj, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));
const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const unique = (items: string[]) => new Set(items).size === items.length;
const yesNo = (r: Rule) => r.kind === "majority" || r.kind === "supermajority" || r.kind === "unanimity";
const ranked = (r: Rule) => r.kind === "schulze" || r.kind === "borda";

// Stage 1: the shape of the input (README.md, "Errors", bad_input).
function shape(input: Json): asserts input is Obj {
  if (!isObj(input)) fail("bad_input");
  const o = input as Obj;
  if (!hasOnly(o, ["rule", "quorum", "veto", "options", "tie_break", "seats", "ballots", "findings"])) fail("bad_input");
  if (!isObj(o.rule) || typeof o.rule.kind !== "string") fail("bad_input");
  if (!isInt(o.quorum)) fail("bad_input");
  if (has(o, "veto") && typeof o.veto !== "boolean") fail("bad_input");
  if (has(o, "options") && !isIds(o.options)) fail("bad_input");
  if (has(o, "tie_break") && !isObj(o.tie_break)) fail("bad_input");
  if (!isIds(o.seats)) fail("bad_input");
  if (!Array.isArray(o.ballots)) fail("bad_input");
  for (const b of o.ballots as Json[]) {
    if (!isObj(b) || !hasOnly(b, ["seat", "vote", "ranking", "value"]) || !isId(b.seat)) fail("bad_input");
    const ballot = b as Obj;
    if (["vote", "ranking", "value"].filter((k) => has(ballot, k)).length !== 1) fail("bad_input");
    if (has(ballot, "vote") && typeof ballot.vote !== "string") fail("bad_input");
    if (has(ballot, "ranking") && !(Array.isArray(ballot.ranking) && ballot.ranking.every((s) => typeof s === "string"))) fail("bad_input");
    if (has(ballot, "value") && !isInt(ballot.value)) fail("bad_input");
  }
  if (has(o, "findings")) {
    if (!Array.isArray(o.findings)) fail("bad_input");
    for (const f of o.findings as Json[]) {
      if (!isObj(f) || Object.keys(f).length !== 4 || !hasOnly(f, ["id", "blocking", "evidence", "challenge"])) fail("bad_input");
      const g = f as Obj;
      if (!isId(g.id) || typeof g.blocking !== "boolean" || typeof g.evidence !== "boolean" || typeof g.challenge !== "string") fail("bad_input");
    }
  }
}

// Stage 2: the rule, the veto, whether options belong, and the tie-break.
function ruleOf(o: Obj): { rule: Rule; seed: Buffer | null } {
  const r = o.rule as Obj;
  const n = Object.keys(r).length;
  let rule: Rule;
  switch (r.kind) {
    case "majority":
    case "unanimity":
    case "schulze":
    case "borda":
    case "median":
      if (n !== 1) fail("bad_rule");
      rule = { kind: r.kind };
      break;
    case "supermajority":
      if (n !== 3 || !isInt(r.num) || !isInt(r.den)) fail("bad_rule");
      if ((r.num as number) === 0 || (r.num as number) > (r.den as number)) fail("bad_rule");
      rule = { kind: "supermajority", num: r.num as number, den: r.den as number };
      break;
    default:
      return fail("bad_rule");
  }
  if (o.veto === true && !yesNo(rule)) fail("bad_rule");
  if (has(o, "options") && !ranked(rule)) fail("bad_rule");
  let seed: Buffer | null = null;
  if (has(o, "tie_break")) {
    const tb = o.tie_break as Obj;
    const size = Object.keys(tb).length;
    if (tb.kind === "none" && size === 1) {
      // no tie-break: a tie stays a tie
    } else if (tb.kind === "seeded" && size === 2 && ranked(rule) && typeof tb.seed === "string" && /^[0-9a-f]{64}$/.test(tb.seed)) {
      seed = Buffer.from(tb.seed, "hex");
    } else {
      fail("bad_rule");
    }
  }
  return { rule, seed };
}

/** Counts the input. Returns the count, or throws a ClerkError with the first error in README.md's order. */
export function count(input: Json): Obj {
  shape(input);
  const o = input;
  const { rule, seed } = ruleOf(o);

  const options = (o.options as string[] | undefined) ?? [];
  if (ranked(rule) && (options.length < 2 || !unique(options))) fail("bad_options");
  const seats = o.seats as string[];
  if (seats.length === 0 || !unique(seats)) fail("bad_seats");
  const quorum = o.quorum as number;
  if (quorum < 1 || quorum > seats.length) fail("bad_quorum");

  const findings: Finding[] = [];
  for (const f of (o.findings as Obj[] | undefined) ?? []) {
    const finding = f as unknown as Finding;
    if (findings.some((g) => g.id === finding.id) || !["none", "stands", "refuted"].includes(finding.challenge)) fail("bad_finding");
    findings.push(finding);
  }

  const ballots: Ballot[] = [];
  for (const b of o.ballots as Obj[]) {
    const seat = b.seat as string;
    if (!seats.includes(seat)) fail("unknown_seat");
    if (ballots.some((x) => x.seat === seat)) fail("duplicate_ballot");
    const choice: Choice = has(b, "vote")
      ? { vote: b.vote as string }
      : has(b, "ranking")
        ? { ranking: b.ranking as string[] }
        : { value: b.value as number };
    const fits =
      "vote" in choice
        ? choice.vote === "abstain" || (yesNo(rule) && (choice.vote === "approve" || choice.vote === "reject"))
        : "ranking" in choice
          ? ranked(rule)
          : rule.kind === "median";
    if (!fits) fail("wrong_ballot");
    if ("ranking" in choice) {
      const r = choice.ranking;
      if (r.length !== options.length || !unique(r) || !r.every((x) => options.includes(x))) fail("bad_ranking");
    }
    ballots.push({ seat, choice });
  }

  const present = ballots.length;
  const abstain = ballots.filter((b) => "vote" in b.choice && b.choice.vote === "abstain").length;
  const noQuorum = present < quorum;
  const out: Obj = { seats: seats.length, present };

  if (yesNo(rule)) {
    const approve = ballots.filter((b) => "vote" in b.choice && b.choice.vote === "approve").length;
    const reject = present - approve - abstain;
    const blocked = o.veto === true ? findings.filter((f) => f.blocking && f.evidence && f.challenge !== "refuted").map((f) => f.id) : [];
    let outcome: string;
    if (noQuorum) outcome = "no_quorum";
    else if (blocked.length > 0) outcome = "reject";
    else if (approve + reject === 0) outcome = "no_votes";
    else if (rule.kind === "majority") outcome = approve > reject ? "approve" : approve < reject ? "reject" : "tie";
    else if (rule.kind === "supermajority")
      outcome = BigInt(approve) * BigInt(rule.den) >= BigInt(rule.num) * BigInt(approve + reject) ? "approve" : "reject";
    else outcome = reject === 0 ? "approve" : "reject";
    out.outcome = outcome;
    out.tally = { approve, reject, abstain };
    out.blocked_by = blocked;
  } else if (ranked(rule)) {
    const n = options.length;
    const rankings = ballots.flatMap((b) => ("ranking" in b.choice ? [b.choice.ranking.map((x) => options.indexOf(x))] : []));
    let winners: number[];
    if (rule.kind === "borda") {
      const scores = new Array<number>(n).fill(0);
      for (const r of rankings) r.forEach((opt, pos) => (scores[opt] += n - 1 - pos));
      const best = Math.max(...scores);
      out.scores = scores;
      winners = scores.flatMap((s, i) => (s === best ? [i] : []));
    } else {
      const { d, p } = schulze(n, rankings);
      out.pairwise = d;
      out.strengths = p;
      winners = [...Array(n).keys()].filter((i) => [...Array(n).keys()].every((j) => j === i || p[i][j] >= p[j][i]));
    }
    const outcome = noQuorum ? "no_quorum" : rankings.length === 0 ? "no_votes" : winners.length === 1 || seed ? "elected" : "tie";
    const tieBroken = outcome === "elected" && winners.length > 1;
    if (outcome === "elected") {
      const winner = tieBroken
        ? winners.reduce((best, i) => (tieKey(seed!, options[i]) < tieKey(seed!, options[best]) ? i : best))
        : winners[0];
      out.winner = options[winner];
    }
    out.outcome = outcome;
    out.tally = { ranked: rankings.length, abstain };
    out.winners = winners.map((i) => options[i]);
    out.tie_broken = tieBroken;
  } else {
    const values = ballots.flatMap((b) => ("value" in b.choice ? [b.choice.value] : [])).sort((a, b) => a - b);
    let outcome: string;
    if (noQuorum) outcome = "no_quorum";
    else if (values.length === 0) outcome = "no_votes";
    else {
      outcome = "value";
      out.value = values[Math.floor((values.length - 1) / 2)];
    }
    out.outcome = outcome;
    out.tally = { values: values.length, abstain };
  }
  return out;
}

// The pairwise preferences d[i][j] (ballots ranking i above j) and the Schulze strongest-path strengths
// p[i][j], both indexed in the options' order.
function schulze(n: number, rankings: number[][]): { d: number[][]; p: number[][] } {
  const d = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (const r of rankings) for (let a = 0; a < r.length; a++) for (let b = a + 1; b < r.length; b++) d[r[a]][r[b]] += 1;
  const p = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i !== j && d[i][j] > d[j][i] ? d[i][j] : 0)));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      for (let k = 0; k < n; k++) if (k !== i && k !== j) p[j][k] = Math.max(p[j][k], Math.min(p[j][i], p[i][k]));
    }
  return { d, p };
}

// The seeded tie-break's key for an option: SHA-256 over "tie-break\n", the seed's 32 bytes and the option
// id's UTF-8 bytes, as lower-case hex. The tied option with the lowest key wins.
function tieKey(seed: Buffer, option: string): string {
  return createHash("sha256").update("tie-break\n").update(seed).update(option, "utf8").digest("hex");
}

/** Whether two JSON values are the same: member order doesn't matter, array order does. */
export function sameJson(a: Json | undefined, b: Json | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  }
  if (isObj(a) || isObj(b)) {
    if (!isObj(a) || !isObj(b)) return false;
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => has(b, k) && sameJson(a[k], b[k]));
  }
  return a === b;
}

/** Whether `verdict` is exactly the count of `input`. An input that can't be counted has no valid verdict. */
export function verify(input: Json, verdict: Json): boolean {
  try {
    return sameJson(count(input), verdict);
  } catch (e) {
    if (e instanceof ClerkError) return false;
    throw e;
  }
}
