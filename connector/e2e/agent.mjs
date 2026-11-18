#!/usr/bin/env node
// The connector with a model as the host's agent: `claude -p` with the connector as its only MCP
// server (--mcp-config, --strict-mcp-config) and none of its built-in tools, on a local Sphere,
// with the scripted client of server/e2e/client.mjs standing in for an Oby, and this script as the
// member's owner, deciding through the connector's CLI.
//
//   node e2e/agent.mjs [--model haiku] [--port 8793] [--keep]
//
// Two short `claude -p` runs, each a fresh session:
//   1. The Oby has asked the member a question. The agent reads the inbox (the question waits for
//      the owner, its words hidden) and asks the Oby for a review of a change.
//   2. The owner has approved the question, and the Oby has reviewed the change. The agent reads
//      the inbox, answers the question, and reports the review's outcome.
// Then the Oby receives the answer, checks it with the reference verifier, and the whole chain is
// verified with the spec's verifyChain. It prints each run's tool calls and cost (total_cost_usd).
//
// `claude` runs with only HOME, PATH and USER from this environment (no CLAUDECODE, CLAUDE_CODE_* or
// ANTHROPIC_*), signed in as the machine's user already: this script never signs in.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONNECTOR, connectorCli, makeTeam, ref, sleep, startSphere, verifyWholeChain } from "./harness.mjs";

const args = process.argv.slice(2).filter((a) => a !== "--");
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const MODEL = opt("--model") ?? "haiku";
const KEEP = args.includes("--keep");
const PASS = `owner-pass-${randomBytes(8).toString("hex")}`;
const BUNDLE = join(CONNECTOR, "dist", "obysphere-connector.mjs");
if (!existsSync(BUNDLE)) throw new Error("build the connector first: pnpm run build");
const TOOLS = ["members", "ask", "request_review", "hand_off", "inbox", "reply"].map((t) => `mcp__obysphere__${t}`);
const SHA = "9b2e4c6a8d0f1e3b5c7a9d1f3e5b7c9a1d3f5e7b";

