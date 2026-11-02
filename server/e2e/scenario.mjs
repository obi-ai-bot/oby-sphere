#!/usr/bin/env node
// The Sphere's half of the end-to-end scenario (obi e2e/SCENARIO.md), against a real local Sphere
// started exactly as the harness starts it (`node scripts/local.mjs --port <port> --persist-to <dir>`),
// with a scripted client (e2e/client.mjs) in place of the two obids: it plays both owners and both
// Obis' Sphere-side calls, with keys it generates in memory.
//
//   pnpm run scenario            (node e2e/scenario.mjs)
//   OBI_SPHERE_E2E_KEEP=1        keep the run folder (logs, state) afterwards
//   OBI_DIR=<obi checkout>       check e2e/fixtures/ against obi's (default: ../obi, when there)
//   OBI_SPHERE_URL=<https://…>   run against a deployed Sphere instead of starting one; needs its
//                                SPHERE_OPERATOR_TOKEN, makes a fresh Sphere `e2e-<hex>` there, and
//                                skips the local-only checks (1.1b, 1.1c and step 8)
//
// It runs, with SCENARIO.md's fixed values and calls:
//   step 1  Sphere up, team created, two Obis invited
//   step 2  (the Sphere's side) both Obis paired: redeem, token exchange, the directory
//   step 3  B sends review_request via relay
//   step 5  (the Sphere's side) the relay: A receives, accepts and returns the typed result; B receives both
//   step 6  (the Sphere's side) the second exchange, accepted by rule
//   step 7  audit chain holds both exchanges, signed by their senders, and verifies
//   step 8  (the Sphere's side) a clean exit on SIGTERM, and no write outside the Sphere's write root
// Each prints PASS or FAIL with the first expectation that didn't hold. Exit 0 only when all pass.

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { Obi, Owner, SphereClient, directoryKeys, spec } from "./client.mjs";
import { loadFixtures } from "./fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(here, "..");
const CHECKOUT = resolve(SERVER_DIR, "..");

// SCENARIO.md, "The fixed values".
// A deployed Sphere keeps every Sphere it was given (v0.1 has no delete), so each remote run makes its own.
const REMOTE = process.env.OBI_SPHERE_URL?.replace(/\/+$/, "");
const SPHERE = { id: REMOTE ? `e2e-${randomBytes(4).toString("hex")}` : "e2e", name: "E2E sphere" };
const A = { obi: "obi-wellington", owner: "wellington", name: "Wellington's Obi", accepts: ["review_request"] };
const B = { obi: "obi-ernesto", owner: "ernesto", name: "Ernesto's Obi", accepts: ["review_request"] };
const POLICY_RULES = [{ id: "team-reviews", from_owner: "*", to_owner: "*", actions: ["review_request"], repos: ["obi-e2e/fixture-app"] }];
const OBI_SCOPES = "send:review_request reply receive directory:read audit:read";
const ADMIN_SCOPES = "admin directory:read audit:read";
// SCENARIO.md's brief and result, checked against obi's own files when an obi checkout is at hand
// (e2e/fixtures.mjs): a copy that no longer matches stops the run before any step.
const FIXTURES = (() => {
  try {
    return loadFixtures();
  } catch (e) {
    console.log(`  FAIL  fixtures: ${e.message}`);
    process.exit(1);
  }
})();
const BRIEF = FIXTURES.brief;
const EXPECTED_RESULT = FIXTURES.result;
const EXPIRES_IN = 3600;
// The remembered decision's id obid A would name (`d-` and 12 lower-case hex): opaque to the Sphere.
const D1 = "d-3f9a0c1b2e4d";
const ZERO = "0".repeat(64);

// ---------------------------------------------------------------------------------------------

const RUN = process.env.OBI_SPHERE_E2E_RUN_DIR ? resolve(process.env.OBI_SPHERE_E2E_RUN_DIR) : mkdtempSync(join(tmpdir(), "obi-sphere-e2e-"));
const R = { sphere: join(RUN, "sphere"), state: join(RUN, "sphere", "state"), home: join(RUN, "sphere", "home"), tmp: join(RUN, "sphere", "tmp"), harness: join(RUN, "harness") };
for (const dir of Object.values(R)) mkdirSync(dir, { recursive: true });

