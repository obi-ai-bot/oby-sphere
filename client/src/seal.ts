// Sealing the words (spec/protocol.md section 9.1): every text value of a body, sealed for its
// recipient's X25519 seal key with a new X25519 key of the sender's, HKDF-SHA256 and
// ChaCha20-Poly1305; and check 11 of section 10, opening them. WebCrypto has no ChaCha20-Poly1305,
// so this module uses node:crypto: it runs in Node (and runtimes with node:crypto), and nothing
// the Sphere runs imports it (a Sphere holds no seal key and never opens anything).

import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes as nodeRandomBytes } from "node:crypto";
import { b64url, fromB64url, sha256 } from "./crypto.ts";
import { canonicalBytes, type JsonObject } from "./json.ts";
import { fail, semanticProblems, type Envelope, type ReceiverContext, type UnsignedEnvelope, type Verdict, verifyEnvelope } from "./envelope.ts";
import { schemaErrors, textPaths } from "./schemas.ts";

export const SEAL_SUITE = "x25519-hkdf-sha256-chacha20poly1305";
export const SEAL_INFO_PREFIX = "obi/0.1 seal\n";

const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

const x25519Private = (raw32: Uint8Array) => createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, raw32]), format: "der", type: "pkcs8" });
const x25519PublicOf = (privateRaw: Uint8Array): Uint8Array => fromB64url(createPublicKey(x25519Private(privateRaw)).export({ format: "jwk" }).x as string);
const x25519Shared = (privateRaw: Uint8Array, peerRaw: Uint8Array): Uint8Array =>
  new Uint8Array(diffieHellman({ privateKey: x25519Private(privateRaw), publicKey: createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, peerRaw]), format: "der", type: "spki" }) }));

/** `x25519:` + base64url of SHA-256 of the raw seal key. */
export const sealKeyIdOf = async (publicRaw: Uint8Array): Promise<string> => "x25519:" + b64url(await sha256(publicRaw));

/** An Obi's seal key: the X25519 key other Obis seal its words for, made apart from its signing key. `privateKey` is what to keep, secret. */
export class SealKey {
  readonly publicKey: string;
  readonly keyId: string;
  readonly #private: Uint8Array;

  private constructor(privateRaw: Uint8Array, publicKey: string, keyId: string) {
    this.#private = privateRaw;
    this.publicKey = publicKey;
    this.keyId = keyId;
  }

  static async fromPrivate(privateRaw: Uint8Array): Promise<SealKey> {
    if (privateRaw.length !== 32) throw new Error("an X25519 private key is 32 bytes");
    const pub = x25519PublicOf(privateRaw);
    return new SealKey(Uint8Array.from(privateRaw), b64url(pub), await sealKeyIdOf(pub));
  }

  static generate(): Promise<SealKey> {
    return SealKey.fromPrivate(new Uint8Array(nodeRandomBytes(32)));
  }

  /** The 32 private bytes, base64url: what to keep, secret. */
  get privateKey(): string {
    return b64url(this.#private);
  }

  toJSON(): { publicKey: string; keyId: string } {
    return { publicKey: this.publicKey, keyId: this.keyId };
  }
}

/** The envelope's key: HKDF-SHA256 of the X25519 secret, salted with enc ‖ the recipient's key. */
function messageKey(shared: Uint8Array, encRaw: Uint8Array, recipientRaw: Uint8Array, env: Pick<Envelope, "sphere" | "id" | "from" | "to" | "type">): Buffer {
  const info = Buffer.concat([Buffer.from(SEAL_INFO_PREFIX, "utf8"), canonicalBytes({ sphere: env.sphere, id: env.id, from: env.from, to: env.to, type: env.type })]);
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([encRaw, recipientRaw]), info, 32));
}

/** A value's nonce: the first 12 bytes of SHA-256 of its JSON Pointer, unique in its envelope. */
const nonceOf = async (pointer: string): Promise<Uint8Array> => (await sha256(new TextEncoder().encode(pointer))).subarray(0, 12);

async function sealValue(key: Buffer, pointer: string, text: string): Promise<Uint8Array> {
  const cipher = createCipheriv("chacha20-poly1305", key, await nonceOf(pointer), { authTagLength: 16 });
  const plain = Buffer.from(text, "utf8");
  cipher.setAAD(Buffer.from(pointer, "utf8"), { plaintextLength: plain.length });
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

/** The text, or an exception when it doesn't open (changed, moved, another key) or isn't UTF-8. */
async function openValue(key: Buffer, pointer: string, sealed: Uint8Array): Promise<string> {
  if (sealed.length < 16) throw new Error("shorter than its tag");
  const decipher = createDecipheriv("chacha20-poly1305", key, await nonceOf(pointer), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(pointer, "utf8"), { plaintextLength: sealed.length - 16 });
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(plain);
}

const unescapeToken = (t: string) => t.replaceAll("~1", "/").replaceAll("~0", "~");
const escapeToken = (t: string) => t.replaceAll("~", "~0").replaceAll("/", "~1");

/** A text value of a body: its JSON Pointer, and the object or array holding it under `key`. */
export interface TextValue {
  pointer: string;
  parent: Record<string, unknown> | unknown[];
  key: string | number;
}

/** Every text value in an action's body (its type's text paths), in the body's own order. */
export function textValues(type: string, body: unknown): TextValue[] {
  const patterns = (textPaths[type] ?? []).map((p) => p.split("/").slice(1).map(unescapeToken));
  const out: TextValue[] = [];
  const walk = (value: unknown, tokens: string[], parent: TextValue["parent"] | null, key: string | number | null) => {
    if (typeof value === "string") {
      const hit = patterns.some((p) => p.length === tokens.length && p.every((t, i) => t === tokens[i] || (t === "*" && /^(0|[1-9][0-9]*)$/.test(tokens[i]!))));
      if (hit && parent !== null && key !== null) out.push({ pointer: "/" + tokens.map(escapeToken).join("/"), parent, key });
    } else if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...tokens, String(i)], value, i));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, [...tokens, k], value as Record<string, unknown>, k);
  };
  walk(body, [], null, null);
  return out;
}

