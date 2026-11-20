// Public links (spec/sphere-api.md section 11): an artifact anyone with the link may look at. The
// owner's agent uploads its ciphertext, sealed to a key of the link's own that lives only in the
// link's # part, which a browser never sends: the Obysphere never sees it. On a separate origin
// (PUBLIC_ORIGIN), never the API's, the Obysphere serves under /a/, to anyone, unauthenticated,
// read only, rate-limited and never cached: the page (the owner's client's, which pins the
// scripts by their SRI hashes, or the Obysphere's own), the ciphertext, and the scripts that
// decrypt it in the visitor's browser. Links expire, each member has a quota, an admin can take
// any link down, and a revoked member's links go with it.

import { bearer, requireActor, requireScope, type Caller } from "../auth.ts";
import { requireSphere, type SphereRow } from "../db.ts";
import type { Deps, Env } from "../env.ts";
import { ApiError, apiError, errorResponse, json, rateLimited, readBody } from "../http.ts";
import { sha256Hex, uuid } from "../protocol/crypto.ts";
import { seconds, timestamp } from "../protocol/envelope.ts";
import { ASSETS, PAGE } from "../public/assets.generated.ts";
import { putCiphertext } from "./blobs.ts";

/**
 * The page's own policy: its scripts only, from the Obysphere; fetching only the Obysphere; the
 * decrypted files framed from memory. A frame made from a `blob:` keeps this policy, so a shared
 * page's own scripts (`blob:` too) run there, sandboxed, where they reach neither this page nor
 * the key.
 */
export const VIEWER_POLICY =
  "default-src 'none'; script-src 'self' blob:; connect-src 'self'; frame-src blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' blob:; font-src blob:; media-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/** A link's id: chosen by its owner's client, unique on this server. */
const LINK = /^[a-z0-9][a-z0-9-]{7,63}$/;
/** The largest page a client uploads for its links. */
export const MAX_PAGE_BYTES = 262144;
/** The longest a link lives before it must be put up again: 30 days. */
export const MAX_LINK_LIFETIME_SECONDS = 2592000;
/** What one member may keep up at once: links, and their ciphertext's bytes together (1 GiB). */
export const MAX_LINKS_PER_MEMBER = 64;
export const MAX_LINK_BYTES_PER_MEMBER = 1073741824;

const nowS = (deps: Deps) => Math.floor(deps.now() / 1000);
/** What every answer under /a/ carries, errors too: never cached, never sniffed, never sent on, never read by another site. */
const PUBLIC_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin" };
const PAGE_HEADERS = { ...PUBLIC_HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": VIEWER_POLICY };

/** The origin public links are served on, when it is one: an http or https origin. */
export function publicOrigin(env: Env): string | null {
  try {
    const url = new URL(env.PUBLIC_ORIGIN ?? "");
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin !== "null" ? url.origin : null;
  } catch {
    return null;
  }
}

/** Whether this Sphere serves public links: a bucket, a rate limiter and an origin of their own (feature `public_links`). */
export const takesPublicLinks = (env: Env): boolean => Boolean(env.ARTIFACTS && env.PUBLIC_LIMIT && publicOrigin(env));

function store(env: Env): R2Bucket {
  if (!takesPublicLinks(env)) throw apiError("not_found", "no such endpoint");
  return env.ARTIFACTS!;
}

interface LinkRow {
  link_id: string;
  sphere: string;
  owner_obi: string;
  object_key: string;
  sha256: string;
  bytes: number;
  expires_at_s: number;
  page: string | null;
  page_sha256: string | null;
}

const answer = (env: Env, link: string, o: { sha256: string; bytes: number; expires: number }) =>
  ({ link_id: link, sha256: o.sha256, bytes: o.bytes, expires: timestamp(o.expires), url: `${publicOrigin(env)}/a/${link}` });

/** The link `link` in `sphereId` as its owner's agent (with `send:artifact_offer`) may change it. */
async function owned(request: Request, env: Env, deps: Deps, sphereId: string, link: string): Promise<{ sphere: SphereRow; obi: string; row: LinkRow | null }> {
  store(env);
  const sphere = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere, nowS(deps));
  const obi = requireActor(caller);
  requireScope(caller, "send:artifact_offer");
  if (!LINK.test(link)) throw apiError("bad_request", "a link id is 8 to 64 lower-case letters, digits and hyphens");
  const row = await env.DB.prepare("SELECT * FROM public_links WHERE link_id = ?1").bind(link).first<LinkRow>();
  if (row && (row.sphere !== sphere.id || row.owner_obi !== obi)) throw apiError("conflict", "that link id is another member's");
  return { sphere, obi, row };
}

