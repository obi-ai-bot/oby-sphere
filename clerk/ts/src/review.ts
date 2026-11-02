// The review profile's tally (spec/council/review.md, section 6): from the chain's entries to the clerk's count
// input. It reads only what stays readable when the words are sealed (types, members, times, outcomes, commit
// ids, finding ids and severities, acceptance kinds and results), so anyone holding the chain can count again
// without a key. The known-answer vectors in clerk/vectors/review.json pin it down, and the Rust crate in
// clerk/rust gives the same answers.

import type { Json } from "./index.ts";
import { unixSeconds } from "./draw.ts";

export type TallyErrorCode = "bad_input" | "bad_panel" | "two_requests";

export class TallyError extends Error {
  readonly code: TallyErrorCode;
  constructor(code: TallyErrorCode) {
    super(code);
    this.code = code;
  }
}

type Obj = { [key: string]: Json };
type Entry = { seq: number; recorded_at: string; envelope: Obj };

/** The most conditions one challenge request carries (protocol.md section 5.1: 1 to 10). */
export const MOST_CONDITIONS = 10;

/** The verifier's requests are recorded at least this long before `deadlines.challenge` (review.md section 6). */
export const CHALLENGE_MARGIN_SECONDS = 600;

const fail = (code: TallyErrorCode): never => {
  throw new TallyError(code);
};

const isObj = (v: Json | undefined): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: Json | undefined): v is string => typeof v === "string" && v.length > 0;
const isInt = (v: Json | undefined): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const exact = (o: Json | undefined, keys: string[], optional: string[] = []): o is Obj =>
  isObj(o) && keys.every((k) => has(o, k)) && Object.keys(o).every((k) => keys.includes(k) || optional.includes(k));
// A protocol timestamp's seconds, or null when it isn't one.
const seconds = (t: Json | undefined): number | null => {
  if (typeof t !== "string") return null;
  try {
    return unixSeconds(t);
  } catch {
    return null;
  }
};
// Repositories compare ignoring ASCII case (protocol.md section 5.9).
const lower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const sameRepo = (a: Json | undefined, b: string) => typeof a === "string" && lower(a) === lower(b);

function checkRule(rule: Obj, quorum: number, seats: string[]): void {
  const keys = Object.keys(rule);
  let ok: boolean;
  if (rule.kind === "majority" || rule.kind === "unanimity") ok = keys.length === 1;
  else if (rule.kind === "supermajority")
    ok = keys.length === 3 && has(rule, "num") && has(rule, "den") && isInt(rule.num) && isInt(rule.den) && 1 <= rule.num && rule.num <= rule.den;
  else ok = false;
  if (!ok || quorum < 1 || quorum > seats.length) fail("bad_panel");
}

