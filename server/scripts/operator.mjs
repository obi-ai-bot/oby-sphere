#!/usr/bin/env node
// The operator's CLI (docs/operator.md, spec/sphere-api.md section 3.3): the supported way to fix an
// Obysphere when no admin can, in place of editing its database by hand. Each command calls the
// Obysphere's own API with the operator token, so it runs the same transaction the API runs, and
// the Obysphere logs each call where its admins read it (GET .../operator-log).
//
//   node scripts/operator.mjs <command> <sphere> [args] [--url <base>] [--yes]
//
//   show <sphere>                                   owners, key ids, admins, linked or not, agents
//   revoke <sphere> <obi>                           revoke one agent
//   reset-owner <sphere> <owner> --owner-key <key>  bind the key the owner gave you; revoke their agents
//   invite <sphere> [--owner <id> --obi <id>] [--max-uses <n>] [--expires-in <seconds>] [--domain <d>] [--label <text>]
//   make-admin <sphere> <owner>
//   remove-admin <sphere> <owner>
//
// Every command but show is a dry run unless --yes is given: it reads the Obysphere and prints what
// would change. The server is --url, or OBI_SPHERE_URL. The token is SPHERE_OPERATOR_TOKEN, or,
// on macOS, the Keychain item service `obi-sphere-operator-token`, account <the server's host>.
// Never on the command line, never in a file, never printed.

const USAGE = `usage: operator.mjs <command> <sphere> [args] [--url <base>] [--yes]
  show <sphere>
  revoke <sphere> <obi>
  reset-owner <sphere> <owner> --owner-key <base64url>
  invite <sphere> [--owner <id> --obi <id>] [--max-uses <n>] [--expires-in <seconds>] [--domain <d>] [--label <text>]
  make-admin <sphere> <owner>
  remove-admin <sphere> <owner>
Dry run unless --yes. Server: --url or OBI_SPHERE_URL. Token: SPHERE_OPERATOR_TOKEN, or the macOS Keychain.`;

const FLAGS = new Set(["url", "owner-key", "owner", "obi", "max-uses", "expires-in", "domain", "label"]);

