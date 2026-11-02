// The connector's folder on the member's machine: one membership of one Sphere. Everything in it
// is the member's and its owner's, readable by this user only (folders 0700, files 0600):
//
//   member.json        the membership: the Sphere, the ids, the member's signing and seal keys
//                      (secret), the owner's delegation, the card's words
//   owner-key.json     the owner's key, encrypted with the owner's passphrase (vault.ts)
//   rules.json         what the host's agent may send without asking, signed by the owner's key
//   memory.json        the client library's MemberMemory: pins, the chain's head and receipts, ids seen
//   items/<id>.json    the mailbox: each request in and out, its owner's decision and its replies
//   decisions/<id>.json  an owner's decision on an item, signed with the owner's key, waiting to be applied
//   connector.lock     the pid of the connector that receives for this membership
//
// Only the running connector writes member.json's state, memory.json and items/; the owner's
// commands (approve, decline, rules) write decisions/ and rules.json, signed.

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export const defaultHome = (): string => resolve(process.env.OBYSPHERE_CONNECTOR_HOME ?? join(homedir(), ".obysphere-connector"));

export class Home {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  /** Makes the folder and its subfolders, this user's only: a new folder, an empty one, or this connector's own. */
  ensure(): void {
    if (existsSync(this.dir)) {
      const names = readdirSync(this.dir);
      const ours = new Set(["member.json", "owner-key.json", "joining.json", "rules.json", "memory.json", "state.json", "items", "decisions", "connector.log", "connector.lock"]);
      if (names.some((n) => !ours.has(n) && !n.endsWith(".tmp"))) throw new Error(`${this.dir} holds files of something else: choose a new or empty folder for --home`);
    }
    for (const d of [this.dir, this.path("items"), this.path("decisions")]) {
      mkdirSync(d, { recursive: true, mode: 0o700 });
      chmodSync(d, 0o700);
    }
  }

  exists(name: string): boolean {
    return existsSync(this.path(name));
  }

  readJson<T>(name: string): T {
    return JSON.parse(readFileSync(this.path(name), "utf8")) as T;
  }

  readJsonOr<T>(name: string, fallback: T): T {
    return this.exists(name) ? this.readJson<T>(name) : fallback;
  }

  /** Writes a file whole or not at all (a new file renamed over the old), this user's only. */
  writeJson(name: string, value: unknown): void {
    const target = this.path(name);
    const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, target);
  }

  list(dir: "items" | "decisions"): string[] {
    if (!existsSync(this.path(dir))) return [];
    return readdirSync(this.path(dir)).filter((n) => n.endsWith(".json")).sort();
  }

  remove(name: string): void {
    rmSync(this.path(name), { force: true });
  }

  /** Files or folders others can read: the connector refuses to run with its secrets open to them. */
  looseModes(): string[] {
    const loose: string[] = [];
    for (const name of [".", "member.json", "owner-key.json", "memory.json", "items", "decisions"]) {
      const p = this.path(name);
      if (existsSync(p) && (statSync(p).mode & 0o077) !== 0) loose.push(p);
    }
    return loose;
  }

  /**
   * Takes the lock that makes this process the one connector receiving for this membership. A lock
   * whose process is gone is taken over. Answers a release function, or throws when another runs.
   */
  lock(): () => void {
    const p = this.path("connector.lock");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(p, "wx", 0o600);
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return () => {
          try {
            if (readFileSync(p, "utf8") === String(process.pid)) rmSync(p, { force: true });
          } catch {}
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const held = readFileSync(p, "utf8");
        const pid = Number(held);
        if (Number.isSafeInteger(pid) && pid > 0 && alive(pid)) throw new Error(`another connector (pid ${pid}) is running for ${this.dir}`);
        // Taken over only while it still names the process that is gone: another connector may have just taken it.
        if (readFileSync(p, "utf8") === held) rmSync(p, { force: true });
      }
    }
    throw new Error(`could not take ${p}`);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
