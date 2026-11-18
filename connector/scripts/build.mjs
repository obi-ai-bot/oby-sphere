#!/usr/bin/env node
// `pnpm run build` (and `pnpm pack`, which runs it first): the client library's schemas compiled
// (../client/scripts/gen.mjs), then the connector and the library bundled into one file,
// dist/obysphere-connector.mjs, which needs nothing but Node: what `npx <path>` runs.

import { execFileSync } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const connector = join(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [join(connector, "..", "client", "scripts", "gen.mjs")], { stdio: "inherit" });
rmSync(join(connector, "dist"), { recursive: true, force: true });
const out = join(connector, "dist", "obysphere-connector.mjs");
await build({
  entryPoints: [join(connector, "src", "main.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  logLevel: "warning",
});
chmodSync(out, 0o755);
console.log(`build: ${out}`);