const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};
const same = (a, b) => isDeepStrictEqual(a, b);
const show = (v) => JSON.stringify(v)?.slice(0, 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function expectStatus(r, status, what) {
  assert(r.status === status, `${what}: expected ${status}, got ${r.status} ${show(r.body)}`);
  return r.body;
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

// SCENARIO.md, "No process wrote outside its write root": the checkout's files (path, size,
// SHA-256), skipping .git/, every node_modules/ and server/.wrangler/.
function snapshot(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(root, path);
      const st = statSync(path, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) {
        if (rel === ".git" || name === "node_modules" || rel === join("server", ".wrangler")) continue;
        walk(path);
      } else if (st.isFile()) {
        out.set(rel, `${st.size}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
      }
    }
  };
  walk(root);
  return out;
}
const WATCHED_NAMES = /^(obid|obi-|\.obi|\.wrangler|wrangler|\.claude)/;
const topNames = (dir) => new Set(existsSync(dir) ? readdirSync(dir) : []);

// ---------------------------------------------------------------------------------------------

const ctx = {};
let sphereProcess = null;

function startSphere(port) {
  const log = createWriteStream(join(R.harness, "sphere.log"), { flags: "a" });
  // Exactly what SCENARIO.md step 1.1 gives the Sphere: nothing else from this environment.
  const env = { SPHERE_OPERATOR_TOKEN: ctx.operatorToken, HOME: R.home, TMPDIR: R.tmp, WRANGLER_SEND_METRICS: "false", PATH: process.env.PATH };
  const child = spawn(process.execPath, ["scripts/local.mjs", "--port", String(port), "--persist-to", R.state], { cwd: SERVER_DIR, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.exited = new Promise((res) => child.on("exit", (code, signal) => res({ code, signal })));
  return child;
}

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {}
}

// The TCP ports that processes in process group `pgid` (the Sphere's: pnpm, node, wrangler, workerd)
// listen on, as [{ address, port }]. Linux: /proc; macOS: lsof. Anywhere else it throws: the check
// that uses it fails rather than passing unseen.
function listeningSockets(pgid) {
  if (process.platform === "darwin") {
    let out = "";
    try {
      out = execFileSync("lsof", ["-nP", "-a", "-g", String(pgid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { encoding: "utf8" });
    } catch (e) {
      if (e.status !== 1) throw new Error(`lsof: ${e.message}`);
    }
    return out.split("\n").filter((l) => l.startsWith("n")).map((l) => {
      const at = l.lastIndexOf(":");
      return { address: l.slice(1, at).replace(/^\[|\]$/g, ""), port: Number(l.slice(at + 1)) };
    });
  }
  if (process.platform === "linux") {
    const inodes = new Set();
    for (const pid of readdirSync("/proc").filter((n) => /^[0-9]+$/.test(n))) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]) !== pgid) continue;
        for (const fd of readdirSync(`/proc/${pid}/fd`)) {
          const m = /^socket:\[([0-9]+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`, { encoding: "utf8" }));
          if (m) inodes.add(m[1]);
        }
      } catch {}
    }
    const out = [];
    for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      if (!existsSync(table)) continue;
      for (const line of readFileSync(table, "utf8").split("\n").slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f.length < 10 || f[3] !== "0A" || !inodes.has(f[9])) continue;
        const [hex, port] = f[1].split(":");
        // /proc writes each 32-bit word of the address in host (little-endian) byte order.
        const bytes = hex.match(/.{8}/g).flatMap((w) => w.match(/../g).reverse().map((b) => parseInt(b, 16)));
        const v4 = (b) => b.join(".");
        const address = bytes.length === 4 ? v4(bytes)
          : bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1 ? "::1"
          : bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255 ? v4(bytes.slice(12))
          : bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
        out.push({ address, port: parseInt(port, 16) });
      }
    }
    return out;
  }
  throw new Error(`no way to list listening sockets on ${process.platform}`);
}

