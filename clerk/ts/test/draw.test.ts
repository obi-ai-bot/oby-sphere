// Runs every known-answer vector in clerk/vectors/draw.json, and checks the draw's two promises on random
// pools: it meets the diversity whenever some panel could, and a seat that declines never costs another seat
// its place.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { anchorId, beaconRandomness, beaconRound, canonicalize, draw, DrawError, pool, QUICKNET, sameJson, verifyBeacon, type Json } from "../src/index.ts";

type Case = { name: string; input: Json; output?: Json; error?: string };
const vectors = JSON.parse(readFileSync(new URL("../../vectors/draw.json", import.meta.url), "utf8")) as {
  beacon: { chain: string; public_key: string; genesis_time: number; period: number; round: number; signature: string; randomness: string };
  beacon_checks: { name: string; round: number; signature: string; valid: boolean }[];
  pool: Case[];
  draw: Case[];
  anchor: { name: string; pool_hash: string; to: string; id: string }[];
  round: { name: string; anchored_at: string; genesis_time: number; period: number; round: number }[];
};

function run(cases: Case[], f: (input: Json) => Json): string[] {
  const failures: string[] = [];
  for (const c of cases) {
    try {
      const out = f(c.input);
      if (c.error !== undefined || !sameJson(out, c.output)) failures.push(`${c.name}: got ${JSON.stringify(out)}`);
    } catch (e) {
      if (!(e instanceof DrawError)) throw e;
      if (e.code !== c.error) failures.push(`${c.name}: got error ${e.code}`);
    }
  }
  return failures;
}

test("pool vectors", () => assert.deepEqual(run(vectors.pool, pool), []));
test("draw vectors", () => assert.deepEqual(run(vectors.draw, draw), []));

test("anchor vectors", () => {
  for (const c of vectors.anchor) assert.equal(anchorId(c.pool_hash, c.to), c.id, c.name);
});

test("round vectors", () => {
  for (const c of vectors.round) assert.equal(beaconRound(c.anchored_at, c.genesis_time, c.period), c.round, c.name);
});

test("the beacon round's randomness is the SHA-256 of its signature", () => {
  assert.equal(beaconRandomness(vectors.beacon.signature), vectors.beacon.randomness);
});

test("beacon checks: a round's signature verifies with quicknet's public key", () => {
  const b = vectors.beacon;
  assert.deepEqual([b.chain, b.public_key, b.genesis_time, b.period], [QUICKNET.chain, QUICKNET.public_key, QUICKNET.genesis_time, QUICKNET.period]);
  for (const c of vectors.beacon_checks) assert.equal(verifyBeacon(c.round, c.signature), c.valid, c.name);
});

test("canonical JSON matches the spec's RFC 8785 vectors", () => {
  const jcs = JSON.parse(readFileSync(new URL("../../../spec/conformance/jcs-vectors.json", import.meta.url), "utf8")) as {
    vectors: { name: string; input: Json; canonical: string }[];
  };
  for (const v of jcs.vectors) assert.equal(canonicalize(v.input), v.canonical, v.name);
});

test("a pool the clerk builds is one the draw takes", () => {
  for (const c of vectors.pool) if (c.output !== undefined) assert.ok(draw({ pool: c.output, randomness: "ab".repeat(32) }), c.name);
});

// A small deterministic generator, so a failure here can be replayed.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function anyPanel(entries: { vendors: string[] }[], seats: number, need: number): boolean {
  const pick = (i: number, left: number, vendors: Set<string>): boolean => {
    if (left === 0) return vendors.size >= need;
    if (entries.length - i < left) return false;
    const v = entries[i].vendors.length === 1 ? [entries[i].vendors[0]] : [];
    return pick(i + 1, left - 1, new Set([...vendors, ...v])) || pick(i + 1, left, vendors);
  };
  return pick(0, seats, new Set());
}

test("random pools: the diversity is met whenever some panel meets it, and declines cost nobody else a seat", () => {
  const random = rng(45);
  let declineRuns = 0;
  const vendorsOf = [[], ["anthropic"], ["openai"], ["google"], ["xai"], ["anthropic", "openai"]];
  for (let round = 0; round < 800; round++) {
    const n = 1 + Math.floor(random() * 8);
    const entries = Array.from({ length: n }, (_, i) => ({ id: `obi-${i}`, owner: `owner-${i}`, vendors: vendorsOf[Math.floor(random() * vendorsOf.length)] }));
    const seats = 1 + Math.floor(random() * n);
    const need = Math.floor(random() * (seats + 1));
    const verifiers = Math.floor(random() * 3);
    const record = {
      draw: 1,
      sphere: "e2e",
      motion: "11".repeat(32),
      at: { seq: round, hash: "22".repeat(32) },
      request: "review_request",
      exclude: [],
      seats,
      verifiers,
      diversity: { owners: 0, vendors: need },
      entries,
    };
    const randomness = Buffer.from(Array.from({ length: 32 }, () => Math.floor(random() * 256))).toString("hex");
    type Out = { outcome: string; seats: string[]; verifiers: string[]; vendors: number };
    const out = draw({ pool: record, randomness }) as Out;
    const enough = entries.length >= seats + verifiers;
    assert.equal(out.outcome === "drawn", enough && anyPanel(entries, seats, need), `round ${round}`);
    if (out.outcome !== "drawn") continue;
    assert.ok(out.vendors >= need && out.seats.length === seats && out.verifiers.length === verifiers, `round ${round}`);
    // Seats and verifiers decline one after another, in a random order: no seat that hasn't declined ever
    // loses its place, whoever declines, as long as the draw can still be met.
    const declined: string[] = [];
    let before = out;
    for (const gone of [...out.seats, ...out.verifiers].sort(() => random() - 0.5)) {
      declined.push(gone);
      const again = draw({ pool: record, randomness, declined: [...declined] }) as Out;
      declineRuns++;
      if (again.outcome !== "drawn") break;
      for (const kept of before.seats) if (!declined.includes(kept)) assert.ok(again.seats.includes(kept), `round ${round}: ${gone} declined, ${kept} lost its seat`);
      before = again;
    }
  }
  assert.ok(declineRuns > 500, `only ${declineRuns} decline runs`);
});
