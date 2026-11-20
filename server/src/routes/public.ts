// Public links (spec/sphere-api.md section 11): an artifact anyone with the link may look at. The
// owner's agent uploads its ciphertext, sealed to a key of the link's own that lives only in the
// link's # part, which a browser never sends: the Obysphere never sees it. Under /a/ the Obysphere
// serves, to anyone, unauthenticated, read only, rate-limited and never cached: the page (the
// owner's client's, which pins the scripts by their SRI hashes, or the Obysphere's own), the
// ciphertext, and the scripts that decrypt it in the visitor's browser.

import { bearer, requireActor, requireScope } from "../auth.ts";
import { requireSphere } from "../db.ts";
import type { Deps, Env } from "../env.ts";
import { apiError, json, rateLimited } from "../http.ts";
import { sha256Hex } from "../protocol/crypto.ts";
import { utf8 } from "../protocol/json.ts";
import { ASSETS, PAGE } from "../public/assets.generated.ts";
import { bucket, putCiphertext } from "./blobs.ts";

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
/** Public requests one client makes in a minute, every path under /a/ counted. */
export const PUBLIC_PER_MINUTE = 120;

const publicKey = (link: string) => `public/${link}`;
const nowS = (deps: Deps) => Math.floor(deps.now() / 1000);
/** What every answer under /a/ carries: never cached, never sniffed, never framed by another page. */
const PUBLIC_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin" };
const PAGE_HEADERS = { ...PUBLIC_HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": VIEWER_POLICY };

interface LinkRow {
  link_id: string;
  sphere: string;
  owner_obi: string;
  sha256: string;
  bytes: number;
  page: string | null;
  page_sha256: string | null;
}

/** The caller's link `link` in `sphereId`, for its owner's agent with `send:artifact_offer`. */
async function owned(request: Request, env: Env, deps: Deps, sphereId: string, link: string) {
  bucket(env);
  const sphere = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere, nowS(deps));
  const obi = requireActor(caller);
  requireScope(caller, "send:artifact_offer");
  if (!LINK.test(link)) throw apiError("bad_request", "a link id is 8 to 64 lower-case letters, digits and hyphens");
  const row = await env.DB.prepare("SELECT * FROM public_links WHERE link_id = ?1").bind(link).first<LinkRow>();
  if (row && (row.sphere !== sphere.id || row.owner_obi !== obi)) throw apiError("conflict", "that link id is another member's");
  return { sphere, obi, row };
}

// ---------------------------------------------------------------------------------------------
// PUT /v0.1/spheres/{sphere}/public/{linkId}: the link's ciphertext, made or replaced.

export async function putPublic(request: Request, env: Env, deps: Deps, sphereId: string, link: string): Promise<Response> {
  const { sphere, obi, row } = await owned(request, env, deps, sphereId, link);
  // Sealed to the link's own key: one recipient.
  const { sha256, bytes } = await putCiphertext(bucket(env), publicKey(link), request, 1, true);
  await env.DB.prepare(
    `INSERT INTO public_links (link_id, sphere, owner_obi, sha256, bytes, updated_at_s) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (link_id) DO UPDATE SET sha256 = ?4, bytes = ?5, updated_at_s = ?6`,
  ).bind(link, sphere.id, obi, sha256, bytes, nowS(deps)).run();
  return json(row ? 200 : 201, { link_id: link, sha256, bytes });
}

// ---------------------------------------------------------------------------------------------
// PUT /v0.1/spheres/{sphere}/public/{linkId}/page: the page /a/{linkId} serves, the owner's client's.

export async function putPublicPage(request: Request, env: Env, deps: Deps, sphereId: string, link: string): Promise<Response> {
  const { row } = await owned(request, env, deps, sphereId, link);
  if (!row) throw apiError("not_found", "no such link: put its ciphertext first");
  if ((request.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase() !== "text/html") throw apiError("bad_request", "a page is sent as text/html");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_PAGE_BYTES) throw apiError("payload_too_large", `a page is at most ${MAX_PAGE_BYTES} bytes`);
  if (bytes.length === 0) throw apiError("bad_request", "a page has a body");
  let page: string;
  try {
    page = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw apiError("bad_request", "a page is UTF-8");
  }
  const sha256 = await sha256Hex(bytes);
  await env.DB.prepare("UPDATE public_links SET page = ?2, page_sha256 = ?3, updated_at_s = ?4 WHERE link_id = ?1").bind(link, page, sha256, nowS(deps)).run();
  return json(200, { link_id: link, sha256, bytes: bytes.length });
}