/** The clerk's count input for a review panel, from the chain's entries in chain order (review.md section 6). */
export function reviewTally(input: Json): Obj {
  const keys = ["convener", "subject", "rule", "quorum", "veto", "seats", "round_at", "deadlines", "entries"];
  if (!exact(input, keys, ["verifier"])) return fail("bad_input");
  const subject = input.subject;
  if (!exact(subject, ["repo", "head_sha"]) || !isId(subject.repo) || typeof subject.head_sha !== "string" || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(subject.head_sha))
    return fail("bad_input");
  if (!isId(input.convener) || !isObj(input.rule) || typeof input.veto !== "boolean" || !isInt(input.quorum)) fail("bad_input");
  if (!Array.isArray(input.seats) || !input.seats.every(isId)) fail("bad_input");
  if (has(input, "verifier") && !isId(input.verifier)) fail("bad_input");
  const roundAt = seconds(input.round_at);
  const d = input.deadlines;
  if (roundAt === null || !exact(d, ["reviews", "challenge"])) return fail("bad_input");
  const reviewsBy = seconds(d.reviews);
  const challengeBy = seconds(d.challenge);
  if (reviewsBy === null || challengeBy === null) return fail("bad_input");
  if (!Array.isArray(input.entries) || !input.entries.every(isObj)) fail("bad_input");
  for (const e of input.entries as Obj[]) {
    const env = e.envelope;
    if (!exact(e, ["seq", "recorded_at", "envelope"]) || !isInt(e.seq) || seconds(e.recorded_at) === null || !isObj(env)) fail("bad_input");
    const v = env as Obj;
    if (!["id", "type", "from", "to", "correlation_id"].every((k) => isId(v[k])) || !isObj(v.body)) fail("bad_input");
  }
  const entries = input.entries as unknown as Entry[];
  const convener = input.convener as string;
  const seats = input.seats as string[];
  const verifier = has(input, "verifier") ? (input.verifier as string) : null;
  const repo = subject.repo as string;
  const head = subject.head_sha as string;

  checkRule(input.rule as Obj, input.quorum as number, seats);
  if (new Set(seats).size !== seats.length || seats.includes(convener)) fail("bad_panel");
  if (verifier !== null && (seats.includes(verifier) || verifier === convener)) fail("bad_panel");
  // The challenge needs its margin twice after the reviews: time to send it, and time to replace a verifier.
  if (!(roundAt < reviewsBy && reviewsBy + 2 * CHALLENGE_MARGIN_SECONDS <= challengeBy)) fail("bad_panel");

  const body = (e: Entry) => e.envelope.body as Obj;
  // The panel's review_requests to `member`: from the convener, for the subject, recorded after round R's time
  // and by `until`.
  const requestsTo = (member: string, until: number): Entry[] =>
    entries.filter(
      (e) =>
        e.envelope.type === "review_request" &&
        e.envelope.from === convener &&
        e.envelope.to === member &&
        sameRepo(body(e).repo, repo) &&
        body(e).head_sha === head &&
        (seconds(e.recorded_at) as number) > roundAt &&
        (seconds(e.recorded_at) as number) <= until,
    );
  // The review's result, when its exchange ended with one from `member` by `deadline`, for the subject; checked.
  const reviewResult = (request: Entry, member: string, deadline: number): Obj | null => {
    const end = entries.find(
      (e) => e.envelope.correlation_id === request.envelope.id && e.envelope.from === member && (e.envelope.type === "result" || e.envelope.type === "decline"),
    );
    if (end === undefined || end.envelope.type !== "result" || (seconds(end.recorded_at) as number) > deadline) return null;
    const b = body(end);
    if (b.for !== "review_request" || b.head_sha !== head || !sameRepo(b.repo, repo)) return null;
    if (b.outcome !== "approved" && b.outcome !== "changes_requested") return null;
    const findings = has(b, "findings") ? b.findings : [];
    const acceptance = has(b, "acceptance") ? b.acceptance : [];
    if (!Array.isArray(findings) || !findings.every((f) => isObj(f) && isId(f.id) && typeof f.severity === "string")) fail("bad_input");
    if (!Array.isArray(acceptance) || !acceptance.every((a) => isObj(a) && isInt(a.index) && typeof a.kind === "string" && typeof a.met === "boolean"))
      fail("bad_input");
    const unique = (xs: Json[]) => new Set(xs).size === xs.length;
    if (!unique((findings as Obj[]).map((f) => f.id)) || !unique((acceptance as Obj[]).map((a) => a.index))) fail("bad_input");
    return b;
  };

  const ballots: Obj[] = [];
  const findings: { id: string; blocking: boolean; evidence: boolean; challenge: string }[] = [];
  for (const seat of seats) {
    const requests = requestsTo(seat, reviewsBy);
    if (requests.length > 1) fail("two_requests");
    const result = requests.length ? reviewResult(requests[0], seat, reviewsBy) : null;
    if (result === null) continue;
    ballots.push({ seat, vote: result.outcome === "approved" ? "approve" : "reject" });
    for (const f of (result.findings as Obj[] | undefined) ?? []) {
      findings.push({ id: `${seat}/${f.id as string}`, blocking: f.severity === "blocker", evidence: true, challenge: "none" });
    }
  }

  const blocking = findings.filter((f) => f.blocking);
  if (verifier !== null && blocking.length > 0) {
    const requests = requestsTo(verifier, challengeBy - CHALLENGE_MARGIN_SECONDS);
    const conditions = requests.map((r) => (has(body(r), "acceptance") ? body(r).acceptance : []));
    const shaped =
      requests.length > 0 &&
      conditions.every((c) => Array.isArray(c) && c.length >= 1 && c.length <= MOST_CONDITIONS && c.every((x) => isObj(x) && x.kind === "custom")) &&
      conditions.reduce<number>((n, c) => n + (c as Json[]).length, 0) === blocking.length;
    if (shaped) {
      let offset = 0;
      requests.forEach((r, k) => {
        const result = reviewResult(r, verifier, challengeBy);
        const size = (conditions[k] as Json[]).length;
        if (result !== null) {
          const met = new Map<number, boolean>();
          for (const a of (result.acceptance as Obj[] | undefined) ?? []) if (a.kind === "custom") met.set(a.index as number, a.met as boolean);
          for (let i = 0; i < size; i++) if (met.has(i)) blocking[offset + i].challenge = met.get(i) ? "stands" : "refuted";
        }
        offset += size;
      });
    }
  }

  return { rule: input.rule, quorum: input.quorum, veto: input.veto, seats, ballots, findings };
}
