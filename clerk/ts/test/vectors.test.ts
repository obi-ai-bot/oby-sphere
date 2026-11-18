// Runs every known-answer vector in clerk/vectors/count.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ClerkError, count, sameJson, verify, type Json } from "../src/index.ts";

type Case = { name: string; input: Json; output?: Json; error?: string };
type VerifyCase = { name: string; input: Json; verdict: Json; valid: boolean };

const vectors = JSON.parse(readFileSync(new URL("../../vectors/count.json", import.meta.url), "utf8")) as {
  count: Case[];
  verify: VerifyCase[];
};

test("count vectors", () => {
  const failures: string[] = [];
  for (const c of vectors.count) {
    try {
      const out = count(c.input);
      if (c.error !== undefined || !sameJson(out, c.output)) failures.push(`${c.name}: got ${JSON.stringify(out)}`);
    } catch (e) {
      if (!(e instanceof ClerkError)) throw e;
      if (e.code !== c.error) failures.push(`${c.name}: got error ${e.code}`);
    }
  }
  assert.deepEqual(failures, [], `${failures.length} of ${vectors.count.length} count vectors failed`);
});

test("verify vectors", () => {
  for (const c of vectors.verify) assert.equal(verify(c.input, c.verdict), c.valid, c.name);
});

test("every counted output verifies", () => {
  for (const c of vectors.count) if (c.output !== undefined) assert.ok(verify(c.input, c.output), c.name);
});
