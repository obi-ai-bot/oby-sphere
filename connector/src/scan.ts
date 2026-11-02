// The secret scan every outgoing message passes before it leaves (protocol.md section 11, step 8):
// every string of its body, before it is sealed. Built-in rules always run; gitleaks runs too when
// it is installed (or must, with `gitleaks: "required"`). A possible secret, or a scan that can't
// run, means nothing is sent. What it reports names the rule and the field, never the match.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "@obysphere/client";

export interface ScanFinding {
  rule: string;
  field: string;
}

export interface ScanResult {
  ok: boolean;
  findings: ScanFinding[];
  /** Why the scan couldn't run, when it couldn't: then nothing may be sent. */
  error?: string;
  scanners: string[];
}

export interface ScanOptions {
  /** `auto`: gitleaks when it is on PATH; `required`: it must run; `off`: the built-in rules alone. */
  gitleaks?: "auto" | "required" | "off";
  /** The gitleaks binary (default: `gitleaks` on PATH). */
  gitleaksPath?: string;
  /** Values that must never leave, matched exactly: this member's own keys, tokens and delegation. */
  never?: string[];
}

const RULES: [string, RegExp][] = [
  ["private-key", /-----BEGIN[A-Z ]{0,40}PRIVATE KEY( BLOCK)?-----/],
  ["aws-access-key-id", /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ["slack-token", /\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b|hooks\.slack\.com\/services\/[A-Za-z0-9/]+/],
  ["stripe-key", /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai-key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["credentials-in-url", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i],
  ["secret-assignment", /\b(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth)\b["']?\s*[:=]\s*["']?(?=[^\s"']*[0-9])[^\s"']{12,}/i],
];

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/** A long token mixing upper and lower case and digits with high entropy: a key or a token, not a word or a commit id. */
function highEntropy(text: string): boolean {
  for (const m of text.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) {
    const t = m[0];
    if (/^[0-9a-f]+$/i.test(t)) continue;
    if (!/[A-Z]/.test(t) || !/[a-z]/.test(t) || !/[0-9]/.test(t)) continue;
    if (entropy(t) >= 4.2) return true;
  }
  return false;
}

/** Every string in `value`, with its JSON Pointer. */
export function strings(value: Json, pointer = ""): { field: string; text: string }[] {
  if (typeof value === "string") return [{ field: pointer || "/", text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${pointer}/${i}`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => strings(v, `${pointer}/${k.replaceAll("~", "~0").replaceAll("/", "~1")}`));
  return [];
}

export function builtinScan(values: { field: string; text: string }[], never: string[] = []): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const secrets = never.filter((s) => s.length >= 16);
  for (const { field, text } of values) {
    for (const [rule, re] of RULES) if (re.test(text)) findings.push({ rule, field });
    if (highEntropy(text)) findings.push({ rule: "high-entropy-string", field });
    if (secrets.some((s) => text.includes(s))) findings.push({ rule: "this-member's-own-secret", field });
  }
  return findings;
}

/** gitleaks over the values, one line range per field; null when it isn't installed. */
function gitleaksScan(values: { field: string; text: string }[], bin: string): Promise<ScanFinding[] | null> {
  const lines: string[] = [];
  const fieldOfLine: string[] = [];
  for (const { field, text } of values) {
    for (const l of text.split("\n")) {
      lines.push(l);
      fieldOfLine.push(field);
    }
  }
  // An empty folder of its own and no GITLEAKS_* settings: no `.gitleaks.toml` of the repository
  // being worked on (or of the agent's) can allowlist anything.
  const cwd = mkdtempSync(join(tmpdir(), "obysphere-scan-"));
  const cleanup = () => rmSync(cwd, { recursive: true, force: true });
  return new Promise<ScanFinding[] | null>((done, failed) => {
    let child;
    try {
      child = spawn(bin, ["stdin", "--no-banner", "--redact", "--log-level", "error", "--report-format", "json", "--report-path", "-"], {
        cwd, env: { PATH: process.env.PATH ?? "", HOME: cwd }, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return failed(e);
    }
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      failed(new Error("gitleaks took more than 30 seconds"));
    }, 30000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e.code === "ENOENT") done(null);
      else failed(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== 1) return failed(new Error(`gitleaks exited ${code}: ${err.trim().split("\n").at(-1) ?? ""}`));
      let report: { RuleID?: string; StartLine?: number }[];
      try {
        report = out.trim() ? JSON.parse(out) : [];
      } catch {
        return failed(new Error("gitleaks wrote no report"));
      }
      if (code === 1 && !report.length) return failed(new Error("gitleaks found something and reported nothing"));
      done(report.map((f) => ({ rule: `gitleaks:${f.RuleID ?? "unknown"}`, field: fieldOfLine[(f.StartLine ?? 1) - 1] ?? "/" })));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(lines.join("\n") + "\n");
  }).finally(cleanup);
}

/** Scans an outgoing body. `ok` only when every scanner ran and none found anything. */
export async function scanOutgoing(body: Json, o: ScanOptions = {}): Promise<ScanResult> {
  const values = strings(body);
  const scanners = ["built-in rules"];
  let findings: ScanFinding[];
  try {
    findings = builtinScan(values, o.never);
  } catch (e) {
    return { ok: false, findings: [], error: `the built-in scan failed: ${(e as Error).message}`, scanners };
  }
  const mode = o.gitleaks ?? "auto";
  if (mode !== "off") {
    try {
      const found = await gitleaksScan(values, o.gitleaksPath ?? "gitleaks");
      if (found === null) {
        if (mode === "required") return { ok: false, findings, error: "gitleaks is required and isn't installed", scanners };
      } else {
        scanners.push("gitleaks");
        findings.push(...found);
      }
    } catch (e) {
      return { ok: false, findings, error: `gitleaks couldn't run: ${(e as Error).message}`, scanners };
    }
  }
  return { ok: findings.length === 0, findings, scanners };
}
