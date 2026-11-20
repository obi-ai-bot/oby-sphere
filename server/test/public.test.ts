// Public links (spec/sphere-api.md section 11): the owner's agent puts a link's ciphertext and,
// if it likes, its own page; anyone may then open /a/{linkId}, read only, never cached, under the
// viewer's policy, at most 120 requests a minute; the Obysphere never sees the key; a link taken
// back is gone. The page's scripts are pinned by their SRI hashes.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ASSETS, PAGE, SRI } from "../src/public/assets.generated";
import { VIEWER_POLICY } from "../src/routes/public";
import { BASE, World, ageFile, expectSchema, makeCall, makeCard, newKey, newSealKey } from "./helpers";

const FEATURES = ["artifacts", "card_runtime"];
const LINK = "l-0123456789abcdef";

async function sharing(): Promise<World> {
  const w = new World();
  expect((await w.create("ana")).status).toBe(201);
  for (const owner of ["ana", "ben"]) {
    const obi = `obi-${owner}`;
    const inv = await w.call("POST", `/v0.1/spheres/${w.sphere}/invitations`, { token: await w.ownerToken("ana"), body: { owner, obi, expires_in: 3600 } });
    const ownerKey = await w.ownerKey(owner);
    const key = await newKey();
    const card = await makeCard({ sphere: w.sphere, obi, owner, ownerKey, obiKey: key, accepts: ["artifact_offer"], seal: await newSealKey(), issuedAt: w.clock.ts(), params: { features: FEATURES } });
    const r = await w.call("POST", `/v0.1/spheres/${w.sphere}/invitations/${inv.body.invitation_id}/redeem`, { body: { secret: inv.body.secret, owner_key: ownerKey.publicKey, card } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    w.obis.set(obi, { owner, key, accepts: ["artifact_offer"] });
  }
  return w;
}

const token = async (w: World, obi: string, scope = "send:artifact_offer reply receive") => {
  const r = await w.exchangeObi(obi, { delegation: await w.delegation(obi, scope) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.access_token as string;
};
const put = (w: World, t: string, bytes: Uint8Array, link = LINK, headers: Record<string, string> = {}) =>
  w.call("PUT", `/v0.1/spheres/${w.sphere}/public/${link}`, { token: t, raw: bytes, headers: { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length), ...headers } });
const putPage = (w: World, t: string, html: string | Uint8Array, link = LINK, type = "text/html; charset=utf-8") =>
  w.call("PUT", `/v0.1/spheres/${w.sphere}/public/${link}/page`, { token: t, raw: html, headers: { "Content-Type": type } });

/** A visitor: no token, a browser's request. */
async function visit(path: string, ip = "203.0.113.7", w?: World): Promise<Response> {
  const { handle } = await import("../src/app");
  return handle(new Request(BASE + path, { headers: { "CF-Connecting-IP": ip } }), env, { now: (w ?? new World()).clock.now });
}
const sha256 = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const sri = async (text: string) => `sha384-${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-384", new TextEncoder().encode(text)))))}`;

describe("public links (sphere-api.md section 11)", () => {
  it("keeps a link's ciphertext, serves it to anyone with no login, never cached, and has no key to it", async () => {
    const w = await sharing();
    const ta = await token(w, "obi-ana");
    const bytes = ageFile(1, 3000);
    const r = await put(w, ta, bytes);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expectSchema("publicResponse", r.body);
    expect(r.body).toEqual({ link_id: LINK, sha256: await sha256(bytes), bytes: bytes.length });
    const blob = await visit(`/a/${LINK}/blob`, "203.0.113.7", w);
    expect(blob.status).toBe(200);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(blob.headers.get("Cache-Control")).toBe("no-store");
    expect(blob.headers.get("Content-Type")).toBe("application/octet-stream");
    // A new version goes up under the same link.
    const v2 = ageFile(1, 4000);
    const again = await put(w, ta, v2);
    expect(again.status).toBe(200);
    expect(new Uint8Array(await (await visit(`/a/${LINK}/blob`, "203.0.113.7", w)).arrayBuffer())).toEqual(v2);
    // What the bucket holds is the ciphertext alone.
    expect((await env.ARTIFACTS!.list()).objects.map((o) => o.key)).toEqual([`public/${LINK}`]);
  });

  it("serves the Obysphere's page under the viewer's policy, its scripts pinned by their hashes", async () => {
    const w = await sharing();
    await put(w, await token(w, "obi-ana"), ageFile(1, 100));
    const page = await visit(`/a/${LINK}`, "203.0.113.7", w);
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("Content-Security-Policy")).toBe(VIEWER_POLICY);
    expect(VIEWER_POLICY).toContain("connect-src 'self'");
    expect(VIEWER_POLICY).toContain("frame-ancestors 'none'");
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(page.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const html = await page.text();
    expect(html).toBe(PAGE);
    // It names no product, and each script it loads is pinned by the hash of what is served.
    expect(html).not.toMatch(/\boby\b|oby:\/\//i);
    for (const [path, name] of [["/a/viewer.js", "viewer.js"], ["/a/vendor/age.bundle.js", "vendor/age.bundle.js"]] as const) {
      const js = await visit(path, "203.0.113.7", w);
      expect(js.status).toBe(200);
      expect(js.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
      const text = await js.text();
      expect(text).toBe(ASSETS[name]!.body);
      expect(SRI[name]).toBe(await sri(text));
      expect(html).toContain(`src="${path}" integrity="${SRI[name]}"`);
    }
    expect((await visit("/a/vendor/LICENSES.txt", "203.0.113.7", w)).status).toBe(200);
  });

  it("serves the page the owner's client uploaded, byte for byte, so the client can pin it by its hash", async () => {
    const w = await sharing();
    const ta = await token(w, "obi-ana");
    expect((await putPage(w, ta, "<p>early</p>")).status).toBe(404);
    await put(w, ta, ageFile(1, 100));
    const own = `<!doctype html><meta charset="utf-8"><title>Ana shared this</title><body data-link="${LINK}"><script src="/a/vendor/age.bundle.js" integrity="${SRI["vendor/age.bundle.js"]}"></script><script src="/a/viewer.js" integrity="${SRI["viewer.js"]}" defer></script><p>Get your own agent — café</p></body>`;
    const r = await putPage(w, ta, own);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expectSchema("publicResponse", r.body);
    const bytes = new TextEncoder().encode(own);
    expect(r.body).toEqual({ link_id: LINK, sha256: await sha256(bytes), bytes: bytes.length });
    const page = await visit(`/a/${LINK}`, "203.0.113.7", w);
    expect(new Uint8Array(await page.arrayBuffer())).toEqual(bytes);
    // Its own page is under the same policy: its inline script, if it had one, wouldn't run.
    expect(page.headers.get("Content-Security-Policy")).toBe(VIEWER_POLICY);
    // A new version keeps the page.
    await put(w, ta, ageFile(1, 200));
    expect(await (await visit(`/a/${LINK}`, "203.0.113.7", w)).text()).toBe(own);
    // What a page is.
    expect((await putPage(w, ta, own, LINK, "application/javascript")).status).toBe(400);
    expect((await putPage(w, ta, new Uint8Array([0x3c, 0xff, 0xfe]))).status).toBe(400);
    expect((await putPage(w, ta, "x".repeat(262145))).status).toBe(413);
  });

  it("refuses what isn't ciphertext, a link of another member's, and anyone but its owner's agent", async () => {
    const w = await sharing();
    const [ta, tb] = [await token(w, "obi-ana"), await token(w, "obi-ben")];
    const plain = await put(w, ta, new TextEncoder().encode("<html>Checkout page</html>"));
    expect(plain.status).toBe(400);
    expect(plain.body.error.message).toContain("age file");
    expect((await env.ARTIFACTS!.list()).objects).toEqual([]);
    expect((await visit(`/a/${LINK}/blob`, "203.0.113.7", w)).status).toBe(404);
    expect((await put(w, ta, ageFile(1, 100))).status).toBe(201);
    // ben can't overwrite, take back or dress ana's link.
    for (const r of [await put(w, tb, ageFile(1, 100)), await putPage(w, tb, "<p>hi</p>"), await w.call("DELETE", `/v0.1/spheres/${w.sphere}/public/${LINK}`, { token: tb })]) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("conflict");
    }
    // Only an agent's token with send:artifact_offer; never without one.
    expect((await put(w, await token(w, "obi-ana", "reply receive"), ageFile(1, 100))).body.error.code).toBe("insufficient_scope");
    expect((await put(w, await w.ownerToken("ana"), ageFile(1, 100))).body.error.code).toBe("forbidden");
    expect((await w.call("PUT", `/v0.1/spheres/${w.sphere}/public/${LINK}`, { raw: ageFile(1, 100), headers: { "Content-Type": "application/octet-stream", "Content-Length": "200" } })).status).toBe(401);
    // A link id is a plain id; its path takes nothing else.
    expect((await put(w, ta, ageFile(1, 100), "L-UPPER-CASE")).status).toBe(400);
    expect((await put(w, ta, ageFile(1, 100), "short")).status).toBe(400);
    expect((await put(w, ta, new Uint8Array(10), LINK, { "Content-Length": "67108865" })).status).toBe(413);
    // Nothing under /a/ takes a write.
    const { handle } = await import("../src/app");
    for (const method of ["PUT", "POST", "DELETE"]) expect((await handle(new Request(`${BASE}/a/${LINK}`, { method }), env, { now: w.clock.now })).status).toBe(404);
  });

  it("is gone once taken back: the blob is 404 and the page says so", async () => {
    const w = await sharing();
    const ta = await token(w, "obi-ana");
    await put(w, ta, ageFile(1, 100));
    await putPage(w, ta, "<p>Ana's page</p>");
    const gone = await w.call("DELETE", `/v0.1/spheres/${w.sphere}/public/${LINK}`, { token: ta });
    expect(gone.status).toBe(204);
    const blob = await visit(`/a/${LINK}/blob`, "203.0.113.7", w);
    expect(blob.status).toBe(404);
    const page = await visit(`/a/${LINK}`, "203.0.113.7", w);
    expect(page.status).toBe(404);
    // The Obysphere's own page, whose script says the link was taken back when its blob is 404.
    expect(await page.text()).toBe(PAGE);
    expect(ASSETS["viewer.js"]!.body).toContain("This link was taken back.");
    expect((await env.ARTIFACTS!.list()).objects).toEqual([]);
    expect((await w.call("DELETE", `/v0.1/spheres/${w.sphere}/public/${LINK}`, { token: ta })).status).toBe(404);
    // Deleting the Obysphere takes its links too.
    await put(w, ta, ageFile(1, 100));
    expect((await w.call("DELETE", `/v0.1/spheres/${w.sphere}`, { token: await w.ownerToken("ana") })).status).toBe(204);
    expect((await visit(`/a/${LINK}/blob`, "203.0.113.7", w)).status).toBe(404);
    expect((await env.ARTIFACTS!.list()).objects).toEqual([]);
  });

  it("answers one visitor at most 120 requests a minute, another all the same", async () => {
    const w = await sharing();
    await put(w, await token(w, "obi-ana"), ageFile(1, 100));
    for (let i = 0; i < 120; i++) expect((await visit(i % 2 ? `/a/${LINK}` : "/a/viewer.js", "198.51.100.9", w)).status).toBe(200);
    const over = await visit(`/a/${LINK}/blob`, "198.51.100.9", w);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await visit(`/a/${LINK}/blob`, "198.51.100.10", w)).status).toBe(200);
    // The next minute, the first visitor is back; and the count says nothing of its address.
    w.clock.advance(60);
    expect((await visit(`/a/${LINK}/blob`, "198.51.100.9", w)).status).toBe(200);
    const { results } = await env.DB.prepare("SELECT client FROM public_hits").all<{ client: string }>();
    expect(results.every((r) => /^[0-9a-f]{64}$/.test(r.client))).toBe(true);
  });

  it("isn't offered without a bucket", async () => {
    const { ARTIFACTS: _bucket, ...bare } = env;
    const call = makeCall(new World().clock, bare as Cloudflare.Env);
    for (const path of [`/a/${LINK}`, `/a/${LINK}/blob`, "/a/viewer.js"]) expect((await call("GET", path)).status).toBe(404);
  });
});
