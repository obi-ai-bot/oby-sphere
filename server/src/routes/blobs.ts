// Blobs (spec/sphere-api.md section 10): the ciphertext of artifacts, kept in R2 (the `ARTIFACTS`
// bucket) and never readable here. Uploaded by a member, for the members it names, until it
// expires; fetched only by those members, and only until then, and never after the share that
// named it was taken back; deleted only by its uploader. The Obysphere checks what it can of what
// it can't read: that the first part is an age file with a wrapped X25519 key for each recipient.

import { bearer, requireActor, requireScope } from "../auth.ts";
import { requireSphere } from "../db.ts";
import type { Deps, Env } from "../env.ts";
import { apiError, json } from "../http.ts";
import { uuid } from "../protocol/crypto.ts";
import { MAX_BLOB_BYTES, seconds, timestamp } from "../protocol/envelope.ts";

/** The longest a blob is kept: as long as a message may live (protocol.md section 3). */
export const MAX_BLOB_LIFETIME_SECONDS = 2592000;
/** The most members one blob is for. */
export const MAX_BLOB_RECIPIENTS = 100;
/** An age file's first line (age-encryption.org/v1). */
const AGE_VERSION_LINE = "age-encryption.org/v1\n";
/** How much of an age file's header the Obysphere reads to count its wrapped keys. */
const MAX_HEADER_BYTES = 65536;
const OBI = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const nowS = (deps: Deps) => Math.floor(deps.now() / 1000);

/** The bucket, when this Obysphere keeps blobs; without one it takes no artifact (sphere-api.md section 2, "Features"). */
export function bucket(env: Env): R2Bucket {
  if (!env.ARTIFACTS) throw apiError("not_found", "no such endpoint");
  return env.ARTIFACTS;
}

export const blobKey = (sphere: string, id: string) => `blobs/${sphere}/${id}`;

export interface BlobRow {
  sphere: string;
  id: string;
  uploader: string;
  sha256: string;
  bytes: number;
  expires_at_s: number;
  /** 1 when the caller is among its recipients, 0 when not. */
  named: number;
}

/**
 * Why `head` (an age file's first bytes) can't be the first part of a ciphertext for `recipients`
 * members: not an age file, or fewer wrapped X25519 keys than recipients. "more" when the header
 * hasn't ended yet and `final` is false. Null when it is one.
 */
export function ageHeaderProblem(head: Uint8Array, recipients: number, final: boolean): string | null {
  const text = new TextDecoder("latin1").decode(head);
  const start = AGE_VERSION_LINE.slice(0, Math.min(text.length, AGE_VERSION_LINE.length));
  if (!text.startsWith(start)) return "a blob is an age file (age-encryption.org/v1): only ciphertext is kept";
  const end = text.indexOf("\n---", AGE_VERSION_LINE.length - 1);
  if (end < 0) return final || head.length >= MAX_HEADER_BYTES ? "the age file's header doesn't end where it should" : "more";
  const keys = text.slice(0, end).split("\n").filter((line) => line.startsWith("-> X25519 ")).length;
  return keys >= recipients ? null : `the age file wraps ${keys} X25519 key(s) for ${recipients} recipient(s): one each`;
}

/** Deletes up to `n` blobs of `sphere` that have expired: their ciphertext first, then their rows. */
export async function sweepExpired(env: Env, sphere: string, now: number, n = 20): Promise<void> {
  if (!env.ARTIFACTS) return;
  const { results } = await env.DB.prepare("SELECT id FROM blobs WHERE sphere = ?1 AND expires_at_s <= ?2 LIMIT ?3").bind(sphere, now, n).all<{ id: string }>();
  if (results.length === 0) return;
  await env.ARTIFACTS.delete(results.map((r) => blobKey(sphere, r.id)));
  await env.DB.batch(results.flatMap((r) => forget(env.DB, sphere, r.id)));
}

const forget = (db: D1Database, sphere: string, id: string): D1PreparedStatement[] => [
  db.prepare("DELETE FROM blob_recipients WHERE sphere = ?1 AND blob = ?2").bind(sphere, id),
  db.prepare("DELETE FROM artifact_blobs WHERE sphere = ?1 AND blob = ?2").bind(sphere, id),
  db.prepare("DELETE FROM blobs WHERE sphere = ?1 AND id = ?2").bind(sphere, id),
];

class Refused extends Error {}

/**
 * Streams `request`'s body to `key` in `store`, as ciphertext (section 10, upload checks 4 and 5):
 * `application/octet-stream` with a `Content-Length` of 1 to 64 MiB; with `checkHeader`, an age
 * file whose header wraps a key for each of `recipients`, read before anything reaches the
 * bucket. Counted and hashed on its way; nothing is kept of a body that fails. Its SHA-256 and size.
 */
