// Copied from client/src/envelope.ts by server/scripts/sync-client.mjs: edit it there, then run `pnpm run sync:client`.
// Envelopes: signing input, the checks of spec/protocol.md section 10, and the exchange rules
// (section 4). Text fields are data: nothing here reads them beyond their schema.

import { verifyEd25519, keyIdOrNull, type SigningKey } from "./crypto.ts";
import { JsonError, canonicalBytes, utf8, type JsonObject } from "./json.ts";
import {
  CLOCK_SKEW_SECONDS, ENVELOPE_SIGNING_PREFIX, MAX_ENVELOPE_BYTES, MAX_LIFETIME_SECONDS, OK, PROTOCOL, SENDER_REPLY_TYPES, fail, isReplyType, keyValidAt, seconds,
  semanticProblems, timestamp, type DirectoryKey, type Envelope, type RequestType, type Verdict,
} from "./rules.ts";
import { schemaErrors } from "./schemas.ts";

export * from "./rules.ts";

export function envelopeSigningInput(envelope: object): Uint8Array {
  const { signature: _signature, ...unsigned } = envelope as Record<string, unknown>;
  const body = canonicalBytes(unsigned);
  const prefix = utf8(ENVELOPE_SIGNING_PREFIX);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix);
  out.set(body, prefix.length);
  return out;
}

/**
 * Checks 1 to 3 of protocol.md section 10: size, schema, and the rules no schema says.
 * Returns the envelope typed when they pass.
 */
export function checkEnvelopeShape(value: unknown): { ok: true; envelope: Envelope } | { ok: false; code: string; message: string } {
  let size: number;
  try {
    size = canonicalBytes(value).length;
  } catch (e) {
    return { ok: false, code: "invalid_envelope", message: e instanceof JsonError ? e.message : "not canonical JSON" };
  }
  if (size > MAX_ENVELOPE_BYTES) return { ok: false, code: "payload_too_large", message: `${size} bytes canonical, the most is ${MAX_ENVELOPE_BYTES}` };
  // A sealed envelope's words are sealed_text: the sealed schema checks their size, never what they say.
  const sealed = typeof value === "object" && value !== null && Object.hasOwn(value, "seal");
  const errors = schemaErrors(sealed ? "sealed/envelope" : "envelope", value);
  if (errors.length) return { ok: false, code: "invalid_envelope", message: errors.join("; ") };
  const env = value as Envelope;
  const problems = semanticProblems(env);
  if (problems.length) return { ok: false, code: "invalid_envelope", message: problems.join("; ") };
  return { ok: true, envelope: env };
}

export const verifyEnvelopeSignature = (env: Envelope, publicKey: string): Promise<boolean> =>
  verifyEd25519(publicKey, envelopeSigningInput(env), env.signature);

export interface ReceiverContext {
  now: string | number;
  sphere: string;
  receiver: string;
  keys: Record<string, DirectoryKey>;
  seq?: number | null;
  seen_ids?: string[];
}

/** The whole of protocol.md section 10, as the receiving Obi `ctx.receiver` judges a message. */
export async function verifyEnvelope(value: unknown, ctx: ReceiverContext): Promise<Verdict> {
  const shape = checkEnvelopeShape(value);
  if (!shape.ok) return fail(shape.code, shape.message);
  const env = shape.envelope;
  if (env.sphere !== ctx.sphere) return fail("wrong_sphere", `for ${env.sphere}, not ${ctx.sphere}`);
  if (typeof ctx.receiver !== "string") return fail("wrong_recipient", "the context names no receiver");
  if (env.to !== ctx.receiver) return fail("wrong_recipient", `addressed to ${env.to}, not ${ctx.receiver}`);
  const key = Object.hasOwn(ctx.keys ?? {}, env.key_id) ? ctx.keys[env.key_id] : undefined;
  if (!key || key.obi !== env.from) return fail("unknown_key", `${env.key_id} is not a key of ${env.from}`);
  if ((await keyIdOrNull(key.public_key)) !== env.key_id) return fail("unknown_key", "the directory's key does not hash to key_id");
  if (!keyValidAt(key, ctx.seq)) return fail("unknown_key", ctx.seq === undefined || ctx.seq === null ? `${env.key_id} is not ${env.from}'s current key` : `${env.key_id} was not valid at seq ${ctx.seq}`);
  if (!(await verifyEnvelopeSignature(env, key.public_key))) return fail("bad_signature", "the signature does not verify");
  const now = typeof ctx.now === "number" ? ctx.now : seconds(ctx.now);
  if (!(seconds(env.expires_at) > now)) return fail("expired", `expired at ${env.expires_at}`);
  if (seconds(env.created_at) > now + CLOCK_SKEW_SECONDS) return fail("clock_skew", `created_at is more than ${CLOCK_SKEW_SECONDS} seconds ahead`);
  if ((ctx.seen_ids ?? []).includes(env.id)) return fail("duplicate", `${env.id} was seen before`);
  return OK;
}

