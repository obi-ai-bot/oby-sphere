// Reference implementation of the Obi-to-Obi protocol v0.1 checks: canonical JSON (RFC 8785),
// Ed25519 keys and signatures, envelope, agent card and audit chain verification.
// It is what the conformance runner judges fixtures with, and it is meant to be read next to
// spec/protocol.md, spec/identity.md and spec/sphere-api.md. Node >= 22.18, node:crypto only, plus
// ajv. The rules over a parsed message (the action types, the exchange and follow-up rules, the
// rules no schema can say, which key is valid at a seq) are the client library's, client/src/rules.ts:
// the same code the server runs, so each rule has one implementation.

import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes, sign, verify } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import * as rules from "../../../client/src/rules.ts";
import { verifyA2aSend } from "./a2a.mjs";

export const PROTOCOL = rules.PROTOCOL;
export const ENVELOPE_SIGNING_PREFIX = rules.ENVELOPE_SIGNING_PREFIX;
export const AUDIT_HASH_PREFIX = "obi/0.1 audit\n";
export const CARD_EXTENSION_URI = "urn:obi-sphere:ext:obi:0.1";
export const MAX_ENVELOPE_BYTES = rules.MAX_ENVELOPE_BYTES;
export const MAX_LIFETIME_SECONDS = rules.MAX_LIFETIME_SECONDS;
export const CLOCK_SKEW_SECONDS = rules.CLOCK_SKEW_SECONDS;
export const ZERO_HASH = "0".repeat(64);
export const REQUEST_TYPES = [...rules.REQUEST_TYPES];
export const REPLY_TYPES = [...rules.REPLY_TYPES];
export const ACTION_TYPES = [...REQUEST_TYPES, ...REPLY_TYPES];
export const TERMINAL_TYPES = [...rules.TERMINAL_TYPES];
// The replies that belong only to a run_request's exchange (spec/protocol.md section 4, rule 7).
export const RUN_REPLY_TYPES = [...rules.RUN_REPLY_TYPES];
// What a share_offer's exchange takes, and nothing else (spec/protocol.md section 4, rule 8).
export const SHARE_REPLY_TYPES = [...rules.SHARE_REPLY_TYPES];
// The replies a request's own sender sends, to its receiver (spec/protocol.md section 4, rule 1).
export const SENDER_REPLY_TYPES = [...rules.SENDER_REPLY_TYPES];
// The requests a cancel calls off (spec/protocol.md section 4, rule 10).
export const CANCELLABLE_TYPES = [...rules.CANCELLABLE_TYPES];
export const SEVERITY_RANK = { ...rules.SEVERITY_RANK };

const here = dirname(fileURLToPath(import.meta.url));
export const SPEC_DIR = join(here, "..", "..");
export const SCHEMA_DIR = join(SPEC_DIR, "schemas", "v0.1");
export const SCHEMA_BASE = "https://github.com/obi-ai-bot/obi-sphere/raw/main/spec/schemas/v0.1/";

// ---------------------------------------------------------------------------------------------
// RFC 8785 JSON Canonicalization Scheme.
// Object keys are sorted by their UTF-16 code units (JavaScript's default string order), strings
// and numbers are serialized as ECMAScript's JSON.stringify does. The protocol only has integers,
// so number formatting never matters in practice; non-finite numbers are refused.

export function canonicalize(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JCS: non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (!value.isWellFormed()) throw new Error("JCS: string with a lone surrogate");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => {
      if (!k.isWellFormed()) throw new Error("JCS: key with a lone surrogate");
      return JSON.stringify(k) + ":" + canonicalize(value[k]);
    }).join(",") + "}";
  }
  throw new Error(`JCS: cannot canonicalize ${typeof value}`);
}

export const canonicalBytes = (value) => Buffer.from(canonicalize(value), "utf8");
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
export const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
export const fromB64url = (text) => Buffer.from(text, "base64url");

// ---------------------------------------------------------------------------------------------
// Reading JSON as the protocol does (protocol.md section 2): parseStrict refuses what JSON.parse
// lets through, two members with the same name, a string with a lone surrogate, and any number
// that is not an integer from 0 to 2^53 - 1; decodeUtf8Strict refuses bytes that aren't UTF-8 and a
// byte order mark. The same reader as the client library's (client/src/json.ts).

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

