// The phone relay (spec/sphere-api.md section 9), an optional extension (`phone_relay`): a member's
// agent (the "Mac" below, the machine it runs on) registers a relay and the SHA-256 of each paired
// phone's relay token; the Worker checks who opens a relay socket, then hands it to the relay's
// PhoneRelay (src/relay.ts), which passes the sealed frames between the agent and its phones without
// reading them. The operator turns it off with PHONE_RELAY=off: then every relay path answers 404
// and /v0.1/features doesn't list it.

import { bearer, presented, requireActor, requireScope, tokenHash, unauthorized } from "../auth.ts";
import type { Deps, Env } from "../env.ts";
import { apiError, json } from "../http.ts";

/** The most relays one Mac (one member's Obi) owns. */
export const MAX_RELAYS = 4;
/** The most phones one relay has. */
export const MAX_DEVICES = 16;
const RELAY_ID = /^[A-Za-z0-9_-]{22,43}$/;
const DEVICE = /^[0-9a-f]{64}$/;

const nowS = (deps: Deps) => Math.floor(deps.now() / 1000);

let warned = false;

/** Whether this Sphere server offers the phone relay: PHONE_RELAY empty or `on`. `off`, or anything else (with a line in the log), turns it off. */
export function phoneRelay(env: Env): boolean {
  const setting = (env.PHONE_RELAY ?? "").trim().toLowerCase();
  if (setting === "" || setting === "on") return true;
  if (setting !== "off" && !warned) {
    warned = true;
    console.warn("relay: PHONE_RELAY is neither on nor off, so the phone relay is off");
  }
  return false;
}

/** A relay id from the path, once the relay is known to be offered (404 not_found otherwise, as for any path a server doesn't serve). */
function relayId(env: Env, id: string): string {
  if (!phoneRelay(env)) throw apiError("not_found", "this Sphere server offers no phone relay");
  if (!RELAY_ID.test(id)) throw apiError("bad_request", "a relay id is 22 to 43 base64url characters");
  return id;
}

/** A Mac: a member's Obi, with the SHA-256 of the access token it called with (its relay checks it while it's connected). */
interface Mac {
  sphere: string;
  obi: string;
  token: string;
}

function deviceId(id: string): string {
  if (!DEVICE.test(id)) throw apiError("bad_request", "a device is the lower-case hex SHA-256 of its relay token");
  return id;
}

/** The Mac behind the request: an Obi's access token with `receive`, from any Sphere on this server. */
async function mac(request: Request, env: Env, deps: Deps): Promise<Mac> {
  const caller = await bearer(request, env, null, nowS(deps));
  const obi = requireActor(caller);
  requireScope(caller, "receive");
  return { sphere: caller.sphere, obi, token: await tokenHash(presented(request)!.token) };
}

const ownerOf = (env: Env, relay: string) => env.DB.prepare("SELECT sphere, obi FROM relays WHERE id = ?1").bind(relay).first<{ sphere: string; obi: string }>();
const owns = (owner: { sphere: string; obi: string }, m: Mac) => owner.sphere === m.sphere && owner.obi === m.obi;

async function ownRelay(env: Env, relay: string, m: Mac): Promise<void> {
  const owner = await ownerOf(env, relay);
  if (!owner) throw apiError("not_found", "no such relay");
  if (!owns(owner, m)) throw apiError("forbidden", "this relay is another Mac's");
}

async function answer(env: Env, relay: string, status: number): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT token_sha256 FROM relay_devices WHERE relay = ?1 ORDER BY token_sha256").bind(relay).all<{ token_sha256: string }>();
  return json(status, { relay, devices: results.map((r) => r.token_sha256) });
}

const stub = (env: Env, relay: string) => env.RELAYS.get(env.RELAYS.idFromName(relay));

