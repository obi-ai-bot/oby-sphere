// The Council draw (spec/council/draw.md): who is eligible, the anchor that fixes a pool in the chain, the
// beacon round that follows it, and the seats drawn by lot from the pool and the round's randomness.
//
// `pool` builds a pool record from the directory, `draw` draws from a pool record, `anchorId` gives the
// envelope id that fixes a pool hash in the chain, and `beaconRound` gives the round that follows an anchor.
// Everything is a function of its input: the known-answer vectors in clerk/vectors/draw.json pin it down, and
// the Rust crate in clerk/rust gives the same answers.

import { createHash } from "node:crypto";
import { bls12_381 } from "@noble/curves/bls12-381.js";
import type { Json } from "./index.ts";

export type DrawErrorCode = "bad_input" | "bad_version" | "bad_members" | "bad_pool" | "bad_panel" | "bad_declined";

export class DrawError extends Error {
  readonly code: DrawErrorCode;
  constructor(code: DrawErrorCode) {
    super(code);
    this.code = code;
  }
}

type Obj = { [key: string]: Json };
type Entry = { id: string; owner: string; vendors: string[] };

/** The protocol's allowed clock skew, in seconds: the round follows its anchor by more than this. */
export const CLOCK_SKEW_SECONDS = 300;

/** The version of the draw this code implements: the pool record's `draw` (draw.md section 2). */
export const DRAW_VERSION = 1;

const fail = (code: DrawErrorCode): never => {
  throw new DrawError(code);
};

const isObj = (v: Json | undefined): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: Json | undefined): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const isId = (v: Json | undefined): v is string => typeof v === "string" && v.length > 0;
const isIds = (v: Json | undefined): v is string[] => Array.isArray(v) && v.every(isId);
const isHex = (v: Json | undefined): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const exact = (o: Json | undefined, keys: string[], optional: string[] = []): o is Obj =>
  isObj(o) && keys.every((k) => has(o, k)) && Object.keys(o).every((k) => keys.includes(k) || optional.includes(k));

// Ids compare as their UTF-8 bytes, as in Rust: JavaScript's own string order is UTF-16's.
const utf8 = (s: string) => Buffer.from(s, "utf8");
const byBytes = (a: string, b: string) => Buffer.compare(utf8(a), utf8(b));
const ascending = (items: string[]) => items.every((x, i) => i === 0 || byBytes(items[i - 1], x) < 0);

