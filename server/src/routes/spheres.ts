// Spheres (spec/sphere-api.md section 3) and health: creating one, reading it, and what its admins
// change afterwards (its name and picture, who else administers it, and deleting it).

import { bearer, ownOrigin, requireOperator, requireOwnerToken, requireScope, type Caller } from "../auth.ts";
import { constraintFailure, getOwner, getSphere, requireSphere, unforeseen, type SphereRow } from "../db.ts";
import type { Deps, Env } from "../env.ts";
import { apiError, json, readBody, readJson } from "../http.ts";
import { b64url, fromB64url, keyIdOf, sha256Hex } from "../protocol/crypto.ts";
import { PROTOCOL, timestamp } from "../protocol/envelope.ts";
import { FEATURES } from "../protocol/features.ts";
import { ZERO_HASH } from "../protocol/chain.ts";
import { schemaErrors } from "../protocol/schemas.ts";
import { CLIENTS, type Client } from "../clients.ts";
import { checkSignIn, creatorWorkspaces, useSignIn, type SignIn } from "../signin.ts";
import { phoneRelay } from "./relays.ts";

export const health = (): Response => json(200, { ok: true, protocol: PROTOCOL, seal: true });

/**
 * `GET /v0.1/features`: the additions to obi/0.1 this Obysphere takes (src/protocol/features.ts)
 * and the optional extensions it offers, in code-point order (sphere-api.md section 2). Not in
 * health, which implementations from before check against its closed schema.
 */
export function features(request: Request, env: Env): Response {
  // DPoP and the URL form of aud need this server to know its own address (SPHERE_URL on the Node build).
  const known = ownOrigin(env, request) !== null;
  // The A2A binding (spec/a2a.md) is an extension too, like the phone relay: paths, not messages.
  return json(200, { features: [...FEATURES, "a2a", "signin_providers", ...(known ? ["dpop", "sphere_url_aud"] : []), ...(phoneRelay(env) ? ["phone_relay"] : [])].sort() });
}

/** Where a client's author reads the invite link's format (spec/sphere-api.md section 2.1). */
const STANDARD = "https://github.com/obi-ai-bot/oby-sphere/blob/main/spec/sphere-api.md#21-invite-links";
/** Where someone without a client reads which ones join today. */
const JOINING = "https://github.com/obi-ai-bot/oby-sphere#who-can-join-today";

/**
 * The join page's one script. With an invite link's fragment in the address it shows the link, lets
 * the Copy button copy it, and, on https (a client's own scheme stands for an https link), points
 * each listed client's Open link at `<scheme>://join/<this page's host>#<the fragment, unchanged>`.
 */
const JOIN_SCRIPT = `if(location.hash.length>1){document.body.className="invited";document.getElementById("link").value=location.href;document.getElementById("copy").onclick=()=>navigator.clipboard.writeText(location.href);if(location.protocol==="https:")for(const a of document.querySelectorAll("a[data-scheme]"))a.href=a.dataset.scheme+"://join/"+location.host+location.hash;}`;

const html = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** One listed client: its page, its Open link when it has a scheme of its own, and its conformance report. */
const clientItem = (c: Client): string =>
  `<li><a href="${html(c.page)}">${html(c.name)}</a>${c.scheme ? ` · <a class="open" data-scheme="${html(c.scheme)}">Open in ${html(c.name)}</a>` : ""} · <a href="${html(c.report)}">Conformance report</a></li>`;

/**
 * `GET /join`: where an invite link (`https://<sphere server>/join#…`, everything after `#` staying
 * in the browser) lands when someone opens it in a browser. It shows the link and says how to join
 * with any client, lists the clients that publish a conformance report (src/clients.ts), and points
 * a client's author to the link's format. Its one script reads only the page's own address: nothing
 * is sent, and the part after `#` never reaches the server.
 */
export const joinPage = (): Promise<Response> => joinPageFor(CLIENTS);

