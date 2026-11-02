// The adapter contract (conformance/README.md, "The receiver track"): how the harness drives an
// implementation under test without knowing anything about it. The adapter is one shell command;
// each call is `sh -c "<command>"` with one JSON object on stdin, `{"op": …, …}`, and for every op
// but `serve` the last line it prints to stdout, when it is a JSON object, is its answer.
//
//   enroll   join the Sphere as a new member, holding the canary as one of its owner's secrets
//   serve    run the receiver until it is stopped (SIGTERM to its process group)
//   inbox    what waits for the owner now: {"items": [{"id", "correlation_id"}]}
//   decide   apply one owner decision: {"id", "correlation_id", "decision": "accept" | "decline" | "answer", "text"?}

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { sleep } from "./sphere.mjs";

/** The last line of `out` that is a JSON object, or null. */
export function lastJson(out) {
  for (const line of out.trim().split("\n").reverse()) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      return JSON.parse(t);
    } catch {}
  }
  return null;
}

export class Adapter {
  /**
   * `command` is run with `sh -c` in `workdir`, with this process's environment (an implementation
   * may need its own sign-in) and its output appended to `logPath`. `redact` hides values (the
   * canary) from that log.
   */
  constructor(command, { workdir, logPath, redact = [] }) {
    this.command = command;
    this.workdir = workdir;
    this.log = createWriteStream(logPath, { flags: "a" });
    this.redact = redact;
    this.serving = null;
  }

  hide(text) {
    return this.redact.reduce((t, v) => t.split(v).join("<canary>"), text);
  }

  /** One op; answers {code, out, err, answer} (answer: the last JSON line). */
  call(op, input = {}, { timeout = 120_000 } = {}) {
    return new Promise((resolve) => {
      const child = spawn("sh", ["-c", this.command], { cwd: this.workdir, stdio: ["pipe", "pipe", "pipe"], detached: true });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
        err += `\n(${op} timed out after ${timeout / 1000} seconds)`;
      }, timeout);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => {
        clearTimeout(timer);
        this.log.write(this.hide(`--- ${op} (exit ${code})\n${out}${err ? `[stderr]\n${err}` : ""}\n`));
        resolve({ code, out, err: this.hide(err), answer: lastJson(out) });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ op, workdir: this.workdir, ...input }));
    });
  }

  /** Starts `serve` in the background; its output goes to the log. */
  serve(input = {}) {
    const child = spawn("sh", ["-c", this.command], { cwd: this.workdir, stdio: ["pipe", "pipe", "pipe"], detached: true });
    child.stdout.on("data", (d) => this.log.write(this.hide(String(d))));
    child.stderr.on("data", (d) => this.log.write(this.hide(String(d))));
    child.exited = new Promise((res) => child.on("exit", (code, signal) => res({ code, signal })));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ op: "serve", workdir: this.workdir, ...input }));
    this.serving = child;
    return child;
  }

  async stop() {
    const child = this.serving;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    if (!(await Promise.race([child.exited, sleep(10_000).then(() => null)]))) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  }

  /** The owner's inbox now: [{id, correlation_id}], or null when the op failed. */
  async inbox() {
    const r = await this.call("inbox", {}, { timeout: 60_000 });
    if (r.code !== 0 || !Array.isArray(r.answer?.items)) return null;
    return r.answer.items.filter((i) => i && typeof i.id === "string" && typeof i.correlation_id === "string");
  }
}