export function parseStrict(text) {
  let i = 0;
  const fail = (what) => {
    throw new Error(`${what} at offset ${i}`);
  };
  const skip = () => {
    while (i < text.length && WS.has(text.charCodeAt(i))) i++;
  };

  function string() {
    // text[i] is the opening quote.
    i++;
    let out = "";
    let start = i;
    for (;;) {
      if (i >= text.length) fail("unterminated string");
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        out += text.slice(start, i);
        i++;
        break;
      }
      if (c < 0x20) fail("control character in a string");
      if (c === 0x5c) {
        out += text.slice(start, i);
        const e = text[i + 1];
        switch (e) {
          case '"': out += '"'; break;
          case "\\": out += "\\"; break;
          case "/": out += "/"; break;
          case "b": out += "\b"; break;
          case "f": out += "\f"; break;
          case "n": out += "\n"; break;
          case "r": out += "\r"; break;
          case "t": out += "\t"; break;
          case "u": {
            const hex = text.slice(i + 2, i + 6);
            if (!/^[0-9A-Fa-f]{4}$/.test(hex)) fail("bad \\u escape");
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            break;
          }
          default:
            fail("bad escape");
        }
        i += 2;
        start = i;
        continue;
      }
      i++;
    }
    if (!out.isWellFormed()) fail("string with a lone surrogate");
    return out;
  }

  function number() {
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 400));
    if (!m) return fail("bad number");
    if (m[0].startsWith("-") || m[2] !== undefined || m[3] !== undefined) fail("only integers from 0 to 2^53 - 1 are allowed");
    const n = Number(m[0]);
    if (!Number.isSafeInteger(n)) fail("integer out of range");
    i += m[0].length;
    return n;
  }

  function value(depth) {
    if (depth > 64) fail("nested too deep");
    skip();
    const c = text[i];
    if (c === "{") {
      i++;
      const obj = {};
      const seen = new Set();
      skip();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        skip();
        if (text[i] !== '"') fail("expected a member name");
        const key = string();
        if (seen.has(key)) fail(`duplicate member name ${JSON.stringify(key).slice(0, 80)}`);
        seen.add(key);
        skip();
        if (text[i] !== ":") fail("expected ':'");
        i++;
        const v = value(depth + 1);
        Object.defineProperty(obj, key, { value: v, enumerable: true, writable: true, configurable: true });
        skip();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return obj;
        }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const arr = [];
      skip();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value(depth + 1));
        skip();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return arr;
        }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"') return string();
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return number();
    return fail("unexpected character");
  }

  const result = value(0);
  skip();
  if (i !== text.length) fail("trailing characters");
  return result;
}

/** UTF-8 bytes to text, refusing invalid UTF-8 and a byte order mark. */
export function decodeUtf8Strict(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error("a byte order mark is not allowed");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("not UTF-8");
  }
}


// ---------------------------------------------------------------------------------------------
// Keys. A conformance key is derived from a public seed string: seed = SHA-256(UTF-8(string)).
// Never use a derived key for anything but tests: anyone can derive it.

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function keyFromSeed(seed32) {
  if (seed32.length !== 32) throw new Error("Ed25519 seed must be 32 bytes");
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed32]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const raw = fromB64url(publicKey.export({ format: "jwk" }).x);
  return { privateKey, publicKey: b64url(raw), keyId: keyIdOf(b64url(raw)) };
}

export const keyFromSeedString = (seedString) => keyFromSeed(sha256(Buffer.from(seedString, "utf8")));

// ---------------------------------------------------------------------------------------------
// The job channel (protocol.md section 13): the hello's signature, the salt, the two keys, the
// nonces and a frame. The known-answer vectors in channel-vectors.json come from these.

export const CHANNEL_HELLO_PREFIX = "obi/0.1 channel\n";
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

/** An X25519 key from 32 private bytes: the key object and its raw public key. */
export function x25519FromPrivate(raw32) {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, raw32]), format: "der", type: "pkcs8" });
  return { privateKey, publicRaw: fromB64url(createPublicKey(privateKey).export({ format: "jwk" }).x) };
}

export const x25519Shared = (privateKey, peerRaw32) =>
  diffieHellman({ privateKey, publicKey: createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, peerRaw32]), format: "der", type: "spki" }) });

/** What a hello's signature covers: the prefix, then the canonical JSON of the hello without it. */
export function helloSigningInput(hello) {
  const { signature: _signature, ...rest } = hello;
  return Buffer.concat([Buffer.from(CHANNEL_HELLO_PREFIX, "utf8"), canonicalBytes(rest)]);
}

export const signHello = (unsigned, privateKey) => ({ ...unsigned, signature: signBytes(privateKey, helloSigningInput(unsigned)) });

/** salt = SHA-256(guest's hello bytes ‖ host's hello bytes); one 32-byte key each way. */
export function channelKeys(shared, guestHelloBytes, hostHelloBytes) {
  const salt = sha256(Buffer.concat([guestHelloBytes, hostHelloBytes]));
  const key = (info) => Buffer.from(hkdfSync("sha256", shared, salt, Buffer.from(info, "utf8"), 32));
  return { salt, guestToHost: key("obi/0.1 channel guest>host"), hostToGuest: key("obi/0.1 channel host>guest") };
}

/** 4 zero bytes, then the frame's number in its direction, big-endian 64-bit. */
export function channelNonce(counter) {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(counter), 4);
  return nonce;
}