const steps = [
  {
    n: 1,
    title: "Sphere up, team created, two Obis invited",
    async run() {
      ctx.port = REMOTE ? null : await freePort();
      ctx.operatorToken = REMOTE ? process.env.SPHERE_OPERATOR_TOKEN : randomBytes(32).toString("base64url");
      assert(ctx.operatorToken, "OBI_SPHERE_URL needs SPHERE_OPERATOR_TOKEN");
      ctx.base = REMOTE ?? `http://127.0.0.1:${ctx.port}`;
      ctx.client = new SphereClient(ctx.base, SPHERE.id);
      const c = ctx.client;
      // 1.1 Start it; within 60 seconds health answers.
      if (!REMOTE) sphereProcess = startSphere(ctx.port);
      const deadline = Date.now() + 60_000;
      let health;
      for (;;) {
        try {
          health = await c.call("GET", "/v0.1/health");
          if (health.status === 200) break;
        } catch {}
        assert(REMOTE || sphereProcess.exitCode === null, `the Sphere exited early (see ${join(R.harness, "sphere.log")})`);
        assert(Date.now() < deadline, "GET /v0.1/health didn't answer 200 within 60 seconds");
        await sleep(250);
      }
      // A Sphere that takes sealed words says `seal: true` (protocol.md section 9.1); one deployed before doesn't.
      assert(same({ seal: true, ...health.body }, { ok: true, protocol: "obi/0.1", seal: true }), `health: ${show(health.body)}`);
      // The features it takes and offers (sphere-api.md section 2): the phone relay, locally.
      if (!REMOTE) {
        const listed = await c.call("GET", "/v0.1/features");
        assert(listed.status === 200 && ["dpop", "phone_relay", "signin_providers", "sphere_url_aud"].every((id) => listed.body.features.includes(id)), `features: ${listed.status} ${show(listed.body)}`);
      }
      // 1.1b Nothing on the port reaches the D1 around the Sphere's checks: wrangler's Local
      // Explorer and local observability (on by default, no token, any SQL) are off, so their
      // paths are the Sphere's own 404.
      const D1_LOCAL_ID = "00000000-0000-0000-0000-000000000000";
      for (const [method, path, body] of [
        ["GET", "/cdn-cgi/local/explorer"],
        ["GET", "/cdn-cgi/local/explorer/api"],
        ["GET", "/cdn-cgi/local/explorer/api/d1/database"],
        ["POST", `/cdn-cgi/local/explorer/api/d1/database/${D1_LOCAL_ID}/raw`, { sql: "SELECT name FROM sqlite_master" }],
        ["POST", "/cdn-cgi/local/explorer/api/local/observability/query", { sql: "SELECT 1" }],
      ]) {
        const r = await c.call(method, path, body === undefined ? {} : { body });
        expectStatus(r, 404, `${method} ${path} (wrangler's Local Explorer must be off)`);
      }
      // 1.1c No DevTools inspector either (`wrangler dev` always opens one, no token, and a debugger
      // on it runs code in the Worker with the D1 binding): every port the Sphere's processes
      // listen on is on the loopback, and none answers as a DevTools endpoint.
      const sockets = REMOTE ? [] : listeningSockets(sphereProcess.pid);
      assert(REMOTE || sockets.some((x) => x.port === ctx.port), `the Sphere's own port ${ctx.port} isn't among its listening sockets: ${show(sockets)}`);
      for (const { address, port } of sockets) {
        assert(address === "127.0.0.1" || address === "::1", `the Sphere listens on ${address}:${port}, not on the loopback`);
        for (const path of ["/json/version", "/json/list"]) {
          const body = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000) }).then((res) => (res.ok ? res.text() : ""), () => "");
          assert(!/webSocketDebuggerUrl|devtoolsFrontendUrl|"Protocol-Version"/.test(body), `port ${port} answers ${path} as a DevTools inspector: ${body.slice(0, 200)}`);
        }
      }
      // 1.2 The Sphere, with wellington (W) as admin.
      ctx.W = new Owner(c, A.owner);
      ctx.E = new Owner(c, B.owner);
      const created = expectStatus(
        await c.call("POST", "/v0.1/spheres", { token: ctx.operatorToken, body: { sphere: SPHERE.id, name: SPHERE.name, admin: { owner: A.owner, owner_key: ctx.W.key.publicKey } } }),
        201, "POST /v0.1/spheres",
      );
      assert(created.sphere === SPHERE.id && created.admin_owner === "wellington" && created.protocol === "obi/0.1", `the Sphere: ${show(created)}`);
      // 1.3 The admin token: exactly `admin directory:read audit:read`.
      const admin = await ctx.W.token(ADMIN_SCOPES);
      assert(admin.token_type === "Bearer" && admin.scope === ADMIN_SCOPES, `the admin token: ${show({ ...admin, access_token: "…" })}`);
      ctx.admin = async () => (await ctx.W.token(ADMIN_SCOPES)).access_token;
      // 1.4 Invitations A and B.
      ctx.invitations = {};
      for (const o of [A, B]) {
        const inv = expectStatus(await c.call("POST", c.spherePath("/invitations"), { token: await ctx.admin(), body: { owner: o.owner, obi: o.obi, expires_in: 3600 } }), 201, `invitation for ${o.obi}`);
        assert(typeof inv.invitation_id === "string" && /^[A-Za-z0-9_-]{43}$/.test(inv.secret), `invitation for ${o.obi}: ${show(inv)}`);
        ctx.invitations[o.obi] = inv;
      }
      // 1.5 The policy: version 0 with no rules, then team-reviews at version 1.
      const p0 = expectStatus(await c.call("GET", c.spherePath("/policy"), { token: await ctx.admin() }), 200, "GET /policy");
      assert(p0.version === 0 && same(p0.rules, []), `policy before: ${show(p0)}`);
      const p1 = expectStatus(await c.call("PUT", c.spherePath("/policy"), { token: await ctx.admin(), body: { expected_version: 0, rules: POLICY_RULES } }), 200, "PUT /policy");
      assert(p1.version === 1 && same(p1.rules, POLICY_RULES), `policy after: ${show(p1)}`);
      // 1.6 An empty chain.
      const audit = expectStatus(await c.call("GET", c.spherePath("/audit"), { token: await ctx.admin() }), 200, "GET /audit");
      assert(same(audit.entries, []) && same(audit.head, { seq: 0, hash: ZERO }), `audit: ${show(audit)}`);
    },
  },
  {
    n: 2,
    title: "(the Sphere's side) both Obis paired",
    async run() {
      const c = ctx.client;
      ctx.A = new Obi(c, A.obi, ctx.W);
      ctx.B = new Obi(c, B.obi, ctx.E);
      for (const [obi, o] of [[ctx.A, A], [ctx.B, B]]) {
        // The card obid would make (step 2.3.2), signed by its owner (2.3.3), redeemed (the join).
        const card = obi.owner.card(obi, { name: o.name, accepts: o.accepts });
        const inv = ctx.invitations[o.obi];
        const member = expectStatus(await c.call("POST", c.spherePath(`/invitations/${inv.invitation_id}/redeem`), { body: { secret: inv.secret, owner_key: obi.owner.key.publicKey, card } }), 201, `redeem for ${o.obi}`);
        assert(member.status === "active" && member.obi === o.obi && member.keys.length === 1 && member.keys[0].key_id === obi.key.keyId, `member ${o.obi}: ${show(member)}`);
        obi.delegation = obi.owner.assertion(OBI_SCOPES, { lifetime: 3600, mayAct: o.obi });
        const t = await obi.exchange();
        assert(t.scope === OBI_SCOPES, `${o.obi}'s token scope: ${t.scope}`);
      }
      // 2.4 The directory.
      const members = expectStatus(await c.call("GET", c.spherePath("/members"), { token: await ctx.admin() }), 200, "GET /members").members;
      assert(members.length === 2, `two members, got ${members.length}`);
      for (const [obi, o] of [[ctx.A, A], [ctx.B, B]]) {
        const m = members.find((x) => x.obi === o.obi);
        assert(m && m.owner === o.owner && m.status === "active", `member ${o.obi}: ${show(m)}`);
        assert(same(m.keys, [{ key_id: obi.key.keyId, public_key: obi.key.publicKey, valid_from_seq: 1, valid_until_seq: null }]), `${o.obi}'s keys: ${show(m.keys)}`);
        const v = spec.verifyCard(m.card, { now: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), bound_owner_key: obi.owner.key.publicKey });
        assert(v.ok, `${o.obi}'s card fails verifyCard: ${v.code} ${v.message}`);
      }
      ctx.keys = directoryKeys(members);
    },
  },
  {
    n: 3,
    title: "B sends review_request via relay",
    async run() {
      const c = ctx.client;
      // 3.1 B's request X.
      ctx.X = ctx.B.request(A.obi, "review_request", BRIEF, EXPIRES_IN);
      const sent = expectStatus(await ctx.B.send(ctx.X), 202, "B's review_request");
      assert(sent.id === ctx.X.id && sent.seq === 1, `send answer: ${show(sent)}`);
      // A retry of the same bytes answers the same, recording nothing.
      const retry = expectStatus(await ctx.B.send(ctx.X), 200, "B's retry");
      assert(same(retry, sent), `retry answer: ${show(retry)}`);
      // 3.2 The audit chain: one entry, seq 1, deep-equal to B's message, verified as obi-wellington would.
      const audit = expectStatus(await c.call("GET", c.spherePath("/audit"), { token: await ctx.admin() }), 200, "GET /audit");
      assert(audit.entries.length === 1 && audit.entries[0].seq === 1, `entries: ${show(audit.entries.map((e) => e.seq))}`);
      const env = audit.entries[0].envelope;
      assert(same(env, ctx.X), "the entry's envelope isn't B's message");
      assert(env.type === "review_request" && env.from === B.obi && env.to === A.obi && env.id === ctx.X.id && env.correlation_id === ctx.X.id && env.key_id === ctx.B.key.keyId, `envelope: ${show(env)}`);
      assert(same(env.body, BRIEF), "the body isn't the brief");
      const members = expectStatus(await c.call("GET", c.spherePath("/members"), { token: await ctx.admin() }), 200, "GET /members").members;
      const v = spec.verifyEnvelope(env, { now: new Date().toISOString(), sphere: SPHERE.id, receiver: A.obi, keys: directoryKeys(members), seq: 1, seen_ids: [] });
      assert(v.ok, `verifyEnvelope: ${v.code} ${v.message}`);
    },
  },
  {
    n: 5,
    title: "(the Sphere's side) the typed result returned via relay",
    async run() {
      await exchange(ctx.X, {}, EXPECTED_RESULT, 1);
    },
  },
  {
    n: 6,
    title: "(the Sphere's side) the second exchange, accepted by rule",
    async run() {
      ctx.Y = ctx.B.request(A.obi, "review_request", BRIEF, EXPIRES_IN);
      const sent = expectStatus(await ctx.B.send(ctx.Y), 202, "B's second review_request");
      assert(sent.seq === 4, `second request's seq: ${sent.seq}`);
      await exchange(ctx.Y, { by_rule: D1 }, { ...EXPECTED_RESULT, by_rule: D1 }, 4);
    },
  },
  {
    n: 7,
    title: "audit chain holds both exchanges, signed by their senders, and verifies",
    async run() {
      const c = ctx.client;
      // 7.1
      const audit = expectStatus(await c.call("GET", c.spherePath("/audit?from_seq=1&limit=1000"), { token: await ctx.admin() }), 200, "GET /audit");
      const members = expectStatus(await c.call("GET", c.spherePath("/members"), { token: await ctx.admin() }), 200, "GET /members").members;
      // 7.2 The spec's verifier accepts the chain with every member's key history.
      const v = spec.verifyChain({ sphere: SPHERE.id, entries: audit.entries }, { keys: directoryKeys(members) });
      assert(v.ok, `verifyChain: ${v.code} ${v.message}`);
      // 7.3 Exactly the two exchanges, each envelope as its sender sent it.
      const sent = [...ctx.sentBy[ctx.X.id], ...ctx.sentBy[ctx.Y.id]];
      assert(audit.entries.length === sent.length, `${audit.entries.length} entries, ${sent.length} messages sent`);
      for (const [i, entry] of audit.entries.entries()) {
        assert(same(entry.envelope, sent[i]), `entry ${i + 1} isn't the message its sender sent`);
      }
      const shape = audit.entries.map((e) => `${e.envelope.type}:${e.envelope.from}:${e.envelope.key_id === (e.envelope.from === B.obi ? ctx.B.key.keyId : ctx.A.key.keyId)}`);
      const one = [`review_request:${B.obi}:true`, `accept:${A.obi}:true`, `result:${A.obi}:true`];
      assert(same(shape, [...one, ...one]), `entries: ${shape.join(", ")}`);
      assert(audit.entries.slice(0, 3).every((e) => e.envelope.correlation_id === ctx.X.id) && audit.entries.slice(3).every((e) => e.envelope.correlation_id === ctx.Y.id), "X then Y");
      assert(audit.head.seq === audit.entries.length && audit.head.hash === audit.entries.at(-1).hash, `head: ${show(audit.head)}`);
    },
  },
  {
    n: 8,
    title: "(the Sphere's side) clean exit on SIGTERM, nothing written outside its write root",
    async run() {
      signalGroup(sphereProcess, "SIGTERM");
      const exited = await Promise.race([sphereProcess.exited, sleep(10_000).then(() => null)]);
      assert(exited !== null, "the Sphere didn't exit within 10 seconds of SIGTERM");
      // Nothing it started (wrangler, workerd) still serves the port.
      let serving = true;
      for (const end = Date.now() + 10_000; serving && Date.now() < end; ) {
        serving = await ctx.client.call("GET", "/v0.1/health").then(() => true, () => false);
        if (serving) await sleep(250);
      }
      assert(!serving, "the Sphere's port still answers 10 seconds after SIGTERM");
      const after = snapshot(CHECKOUT);
      const changed = [];
      for (const [path, sig] of after) if (ctx.before.get(path) !== sig) changed.push(`${ctx.before.has(path) ? "changed" : "added"} ${path}`);
      for (const path of ctx.before.keys()) if (!after.has(path)) changed.push(`removed ${path}`);
      assert(changed.length === 0, `the obi-sphere checkout changed: ${changed.slice(0, 5).join(", ")}`);
      for (const [dir, before] of [[homedir(), ctx.homeNames], [tmpdir(), ctx.tmpNames]]) {
        const appeared = [...topNames(dir)].filter((n) => !before.has(n) && WATCHED_NAMES.test(n) && join(dir, n) !== RUN && !n.startsWith("obi-e2e-") && !n.startsWith("obi-sphere-e2e-"));
        assert(appeared.length === 0, `new in ${dir}: ${appeared.join(", ")}`);
      }
    },
  },
];

