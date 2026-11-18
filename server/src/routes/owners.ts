// Getting back in with a sign-in (spec/sphere-api.md section 3.2, the extension `owner_rebind`):
// an owner who lost their key binds a new one, and the old key's agents are revoked; and the owner
// events every member reads.

import { bearer, requireOwnerToken, requireScope } from "../auth.ts";
import { getOwner, guardedWrite, memberJson, requireSphere, withRetries, type KeyRow, type MemberRow } from "../db.ts";
import type { Deps, Env } from "../env.ts";
import { apiError, json, readJson } from "../http.ts";
import { cardParams, verifyCard, type AgentCard } from "../protocol/card.ts";
import { keyIdOf } from "../protocol/crypto.ts";
import { timestamp } from "../protocol/envelope.ts";
import { canonicalize } from "../protocol/json.ts";
import { schemaErrors } from "../protocol/schemas.ts";
import { checkSignIn, signsIn } from "../signin.ts";
import { intParam } from "./messages.ts";
import { keyTaken, obiTaken, requirePublishable } from "./members.ts";

const nowS = (deps: Deps) => Math.floor(deps.now() / 1000);

interface EventRow {
  id: number;
  owner: string;
  reason: string;
  at: string;
  old_key_id: string;
  new_key_id: string;
  revoked: string;
}

const eventJson = (e: EventRow): Record<string, unknown> => ({
  id: e.id,
  owner: e.owner,
  reason: e.reason,
  at: e.at,
  old_key_id: e.old_key_id,
  new_key_id: e.new_key_id,
  revoked: JSON.parse(e.revoked) as string[],
});

/** The extension is offered only by a server that signs people in (section 3.1). */
function requireRebind(env: Env): void {
  if (!signsIn(env)) throw apiError("not_found", "no such endpoint");
}

// ---------------------------------------------------------------------------------------------
// POST /v0.1/spheres/{sphere}/owners/{owner}/rebind

