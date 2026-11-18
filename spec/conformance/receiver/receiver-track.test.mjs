// The receiver track proves itself: the careful test receiver must pass every case, and the reckless
// one must fail — and fail for the right reasons (it acts without its owner, and it lets the canary
// out). This runs the track against both, so a change that makes the track accept a reckless receiver,
// or reject a careful one, fails CI.
//
//   node --test conformance/receiver/receiver-track.test.mjs      (from spec/, with the server built)
//
// It needs a Sphere server to start a local Sphere: $OBI_SERVER_DIR, or ../server beside this
// checkout's spec/. Both the server's and the spec's packages must be installed.

import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runReceiverTrack } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const RECEIVER = join(here, "receivers", "receiver.mjs");
const serverDir = resolve(process.env.OBI_SERVER_DIR ?? join(here, "..", "..", "..", "server"));
const haveServer = existsSync(join(serverDir, "scripts", "local.mjs")) && existsSync(join(serverDir, "node_modules"));
// A silent skip would let the suite go green without ever running; under CI the server must be there.
if (process.env.CI && !haveServer) throw new Error(`the receiver track needs a server checkout with its packages at ${serverDir} (set OBI_SERVER_DIR)`);

const adapter = (mode) => `"${process.execPath}" "${RECEIVER}" ${mode}`;

test("the careful receiver passes every case", { skip: haveServer ? false : "no server checkout with its packages (set OBI_SERVER_DIR)" }, async () => {
  const r = await runReceiverTrack({ adapter: adapter("careful"), serverDir });
  const failed = r.results.filter((c) => c.status === "fail");
  assert.equal(failed.length, 0, `careful receiver failed: ${failed.map((c) => `${c.id} (${c.problems[0]})`).join("; ")}`);
  assert.ok(r.results.some((c) => c.status === "pass"), "no case ran");
  assert.ok(r.ok, "the track did not pass the careful receiver");
});

test("the reckless receiver fails, on acting without its owner and on leaking the canary", { skip: haveServer ? false : "no server checkout with its packages (set OBI_SERVER_DIR)" }, async () => {
  const r = await runReceiverTrack({ adapter: adapter("reckless"), serverDir });
  assert.equal(r.ok, false, "the track passed a receiver that acts on its own and dumps what it holds");
  const problems = r.results.flatMap((c) => c.problems);
  assert.ok(problems.some((p) => /before its owner was asked/.test(p)), "the track did not catch the receiver acting without its owner");
  assert.ok(problems.some((p) => /canary reached/.test(p)), "the track did not catch the canary leaving");
});
