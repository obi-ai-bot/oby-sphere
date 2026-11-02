// The receiver-track adapter for the Obysphere MCP connector (conformance/README.md). The connector
// holds its own keys (so enroll just shells to `connector join` with an invite link), keeps a mailbox
// under <home>/items/, and applies the owner's signed decisions when a `connector run` or `connector
// mcp` is running. It holds no owner secret, so it reports `holds_canary: false` and the canary cases
// are not-applicable. The review case needs a host agent to produce the result: serve in "agent" mode
// runs `claude -p` with `connector mcp` as its only MCP server (as connector/e2e/agent.mjs does).
//
//   node connector.mjs            (CONNECTOR_BUNDLE, CONNECTOR_SERVE=run|agent, CLAUDE_MODEL in env)

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BUNDLE = process.env.CONNECTOR_BUNDLE;
const SERVE = process.env.CONNECTOR_SERVE || "run"; // "run" (no model) or "agent" (claude + connector mcp)
const MODEL = process.env.CLAUDE_MODEL || "haiku";
const ALLOWED = ["members", "ask", "request_review", "hand_off", "inbox", "reply"].map((t) => `mcp__obysphere__${t}`);

const paths = (dir) => ({ member: join(dir, "member"), userHome: join(dir, "home"), pass: join(dir, "passphrase"), mcp: join(dir, "mcp.json"), work: join(dir, "work") });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The connector CLI: `node <bundle> <argv…> --home <member>`, HOME = the user home, passphrase on stdin. */
function cli(dir, argv, { input } = {}) {
  const p = paths(dir);
  const r = spawnSync(process.execPath, [BUNDLE, ...argv, "--home", p.member], { input, encoding: "utf8", env: { PATH: process.env.PATH, HOME: p.userHome } });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const items = (dir) => {
  const d = join(paths(dir).member, "items");
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(d, n), "utf8")));
};

// ---- ops ----------------------------------------------------------------------------------------

async function enroll(input) {
  const dir = input.workdir;
  const p = paths(dir);
  for (const d of [p.userHome, p.work]) mkdirSync(d, { recursive: true });
  const pass = `owner-${randomBytes(12).toString("hex")}`;
  writeFileSync(p.pass, pass);
  const { base, id: sphere, invitation_id, secret } = input.sphere;
  const link = `${base}/join#sphere=${sphere}&for=${input.owner}&obi=${input.obi_id}&id=${invitation_id}&secret=${secret}`;
  const joined = cli(dir, ["join", link, "--owner", input.owner, "--obi", input.obi_id, "--name", "Connector under test", "--accepts", "question,review_request", "--passphrase-stdin"], { input: pass + "\n" });
  if (joined.code !== 0) throw new Error(`join: ${joined.err || joined.out}`);
  // The connector holds no owner secret, so there is no canary for it to keep (README, enroll).
  console.log(JSON.stringify({ ok: true, holds_canary: false }));
}

