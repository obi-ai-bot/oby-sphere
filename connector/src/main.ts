#!/usr/bin/env node
// obysphere-connector: join an Obysphere from any MCP host (cli.ts has the commands).

import { main } from "./cli.ts";
import { ConnectorError } from "./connector.ts";

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write((e instanceof ConnectorError ? e.message : `obysphere-connector: ${(e as Error).message}`) + "\n");
  process.exit(1);
});