/** A frame on the wire: ChaCha20-Poly1305 of (stream u32 BE, kind byte, payload), the tag after. */
export function sealFrame(key, counter, stream, kind, payload) {
  const plain = Buffer.alloc(5 + payload.length);
  plain.writeUInt32BE(stream, 0);
  plain[4] = kind;
  Buffer.from(payload).copy(plain, 5);
  const cipher = createCipheriv("chacha20-poly1305", key, channelNonce(counter), { authTagLength: 16 });
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

export function openFrame(key, counter, wire) {
  const decipher = createDecipheriv("chacha20-poly1305", key, channelNonce(counter), { authTagLength: 16 });
  decipher.setAuthTag(wire.subarray(wire.length - 16));
  const plain = Buffer.concat([decipher.update(wire.subarray(0, wire.length - 16)), decipher.final()]);
  return { stream: plain.readUInt32BE(0), kind: plain[4], payload: plain.subarray(5) };
}

// ---------------------------------------------------------------------------------------------
// Sealing the words (protocol.md section 9.1): every text value of a body, sealed for its
// recipient's seal key with a new X25519 key of the sender's, HKDF-SHA256 and ChaCha20-Poly1305.
// The known answers in seal-vectors.json come from these.

export const SEAL_SUITE = "x25519-hkdf-sha256-chacha20poly1305";
export const SEAL_INFO_PREFIX = "obi/0.1 seal\n";

/** `x25519:` + base64url of SHA-256 of the raw seal key. */
export const sealKeyIdOf = (publicRaw) => "x25519:" + b64url(sha256(publicRaw));

/** The envelope's key: HKDF-SHA256 of the X25519 secret, salted with enc ‖ the recipient's key. */
export function sealKey(shared, encRaw, recipientRaw, env) {
  const info = Buffer.concat([Buffer.from(SEAL_INFO_PREFIX, "utf8"), canonicalBytes({ sphere: env.sphere, id: env.id, from: env.from, to: env.to, type: env.type })]);
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([encRaw, recipientRaw]), info, 32));
}

/** A value's nonce: the first 12 bytes of SHA-256 of its JSON Pointer, unique in its envelope. */
export const sealNonce = (pointer) => sha256(Buffer.from(pointer, "utf8")).subarray(0, 12);

export function sealValue(key, pointer, text) {
  const cipher = createCipheriv("chacha20-poly1305", key, sealNonce(pointer), { authTagLength: 16 });
  cipher.setAAD(Buffer.from(pointer, "utf8"));
  return Buffer.concat([cipher.update(Buffer.from(text, "utf8")), cipher.final(), cipher.getAuthTag()]);
}

/** The text, or an exception when it doesn't open (changed, moved, another key) or isn't UTF-8. */
export function openValue(key, pointer, sealed) {
  if (sealed.length < 16) throw new Error("shorter than its tag");
  const decipher = createDecipheriv("chacha20-poly1305", key, sealNonce(pointer), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(pointer, "utf8"));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(plain);
}

const unescapeToken = (t) => t.replaceAll("~1", "/").replaceAll("~0", "~");
const escapeToken = (t) => t.replaceAll("~", "~0").replaceAll("/", "~1");

/** The plain schemas as JSON, by name: what the sealed ones and the text paths derive from. */
export function plainSchemaDocs() {
  return Object.fromEntries(schemaFiles()
    .map((path) => [relative(SCHEMA_DIR, path).replace(/\.schema\.json$/, ""), path])
    .filter(([name]) => !name.startsWith("sealed/"))
    .map(([name, path]) => [name, JSON.parse(readFileSync(path, "utf8"))]));
}

/**
 * Each action type's text paths: where its schema says `x-obi-text: "data"`, as JSON Pointers into
 * its body with `*` for every item of an array. schemas/v0.1/sealed/text-paths.json is this.
 */
export function deriveTextPaths(docs = plainSchemaDocs()) {
  const byId = Object.fromEntries(Object.values(docs).map((d) => [d.$id, d]));
  const resolve = (base, ref) => {
    const [file, fragment = ""] = ref.split("#");
    const doc = byId[new URL(file || base, base).href];
    let node = doc;
    for (const t of fragment.split("/").slice(1)) node = node[unescapeToken(t)];
    return [node, doc.$id];
  };
  const out = {};
  for (const type of ACTION_TYPES) {
    const paths = new Set();
    const walk = (node, base, path) => {
      if (!node || typeof node !== "object") return;
      if (node["x-obi-text"] === "data") return void paths.add("/" + path.map(escapeToken).join("/"));
      if (typeof node.$ref === "string") walk(...resolve(base, node.$ref), path);
      for (const k of ["allOf", "anyOf", "oneOf"]) for (const n of node[k] ?? []) walk(n, base, path);
      for (const k of ["if", "then", "else"]) walk(node[k], base, path);
      for (const [name, n] of Object.entries(node.properties ?? {})) walk(n, base, [...path, name]);
      walk(node.items, base, [...path, "*"]);
    };
    const schema = docs[`actions/${type}`];
    walk(schema, schema.$id, []);
    out[type] = [...paths].sort();
  }
  return out;
}

let textPathsLoaded;
export const textPaths = () => (textPathsLoaded ??= deriveTextPaths());

/** Every text value in an action's body: its pointer and where it is, in the body's own order. */
export function textValues(type, body) {
  const patterns = (textPaths()[type] ?? []).map((p) => p.split("/").slice(1).map(unescapeToken));
  const out = [];
  const walk = (value, tokens, parent, key) => {
    if (typeof value === "string") {
      const hit = patterns.some((p) => p.length === tokens.length && p.every((t, i) => t === tokens[i] || (t === "*" && /^(0|[1-9][0-9]*)$/.test(tokens[i]))));
      if (hit) out.push({ pointer: "/" + tokens.map(escapeToken).join("/"), parent, key });
    } else if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...tokens, String(i)], value, i));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, [...tokens, k], value, k);
  };
  walk(body, [], null, null);
  return out;
}

