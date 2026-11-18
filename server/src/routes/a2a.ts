// The A2A binding (spec/a2a.md): each member's card url is an A2A 1.0 interface, in A2A's
// HTTP+JSON binding. SendMessage carries one signed envelope, unchanged, as its message's one data
// part, and goes through the relay's own checks and record (routes/messages.ts, `recordSend`), so a
// message sent this way is the one the relay would have recorded. GetTask shows an exchange
// between the caller and the URL's member, read from the chain. Every error here is A2A's
// (google.rpc.Status), never the Obysphere's own form.

import { bearer, presented, requireActor, requireScope, unauthorized, type Caller } from "../auth.ts";
import { requireSphere, type SphereRow } from "../db.ts";
import type { Deps, Env } from "../env.ts";
import { ApiError, INTERNAL_MESSAGE, apiError, errorResponse, oneLine, parseBody, readBody } from "../http.ts";
import { A2A_VERSION, EXTENSION, agreementProblem, exchangeTask, historyKept, sendRequestProblem, type BindingProblem, type ExchangeEntry, type SendMessage } from "../protocol/a2a.ts";
import type { Envelope } from "../protocol/envelope.ts";
import { recordSend } from "./messages.ts";

const A2A_DOMAIN = "a2a-protocol.org";
/** Where an agent without a token reads how it joins: an invite link, then a token (spec/a2a.md section 2). */
const JOINING = "https://github.com/obi-ai-bot/oby-sphere/blob/main/spec/sphere-api.md#21-invite-links";

const nowS = (deps: Deps) => Math.floor(deps.now() / 1000);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An error in A2A's form: its HTTP status, gRPC status name, reason and domain (spec/a2a.md section 6). */
class A2aError extends Error {
  readonly status: number;
  readonly grpc: string;
  readonly reason: string;
  readonly domain: string;
  constructor(status: number, grpc: string, reason: string, domain: string, message: string) {
    super(message);
    this.status = status;
    this.grpc = grpc;
    this.reason = reason;
    this.domain = domain;
  }
}

/** A2A's own errors, under a2a-protocol.org (A2A section 5.4). */
const a2aOwn = (reason: string, message: string) => new A2aError(reason === "TASK_NOT_FOUND" ? 404 : 400, reason === "TASK_NOT_FOUND" ? "NOT_FOUND" : "FAILED_PRECONDITION", reason, A2A_DOMAIN, message);
const unsupported = (message: string) => a2aOwn("UNSUPPORTED_OPERATION", message);
const taskNotFound = () => a2aOwn("TASK_NOT_FOUND", "no such task between you and this member");

/** A binding rule's refusal as the error it answers: the Obysphere's own `bad_request`, `wrong_recipient` (400) or A2A's. */
function refusal(p: BindingProblem): Error {
  if (p.code === "bad_request") return apiError("bad_request", p.message, p.details ?? []);
  if (p.code === "wrong_recipient") return new A2aError(400, "INVALID_ARGUMENT", "WRONG_RECIPIENT", EXTENSION, p.message);
  return a2aOwn(p.code.toUpperCase(), p.message);
}

/** The gRPC status name for one of the Obysphere's own errors, by its HTTP status. */
function grpcStatus(code: string, status: number): string {
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "PERMISSION_DENIED";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return code === "duplicate" ? "ALREADY_EXISTS" : "ABORTED";
  if (status === 429) return "RESOURCE_EXHAUSTED";
  if (status === 500) return "INTERNAL";
  return "INVALID_ARGUMENT";
}

const A2A_HEADERS = { "Content-Type": "application/a2a+json", "Cache-Control": "no-store" };

/** A successful answer, saying which extension it activated. */
const answer = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { ...A2A_HEADERS, "A2A-Extensions": EXTENSION } });

/**
 * Any error as A2A's google.rpc.Status, the Obysphere's own codes in capitals under the extension's
 * URI. A 401 to a call that sent no token at all says how an agent joins (spec/a2a.md section 2).
 */
