// What a Sphere's admins change after it's made (spec/sphere-api.md sections 3 and 4): its name and
// picture, who else administers it, the invitations they can list, and deleting it.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/protocol/crypto";
import { World, expectSchema, team } from "./helpers";

/** A PNG's signature and IHDR chunk, `width` by `height`: all the Sphere reads of a picture. */
function png(width: number, height = width): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const PNG_TYPE = { "Content-Type": "image/png" };

describe("a Sphere's name and picture", () => {
  it("answers who administers it, and lets an admin rename it, never anyone else", async () => {
    const w = await team();
    const read = await w.call("GET", "/v0.1/spheres/e2e", { token: await w.ownerToken("ernesto") });
    expect(read.body.admins).toEqual(["wellington"]);
    expectSchema("sphere", read.body);
    const renamed = await w.call("PATCH", "/v0.1/spheres/e2e", { token: await w.ownerToken(), body: { name: "Deskree" } });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("Deskree");
    expectSchema("sphere", renamed.body);
    const member = await w.call("PATCH", "/v0.1/spheres/e2e", { token: await w.ownerToken("ernesto"), body: { name: "Mine" } });
    expect(member.status).toBe(403);
    const bad = await w.call("PATCH", "/v0.1/spheres/e2e", { token: await w.ownerToken(), body: { name: "" } });
    expect(bad.status).toBe(400);
    const id = await w.call("PATCH", "/v0.1/spheres/e2e", { token: await w.ownerToken(), body: { name: "Deskree", sphere: "other" } });
    expect(id.status).toBe(400);
  });

  it("keeps a square PNG as its picture, serves it to members only, and takes it away", async () => {
    const w = await team();
    const picture = png(256);
    const put = await w.call("PUT", "/v0.1/spheres/e2e/image", { token: await w.ownerToken(), raw: picture, headers: PNG_TYPE });
    expect(put.status).toBe(200);
    expect(put.body.image_sha256).toBe(await sha256Hex(picture));
    expectSchema("sphere", put.body);
    const got = await w.call("GET", "/v0.1/spheres/e2e/image", { token: await w.ownerToken("ernesto") });
    expect(got.status).toBe(200);
    expect(got.headers.get("Content-Type")).toBe("image/png");
    expect(got.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((await w.call("GET", "/v0.1/spheres/e2e/image")).status).toBe(401);
    // Not a PNG, not square, too small or too big, or not sent as one: refused, the picture kept.
    for (const [raw, headers] of [[png(256), {}], [new Uint8Array(64), PNG_TYPE], [png(256, 200), PNG_TYPE], [png(64), PNG_TYPE], [png(2048), PNG_TYPE]] as const) {
      const r = await w.call("PUT", "/v0.1/spheres/e2e/image", { token: await w.ownerToken(), raw, headers });
      expect(r.status).toBe(400);
    }
    expect((await w.call("PUT", "/v0.1/spheres/e2e/image", { token: await w.ownerToken("ernesto"), raw: picture, headers: PNG_TYPE })).status).toBe(403);
    const gone = await w.call("DELETE", "/v0.1/spheres/e2e/image", { token: await w.ownerToken() });
    expect(gone.status).toBe(200);
    expect(gone.body.image_sha256).toBeUndefined();
    expect((await w.call("GET", "/v0.1/spheres/e2e/image", { token: await w.ownerToken() })).status).toBe(404);
  });
});

describe("its admins", () => {
  it("makes a member an admin, who then holds admin; takes it away, and their admin tokens stop at once", async () => {
    const w = await team();
    const made = await w.call("PUT", "/v0.1/spheres/e2e/admins/ernesto", { token: await w.ownerToken() });
    expect(made.status).toBe(200);
    expect(made.body.admins).toEqual(["ernesto", "wellington"]);
    const ernesto = await w.ownerToken("ernesto");
    expect((await w.call("PATCH", "/v0.1/spheres/e2e", { token: ernesto, body: { name: "Ernesto's" } })).status).toBe(200);
    // Ernesto takes it away from the one who made it, whose token stops working.
    const wellington = await w.ownerToken();
    const taken = await w.call("DELETE", "/v0.1/spheres/e2e/admins/wellington", { token: ernesto });
    expect(taken.body.admins).toEqual(["ernesto"]);
    expect((await w.call("PATCH", "/v0.1/spheres/e2e", { token: wellington, body: { name: "Back" } })).status).toBe(401);
    expect((await w.exchangeOwner("wellington", "admin")).status).toBe(400);
    // The last admin stays one; someone who hasn't joined can't become one.
    expect((await w.call("DELETE", "/v0.1/spheres/e2e/admins/ernesto", { token: ernesto })).status).toBe(409);
    expect((await w.call("PUT", "/v0.1/spheres/e2e/admins/sangam", { token: ernesto })).status).toBe(409);
    // Taking it from someone who isn't one changes nothing.
    expect((await w.call("DELETE", "/v0.1/spheres/e2e/admins/wellington", { token: ernesto })).body.admins).toEqual(["ernesto"]);
  });
});

describe("its invitations", () => {
  it("lists those that can still be used, the newest first, with their labels, for admins only", async () => {
    const w = await team();
    const admin = await w.ownerToken();
    const make = (body: Record<string, unknown>) => w.call("POST", "/v0.1/spheres/e2e/invitations", { token: admin, body });
    const first = await make({ expires_in: 3600, max_uses: 1, label: "Invited from Mail" });
    expect(first.body.label).toBe("Invited from Mail");
    expectSchema("invitationResponse", first.body);
    w.clock.advance(60);
    const team_ = await make({ expires_in: 604800, max_uses: 50, label: "Team link" });
    w.clock.advance(60);
    const short = await make({ expires_in: 120 });
    // Never an address: the Sphere keeps none.
    expect((await make({ expires_in: 3600, label: "sangam@example.com" })).status).toBe(400);
    const listed = await w.call("GET", "/v0.1/spheres/e2e/invitations", { token: admin });
    expect(listed.status).toBe(200);
    expectSchema("invitationsResponse", listed.body);
    expect(listed.body.invitations.map((i: { invitation_id: string }) => i.invitation_id)).toEqual([short.body.invitation_id, team_.body.invitation_id, first.body.invitation_id]);
    expect(listed.body.invitations[1]).toMatchObject({ label: "Team link", max_uses: 50, uses: 0, created_at: w.clock.ts(-60) });
    expect(JSON.stringify(listed.body)).not.toContain(first.body.secret);
    // Withdrawn, expired or used up: no longer listed.
    await w.call("DELETE", `/v0.1/spheres/e2e/invitations/${first.body.invitation_id}`, { token: admin });
    w.clock.advance(180);
    const later = await w.call("GET", "/v0.1/spheres/e2e/invitations", { token: await w.ownerToken() });
    expect(later.body.invitations.map((i: { invitation_id: string }) => i.invitation_id)).toEqual([team_.body.invitation_id]);
    expect((await w.call("GET", "/v0.1/spheres/e2e/invitations", { token: await w.ownerToken("ernesto") })).status).toBe(403);
  });
});

describe("deleting a Sphere", () => {
  it("erases everything it kept for its admin alone, and its id stays taken", async () => {
    const w = await team();
    expect((await w.call("DELETE", "/v0.1/spheres/e2e", { token: await w.ownerToken("ernesto") })).status).toBe(403);
    const obi = await w.obiToken("obi-ernesto");
    expect((await w.call("DELETE", "/v0.1/spheres/e2e", { token: await w.ownerToken() })).status).toBe(204);
    expect((await w.call("GET", "/v0.1/spheres/e2e", { token: obi })).status).toBe(404);
    for (const table of ["members", "owners", "tokens", "audit", "invitations", "member_keys", "deliveries"]) {
      const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE sphere = 'e2e'`).first<{ n: number }>();
      expect(left?.n, table).toBe(0);
    }
    const again = await new World().create();
    expect(again.status).toBe(409);
    expect(again.body.error.message).toContain("taken");
  });
});