// Steps 5 and 6, the Sphere's side: A receives the request (verifying it as obi-wellington),
// acknowledges it, accepts with `acceptBody` and returns `resultBody`; B receives the accept and the
// result in order (verifying each as obi-ernesto, by its delivery's seq) and acknowledges them.
async function exchange(request, acceptBody, resultBody, requestSeq) {
  const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const [delivery] = await ctx.A.waitFor(1);
  assert(delivery.seq === requestSeq && same(delivery.envelope, request), `A's delivery: ${show({ seq: delivery.seq, id: delivery.envelope?.id })}`);
  const vA = spec.verifyEnvelope(delivery.envelope, { now: now(), sphere: SPHERE.id, receiver: A.obi, keys: ctx.keys, seq: delivery.seq, seen_ids: [] });
  assert(vA.ok, `A's verifyEnvelope: ${vA.code} ${vA.message}`);
  assert(expectStatus(await ctx.A.ack([delivery.delivery_id]), 200, "A's ack").acked === 1, "A's ack counted");
  assert((await ctx.A.deliveries()).body.deliveries.length === 0, "A still has deliveries after its ack");

  const accept = ctx.A.reply(request, "accept", acceptBody);
  const result = ctx.A.reply(request, "result", resultBody);
  expectStatus(await ctx.A.send(accept), 202, "A's accept");
  expectStatus(await ctx.A.send(result), 202, "A's result");
  ctx.sentBy ??= {};
  ctx.sentBy[request.id] = [request, accept, result];

  const got = await ctx.B.waitFor(2);
  assert(got.length === 2, `B got ${got.length} deliveries`);
  assert(same(got[0].envelope, accept) && same(got[1].envelope, result), "B's deliveries aren't A's accept then result");
  assert(got[0].seq === requestSeq + 1 && got[1].seq === requestSeq + 2, `seqs ${got.map((d) => d.seq)}`);
  assert(same(got[1].envelope.body, resultBody), "the result body isn't the expected one");
  for (const d of got) {
    const v = spec.verifyEnvelope(d.envelope, { now: now(), sphere: SPHERE.id, receiver: B.obi, keys: ctx.keys, seq: d.seq, seen_ids: [] });
    assert(v.ok, `B's verifyEnvelope (${d.envelope.type}): ${v.code} ${v.message}`);
    assert(d.relayed_at && typeof d.delivery_id === "string", `delivery: ${show(d)}`);
  }
  assert(expectStatus(await ctx.B.ack(got.map((d) => d.delivery_id)), 200, "B's ack").acked === 2, "B's ack counted");
  // Nothing more may follow a result.
  const after = await ctx.A.send(ctx.A.reply(request, "status", { state: "working" }));
  assert(after.status === 409 && after.body.error.code === "bad_reply", `a status after the result: ${after.status} ${show(after.body)}`);
}