/** The unsigned envelope with its words sealed for `recipientRaw` (32 bytes), and its `seal`. */
export function sealEnvelope(unsigned, recipientRaw, ephemeralRaw = randomBytes(32)) {
  const e = x25519FromPrivate(ephemeralRaw);
  const key = sealKey(x25519Shared(e.privateKey, recipientRaw), e.publicRaw, recipientRaw, unsigned);
  const body = structuredClone(unsigned.body);
  for (const { pointer, parent, key: k } of textValues(unsigned.type, body)) parent[k] = b64url(sealValue(key, pointer, parent[k]));
  return { ...unsigned, body, seal: { suite: SEAL_SUITE, key_id: sealKeyIdOf(recipientRaw), enc: b64url(e.publicRaw) } };
}

/** A sealed envelope's body with its words opened, for the holder of `privateRaw`; throws when one doesn't open. */
export function openBody(env, privateRaw) {
  const own = x25519FromPrivate(privateRaw);
  const shared = x25519Shared(own.privateKey, fromB64url(env.seal.enc));
  if (shared.every((b) => b === 0)) throw new Error("an all-zero X25519 secret");
  const key = sealKey(shared, fromB64url(env.seal.enc), own.publicRaw, env);
  const body = structuredClone(env.body);
  for (const { pointer, parent, key: k } of textValues(env.type, body)) parent[k] = openValue(key, pointer, fromB64url(parent[k]));
  return body;
}

/** The sealed schemas: every envelope and body schema, its text fields sealed_text (protocol.md section 9.1). */
export function deriveSealedSchemas(docs = plainSchemaDocs()) {
  // A text value's bytes are at most 4 per character; sealed, 16 more; base64url, 4 per 3.
  const minSealed = (n) => Math.ceil(((n ?? 0) + 16) * 4 / 3);
  const maxSealed = (n) => Math.ceil((4 * n + 16) * 4 / 3);
  const seal = (node) => {
    if (Array.isArray(node)) return node.map(seal);
    if (!node || typeof node !== "object") return node;
    if (node["x-obi-text"] === "data") {
      return {
        $ref: node.$ref.replace(/(line|block)_text$/, "sealed_text"), "x-obi-text": "sealed",
        minLength: minSealed(node.minLength), maxLength: maxSealed(node.maxLength),
        ...(node.description ? { description: node.description } : {}),
      };
    }
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, k === "enum" || k === "const" ? v : seal(v)]));
  };
  const out = {};
  for (const [name, doc] of Object.entries(docs)) {
    if (!(name === "common" || name === "envelope" || name.startsWith("actions/"))) continue;
    const sealed = seal(doc);
    sealed.$id = doc.$id.replace("/schemas/v0.1/", "/schemas/v0.1/sealed/");
    sealed.title = `${doc.title ?? name} (sealed)`;
    sealed.description = `${doc.description ? doc.description + " " : ""}Sealed: derived from ${name}.schema.json by spec/conformance/generate.mjs, every x-obi-text field a sealed_text (spec/protocol.md section 9.1). Don't edit it by hand.`;
    if (name === "envelope") {
      sealed.required = [...sealed.required, "seal"];
      sealed.properties = { ...sealed.properties, seal: { $ref: "common.schema.json#/$defs/seal", description: "How the words are sealed: for the recipient's seal key." } };
    }
    out[name] = sealed;
  }
  return out;
}

export function keyIdOf(publicKeyB64url) {
  const raw = fromB64url(publicKeyB64url);
  if (raw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return "ed25519:" + b64url(sha256(raw));
}

export function publicKeyObject(publicKeyB64url) {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKeyB64url }, format: "jwk" });
}

export const signBytes = (privateKey, bytes) => b64url(sign(null, bytes, privateKey));

