// Copied from client/src/rules.ts by server/scripts/sync-client.mjs: edit it there, then run `pnpm run sync:client`.
// The protocol's rules as pure functions over already-parsed messages (spec/protocol.md sections
// 3, 4, 5 and 10, check 3): the action types, the exchange rules, the rules no schema can say, and
// which key is valid at a seq. No schemas, no cryptography, no I/O: so the spec's reference
// verifier (spec/conformance/lib/obi.mjs) and the server use this same code. Text fields are data:
// nothing here reads them beyond their schema.

import { canonicalize, type JsonObject } from "./json.ts";

export const PROTOCOL = "obi/0.1";
export const ENVELOPE_SIGNING_PREFIX = "obi/0.1 envelope\n";
export const MAX_ENVELOPE_BYTES = 65536;
export const MAX_LIFETIME_SECONDS = 2592000;
export const CLOCK_SKEW_SECONDS = 300;
export const REQUEST_TYPES = ["review_request", "question", "handoff", "run_request", "share_offer", "introduction"] as const;
export const REPLY_TYPES = ["status", "accept", "decline", "result", "answer", "run_progress", "run_return", "run_cancel", "share_status", "share_revoke", "cancel"] as const;
export const TERMINAL_TYPES = ["decline", "result", "answer", "run_return", "run_cancel", "share_revoke", "cancel"];
/** The replies that belong only to a run_request's exchange (protocol.md section 4, rule 7). */
export const RUN_REPLY_TYPES = ["run_progress", "run_return", "run_cancel"];
/** What a share_offer's exchange takes, and nothing else (protocol.md section 4, rule 8). */
export const SHARE_REPLY_TYPES = ["share_status", "share_revoke", "decline"];
/** The replies a request's own sender sends, to its receiver (protocol.md section 4, rule 1). */
export const SENDER_REPLY_TYPES = ["run_cancel", "share_status", "share_revoke", "cancel"];
/** The requests a cancel calls off (protocol.md section 4, rule 10). */
export const CANCELLABLE_TYPES = ["review_request", "question", "handoff", "introduction"];
export const SEVERITY_RANK: Record<string, number> = { nit: 1, minor: 2, major: 3, blocker: 4 };

export type RequestType = (typeof REQUEST_TYPES)[number];
export const isRequestType = (t: unknown): t is RequestType => (REQUEST_TYPES as readonly unknown[]).includes(t);
export const isReplyType = (t: unknown): boolean => (REPLY_TYPES as readonly unknown[]).includes(t);

/** An envelope that matched the schema. Its body is only what its action's schema allows. */
export interface Envelope {
  protocol: string;
  id: string;
  type: string;
  from: string;
  to: string;
  sphere: string;
  correlation_id: string;
  in_reply_to?: string;
  created_at: string;
  expires_at: string;
  key_id: string;
  body: JsonObject;
  /** How the words in `body` are sealed for the receiver (protocol.md section 9.1). */
  seal?: { suite: string; key_id: string; enc: string };
  signature: string;
}

export type Verdict = { ok: true } | { ok: false; code: string; message: string };
export const OK: Verdict = { ok: true };
export const fail = (code: string, message: string): Verdict => ({ ok: false, code, message });

/** Seconds since 1970 of a protocol timestamp (NaN when it is not a date). */
export const seconds = (timestamp: string): number => Date.parse(timestamp) / 1000;