// ---------------------------------------------------------------------------------------------
// Making messages: the sender's side of sections 3 and 9.

/** An envelope before it is signed. */
export type UnsignedEnvelope = Omit<Envelope, "signature">;

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** How long a message the library makes lives when the caller doesn't say: one day. */
export const DEFAULT_LIFETIME_SECONDS = 86400;

/** Signs an envelope with the sender's key: Ed25519 over the prefix and the canonical JSON of every other member (section 9). */
export async function signEnvelope(unsigned: UnsignedEnvelope, key: SigningKey): Promise<Envelope> {
  const { signature: _signature, ...rest } = unsigned as UnsignedEnvelope & { signature?: string };
  if (rest.key_id !== key.keyId) throw new Error(`the envelope names ${rest.key_id}, and the key is ${key.keyId}`);
  return { ...rest, signature: await key.sign(envelopeSigningInput(rest)) };
}

export interface MessageOptions {
  sphere: string;
  /** The sender's obi_id. */
  from: string;
  /** The sender's current key id. */
  keyId: string;
  /** Seconds since 1970; now when left out. */
  now?: number;
  /** Seconds from `now` until it expires: 1 to 2,592,000. */
  expiresIn?: number;
}

function lifetime(opts: MessageOptions): { created_at: string; expires_at: string } {
  const now = opts.now ?? nowSeconds();
  const expiresIn = opts.expiresIn ?? DEFAULT_LIFETIME_SECONDS;
  if (!Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_LIFETIME_SECONDS) throw new Error(`expiresIn is 1 to ${MAX_LIFETIME_SECONDS} seconds`);
  return { created_at: timestamp(now), expires_at: timestamp(now + expiresIn) };
}

/** A new request to `to`, unsigned: its own exchange, `correlation_id` its `id`. */
export function newRequest(opts: MessageOptions & { to: string; type: RequestType; body: JsonObject }): UnsignedEnvelope {
  const id = crypto.randomUUID();
  return {
    protocol: PROTOCOL, id, type: opts.type, from: opts.from, to: opts.to, sphere: opts.sphere, correlation_id: id,
    ...lifetime(opts), key_id: opts.keyId, body: opts.body,
  };
}

/**
 * A reply to `request`, unsigned. It goes to the request's sender, or, for the replies a request's
 * own sender sends (`run_cancel`, `share_status`, `share_revoke`, `cancel`), to its receiver.
 */
export function newReply(request: Pick<Envelope, "id" | "from" | "to" | "sphere">, opts: Omit<MessageOptions, "sphere"> & { type: string; body: JsonObject }): UnsignedEnvelope {
  if (!isReplyType(opts.type)) throw new Error(`${opts.type} is not a reply`);
  const to = SENDER_REPLY_TYPES.includes(opts.type) ? request.to : request.from;
  return {
    protocol: PROTOCOL, id: crypto.randomUUID(), type: opts.type, from: opts.from, to, sphere: request.sphere,
    correlation_id: request.id, in_reply_to: request.id, ...lifetime({ ...opts, sphere: request.sphere }), key_id: opts.keyId, body: opts.body,
  };
}
