#!/usr/bin/env node
// Run by scripts/local.mjs only (`node scripts/serve-local.mjs <port> <persist-to>`), after the
// migrations: the Sphere's Worker on 127.0.0.1:<port>, its D1 under <persist-to>, through wrangler's
// programmatic dev server (`unstable_startWorker`, what `wrangler dev` itself runs on) so that it
// can be started with no DevTools inspector, which `wrangler dev` has no flag for (see local.mjs).
// Also: no dev registry (other local `wrangler dev`s can't bind to this Worker), no file watching,
// no hotkeys. The operator token comes from SPHERE_OPERATOR_TOKEN as a Worker secret, never a file.
// local.mjs sets wrangler's environment (no metrics, no Local Explorer, no local observability) and
// owns the signals: SIGINT or SIGTERM stops this process, and wrangler's exit hook stops workerd.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const server = join(dirname(fileURLToPath(import.meta.url)), "..");
const [port, persistTo] = process.argv.slice(2);
if (!/^[0-9]{1,5}$/.test(port ?? "") || !persistTo) {
  console.error("serve-local: run it through `pnpm run local` (scripts/local.mjs)");
  process.exit(64);
}
if (process.env.X_LOCAL_EXPLORER !== "false" || process.env.X_LOCAL_OBSERVABILITY !== "false") {
  console.error("serve-local: wrangler's Local Explorer must be off; run it through `pnpm run local`");
  process.exit(64);
}
delete process.env.VSCODE_INSPECTOR_OPTIONS;
process.chdir(server);

const { unstable_startWorker: startWorker } = createRequire(import.meta.url)("wrangler");
const token = process.env.SPHERE_OPERATOR_TOKEN;
let worker;
try {
  worker = await startWorker({
    config: join(server, "wrangler.jsonc"),
    // The operator token as a secret; PUBLIC_ORIGIN, when given, the origin public links are served
    // on (spec/sphere-api.md section 11), like http://localhost:<port> beside the API's 127.0.0.1.
    bindings: {
      ...(token ? { SPHERE_OPERATOR_TOKEN: { type: "secret_text", value: token } } : {}),
      ...(process.env.PUBLIC_ORIGIN ? { PUBLIC_ORIGIN: { type: "plain_text", value: process.env.PUBLIC_ORIGIN } } : {}),
    },
    dev: {
      remote: false,
      server: { hostname: "127.0.0.1", port: Number(port) },
      inspector: false,
      persist: persistTo,
      registry: undefined,
      watch: false,
      liveReload: false,
    },
  });
  const url = await worker.url;
  const inspector = await worker.inspectorUrl;
  if (inspector) throw new Error(`wrangler opened an inspector at ${inspector.href}`);
  console.log(`local: the Sphere is on ${url.origin}, its D1 under ${persistTo}, no inspector`);
} catch (e) {
  console.error(`local: the Worker didn't start: ${e?.message ?? e}`);
  if (worker) await worker.dispose().catch(() => {});
  process.exit(1);
}