// ---------------------------------------------------------------------------------------------
// DELETE /v0.1/spheres/{sphere}/public/{linkId}: taken back.

export async function deletePublic(request: Request, env: Env, deps: Deps, sphereId: string, link: string): Promise<Response> {
  const { row } = await owned(request, env, deps, sphereId, link);
  if (!row) throw apiError("not_found", "no such link");
  await bucket(env).delete(publicKey(link));
  await env.DB.prepare("DELETE FROM public_links WHERE link_id = ?1").bind(link).run();
  return new Response(null, { status: 204 });
}

/** Deletes every public link of `sphere`, ciphertext first: what deleting an Obysphere does. */
export async function deletePublicLinks(env: Env, sphere: string): Promise<void> {
  if (!env.ARTIFACTS) return;
  const { results } = await env.DB.prepare("SELECT link_id FROM public_links WHERE sphere = ?1").bind(sphere).all<{ link_id: string }>();
  if (results.length) await env.ARTIFACTS.delete(results.map((r) => publicKey(r.link_id)));
  await env.DB.prepare("DELETE FROM public_links WHERE sphere = ?1").bind(sphere).run();
}

// ---------------------------------------------------------------------------------------------
// GET /a/…: no login, read only.

/**
 * At most PUBLIC_PER_MINUTE requests a minute from one client (its address, as Cloudflare gives
 * it), counted under SHA-256 of that address and the minute, so a row says nothing once its
 * minute is over; and those rows go as soon as a later minute starts.
 */
async function limit(request: Request, env: Env, deps: Deps): Promise<void> {
  const minute = Math.floor(deps.now() / 60000);
  const client = await sha256Hex(utf8(`obi/0.1 public ${request.headers.get("CF-Connecting-IP") ?? "unknown"} ${minute}`));
  const row = await env.DB.prepare(
    "INSERT INTO public_hits (client, minute, count) VALUES (?1, ?2, 1) ON CONFLICT (client) DO UPDATE SET count = count + 1 RETURNING count",
  ).bind(client, minute).first<{ count: number }>();
  if (row?.count === 1) await env.DB.prepare("DELETE FROM public_hits WHERE minute < ?1").bind(minute).run();
  if ((row?.count ?? 0) > PUBLIC_PER_MINUTE) throw rateLimited(`at most ${PUBLIC_PER_MINUTE} requests a minute`, 60 - (Math.floor(deps.now() / 1000) % 60));
}

const linkRow = (env: Env, link: string) => (LINK.test(link) ? env.DB.prepare("SELECT * FROM public_links WHERE link_id = ?1").bind(link).first<LinkRow>() : Promise.resolve(null));

/** GET /a/{linkId}: the link's page. A link taken back still opens the Obysphere's page, `404`, which says so. */
export async function publicPage(request: Request, env: Env, deps: Deps, link: string): Promise<Response> {
  bucket(env);
  await limit(request, env, deps);
  const row = await linkRow(env, link);
  return new Response(row?.page ?? PAGE, { status: row ? 200 : 404, headers: PAGE_HEADERS });
}

/** GET /a/{linkId}/blob: the link's ciphertext, `404` once taken back. */
export async function publicBlob(request: Request, env: Env, deps: Deps, link: string): Promise<Response> {
  const store = bucket(env);
  await limit(request, env, deps);
  const row = await linkRow(env, link);
  const object = row && (await store.get(publicKey(link)));
  if (!row || !object) throw apiError("not_found", "this link was taken back");
  return new Response(object.body, { status: 200, headers: { ...PUBLIC_HEADERS, "Content-Type": "application/octet-stream", "Content-Length": String(row.bytes) } });
}

/** GET /a/viewer.js, /a/vendor/age.bundle.js and /a/vendor/LICENSES.txt: the runtime, as built (src/public/assets.generated.ts). */
export function publicAsset(path: string) {
  return async (request: Request, env: Env, deps: Deps): Promise<Response> => {
    bucket(env);
    await limit(request, env, deps);
    const asset = ASSETS[path]!;
    return new Response(asset.body, { status: 200, headers: { ...PUBLIC_HEADERS, "Content-Type": asset.type } });
  };
}
