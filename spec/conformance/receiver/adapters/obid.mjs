// The receiver-track adapter for Oby's obid (conformance/README.md, "The adapter contract").
// obid is a loopback daemon: enroll makes its keys and card through its HTTP API, signs the card and
// the delegation with an owner key this adapter holds (obid never holds the owner key), joins the
// Sphere, and gives obid the canary through its vault; serve runs `obid serve`; inbox reads the
// owner's inbox; decide applies one owner decision. The review case runs obid's own stub agent
// (e2e/stub-agent), so no model is needed — the track checks obid's receiver behaviour, not its agent.
//
//   node obid.mjs            (OBID_BIN, OBID_STUB and OBID_GITLEAKS in the environment)
//
// Env: OBID_BIN (the obid binary), OBID_STUB (the stub agent), OBID_GITLEAKS (gitleaks, for the
// publish scan). Per op, {op, workdir, …} on stdin; the last JSON line on stdout is the answer.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as spec from "../../lib/obi.mjs";
import { newKey, nowSeconds, sleep } from "../sphere.mjs";

const OBID = process.env.OBID_BIN;
const STUB = process.env.OBID_STUB;
const GITLEAKS = process.env.OBID_GITLEAKS || "gitleaks";
const OBI_SCOPES = "send:review_request reply receive directory:read audit:read";
// obid takes these two request types in this version; the harness's `accepts` and `seal` inputs are
// not honoured here (obid's first card publishes no seal key, a staged rollout), and the harness
// reads the real card from the directory for what obid accepts and whether its replies are sealed.
const ACCEPTS = ["review_request", "question"];

const paths = (dir) => ({
  home: join(dir, "obid-home"),
  config: join(dir, "obid-config.json"),
  token: join(dir, "obid-home", "api-token"), // obid reads its API token here
  port: join(dir, "obid-port"),
  repo: join(dir, "fixture-app.git"),
  tmp: join(dir, "obid-tmp"),
});

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v));

/** One obid HTTP call; answers {status, body}. */
async function call(dir, method, path, body) {
  const p = paths(dir);
  const port = readFileSync(p.port, "utf8").trim();
  const token = readFileSync(p.token, "utf8").trim();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Host: "127.0.0.1", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, body: parsed };
}

/** Writes obid's config and the fixture git remote the review job fetches. */
function configure(dir, owner) {
  const p = paths(dir);
  for (const d of [p.home, p.tmp]) mkdirSync(d, { recursive: true });
  const port = spawnSyncPort();
  // A bare repo stands in for the reviewed repository: obid fetches it for the review job. The
  // request's head_sha isn't in it, so the job fails and obid returns a failed result — which is a
  // result all the same, what the owner-decides-a-review case checks.
  if (!existsSync(p.repo)) {
    spawnSync("git", ["init", "--bare", p.repo], { stdio: "ignore" });
  }
  const config = {
    listen: `127.0.0.1:${port}`,
    home: p.home,
    owner,
    agents: { claude: { bin: STUB, accounts: [{ id: "stub", name: "Stub", configDir: null }] } },
    repos: [{ repo: "obi-rt/fixture-app", remote: `file://${p.repo}`, defaultBranch: "main", check: null }],
    allowFileRemotes: true,
    telemetry: false,
    claudeKeychain: false,
    cursorKeychain: false,
  };
  writeJson(p.config, config);
  writeFileSync(p.port, String(port));
  if (!existsSync(p.token)) {
    writeFileSync(p.token, randomBytes(32).toString("base64url"));
    chmodSync(p.token, 0o600);
  }
  return port;
}

function spawnSyncPort() {
  // A free port, chosen synchronously (configure is called before the async flow).
  const r = spawnSync(process.execPath, ["-e", "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});"], { encoding: "utf8" });
  return Number(r.stdout.trim());
}

