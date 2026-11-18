// JSON as the protocol reads and writes it (spec/protocol.md section 2).
//
// parseStrict reads RFC 8259 JSON and refuses what JSON.parse lets through: two members with the
// same name, a string with a lone surrogate, and any number that is not an integer from 0 to
// 2^53 - 1 (the protocol has no other numbers). canonicalize writes RFC 8785 (JCS).

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export class JsonError extends Error {}

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

export function parseStrict(text: string): Json {
  let i = 0;
  const fail = (what: string): never => {
    throw new JsonError(`${what} at offset ${i}`);
  };
  const skip = () => {
    while (i < text.length && WS.has(text.charCodeAt(i))) i++;
  };

  function string(): string {
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

  function number(): number {
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 400));
    if (!m) return fail("bad number");
    if (m[0].startsWith("-") || m[2] !== undefined || m[3] !== undefined) fail("only integers from 0 to 2^53 - 1 are allowed");
    const n = Number(m[0]);
    if (!Number.isSafeInteger(n)) fail("integer out of range");
    i += m[0].length;
    return n;
  }

  function value(depth: number): Json {
    if (depth > 64) fail("nested too deep");
    skip();
    const c = text[i];
    if (c === "{") {
      i++;
      const obj: JsonObject = {};
      const seen = new Set<string>();
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
      const arr: Json[] = [];
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
export function decodeUtf8Strict(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new JsonError("a byte order mark is not allowed");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new JsonError("not UTF-8");
  }
}

/** RFC 8785: members sorted by UTF-16 code units, no whitespace, ECMAScript string escaping. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new JsonError("JCS: non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (!value.isWellFormed()) throw new JsonError("JCS: string with a lone surrogate");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      "{" +
      keys
        .map((k) => {
          if (!k.isWellFormed()) throw new JsonError("JCS: key with a lone surrogate");
          return JSON.stringify(k) + ":" + canonicalize(obj[k]);
        })
        .join(",") +
      "}"
    );
  }
  throw new JsonError(`JCS: cannot canonicalize ${typeof value}`);
}

const encoder = new TextEncoder();
export const utf8 = (text: string): Uint8Array => encoder.encode(text);
export const canonicalBytes = (value: unknown): Uint8Array => utf8(canonicalize(value));

export const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