/** Deletes links' ciphertext first and their rows after, so a failure leaves them to delete again. */
async function forgetLinks(env: Env, rows: { link_id: string; object_key: string }[]): Promise<void> {
  if (rows.length === 0 || !env.ARTIFACTS) return;
  await env.ARTIFACTS.delete(rows.map((r) => r.object_key));
  await env.DB.batch(rows.map((r) => env.DB.prepare("DELETE FROM public_links WHERE link_id = ?1 AND object_key = ?2").bind(r.link_id, r.object_key)));
}

/** Deletes up to `n` links that have expired, anywhere on this server. */
async function sweepExpiredLinks(env: Env, now: number, n = 20): Promise<void> {
  const { results } = await env.DB.prepare("SELECT link_id, object_key FROM public_links WHERE expires_at_s <= ?1 LIMIT ?2").bind(now, n).all<{ link_id: string; object_key: string }>();
  await forgetLinks(env, results);
}

// ---------------------------------------------------------------------------------------------
// PUT /v0.1/spheres/{sphere}/public/{linkId}[?expires_at=…]: the link's ciphertext, made or replaced.

export async function putPublic(request: Request, env: Env, deps: Deps, sphereId: string, link: string): Promise<Response> {
  const bucket = store(env);
  const { sphere, obi } = await owned(request, env, deps, sphereId, link);
  const now = nowS(deps);
  const url = new URL(request.url);
  for (const name of url.searchParams.keys()) if (name !== "expires_at") throw apiError("bad_request", `no query parameter ${name}`);
  const asked = url.searchParams.get("expires_at");
  const expires = asked === null ? now + MAX_LINK_LIFETIME_SECONDS : seconds(asked);
  if (asked !== null && (Number.isNaN(expires) || timestamp(expires) !== asked)) throw apiError("bad_request", "expires_at is a timestamp like 2026-10-21T12:00:00Z");
  if (!(expires > now) || expires - now > MAX_LINK_LIFETIME_SECONDS) throw apiError("bad_request", `a link lives at most ${MAX_LINK_LIFETIME_SECONDS} seconds`);
  // The member's quota, this link's current version aside: it is replaced.
  const used = await env.DB.prepare("SELECT COUNT(*) AS links, COALESCE(SUM(bytes), 0) AS bytes FROM public_links WHERE sphere = ?1 AND owner_obi = ?2 AND link_id != ?3 AND expires_at_s > ?4")
    .bind(sphere.id, obi, link, now).first<{ links: number; bytes: number }>();
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (used!.links >= MAX_LINKS_PER_MEMBER) throw apiError("conflict", `a member keeps at most ${MAX_LINKS_PER_MEMBER} public links: take one down first`);
  if (used!.bytes + (Number.isInteger(declared) ? declared : 0) > MAX_LINK_BYTES_PER_MEMBER) throw apiError("conflict", `a member's public links hold at most ${MAX_LINK_BYTES_PER_MEMBER} bytes together`);

  // Each version in an object of its own: a replace that fails leaves the live one as it was.
  const objectKey = `public/${link}/${uuid()}`;
  const { sha256, bytes } = await putCiphertext(bucket, objectKey, request, 1, true);
  let written: D1Result[];
  try {
    written = await env.DB.batch([
      env.DB.prepare("SELECT object_key FROM public_links WHERE link_id = ?1").bind(link),
      // Still this member's, here, when it is written: a member who took the id meanwhile keeps it.
      env.DB.prepare(
        `INSERT INTO public_links (link_id, sphere, owner_obi, object_key, sha256, bytes, expires_at_s, updated_at_s) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (link_id) DO UPDATE SET object_key = ?4, sha256 = ?5, bytes = ?6, expires_at_s = ?7, updated_at_s = ?8
         WHERE public_links.sphere = ?2 AND public_links.owner_obi = ?3`,
      ).bind(link, sphere.id, obi, objectKey, sha256, bytes, expires, now),
    ]);
  } catch (e) {
    await bucket.delete(objectKey);
    throw e;
  }
  if (written[1]!.meta.changes !== 1) {
    await bucket.delete(objectKey);
    throw apiError("conflict", "that link id is another member's");
  }
  const before = (written[0]!.results as { object_key: string }[])[0];
  if (before) await bucket.delete(before.object_key);
  await sweepExpiredLinks(env, now);
  return json(before ? 200 : 201, answer(env, link, { sha256, bytes, expires }));
}

