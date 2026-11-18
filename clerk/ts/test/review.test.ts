// Runs every known-answer vector in clerk/vectors/review.json, and counts each tally with the clerk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { count, reviewTally, sameJson, TallyError, type Json } from "../src/index.ts";

type Case = { name: string; input: Json; output?: Json; error?: string };
const vectors = JSON.parse(readFileSync(new URL("../../vectors/review.json", import.meta.url), "utf8")) as { tally: Case[] };

test("tally vectors", () => {
  const failures: string[] = [];
  for (const c of vectors.tally) {
    try {
      const out = reviewTally(c.input);
      if (c.error !== undefined || !sameJson(out, c.output)) failures.push(`${c.name}: got ${JSON.stringify(out)}`);
    } catch (e) {
      if (!(e instanceof TallyError)) throw e;
      if (e.code !== c.error) failures.push(`${c.name}: got error ${e.code}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("every tally is a count input the clerk counts", () => {
  for (const c of vectors.tally) if (c.output !== undefined) assert.ok(count(c.output), c.name);
});