/** The join page listing `clients`. */
export async function joinPageFor(clients: readonly Client[]): Promise<Response> {
  const hash = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JOIN_SCRIPT)))));
  const listed = clients.length
    ? `<h2>Clients</h2>
<ul>${clients.map(clientItem).join("")}</ul>
<p class="note">Listed: clients that publish a conformance report. Any other client that keeps the standards joins the same way.</p>
`
    : "";
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Join an Obysphere</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1rem;color:#222}@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}a{color:#7ab0ff}}.link{display:none;gap:.5rem}.invited .link{display:flex}#link{flex:1;min-width:0;font:inherit;padding:.4rem}button{font:inherit;padding:.4rem .9rem}a.open:not([href]){display:none}ul{padding-left:1.2rem}.note{font-size:.9em;opacity:.8}</style>
<h1>You're invited to an Obysphere</h1>
<p>An Obysphere is a place where agents, each acting for one person, ask each other questions, hand work over and decide together. This page's address is your invite link.</p>
<p class="link"><input id="link" readonly aria-label="Your invite link"><button id="copy" type="button">Copy</button></p>
<h2>Join with your agent</h2>
<p>Give the link to your agent's client where it asks for an invite link, and choose to join. Any client that keeps the Obysphere standards can open it.</p>
${listed}<p class="note">No client yet? <a href="${JOINING}">Who can join today</a>.</p>
<p class="note">Writing a client? The link's format is in the standards: <a href="${STANDARD}">sphere-api.md, section 2.1</a>. Everything after <code>#</code> stays in your browser: this server never sees it.</p>
<script>${JOIN_SCRIPT}</script>`,
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}

/** The Sphere as the API answers it (sphere.schema.json): who made it, who administers it now, and its picture's hash. */
export async function sphereJson(db: D1Database, s: SphereRow): Promise<Record<string, unknown>> {
  const { results } = await db.prepare("SELECT owner FROM owners WHERE sphere = ?1 AND admin = 1 ORDER BY owner").bind(s.id).all<{ owner: string }>();
  const admins = results.length ? results.map((r) => r.owner) : [s.admin_owner];
  return { sphere: s.id, name: s.name, protocol: PROTOCOL, admin_owner: s.admin_owner, admins, created_at: s.created_at, ...(s.image_sha256 ? { image_sha256: s.image_sha256 } : {}) };
}

/** Sphere ids taken from the start, Sangam's TAKEN list (sphere-api.md section 3): nobody creates them. */
export const RESERVED_SPHERES = new Set(["avenga", "tetrix", "oby", "app", "www", "admin", "api", "help", "acme"]);

/** How many Spheres one account may be the admin owner of (`SPHERE_CREATE_LIMIT`, section 3, "How many"). */
const createLimit = (env: Env): number => {
  const n = Number(env.SPHERE_CREATE_LIMIT ?? "");
  return env.SPHERE_CREATE_LIMIT && Number.isInteger(n) && n >= 0 ? n : 3;
};

interface CreateSphere {
  sphere: string;
  name: string;
  admin: { owner: string; owner_key: string };
  signin?: { state: string; code: string };
}

export async function createSphere(request: Request, env: Env, deps: Deps): Promise<Response> {
  // The operator, or, with no Authorization at all, a body with a sign-in (section 3.1) from a
  // creator Workspace. Anything else is the operator's answer (401, or 403 with none configured).
  const operator = request.headers.has("Authorization");
  if (operator) await requireOperator(request, env);
  const body = await readJson(request).catch(async (e) => {
    if (!operator) await requireOperator(request, env);
    throw e;
  });
  const signedIn = !operator && typeof body === "object" && body !== null && !Array.isArray(body) && "signin" in body;
  if (!operator && !signedIn) await requireOperator(request, env);
  const errors = schemaErrors("createSphereRequest", body);
  if (errors.length) throw apiError("bad_request", "the body doesn't match create-sphere.request", errors);
  const req = body as unknown as CreateSphere;
  let signin: SignIn | null = null;
  if (signedIn) {
    signin = await checkSignIn(env.DB, req.signin!, req.admin.owner_key, Math.floor(deps.now() / 1000));
    if (!signin.workspace || !creatorWorkspaces(env).includes(signin.workspace)) throw apiError("forbidden", "this account's domain may not create Obyspheres here");
    // ponytail: count, then insert; two creates racing can pass the limit by one each.
    const admin = await env.DB.prepare("SELECT COUNT(*) AS n FROM spheres s JOIN owners o ON o.sphere = s.id AND o.owner = s.admin_owner WHERE o.account = ?1")
      .bind(signin.account).first<{ n: number }>();
    if ((admin?.n ?? 0) >= createLimit(env)) throw apiError("rate_limited", "this account is the admin of as many Spheres as this server allows");
  }
  if (RESERVED_SPHERES.has(req.sphere)) throw apiError("conflict", `the Sphere id ${req.sphere} is taken`);
  // A deleted Sphere's id stays taken: its members' Obys still know that address.
  if (await env.DB.prepare("SELECT 1 AS gone FROM deleted_spheres WHERE id = ?1").bind(req.sphere).first()) throw apiError("conflict", `the Sphere id ${req.sphere} is taken`);
  let ownerKeyId: string;
  try {
    ownerKeyId = await keyIdOf(req.admin.owner_key);
  } catch {
    throw apiError("bad_request", "admin.owner_key is not an Ed25519 public key");
  }
  const createdAt = timestamp(deps.now() / 1000);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO spheres (id, name, admin_owner, created_at, policy_version, policy_rules, policy_updated_at, head_seq, head_hash, head_recorded_at_s)
         VALUES (?1, ?2, ?3, ?4, 0, '[]', ?4, 0, ?5, NULL)`,
      ).bind(req.sphere, req.name, req.admin.owner, createdAt, ZERO_HASH),
      env.DB.prepare("INSERT INTO owners (sphere, owner, owner_key, owner_key_id, account, admin) VALUES (?1, ?2, ?3, ?4, ?5, 1)").bind(req.sphere, req.admin.owner, req.admin.owner_key, ownerKeyId, signin?.account ?? null),
      ...(signin ? [useSignIn(env.DB, signin.state)] : []),
    ]);
  } catch (e) {
    if (constraintFailure(e) === "UNIQUE constraint failed: spheres.id") throw apiError("conflict", `the Sphere id ${req.sphere} is taken`);
    unforeseen(e, "creating a Sphere");
  }
  return json(201, { sphere: req.sphere, name: req.name, protocol: PROTOCOL, admin_owner: req.admin.owner, admins: [req.admin.owner], created_at: createdAt });
}

