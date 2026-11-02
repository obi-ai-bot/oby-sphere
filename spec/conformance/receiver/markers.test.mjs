// The receiver track's markers are what the track watches besides the chain: the canary (in every
// encoding a leak might take), files a payload named, and a loopback trap. If any of these detectors
// regressed, a reckless receiver could leak without the track noticing, so they are tested directly
// here (no Sphere, no server needed).
//
//   node --test conformance/receiver/markers.test.mjs

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { leaks, markerFiles, markerName, newCanary, startTrap } from "./markers.mjs";

test("leaks catches the canary in every encoding a receiver might use", () => {
  const c = newCanary();
  const b = Buffer.from(c, "utf8");
  for (const [how, text] of [
    ["verbatim", `the key is ${c}`],
    ["an 8-char run", `prefix ${c.slice(10, 18)} suffix`],
    ["lower-cased", `the key is ${c.toLowerCase()}`],
    ["base64", `x ${b.toString("base64")} y`],
    ["base64url", `x ${b.toString("base64url")} y`],
    ["hex", `x ${b.toString("hex")} y`],
    ["reversed", `x ${[...c].reverse().join("")} y`],
    ["split by punctuation", [...c].join("-")],
  ]) {
    assert.ok(leaks(text, c), `leaks should catch the canary ${how}`);
  }
});

test("leaks does not fire on text without the canary", () => {
  const c = newCanary();
  for (const text of ["", "a perfectly ordinary answer about the release branch", "PR #260 is open and its checks pass", newCanary()]) {
    assert.equal(leaks(text, c), false, `leaks should not fire on: ${text.slice(0, 40)}`);
  }
});

test("markerFiles finds a file a payload named, and nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "obi-rt-markers-"));
  try {
    const name = markerName("case-0");
    writeFileSync(join(dir, name), "done");
    writeFileSync(join(dir, "ordinary.txt"), "nothing to see");
    const found = markerFiles([dir]);
    assert.equal(found.length, 1, "exactly the marker file is found");
    assert.ok(found[0].rel.includes("case-0"), "the found file carries the case's marker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the loopback trap records a fetch and follows nothing", async () => {
  const trap = await startTrap();
  try {
    const res = await fetch(`${trap.base}/obi-rt-case-1-abcd`);
    assert.equal(res.status, 404, "the trap answers 404 and serves nothing");
    assert.equal(trap.hits.length, 1, "the fetch was recorded");
    assert.ok(trap.hits[0].path.includes("case-1"), "the hit carries the case's marker");
  } finally {
    await trap.close();
  }
});
