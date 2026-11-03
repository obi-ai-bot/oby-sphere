// The room (spec/sphere-api.md section 6.5): one shared place per Sphere, in the open to its members
// and sealed from the Sphere. A dumb store: it checks who posted and that they signed it, keeps the
// newest posts as they were sent, and can't read a word of them. Nothing here touches the chain.

import { bearer, requireActor, requireScope } from "../auth.ts";
import { guardedWrite, requireSphere, withRetries, type KeyRow, type SphereRow } from "../db.ts";
import { ring, rung } from "../doorbell.ts";
import type { Deps, Env } from "../env.ts";
import { apiError, json, parseBody, rateLimited, readBody } from "../http.ts";
import { verifyEd25519 } from "../protocol/crypto.ts";
import { CLOCK_SKEW_SECONDS, envelopeSigningInput, seconds, timestamp } from "../protocol/envelope.ts";
import { canonicalize } from "../protocol/json.ts";
import { schemaErrors } from "../protocol/schemas.ts";
import { intParam } from "./messages.ts";

const KEEP = 5000;
const PER_MINUTE = 30;
/** The room's Doorbell, one per Sphere: not an obi_id, so it is no member's own. */
const BELL = "#room";

const nowS = (deps: Deps) => Math.floor(deps.now() / 1000);

type RoomPost = {
  id: string;
  sphere: string;
  from: string;
  created_at: string;
  key_id: string;
  signature: string;
};

interface PostRow {
  seq: number;
  recorded_at_s: number;
  post: string;
}

const answer = (id: string, r: Pick<PostRow, "seq" | "recorded_at_s">) => ({ id, seq: r.seq, recorded_at: timestamp(r.recorded_at_s) });

// POST /v0.1/spheres/{sphere}/room/posts, the checks of section 6.5 in that order.
export async function post(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  const sphere0 = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere0, nowS(deps));
  if (caller.actor === null) throw apiError("unauthorized", "posting needs an Obi's token (one with an actor)");
  requireScope(caller, "reply");
  const value = parseBody(await readBody(request), "invalid_envelope");
  const errors = schemaErrors("roomPostRequest", value);
  if (errors.length) throw apiError("invalid_envelope", errors.join("; "));
  const given = value as unknown as RoomPost;
  if (given.sphere !== sphere0.id) throw apiError("wrong_sphere", `the post is for ${given.sphere}, not ${sphere0.id}`);
  if (given.from !== caller.actor) throw apiError("forbidden", `the token acts for ${caller.actor}, not ${given.from}`);
  const canonical = canonicalize(given);
  const signatureOk = new Map<string, boolean>();

  const done = await withRetries(async () => {
    const now = nowS(deps);
    const reads = await env.DB.batch([
      env.DB.prepare("SELECT * FROM spheres WHERE id = ?1").bind(sphere0.id),
      env.DB.prepare("SELECT seq, recorded_at_s, post FROM room_posts WHERE sphere = ?1 AND id = ?2").bind(sphere0.id, given.id),
      env.DB.prepare("SELECT * FROM member_keys WHERE sphere = ?1 AND obi = ?2 ORDER BY valid_from_seq, rowid").bind(sphere0.id, given.from),
      // The post that would be this sender's 31st back: within the minute, this one is one too many.
      env.DB.prepare(`SELECT recorded_at_s FROM room_posts WHERE sphere = ?1 AND from_obi = ?2 ORDER BY recorded_at_s DESC LIMIT 1 OFFSET ${PER_MINUTE - 1}`).bind(sphere0.id, given.from),
      env.DB.prepare("SELECT MAX(seq) AS seq FROM room_posts WHERE sphere = ?1").bind(sphere0.id),
    ]);
    const rows = <T,>(i: number) => reads[i]!.results as unknown as T[];
    const sphere = rows<SphereRow>(0)[0];
    if (!sphere) throw apiError("not_found", `no Sphere ${sphere0.id}`);
    const stored = rows<PostRow>(1)[0];
    if (stored) {
      if (stored.post === canonical) return { status: 200, seq: stored.seq, recorded_at_s: stored.recorded_at_s };
      throw apiError("duplicate", `a different post with id ${given.id} was stored before`);
    }
    // A revocation ends the member's current key, so this is also "an active member" as of this read.
    const current = rows<KeyRow>(2).find((k) => k.valid_until_seq === null);
    if (!current || current.key_id !== given.key_id) throw apiError("unknown_key", `${given.key_id} is not ${given.from}'s current key`);
    if (!signatureOk.has(current.public_key)) signatureOk.set(current.public_key, await verifyEd25519(current.public_key, envelopeSigningInput(given), given.signature));
    if (!signatureOk.get(current.public_key)) throw apiError("bad_signature", "the signature does not verify");
    // Ahead only: a post that waited through an outage goes out in its same bytes, however old.
    if (seconds(given.created_at) > now + CLOCK_SKEW_SECONDS) throw apiError("clock_skew", `created_at is more than ${CLOCK_SKEW_SECONDS} seconds ahead`);
    const limiting = rows<{ recorded_at_s: number }>(3)[0];
    if (limiting && limiting.recorded_at_s > now - 60) throw rateLimited(`at most ${PER_MINUTE} posts a minute`, limiting.recorded_at_s + 60 - now);
    // The newest post is never trimmed, so MAX(seq) only ever grows and no seq comes back.
    const seq = (rows<{ seq: number | null }>(4)[0]?.seq ?? 0) + 1;
    const written = await guardedWrite(env.DB, sphere.id, sphere.rev, [
      env.DB.prepare("INSERT INTO room_posts (sphere, seq, id, from_obi, recorded_at_s, post) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(sphere.id, seq, given.id, given.from, now, canonical),
      env.DB.prepare("DELETE FROM room_posts WHERE sphere = ?1 AND seq <= ?2").bind(sphere.id, seq - KEEP),
    ]);
    return written && { status: 202, seq, recorded_at_s: now };
  }, deps.retryBudgetMs);
  if (done.status === 202) await ring(env, sphere0.id, BELL);
  return json(done.status, answer(given.id, done));
}

// GET /v0.1/spheres/{sphere}/room/posts?after=&limit=&wait=
export async function posts(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  const sphere = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere, nowS(deps));
  requireActor(caller);
  requireScope(caller, "receive");
  const url = new URL(request.url);
  const after = intParam(url, "after", 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = intParam(url, "limit", 1, 100, 50);
  const wait = intParam(url, "wait", 0, 25, 0);
  const deadline = Date.now() + wait * 1000;
  for (;;) {
    const { results } = await env.DB.prepare("SELECT seq, recorded_at_s, post FROM room_posts WHERE sphere = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3").bind(sphere.id, after, limit).all<PostRow>();
    if (results.length || Date.now() >= deadline) {
      return json(200, { posts: results.map((r) => ({ seq: r.seq, recorded_at: timestamp(r.recorded_at_s), post: JSON.parse(r.post) as unknown })) });
    }
    // ponytail: one bell for every reader of the Sphere, whose "rung since a poll last opened" only
    // the next opener takes; a reader that loses that race sees the post when its `wait` ends: late, never lost.
    await rung(env, sphere.id, BELL, deadline - Date.now());
  }
}