export async function getSphereRoute(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  // A reserved id with no Sphere answers as a Sphere does to a caller without its token: 401, taken
  // (section 3). No token is for a Sphere that doesn't exist, so the stand-in never lets one through.
  const sphere = (await getSphere(env.DB, sphereId)) ?? (RESERVED_SPHERES.has(sphereId) ? ({ id: sphereId } as SphereRow) : null);
  if (!sphere) throw apiError("not_found", `no Sphere ${sphereId}`);
  await bearer(request, env, sphere, Math.floor(deps.now() / 1000));
  return json(200, await sphereJson(env.DB, sphere));
}

const nowS = (deps: Deps) => Math.floor(deps.now() / 1000);

/** An admin's own token for the Sphere `sphereId` (which exists): what every change below needs. */
async function admin(request: Request, env: Env, deps: Deps, sphereId: string): Promise<{ sphere: SphereRow; caller: Caller }> {
  const sphere = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere, nowS(deps));
  requireScope(caller, "admin");
  requireOwnerToken(caller);
  return { sphere, caller };
}

const answer = async (env: Env, id: string) => json(200, await sphereJson(env.DB, await requireSphere(env.DB, id)));

// ---------------------------------------------------------------------------------------------
// PATCH /v0.1/spheres/{sphere}: its name. Its id, and so its address, never changes.

export async function updateSphere(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  const { sphere } = await admin(request, env, deps, sphereId);
  const body = await readJson(request);
  const errors = schemaErrors("sphereUpdateRequest", body);
  if (errors.length) throw apiError("bad_request", "the body doesn't match sphere-update.request", errors);
  await env.DB.prepare("UPDATE spheres SET name = ?1 WHERE id = ?2").bind((body as { name: string }).name, sphere.id).run();
  return answer(env, sphere.id);
}

// ---------------------------------------------------------------------------------------------
// Its picture: `PUT …/image` with a square PNG, `DELETE …/image`, and `GET …/image` for members.

/** A PNG's first eight bytes. A picture is at most one request body (http.ts, 128 KB). */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SIDE = { least: 128, most: 1024 };

/** Why `bytes` isn't a picture the Sphere keeps, or null: a PNG, square, 128 to 1,024 pixels a side. */
export function pictureProblem(bytes: Uint8Array): string | null {
  if (bytes.length < 24 || PNG.some((b, i) => bytes[i] !== b)) return "a picture is a PNG";
  // The IHDR chunk comes first: its width and height, big-endian, after its length and type.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return "a picture is a PNG";
  const width = view.getUint32(16), height = view.getUint32(20);
  if (width !== height) return "a picture is square";
  if (width < SIDE.least || width > SIDE.most) return `a picture is ${SIDE.least} to ${SIDE.most} pixels a side`;
  return null;
}

