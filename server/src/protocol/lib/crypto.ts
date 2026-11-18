// Copied from client/src/crypto.ts by server/scripts/sync-client.mjs: edit it there, then run `pnpm run sync:client`.
// Bytes, base64url, SHA-256 and Ed25519 through WebCrypto, so the same code runs in a Worker
// (workerd), in Node and in a browser.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = new Map([...ALPHABET].map((c, i) => [c, i]));

export function b64url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]!;
  }
  return out;
}

/**
 * base64url without padding to bytes. Characters outside the alphabet make it throw; unused
 * low bits of the last character are ignored, as Node's Buffer does (the reference verifier's
 * decoder), so both read the same bytes.
 */
export function fromB64url(text: string): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const c of text) {
    const v = LOOKUP.get(c);
    if (v === undefined) throw new Error("not base64url");
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => hex(await sha256(bytes));

/** `ed25519:` + base64url(SHA-256(raw public key)). Throws when the key is not 32 bytes. */
export async function keyIdOf(publicKey: string): Promise<string> {
  const raw = fromB64url(publicKey);
  if (raw.length !== 32) throw new Error("an Ed25519 public key is 32 bytes");
  return "ed25519:" + b64url(await sha256(raw));
}

/** The key id of `publicKey`, or null when it is not a 32-byte key. */
export async function keyIdOrNull(publicKey: string): Promise<string | null> {
  try {
    return await keyIdOf(publicKey);
  } catch {
    return null;
  }
}

/** `x25519:` + base64url(SHA-256(raw seal key)) (protocol.md section 9.1), or null when it is not 32 bytes. */
export async function sealKeyIdOrNull(publicKey: string): Promise<string | null> {
  const raw = fromB64url(publicKey);
  return raw.length === 32 ? "x25519:" + b64url(await sha256(raw)) : null;
}

/** A WebCrypto key, named so that both Node's and the Workers' type definitions agree on it. */
type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const imported = new Map<string, Promise<Key>>();

function importEd25519(publicKey: string): Promise<Key> {
  let key = imported.get(publicKey);
  if (!key) {
    if (imported.size > 1000) imported.clear();
    const raw = fromB64url(publicKey);
    if (raw.length !== 32) return Promise.reject(new Error("an Ed25519 public key is 32 bytes"));
    key = crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    imported.set(publicKey, key);
    key.catch(() => imported.delete(publicKey));
  }
  return key;
}

/** Pure Ed25519 (RFC 8032) over `data`. False for any malformed key or signature. */
export async function verifyEd25519(publicKey: string, data: Uint8Array, signature: string): Promise<boolean> {
  try {
    const sig = fromB64url(signature);
    if (sig.length !== 64) return false;
    return await crypto.subtle.verify({ name: "Ed25519" }, await importEd25519(publicKey), sig, data);
  } catch {
    return false;
  }
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export const randomToken = (n = 32): string => b64url(randomBytes(n));
export const uuid = (): string => crypto.randomUUID();

/** Compares two byte strings in time that depends only on their lengths. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

const encoder = new TextEncoder();

/** The DER prefix that makes a 32-byte Ed25519 seed a PKCS #8 private key. */
const PKCS8_ED25519_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

/**
 * An Ed25519 key that signs: an owner's key or an Obi's (identity.md section 1). It is its 32-byte
 * seed; `seed` is what to store, and whoever holds it holds the key.
 */
export class SigningKey {
  readonly publicKey: string;
  readonly keyId: string;
  readonly #key: Key;
  readonly #seed: Uint8Array;

  private constructor(key: Key, seed: Uint8Array, publicKey: string, keyId: string) {
    this.#key = key;
    this.#seed = seed;
    this.publicKey = publicKey;
    this.keyId = keyId;
  }

  /** The key whose seed is these 32 bytes. */
  static async fromSeed(seed: Uint8Array): Promise<SigningKey> {
    if (seed.length !== 32) throw new Error("an Ed25519 seed is 32 bytes");
    const der = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
    der.set(PKCS8_ED25519_PREFIX);
    der.set(seed, PKCS8_ED25519_PREFIX.length);
    const extractable = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, true, ["sign"]);
    // A JWK, whatever union the runtime's typings give exportKey.
    const jwk = (await crypto.subtle.exportKey("jwk", extractable)) as { x?: unknown };
    if (typeof jwk.x !== "string") throw new Error("the key has no public part");
    const key = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
    return new SigningKey(key, Uint8Array.from(seed), jwk.x, await keyIdOf(jwk.x));
  }

  /** A new key from 32 random bytes. */
  static generate(): Promise<SigningKey> {
    return SigningKey.fromSeed(randomBytes(32));
  }

  /** A key whose seed is SHA-256 of a string: the conformance suite's test keys. Anyone can derive it; never use one for anything but tests. */
  static async fromSeedString(seed: string): Promise<SigningKey> {
    return SigningKey.fromSeed(await sha256(encoder.encode(seed)));
  }

  /** The seed, base64url: what to keep, secret, to use this key again (`SigningKey.fromSeed(fromB64url(…))`). */
  get seed(): string {
    return b64url(this.#seed);
  }

  /** The Ed25519 signature over `data`, base64url without padding. */
  async sign(data: Uint8Array): Promise<string> {
    return b64url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, this.#key, data)));
  }

  toJSON(): { publicKey: string; keyId: string } {
    return { publicKey: this.publicKey, keyId: this.keyId };
  }
}
