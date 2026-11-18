// The A2A binding (spec/a2a.md), as reference code: what the Obysphere takes in an A2A 1.0
// SendMessage (section 4), and an exchange as GetTask shows it (section 5).
//
// Imported by obi.mjs (judge), which this file imports too: nothing here reads obi.mjs's bindings
// until a function runs.

import { MAX_ENVELOPE_BYTES, REPLY_TYPES, canonicalBytes, schemaErrors, semanticProblems, verifyEnvelope } from "./obi.mjs";

/** The A2A version the binding speaks (A2A-Version), and the extension a client activates (A2A-Extensions). */
export const A2A_VERSION = "1.0";
export const A2A_EXTENSION = "urn:obi-sphere:ext:obi:0.1";
/** The most messages a task's history holds: the latest ones. */
export const HISTORY_LIMIT = 50;

const fail = (code, message) => ({ ok: false, code, message });
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** protocol.md section 10, checks 1 to 3, as the relay's send makes them (sphere-api.md section 6.1, check 4). */
function envelopeShapeProblem(env) {
  let size;
  try {
    size = canonicalBytes(env).length;
  } catch (e) {
    return fail("invalid_envelope", e.message);
  }
  if (size > MAX_ENVELOPE_BYTES) return fail("payload_too_large", `${size} bytes canonical, the most is ${MAX_ENVELOPE_BYTES}`);
  const errors = schemaErrors(env.seal === undefined ? "envelope" : "sealed/envelope", env);
  if (errors.length) return fail("invalid_envelope", errors.slice(0, 5).join("; "));
  const problems = semanticProblems(env);
  return problems.length ? fail("invalid_envelope", problems.join("; ")) : null;
}

/**
 * Checks 5 to 9 of spec/a2a.md section 4, on a SendMessageRequest body (already a JSON object:
 * check 4) sent to the URL of the member `member`: `{ok: true, envelope}`, or why the binding
 * refuses it. Checks 1 to 3 are the call's (its token and headers), and the relay's own checks
 * follow (check 10).
 */
export function unwrapSend(body, member) {
  if (!isObject(body)) return fail("bad_request", "the body is a JSON object");
  // 5. No push notifications, and nothing held open.
  const config = body.configuration;
  if (isObject(config) && config.taskPushNotificationConfig !== undefined) return fail("push_notification_not_supported", "this interface sends no push notifications");
  if (!isObject(config) || config.returnImmediately !== true) return fail("unsupported_operation", "send with configuration.returnImmediately: true; read the task for its replies");
  // 6. A2A's request, as the binding takes it.
  const errors = schemaErrors("wire/a2a-send.request", body);
  if (errors.length) return fail("bad_request", `the body doesn't match a2a-send.request: ${errors.slice(0, 5).join("; ")}`);
  const message = body.message;
  const env = message.parts[0].data;
  // 7. The data part is an envelope.
  const shape = envelopeShapeProblem(env);
  if (shape) return shape;
  // 8. The message agrees with its envelope.
  if (message.messageId !== env.id) return fail("bad_request", "messageId is the envelope's id");
  if (message.contextId !== undefined && message.contextId !== env.correlation_id) return fail("bad_request", "contextId is the envelope's correlation_id");
  if (REPLY_TYPES.includes(env.type)) {
    if (message.taskId !== env.correlation_id) return fail("bad_request", "a reply's taskId is its envelope's correlation_id: the task it continues");
  } else if (message.taskId !== undefined) {
    return fail("bad_request", "a request starts its task: it has no taskId");
  }
  // 9. For the URL's member.
  if (env.to !== member) return fail("wrong_recipient", `the envelope is for ${env.to}, not ${member}, whose URL this is`);
  return { ok: true, envelope: env };
}

/**
 * A conformance case of kind `a2a`: the binding's checks, then the envelope judged as an envelope
 * case is, by the URL's member (`context.receiver`).
 */
export function verifyA2aSend(body, context) {
  const unwrapped = unwrapSend(body, context?.receiver);
  return unwrapped.ok ? verifyEnvelope(unwrapped.envelope, context) : unwrapped;
}

// ---------------------------------------------------------------------------------------------
// GetTask (spec/a2a.md section 5).

const SUBMITTED = "TASK_STATE_SUBMITTED", WORKING = "TASK_STATE_WORKING", COMPLETED = "TASK_STATE_COMPLETED";
const FAILED = "TASK_STATE_FAILED", REJECTED = "TASK_STATE_REJECTED", CANCELED = "TASK_STATE_CANCELED";

/**
 * The state an exchange is in after its latest reply, its request being of `requestType`; with none
 * yet, submitted. The exchange rules end an exchange at its first terminal reply, so the latest reply
 * alone says the state. A reply type a later addition brings shows as working until this view knows it.
 */
export function taskState(requestType, latest) {
  switch (latest?.type) {
    case undefined:
      return SUBMITTED;
    case "accept":
      return requestType === "introduction" ? COMPLETED : WORKING;
    case "answer":
      return COMPLETED;
    case "result":
      return latest.body.outcome === "failed" ? FAILED : COMPLETED;
    case "run_return":
      return FAILED;
    case "decline":
      return REJECTED;
    case "cancel":
    case "run_cancel":
    case "share_revoke":
      return CANCELED;
    default:
      return WORKING;
  }
}

/** An audit entry's receipt: what the relay answers for its send (send.response). */
export const receiptOf = (entry) => ({ id: entry.envelope.id, seq: entry.seq, entry_hash: entry.hash, recorded_at: entry.recorded_at });

/** One entry of the exchange as an A2A Message, seen by `caller`. */
export const taskMessage = (entry, correlationId, caller) => ({
  messageId: entry.envelope.id,
  contextId: correlationId,
  taskId: correlationId,
  role: entry.envelope.from === caller ? "ROLE_USER" : "ROLE_AGENT",
  parts: [{ data: entry.envelope, mediaType: "application/json" }],
  extensions: [A2A_EXTENSION],
  metadata: { [A2A_EXTENSION]: receiptOf(entry) },
});

/**
 * The exchange whose request has the id `id`, among a chain's `entries` (in seq order), as GetTask
 * shows it to `caller` at the URL of `member`; null when there is no such request between them, in
 * either direction (TASK_NOT_FOUND). The history holds the latest HISTORY_LIMIT messages at most, and
 * the latest `historyLength` when it is given; 0 holds none.
 */
export function exchangeTask(entries, id, caller, member, { historyLength } = {}) {
  const request = entries.find((e) => e.envelope.id === id && !REPLY_TYPES.includes(e.envelope.type));
  if (!request) return null;
  const { from, to, type } = request.envelope;
  if (!((from === caller && to === member) || (from === member && to === caller))) return null;
  const exchange = [request, ...entries.filter((e) => e.seq > request.seq && REPLY_TYPES.includes(e.envelope.type) && e.envelope.in_reply_to === id)];
  const state = taskState(type, exchange.length > 1 ? exchange.at(-1).envelope : undefined);
  const n = Math.min(historyLength ?? HISTORY_LIMIT, HISTORY_LIMIT);
  const kept = n === 0 ? [] : exchange.slice(-n);
  return {
    id,
    contextId: id,
    status: { state, timestamp: exchange.at(-1).recorded_at },
    ...(kept.length ? { history: kept.map((e) => taskMessage(e, id, caller)) } : {}),
  };
}