async function serve(input) {
  const dir = input.workdir;
  const p = paths(dir);
  let child = null;
  let running = true;
  const stop = () => {
    running = false;
    if (child && child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  if (SERVE === "run") {
    // The mailbox worker: receives, holds each request for the owner, applies the owner's decisions.
    child = spawn(process.execPath, [BUNDLE, "run", "--home", p.member], { env: { PATH: process.env.PATH, HOME: p.userHome }, detached: true, stdio: ["ignore", "ignore", "ignore"] });
    await new Promise((res) => {
      child.on("exit", res);
      const t = setInterval(() => {
        if (!running) {
          clearInterval(t);
          res();
        }
      }, 200);
    });
    return;
  }

  // "agent": a host agent (claude) with the connector as its only MCP server produces the review
  // result. The agent polls its inbox until the owner has approved a review, then replies.
  writeFileSync(p.mcp, JSON.stringify({ mcpServers: { obysphere: { command: process.execPath, args: [BUNDLE, "mcp", "--home", p.member], alwaysLoad: true } } }));
  // Each run is short and one-shot: call inbox once (which receives new deliveries and applies the
  // owner's decisions), and if a review is already approved, reply with its result. The loop repeats
  // it, so the run right after the owner approves is the one that applies the approve and replies.
  const prompt = [
    "You are a member of an Obysphere through the `obysphere` MCP tools, acting for your owner.",
    "1. Call inbox once, with wait_seconds 5.",
    "2. Look for a review_request whose body you can see in full (a review your owner APPROVED — not one marked waiting for the owner, whose words are hidden).",
    "3. If and only if you see such an approved review, reply to it with the reply tool: kind result, for review_request, outcome failed, repo and head_sha copied from the request, findings []. (A failed result is correct; do not try to fetch the repo.)",
    "4. Say in one sentence what you did, and stop.",
  ].join("\n");
  let replied = false;
  while (running && !replied) {
    const run = await claude(prompt, p.mcp, p.work, p.userHome);
    if (run.repliedResult) replied = true;
    if (!replied) await sleep(500);
  }
  // Stay up until the harness stops us, so the connector can still relay the result to the peer.
  while (running) await sleep(300);
}

/** One `claude -p` run with the connector as its MCP server; resolves with whether it sent a result. */
function claude(prompt, mcpConfig, cwd, home) {
  const argv = ["-p", prompt, "--model", MODEL, "--mcp-config", mcpConfig, "--strict-mcp-config", "--tools", "", "--allowedTools", ...ALLOWED, "--no-session-persistence", "--output-format", "stream-json", "--verbose"];
  return new Promise((done) => {
    const child = spawn("claude", argv, { cwd, env: { HOME: home, PATH: process.env.PATH, USER: process.env.USER }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      if (err.trim()) console.error(`[connector-adapter] claude stderr (exit ${code}): ${err.trim().slice(0, 400)}`);
      clearTimeout(timer);
      let cost = 0;
      let repliedResult = false;
      for (const line of out.split("\n").filter(Boolean)) {
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e.type === "result" && typeof e.total_cost_usd === "number") cost += e.total_cost_usd;
        if (e.type === "assistant") for (const c of e.message?.content ?? []) if (c.type === "tool_use" && c.name === "mcp__obysphere__reply" && c.input?.kind === "result") repliedResult = true;
      }
      // Record cost for the run's log line (the harness reads nothing from here).
      if (cost) console.error(`[connector-adapter] claude run total_cost_usd ${cost}`);
      done({ repliedResult });
    });
  });
}

async function inbox(input) {
  const waiting = items(input.workdir).filter((i) => i.direction === "in" && i.state === "waiting_on_owner" && !i.decided);
  console.log(JSON.stringify({ items: waiting.map((i) => ({ id: i.id, correlation_id: i.request_id })) }));
}

async function decide(input) {
  const dir = input.workdir;
  const pass = readFileSync(paths(dir).pass, "utf8");
  const argv =
    input.decision === "accept" ? ["approve", input.id]
    : input.decision === "decline" ? ["decline", input.id, "--reason", "owner_declined"]
    : ["answer", input.id, "--text", input.text ?? ""];
  const r = cli(dir, [...argv, "--passphrase-stdin"], { input: pass + "\n" });
  if (r.code !== 0) throw new Error(`${input.decision} ${input.id}: ${r.err || r.out}`);
  console.log(JSON.stringify({ ok: true }));
}

async function main() {
  if (!BUNDLE || !existsSync(BUNDLE)) throw new Error("set CONNECTOR_BUNDLE to the built connector (dist/obysphere-connector.mjs)");
  const input = JSON.parse(readFileSync(0, "utf8"));
  const ops = { enroll, serve, inbox, decide };
  const op = ops[input.op];
  if (!op) throw new Error(`unknown op ${input.op}`);
  await op(input);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
