#!/usr/bin/env node
// `pnpm run build` (and `pnpm pack`, which runs it first): the schemas compiled (scripts/gen.mjs),
// the sources compiled to dist/ as JavaScript with their types, and the generated module copied
// beside them. What `pnpm pack` puts in the package is dist/ and the README.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const client = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(client, "dist");
rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [join(client, "scripts", "gen.mjs")], { stdio: "inherit" });
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
execFileSync(process.execPath, [tsc, "-p", join(client, "tsconfig.build.json")], { stdio: "inherit" });
mkdirSync(join(dist, "generated"), { recursive: true });
for (const f of ["spec.js", "spec.d.ts"]) copyFileSync(join(client, "src", "generated", f), join(dist, "generated", f));
console.log(`build: ${dist}`);