/** A protocol timestamp: UTC, whole seconds, `Z`. */
export const timestamp = (secondsSince1970: number): string => new Date(Math.floor(secondsSince1970) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

const realDate = (ts: string): boolean => !Number.isNaN(seconds(ts)) && timestamp(seconds(ts)) === ts;

interface Finding {
  id: string;
  severity: string;
  line: number;
  end_line?: number;
}
interface AcceptanceResult {
  index: number;
  kind: string;
  severity?: string;
  met: boolean;
}

/** A result that contradicts itself (protocol.md section 5.7). */
export function resultProblems(body: JsonObject): string[] {
  const problems: string[] = [];
  const findings = (body.findings ?? []) as unknown as Finding[];
  const ids = new Set<string>();
  for (const f of findings) {
    if (ids.has(f.id)) problems.push(`finding id ${f.id} appears twice`);
    ids.add(f.id);
  }
  const acceptance = (body.acceptance ?? []) as unknown as AcceptanceResult[];
  const indexes = new Set<number>();
  for (const a of acceptance) {
    if (indexes.has(a.index)) problems.push(`acceptance index ${a.index} appears twice`);
    indexes.add(a.index);
    if (body.for === "review_request") {
      if (a.kind === "no_blocker_findings" && a.met !== !findings.some((f) => f.severity === "blocker")) problems.push("no_blocker_findings: met disagrees with the findings");
      if (a.kind === "no_findings_at_or_above" && a.met !== !findings.some((f) => SEVERITY_RANK[f.severity]! >= SEVERITY_RANK[a.severity!]!)) problems.push("no_findings_at_or_above: met disagrees with the findings");
    }
  }
  const allMet = acceptance.length > 0 && acceptance.every((a) => a.met);
  if (body.outcome === "approved" && !allMet) problems.push("approved needs every acceptance condition met");
  if (body.outcome === "changes_requested" && allMet) problems.push("changes_requested needs an acceptance condition not met");
  if (body.for === "handoff" && body.outcome === "done" && !allMet) problems.push("done needs every acceptance condition met");
  return problems;
}

/**
 * The references in one list are distinct, repositories compared ignoring ASCII case
 * (protocol.md section 5.9): `Acme/App` and `acme/app` name the same repository.
 */
export function refProblems(body: JsonObject): string[] {
  const problems: string[] = [];
  const lower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  for (const list of ["about", "refs"]) {
    const seen = new Set<string>();
    for (const ref of (Array.isArray(body[list]) ? body[list] : []) as JsonObject[]) {
      const key = canonicalize({ ...ref, repo: lower(ref.repo as string) });
      if (seen.has(key)) problems.push(`${list}: the same reference twice`);
      seen.add(key);
    }
  }
  return problems;
}

/** protocol.md section 10, check 3: the rules no schema can say. Runs after the schema matched. */
export function semanticProblems(env: Envelope): string[] {
  const problems: string[] = [];
  if (!realDate(env.created_at)) problems.push("created_at is not a real date");
  if (!realDate(env.expires_at)) problems.push("expires_at is not a real date");
  const created = seconds(env.created_at);
  const expires = seconds(env.expires_at);
  if (!(expires > created)) problems.push("expires_at must be after created_at");
  if (expires - created > MAX_LIFETIME_SECONDS) problems.push(`a message may live at most ${MAX_LIFETIME_SECONDS} seconds`);
  if (env.from === env.to) problems.push("from and to must differ");
  if (isRequestType(env.type) && env.correlation_id !== env.id) problems.push("a request's correlation_id must equal its id");
  if (isReplyType(env.type) && env.in_reply_to !== env.correlation_id) problems.push("a reply's in_reply_to must equal its correlation_id");
  // An introduction introduces a third member (section 5.18); a follow-up follows an earlier exchange (5.19).
  if (env.type === "introduction" && (env.body.member === env.from || env.body.member === env.to)) problems.push("an introduction's member is neither its sender nor its receiver");
  if (env.body.follows !== undefined && env.body.follows === env.id) problems.push("a request doesn't follow itself up");
  if (env.type === "result") problems.push(...resultProblems(env.body));
  problems.push(...refProblems(env.body));
  for (const f of (env.body.findings ?? []) as unknown as Finding[]) {
    if (f.end_line !== undefined && f.end_line < f.line) problems.push(`finding ${f.id}: end_line before line`);
  }
  return problems;
}

/** A directory key: `valid_from_seq` and `valid_until_seq` may be absent (a key with no range). */
export interface DirectoryKey {
  obi: string;
  public_key: string;
  valid_from_seq?: number | null;
  valid_until_seq?: number | null;
}

/**
 * Whether `key` may sign the message at audit seq `seq`; with no seq (a message not recorded
 * yet) the key must be current. A key without a range is always valid.
 */
export function keyValidAt(key: DirectoryKey, seq: number | null | undefined): boolean {
  if (key.valid_from_seq === undefined && key.valid_until_seq === undefined) return true;
  const open = key.valid_until_seq === null || key.valid_until_seq === undefined;
  if (seq === undefined || seq === null) return open;
  return seq >= (key.valid_from_seq ?? 1) && (open || seq <= key.valid_until_seq!);
}

/** The parts of an envelope the exchange rules look at. */
export interface ExchangeMessage {
  type: string;
  from: string;
  to: string;
  result_for?: string | undefined;
  /** Whether the message's body has a `note` (a decline's words, rule 9). */
  has_note?: boolean | undefined;
  /** A decline's `reason`, and whether it names a remembered decision (`by_rule`): rule 9. */
  reason?: string | undefined;
  has_by_rule?: boolean | undefined;
}

/** The reasons a decline in a run_request's exchange may give (rule 9): the guest's own doing, or nothing about the host. */
export const RUN_DECLINE_REASONS = ["unavailable", "expired", "out_of_scope", "share_used"];

/**
 * The exchange rules (protocol.md section 4): why `reply` breaks them, given the request its
 * `in_reply_to` names (undefined when there is none) and the replies to it recorded before it,
 * in order; null when it keeps them.
 */
export function exchangeProblem(reply: ExchangeMessage, request: ExchangeMessage | undefined, earlier: ExchangeMessage[]): string | null {
  if (!request || !isRequestType(request.type)) return "replies to no earlier request";
  // run_cancel, share_status and share_revoke are the replies the request's own sender sends, to its receiver.
  if (SENDER_REPLY_TYPES.includes(reply.type)) {
    if (request.from !== reply.from || request.to !== reply.to) return `only the request's sender sends a ${reply.type}, to its receiver`;
  } else if (request.from !== reply.to || request.to !== reply.from) return "only the request's receiver replies, to its sender";
  if (RUN_REPLY_TYPES.includes(reply.type) && request.type !== "run_request") return `a ${reply.type} belongs to a run_request, not a ${request.type}`;
  // A share_offer's exchange takes share_status, share_revoke and decline, and they belong to it alone (decline to any request).
  if (request.type === "share_offer" ? !SHARE_REPLY_TYPES.includes(reply.type) : SHARE_REPLY_TYPES.includes(reply.type) && reply.type !== "decline")
    return request.type === "share_offer" ? `a share_offer takes no ${reply.type}` : `a ${reply.type} belongs to a share_offer, not a ${request.type}`;
  // A cancel calls off a review_request, a question, a handoff or an introduction (rule 10).
  if (reply.type === "cancel" && !CANCELLABLE_TYPES.includes(request.type)) return `a cancel calls off a review_request, question, handoff or introduction, not a ${request.type}`;
  if (earlier.some((e) => TERMINAL_TYPES.includes(e.type))) return "the exchange already ended";
  const accepted = earlier.some((e) => e.type === "accept");
  // An introduction's accept ends its exchange: nothing follows it (rule 10).
  if (request.type === "introduction" && accepted) return "the exchange already ended";
  if (reply.type === "accept" && accepted) return "accepted twice";
  if (reply.type === "result") {
    if (reply.result_for !== request.type) return `a result for ${reply.result_for} answers a ${request.type}`;
    if (!accepted) return `a ${request.type} is answered by a result only after an accept`;
  }
  // A run_return comes back only from a job that was accepted.
  if (reply.type === "run_return" && !accepted) return "a run_request is answered by a run_return only after an accept";
  // An answer answers a question, and nothing else; an accept before it is allowed, not needed.
  if (reply.type === "answer" && request.type !== "question") return `an answer answers a question, not a ${request.type}`;
  // No words in a guest job's or a share's exchange: a decline there has no note, and a guest
  // job's takes no status, whose states and note would say when its host's owner is there (rule 9).
  if (reply.type === "status" && request.type === "run_request") return "a run_request takes no status";
  if (reply.type === "decline" && (request.type === "run_request" || request.type === "share_offer") && reply.has_note) return `a decline of a ${request.type} has no note`;
  // Nor why its host declined, which would say when its owner is at the Mac or what its rules are.
  if (reply.type === "decline" && request.type === "run_request" && !RUN_DECLINE_REASONS.includes(reply.reason ?? ""))
    return `a decline of a run_request says only ${RUN_DECLINE_REASONS.join(", ")}`;
  // Nor whether a rule or its owner in person answered.
  if (request.type === "run_request" && reply.has_by_rule) return `no reply to a run_request names a rule (by_rule)`;
  return null;
}

/**
 * A request's repository, as policy matches it (sphere-api.md section 5): the body's `repo`, or for
 * a question the one repository its `about` references name (protocol.md section 5.2). Undefined
 * when it has none: a question about nothing, or about more than one repository.
 */
export function requestRepo(env: Envelope): string | undefined {
  if (env.type !== "question" && env.type !== "introduction") return typeof env.body.repo === "string" ? env.body.repo : undefined;
  const repos = (Array.isArray(env.body.about) ? env.body.about : []).map((ref) => (ref as JsonObject).repo as string);
  const lower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return repos.length > 0 && repos.every((r) => lower(r) === lower(repos[0]!)) ? repos[0] : undefined;
}

/**
 * What's wrong with a request's `follows` (protocol.md section 5.19), given the earlier message it
 * names (undefined when there is none): it must be a request between the same two members, in
 * either direction. Null when it has none, or names one.
 */
export function followUpProblem(request: Pick<Envelope, "from" | "to" | "body">, earlier: Pick<Envelope, "type" | "from" | "to"> | undefined): string | null {
  if (request.body.follows === undefined) return null;
  if (!earlier || !isRequestType(earlier.type)) return "follows no earlier request";
  const same = (earlier.from === request.from && earlier.to === request.to) || (earlier.from === request.to && earlier.to === request.from);
  return same ? null : "follows an exchange between other members";
}

export const exchangeMessage = (env: Envelope): ExchangeMessage => ({
  type: env.type,
  from: env.from,
  to: env.to,
  result_for: env.type === "result" ? (env.body.for as string) : undefined,
  has_note: env.body.note !== undefined,
  reason: env.type === "decline" ? (env.body.reason as string) : undefined,
  has_by_rule: env.body.by_rule !== undefined,
});