/** Starts `obid serve`; resolves once its health answers (or throws). Returns the child. */
async function start(dir) {
  const p = paths(dir);
  const env = { HOME: p.home, TMPDIR: p.tmp, PATH: `${dirname(GITLEAKS)}:${process.env.PATH}`, OBID_MEMORY_AVAILABLE: String(64 * 1024 * 1024 * 1024) };
  const child = spawn(OBID, ["serve", "--config", p.config], { env, detached: true, stdio: ["ignore", "ignore", "ignore"] });
  child.exited = new Promise((res) => child.on("exit", (code, signal) => res({ code, signal })));
  const port = readFileSync(p.port, "utf8").trim();
  const token = readFileSync(p.token, "utf8").trim();
  const deadline = Date.now() + 60_000;
  for (;;) {
    const ok = await fetch(`http://127.0.0.1:${port}/v1/status`, { headers: { Authorization: `Bearer ${token}`, Host: "127.0.0.1" } }).then((r) => r.ok, () => false);
    if (ok) return child;
    if (child.exitCode !== null || Date.now() > deadline) throw new Error("obid did not come up");
    await sleep(250);
  }
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  await Promise.race([child.exited, sleep(10_000)]);
}

// ---- ops ----------------------------------------------------------------------------------------

async function enroll(input) {
  const dir = input.workdir;
  const { base, id: sphere, invitation_id, secret } = input.sphere;
  const owner = input.owner;
  configure(dir, owner);
  const obid = await start(dir);
  try {
    // The owner key this adapter holds (obid never does): it signs the card and the delegation.
    const ownerKey = newKey();
    const made = await call(dir, "POST", "/v1/obid/sphere/key");
    if (made.status !== 200) throw new Error(`key: ${made.status} ${JSON.stringify(made.body)}`);
    // obid builds the member URL itself; `url` is the Sphere's base URL (http on this machine).
    const carded = await call(dir, "POST", "/v1/obid/sphere/card", { url: base, sphere, obiId: input.obi_id, name: "obid under test", ownerKey: ownerKey.publicKey, accepts: ACCEPTS });
    if (carded.status !== 200) throw new Error(`card: ${carded.status} ${JSON.stringify(carded.body)}`);
    const unsigned = carded.body.card ?? carded.body;
    const card = spec.signCard(unsigned, ownerKey.privateKey, ownerKey.keyId);
    const iat = nowSeconds();
    const delegation = spec.signJwt({ iss: owner, sub: owner, aud: `obi-sphere:${sphere}`, iat, exp: iat + 3600, jti: randomUUID(), scope: OBI_SCOPES, may_act: { sub: input.obi_id } }, ownerKey.privateKey, ownerKey.keyId);
    const joined = await call(dir, "POST", "/v1/obid/sphere/join", { url: base, sphere, invitation: { id: invitation_id, secret }, card, delegation });
    if (joined.status !== 200) throw new Error(`join: ${joined.status} ${JSON.stringify(joined.body)}`);
  } finally {
    await stop(obid);
  }
  // Give obid the canary, the way it holds an owner's secret: the vault's file store.
  const p = paths(dir);
  const vault = spawnSync(OBID, ["vault", "--config", p.config, "add", input.canary.name], { input: input.canary.value, encoding: "utf8" });
  if (vault.status !== 0) throw new Error(`vault add: ${vault.stderr}`);
  console.log(JSON.stringify({ ok: true }));
}

async function serve(input) {
  const obid = await start(input.workdir);
  await new Promise((res) => {
    const done = async () => {
      await stop(obid);
      res();
    };
    process.on("SIGTERM", done);
    process.on("SIGINT", done);
    obid.exited.then(res);
  });
}

async function inbox(input) {
  const r = await call(input.workdir, "GET", "/v1/inbox");
  const items = (Array.isArray(r.body) ? r.body : (r.body?.items ?? []))
    .filter((i) => i && i.kind === "obiRequest")
    .map((i) => ({ id: i.id, correlation_id: i.obi?.correlationId ?? i.correlation_id }))
    .filter((i) => typeof i.id === "string" && typeof i.correlation_id === "string");
  console.log(JSON.stringify({ items }));
}

async function decide(input) {
  const answer = input.decision === "accept" ? "Accept" : input.decision === "decline" ? "Decline" : input.text;
  const r = await call(input.workdir, "POST", `/v1/inbox/${encodeURIComponent(input.id)}/answer`, { answer });
  if (r.status < 200 || r.status >= 300) throw new Error(`answer ${input.decision}: ${r.status} ${JSON.stringify(r.body)}`);
  console.log(JSON.stringify({ ok: true }));
}

async function main() {
  if (!OBID || !existsSync(OBID)) throw new Error("set OBID_BIN to the obid binary");
  if (!STUB || !existsSync(STUB)) throw new Error("set OBID_STUB to the stub agent");
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
