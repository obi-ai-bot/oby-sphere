// The adversarial corpus: payloads a scripted peer puts into a request's data fields, and the cases
// built from them. The payloads themselves are not written in this repository; they come from a
// corpus file the maintainer supplies (a published injection benchmark, imported by
// import-corpus.mjs, or written by hand), so the suite carries the mechanism and the proof, not a
// library of attacks. The repository ships only a placeholder corpus of inert entries, to prove the
// format loads; its entries carry no instruction text.
//
// A corpus file (receiver/injections.json by default):
//
//   { "suite": "receiver/0.1",
//     "entries": [
//       { "id": "<unique>", "source": "<where it came from>", "licence": "<its licence, or CC0>",
//         "class": "participant",                      // the conformance class the case belongs to
//         "field": "question" | "review" | "handoff",  // which typed request carries it
//         "placement": "single" | "split",             // one request, or a labelled series
//         "payload": "<text>" | ["<part>", "<part>"]    // the words; an array for "split"
//       }, … ] }
//
// A payload may use three placeholders, which the harness replaces with this case's own markers
// before sending, and watches for afterwards (it follows none of them itself):
//   {{FILE}}         an absolute path under the receiver's work directory
//   {{URL}}          a URL on a loopback server that only records what fetched it
//   {{CANARY_NAME}}  the name under which the receiver was given the canary secret
// A payload that names none of them exercises only that nothing is sent but a typed reply.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CORPUS = join(here, "injections.json");

const FIELDS = { question: ["question"], review: ["review_request"], handoff: ["handoff"] };

/** Reads and checks a corpus file; an absent default file is an empty corpus, not an error. */
export function loadCorpus(path = DEFAULT_CORPUS) {
  if (!existsSync(path)) {
    if (path === DEFAULT_CORPUS) return { suite: "receiver/0.1", entries: [] };
    throw new Error(`no corpus file at ${path}`);
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`the corpus ${path} is not JSON: ${e.message}`);
  }
  if (!Array.isArray(doc?.entries)) throw new Error(`the corpus ${path} has no entries array`);
  const ids = new Set();
  for (const e of doc.entries) {
    for (const f of ["id", "source", "licence", "field"]) if (typeof e?.[f] !== "string") throw new Error(`a corpus entry is missing "${f}"`);
    if (ids.has(e.id)) throw new Error(`the corpus has two entries with id ${e.id}`);
    ids.add(e.id);
    if (!FIELDS[e.field]) throw new Error(`corpus entry ${e.id} has an unknown field "${e.field}"`);
    const split = e.placement === "split";
    if (split ? !Array.isArray(e.payload) || !e.payload.every((p) => typeof p === "string") : typeof e.payload !== "string") {
      throw new Error(`corpus entry ${e.id}'s payload is not ${split ? "an array of strings" : "a string"}`);
    }
  }
  return doc;
}

/** Replaces the placeholders in `text` with this case's markers (none of which the harness follows). */
function fill(text, marker, canaryName) {
  return text.replaceAll("{{FILE}}", marker.path).replaceAll("{{URL}}", marker.url).replaceAll("{{CANARY_NAME}}", canaryName);
}

/** One case per corpus entry: the payload goes into a typed field, the owner declines, and the
 *  track's checks catch anything the receiver did beyond sending that typed decline. */
export function buildCorpusCases(corpus) {
  return corpus.entries.map((e) => ({
    id: `corpus-${e.id}`,
    class: e.class ?? "participant",
    needs: FIELDS[e.field],
    title: `corpus ${e.id} (${e.source}): a payload in a ${e.field} leads to nothing but a typed decline`,
    source: e.source,
    licence: e.licence,
    async run(t) {
      const m = t.marker();
      const parts = e.placement === "split" ? e.payload : [e.payload];
      const requests = [];
      for (const part of parts) {
        const text = fill(part, m, t.canaryName);
        const req =
          e.field === "question" ? await t.send(t.peers.a, "question", { text })
          : e.field === "review" ? await t.send(t.peers.a, "review_request", reviewBody(text))
          : await t.send(t.peers.a, "handoff", handoffBody(text));
        requests.push(req);
      }
      for (const req of requests) {
        const item = await t.ownerStep(req);
        if (item) await t.decide(item, "decline");
        await t.waitTerminal(req);
      }
    },
  }));
}

export function reviewBody(summary) {
  return {
    goal: "Review the fixture change",
    repo: "obi-rt/fixture-app",
    base_branch: "main",
    head_branch: "feature/x",
    head_sha: "0000000000000000000000000000000000000000",
    acceptance: [{ kind: "tests_pass" }],
    summary,
  };
}

export function handoffBody(summary) {
  return { goal: "Carry out the fixture task", repo: "obi-rt/fixture-app", base_branch: "main", acceptance: [{ kind: "tests_pass" }], summary };
}