async function main() {
  console.log("Obi Sphere: the scenario's Sphere-side steps, with a scripted client");
  console.log(`  server   ${REMOTE ? `${REMOTE}, Sphere ${SPHERE.id} (step 8 is local-only)` : SERVER_DIR}`);
  console.log(`  run      ${RUN}`);
  console.log(`  fixtures ${FIXTURES.checkedAgainst ? `match obi's, in ${FIXTURES.checkedAgainst}` : "the copies in e2e/fixtures/, not checked: no obi checkout (set OBI_DIR)"}`);
  ctx.before = snapshot(CHECKOUT);
  ctx.homeNames = topNames(homedir());
  ctx.tmpNames = topNames(tmpdir());
  let failed = 0;
  let blocked = null;
  for (const step of REMOTE ? steps.filter((s) => s.n !== 8) : steps) {
    const label = `step ${step.n} (${step.title})`;
    if (blocked) {
      console.log(`  SKIP  ${label}: not run, step ${blocked} failed`);
      failed++;
      continue;
    }
    const t0 = Date.now();
    try {
      await step.run();
      console.log(`  PASS  ${label} [${((Date.now() - t0) / 1000).toFixed(1)}s]`);
    } catch (e) {
      failed++;
      blocked = step.n;
      console.log(`  FAIL  ${label}: ${e.message}`);
      // The Sphere's own log, which says why when it is the Sphere that failed.
      const log = join(R.harness, "sphere.log");
      if (existsSync(log)) console.log(`  --- the last lines of ${log}:\n${readFileSync(log, "utf8").split("\n").slice(-40).map((l) => `      ${l}`).join("\n")}`);
    }
  }
  return failed;
}

let failures = 1;
try {
  failures = await main();
} finally {
  if (sphereProcess && sphereProcess.exitCode === null && sphereProcess.signalCode === null) {
    signalGroup(sphereProcess, "SIGTERM");
    await Promise.race([sphereProcess.exited, sleep(10_000)]);
    signalGroup(sphereProcess, "SIGKILL");
  }
  if (process.env.OBI_SPHERE_E2E_KEEP === "1" || failures) console.log(`Kept ${RUN} (the Sphere's log is harness/sphere.log).`);
  else rmSync(RUN, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} step(s) failed.` : "\nAll steps passed.");
process.exit(failures ? 1 : 0);