function errorAnswer(e: unknown, noToken: boolean): Response {
  let status: number, grpc: string, reason: string, domain: string, message: string;
  let headers: Record<string, string> = {};
  if (e instanceof A2aError) {
    ({ status, grpc, reason, domain, message } = e);
  } else if (e instanceof ApiError) {
    // The Obysphere's own answer gives the HTTP status and the headers (a 401's challenge, Retry-After).
    const plain = errorResponse(e);
    status = plain.status;
    for (const h of ["WWW-Authenticate", "Retry-After"]) {
      const v = plain.headers.get(h);
      if (v !== null) headers[h] = v;
    }
    grpc = grpcStatus(e.code, status);
    reason = e.code.toUpperCase();
    domain = EXTENSION;
    message = e.message;
  } else {
    // Never echo what failed: it may hold what a client sent. The cause stays in the Worker's own log.
    console.error("sphere: internal error", e instanceof Error ? e.name : typeof e);
    ({ status, grpc, reason, domain, message } = { status: 500, grpc: "INTERNAL", reason: "INTERNAL", domain: EXTENSION, message: INTERNAL_MESSAGE });
  }
  const details: unknown[] = [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain }];
  if (status === 401 && noToken) {
    details.push({
      "@type": "type.googleapis.com/google.rpc.Help",
      links: [{ description: "Only members call here. To join: an invite link from this Obysphere's admin, redeemed with a card your owner signed, then a token.", url: JOINING }],
    });
  }
  return new Response(JSON.stringify({ error: { code: status, status: grpc, message: oneLine(message, 500), details } }), { status, headers: { ...A2A_HEADERS, ...headers } });
}

type Need = "send" | "read" | "any";
type Operation = (request: Request, env: Env, deps: Deps, sphere: SphereRow, caller: Caller, member: string, ...rest: string[]) => Promise<Response>;

/**
 * An operation of the interface: the token first, before anything about the Obysphere or the member is
 * read, then the A2A version and the extension (spec/a2a.md sections 2 and 3), and every error answered
 * in A2A's form. Sending needs an agent's token at its first check, as the relay's send does
 * (sphere-api.md section 6.1, check 1), and one that may read the exchange its answer shows.
 */
function operation(need: Need, op: Operation) {
  return async (request: Request, env: Env, deps: Deps, sphereId: string, member: string, ...rest: string[]): Promise<Response> => {
    try {
      const caller = await bearer(request, env, null, nowS(deps));
      if (caller.sphere !== sphereId) throw unauthorized(env, "the access token is for another Obysphere", "invalid_token");
      if (need === "send") {
        if (caller.actor === null) throw unauthorized(env, "sending needs an agent's token (one with an actor)");
        requireScope(caller, "receive", "audit:read");
      }
      const sphere = await requireSphere(env.DB, sphereId);
      const version = (request.headers.get("A2A-Version") ?? new URL(request.url).searchParams.get("A2A-Version") ?? "").trim();
      if (version !== A2A_VERSION) throw a2aOwn("VERSION_NOT_SUPPORTED", `this interface speaks A2A ${A2A_VERSION}: send A2A-Version: ${A2A_VERSION}${version ? "" : " (none means 0.3)"}`);
      const extensions = (request.headers.get("A2A-Extensions") ?? "").split(",").map((u) => u.trim());
      if (!extensions.includes(EXTENSION)) throw a2aOwn("EXTENSION_SUPPORT_REQUIRED", `activate the required extension: A2A-Extensions: ${EXTENSION}`);
      return await op(request, env, deps, sphere, caller, member, ...rest);
    } catch (e) {
      return errorAnswer(e, presented(request) === null);
    }
  };
}

// ---------------------------------------------------------------------------------------------
// The exchange as a task (spec/a2a.md section 5).

type EntryRow = { seq: number; recorded_at: string; envelope: string; hash: string };
const entry = (r: EntryRow): ExchangeEntry => ({ seq: r.seq, recorded_at: r.recorded_at, hash: r.hash, envelope: JSON.parse(r.envelope) as Envelope });

/**
 * The exchange whose request has the id `id`, when that request is between `caller` and `member`
 * (either way round), as an A2A Task; null otherwise. Who may see it is part of both queries, so
 * nothing of an exchange between others is read; and only the replies the task shows are read.
 */
