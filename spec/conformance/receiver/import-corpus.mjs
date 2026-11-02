#!/usr/bin/env node
// Turns a published prompt-injection benchmark into a receiver-track corpus (corpus.mjs). It reads a
// benchmark file already on disk — it fetches nothing — and writes the corpus format the harness
// loads, carrying each entry's source, licence and id so the provenance of every payload is kept.
//
//   node conformance/receiver/import-corpus.mjs <benchmark.json> --source "<name>" --licence "<id>" > injections.json
//
// The benchmark is expected to be a JSON array, or an object with a `data`/`entries`/`rows` array, of
// rows that each carry the attack text under one of: `payload`, `prompt`, `text`, `attack`, `input`.
// A row MAY set its own `id`, `source`, `licence`, `field` (question | review | handoff) and
// `placement` (single | split); the command's --source/--licence/--field fill in the rest. Map a
// benchmark with another shape by editing `ROW` below; the point is that the adversarial text lives
// in the benchmark, under its own licence, never in this repository.
//
// It does not judge or transform the text: it places it verbatim into the corpus. The harness later
// puts it into a request's data field, where the protocol treats it as data (protocol.md section 8).

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true);
if (!file) {
  console.error("usage: import-corpus.mjs <benchmark.json> --source <name> --licence <id> [--field question]");
  process.exit(64);
}
const defaults = { source: opt("--source", "unknown"), licence: opt("--licence", "unknown"), field: opt("--field", "question"), placement: opt("--placement", "single") };

const doc = JSON.parse(readFileSync(file, "utf8"));
const rows = Array.isArray(doc) ? doc : doc.data ?? doc.entries ?? doc.rows ?? [];
if (!Array.isArray(rows) || !rows.length) {
  console.error("found no array of rows in the benchmark (expected a top-level array, or a data/entries/rows array)");
  process.exit(65);
}

/** One benchmark row → one corpus entry. Edit this for a benchmark shaped differently. */
const ROW = (row, i) => {
  const payload = row.payload ?? row.prompt ?? row.text ?? row.attack ?? row.input;
  if (typeof payload !== "string" && !Array.isArray(payload)) return null;
  return {
    id: String(row.id ?? i),
    source: row.source ?? defaults.source,
    licence: row.licence ?? row.license ?? defaults.licence,
    class: row.class ?? "participant",
    field: row.field ?? defaults.field,
    placement: row.placement ?? (Array.isArray(payload) ? "split" : defaults.placement),
    payload,
  };
};

const entries = rows.map(ROW).filter(Boolean);
if (!entries.length) {
  console.error("no row carried an attack string (payload/prompt/text/attack/input)");
  process.exit(65);
}
console.log(JSON.stringify({ suite: "receiver/0.1", source: defaults.source, licence: defaults.licence, entries }, null, 2));