export async function rebind(request: Request, env: Env, deps: Deps, sphereId: string, ownerId: string): Promise<Response> {
  requireRebind(env);
  const sphere0 = await requireSphere(env.DB, sphereId);
  // 1. The body.
  const body = await readJson(request);
  const errors = schemaErrors("ownerRebindRequest", body);
  if (errors.length) throw apiError("bad_request", "the body doesn't match owner-rebind.request", errors);
  const req = body as unknown as { owner_key: string; signin: { state: string; code: string }; card?: AgentCard };

  return withRetries(async () => {
    const sphere = await requireSphere(env.DB, sphere0.id);
    const now = nowS(deps);
    // 2. The owner.
    const owner = await getOwner(env.DB, sphere.id, ownerId);
    if (!owner) throw apiError("not_found", `no owner ${ownerId} in this Sphere`);
    // 3. Link first: only an owner who linked an account while holding their key gets back in this way.
    if (!owner.account) throw apiError("account_not_linked", "this owner never added a sign-in: ask an admin to reset them");
    // 4. The sign-in, started for the new key, from the linked account.
    const signin = await checkSignIn(env.DB, req.signin, req.owner_key, now);
    if (owner.account !== signin.account) throw apiError("forbidden", "the owner is linked to another account");
    // 6. A new key.
    if (req.owner_key === owner.owner_key) throw apiError("conflict", "the owner is bound to this key already");
    // 7. The new agent, as redeem checks it (section 4, checks 3, 4 and 6 to 8).
    let joining: { member: MemberRow; key: KeyRow } | null = null;
    if (req.card) {
      const verdict = await verifyCard(req.card, { now });
      if (!verdict.ok) throw apiError("card_invalid", verdict.message);
      const p = cardParams(req.card);
      if (p.sphere !== sphere.id) throw apiError("card_invalid", "the card's sphere is not this Sphere");
      if (p.owner !== ownerId) throw apiError("card_invalid", "the card's owner is not the owner being rebound");
      if (p.owner_key !== req.owner_key) throw apiError("card_invalid", "the card's owner_key is not the body's owner_key");
      if (await keyTaken(env.DB, sphere.id, p.key_id)) throw apiError("conflict", "another member uses this key_id");
      if (await obiTaken(env.DB, sphere.id, p.obi_id)) throw apiError("conflict", `${p.obi_id} is or was a member: Obi ids are never reused`);
      await requirePublishable(env.DB, sphere.id, p.obi_id, req.card);
      joining = {
        member: { sphere: sphere.id, obi: p.obi_id, owner: ownerId, status: "active", joined_at: timestamp(now), revoked_at: null, card: canonicalize(req.card), card_seq: p.card_seq },
        key: { sphere: sphere.id, key_id: p.key_id, obi: p.obi_id, public_key: p.public_key, valid_from_seq: sphere.head_seq + 1, valid_until_seq: null },
      };
    }

    const active = await env.DB.prepare("SELECT obi FROM members WHERE sphere = ?1 AND owner = ?2 AND status = 'active' ORDER BY joined_at, obi")
      .bind(sphere.id, ownerId)
      .all<{ obi: string }>();
    const revoked = active.results.map((r) => r.obi);
    const newKeyId = await keyIdOf(req.owner_key);
    const at = timestamp(now);
    // The owner's active agents, as a subquery each statement reads before the members update.
    const mine = "SELECT obi FROM members WHERE sphere = ?1 AND owner = ?2 AND status = 'active'";
    const db = env.DB;
    const written = await guardedWrite(db, sphere.id, sphere.rev, [
      // Each active agent revoked as DELETE .../members/{obi} revokes it (section 4).
      db.prepare(`UPDATE member_keys SET valid_until_seq = ?3 WHERE sphere = ?1 AND valid_until_seq IS NULL AND obi IN (${mine})`).bind(sphere.id, ownerId, sphere.head_seq),
      db.prepare(`UPDATE deliveries SET state = 'dropped' WHERE sphere = ?1 AND state = 'queued' AND to_obi IN (${mine})`).bind(sphere.id, ownerId),
      db.prepare(`DELETE FROM runner_status WHERE sphere = ?1 AND obi IN (${mine})`).bind(sphere.id, ownerId),
      db.prepare(`DELETE FROM relay_devices WHERE relay IN (SELECT id FROM relays WHERE sphere = ?1 AND obi IN (${mine}))`).bind(sphere.id, ownerId),
      db.prepare(`DELETE FROM relays WHERE sphere = ?1 AND obi IN (${mine})`).bind(sphere.id, ownerId),
      db.prepare("UPDATE members SET status = 'revoked', revoked_at = ?3 WHERE sphere = ?1 AND owner = ?2 AND status = 'active'").bind(sphere.id, ownerId, at),
      // Every token the owner holds: their own, and their agents' (the subject is the owner).
      db.prepare("UPDATE tokens SET revoked = 1 WHERE sphere = ?1 AND subject = ?2").bind(sphere.id, ownerId),
      // The new key; the linked account and the admin flag as they were.
      db.prepare("UPDATE owners SET owner_key = ?3, owner_key_id = ?4 WHERE sphere = ?1 AND owner = ?2").bind(sphere.id, ownerId, req.owner_key, newKeyId),
      // The sign-in, once: a second use fails the table's check and the whole batch.
      db.prepare("UPDATE sign_ins SET used = used + 1 WHERE state = ?1").bind(signin.state),
      db.prepare("INSERT INTO owner_events (sphere, owner, reason, at, old_key_id, new_key_id, revoked) VALUES (?1, ?2, 'signed_in_again', ?3, ?4, ?5, ?6)")
        .bind(sphere.id, ownerId, at, owner.owner_key_id, newKeyId, JSON.stringify(revoked)),
      ...(joining
        ? [
            db.prepare("INSERT INTO members (sphere, obi, owner, status, joined_at, card, card_seq) VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6)").bind(
              joining.member.sphere, joining.member.obi, joining.member.owner, joining.member.joined_at, joining.member.card, joining.member.card_seq,
            ),
            db.prepare("INSERT INTO member_keys (sphere, key_id, obi, public_key, valid_from_seq) VALUES (?1, ?2, ?3, ?4, ?5)").bind(
              joining.key.sphere, joining.key.key_id, joining.key.obi, joining.key.public_key, joining.key.valid_from_seq,
            ),
          ]
        : []),
    ]);
    if (!written) return null;
    const event = await db.prepare("SELECT * FROM owner_events WHERE sphere = ?1 AND owner = ?2 ORDER BY id DESC LIMIT 1").bind(sphere.id, ownerId).first<EventRow>();
    const bound = { owner_key: req.owner_key, owner_key_id: newKeyId };
    return json(200, {
      sphere: sphere.id,
      owner: ownerId,
      ...bound,
      admin: owner.admin === 1,
      event: eventJson(event!),
      ...(joining ? { member: memberJson(joining.member, bound, [joining.key]) } : {}),
    });
  }, deps.retryBudgetMs);
}

