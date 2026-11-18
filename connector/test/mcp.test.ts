// The MCP surface: the tools a host sees, and that the server speaks only JSON-RPC on stdout.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../src/mcp.ts";

const MAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main.ts");

test("six tools, each with an object input schema and a description", () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ["members", "ask", "request_review", "hand_off", "inbox", "reply"]);
  for (const t of TOOLS) {
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.description.length > 20);
  }
});

test("no tool lets the host's agent approve, decline for the owner, or change the rules", () => {
  const names = TOOLS.map((t) => t.name).join(" ");
  assert.ok(!/approve|rules|decide|renew/.test(names));
  const reply = TOOLS.find((t) => t.name === "reply")!;
  assert.ok(!JSON.stringify(reply.inputSchema).includes("owner_declined"));
});

test("mcp without a membership says so on stderr and writes nothing on stdout", () => {
  const home = mkdtempSync(join(tmpdir(), "obysphere-connector-test-"));
  try {
    const r = spawnSync(process.execPath, [MAIN, "mcp", "--home", home], { input: "", encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /join first/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an unknown command prints the usage and exits 64", () => {
  const r = spawnSync(process.execPath, [MAIN, "nope"], { encoding: "utf8" });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /obysphere-connector join <invite link>/);
});
