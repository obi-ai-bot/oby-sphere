// The operator's supported acts (spec/sphere-api.md section 3.3, `operator_recovery`) and the CLI
// that calls them (scripts/operator.mjs): the operator token on the owners list, revoke, reset,
// invitations and admins, each call logged where admins read it; dry runs that change nothing.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { main } from "../scripts/operator.mjs";
import { BASE, ISSUERS, OPERATOR, expectSchema, makeCard, newKey, team, type World } from "./helpers";

const op = (w: World, method: string, path: string, body?: unknown) => w.call(method, `/v0.1/spheres/e2e${path}`, { token: OPERATOR, ...(body === undefined ? {} : { body }) });
const log = async (w: World) => (await w.call("GET", "/v0.1/spheres/e2e/operator-log", { token: await w.ownerToken() })).body.entries.map((e: { action: string; target?: string }) => `${e.action} ${e.target ?? ""}`.trim());

describe("the operator's acts (operator_recovery)", () => {
  it("shows owners, key ids, admins and agents to the operator or an admin, never an account", async () => {
    const w = await team();
    const r = await op(w, "GET", "/owners");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expectSchema("ownersResponse", r.body);
    expect(r.body.owners).toEqual([
      { owner: "ernesto", owner_key_id: (await w.ownerKey("ernesto")).keyId, admin: false, account_linked: false, members: [{ obi: "obi-ernesto", status: "active" }] },
      { owner: "wellington", owner_key_id: (await w.ownerKey("wellington")).keyId, admin: true, account_linked: false, members: [{ obi: "obi-wellington", status: "active" }] },
    ]);
    expect(r.body.unbound).toEqual([]);
    expect((await w.call("GET", "/v0.1/spheres/e2e/owners", { token: await w.ownerToken() })).status).toBe(200);
    expect((await w.call("GET", "/v0.1/spheres/e2e/owners", { token: await w.ownerToken("ernesto", "directory:read") })).status).toBe(403);
    expect((await w.call("GET", "/v0.1/spheres/e2e/owners", { token: "not-the-operator-token-0123456789-abcdef" })).status).toBe(401);
  });

  it("lists a member whose owner row is gone under unbound", async () => {
    const w = await team();
    await env.DB.prepare("DELETE FROM owners WHERE sphere = 'e2e' AND owner = 'ernesto'").run();
    expect((await op(w, "GET", "/owners")).body.unbound).toEqual([{ owner: "ernesto", obi: "obi-ernesto", status: "active" }]);
  });

  it("revokes, invites and changes admins with the operator token, logging each call and no secret", async () => {
    const w = await team();
    expect((await op(w, "DELETE", "/members/obi-ernesto")).body.status).toBe("revoked");
    const inv = await op(w, "POST", "/invitations", { expires_in: 3600, max_uses: 3 });
    expect(inv.status).toBe(201);
    expect((await op(w, "PUT", "/admins/ernesto")).body.admins).toEqual(["ernesto", "wellington"]);
    expect((await op(w, "DELETE", "/admins/ernesto")).body.admins).toEqual(["wellington"]);
    const r = await w.call("GET", "/v0.1/spheres/e2e/operator-log", { token: await w.ownerToken() });
    expectSchema("operatorLogResponse", r.body);
    expect(await log(w)).toEqual(["revoke obi-ernesto", `invite ${inv.body.invitation_id}`, "make_admin ernesto", "remove_admin ernesto"]);
    expect(JSON.stringify(r.body)).not.toContain(inv.body.secret);
    // An admin's own calls aren't the operator's.
    expect((await w.call("PUT", "/v0.1/spheres/e2e/admins/ernesto", { token: await w.ownerToken() })).status).toBe(200);
    expect((await log(w)).length).toBe(4);
    expect((await w.call("GET", "/v0.1/spheres/e2e/operator-log", { token: await w.obiToken("obi-wellington") })).status).toBe(403);
  });

  it("resets an owner to a key they gave out of band: their agents revoked, admin kept, an event says who", async () => {
    const w = await team();
    const key = await newKey();
    const r = await op(w, "POST", "/owners/wellington/reset", { owner_key: key.publicKey });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expectSchema("ownerRebindResponse", r.body);
    expect(r.body).toMatchObject({ owner: "wellington", owner_key_id: key.keyId, admin: true });
    expect(r.body.event).toMatchObject({ kind: "reset", by: "operator", revoked: ["obi-wellington"] });
    expect(r.body.event).not.toHaveProperty("account_linked");
    w.owners.set("wellington", key);
    expect(await log(w)).toEqual(["reset_owner wellington"]);
    // The owner joins again with an invitation, under the new key.
    expect((await w.join("wellington", "obi-wellington-2")).status).toBe(201);
    // An admin may reset too; the event says so.
    const k2 = await newKey();
    const byAdmin = await w.call("POST", "/v0.1/spheres/e2e/owners/ernesto/reset", { token: await w.ownerToken(), body: { owner_key: k2.publicKey } });
    expect(byAdmin.body.event).toMatchObject({ kind: "reset", by: "admin", revoked: ["obi-ernesto"] });
    // An owner who isn't an admin may not, not even for themself.
    w.owners.set("ernesto", k2);
    expect((await w.call("POST", "/v0.1/spheres/e2e/owners/ernesto/reset", { token: await w.ownerToken("ernesto", "directory:read"), body: { owner_key: (await newKey()).publicKey } })).status).toBe(403);
    expect((await op(w, "POST", "/owners/nobody/reset", { owner_key: k2.publicKey })).status).toBe(404);
    expect((await op(w, "POST", "/owners/ernesto/reset", { owner_key: k2.publicKey })).status).toBe(409);
  });
});