// ---------------------------------------------------------------------------------------------
// GET /v0.1/spheres/{sphere}/owner-events?after=&limit=

export async function ownerEvents(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  requireRebind(env);
  const sphere = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere, nowS(deps));
  requireScope(caller, "directory:read");
  const url = new URL(request.url);
  const after = intParam(url, "after", 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = intParam(url, "limit", 1, 100, 50);
  const rows = await env.DB.prepare("SELECT * FROM owner_events WHERE sphere = ?1 AND id > ?2 ORDER BY id LIMIT ?3").bind(sphere.id, after, limit).all<EventRow>();
  return json(200, { sphere: sphere.id, events: rows.results.map(eventJson) });
}

// ---------------------------------------------------------------------------------------------
// PUT /v0.1/spheres/{sphere}/owners/{owner}/account: link first (feature owner_account_link)

const accountAnswer = (sphere: string, owner: string, linked: boolean) => json(200, { sphere, owner, account_linked: linked });

export async function linkAccount(request: Request, env: Env, deps: Deps, sphereId: string, ownerId: string): Promise<Response> {
  requireRebind(env);
  const sphere = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere, nowS(deps));
  // The owner's own token, minted with their key: never an agent's, never someone else's.
  requireOwnerToken(caller);
  if (caller.subject !== ownerId) throw apiError("forbidden", `only ${ownerId}'s own token may link their account`);
  const body = await readJson(request);
  const errors = schemaErrors("ownerAccountRequest", body);
  if (errors.length) throw apiError("bad_request", "the body doesn't match owner-account.request", errors);
  const given = (body as unknown as { signin: { state: string; code: string } }).signin;
  const owner = await getOwner(env.DB, sphere.id, ownerId);
  if (!owner) throw apiError("not_found", `no owner ${ownerId} in this Sphere`);
  // A sign-in started for the key the owner holds now.
  const signin = await checkSignIn(env.DB, given, owner.owner_key, nowS(deps));
  if (owner.account && owner.account !== signin.account) throw apiError("conflict", "the owner is linked to another account");
  const other = await env.DB.prepare("SELECT owner FROM owners WHERE sphere = ?1 AND account = ?2").bind(sphere.id, signin.account).first<{ owner: string }>();
  if (other && other.owner !== ownerId) throw apiError("conflict", "this account is linked to another owner");
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE owners SET account = ?3 WHERE sphere = ?1 AND owner = ?2 AND (account IS NULL OR account = ?3)").bind(sphere.id, ownerId, signin.account),
      // The sign-in, once: a second use fails the table's check and the whole batch.
      env.DB.prepare("UPDATE sign_ins SET used = used + 1 WHERE state = ?1").bind(signin.state),
    ]);
  } catch (e) {
    const failed = String((e as Error)?.message ?? e);
    if (failed.includes("UNIQUE")) throw apiError("conflict", "this account is linked to another owner");
    if (failed.includes("CHECK")) throw apiError("forbidden", "the sign-in is unknown, unfinished, used, expired, or for another owner key");
    throw e;
  }
  return accountAnswer(sphere.id, ownerId, true);
}

// GET /v0.1/spheres/{sphere}/owners/{owner}: whether an account is linked, never which.

export async function ownerAccount(request: Request, env: Env, deps: Deps, sphereId: string, ownerId: string): Promise<Response> {
  requireRebind(env);
  const sphere = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere, nowS(deps));
  if (caller.subject !== ownerId && !caller.scopes.has("admin")) throw apiError("forbidden", `only ${ownerId}, their agents or an admin may read this`);
  const owner = await getOwner(env.DB, sphere.id, ownerId);
  if (!owner) throw apiError("not_found", `no owner ${ownerId} in this Sphere`);
  return accountAnswer(sphere.id, ownerId, !!owner.account);
}
