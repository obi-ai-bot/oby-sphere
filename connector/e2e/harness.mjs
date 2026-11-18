// What the connector's end-to-end runs share: a local Sphere started as spec/sphere-api.md
// section 8 says, a team the scripted client of server/e2e/client.mjs makes and plays (standing in
// for an Oby), and the connector's CLI run as its owner runs it.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CONNECTOR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SERVER = join(CONNECTOR, "..", "server");
export const ref = await import(pathToFileURL(join(SERVER, "e2e", "client.mjs")).href);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((done) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => done(port));
  });
});

/** A local Sphere in a fresh run folder; `stop()` ends it. */
export async function startSphere({ port, prefix }) {
  const run = mkdtempSync(join(tmpdir(), prefix));
  port = Number(port ?? (await freePort()));
  const base = `http://127.0.0.1:${port}`;
  const operatorToken = randomBytes(32).toString("base64url");
  for (const d of ["state", "home", "tmp"]) mkdirSync(join(run, d), { recursive: true });
  const log = createWriteStream(join(run, "sphere.log"));
  const proc = spawn(process.execPath, ["scripts/local.mjs", "--port", String(port), "--persist-to", join(run, "state")], {
    cwd: SERVER, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { SPHERE_OPERATOR_TOKEN: operatorToken, HOME: join(run, "home"), TMPDIR: join(run, "tmp"), WRANGLER_SEND_METRICS: "false", PATH: process.env.PATH },
  });
  proc.stdout.pipe(log);
  proc.stderr.pipe(log);
  const exited = new Promise((done) => proc.on("exit", done));
  const stop = async () => {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {}
    await Promise.race([exited, sleep(10000)]);
  };
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      if ((await fetch(`${base}/v0.1/health`)).status === 200) break;
    } catch {}
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`the Sphere didn't answer health within 90 seconds; its log: ${join(run, "sphere.log")}`);
    }
    await sleep(500);
  }
  return { run, port, base, operatorToken, stop };
}

/**
 * The Oby's side: it makes the Sphere (its owner `ada` the admin), a policy for questions, reviews
 * and handoffs, an invite link for two, and joins as `oby-ada` itself.
 */
export async function makeTeam(sphere) {
  const id = `conn-${randomBytes(3).toString("hex")}`;
  const client = new ref.SphereClient(sphere.base, id);
  const ada = new ref.Owner(client, "ada");
  const made = await client.call("POST", "/v0.1/spheres", { token: sphere.operatorToken, body: { sphere: id, name: "Connector e2e", admin: { owner: "ada", owner_key: ada.key.publicKey } } });
  if (made.status !== 201) throw new Error(`making the Sphere: ${made.status} ${JSON.stringify(made.body)}`);
  const adminToken = (await ada.token()).access_token;
  const policy = await client.call("PUT", client.spherePath("/policy"), {
    token: adminToken, body: { expected_version: 0, rules: [{ id: "team", from_owner: "*", to_owner: "*", actions: ["question", "review_request", "handoff"], repos: ["*"] }] },
  });
  if (policy.status !== 200) throw new Error(`the policy: ${policy.status}`);
  const inv = (await client.call("POST", client.spherePath("/invitations"), { token: adminToken, body: { expires_in: 3600, max_uses: 2 } })).body;
  const link = `${sphere.base}/join#sphere=${id}&name=${encodeURIComponent("Connector e2e")}&by=ada&id=${inv.invitation_id}&secret=${inv.secret}`;
  const oby = new ref.Obi(client, "oby-ada", ada);
  const card = ada.card(oby, { name: "Ada's Oby", accepts: ["question", "review_request", "handoff"] });
  const redeemed = await client.call("POST", client.spherePath(`/invitations/${inv.invitation_id}/redeem`), { body: { secret: inv.secret, owner_key: ada.key.publicKey, card } });
  if (redeemed.status !== 201) throw new Error(`the Oby's redeem: ${redeemed.status}`);
  oby.delegation = ada.assertion("send:review_request send:question send:handoff reply receive directory:read audit:read", { lifetime: 3600, mayAct: oby.id });
  await oby.exchange();
  return { id, client, ada, oby, link };
}

/** The connector's CLI, as its owner runs it, against the member's folder `home`. */
export function connectorCli(entry, home, userHome, argv, input) {
  const r = spawnSync(process.execPath, [entry, ...argv, "--home", home], { input, encoding: "utf8", env: { PATH: process.env.PATH, HOME: userHome } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** The chain from seq 1 and every member's keys, checked with the spec's verifyChain. */
export async function verifyWholeChain(team) {
  const { client, oby } = team;
  const audit = (await client.call("GET", client.spherePath("/audit?limit=1000"), { token: oby.accessToken })).body;
  const keys = ref.directoryKeys((await client.call("GET", client.spherePath("/members"), { token: oby.accessToken })).body.members);
  return { entries: audit.entries, keys, verdict: ref.spec.verifyChain({ sphere: team.id, entries: audit.entries }, { keys }) };
}