export function verifyBytes(publicKeyB64url, bytes, signatureB64url) {
  try {
    const sig = fromB64url(signatureB64url);
    if (sig.length !== 64) return false;
    return verify(null, bytes, publicKeyObject(publicKeyB64url), sig);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Envelope signing: Ed25519 over UTF-8("obi/0.1 envelope\n") followed by the JCS form of the
// envelope without its `signature` member.

export function envelopeSigningInput(envelope) {
  const { signature, ...unsigned } = envelope;
  return Buffer.concat([Buffer.from(ENVELOPE_SIGNING_PREFIX, "utf8"), canonicalBytes(unsigned)]);
}

export function signEnvelope(unsigned, privateKey) {
  const { signature, ...rest } = unsigned;
  return { ...rest, signature: signBytes(privateKey, envelopeSigningInput(rest)) };
}

// ---------------------------------------------------------------------------------------------
// JWS (RFC 7515) with EdDSA (RFC 8037): owner and Obi assertions (compact JWT) and the agent
// card's detached signature (A2A AgentCardSignature).

export const jwsHeader = (kid, typ) => b64url(canonicalBytes({ alg: "EdDSA", kid, typ }));

export function signJwt(claims, privateKey, kid) {
  const head = jwsHeader(kid, "JWT");
  const body = b64url(canonicalBytes(claims));
  return `${head}.${body}.${signBytes(privateKey, Buffer.from(`${head}.${body}`, "ascii"))}`;
}

export function cardSigningInput(card, protectedHeader) {
  const { signatures, ...unsigned } = card;
  return Buffer.from(`${protectedHeader}.${b64url(canonicalBytes(unsigned))}`, "ascii");
}

export function signCard(unsignedCard, ownerPrivateKey, ownerKeyId) {
  const { signatures, ...rest } = unsignedCard;
  const protectedHeader = jwsHeader(ownerKeyId, "JOSE");
  return { ...rest, signatures: [{ protected: protectedHeader, signature: signBytes(ownerPrivateKey, cardSigningInput(rest, protectedHeader)) }] };
}

// ---------------------------------------------------------------------------------------------
// Findings: the recommended stable id (spec/protocol.md, "Findings").

export function findingId(file, line, title) {
  return "f-" + sha256(Buffer.from(`${file}\n${line}\n${title}`, "utf8")).toString("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------------------------
// Schemas.

function schemaFiles(dir = SCHEMA_DIR) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? schemaFiles(path) : name.endsWith(".schema.json") ? [path] : [];
  });
}

export function loadSchemas() {
  const ajv = new Ajv2020({ strict: true, strictTypes: false, strictRequired: false, allErrors: true, validateFormats: false });
  // The annotation keyword the spec defines: the string is data written by someone else.
  ajv.addKeyword({ keyword: "x-obi-text", metaSchema: { enum: ["data", "sealed"] } });
  const schemas = {};
  for (const path of schemaFiles()) {
    const schema = JSON.parse(readFileSync(path, "utf8"));
    const name = relative(SCHEMA_DIR, path).replace(/\.schema\.json$/, "");
    if (schema.$id !== SCHEMA_BASE + relative(SCHEMA_DIR, path)) throw new Error(`${name}: $id does not match its path`);
    schemas[name] = schema;
    ajv.addSchema(schema);
  }
  const validators = {};
  for (const [name, schema] of Object.entries(schemas)) validators[name] = ajv.getSchema(schema.$id);
  return { ajv, schemas, validators };
}

let loaded;
export const schemas = () => (loaded ??= loadSchemas());

export function schemaErrors(name, value) {
  const validate = schemas().validators[name];
  if (!validate) throw new Error(`no schema ${name}`);
  return validate(value) ? [] : validate.errors.map((e) => `${e.instancePath || "/"} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ""}`);
}

// ---------------------------------------------------------------------------------------------
// Envelope verification (spec/protocol.md, "Verifying a message").

const seconds = (timestamp) => Date.parse(timestamp) / 1000;
const fail = (code, message) => ({ ok: false, code, message });
const OK = { ok: true };

// The rules no schema can say (protocol.md section 10, check 3), the references' and a result's
// own rules, which key is valid at a seq, and the exchange and follow-up rules (section 4): the
// client library's (client/src/rules.ts), the same code the server runs.
export const semanticProblems = (env) => rules.semanticProblems(env);

export const refProblems = (body) => rules.refProblems(body);

export const resultProblems = (body) => rules.resultProblems(body);

export const keyValidAt = (key, seq) => rules.keyValidAt(key, seq);

export function verifyEnvelope(env, ctx) {
  let size;
  try {
    size = canonicalBytes(env).length;
  } catch (e) {
    return fail("invalid_envelope", e.message);
  }
  if (size > MAX_ENVELOPE_BYTES) return fail("payload_too_large", `${size} bytes canonical, the most is ${MAX_ENVELOPE_BYTES}`);
  const errors = schemaErrors(env?.seal === undefined ? "envelope" : "sealed/envelope", env);
  if (errors.length) return fail("invalid_envelope", errors.slice(0, 5).join("; "));
  const problems = semanticProblems(env);
  if (problems.length) return fail("invalid_envelope", problems.join("; "));
  if (env.sphere !== ctx.sphere) return fail("wrong_sphere", `for ${env.sphere}, not ${ctx.sphere}`);
  if (typeof ctx.receiver !== "string") return fail("wrong_recipient", "the context names no receiver");
  if (env.to !== ctx.receiver) return fail("wrong_recipient", `addressed to ${env.to}, not ${ctx.receiver}`);
  const key = ctx.keys?.[env.key_id];
  if (!key || key.obi !== env.from) return fail("unknown_key", `${env.key_id} is not a key of ${env.from}`);
  if (keyIdOf(key.public_key) !== env.key_id) return fail("unknown_key", "the directory's key does not hash to key_id");
  if (!keyValidAt(key, ctx.seq)) return fail("unknown_key", ctx.seq === undefined ? `${env.key_id} is not ${env.from}'s current key` : `${env.key_id} was not valid at seq ${ctx.seq}`);
  if (!verifyBytes(key.public_key, envelopeSigningInput(env), env.signature)) return fail("bad_signature", "the signature does not verify");
  const now = seconds(ctx.now);
  if (!(seconds(env.expires_at) > now)) return fail("expired", `expired at ${env.expires_at}`);
  if (seconds(env.created_at) > now + CLOCK_SKEW_SECONDS) return fail("clock_skew", `created_at is more than ${CLOCK_SKEW_SECONDS} seconds ahead`);
  if ((ctx.seen_ids ?? []).includes(env.id)) return fail("duplicate", `${env.id} was seen before`);
  return openedProblem(env, ctx) ?? OK;
}

// Check 11 (protocol.md section 9.1), after the signature: a sealed message opens with one of the
// receiver's own seal keys (ctx.seal_keys: {key_id: base64url of the 32 private bytes}) to a body
// that passes the plain schema and check 3; one in the clear is refused when both seal
// (ctx.sender_seals: the sender's trusted card has a seal key).
export function openedProblem(env, ctx) {
  const own = ctx.seal_keys ?? {};
  if (env.seal === undefined) {
    return Object.keys(own).length && ctx.sender_seals ? fail("not_sealed", `${env.from} and ${ctx.receiver} both seal: its words must be sealed`) : null;
  }
  const mine = own[env.seal.key_id];
  if (!mine) return fail("seal_invalid", `sealed for ${env.seal.key_id}, not a seal key of ${ctx.receiver}`);
  let body;
  try {
    body = openBody(env, fromB64url(mine));
  } catch {
    return fail("seal_invalid", "a sealed value doesn't open");
  }
  const { seal: _seal, ...opened } = { ...env, body };
  const errors = schemaErrors("envelope", opened);
  if (errors.length) return fail("seal_invalid", `opened, it doesn't match the schema: ${errors.slice(0, 5).join("; ")}`);
  const problems = semanticProblems(opened);
  return problems.length ? fail("seal_invalid", `opened: ${problems.join("; ")}`) : null;
}

// ---------------------------------------------------------------------------------------------
// Agent card verification (spec/identity.md, "Verifying a card").
// ctx: { now, bound_owner_key?: <public key the Sphere bound for this owner> }

export function verifyCard(card, ctx) {
  const errors = schemaErrors("agent-card", card);
  if (errors.length) return fail("card_invalid", errors.slice(0, 5).join("; "));
  const params = card.capabilities.extensions[0].params;
  if (keyIdOf(params.public_key) !== params.key_id) return fail("card_invalid", "key_id does not match public_key");
  if (params.seal_public_key !== undefined && sealKeyIdOf(fromB64url(params.seal_public_key)) !== params.seal_key_id) return fail("card_invalid", "seal_key_id does not match seal_public_key");
  if (params.owner_key === params.public_key) return fail("card_invalid", "the Obi's key must not be its owner's key");
  const skills = card.skills.map((s) => s.id).sort().join(",");
  if (skills !== [...params.accepts].sort().join(",")) return fail("card_invalid", "skills and accepts differ");
  const urlTail = `/v0.1/spheres/${params.sphere}/members/${params.obi_id}`;
  if (!card.url.endsWith(urlTail)) return fail("card_invalid", `url must end with ${urlTail}`);
  if (ctx.bound_owner_key && ctx.bound_owner_key !== params.owner_key) return fail("card_invalid", "signed by another key than the owner's bound key");
  const sig = card.signatures[0];
  let header;
  try {
    header = parseStrict(decodeUtf8Strict(fromB64url(sig.protected)));
  } catch {
    return fail("card_invalid", "the protected header is not JSON");
  }
  const headerErrors = schemaErrors("wire/jws-header", header);
  if (headerErrors.length || header.typ !== "JOSE") return fail("card_invalid", "the protected header must be {alg: EdDSA, kid, typ: JOSE}");
  if (header.kid !== keyIdOf(params.owner_key)) return fail("card_invalid", "kid is not the owner key's id");
  if (!verifyBytes(params.owner_key, cardSigningInput(card, sig.protected), sig.signature)) return fail("bad_signature", "the owner's signature does not verify");
  if (ctx.now && seconds(params.issued_at) > seconds(ctx.now) + CLOCK_SKEW_SECONDS) return fail("card_invalid", "issued in the future");
  return OK;
}

// ---------------------------------------------------------------------------------------------
// Audit chain (spec/sphere-api.md, "Audit chain").

export function entryHash(entry) {
  const { hash, ...rest } = entry;
  return sha256(Buffer.concat([Buffer.from(AUDIT_HASH_PREFIX, "utf8"), canonicalBytes(rest)])).toString("hex");
}

export function appendEntry(entries, sphere, envelope, recordedAt) {
  const prev = entries.length ? entries[entries.length - 1].hash : ZERO_HASH;
  const entry = { sphere, seq: entries.length + 1, prev, recorded_at: recordedAt, envelope };
  return [...entries, { ...entry, hash: entryHash(entry) }];
}

// reply: the reply envelope; request: the envelope its in_reply_to names, or undefined; earlier: the
// replies to that request that came before it, in order. Why the reply breaks the rules, or null.
const withBody = (e) => ({ ...e, body: e.body ?? {} });
export const exchangeProblem = (reply, request, earlier) =>
  rules.exchangeProblem(rules.exchangeMessage(withBody(reply)), request && rules.exchangeMessage(withBody(request)), earlier.map((e) => rules.exchangeMessage(withBody(e))));

export const followUpProblem = (request, earlier) => rules.followUpProblem(withBody(request), earlier);

// chain: { sphere, entries }, ctx: { keys: { [key_id]: { obi, public_key, valid_from_seq, valid_until_seq } } }
export function verifyChain(chain, ctx) {
  if (!chain || typeof chain.sphere !== "string" || !Array.isArray(chain.entries)) return fail("bad_request", "a chain is {sphere, entries}");
  let prev = ZERO_HASH;
  let lastTime = -Infinity;
  const byId = new Map();
  for (const [i, entry] of chain.entries.entries()) {
    const at = `entry ${i + 1}`;
    const errors = schemaErrors("audit-entry", entry);
    if (errors.length) return fail("invalid_envelope", `${at}: ${errors.slice(0, 3).join("; ")}`);
    if (entry.seq !== i + 1) return fail("conflict", `${at}: seq is ${entry.seq}`);
    if (entry.sphere !== chain.sphere) return fail("wrong_sphere", `${at}: sphere ${entry.sphere}`);
    if (entry.prev !== prev) return fail("conflict", `${at}: prev does not link to the entry before`);
    if (entryHash(entry) !== entry.hash) return fail("conflict", `${at}: hash does not match its content`);
    const time = seconds(entry.recorded_at);
    if (time < lastTime) return fail("conflict", `${at}: recorded_at goes back in time`);
    lastTime = time;
    const env = entry.envelope;
    const problems = semanticProblems(env);
    if (problems.length) return fail("invalid_envelope", `${at}: ${problems.join("; ")}`);
    if (env.sphere !== chain.sphere) return fail("wrong_sphere", `${at}: envelope for ${env.sphere}`);
    if (seconds(env.created_at) > time + CLOCK_SKEW_SECONDS) return fail("clock_skew", `${at}: created after it was recorded`);
    if (!(seconds(env.expires_at) > time)) return fail("expired", `${at}: recorded after it expired`);
    const key = ctx.keys?.[env.key_id];
    if (!key || key.obi !== env.from || keyIdOf(key.public_key) !== env.key_id) return fail("unknown_key", `${at}: ${env.key_id} is not a key of ${env.from}`);
    if (!keyValidAt(key, entry.seq)) return fail("unknown_key", `${at}: ${env.key_id} was not valid at seq ${entry.seq}`);
    if (!verifyBytes(key.public_key, envelopeSigningInput(env), env.signature)) return fail("bad_signature", `${at}: the sender's signature does not verify`);
    if (byId.has(env.id)) return fail("duplicate", `${at}: ${env.id} is in the chain twice`);
    if (REPLY_TYPES.includes(env.type)) {
      const problem = exchangeProblem(env, byId.get(env.in_reply_to), [...byId.values()].filter((e) => REPLY_TYPES.includes(e.type) && e.in_reply_to === env.in_reply_to));
      if (problem) return fail("bad_reply", `${at}: ${problem}`);
    }
    const followUp = REQUEST_TYPES.includes(env.type) ? followUpProblem(env, byId.get(env.body.follows)) : null;
    if (followUp) return fail("bad_reply", `${at}: ${followUp}`);
    byId.set(env.id, env);
    prev = entry.hash;
  }
  return OK;
}

// ---------------------------------------------------------------------------------------------
// One conformance case, as the runner hands it to an implementation on stdin.

/** A wire document (sphere-api.md) judged by the wire schema `context.schema` names, and nothing else. */
export function verifyWire(input, context) {
  const name = context?.schema;
  if (typeof name !== "string" || !/^wire\/[a-z-]+(\.[a-z]+)?$/.test(name) || !schemas().validators[name]) return fail("bad_request", `no wire schema ${name}`);
  const errors = schemaErrors(name, input);
  return errors.length ? fail("bad_request", errors.join("; ")) : OK;
}

// ---- Approving on the code host (protocol.md section 11, "Approving on the code host")

// How long an owner's confirmation of one exchange stays fresh: signed at most this long before
// the receiver checks it, and at most CONFIRMATION_AHEAD after (the device's clock running ahead).
export const CONFIRMATION_FRESH = 120;
export const CONFIRMATION_AHEAD = 30;

// What every review an Oby posts on the code host carries, matched without regard to case: a
// review whose body has it is an Oby's, whoever's account posted it.
export const OBI_REVIEW_MARKER = "by oby:";

// The code host's access levels that let an approval count: write or more.
export const WRITE_ACCESS = ["admin", "maintain", "write"];

// A CODEOWNERS pattern as a matcher of repository paths ("Who counts as a code owner"): `*` any
// characters but `/`, `**` any characters, `?` one character but `/`; anchored when it starts with
// `/` or has a `/` before its end; a trailing `/` covers everything under the directory; any other
// pattern also covers everything under a directory it names, unless its last part is exactly `*`.
export function codeownersPattern(pattern) {
  const dirOnly = pattern.endsWith("/");
  let body = dirOnly ? pattern.slice(0, -1) : pattern;
  const anchored = body.startsWith("/") || body.includes("/");
  if (body.startsWith("/")) body = body.slice(1);
  let re = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "*" && body[i + 1] === "*") {
      if (body[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  const last = body.split("/").pop();
  const tail = dirOnly ? "/.*" : last === "*" ? "" : "(?:/.*)?";
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${re}${tail}$`, "s");
}

// The rules of a CODEOWNERS file, in order: [{match, owners}], or null when it can't be read.
export function parseCodeowners(text) {
  if (typeof text !== "string") return null;
  const rules = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const words = line.split(/\s+/);
    const pattern = words[0];
    if (/[!\[\]\\]/.test(pattern)) return null;
    const owners = [];
    for (const w of words.slice(1)) {
      if (w.startsWith("#")) break;
      owners.push(w);
    }
    rules.push({ match: codeownersPattern(pattern), owners });
  }
  return rules;
}

// The owners of `path`: the last matching rule's.
export function ownersOf(rules, path) {
  let owners = [];
  for (const rule of rules) if (rule.match.test(path)) owners = rule.owners;
  return owners;
}

// Whether a review is a person's: not an account the code host marks as a bot, and no Oby's marker.
export const byAPerson = (review) =>
  review?.account_type !== "Bot" && !String(review?.body ?? "").toLowerCase().includes(OBI_REVIEW_MARKER);

// The logins (lower case) whose approval of `head` counts: each person's last approving,
// changes-requesting or dismissed review decides; only a person's, with write access or more
// (`permissions`), and never the receiver's own owner's.
export function countingApprovers(reviews, head, ownLogin, permissions) {
  const last = new Map();
  for (const r of reviews ?? []) {
    if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r?.state) || typeof r.login !== "string") continue;
    last.set(r.login.toLowerCase(), r);
  }
  const own = (ownLogin ?? "").toLowerCase();
  const access = (login) => Object.entries(permissions ?? {}).find(([l]) => l.toLowerCase() === login)?.[1];
  return [...last.entries()]
    .filter(([login, r]) => r.state === "APPROVED" && r.commit_id === head && byAPerson(r) && login !== own && WRITE_ACCESS.includes(access(login)))
    .map(([login]) => login);
}

// Whether `owner` (`@login` or `@org/team`) names `login`: a team only of the repository's own
// organization (`org`), with `login` among its members.
const isOwner = (owner, login, teams, org) => {
  if (!owner.startsWith("@")) return false;
  const name = owner.slice(1).toLowerCase();
  if (!name.includes("/")) return name === login;
  if (name.split("/")[0] !== org) return false;
  const team = Object.entries(teams ?? {}).find(([t]) => t.toLowerCase() === name);
  return !!team && team[1].some((m) => typeof m === "string" && m.toLowerCase() === login);
};

// Whether people who between them own every changed file of `repo` approved `head`.
export function codeOwnerApproved(host, repo, head, ownLogin) {
  const rules = parseCodeowners(host?.codeowners);
  if (!rules) return false;
  const files = host.changed_files ?? [];
  if (!files.length || host.files_complete !== true) return false;
  const org = String(repo ?? "").split("/")[0].toLowerCase();
  const approvers = countingApprovers(host.reviews, head, ownLogin, host.permissions);
  return files.every((file) => {
    const owners = ownersOf(rules, file);
    return owners.length > 0 && approvers.some((login) => owners.some((o) => isOwner(o, login, host.teams, org)));
  });
}

// A `host_approval` case: whether the receiver may post its approving review now. `context` is
// {now, request: {correlation_id, repo, head_sha, expires_at}, member, owner_login,
// standing_permission}; `input` is {owner_confirmations: [{correlation_id, head_sha, signed_at,
// from_owner_device, used_before}], code_host: {codeowners, changed_files, files_complete,
// reviews: [{login, account_type, body, state, commit_id}], teams, permissions}}.
export function verifyHostApproval(input, context) {
  const now = seconds(context?.now);
  const request = context?.request ?? {};
  if (!(now < seconds(request.expires_at)) || context?.member !== true) {
    return fail("lapsed", "the request expired, or the receiver is no longer an active member of its Sphere");
  }
  const confirmed = (input?.owner_confirmations ?? []).some((c) =>
    c?.from_owner_device === true &&
    c.used_before === false &&
    c.correlation_id === request.correlation_id &&
    c.head_sha === request.head_sha &&
    now - seconds(c.signed_at) <= CONFIRMATION_FRESH &&
    seconds(c.signed_at) - now <= CONFIRMATION_AHEAD);
  if (confirmed) return { ok: true };
  if (context?.standing_permission !== true) {
    return fail("no_owner_confirmation", "its owner didn't confirm this exchange at this commit on their own device");
  }
  if (!codeOwnerApproved(input?.code_host, request.repo, request.head_sha, context?.owner_login)) {
    return fail("no_code_owner_approval", "no person who owns every changed file approved this commit");
  }
  return { ok: true };
}

export function judge(testCase) {
  switch (testCase.case) {
    case "envelope":
      return verifyEnvelope(testCase.input, testCase.context);
    case "card":
      return verifyCard(testCase.input, testCase.context);
    case "audit":
      return verifyChain(testCase.input, testCase.context);
    case "wire":
      return verifyWire(testCase.input, testCase.context);
    case "host_approval":
      return verifyHostApproval(testCase.input, testCase.context);
    case "a2a":
      return verifyA2aSend(testCase.input, testCase.context);
    default:
      return fail("bad_request", `unknown case kind ${testCase.case}`);
  }
}
