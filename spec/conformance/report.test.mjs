// The per-class report (report.mjs, #57): fixtures map to the right class, a class needs its
// required parts to pass, and two runs merge into one report.
//
//   node --test conformance/report.test.mjs

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { badgeSvg, classOfFixture, loadOrNew, recordImpl, recordReceiver, writeReport } from "./report.mjs";

test("fixtures map to their conformance class", () => {
  assert.equal(classOfFixture({ case: "host_approval", input: {} }), "approver");
  assert.equal(classOfFixture({ case: "envelope", input: { type: "run_request" } }), "executor");
  assert.equal(classOfFixture({ case: "envelope", input: { type: "share_offer" } }), "holder");
  assert.equal(classOfFixture({ case: "envelope", input: { type: "review_request" } }), "participant");
  assert.equal(classOfFixture({ case: "card", input: {} }), "participant");
  assert.equal(classOfFixture({ case: "audit", input: { entries: [{ envelope: { type: "run_return" } }] } }), "executor");
});

test("a class with both parts needs both to pass; one with only message needs only message", () => {
  let r = recordImpl(loadOrNew(null, "x"), { participant: { ran: 10, passed: 10 }, executor: { ran: 5, passed: 5 }, holder: { ran: 3, passed: 3 }, approver: { ran: 2, passed: 2 } });
  assert.equal(r.classes.participant.status, "incomplete", "participant with no behaviour part is incomplete");
  assert.equal(r.classes.holder.status, "pass", "holder needs only the message part");
  assert.equal(r.classes.approver.status, "pass");
  r = recordReceiver(r, [{ class: "participant", status: "pass" }, { class: "participant", status: "pass" }]);
  assert.equal(r.classes.participant.status, "pass", "participant passes once both parts are in");
  assert.equal(r.classes.executor.status, "incomplete", "executor still lacks its behaviour part");
});

test("a failing case fails its class", () => {
  const r = recordReceiver(loadOrNew(null, "x"), [{ class: "participant", status: "fail" }]);
  assert.equal(r.classes.participant.status, "fail");
});

test("two runs into the same file merge", () => {
  const dir = mkdtempSync(join(tmpdir(), "obi-rt-report-"));
  const path = join(dir, "report.json");
  try {
    writeReport(path, recordImpl(loadOrNew(path, "impl-a"), { participant: { ran: 4, passed: 4 } }));
    writeReport(path, recordReceiver(loadOrNew(path, "impl-a"), [{ class: "participant", status: "pass" }]));
    const merged = loadOrNew(path, "impl-a");
    assert.equal(merged.classes.participant.message.ran, 4, "the message part survived the second run");
    assert.equal(merged.classes.participant.behaviour.ran, 1, "the behaviour part was added");
    assert.equal(merged.classes.participant.status, "pass");
    assert.equal(merged.runs.length, 2, "both runs are recorded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the badge is self-contained SVG naming the suite", () => {
  const r = recordImpl(loadOrNew(null, "x"), { holder: { ran: 1, passed: 1 } });
  const svg = badgeSvg(r);
  assert.match(svg, /^<svg /);
  assert.match(svg, /obi conformance/);
  // Self-contained: no external service, image, link or script (the SVG xmlns URI aside).
  assert.ok(!/shields\.io|<image|xlink:href|href=|<script/.test(svg), "the badge pulls in nothing external");
});