let failures = 0;
const check = (cond, what) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}`);
  if (!cond) failures++;
  return cond;
};

/** One `claude -p` run: its final words, its tool calls, and what it cost. */
function claude(prompt, mcpConfig, cwd) {
  const argv = [
    "-p", prompt, "--model", MODEL, "--mcp-config", mcpConfig, "--strict-mcp-config", "--tools", "", "--allowedTools", ...TOOLS,
    "--no-session-persistence", "--output-format", "stream-json", "--verbose",
  ];
  const env = { HOME: process.env.HOME, PATH: process.env.PATH, USER: process.env.USER };
  return new Promise((done, failed) => {
    const child = spawn("claude", argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      failed(new Error("claude took more than 5 minutes"));
    }, 300000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      const events = out.split("\n").filter(Boolean).flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
      const calls = events.filter((e) => e.type === "assistant").flatMap((e) => e.message?.content ?? []).filter((c) => c.type === "tool_use");
      const results = events.filter((e) => e.type === "user").flatMap((e) => e.message?.content ?? []).filter((c) => c.type === "tool_result");
      const result = events.find((e) => e.type === "result");
      const init = events.find((e) => e.type === "system" && e.subtype === "init");
      if (!result) return failed(new Error(`claude exited ${code} with no result: ${err.slice(-500)}`));
      done({ code, result, calls, results, init });
    });
  });
}

const show = (run, n) => {
  console.log(`\n   claude run ${n}: model ${run.init?.model ?? MODEL}, MCP servers ${JSON.stringify(run.init?.mcp_servers ?? [])}, tools ${JSON.stringify(run.init?.tools ?? [])}`);
  for (const c of run.calls) console.log(`   → ${c.name.replace("mcp__obysphere__", "")} ${JSON.stringify(c.input)}`);
  console.log(`   its last words:\n${String(run.result.result ?? "").split("\n").map((l) => "   | " + l).join("\n")}`);
  console.log(`   turns ${run.result.num_turns}, total_cost_usd ${run.result.total_cost_usd}, ${run.result.is_error ? "an error" : "no error"}`);
};

const sphere = await startSphere({ port: opt("--port"), prefix: "obysphere-connector-agent-" });
const { run } = sphere;
const memberHome = join(run, "member");
const userHome = join(run, "home");
const cli = (argv, input) => connectorCli(BUNDLE, memberHome, userHome, argv, input);
let cost = 0;

try {
  console.log(`A local Sphere at ${sphere.base}; claude's model: ${MODEL}`);
  console.log("\n1. The Oby makes the team and joins; the connector joins with the invite link (its owner's passphrase on stdin)");
  const team = await makeTeam(sphere);
  const { oby, client } = team;
  const joined = cli(["join", team.link, "--owner", "dee", "--obi", "dee-agent", "--name", "Dee's Claude Code", "--description", "Claude Code, joined through the connector.", "--passphrase-stdin"], PASS + "\n");
  if (!check(joined.code === 0, `the connector joins${joined.code ? `: ${joined.err}` : ""}`)) throw new Error("no member");
  check(cli(["rules", "--allow", "question,review_request", "--to", "*", "--passphrase-stdin"], PASS + "\n").code === 0, "the owner lets the agent ask questions and request reviews without asking");
  const mcpConfig = join(run, "mcp.json");
  // alwaysLoad: Claude Code otherwise connects MCP servers lazily, and a `-p` run starts without its tools.
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { obysphere: { command: process.execPath, args: [BUNDLE, "mcp", "--home", memberHome], alwaysLoad: true } } }, null, 2));
  const workdir = join(run, "work");
  rmSync(workdir, { recursive: true, force: true });
  (await import("node:fs")).mkdirSync(workdir);

  console.log("\n2. The Oby asks dee-agent a question");
  const question = oby.request("dee-agent", "question", { text: "Which branch should the 0.4 release be cut from?", choices: ["main", "release/0.4"] });
  check((await oby.send(question)).status === 202, "the question is recorded");

  console.log("\n3. claude, run 1: read the inbox, ask the Oby for a review");
  const run1 = await claude(
    [
      "You are a member of an Obysphere through the `obysphere` MCP tools, acting for your owner, Dee.",
      "1. Call inbox with wait_seconds 30, and say in one sentence what is in it.",
      `2. Ask the member oby-ada to review a change with request_review: repo acme/app, pr 12, base_branch main, head_branch fix/retry, head_sha ${SHA}, goal "Retry failed uploads", summary "Adds a bounded retry around uploads."`,
      "3. Stop there, saying what you sent.",
    ].join("\n"),
    mcpConfig, workdir,
  );
  show(run1, 1);
  cost += run1.result.total_cost_usd ?? 0;
  check(run1.calls.some((c) => c.name === "mcp__obysphere__inbox"), "it read the inbox");
  check(run1.calls.some((c) => c.name === "mcp__obysphere__request_review"), "it asked for a review");
  const inboxSeen = run1.results.map((r) => JSON.stringify(r.content)).join("\n");
  check(inboxSeen.includes("WAITING FOR YOUR OWNER") && !inboxSeen.includes("0.4 release"), "the question waited for the owner, its words hidden from the agent");

  console.log("\n4. The Oby receives the review request, accepts it and sends its result; the owner approves the question");
  const req = (await oby.waitFor(1, 30)).find((d) => d.envelope.type === "review_request");
  check(req?.envelope.body.head_sha === SHA && req.envelope.from === "dee-agent", "the Oby receives the review request from dee-agent");
  const status = (await oby.deliveries()).body.deliveries;
  await oby.ack([req.delivery_id, ...status.map((d) => d.delivery_id)].filter((v, i, a) => a.indexOf(v) === i));
  check((await oby.send(oby.reply(req.envelope, "accept", {}))).status === 202, "the Oby accepts");
  const finding = { id: ref.spec.findingId("src/upload.js", 41, "Retry has no jitter"), severity: "minor", file: "src/upload.js", line: 41, title: "Retry has no jitter", detail: "All clients retry at the same moment after an outage." };
  const result = { for: "review_request", outcome: "approved", repo: "acme/app", head_sha: SHA, findings: [finding], acceptance: [{ index: 0, kind: "no_blocker_findings", met: true }], summary: "Looks good; one minor finding." };
  check((await oby.send(oby.reply(req.envelope, "result", result))).status === 202, "the Oby sends its result: approved, one minor finding");
  const approve = cli(["approve", question.id.slice(0, 8), "--passphrase-stdin"], PASS + "\n");
  check(approve.code === 0, `the owner approves the question with their passphrase${approve.code ? `: ${approve.err}` : ""}`);

  console.log("\n5. claude, run 2: answer the approved question, report the review");
  const run2 = await claude(
    [
      "You are a member of an Obysphere through the `obysphere` MCP tools, acting for your owner, Dee.",
      "1. Call inbox with wait_seconds 20.",
      "2. Your owner approved a question from oby-ada about which branch the 0.4 release is cut from. Dee's answer: the release is cut from main. Reply with kind answer, choosing that choice, in one short sentence.",
      "3. Then say in two sentences what the review you requested from oby-ada came back with (its outcome and findings).",
    ].join("\n"),
    mcpConfig, workdir,
  );
  show(run2, 2);
  cost += run2.result.total_cost_usd ?? 0;
  check(run2.calls.some((c) => c.name === "mcp__obysphere__reply" && c.input?.kind === "answer"), "it answered with the reply tool");
  check(/approved/i.test(String(run2.result.result)) && /jitter/i.test(String(run2.result.result)), "it reports the review: approved, the jitter finding");

  console.log("\n6. The Oby receives the answer and checks it");
  let got;
  for (let i = 0; i < 10 && !got; i++) got = (await oby.deliveries("?wait=3")).body.deliveries.find((d) => d.envelope.type === "answer" && d.envelope.in_reply_to === question.id);
  check(got?.envelope.body.choice === 0 && got.envelope.body.by === "obi", `the answer arrives: choice ${got?.envelope.body.choice} (main), by ${got?.envelope.body.by}`);
  if (got) {
    const keys = ref.directoryKeys((await client.call("GET", client.spherePath("/members"), { token: oby.accessToken })).body.members);
    const v = ref.spec.verifyEnvelope(got.envelope, { now: new Date().toISOString().replace(/\.\d+Z$/, "Z"), sphere: team.id, receiver: "oby-ada", keys, seq: got.seq });
    check(v.ok, `it verifies with the reference verifier: ${JSON.stringify(v)}`);
    console.log(`   the answer's words, as the Oby received them: ${JSON.stringify(got.envelope.body.text)}`);
  }

  console.log("\n7. The whole chain, with the spec's verifyChain");
  const { entries, verdict } = await verifyWholeChain(team);
  check(verdict.ok, `verifyChain on ${entries.length} entries: ${JSON.stringify(verdict)}`);
  for (const e of entries) console.log(`     seq ${String(e.seq).padStart(2)}  ${e.envelope.type.padEnd(14)} ${e.envelope.from} -> ${e.envelope.to}  ${e.hash.slice(0, 16)}…`);
} catch (e) {
  failures++;
  console.log(`  FAIL  ${e.message}`);
} finally {
  await sphere.stop();
  if (!KEEP && failures === 0) rmSync(run, { recursive: true, force: true });
  else console.log(`\nrun folder kept: ${run}`);
}
console.log(`\nclaude's two runs cost ${cost.toFixed(4)} USD in all (total_cost_usd).`);
console.log(failures === 0 ? "All passed." : `${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
