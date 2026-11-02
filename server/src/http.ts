// HTTP plumbing: the Sphere's error answers (spec/sphere-api.md section 1), JSON answers, and
// reading request bodies within the size limit.

import { JsonError, decodeUtf8Strict, parseStrict, type Json } from "./protocol/json.ts";

export const MAX_BODY_BYTES = 131072;

export type ErrorCode =
  | "bad_request" | "invalid_envelope" | "wrong_sphere" | "bad_signature" | "unknown_key" | "expired" | "clock_skew"
  | "duplicate" | "policy_denied" | "unknown_recipient" | "recipient_revoked" | "bad_reply" | "unauthorized"
  | "insufficient_scope" | "forbidden" | "not_found" | "conflict" | "feature_not_taken" | "invitation_invalid" | "card_invalid"
  | "payload_too_large" | "rate_limited" | "internal" | "not_sealed";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400, invalid_envelope: 400, wrong_sphere: 400, unknown_key: 400, bad_signature: 400, expired: 400,
  clock_skew: 400, card_invalid: 400, not_sealed: 400, unauthorized: 401, insufficient_scope: 403, forbidden: 403, policy_denied: 403,
  recipient_revoked: 403, invitation_invalid: 403, not_found: 404, unknown_recipient: 404, duplicate: 409,
  bad_reply: 409, conflict: 409, feature_not_taken: 409, payload_too_large: 413, rate_limited: 429, internal: 500,
};

/**
 * Text for people in an error answer: one line (no control or bidirectional formatting
 * characters, which the error schema's line_text forbids), at most `max` characters. It may
 * quote what a client sent (a member name, say), so it is cleaned, never trusted.
 */
export function oneLine(text: string, max: number): string {
  const clean = [...text.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ").toWellFormed()];
  const out = clean.length > max ? clean.slice(0, max - 1).join("") + "…" : clean.join("");
  return out.trim() || "error";
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details: string[];
  /** Seconds, for the `Retry-After` header of a `429 rate_limited`. */
  readonly retryAfter: number | undefined;
  /** More headers for the answer (a 401's `WWW-Authenticate`). */
  readonly headers: Record<string, string>;
  constructor(code: ErrorCode, message: string, details: string[] = [], retryAfter?: number, headers: Record<string, string> = {}) {
    super(message);
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
    this.headers = headers;
  }
}

export const apiError = (code: ErrorCode, message: string, details: string[] = []): ApiError => new ApiError(code, message, details);

/** The message of every `500 internal` answer (sphere-api.md section 1). */
export const INTERNAL_MESSAGE = "the Sphere failed; nothing was recorded";

/** `429 rate_limited` with `Retry-After: seconds` (sphere-api.md section 1). */
export const rateLimited = (message: string, seconds: number): ApiError => new ApiError("rate_limited", message, [], seconds);

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

export function errorResponse(e: ApiError): Response {
  const details = e.details.slice(0, 20).map((d) => oneLine(d, 300));
  const headers: Record<string, string> = { ...e.headers, ...(e.retryAfter !== undefined ? { "Retry-After": String(e.retryAfter) } : {}) };
  return json(STATUS[e.code], { error: { code: e.code, message: oneLine(e.message, 500), ...(details.length ? { details } : {}) } }, headers);
}

/** The request's body bytes, or 413 payload_too_large past the limit. */
export async function readBody(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) throw apiError("payload_too_large", `the body is over ${MAX_BODY_BYTES} bytes`);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw apiError("payload_too_large", `the body is over ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Parses a JSON body strictly (no duplicate names, integers only); `code` is the error when it isn't. */
export function parseBody(bytes: Uint8Array, code: "bad_request" | "invalid_envelope"): Json {
  try {
    return parseStrict(decodeUtf8Strict(bytes));
  } catch (e) {
    throw apiError(code, e instanceof JsonError ? `the body is not JSON as the protocol allows: ${e.message}` : "the body is not JSON");
  }
}

export async function readJson(request: Request): Promise<Json> {
  return parseBody(await readBody(request), "bad_request");
}