/** The CLI, its fetch the Worker itself. */
function cli(w: World) {
  const out: string[] = [];
  const err: string[] = [];
  const run = (...argv: string[]) => main([...argv, "--url", BASE], {
    fetch: (url, init) => handle(new Request(url, init), env, { now: w.clock.now, issuers: ISSUERS }),
    env: { SPHERE_OPERATOR_TOKEN: OPERATOR },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    token: async () => null,
  });
  return { run, out, err };
}

describe("scripts/operator.mjs", () => {
  it("shows the Sphere", async () => {
    const w = await team();
    const c = cli(w);
    expect(await c.run("show", "e2e")).toBe(0);
    expect(c.out).toContain("  wellington (admin)  key " + (await w.ownerKey("wellington")).keyId + "  account not linked");
    expect(c.out).toContain("    obi-ernesto  active");
  });

  it("changes nothing without --yes, and applies with it", async () => {
    const w = await team();
    const c = cli(w);
    expect(await c.run("revoke", "e2e", "obi-ernesto")).toBe(0);
    expect(c.out.join("\n")).toContain("Dry run: nothing changed");
    expect((await op(w, "GET", "/owners")).body.owners[0].members[0].status).toBe("active");
    expect(await c.run("revoke", "e2e", "obi-ernesto", "--yes")).toBe(0);
    expect((await op(w, "GET", "/owners")).body.owners[0].members[0].status).toBe("revoked");

    const key = await newKey();
    expect(await c.run("reset-owner", "e2e", "ernesto", "--owner-key", key.publicKey)).toBe(0);
    expect((await op(w, "GET", "/owners")).body.owners[0].owner_key_id).toBe((await w.ownerKey("ernesto")).keyId);
    expect(await c.run("reset-owner", "e2e", "ernesto", "--owner-key", key.publicKey, "--yes")).toBe(0);
    expect((await op(w, "GET", "/owners")).body.owners[0].owner_key_id).toBe(key.keyId);

    expect(await c.run("make-admin", "e2e", "ernesto")).toBe(0);
    expect((await op(w, "GET", "/owners")).body.owners[0].admin).toBe(false);
    expect(await c.run("make-admin", "e2e", "ernesto", "--yes")).toBe(0);
    expect(await c.run("remove-admin", "e2e", "wellington", "--yes")).toBe(0);
    expect((await op(w, "GET", "/owners")).body.owners.map((o: { admin: boolean }) => o.admin)).toEqual([true, false]);
    // The last admin stays.
    expect(await c.run("remove-admin", "e2e", "ernesto", "--yes")).toBe(1);
    // Each applied write is in the log, in order; dry runs only read (show).
    const entries = (await op(w, "GET", "/operator-log?limit=100")).body.entries.map((e: { action: string; target?: string }) => `${e.action} ${e.target ?? ""}`.trim());
    expect(entries.filter((e: string) => e !== "show")).toEqual(["revoke obi-ernesto", "reset_owner ernesto", "make_admin ernesto", "remove_admin wellington"]);
  });

  it("makes an invitation whose printed link joins", async () => {
    const w = await team();
    const c = cli(w);
    expect(await c.run("invite", "e2e", "--max-uses", "3", "--expires-in", "86400")).toBe(0);
    expect(c.out.join("\n")).toContain("Dry run");
    expect(await c.run("invite", "e2e", "--max-uses", "3", "--expires-in", "86400", "--yes")).toBe(0);
    const link = c.out.find((l) => l.startsWith(`${BASE}/join#`))!;
    expect(c.out.find((l) => l.startsWith("oby://join/sphere.test#"))).toBeDefined();
    const f = new URLSearchParams(link.split("#")[1]);
    expect(f.get("sphere")).toBe("e2e");
    const ownerKey = await newKey();
    const card = await makeCard({ sphere: "e2e", obi: "obi-new", owner: "newcomer", ownerKey, obiKey: await newKey(), issuedAt: w.clock.ts() });
    const r = await w.call("POST", `/v0.1/spheres/e2e/invitations/${f.get("id")}/redeem`, { body: { secret: f.get("secret"), owner_key: ownerKey.publicKey, card } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("refuses to run without a server or a token, and with a malformed line", async () => {
    const w = await team();
    const out: string[] = [], err: string[] = [];
    const io = { fetch: globalThis.fetch, env: {}, out: (l: string) => out.push(l), err: (l: string) => err.push(l), token: async () => null };
    expect(await main(["show", "e2e"], io)).toBe(2);
    expect(await main(["show", "e2e", "--url", BASE], io)).toBe(2);
    expect(err.join("\n")).toContain("no operator token");
    expect(await main(["show", "e2e", "--url", BASE, "--token", "x"], io)).toBe(2);
    expect(await cli(w).run("nonsense", "e2e")).toBe(2);
  });
});
