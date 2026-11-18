// Job channels (spec/sphere-api.md section 6.3; protocol.md section 13): the Worker checks who is
// connecting and to what, then hands the WebSocket to the exchange's ChannelRelay (src/channel.ts),
// which pairs the two sides and forwards their frames without reading them.

import { bearer, presented, requireActor, requireScope, tokenHash } from "../auth.ts";
import { requireSphere } from "../db.ts";
import type { Deps, Env } from "../env.ts";
import { apiError } from "../http.ts";
import { TERMINAL_TYPES, seconds } from "../protocol/envelope.ts";

const nowS = (deps: Deps) => Math.floor(deps.now() / 1000);

/** How long a channel outlives its job's limit: the job's wind-down, and its commits coming back. */
export const CHANNEL_GRACE_SECONDS = 900;
/** The most live job exchanges (accepted, not ended, the job's time not up) an Obi may be in when it opens a channel. */
export const MAX_OPEN_CHANNELS = 8;

/**
 * Why an exchange's channel may not be open now, or null when it may: it needs its accept and no
 * end, and lasts until the accept plus the request's max_minutes plus a grace, whatever the
 * request's expires_at (up to 30 days) says.
 */
export async function channelProblem(db: D1Database, sphere: string, correlationId: string, now: number): Promise<string | null> {
  const [requests, replies] = await db.batch([
    db.prepare("SELECT envelope FROM audit WHERE sphere = ?1 AND msg_id = ?2 AND type = 'run_request'").bind(sphere, correlationId),
    db.prepare("SELECT type, recorded_at FROM audit WHERE sphere = ?1 AND in_reply_to = ?2").bind(sphere, correlationId),
  ]);
  const request = (requests!.results as { envelope: string }[])[0];
  if (!request) return "no such run_request";
  const rows = replies!.results as { type: string; recorded_at: string }[];
  if (rows.some((r) => TERMINAL_TYPES.includes(r.type))) return "the exchange has ended";
  const accept = rows.find((r) => r.type === "accept");
  if (!accept) return "the run_request hasn't been accepted";
  const minutes = (JSON.parse(request.envelope) as { body: { max_minutes?: number } }).body.max_minutes ?? 480;
  if (!(seconds(accept.recorded_at) + minutes * 60 + CHANNEL_GRACE_SECONDS > now)) return "the job's time is up";
  return null;
}

export async function openChannel(request: Request, env: Env, deps: Deps, sphereId: string, correlationId: string): Promise<Response> {
  const sphere = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere, nowS(deps));
  requireScope(caller, "receive");
  const obi = requireActor(caller);
  if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") throw apiError("bad_request", "a job channel is a WebSocket: Upgrade: websocket");
  const row = await env.DB.prepare("SELECT from_obi, to_obi FROM audit WHERE sphere = ?1 AND msg_id = ?2 AND type = 'run_request'")
    .bind(sphere.id, correlationId)
    .first<{ from_obi: string; to_obi: string }>();
  if (!row) throw apiError("not_found", `no run_request ${correlationId}`);
  const role = obi === row.from_obi ? "guest" : obi === row.to_obi ? "host" : null;
  if (!role) throw apiError("forbidden", "only the exchange's two Obis open its channel");
  const problem = await channelProblem(env.DB, sphere.id, correlationId, nowS(deps));
  if (problem) throw apiError("conflict", problem);
  // At most this many live job exchanges for one Obi when it opens a channel: its others, accepted, not ended, the job's time not up.
  const live = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM audit r JOIN audit a ON a.sphere = r.sphere AND a.in_reply_to = r.msg_id AND a.type = 'accept'
      WHERE r.sphere = ?1 AND r.type = 'run_request' AND (r.from_obi = ?2 OR r.to_obi = ?2) AND r.msg_id != ?3
        AND NOT EXISTS (SELECT 1 FROM audit t WHERE t.sphere = r.sphere AND t.in_reply_to = r.msg_id AND t.type IN (${TERMINAL_TYPES.map((t) => `'${t}'`).join(", ")}))
        AND CAST(strftime('%s', a.recorded_at) AS INTEGER) + COALESCE(json_extract(r.envelope, '$.body.max_minutes'), 480) * 60 + ?4 > ?5`,
  ).bind(sphere.id, obi, correlationId, CHANNEL_GRACE_SECONDS, nowS(deps)).first<{ n: number }>();
  if ((live?.n ?? 0) >= MAX_OPEN_CHANNELS) throw apiError("rate_limited", `an Obi may be in at most ${MAX_OPEN_CHANNELS} live job exchanges at once`);
  const relay = env.CHANNELS.get(env.CHANNELS.idFromName(`${sphere.id}/${correlationId}`));
  // The relay checks this token stays unrevoked (a card rotation or a revocation revokes it).
  const token = presented(request)!.token;
  // The Worker's clock, as the relay's alarms read it (zero apart in production; a test's own clock otherwise).
  const headers = new Headers({ Upgrade: "websocket", "X-Obi-Clock-Offset": String(deps.now() - Date.now()), "X-Obi-Token": await tokenHash(token), "X-Obi-Role": role, "X-Obi-Sphere": sphere.id, "X-Obi-Exchange": correlationId, "X-Obi-Guest": row.from_obi, "X-Obi-Host": row.to_obi });
  return relay.fetch("https://channel.internal/", { headers });
}