const setAt = (t: TextValue, v: string) => {
  (t.parent as Record<string | number, unknown>)[t.key] = v;
};

/**
 * The unsigned envelope with its words sealed for the recipient's seal key (`recipient`: its
 * public key, base64url), and its `seal`. Sign it after sealing: the signature covers the sealed words.
 */
export async function sealEnvelope(unsigned: UnsignedEnvelope, recipient: string, ephemeral: Uint8Array = new Uint8Array(nodeRandomBytes(32))): Promise<UnsignedEnvelope> {
  const recipientRaw = fromB64url(recipient);
  if (recipientRaw.length !== 32) throw new Error("an X25519 public key is 32 bytes");
  const encRaw = x25519PublicOf(ephemeral);
  const key = messageKey(x25519Shared(ephemeral, recipientRaw), encRaw, recipientRaw, unsigned);
  const body = structuredClone(unsigned.body);
  for (const t of textValues(unsigned.type, body)) setAt(t, b64url(await sealValue(key, t.pointer, (t.parent as Record<string | number, string>)[t.key]!)));
  return { ...unsigned, body, seal: { suite: SEAL_SUITE, key_id: await sealKeyIdOf(recipientRaw), enc: b64url(encRaw) } };
}

/** A sealed envelope's body with its words opened with `key`; throws when one doesn't open. */
export async function openBody(env: Envelope, key: SealKey): Promise<JsonObject> {
  if (!env.seal) throw new Error("the envelope is not sealed");
  const encRaw = fromB64url(env.seal.enc);
  const privateRaw = fromB64url(key.privateKey);
  const shared = x25519Shared(privateRaw, encRaw);
  if (shared.every((b) => b === 0)) throw new Error("an all-zero X25519 secret");
  const mk = messageKey(shared, encRaw, fromB64url(key.publicKey), env);
  const body = structuredClone(env.body);
  for (const t of textValues(env.type, body)) setAt(t, await openValue(mk, t.pointer, fromB64url((t.parent as Record<string | number, string>)[t.key]!)));
  return body;
}

/** A receiver's context with the seal keys it holds: check 11 needs them. */
export interface OpeningContext extends ReceiverContext {
  /** The receiver's own seal keys, by seal key id. */
  seal_keys?: Record<string, SealKey>;
  /** Whether the sender's trusted card has a seal key. */
  sender_seals?: boolean;
}

/**
 * Check 11 (protocol.md section 9.1), after the signature: a sealed message opens with one of the
 * receiver's own seal keys to a body that passes the plain schema and check 3; one in the clear is
 * refused when both seal. Answers the opened body, or the failure.
 */
export async function openEnvelope(env: Envelope, ctx: Pick<OpeningContext, "seal_keys" | "sender_seals" | "receiver">): Promise<{ ok: true; body: JsonObject } | (Verdict & { ok: false })> {
  const own = ctx.seal_keys ?? {};
  if (env.seal === undefined) {
    if (Object.keys(own).length && ctx.sender_seals) return fail("not_sealed", `${env.from} and ${ctx.receiver} both seal: its words must be sealed`) as Verdict & { ok: false };
    return { ok: true, body: env.body };
  }
  const mine = Object.hasOwn(own, env.seal.key_id) ? own[env.seal.key_id] : undefined;
  if (!mine) return fail("seal_invalid", `sealed for ${env.seal.key_id}, not a seal key of ${ctx.receiver}`) as Verdict & { ok: false };
  let body: JsonObject;
  try {
    body = await openBody(env, mine);
  } catch {
    return fail("seal_invalid", "a sealed value doesn't open") as Verdict & { ok: false };
  }
  const { seal: _seal, ...opened } = { ...env, body };
  const errors = schemaErrors("envelope", opened);
  if (errors.length) return fail("seal_invalid", `opened, it doesn't match the schema: ${errors.join("; ")}`) as Verdict & { ok: false };
  const problems = semanticProblems(opened as Envelope);
  if (problems.length) return fail("seal_invalid", `opened: ${problems.join("; ")}`) as Verdict & { ok: false };
  return { ok: true, body };
}

/** The whole of protocol.md section 10, checks 1 to 11, as the receiving Obi judges a message; with the opened body when it passes. */
export async function verifyAndOpen(value: unknown, ctx: OpeningContext): Promise<{ ok: true; body: JsonObject } | (Verdict & { ok: false })> {
  const verdict = await verifyEnvelope(value, ctx);
  if (!verdict.ok) return verdict;
  return openEnvelope(value as Envelope, ctx);
}