export async function putRelay(request: Request, env: Env, deps: Deps, id: string): Promise<Response> {
  const relay = relayId(env, id);
  const m = await mac(request, env, deps);
  // One statement, so two at once can't pass the limit.
  const made = await env.DB.prepare(
    "INSERT OR IGNORE INTO relays (id, sphere, obi, created_at_s) SELECT ?1, ?2, ?3, ?4 WHERE (SELECT COUNT(*) FROM relays WHERE sphere = ?2 AND obi = ?3) < ?5",
  ).bind(relay, m.sphere, m.obi, nowS(deps), MAX_RELAYS).run();
  if (made.meta.changes > 0) return answer(env, relay, 201);
  const owner = await ownerOf(env, relay);
  if (!owner) throw apiError("rate_limited", `a Mac owns at most ${MAX_RELAYS} relays: delete one first`);
  if (!owns(owner, m)) throw apiError("conflict", "this relay id is another Mac's");
  return answer(env, relay, 200);
}

export async function deleteRelay(request: Request, env: Env, deps: Deps, id: string): Promise<Response> {
  const relay = relayId(env, id);
  await ownRelay(env, relay, await mac(request, env, deps));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM relay_devices WHERE relay = ?1").bind(relay),
    env.DB.prepare("DELETE FROM relays WHERE id = ?1").bind(relay),
  ]);
  await stub(env, relay).forget(null);
  return new Response(null, { status: 204 });
}

export async function putDevice(request: Request, env: Env, deps: Deps, id: string, device: string): Promise<Response> {
  const relay = relayId(env, id);
  const token = deviceId(device);
  await ownRelay(env, relay, await mac(request, env, deps));
  const added = await env.DB.prepare(
    "INSERT OR IGNORE INTO relay_devices (relay, token_sha256, added_at_s) SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM relay_devices WHERE relay = ?1) < ?4",
  ).bind(relay, token, nowS(deps), MAX_DEVICES).run();
  if (added.meta.changes > 0) return answer(env, relay, 201);
  const has = await env.DB.prepare("SELECT 1 AS has FROM relay_devices WHERE relay = ?1 AND token_sha256 = ?2").bind(relay, token).first();
  if (!has) throw apiError("rate_limited", `a relay has at most ${MAX_DEVICES} devices: forget one first`);
  return answer(env, relay, 200);
}

export async function deleteDevice(request: Request, env: Env, deps: Deps, id: string, device: string): Promise<Response> {
  const relay = relayId(env, id);
  const token = deviceId(device);
  await ownRelay(env, relay, await mac(request, env, deps));
  const gone = await env.DB.prepare("DELETE FROM relay_devices WHERE relay = ?1 AND token_sha256 = ?2").bind(relay, token).run();
  if (gone.meta.changes === 0) throw apiError("not_found", "the relay has no such device");
  await stub(env, relay).forget(token);
  return new Response(null, { status: 204 });
}

/** `GET /v0.1/relay/{relay}`, a WebSocket: a phone with its relay token, or the relay's Mac. */
export async function openRelay(request: Request, env: Env, deps: Deps, id: string): Promise<Response> {
  const relay = relayId(env, id);
  if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") throw apiError("bad_request", "a relay is a WebSocket: Upgrade: websocket");
  const given = presented(request);
  if (!given) throw unauthorized(env, "a relay token or the Mac's access token is needed: Authorization: Bearer <…>");
  // The Worker's clock, as the relay's alarms read it (zero apart in production; a test's own clock otherwise).
  const headers = new Headers({ Upgrade: "websocket", "X-Obi-Relay": relay, "X-Obi-Clock-Offset": String(deps.now() - Date.now()) });
  // A phone's relay token is a bearer secret; a token bound to a key is only ever the Mac's.
  const hash = await tokenHash(given.token);
  const phone = given.scheme === "Bearer" && (await env.DB.prepare("SELECT 1 AS phone FROM relay_devices WHERE relay = ?1 AND token_sha256 = ?2").bind(relay, hash).first());
  if (phone) headers.set("X-Obi-Device", hash);
  else {
    const m = await mac(request, env, deps);
    await ownRelay(env, relay, m);
    headers.set("X-Obi-Mac", JSON.stringify(m));
  }
  return stub(env, relay).fetch("https://relay.internal/", { headers });
}