export async function putCiphertext(store: R2Bucket, key: string, request: Request, recipients: number, checkHeader: boolean): Promise<{ sha256: string; bytes: number }> {
  if ((request.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase() !== "application/octet-stream") throw apiError("bad_request", "a blob is sent as application/octet-stream");
  const length = Number(request.headers.get("Content-Length") ?? "");
  if (!Number.isInteger(length) || length < 1) throw apiError("bad_request", "a blob says its size (Content-Length), at least 1 byte");
  if (length > MAX_BLOB_BYTES) throw apiError("payload_too_large", `a blob is at most ${MAX_BLOB_BYTES} bytes: a larger ciphertext goes up in parts`);
  if (!request.body) throw apiError("bad_request", "a blob has a body");

  // The first part's header is read before anything goes to the bucket: what isn't an age file
  // with a key for each recipient is refused without a byte kept.
  const reader = request.body.getReader();
  const first: Uint8Array[] = [];
  let head = new Uint8Array(0);
  for (let problem = !checkHeader ? null : ageHeaderProblem(head, recipients, false); problem !== null; ) {
    if (problem !== "more") {
      await reader.cancel();
      throw apiError("bad_request", problem);
    }
    const { value, done } = await reader.read();
    if (done) problem = ageHeaderProblem(head, recipients, true) ?? null;
    else {
      first.push(value);
      const more = value.subarray(0, Math.max(0, MAX_HEADER_BYTES - head.length));
      const joined = new Uint8Array(head.length + more.length);
      joined.set(head);
      joined.set(more, head.length);
      head = joined;
      problem = ageHeaderProblem(head, recipients, false);
    }
  }
  const body = new ReadableStream<Uint8Array>({
    start(out) {
      for (const chunk of first) out.enqueue(chunk);
    },
    async pull(out) {
      const { value, done } = await reader.read();
      if (done) out.close();
      else out.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });

  // Then on its way to the bucket: counted and hashed. The bucket keeps nothing of a body that
  // turns out longer or shorter than it said.
  const digest = new crypto.DigestStream("SHA-256");
  const hashing = digest.getWriter();
  // A refused body never finishes its hash: nothing waits on it then.
  const hashed = digest.digest;
  hashed.catch(() => {});
  let seen = 0;
  let refusal: string | null = null;
  const checked = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, out) {
        seen += chunk.byteLength;
        if (seen > length) {
          refusal = "the body is longer than its Content-Length";
          throw new Refused(refusal);
        }
        await hashing.write(chunk);
        out.enqueue(chunk);
      },
      async flush() {
        await hashing.close();
      },
    }),
  );
  try {
    await store.put(key, checked.pipeThrough(new FixedLengthStream(length)), { httpMetadata: { contentType: "application/octet-stream" } });
  } catch (e) {
    await store.delete(key);
    if (refusal !== null) throw apiError("bad_request", refusal);
    if (seen !== length) throw apiError("bad_request", "the body is shorter than its Content-Length");
    throw e;
  }
  return { sha256: [...new Uint8Array(await hashed)].map((b) => b.toString(16).padStart(2, "0")).join(""), bytes: length };
}

// ---------------------------------------------------------------------------------------------
// POST /v0.1/spheres/{sphere}/blobs?to=…&expires_at=…[&part=n]

