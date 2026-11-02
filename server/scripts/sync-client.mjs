#!/usr/bin/env node
// The server's protocol code is the client library's (client/src), so each rule has one
// implementation. This copies the library's protocol modules into src/protocol/lib/, each under a
// line saying where it comes from, so the server (the Worker and the Docker image, both built from
// server/ alone) needs nothing outside server/. src/protocol/lib/schemas.ts is the server's own: it
// gives those modules the server's compiled validators under the schema names the library uses.
//
//   node scripts/sync-client.mjs           copy them (after changing client/src)
//   node scripts/sync-client.mjs --check   fail if a copy differs from client/src
//
// Edit the rules in client/src, never in src/protocol/lib/: the check (CI's "The protocol code is
// the client library's") refuses a copy that differs.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const server = join(dirname(fileURLToPath(import.meta.url)), "..");
const client = join(server, "..", "client", "src");
const lib = join(server, "src", "protocol", "lib");
export const MODULES = ["json.ts", "crypto.ts", "rules.ts", "envelope.ts", "card.ts", "chain.ts", "jws.ts"];

const copyOf = (name) => `// Copied from client/src/${name} by server/scripts/sync-client.mjs: edit it there, then run \`pnpm run sync:client\`.\n` + readFileSync(join(client, name), "utf8");

if (process.argv.includes("--check")) {
  const stale = MODULES.filter((name) => {
    try {
      return readFileSync(join(lib, name), "utf8") !== copyOf(name);
    } catch {
      return true;
    }
  });
  if (stale.length) {
    console.error(`${stale.map((n) => relative(process.cwd(), join(lib, n))).join(", ")} differ from client/src: run \`pnpm run sync:client\` and commit them (and edit the rules in client/src, never in src/protocol/lib).`);
    process.exit(1);
  }
  console.log(`src/protocol/lib matches client/src (${MODULES.length} modules).`);
} else {
  mkdirSync(lib, { recursive: true });
  for (const name of MODULES) writeFileSync(join(lib, name), copyOf(name));
  console.log(`copied ${MODULES.length} modules from client/src into ${relative(process.cwd(), lib)}`);
}
