// The Sphere as one Node process (node/main.ts, what the container image runs), started for real on
// a free port with its own data folder: the claim, the HTTPS rule, the phone relay's sockets, and a
// restart that keeps the claim and the Spheres. The protocol itself is the scenario's job:
// `OBI_SPHERE_URL=http://127.0.0.1:<port> node e2e/scenario.mjs` against a claimed one.
//
//   pnpm run test:node       (node --test e2e/node-sphere.test.mjs)

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Obi, Owner, SphereClient } from "./client.mjs";

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const data = mkdtempSync(join(tmpdir(), "obi-sphere-node-"));
const operatorToken = randomBytes(32).toString("base64url");
let sphere = null;
after(() => {
  sphere?.kill();
  rmSync(data, { recursive: true, force: true });
});

const freePort = () =>
  new Promise((done) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });

/** Starts the Sphere and answers its port and the claim code it printed (null when it printed none). */
async function start() {
  const port = await freePort();
  sphere = spawn(process.execPath, [join(SERVER_DIR, "node", "main.ts")], {
    env: { PATH: process.env.PATH, PORT: String(port), SPHERE_DATA: data, SPHERE_URL: `http://127.0.0.1:${port}` },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let log = "";
  await new Promise((ready, failed) => {
    sphere.stdout.on("data", (chunk) => {
      log += chunk;
      if (log.includes("sphere: listening")) ready();
    });
    sphere.on("exit", (code) => failed(new Error(`the Sphere exited (${code}) before listening:\n${log}`)));
  });
  return { port, code: /\/claim#([A-Za-z0-9_-]+)/.exec(log)?.[1] ?? null };
}

async function stop() {
  const exited = new Promise((done) => sphere.on("exit", done));
  sphere.kill("SIGTERM");
  assert.equal(await exited, 0, "a clean exit on SIGTERM");
}

/** Opens a relay socket and answers it once open, with what it receives and how it closed. */
function socket(port, relay, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v0.1/relay/${relay}`, { headers: { Authorization: `Bearer ${token}` } });
  const got = [];
  const waiters = [];
  ws.on("message", (data, binary) => {
    got.push(binary ? new Uint8Array(data) : data.toString());
    waiters.splice(0).forEach((w) => w());
  });
  ws.closed = new Promise((done) => ws.on("close", (code, reason) => done({ code, reason: reason.toString() })));
  ws.next = async () => {
    while (!got.length) await new Promise((w) => waiters.push(w));
    return got.shift();
  };
  return new Promise((opened, failed) => {
    ws.on("open", () => opened(ws));
    ws.on("unexpected-response", (_, res) => failed(new Error(`the relay answered ${res.statusCode}`)));
  });
}

test("a Node Sphere is claimed once, answers only over HTTPS, relays, and keeps both across a restart", async () => {
  let { port, code } = await start();
  assert.ok(code, "an unclaimed Sphere prints its claim link");
  const base = `http://127.0.0.1:${port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });

  // Unclaimed: health and the claim answer, nothing else does.
  assert.equal((await fetch(`${base}/v0.1/health`)).status, 200);
  const listed = (await (await fetch(`${base}/v0.1/features`)).json()).features;
  for (const id of ["dpop", "phone_relay", "signin_providers", "sphere_url_aud"]) assert.ok(listed.includes(id), `features: ${listed}`);
  const claimPage = await fetch(`${base}/claim`);
  assert.equal(claimPage.status, 200);
  // The page says how to claim it with curl, for any operator; its one script is the one the CSP allows.
  const page = await claimPage.text();
  assert.match(page, /curl -sS --fail-with-body --data @- -H 'Content-Type: application\/json' <span id="host"><\/span>\/v0\.1\/claim &&/);
  const script = /<script>(.*)<\/script>/s.exec(page)[1];
  assert.ok(claimPage.headers.get("Content-Security-Policy").includes(`'sha256-${createHash("sha256").update(script).digest("base64")}'`));
  const early = await post("/v0.1/spheres", {}, { Authorization: `Bearer ${operatorToken}` });
  assert.equal(early.status, 403);
  assert.match((await early.json()).error.message, /isn't claimed yet/);

  // The claim: the right code, a token long enough, once. Only the token's hash is kept, 0600.
  assert.equal((await post("/v0.1/claim", { code: "wrong", operator_token: operatorToken })).status, 401);
  assert.equal((await post("/v0.1/claim", { code, operator_token: "short" })).status, 400);
  assert.equal((await post("/v0.1/claim", { code, operator_token: operatorToken })).status, 200);
  assert.equal((await post("/v0.1/claim", { code, operator_token: operatorToken })).status, 409);
  const kept = join(data, "operator-token.sha256");
  assert.equal((statSync(kept).mode & 0o777).toString(8), "600");
  assert.equal(readFileSync(kept, "utf8").trim(), createHash("sha256").update(operatorToken).digest("hex"));

  // HTTPS only: a proxy that says the client came over plain HTTP is refused, health aside.
  assert.equal((await fetch(`${base}/v0.1/spheres/team`, { headers: { "X-Forwarded-Proto": "http" } })).status, 403);
  assert.equal((await fetch(`${base}/v0.1/health`, { headers: { "X-Forwarded-Proto": "http" } })).status, 200);

  // A Sphere, and Wellington's Mac: an Obi's token with `receive`.
  const c = new SphereClient(base, "team");
  const W = new Owner(c, "wellington");
  assert.equal((await c.call("POST", "/v0.1/spheres", { token: operatorToken, body: { sphere: "team", name: "Team", admin: { owner: "wellington", owner_key: W.key.publicKey } } })).status, 201);
  const admin = (await W.token("admin directory:read audit:read")).access_token;
  const inv = (await c.call("POST", c.spherePath("/invitations"), { token: admin, body: { owner: "wellington", obi: "obi-wellington", expires_in: 3600 } })).body;
  const mac = new Obi(c, "obi-wellington", W);
  const card = W.card(mac, { name: "Wellington's Obi", accepts: ["review_request"] });
  assert.equal((await c.call("POST", c.spherePath(`/invitations/${inv.invitation_id}/redeem`), { body: { secret: inv.secret, owner_key: W.key.publicKey, card } })).status, 201);
  mac.delegation = W.assertion("receive directory:read", { lifetime: 3600, mayAct: "obi-wellington" });
  const macToken = (await mac.exchange()).access_token;

  // The phone relay: the Mac and a paired phone pass sealed frames through it, unchanged.
  const relay = randomBytes(16).toString("base64url");
  const phoneToken = randomBytes(32).toString("base64url");
  const device = createHash("sha256").update(phoneToken).digest("hex");
  assert.equal((await c.call("PUT", `/v0.1/relay/${relay}`, { token: macToken })).status, 201);
  assert.equal((await c.call("PUT", `/v0.1/relay/${relay}/devices/${device}`, { token: macToken })).status, 201);
  const macSocket = await socket(port, relay, macToken);
  const phone = await socket(port, relay, phoneToken);
  assert.deepEqual(JSON.parse(await macSocket.next()), { device, peer: "joined" });
  phone.send(Uint8Array.of(1, 2, 3));
  assert.deepEqual(await macSocket.next(), Uint8Array.from([...Buffer.from(device, "hex"), 1, 2, 3]));
  macSocket.send(Uint8Array.from([...Buffer.from(device, "hex"), 4, 5]));
  assert.deepEqual(await phone.next(), Uint8Array.of(4, 5));
  phone.send("ping");
  assert.equal(await phone.next(), "pong");
  // Forgetting the phone closes its socket, and the Mac hears it left.
  assert.equal((await c.call("DELETE", `/v0.1/relay/${relay}/devices/${device}`, { token: macToken })).status, 204);
  assert.deepEqual(await phone.closed, { code: 4001, reason: "this phone was forgotten" });
  assert.deepEqual(JSON.parse(await macSocket.next()), { device, peer: "left" });
  macSocket.close();
  await macSocket.closed;

  // A restart: no new claim link, the operator token still works, and the Sphere is still there.
  await stop();
  ({ port, code } = await start());
  assert.equal(code, null, "a claimed Sphere prints no claim link");
  const again = new SphereClient(`http://127.0.0.1:${port}`, "team");
  const taken = await again.call("POST", "/v0.1/spheres", { token: operatorToken, body: { sphere: "team", name: "Team", admin: { owner: "wellington", owner_key: W.key.publicKey } } });
  assert.equal(taken.status, 409, "the Sphere made before the restart is kept");
  await stop();
});
