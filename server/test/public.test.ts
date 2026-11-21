// Public links (spec/sphere-api.md section 11): the owner's agent puts a link's ciphertext and,
// if it likes, its own page; anyone may then open /a/{linkId} on the public origin, never the
// API's, read only, never cached, under the viewer's policy, at most 120 requests a minute per
// visitor; the Obysphere never sees the key; a link taken down, expired or its member revoked is
// gone. The page's scripts are pinned by their SRI hashes.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { ASSETS, PAGE, SRI } from "../src/public/assets.generated";
import { MAX_LINKS_PER_MEMBER, VIEWER_POLICY, visitorKey } from "../src/routes/public";
import { BASE, World, ageFile, expectSchema, makeCall, makeCard, newKey, newSealKey } from "./helpers";

const FEATURES = ["artifacts", "card_runtime"];
const LINK = "l-0123456789abcdef";
const PUBLIC = env.PUBLIC_ORIGIN;
const PUBLIC_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin" };

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
const put = (w: World, t: string, bytes: Uint8Array, link = LINK, headers: Record<string, string> = {}, query = "") =>
  w.call("PUT", `/v0.1/spheres/${w.sphere}/public/${link}${query}`, { token: t, raw: bytes, headers: { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length), ...headers } });
const putPage = (w: World, t: string, html: string | Uint8Array, link = LINK, type = "text/html; charset=utf-8", headers: Record<string, string> = {}) =>
  w.call("PUT", `/v0.1/spheres/${w.sphere}/public/${link}/page`, { token: t, raw: html, headers: { "Content-Type": type, ...headers } });
const takeDown = (w: World, t: string, link = LINK) => w.call("DELETE", `/v0.1/spheres/${w.sphere}/public/${link}`, { token: t });

/** Each test's visitors have addresses of their own: the rate limiter outlives a test. */
let visitors = 0;
const newVisitor = () => `203.0.${Math.floor(++visitors / 250)}.${visitors % 250}`;
/** A visitor: no token, a browser's request, on the public origin unless said. */
async function visit(w: World, path: string, ip: string | null, o: { origin?: string; method?: string } = {}): Promise<Response> {
  return handle(new Request((o.origin ?? PUBLIC) + path, { method: o.method ?? "GET", headers: ip ? { "CF-Connecting-IP": ip } : {} }), env, { now: w.clock.now });
}
const sha256 = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const sri = async (text: string) => `sha384-${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-384", new TextEncoder().encode(text)))))}`;
const held = async () => (await env.ARTIFACTS!.list()).objects.map((o) => o.key);
const publicHeaders = (r: Response) => Object.fromEntries(Object.keys(PUBLIC_HEADERS).map((k) => [k, r.headers.get(k)]));