/** argv into positionals and flags; null for a malformed line. */
export function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes") flags.yes = true;
    else if (a.startsWith("--")) {
      const name = a.slice(2);
      if (!FLAGS.has(name) || i + 1 >= argv.length) return null;
      flags[name] = argv[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

/** An invite link as spec/sphere-api.md section 2.1 writes it, and Oby's own scheme for the same link. */
export function inviteLinks(base, answer) {
  // encodeURIComponent encodes more than section 2.1 needs, which a writer may.
  const enc = (v) => encodeURIComponent(v);
  const parts = [["sphere", answer.sphere], ["id", answer.invitation_id], ["secret", answer.secret]];
  if (answer.owner) parts.push(["for", answer.owner], ["obi", answer.obi]);
  if (answer.domain) parts.push(["domain", answer.domain]);
  const fragment = parts.map(([k, v]) => `${k}=${enc(v)}`).join("&");
  return { https: `${base}/join#${fragment}`, oby: `oby://join/${new URL(base).host}#${fragment}` };
}

async function keychainToken(host) {
  if (process.platform !== "darwin") return null;
  const { execFileSync } = await import("node:child_process");
  try {
    return execFileSync("/usr/bin/security", ["find-generic-password", "-s", "obi-sphere-operator-token", "-a", host, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Runs one command. `io` is what it reaches outside: `fetch`, `env`, `out` and `err` (one line
 * each), and `token(host)` for the Keychain. Answers the exit code.
 */
export async function main(argv, io) {
  const parsed = parse(argv);
  if (!parsed || parsed.pos.length < 2) return usage(io);
  const [command, sphere, arg] = parsed.pos;
  const { flags } = parsed;
  const base = (flags.url ?? io.env.OBI_SPHERE_URL ?? "").replace(/\/+$/, "");
  let host;
  try {
    host = new URL(base).host;
  } catch {
    io.err("the server is --url <base> or OBI_SPHERE_URL, like https://sphere.example.com");
    return 2;
  }
  const token = io.env.SPHERE_OPERATOR_TOKEN || (await io.token(host));
  if (!token) {
    io.err(`no operator token: set SPHERE_OPERATOR_TOKEN, or keep it in the Keychain (service obi-sphere-operator-token, account ${host})`);
    return 2;
  }
  const api = async (method, path, body) => {
    const res = await io.fetch(`${base}/v0.1/spheres/${encodeURIComponent(sphere)}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, body: json };
  };
  const fail = (what, r) => {
    io.err(`${what}: ${r.status} ${r.body?.error?.code ?? ""} ${r.body?.error?.message ?? ""}`.trim());
    return 1;
  };
  const read = async () => {
    const r = await api("GET", "/owners");
    if (r.status !== 200) return { failed: fail("reading the owners", r) };
    return { owners: r.body };
  };
  const ownerOf = (state, owner) => state.owners.find((o) => o.owner === owner);
  const dry = !flags.yes;
  const bookmark = () => io.out(`Before applying, take a D1 Time Travel bookmark: wrangler d1 time-travel info <database> --env <env>`);

  switch (command) {
    case "show": {
      const { owners, failed } = await read();
      if (failed) return failed;
      io.out(`${owners.sphere}: ${owners.owners.length} owner(s)`);
      for (const o of owners.owners) {
        io.out(`  ${o.owner}${o.admin ? " (admin)" : ""}  key ${o.owner_key_id}  account ${o.account_linked ? "linked" : "not linked"}`);
        for (const m of o.members) io.out(`    ${m.obi}  ${m.status}`);
      }
      for (const m of owners.unbound) io.out(`  ! ${m.obi} (${m.status}) names owner ${m.owner}, who has no row`);
      return 0;
    }
    case "revoke": {
      if (!arg) return usage(io);
      const { owners, failed } = await read();
      if (failed) return failed;
      const found = owners.owners.flatMap((o) => o.members.map((m) => ({ ...m, owner: o.owner }))).concat(owners.unbound).find((m) => m.obi === arg);
      if (!found) return io.err(`no member ${arg} in ${sphere}`), 1;
      if (found.status === "revoked") return io.out(`${arg} is revoked already: nothing to do`), 0;
      io.out(`${dry ? "Would revoke" : "Revoking"} ${arg} (owner ${found.owner}): its key closed, its tokens, queued deliveries, runner status and phone relays gone.`);
      if (dry) return bookmark(), io.out("Dry run: nothing changed. Add --yes to apply."), 0;
      const r = await api("DELETE", `/members/${encodeURIComponent(arg)}`);
      if (r.status !== 200) return fail("revoking", r);
      io.out(`${arg} is ${r.body.status}.`);
      return 0;
    }
    case "reset-owner": {
      if (!arg || !flags["owner-key"]) return usage(io);
      const { owners, failed } = await read();
      if (failed) return failed;
      const o = ownerOf(owners, arg);
      if (!o) return io.err(`no owner ${arg} in ${sphere}`), 1;
      const active = o.members.filter((m) => m.status === "active").map((m) => m.obi);
      io.out(`${dry ? "Would bind" : "Binding"} a new owner key to ${arg} (now ${o.owner_key_id}), keeping their admin flag (${o.admin ? "admin" : "not admin"}).`);
      io.out(`${dry ? "Would revoke" : "Revoking"} their agents: ${active.length ? active.join(", ") : "none active"}. Every member sees an owner event, and compares the new fingerprint before trusting it.`);
      if (dry) return bookmark(), io.out("Dry run: nothing changed. Add --yes to apply."), 0;
      const r = await api("POST", `/owners/${encodeURIComponent(arg)}/reset`, { owner_key: flags["owner-key"] });
      if (r.status !== 200) return fail("resetting", r);
      io.out(`${arg} is bound to ${r.body.owner_key_id}. They join an agent again with an invite link (invite ${sphere} --owner ${arg} --obi <new id>).`);
      return 0;
    }
    case "invite": {
      if ((flags.owner === undefined) !== (flags.obi === undefined)) return io.err("--owner and --obi go together"), 2;
      const body = { expires_in: Number(flags["expires-in"] ?? 604800) };
      if (flags.owner) Object.assign(body, { owner: flags.owner, obi: flags.obi });
      else body.max_uses = Number(flags["max-uses"] ?? 1);
      if (flags.domain) body.domain = flags.domain;
      if (flags.label) body.label = flags.label;
      const days = Math.round((body.expires_in / 86400) * 10) / 10;
      io.out(`${dry ? "Would make" : "Making"} ${flags.owner ? `a named invitation for ${flags.owner}'s ${flags.obi}` : `an open invitation for up to ${body.max_uses} agent(s)`}${body.domain ? ` of ${body.domain}` : ""}, good for ${days} day(s).`);
      if (dry) return io.out("Dry run: nothing changed. Add --yes to apply."), 0;
      const r = await api("POST", "/invitations", body);
      if (r.status !== 201) return fail("inviting", r);
      const links = inviteLinks(base, r.body);
      io.out(`Invitation ${r.body.invitation_id}, until ${r.body.expires_at}. Send one of these to whoever joins:`);
      io.out(links.https);
      io.out(links.oby);
      return 0;
    }
    case "make-admin":
    case "remove-admin": {
      if (!arg) return usage(io);
      const { owners, failed } = await read();
      if (failed) return failed;
      const o = ownerOf(owners, arg);
      if (!o) return io.err(`no owner ${arg} in ${sphere}`), 1;
      const making = command === "make-admin";
      if (o.admin === making) return io.out(`${arg} is ${making ? "an admin" : "not an admin"} already: nothing to do`), 0;
      if (!making && owners.owners.filter((x) => x.admin).length < 2) return io.err(`${arg} is the only admin: make someone else one first`), 1;
      io.out(`${dry ? "Would" : "Will"} ${making ? "make" : "remove"} ${arg} ${making ? "an admin" : "as an admin"}${making ? "" : ", revoking their admin tokens"}.`);
      if (dry) return io.out("Dry run: nothing changed. Add --yes to apply."), 0;
      const r = await api(making ? "PUT" : "DELETE", `/admins/${encodeURIComponent(arg)}`);
      if (r.status !== 200) return fail(making ? "making an admin" : "removing an admin", r);
      io.out(`Admins of ${sphere}: ${(r.body.admins ?? []).join(", ") || "(see show)"}.`);
      return 0;
    }
    default:
      return usage(io);
  }
}

function usage(io) {
  io.err(USAGE);
  return 2;
}

if (typeof process !== "undefined" && process.argv?.[1] && import.meta.url === `file://${process.argv[1]}`) {
  const code = await main(process.argv.slice(2), {
    fetch: globalThis.fetch,
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    token: keychainToken,
  });
  process.exit(code);
}
