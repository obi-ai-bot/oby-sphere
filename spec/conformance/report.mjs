// The conformance report and its badge (conformance/README.md, "The report and the badge", #57).
//
// A report says, per conformance class, how many of that class's cases ran and passed, and whether
// the class is pass / fail / incomplete / not_run. A class is checked by two kinds of case: the
// message fixtures (an `--impl` run) and the receiver track (a `--receiver` run). `participant` and
// `executor` need both kinds; `holder` and `approver` are checked at the message level in v0.1. A
// report merges across runs: `--impl` fills the message part, `--receiver` the behaviour part, and
// two runs into the same file combine, so a project that claims a class with both publishes one
// report from both runs.
//
// Report shape (JSON):
//   { "suite": "obi/0.1", "report_version": 1, "label": "<impl>", "generated_at": "<ISO>",
//     "commit": "<the suite's commit the run was at, or null>",
//     "runs": [ { "mode": "impl" | "receiver", "at": "<ISO>" } ],
//     "classes": { "<id>": { "message": {ran, passed} | null, "behaviour": {ran, passed} | null,
//                            "status": "pass" | "fail" | "incomplete" | "not_run" } } }

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PROTOCOL } from "./lib/obi.mjs";

export const SUITE = PROTOCOL; // "obi/0.1": the report is tied to the protocol version it checks
export const REPORT_VERSION = 1;
export const CLASS_IDS = ["participant", "executor", "holder", "approver"];
// The case kinds each class needs for a full claim: "message" (fixtures), "behaviour" (receiver track).
export const CLASS_PARTS = { participant: ["message", "behaviour"], executor: ["message", "behaviour"], holder: ["message"], approver: ["message"] };

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** The class a message fixture belongs to (conformance/README.md, "Conformance classes"). */
export function classOfFixture(c) {
  if (c.case === "host_approval") return "approver";
  const types = c.case === "audit" ? (c.input?.entries ?? []).map((e) => e?.envelope?.type) : [c.input?.type];
  if (types.some((t) => typeof t === "string" && t.startsWith("run_"))) return "executor";
  if (types.some((t) => typeof t === "string" && t.startsWith("share_"))) return "holder";
  return "participant";
}

const emptyClasses = () => Object.fromEntries(CLASS_IDS.map((id) => [id, { message: null, behaviour: null, status: "not_run" }]));

/** A fresh report, or the one already at `path` for the same suite (to merge into). */
export function loadOrNew(path, label) {
  if (path && existsSync(path)) {
    try {
      const prior = JSON.parse(readFileSync(path, "utf8"));
      if (prior.suite === SUITE && prior.classes) return { suite: SUITE, report_version: REPORT_VERSION, label: label ?? prior.label, generated_at: prior.generated_at, runs: prior.runs ?? [], classes: { ...emptyClasses(), ...prior.classes } };
    } catch {
      // a corrupt or foreign file is replaced, not merged
    }
  }
  return { suite: SUITE, report_version: REPORT_VERSION, label: label ?? "unnamed", generated_at: null, runs: [], classes: emptyClasses() };
}

/** Records one part's counts ({ran, passed}) per class into the report, replacing that part. */
function applyPart(report, part, byClass) {
  for (const id of CLASS_IDS) if (byClass[id]) report.classes[id][part] = { ran: byClass[id].ran, passed: byClass[id].passed };
}

/** Recomputes each class's status and stamps the report. */
export function finalize(report, run) {
  if (run) report.runs = [...report.runs.filter((r) => r.mode !== run.mode), run];
  report.generated_at = nowIso();
  for (const id of CLASS_IDS) {
    const cls = report.classes[id];
    const parts = CLASS_PARTS[id].map((p) => cls[p]);
    const anyRan = parts.some((p) => p && p.ran > 0);
    const anyFailed = parts.some((p) => p && p.ran > p.passed);
    const allRequiredRan = CLASS_PARTS[id].every((p) => cls[p] && cls[p].ran > 0);
    cls.status = anyFailed ? "fail" : !anyRan ? "not_run" : allRequiredRan ? "pass" : "incomplete";
  }
  return report;
}

/** Folds an `--impl` run (message fixtures) into the report: `byClass` is {class: {ran, passed}}. */
export function recordImpl(report, byClass) {
  applyPart(report, "message", byClass);
  return finalize(report, { mode: "impl", at: nowIso() });
}

/** Folds a `--receiver` run into the report, from the track's per-case results. */
export function recordReceiver(report, results) {
  const byClass = {};
  for (const r of results) {
    if (r.status === "n/a") continue;
    const c = (byClass[r.class] ??= { ran: 0, passed: 0 });
    c.ran++;
    if (r.status === "pass") c.passed++;
  }
  applyPart(report, "behaviour", byClass);
  return finalize(report, { mode: "receiver", at: nowIso() });
}

export function writeReport(path, report) {
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
}

// --- the badge -----------------------------------------------------------------------------------

const COLOURS = { pass: "#2da44e", fail: "#cf222e", incomplete: "#9a6700", not_run: "#6e7781" };

/** A self-contained SVG badge from a report: the suite, then each class with its status colour. */
export function badgeSvg(report) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const label = `obi conformance ${report.suite}`;
  const segs = CLASS_IDS.map((id) => ({ id, status: report.classes[id].status }));
  const char = 6.3; // approx width per character at 11px monospace
  const pad = 8;
  const labelW = Math.ceil(label.length * char + pad * 2);
  const parts = segs.map((s) => {
    const text = `${s.id} ${s.status === "pass" ? "✓" : s.status === "fail" ? "✗" : s.status === "incomplete" ? "…" : "–"}`;
    return { ...s, text, w: Math.ceil(text.length * char + pad * 2) };
  });
  const total = labelW + parts.reduce((n, p) => n + p.w, 0);
  const h = 20;
  let x = labelW;
  const segSvg = parts
    .map((p) => {
      const rect = `<rect x="${x}" width="${p.w}" height="${h}" fill="${COLOURS[p.status] ?? COLOURS.not_run}"/>`;
      const label = `<text x="${x + p.w / 2}" y="14" fill="#fff" text-anchor="middle" font-family="monospace" font-size="11">${esc(p.text)}</text>`;
      x += p.w;
      return rect + label;
    })
    .join("");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${h}" role="img" aria-label="${esc(label)}">`,
    `<rect width="${total}" height="${h}" fill="#24292f"/>`,
    `<rect x="0" width="${labelW}" height="${h}" fill="#24292f"/>`,
    `<text x="${labelW / 2}" y="14" fill="#fff" text-anchor="middle" font-family="monospace" font-size="11">${esc(label)}</text>`,
    segSvg,
    `</svg>`,
  ].join("");
}
