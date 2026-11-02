#!/usr/bin/env node
// `pnpm run conformance`: the spec's conformance runner, in implementation mode, against the
// server's checker (conformance/check.ts), for the case kinds a Sphere judges: envelopes, cards,
// chains, wire bodies and the A2A binding's sends (not host_approval, a receiving Oby's own decision);
// then the A2A binding's known answers (a2a-vectors.json), by the server's own task view. Extra
// arguments go to the runner (like --verbose). Needs ../spec's packages installed
// (`pnpm install --frozen-lockfile` in spec/).

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const server = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = join(server, "..", "spec");
const checker = `"${process.execPath}" "${join(server, "conformance", "check.ts")}"`;
const args = process.argv.slice(2).filter((a) => a !== "--");
const r = spawnSync(process.execPath, [join(spec, "conformance", "run.mjs"), "--impl", checker, "--kinds", "envelope,card,audit,wire,a2a", ...args], { cwd: spec, stdio: "inherit" });
// Then the A2A binding's known answers, by the server's own task view (conformance/a2a-vectors.ts).
const v = spawnSync(process.execPath, [join(server, "conformance", "a2a-vectors.ts")], { stdio: "inherit" });
process.exit(r.status === 0 && v.status === 0 ? 0 : 1);
