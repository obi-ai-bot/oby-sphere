#!/usr/bin/env node
// `pnpm run e2e`: #55's "done when" against a real local Sphere. It starts one exactly as
// spec/sphere-api.md section 8 says (server/scripts/local.mjs, a fresh operator token in its
// environment only), runs examples/ask-and-answer.ts against it, checks the chain the example
// wrote with the spec's own reference verifier (spec/conformance/lib/obi.mjs, verifyChain), and
// stops the Sphere. Needs ../server's and ../spec's packages installed.
//
//   node e2e/run.mjs [--port 8792] [--persist-to <dir>]     (default: a free port, a fresh folder)

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(CLIENT, "..", "server");
const SPEC = join(CLIENT, "..", "spec");
const args = process.argv.slice(2).filter((a) => a !== "--");
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const freePort = () => new Promise((done) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => done(port));
  });
});

const run = mkdtempSync(join(tmpdir(), "obysphere-client-e2e-"));
const port = Number(opt("--port") ?? (await freePort()));
const state = resolve(opt("--persist-to") ?? join(run, "state"));
for (const dir of [state, join(run, "home"), join(run, "tmp")]) mkdirSync(dir, { recursive: true });
const operatorToken = randomBytes(32).toString("base64url");
const base = `http://127.0.0.1:${port}`;

const log = createWriteStream(join(run, "sphere.log"));
const sphere = spawn(process.execPath, ["scripts/local.mjs", "--port", String(port), "--persist-to", state], {
  cwd: SERVER, detached: true, stdio: ["ignore", "pipe", "pipe"],
  env: { SPHERE_OPERATOR_TOKEN: operatorToken, HOME: join(run, "home"), TMPDIR: join(run, "tmp"), WRANGLER_SEND_METRICS: "false", PATH: process.env.PATH },
});
sphere.stdout.pipe(log);
sphere.stderr.pipe(log);
const exited = new Promise((done) => sphere.on("exit", (code, signal) => done({ code, signal })));
const stop = async () => {
  try {
    process.kill(-sphere.pid, "SIGTERM");
  } catch {}
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
};

let status = 1;
try {
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      if ((await fetch(`${base}/v0.1/health`)).status === 200) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`the Sphere didn't answer health within 90 seconds; its log: ${join(run, "sphere.log")}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`A local Sphere at ${base} (node server/scripts/local.mjs --port ${port} --persist-to ${state})`);

  const chainFile = join(run, "chain.json");
  const example = spawn(process.execPath, [join(CLIENT, "examples", "ask-and-answer.ts"), "--chain-out", chainFile], {
    stdio: "inherit", env: { ...process.env, OBYSPHERE_URL: base, SPHERE_OPERATOR_TOKEN: operatorToken },
  });
  const code = await new Promise((done) => example.on("exit", done));
  if (code !== 0) throw new Error(`the example exited ${code}`);

  const { chain, keys } = JSON.parse(readFileSync(chainFile, "utf8"));
  const spec = await import(pathToFileURL(join(SPEC, "conformance", "lib", "obi.mjs")).href);
  const verdict = spec.verifyChain(chain, { keys });
  console.log(`\nThe spec's reference verifyChain (spec/conformance/lib/obi.mjs) on the same ${chain.entries.length} entries: ${JSON.stringify(verdict)}`);
  if (!verdict.ok) throw new Error("the reference verifier refuses the chain");
  status = 0;
} catch (e) {
  console.error(`FAIL: ${e.message}`);
} finally {
  await stop();
  if (status === 0 && !opt("--persist-to")) rmSync(run, { recursive: true, force: true });
  else console.error(`run folder kept: ${run}`);
}
process.exit(status);