export async function uploadBlob(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  const store = bucket(env);
  const sphere = await requireSphere(env.DB, sphereId);
  const now = nowS(deps);
  const caller = await bearer(request, env, sphere, now);
  const from = requireActor(caller);
  requireScope(caller, "send:artifact_offer", "reply");
  const url = new URL(request.url);
  for (const name of url.searchParams.keys()) if (!["to", "expires_at", "part"].includes(name)) throw apiError("bad_request", `no query parameter ${name}`);
  const to = url.searchParams.getAll("to");
  if (to.length < 1 || to.length > MAX_BLOB_RECIPIENTS) throw apiError("bad_request", `a blob is for 1 to ${MAX_BLOB_RECIPIENTS} members (to)`);
  if (new Set(to).size !== to.length) throw apiError("bad_request", "a member named twice in to");
  for (const obi of to) {
    if (!OBI.test(obi)) throw apiError("bad_request", "to names members by their ids");
    if (obi === from) throw apiError("bad_request", "a blob is for other members than its uploader");
  }
  const expiresAt = url.searchParams.get("expires_at") ?? "";
  const expires = seconds(expiresAt);
  if (Number.isNaN(expires) || timestamp(expires) !== expiresAt) throw apiError("bad_request", "expires_at is a timestamp like 2026-10-21T12:00:00Z");
  if (!(expires > now) || expires - now > MAX_BLOB_LIFETIME_SECONDS) throw apiError("bad_request", `expires_at is after now and at most ${MAX_BLOB_LIFETIME_SECONDS} seconds ahead`);
  const partParam = url.searchParams.get("part");
  if (partParam !== null && !/^[1-8]$/.test(partParam)) throw apiError("bad_request", "part is 1 to 8: which part of a ciphertext over 64 MiB this is");
  const part = partParam === null ? 1 : Number(partParam);

  const { results: members } = await env.DB.prepare(`SELECT obi, status FROM members WHERE sphere = ?1 AND obi IN (${to.map((_, i) => `?${i + 2}`).join(", ")})`)
    .bind(sphere.id, ...to).all<{ obi: string; status: string }>();
  for (const obi of to) {
    const m = members.find((r) => r.obi === obi);
    if (!m) throw apiError("unknown_recipient", `${obi} is not a member`);
    if (m.status !== "active") throw apiError("recipient_revoked", `${obi} was revoked`);
  }

  const id = uuid();
  const key = blobKey(sphere.id, id);
  const { sha256, bytes: length } = await putCiphertext(store, key, request, to.length, part === 1);
  // The part it went up as is kept: only part 1's age header was checked, so only part 1 may be an
  // offer's one blob or its first part (sphere-api.md section 6.1, check 12).
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO blobs (sphere, id, uploader, sha256, bytes, expires_at_s, created_at_s, part) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)").bind(sphere.id, id, from, sha256, length, expires, now, part),
      ...to.map((obi) => env.DB.prepare("INSERT INTO blob_recipients (sphere, blob, obi) VALUES (?1, ?2, ?3)").bind(sphere.id, id, obi)),
    ]);
  } catch (e) {
    await store.delete(key);
    throw e;
  }
  await sweepExpired(env, sphere.id, now);
  return json(201, { id, sha256, bytes: length, expires: timestamp(expires), to: [...to].sort() });
}

/** The blob `id` of `sphere` as `obi` may see it: undefined when there is none, or it is neither theirs nor for them. */
async function visible(env: Env, sphere: string, id: string, obi: string): Promise<BlobRow | undefined> {
  if (!UUID.test(id)) return undefined;
  const row = await env.DB.prepare(
    "SELECT b.*, EXISTS (SELECT 1 FROM blob_recipients r WHERE r.sphere = b.sphere AND r.blob = b.id AND r.obi = ?3) AS named FROM blobs b WHERE b.sphere = ?1 AND b.id = ?2",
  ).bind(sphere, id, obi).first<BlobRow>();
  return row && (row.named === 1 || row.uploader === obi) ? row : undefined;
}

// ---------------------------------------------------------------------------------------------
// GET /v0.1/spheres/{sphere}/blobs/{id}

export async function fetchBlob(request: Request, env: Env, deps: Deps, sphereId: string, id: string): Promise<Response> {
  const store = bucket(env);
  const sphere = await requireSphere(env.DB, sphereId);
  const now = nowS(deps);
  const caller = await bearer(request, env, sphere, now);
  const obi = requireActor(caller);
  requireScope(caller, "receive");
  // Only a member it is for: anyone else, its uploader included, learns nothing of it.
  const row = await visible(env, sphere.id, id, obi);
  if (!row || row.named !== 1) throw apiError("not_found", "no such blob for you");
  if (row.expires_at_s <= now) {
    await sweepExpired(env, sphere.id, now);
    throw apiError("expired", `the blob expired at ${timestamp(row.expires_at_s)}`);
  }
  const object = await store.get(blobKey(sphere.id, row.id));
  if (!object) throw apiError("not_found", "no such blob for you");
  return new Response(object.body, {
    status: 200,
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(row.bytes), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

// ---------------------------------------------------------------------------------------------
// DELETE /v0.1/spheres/{sphere}/blobs/{id}

export async function deleteBlob(request: Request, env: Env, deps: Deps, sphereId: string, id: string): Promise<Response> {
  const store = bucket(env);
  const sphere = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere, nowS(deps));
  const obi = requireActor(caller);
  requireScope(caller, "send:artifact_offer", "reply");
  const row = await visible(env, sphere.id, id, obi);
  if (!row) throw apiError("not_found", "no such blob for you");
  if (row.uploader !== obi) throw apiError("forbidden", "only its uploader deletes a blob");
  await store.delete(blobKey(sphere.id, row.id));
  await env.DB.batch(forget(env.DB, sphere.id, row.id));
  return new Response(null, { status: 204 });
}