// ---------------------------------------------------------------------------------------------
// PUT /v0.1/spheres/{sphere}/public/{linkId}/page: the page /a/{linkId} serves, the owner's client's.

export async function putPublicPage(request: Request, env: Env, deps: Deps, sphereId: string, link: string): Promise<Response> {
  const { sphere, obi, row } = await owned(request, env, deps, sphereId, link);
  if (!row || row.expires_at_s <= nowS(deps)) throw apiError("not_found", "no such link: put its ciphertext first");
  if ((request.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase() !== "text/html") throw apiError("bad_request", "a page is sent as text/html");
  // Never more than the limit is read: a Content-Length over it is refused first.
  const bytes = await readBody(request, MAX_PAGE_BYTES);
  if (bytes.length === 0) throw apiError("bad_request", "a page has a body");
  let page: string;
  try {
    // Kept as it came, a byte order mark included, so it is served byte for byte.
    page = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw apiError("bad_request", "a page is UTF-8");
  }
  const sha256 = await sha256Hex(bytes);
  const r = await env.DB.prepare("UPDATE public_links SET page = ?2, page_sha256 = ?3, updated_at_s = ?4 WHERE link_id = ?1 AND sphere = ?5 AND owner_obi = ?6")
    .bind(link, page, sha256, nowS(deps), sphere.id, obi).run();
  if (r.meta.changes !== 1) throw apiError("not_found", "no such link");
  return json(200, answer(env, link, { sha256, bytes: bytes.length, expires: row.expires_at_s }));
}

// ---------------------------------------------------------------------------------------------
// DELETE /v0.1/spheres/{sphere}/public/{linkId}: taken back, by its owner's agent or an admin.

export async function deletePublic(request: Request, env: Env, deps: Deps, sphereId: string, link: string): Promise<Response> {
  store(env);
  const sphere = await requireSphere(env.DB, sphereId);
  const caller: Caller = await bearer(request, env, sphere, nowS(deps));
  if (!LINK.test(link)) throw apiError("bad_request", "a link id is 8 to 64 lower-case letters, digits and hyphens");
  const row = await env.DB.prepare("SELECT * FROM public_links WHERE link_id = ?1").bind(link).first<LinkRow>();
  if (caller.actor === null) {
    // An admin takes down any link of the Obysphere (an owner's own token, with admin).
    requireScope(caller, "admin");
    if (!row || row.sphere !== sphere.id) throw apiError("not_found", "no such link");
  } else {
    requireScope(caller, "send:artifact_offer");
    if (!row) throw apiError("not_found", "no such link");
    if (row.sphere !== sphere.id || row.owner_obi !== caller.actor) throw apiError("conflict", "that link id is another member's");
  }
  await forgetLinks(env, [row]);
  return new Response(null, { status: 204 });
}

/** Deletes every public link of `sphere`, ciphertext first: what deleting an Obysphere does first. */
export async function deletePublicLinks(env: Env, sphere: string): Promise<void> {
  const { results } = await env.DB.prepare("SELECT link_id, object_key FROM public_links WHERE sphere = ?1").bind(sphere).all<{ link_id: string; object_key: string }>();
  await forgetLinks(env, results);
}

/** Deletes the links of every revoked member of `sphere`: what revoking one does, its owner's rebind or reset included. */
export async function deleteRevokedMembersLinks(env: Env, sphere: string): Promise<void> {
  const { results } = await env.DB.prepare("SELECT link_id, object_key FROM public_links WHERE sphere = ?1 AND owner_obi IN (SELECT obi FROM members WHERE sphere = ?1 AND status = 'revoked')")
    .bind(sphere).all<{ link_id: string; object_key: string }>();
  await forgetLinks(env, results);
}

// ---------------------------------------------------------------------------------------------
// GET /a/…, on PUBLIC_ORIGIN only: no login, read only.

/**
 * Who is asking, for the rate limit: the visitor's address as Cloudflare gives it, an IPv6
 * address by its /64 (one household, one key); null when there is none (not behind Cloudflare).
 */
export function visitorKey(request: Request): string | null {
  const ip = (request.headers.get("CF-Connecting-IP") ?? "").trim().toLowerCase();
  if (/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(ip)) return `v4 ${ip}`;
  if (!/^[0-9a-f:.]+$/.test(ip) || !ip.includes(":")) return null;
  const [head = "", tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = ip.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = ip.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  if (groups.length < 4 || groups.slice(0, 4).some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return `v6 ${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/**
 * At most 120 requests a minute from one visitor, every path under /a/ counted, kept by
 * Cloudflare's rate limiter (PUBLIC_LIMIT): the Obysphere writes nothing per visit. A request
 * with no visitor's address isn't served: it would share one count with every other such request.
 */
async function limit(request: Request, env: Env, deps: Deps): Promise<void> {
  const key = visitorKey(request);
  if (key === null) throw apiError("forbidden", "a public link is served only to a visitor whose address the Obysphere's host gives it");
  if (!(await env.PUBLIC_LIMIT!.limit({ key })).success) throw rateLimited("at most 120 requests a minute", 60 - (Math.floor(deps.now() / 1000) % 60));
}

/** A handler under /a/: the public paths' checks, and their headers on every answer, an error's too. */
function publicRoute(fn: (request: Request, env: Env, deps: Deps, ...params: string[]) => Promise<Response>) {
  return async (request: Request, env: Env, deps: Deps, ...params: string[]): Promise<Response> => {
    try {
      store(env);
      await limit(request, env, deps);
      return await fn(request, env, deps, ...params);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      const r = errorResponse(e);
      for (const [k, v] of Object.entries(PUBLIC_HEADERS)) r.headers.set(k, v);
      return r;
    }
  };
}

/** The link, while it is up; an expired one is deleted when asked for. */
async function liveLink(env: Env, deps: Deps, link: string): Promise<LinkRow | null> {
  if (!LINK.test(link)) return null;
  const row = await env.DB.prepare("SELECT * FROM public_links WHERE link_id = ?1").bind(link).first<LinkRow>();
  if (row && row.expires_at_s <= nowS(deps)) {
    await forgetLinks(env, [row]);
    return null;
  }
  return row;
}

/** GET /a/{linkId}: the link's page. A link taken back or expired still opens the Obysphere's page, `404`, which says so. */
export const publicPage = publicRoute(async (_request, env, deps, link) => {
  const row = await liveLink(env, deps, link!);
  return new Response(row?.page ?? PAGE, { status: row ? 200 : 404, headers: PAGE_HEADERS });
});

/** GET /a/{linkId}/blob: the link's ciphertext, `404` once taken back or expired. */
export const publicBlob = publicRoute(async (_request, env, deps, link) => {
  const row = await liveLink(env, deps, link!);
  const object = row && (await env.ARTIFACTS!.get(row.object_key));
  if (!row || !object) throw apiError("not_found", "this link was taken back");
  return new Response(object.body, { status: 200, headers: { ...PUBLIC_HEADERS, "Content-Type": "application/octet-stream", "Content-Length": String(row.bytes) } });
});

/** GET /a/viewer.js, /a/vendor/age.bundle.js and /a/vendor/LICENSES.txt: the runtime, as built (src/public/assets.generated.ts). */
export const publicAsset = (path: string) =>
  publicRoute(async () => {
    const asset = ASSETS[path]!;
    return new Response(asset.body, { status: 200, headers: { ...PUBLIC_HEADERS, "Content-Type": asset.type } });
  });

/** Any other path, or method, on the public origin: nothing, with the public headers. */
export const publicNothing = publicRoute(async () => {
  throw apiError("not_found", "only public links are served here");
});