async function readTask(env: Env, sphere: string, id: string, caller: string, member: string, historyLength?: number): Promise<Record<string, unknown> | null> {
  const between = "((from_obi = ?3 AND to_obi = ?4) OR (from_obi = ?4 AND to_obi = ?3))";
  const [request, replies] = await env.DB.batch([
    env.DB.prepare(`SELECT seq, recorded_at, envelope, hash FROM audit WHERE sphere = ?1 AND msg_id = ?2 AND in_reply_to IS NULL AND ${between}`).bind(sphere, id, caller, member),
    env.DB.prepare(
      `SELECT seq, recorded_at, envelope, hash FROM audit WHERE sphere = ?1 AND in_reply_to = ?2
          AND EXISTS (SELECT 1 FROM audit WHERE sphere = ?1 AND msg_id = ?2 AND in_reply_to IS NULL AND ${between})
        ORDER BY seq DESC LIMIT ?5`,
    ).bind(sphere, id, caller, member, Math.max(historyKept(historyLength), 1)),
  ]);
  const row = (request!.results as unknown as EntryRow[])[0];
  if (!row) return null;
  return exchangeTask(entry(row), (replies!.results as unknown as EntryRow[]).reverse().map(entry), caller, historyLength);
}

// ---------------------------------------------------------------------------------------------
// POST {url}/message:send: checks 4 to 10 of spec/a2a.md section 4 (1 to 3 are `operation`'s).

export const sendMessage = operation("send", async (request, env, deps, sphere, caller, member) => {
  // 4. At most 131,072 bytes, a JSON object with no duplicate member names.
  const value = parseBody(await readBody(request), "bad_request");
  // 5 and 6. No push notifications, nothing held open, and the envelope as the one data part, nothing beside it.
  const problem = sendRequestProblem(value);
  if (problem) throw refusal(problem);
  const { message, configuration } = value as unknown as SendMessage;
  let correlationId = "";
  // 7, then the relay's own checks 5 to 13, with 8 and 9 between them.
  const sent = await recordSend(env, deps, sphere, caller, message.parts[0].data, (envelope) => {
    const disagreement = agreementProblem(message, envelope, member);
    if (disagreement) throw refusal(disagreement);
    correlationId = envelope.correlation_id;
  });
  // Recorded: from here an error must say so, and the client reads the task, or sends the same bytes again (a retry).
  let task: Record<string, unknown> | null = null;
  try {
    task = await readTask(env, sphere.id, correlationId, caller.actor!, member, configuration.historyLength);
  } catch (e) {
    console.error("sphere: a2a: reading a recorded message's task failed", e instanceof Error ? e.name : typeof e);
  }
  if (!task) throw new A2aError(500, "INTERNAL", "INTERNAL", EXTENSION, `recorded as seq ${sent.receipt.seq}, but its task couldn't be read: read it with GetTask`);
  return answer(200, { task: { ...task, metadata: { [EXTENSION]: sent.receipt } } });
});

// ---------------------------------------------------------------------------------------------
// GET {url}/tasks/{id}

/** `historyLength`, a decimal integer from 0, or undefined; past HISTORY_LIMIT the task holds that many (A2A lets a server hold fewer). */
function historyParam(url: URL): number | undefined {
  const all = url.searchParams.getAll("historyLength");
  if (all.length === 0) return undefined;
  if (all.length > 1 || !/^[0-9]{1,10}$/.test(all[0]!)) throw apiError("bad_request", "historyLength is one decimal integer from 0");
  return Number(all[0]);
}

export const getTask = operation("read", async (request, env, _deps, sphere, caller, member, id) => {
  const actor = requireActor(caller);
  requireScope(caller, "receive", "audit:read");
  const url = new URL(request.url);
  const historyLength = historyParam(url);
  const task = UUID.test(id!) ? await readTask(env, sphere.id, id!, actor, member, historyLength) : null;
  if (!task) throw taskNotFound();
  return answer(200, task);
});

// ---------------------------------------------------------------------------------------------
// What the interface doesn't do (spec/a2a.md section 3).

/** Streaming, subscribing, listing and cancelling tasks, and the extended card. */
export const notSupported = (why: string) => operation("any", async () => {
  throw unsupported(why);
});

/** Push notification configurations. */
export const noPushNotifications = operation("any", async () => {
  throw a2aOwn("PUSH_NOTIFICATION_NOT_SUPPORTED", "this interface sends no push notifications (pushNotifications: false): read the task");
});