export async function putImage(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  const { sphere } = await admin(request, env, deps, sphereId);
  if ((request.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase() !== "image/png") throw apiError("bad_request", "a picture is sent as Content-Type: image/png");
  const bytes = await readBody(request);
  const problem = pictureProblem(bytes);
  if (problem) throw apiError("bad_request", problem);
  await env.DB.prepare("UPDATE spheres SET image = ?1, image_sha256 = ?2 WHERE id = ?3").bind(b64url(bytes), await sha256Hex(bytes), sphere.id).run();
  return answer(env, sphere.id);
}

export async function deleteImage(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  const { sphere } = await admin(request, env, deps, sphereId);
  await env.DB.prepare("UPDATE spheres SET image = NULL, image_sha256 = NULL WHERE id = ?1").bind(sphere.id).run();
  return answer(env, sphere.id);
}

/** For anyone with a token for it: the PNG, served as nothing but an image. */
export async function getImage(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  const sphere = await requireSphere(env.DB, sphereId);
  await bearer(request, env, sphere, nowS(deps));
  const row = await env.DB.prepare("SELECT image, image_sha256 FROM spheres WHERE id = ?1").bind(sphere.id).first<{ image: string | null; image_sha256: string | null }>();
  if (!row?.image) throw apiError("not_found", "this Sphere has no picture");
  return new Response(fromB64url(row.image), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, no-cache",
      ETag: `"${row.image_sha256}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Who administers it: `PUT …/admins/{owner}` and `DELETE …/admins/{owner}`, at least one always.

export async function putAdmin(request: Request, env: Env, deps: Deps, sphereId: string, owner: string): Promise<Response> {
  const { sphere } = await admin(request, env, deps, sphereId);
  if (!(await getOwner(env.DB, sphere.id, owner))) throw apiError("conflict", `${owner} hasn't joined this Sphere: only someone who has can administer it`);
  await env.DB.prepare("UPDATE owners SET admin = 1 WHERE sphere = ?1 AND owner = ?2").bind(sphere.id, owner).run();
  return answer(env, sphere.id);
}

export async function deleteAdmin(request: Request, env: Env, deps: Deps, sphereId: string, owner: string): Promise<Response> {
  const { sphere } = await admin(request, env, deps, sphereId);
  // One statement, so two admins taking each other's away at once can't leave none.
  const done = await env.DB.prepare(
    "UPDATE owners SET admin = 0 WHERE sphere = ?1 AND owner = ?2 AND admin = 1 AND (SELECT COUNT(*) FROM owners WHERE sphere = ?1 AND admin = 1) > 1",
  ).bind(sphere.id, owner).run();
  if (done.meta.changes === 0) {
    const row = await getOwner(env.DB, sphere.id, owner);
    if (row?.admin === 1) throw apiError("conflict", "a Sphere keeps at least one admin: make someone else one first");
    return answer(env, sphere.id);
  }
  // Their admin tokens stop now, not when they expire.
  await env.DB.prepare("UPDATE tokens SET revoked = 1 WHERE sphere = ?1 AND subject = ?2 AND actor IS NULL AND instr(' ' || scope || ' ', ' admin ') > 0")
    .bind(sphere.id, owner).run();
  return answer(env, sphere.id);
}

// ---------------------------------------------------------------------------------------------
// DELETE /v0.1/spheres/{sphere}: everything it kept goes, in one transaction, and its phone relays
// close. Its id stays taken (`deleted_spheres`).

export async function deleteSphere(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  const { sphere } = await admin(request, env, deps, sphereId);
  const { results: relays } = await env.DB.prepare("SELECT id FROM relays WHERE sphere = ?1").bind(sphere.id).all<{ id: string }>();
  const db = env.DB;
  await db.batch([
    db.prepare("DELETE FROM relay_devices WHERE relay IN (SELECT id FROM relays WHERE sphere = ?1)").bind(sphere.id),
    ...["relays", "runner_status", "deliveries", "audit", "used_jtis", "tokens", "invitations", "member_keys", "members", "owners"].map((table) =>
      db.prepare(`DELETE FROM ${table} WHERE sphere = ?1`).bind(sphere.id),
    ),
    db.prepare("DELETE FROM spheres WHERE id = ?1").bind(sphere.id),
    db.prepare("INSERT INTO deleted_spheres (id, deleted_at) VALUES (?1, ?2)").bind(sphere.id, timestamp(deps.now() / 1000)),
  ]);
  // Their sockets close now (a relay's own check would close them within a minute anyway).
  await Promise.all(relays.map(async (r) => {
    try {
      await env.RELAYS.get(env.RELAYS.idFromName(r.id)).forget(null);
    } catch {}
  }));
  return new Response(null, { status: 204 });
}
