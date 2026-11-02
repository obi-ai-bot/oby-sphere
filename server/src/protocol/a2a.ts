// The A2A binding's own rules (spec/a2a.md), with no I/O: what SendMessage takes beside the
// envelope (section 4, checks 5, 6, 8 and 9), and an exchange as GetTask shows it (section 5). The
// route (src/routes/a2a.ts) and the conformance checker (conformance/check.ts) both run these.

import { isRequestType, type Envelope } from "./envelope.ts";
import { schemaErrors } from "./schemas.ts";

/** The A2A version the interface speaks (A2A-Version), and the extension a client activates (A2A-Extensions). */
export const A2A_VERSION = "1.0";
export const EXTENSION = "urn:obi-sphere:ext:obi:0.1";
/** The most messages a task's history holds: the latest ones (A2A lets a server set a lower limit than a client asks). */
export const HISTORY_LIMIT = 50;

/** Why the binding refuses a send: `bad_request` and `wrong_recipient` are the Obysphere's, the others A2A's. */
export type BindingProblem = { code: "bad_request" | "wrong_recipient" | "unsupported_operation" | "push_notification_not_supported"; message: string; details?: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The parts of a SendMessageRequest the binding reads, once it matches a2a-send.request. */
export interface SendMessage {
  message: { messageId: string; contextId?: string; taskId?: string; parts: [{ data: unknown }] };
  configuration: { returnImmediately: true; historyLength?: number };
}

/** Checks 5 and 6: no push notifications, nothing held open, and A2A's request as the binding takes it. */
export function sendRequestProblem(value: unknown): BindingProblem | null {
  if (!isObject(value)) return { code: "bad_request", message: "the body is a JSON object: A2A's SendMessageRequest" };
  const config = value.configuration;
  if (isObject(config) && config.taskPushNotificationConfig !== undefined) return { code: "push_notification_not_supported", message: "this interface sends no push notifications: read the task" };
  if (!isObject(config) || config.returnImmediately !== true) return { code: "unsupported_operation", message: "send with configuration.returnImmediately: true; the receiver's owner decides, and the task shows the replies" };
  const errors = schemaErrors("a2aSendRequest", value);
  return errors.length ? { code: "bad_request", message: `the body doesn't match a2a-send.request: ${errors[0]}`, details: errors } : null;
}

/** Checks 8 and 9, once the envelope passed protocol.md section 10's checks 1 to 3: the message agrees with it, and it is for the URL's `member`. */
export function agreementProblem(message: SendMessage["message"], envelope: Envelope, member: string): BindingProblem | null {
  if (message.messageId !== envelope.id) return { code: "bad_request", message: "messageId is the envelope's id" };
  if (message.contextId !== undefined && message.contextId !== envelope.correlation_id) return { code: "bad_request", message: "contextId is the envelope's correlation_id" };
  if (isRequestType(envelope.type)) {
    if (message.taskId !== undefined) return { code: "bad_request", message: "a request starts its task: it has no taskId" };
  } else if (message.taskId !== envelope.correlation_id) {
    return { code: "bad_request", message: "a reply's taskId is its envelope's correlation_id: the task it continues" };
  }
  if (envelope.to !== member) return { code: "wrong_recipient", message: `the envelope is for ${envelope.to}, not ${member}, whose URL this is` };
  return null;
}

/** An exchange's entry as the chain keeps it. */
export interface ExchangeEntry {
  seq: number;
  recorded_at: string;
  hash: string;
  envelope: Envelope;
}

/**
 * The state an exchange is in after its latest reply, its request being of `requestType`; with no
 * reply yet, submitted. The exchange rules end an exchange at its first terminal reply, so the latest
 * reply alone says the state.
 */
export function taskState(requestType: string, latest?: Envelope): string {
  switch (latest?.type) {
    case undefined:
      return "TASK_STATE_SUBMITTED";
    case "accept":
      return requestType === "introduction" ? "TASK_STATE_COMPLETED" : "TASK_STATE_WORKING";
    case "answer":
      return "TASK_STATE_COMPLETED";
    case "result":
      return latest.body.outcome === "failed" ? "TASK_STATE_FAILED" : "TASK_STATE_COMPLETED";
    case "run_return":
      return "TASK_STATE_FAILED";
    case "decline":
      return "TASK_STATE_REJECTED";
    case "cancel":
    case "run_cancel":
    case "share_revoke":
      return "TASK_STATE_CANCELED";
    default:
      // status, run_progress, share_status; and a reply a later addition brings, until this view knows it.
      return "TASK_STATE_WORKING";
  }
}

/** The latest `historyLength` messages a task holds, at most HISTORY_LIMIT; all of them, up to it, when it isn't given. */
export const historyKept = (historyLength?: number): number => Math.min(historyLength ?? HISTORY_LIMIT, HISTORY_LIMIT);

/**
 * An exchange as the A2A Task GetTask shows `caller`: `request`, and `replies`, the latest of its
 * replies in the chain's order, all of them or at least the latest `historyKept(historyLength)` (and
 * the latest one). Each envelope is one message, `ROLE_USER` when the caller sent it.
 */
export function exchangeTask(request: ExchangeEntry, replies: ExchangeEntry[], caller: string, historyLength?: number): Record<string, unknown> {
  const id = request.envelope.id;
  const n = historyKept(historyLength);
  const kept = n === 0 ? [] : replies.length < n ? [request, ...replies] : replies.slice(-n);
  const last = replies.at(-1) ?? request;
  return {
    id,
    contextId: id,
    status: { state: taskState(request.envelope.type, replies.at(-1)?.envelope), timestamp: last.recorded_at },
    ...(kept.length
      ? {
          history: kept.map((e) => ({
            messageId: e.envelope.id,
            contextId: id,
            taskId: id,
            role: e.envelope.from === caller ? "ROLE_USER" : "ROLE_AGENT",
            parts: [{ data: e.envelope, mediaType: "application/json" }],
            extensions: [EXTENSION],
            metadata: { [EXTENSION]: { id: e.envelope.id, seq: e.seq, entry_hash: e.hash, recorded_at: e.recorded_at } },
          })),
        }
      : {}),
  };
}
