// The outgoing scan: what it stops, what it lets through, and that it never repeats a match.

import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { builtinScan, scanOutgoing, strings } from "../src/scan.ts";

const token = (prefix: string, n: number) => prefix + randomBytes(n).toString("base64").replace(/[^A-Za-z0-9]/g, "x").slice(0, n);

test("the built-in rules stop common secrets, wherever they are in the body", () => {
  const cases: [string, string][] = [
    [`see ${token("ghp_", 36)}`, "github-token"],
    [`key ${token("sk-ant-api03-", 40)}`, "anthropic-key"],
    // Made at run time, so this file holds no string a scanner takes for a key.
    [`${"AKIA"}${randomBytes(10).toString("hex").toUpperCase().slice(0, 16)} in prod`, "aws-access-key-id"],
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nabc", "private-key"],
    ["postgres://app:hunter2hunter2@db.internal/app", "credentials-in-url"],
    ["password = Tr0ub4dor&3xyz", "secret-assignment"],
    [`token ${token("xoxb-", 30)}`, "slack-token"],
    [`eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${token("", 30)}`, "jwt"],
    [`a random ${token("", 40)}`, "high-entropy-string"],
  ];
  for (const [text, rule] of cases) {
    const found = builtinScan(strings({ summary: "fine", findings: [{ detail: text }] }));
    assert.ok(found.some((f) => f.rule === rule && f.field === "/findings/0/detail"), `${rule}: ${JSON.stringify(found)}`);
  }
});

test("ordinary words, commit ids and identifiers pass", () => {
  const body = {
    goal: "Fix the cache key so two tenants never share an entry", repo: "acme/app", head_sha: "4f1c0e2a9b7d3c5e6f8a1b2c3d4e5f60718293a4",
    summary: "The token: rotation happens nightly. Passwords are hashed with scrypt.", text: "Is PR 7 ready to merge?",
  };
  assert.deepEqual(builtinScan(strings(body)), []);
});

test("this member's own secrets never leave, matched exactly", () => {
  const seed = randomBytes(32).toString("base64url");
  assert.deepEqual(builtinScan([{ field: "/text", text: `x ${seed.slice(0, 20)}` }], [seed]).filter((f) => f.rule === "this-member's-own-secret"), []);
  assert.ok(builtinScan([{ field: "/text", text: `here: ${seed}.` }], [seed]).some((f) => f.rule === "this-member's-own-secret"));
});

test("a finding names the rule and the field, never the match", async () => {
  const secret = token("ghp_", 36);
  const r = await scanOutgoing({ text: `use ${secret}` }, { gitleaks: "off" });
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes(secret));
});

test("a scan that must use gitleaks and can't, or whose gitleaks fails, lets nothing out", async () => {
  const missing = await scanOutgoing({ text: "hello" }, { gitleaks: "required", gitleaksPath: "/nonexistent/gitleaks" });
  assert.equal(missing.ok, false);
  assert.match(missing.error!, /required/);
  const dir = mkdtempSync(join(tmpdir(), "obysphere-scan-"));
  try {
    const failing = join(dir, "gitleaks");
    writeFileSync(failing, "#!/bin/sh\nexit 2\n");
    chmodSync(failing, 0o700);
    const broken = await scanOutgoing({ text: "hello" }, { gitleaks: "auto", gitleaksPath: failing });
    assert.equal(broken.ok, false);
    assert.match(broken.error!, /couldn't run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const off = await scanOutgoing({ text: "hello" }, { gitleaks: "off" });
  assert.equal(off.ok, true);
});

test("with gitleaks installed, it runs too and maps what it finds to the field", { skip: !(process.env.PATH ?? "").split(":").some((d) => existsSync(join(d, "gitleaks"))) && "gitleaks isn't installed" }, async () => {
  const r = await scanOutgoing({ text: "fine", summary: `line one\nuse ${token("glpat-", 20)}` }, { gitleaks: "required" });
  assert.ok(r.scanners.includes("gitleaks"));
  assert.ok(r.findings.some((f) => f.rule.startsWith("gitleaks:") && f.field === "/summary"), JSON.stringify(r.findings));
});