describe("public links (sphere-api.md section 11)", () => {
  it("keeps a link's ciphertext, serves it to anyone with no login, never cached, and has no key to it", async () => {
    const w = await sharing();
    const ta = await token(w, "obi-ana");
    const ip = newVisitor();
    const bytes = ageFile(1, 3000);
    const r = await put(w, ta, bytes);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expectSchema("publicResponse", r.body);
    expect(r.body).toEqual({ link_id: LINK, sha256: await sha256(bytes), bytes: bytes.length, expires: w.clock.ts(2592000), url: `${PUBLIC}/a/${LINK}` });
    const blob = await visit(w, `/a/${LINK}/blob`, ip);
    expect(blob.status).toBe(200);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(publicHeaders(blob)).toEqual(PUBLIC_HEADERS);
    expect(blob.headers.get("Content-Type")).toBe("application/octet-stream");
    // A new version goes up under the same link, and the old one is deleted after.
    const v2 = ageFile(1, 4000);
    expect((await put(w, ta, v2)).status).toBe(200);
    expect(new Uint8Array(await (await visit(w, `/a/${LINK}/blob`, ip)).arrayBuffer())).toEqual(v2);
    const keys = await held();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^public/${LINK}/[0-9a-f-]{36}$`));
  });

  it("keeps the live version when a replace fails", async () => {
    const w = await sharing();
    const ta = await token(w, "obi-ana");
    const ip = newVisitor();
    const live = ageFile(1, 3000);
    await put(w, ta, live);
    // Not ciphertext; a body shorter than it says; longer: each refused, and the live one stays.
    expect((await put(w, ta, new TextEncoder().encode("<html>plain</html>"))).status).toBe(400);
    expect((await put(w, ta, ageFile(1, 100), LINK, { "Content-Length": "5000" })).status).toBe(400);
    expect((await put(w, ta, ageFile(1, 100), LINK, { "Content-Length": "50" })).status).toBe(400);
    const blob = await visit(w, `/a/${LINK}/blob`, ip);
    expect(blob.status).toBe(200);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(live);
    expect(await held()).toHaveLength(1);
  });

  it("keeps a link its member took while another's upload was on its way", async () => {
    const w = await sharing();
    const [ta, tb] = [await token(w, "obi-ana"), await token(w, "obi-ben")];
    const file = ageFile(1, 2000);
    // ben's upload passes the first check, then waits on its body; ana takes the id meanwhile.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(file.subarray(0, 1000));
        await gate;
        c.enqueue(file.subarray(1000));
        c.close();
      },
    });
    const bens = handle(
      new Request(`${BASE}/v0.1/spheres/${w.sphere}/public/${LINK}`, { method: "PUT", body, headers: { Authorization: `Bearer ${tb}`, "Content-Type": "application/octet-stream", "Content-Length": String(file.length) } }),
      env,
      { now: w.clock.now },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect((await put(w, ta, ageFile(1, 100))).status).toBe(201);
    release();
    const r = await bens;
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("conflict");
    const row = await env.DB.prepare("SELECT owner_obi FROM public_links WHERE link_id = ?1").bind(LINK).first<{ owner_obi: string }>();
    expect(row!.owner_obi).toBe("obi-ana");
    // ben's upload left nothing behind.
    expect(await held()).toHaveLength(1);
  });

  it("serves the Obysphere's page under the viewer's policy, its scripts pinned by their hashes", async () => {
    const w = await sharing();
    const ip = newVisitor();
    await put(w, await token(w, "obi-ana"), ageFile(1, 100));
    const page = await visit(w, `/a/${LINK}`, ip);
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("Content-Security-Policy")).toBe(VIEWER_POLICY);
    expect(VIEWER_POLICY).toContain("connect-src 'self'");
    expect(VIEWER_POLICY).toContain("frame-ancestors 'none'");
    expect(publicHeaders(page)).toEqual(PUBLIC_HEADERS);
    const html = await page.text();
    expect(html).toBe(PAGE);
    // It names no product, and each script it loads is pinned by the hash of what is served.
    expect(html).not.toMatch(/\boby\b|oby:\/\//i);
    for (const [path, name] of [["/a/viewer.js", "viewer.js"], ["/a/vendor/age.bundle.js", "vendor/age.bundle.js"]] as const) {
      const js = await visit(w, path, ip);
      expect(js.status).toBe(200);
      expect(js.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
      const text = await js.text();
      expect(text).toBe(ASSETS[name]!.body);
      expect(SRI[name]).toBe(await sri(text));
      expect(html).toContain(`src="${path}" integrity="${SRI[name]}"`);
    }
    expect((await visit(w, "/a/vendor/LICENSES.txt", ip)).status).toBe(200);
    // The viewer takes the key out of the address once it has read it, before it fetches anything.
    const js = ASSETS["viewer.js"]!.body;
    expect(js.indexOf("history.replaceState(null, '', location.pathname + location.search)")).toBeGreaterThan(js.indexOf("location.hash.slice(1)"));
    expect(js.indexOf("history.replaceState")).toBeLessThan(js.indexOf("fetch("));
  });

  it("serves /a/ only on the public origin, which serves nothing else", async () => {
    const w = await sharing();
    const ip = newVisitor();
    await put(w, await token(w, "obi-ana"), ageFile(1, 100));
    for (const path of [`/a/${LINK}`, `/a/${LINK}/blob`, "/a/viewer.js"]) expect((await visit(w, path, ip, { origin: BASE })).status).toBe(404);
    for (const path of ["/v0.1/health", "/v0.1/features", "/join", `/v0.1/spheres/${w.sphere}`]) {
      const r = await visit(w, path, ip);
      expect(r.status).toBe(404);
      expect(publicHeaders(r)).toEqual(PUBLIC_HEADERS);
    }
    // Nothing under /a/ takes a write.
    for (const method of ["PUT", "POST", "DELETE"]) expect((await visit(w, `/a/${LINK}`, ip, { method })).status).toBe(404);
    // Without a public origin, no public links at all.
    const { PUBLIC_ORIGIN: _o, ...bare } = env;
    const call = makeCall(w.clock, bare as Cloudflare.Env);
    expect((await call("GET", "/v0.1/features")).body.features).not.toContain("public_links");
    expect((await call("GET", "/v0.1/features", {})).body.features).toContain("artifacts");
    expect((await w.call("GET", "/v0.1/features")).body.features).toContain("public_links");
  });

  it("serves the page the owner's client uploaded, byte for byte, so the client can pin it by its hash", async () => {
    const w = await sharing();
    const ta = await token(w, "obi-ana");
    const ip = newVisitor();
    expect((await putPage(w, ta, "<p>early</p>")).status).toBe(404);
    await put(w, ta, ageFile(1, 100));
    const own = `\uFEFF<!doctype html><meta charset="utf-8"><title>Ana shared this</title><body data-link="${LINK}"><script src="/a/vendor/age.bundle.js" integrity="${SRI["vendor/age.bundle.js"]}"></script><script src="/a/viewer.js" integrity="${SRI["viewer.js"]}" defer></script><p>Get your own agent — café</p></body>`;
    const bytes = new TextEncoder().encode(own);
    // It starts with a byte order mark, which stays.
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const r = await putPage(w, ta, own);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expectSchema("publicResponse", r.body);
    expect(r.body).toMatchObject({ link_id: LINK, sha256: await sha256(bytes), bytes: bytes.length });
    const page = await visit(w, `/a/${LINK}`, ip);
    expect(new Uint8Array(await page.arrayBuffer())).toEqual(bytes);
    expect(page.headers.get("Content-Security-Policy")).toBe(VIEWER_POLICY);
    // A new version keeps the page.
    await put(w, ta, ageFile(1, 200));
    expect(new Uint8Array(await (await visit(w, `/a/${LINK}`, ip)).arrayBuffer())).toEqual(bytes);
    // What a page is.
    expect((await putPage(w, ta, own, LINK, "application/javascript")).status).toBe(400);
    expect((await putPage(w, ta, new Uint8Array([0x3c, 0xff, 0xfe]))).status).toBe(400);
    expect((await putPage(w, ta, "x".repeat(262145))).status).toBe(413);
  });

  it("refuses a page whose Content-Length is over 256 KiB before reading it, and one that grows past it", async () => {
    const w = await sharing();
    const ta = await token(w, "obi-ana");
    await put(w, ta, ageFile(1, 100));
    // A short body that says it is long: refused from what it says.
    const says = await putPage(w, ta, "<p>short</p>", LINK, "text/html", { "Content-Length": "262145" });
    expect(says.status).toBe(413);
    // A body longer than it says: no more than the limit is read.
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 65536;
        c.enqueue(new Uint8Array(65536).fill(0x61));
        if (pulled > 4 * 1048576) c.close();
      },
    });
    const r = await handle(new Request(`${BASE}/v0.1/spheres/${w.sphere}/public/${LINK}/page`, { method: "PUT", body: endless, headers: { Authorization: `Bearer ${ta}`, "Content-Type": "text/html" } }), env, { now: w.clock.now });
    expect(r.status).toBe(413);
    expect(pulled).toBeLessThan(262144 + 3 * 65536);
  });

  it("refuses what isn't ciphertext, a link of another member's, and anyone but its owner's agent", async () => {
    const w = await sharing();
    const [ta, tb] = [await token(w, "obi-ana"), await token(w, "obi-ben")];
    const plain = await put(w, ta, new TextEncoder().encode("<html>Checkout page</html>"));
    expect(plain.status).toBe(400);
    expect(plain.body.error.message).toContain("age file");
    expect(await held()).toEqual([]);
    expect((await put(w, ta, ageFile(1, 100))).status).toBe(201);
    for (const r of [await put(w, tb, ageFile(1, 100)), await putPage(w, tb, "<p>hi</p>"), await takeDown(w, tb)]) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("conflict");
    }
    expect((await put(w, await token(w, "obi-ana", "reply receive"), ageFile(1, 100))).body.error.code).toBe("insufficient_scope");
    expect((await put(w, await w.ownerToken("ana"), ageFile(1, 100))).body.error.code).toBe("forbidden");
    expect((await w.call("PUT", `/v0.1/spheres/${w.sphere}/public/${LINK}`, { raw: ageFile(1, 100), headers: { "Content-Type": "application/octet-stream", "Content-Length": "200" } })).status).toBe(401);
    expect((await put(w, ta, ageFile(1, 100), "L-UPPER-CASE")).status).toBe(400);
    expect((await put(w, ta, ageFile(1, 100), "short")).status).toBe(400);
    expect((await put(w, ta, new Uint8Array(10), LINK, { "Content-Length": "67108865" })).status).toBe(413);
  });

  it("lives at most 30 days, then is gone", async () => {
    const w = await sharing();
    const ta = await token(w, "obi-ana");
    const ip = newVisitor();
    expect((await put(w, ta, ageFile(1, 100), LINK, {}, `?expires_at=${w.clock.ts(2592001)}`)).status).toBe(400);
    expect((await put(w, ta, ageFile(1, 100), LINK, {}, `?expires_at=${w.clock.ts(0)}`)).status).toBe(400);
    const r = await put(w, ta, ageFile(1, 100), LINK, {}, `?expires_at=${w.clock.ts(600)}`);
    expect(r.body.expires).toBe(w.clock.ts(600));
    expect((await visit(w, `/a/${LINK}/blob`, ip)).status).toBe(200);
    w.clock.advance(600);
    expect((await visit(w, `/a/${LINK}/blob`, ip)).status).toBe(404);
    expect((await visit(w, `/a/${LINK}`, ip)).status).toBe(404);
    expect(await held()).toEqual([]);
  });

  it("holds a member to its quota of links", async () => {
    const w = await sharing();
    const ta = await token(w, "obi-ana");
    for (let i = 0; i < MAX_LINKS_PER_MEMBER; i++) expect((await put(w, ta, ageFile(1, 10), `l-quota-${String(i).padStart(4, "0")}`)).status).toBe(201);
    const over = await put(w, ta, ageFile(1, 10), "l-quota-over");
    expect(over.status).toBe(409);
    expect(over.body.error.message).toContain(`at most ${MAX_LINKS_PER_MEMBER} public links`);
    // A new version of one it has isn't one more.
    expect((await put(w, ta, ageFile(1, 20), "l-quota-0000")).status).toBe(200);
    // Nor are bytes past 1 GiB together, said before anything is read.
    const tb = await token(w, "obi-ben");
    await env.DB.prepare("INSERT INTO public_links (link_id, sphere, owner_obi, object_key, sha256, bytes, expires_at_s, updated_at_s) VALUES ('l-big-big-big', ?1, 'obi-ben', 'public/x', ?2, 1073741000, ?3, ?4)")
      .bind(w.sphere, "a".repeat(64), w.clock.s + 3600, w.clock.s).run();
    const big = await put(w, tb, ageFile(1, 2000), "l-ben-ben-ben");
    expect(big.status).toBe(409);
    expect(big.body.error.message).toContain("1073741824 bytes");
  });

  it("is gone once taken down, by its owner's agent or an admin, and when its member is revoked", async () => {
    const w = await sharing();
    const [ta, tb] = [await token(w, "obi-ana"), await token(w, "obi-ben")];
    const ip = newVisitor();
    await put(w, ta, ageFile(1, 100));
    await putPage(w, ta, "<p>Ana's page</p>");
    expect((await takeDown(w, ta)).status).toBe(204);
    expect((await visit(w, `/a/${LINK}/blob`, ip)).status).toBe(404);
    const page = await visit(w, `/a/${LINK}`, ip);
    expect(page.status).toBe(404);
    expect(await page.text()).toBe(PAGE);
    expect(ASSETS["viewer.js"]!.body).toContain("This link was taken back.");
    expect(await held()).toEqual([]);
    expect((await takeDown(w, ta)).status).toBe(404);
    // An admin takes down a member's link.
    await put(w, tb, ageFile(1, 100), "l-bens-link");
    const benOwner = await w.ownerToken("ben", "directory:read");
    expect((await takeDown(w, benOwner, "l-bens-link")).body.error.code).toBe("insufficient_scope");
    expect((await takeDown(w, await w.ownerToken("ana"), "l-bens-link")).status).toBe(204);
    expect((await visit(w, "/a/l-bens-link/blob", ip)).status).toBe(404);
    // Revoking ben deletes his links.
    await put(w, tb, ageFile(1, 100), "l-bens-other");
    expect((await w.call("DELETE", `/v0.1/spheres/${w.sphere}/members/obi-ben`, { token: await w.ownerToken("ana") })).status).toBe(200);
    expect((await visit(w, "/a/l-bens-other/blob", ip)).status).toBe(404);
    expect(await held()).toEqual([]);
    // Deleting the Obysphere takes the rest.
    await put(w, ta, ageFile(1, 100));
    expect((await w.call("DELETE", `/v0.1/spheres/${w.sphere}`, { token: await w.ownerToken("ana") })).status).toBe(204);
    expect((await visit(w, `/a/${LINK}/blob`, ip)).status).toBe(404);
    expect(await held()).toEqual([]);
  });

  it("answers one visitor at most 120 requests a minute, writing nothing, with an IPv6 visitor counted by its /64", async () => {
    const w = await sharing();
    await put(w, await token(w, "obi-ana"), ageFile(1, 100));
    const ip = newVisitor();
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").first<{ n: number }>();
    for (let i = 0; i < 120; i++) expect((await visit(w, i % 2 ? `/a/${LINK}` : "/a/viewer.js", ip)).status).toBe(200);
    const over = await visit(w, `/a/${LINK}/blob`, ip);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(publicHeaders(over)).toEqual(PUBLIC_HEADERS);
    expect((await visit(w, `/a/${LINK}/blob`, newVisitor())).status).toBe(200);
    // No table of visits, and none was made.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").first<{ n: number }>())!.n).toBe(before!.n);
    expect(await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'public_hits'").first()).toBeNull();
    // Two addresses in one /64 are one visitor.
    expect(visitorKey(new Request(PUBLIC, { headers: { "CF-Connecting-IP": "2001:db8:1:2:aaaa::1" } }))).toBe(visitorKey(new Request(PUBLIC, { headers: { "CF-Connecting-IP": "2001:0db8:0001:0002:ffff:ffff:ffff:ffff" } })));
    expect(visitorKey(new Request(PUBLIC, { headers: { "CF-Connecting-IP": "2001:db8:1:3::1" } }))).not.toBe(visitorKey(new Request(PUBLIC, { headers: { "CF-Connecting-IP": "2001:db8:1:2::1" } })));
    const v6 = "2001:db8:99:1";
    for (let i = 0; i < 120; i++) await visit(w, "/a/viewer.js", `${v6}::${(i % 9) + 1}`);
    expect((await visit(w, "/a/viewer.js", `${v6}:aaaa:bbbb:cccc:dddd`)).status).toBe(429);
    // A request with no address isn't served: it isn't counted with every other such request.
    const none = await visit(w, `/a/${LINK}`, null);
    expect(none.status).toBe(403);
    expect(publicHeaders(none)).toEqual(PUBLIC_HEADERS);
  });

  it("isn't offered without a bucket, a rate limiter or a public origin", async () => {
    const w = new World();
    for (const missing of ["ARTIFACTS", "PUBLIC_LIMIT", "PUBLIC_ORIGIN"] as const) {
      const { [missing]: _x, ...bare } = env;
      const r = await handle(new Request(`${PUBLIC}/a/${LINK}`, { headers: { "CF-Connecting-IP": newVisitor() } }), bare as Cloudflare.Env, { now: w.clock.now });
      expect(r.status).toBe(404);
      expect((await makeCall(w.clock, bare as Cloudflare.Env)("GET", "/v0.1/features")).body.features).not.toContain("public_links");
    }
  });
});