const sha256 = (...parts: (string | Buffer)[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

/** RFC 8785 canonical JSON (protocol.md section 9), for the values the draw hashes: a bad_input error on a number that isn't an integer. */
export function canonicalize(value: Json): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("bad_input");
    return String(value === 0 ? 0 : value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  // JavaScript's default sort compares UTF-16 code units, which is RFC 8785's order for member names.
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
}

const TERMS = ["sphere", "motion", "at", "request", "exclude", "seats", "verifiers", "diversity"];

// The members a pool request and a pool record share (draw.md section 2).
function checkTerms(o: Obj): void {
  if (!isId(o.sphere) || !isHex(o.motion) || !isId(o.request)) fail("bad_input");
  if (!exact(o.at, ["seq", "hash"]) || !isInt(o.at.seq) || !isHex(o.at.hash)) fail("bad_input");
  if (!isIds(o.exclude) || !isInt(o.seats) || !isInt(o.verifiers)) fail("bad_input");
  if (!exact(o.diversity, ["owners", "vendors"]) || !isInt(o.diversity.owners) || !isInt(o.diversity.vendors)) fail("bad_input");
}

/** The pool record for a directory: every eligible member, one per owner (draw.md section 2). */
export function pool(input: Json): Obj {
  if (!exact(input, [...TERMS, "members"])) return fail("bad_input");
  checkTerms(input);
  if (!Array.isArray(input.members)) fail("bad_input");
  const members = input.members as Obj[];
  for (const m of members) {
    if (!exact(m, ["obi_id", "owner", "accepts"], ["vendors"])) fail("bad_input");
    if (!isId(m.obi_id) || !isId(m.owner) || !isIds(m.accepts)) fail("bad_input");
    if (has(m, "vendors") && !isIds(m.vendors)) fail("bad_input");
  }
  if (new Set(members.map((m) => m.obi_id)).size !== members.length) fail("bad_members");
  const exclude = input.exclude as string[];
  const best = new Map<string, Obj>();
  for (const m of members) {
    const owner = m.owner as string;
    if (!(m.accepts as string[]).includes(input.request as string) || exclude.includes(owner)) continue;
    const current = best.get(owner);
    if (current === undefined || byBytes(m.obi_id as string, current.obi_id as string) < 0) best.set(owner, m);
  }
  const entries = [...best.values()]
    .map((m) => ({ id: m.obi_id as string, owner: m.owner as string, vendors: [...new Set((m.vendors as string[] | undefined) ?? [])].sort(byBytes) }))
    .sort((a, b) => byBytes(a.id, b.id));
  const out: Obj = { draw: DRAW_VERSION };
  for (const k of TERMS) out[k] = input[k];
  out.exclude = [...new Set(exclude)].sort(byBytes);
  out.entries = entries;
  return out;
}

/** The pool hash: SHA-256 over "council pool\n" and the record's canonical JSON, as lower-case hex. */
export function poolHash(record: Json): string {
  return sha256("council pool\n", canonicalize(record)).toString("hex");
}

/** The id of an anchor envelope to `to` for a pool hash: a version 8 UUID from SHA-256 (draw.md section 3). */
export function anchorId(poolHashHex: string, to: string): string {
  if (!isHex(poolHashHex) || !isId(to)) fail("bad_input");
  const d = sha256("council anchor\n", Buffer.from(poolHashHex, "hex"), utf8(to)).subarray(0, 16);
  d[6] = (d[6] & 0x0f) | 0x80;
  d[8] = (d[8] & 0x3f) | 0x80;
  const h = d.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/** Seconds since 1970 for a protocol timestamp (protocol.md section 2), or a bad_input error. */
export function unixSeconds(timestamp: string): number {
  const m = TIMESTAMP.exec(timestamp);
  if (m === null) return fail("bad_input");
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  // Before 1970 is no time the protocol records (and Date.UTC would read years 0 to 99 as 1900 to 1999).
  if (y < 1970) fail("bad_input");
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) fail("bad_input");
  return t / 1000;
}

/** The first beacon round whose time is more than the clock skew after `anchoredAt` (draw.md section 4). */
export function beaconRound(anchoredAt: string, genesisTime: number, period: number): number {
  if (!isInt(genesisTime) || !isInt(period) || period < 1) fail("bad_input");
  const anchored = unixSeconds(anchoredAt);
  if (anchored < 0) fail("bad_input");
  const t = anchored + CLOCK_SKEW_SECONDS;
  if (t < genesisTime) return 1;
  return Math.floor((t - genesisTime) / period) + 2;
}

/** drand's quicknet, the beacon draw.md names (section 4, "The beacon"). */
export const QUICKNET = {
  chain: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  public_key:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  genesis_time: 1692803367,
  period: 3,
} as const;

// A signature is a G1 point in its 48-byte compressed form, and nothing else: another encoding of the same point
// would verify too and hash to another randomness (draw.md section 4).
const SIGNATURE = /^[0-9a-f]{96}$/;

// quicknet signs, on G1, the SHA-256 of the round number as 8 big-endian bytes (drand's unchained scheme,
// hashed to the curve as RFC 9380 says, with this domain separation tag).
const QUICKNET_DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";

/**
 * Whether `signatureHex` is quicknet's signature of `round`. The key is quicknet's own, never one from a record:
 * a check that took the key from its input would take a key anyone could sign with.
 */
export function verifyBeacon(round: number, signatureHex: string): boolean {
  if (!isInt(round) || round < 1 || !SIGNATURE.test(signatureHex)) return false;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(round));
  const short = bls12_381.shortSignatures;
  try {
    return short.verify(Buffer.from(signatureHex, "hex"), short.hash(sha256(message), QUICKNET_DST), Buffer.from(QUICKNET.public_key, "hex"));
  } catch {
    return false;
  }
}

/** A beacon round's randomness: SHA-256 of its signature (drand). `verifyBeacon` checks the signature. */
export function beaconRandomness(signatureHex: string): string {
  if (typeof signatureHex !== "string" || !SIGNATURE.test(signatureHex)) fail("bad_input");
  return sha256(Buffer.from(signatureHex, "hex")).toString("hex");
}

// The one vendor a seat counts for: its only declared vendor, else none (draw.md section 2, "Counted vendors").
const counted = (e: Entry): string | null => (e.vendors.length === 1 ? e.vendors[0] : null);

// Whether `slots` more seats from `rest` can bring the counted vendors to `need` (draw.md section 5).
function canMeet(taken: Set<string>, slots: number, rest: Entry[], need: number): boolean {
  const fresh = new Set(rest.map(counted).filter((v): v is string => v !== null && !taken.has(v)));
  return rest.length >= slots && taken.size + Math.min(slots, fresh.size) >= need;
}

/** Draws seats from a pool record and a beacon round's randomness (draw.md sections 4 to 7). */
export function draw(input: Json): Obj {
  if (!exact(input, ["pool", "randomness"], ["declined"])) return fail("bad_input");
  const rec = input.pool;
  if (!exact(rec, ["draw", ...TERMS, "entries"])) return fail("bad_input");
  checkTerms(rec);
  if (!isInt(rec.draw)) fail("bad_input");
  if (!isHex(input.randomness)) fail("bad_input");
  const declined = has(input, "declined") ? input.declined : [];
  if (!isIds(declined)) return fail("bad_input");
  if (!Array.isArray(rec.entries)) fail("bad_input");
  for (const e of rec.entries as Json[]) {
    if (!exact(e, ["id", "owner", "vendors"]) || !isId(e.id) || !isId(e.owner) || !isIds(e.vendors)) fail("bad_input");
  }
  const entries = rec.entries as Entry[];
  const exclude = rec.exclude as string[];
  if (rec.draw !== DRAW_VERSION) fail("bad_version");

  if (!ascending(entries.map((e) => e.id))) fail("bad_pool");
  if (new Set(entries.map((e) => e.owner)).size !== entries.length) fail("bad_pool");
  if (!entries.every((e) => ascending(e.vendors))) fail("bad_pool");
  if (!ascending(exclude) || entries.some((e) => exclude.includes(e.owner))) fail("bad_pool");

  const seats = rec.seats as number;
  const verifiers = rec.verifiers as number;
  const diversity = rec.diversity as { owners: number; vendors: number };
  if (seats < 1 || diversity.owners > seats || diversity.vendors > seats) fail("bad_panel");

  const ids = new Set(entries.map((e) => e.id));
  if (new Set(declined).size !== declined.length || declined.some((d) => !ids.has(d))) fail("bad_declined");

  const hash = poolHash(rec);
  const seed = sha256("council seed\n", Buffer.from(hash, "hex"), Buffer.from(input.randomness as string, "hex"));
  const keyed = entries
    .map((e) => ({ e, key: sha256("council order\n", seed, utf8(e.id)) }))
    .sort((a, b) => Buffer.compare(a.key, b.key) || byBytes(a.e.id, b.e.id))
    .map((x) => x.e);
  const out: Obj = { pool_hash: hash, seed: seed.toString("hex"), order: keyed.map((e) => e.id) };

  const available = keyed.filter((e) => !declined.includes(e.id));
  const need = diversity.vendors;
  if (available.length < seats + verifiers || !canMeet(new Set(), seats, available, need)) {
    return { ...out, outcome: "unmet", seats: [], verifiers: [], vendors: 0, skipped: [] };
  }

  const taken: string[] = [];
  const skipped: string[] = [];
  let vendors = new Set<string>();
  for (let i = 0; i < available.length && taken.length < seats; i++) {
    const e = available[i];
    const v = counted(e);
    const after = v === null ? vendors : new Set([...vendors, v]);
    if (canMeet(after, seats - taken.length - 1, available.slice(i + 1), need)) {
      taken.push(e.id);
      vendors = after;
    } else {
      skipped.push(e.id);
    }
  }
  const chosen = available.filter((e) => !taken.includes(e.id)).slice(0, verifiers).map((e) => e.id);
  return { ...out, outcome: "drawn", seats: taken, verifiers: chosen, vendors: vendors.size, skipped };
}
