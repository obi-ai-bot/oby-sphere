// Getting back in with a sign-in (spec/sphere-api.md section 3.2, the extension `owner_rebind`):
// an owner who lost their key binds a new one, and the old key's agents are revoked; and the owner
// events every member reads.

import { deleteRevokedMembersLinks } from "./public.ts";
import { adminOrOperator, bearer, isOperator, requireOwnerToken, requireScope } from "../auth.ts";
import { getOwner, guardedWrite, memberJson, operatorLogStatement, requireSphere, withRetries, type KeyRow, type MemberRow, type OwnerRow, type SphereRow } from "../db.ts";
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

/** The statements that join a new agent, as redeem writes it. */
const joinStatements = (db: D1Database, j: { member: MemberRow; key: KeyRow }): D1PreparedStatement[] => [
  db.prepare("INSERT INTO members (sphere, obi, owner, status, joined_at, card, card_seq) VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6)").bind(
    j.member.sphere, j.member.obi, j.member.owner, j.member.joined_at, j.member.card, j.member.card_seq,
  ),
  db.prepare("INSERT INTO member_keys (sphere, key_id, obi, public_key, valid_from_seq) VALUES (?1, ?2, ?3, ?4, ?5)").bind(j.key.sphere, j.key.key_id, j.key.obi, j.key.public_key, j.key.valid_from_seq),
];

/**
 * Binds `newKey` to `owner` in one guarded write (sections 3.2 and 3.3): each of the owner's
 * active agents revoked as DELETE .../members/{obi} revokes it, every token the owner holds
 * revoked, the linked account and admin flag kept, an owner event with `reason` recorded, and `statements` in the same
 * batch. Null when another write got in first (withRetries tries again).
 */
export async function replaceOwnerKey(
  env: Env, sphere: SphereRow, owner: OwnerRow, newKey: string, now: number,
  o: { reason: "signed_in_again" | "admin_reset" | "operator_reset"; statements?: D1PreparedStatement[] },
): Promise<{ bound: { owner_key: string; owner_key_id: string }; answer: Record<string, unknown> } | null> {
  const db = env.DB;
  const ownerId = owner.owner;
  const active = await db.prepare("SELECT obi FROM members WHERE sphere = ?1 AND owner = ?2 AND status = 'active' ORDER BY joined_at, obi").bind(sphere.id, ownerId).all<{ obi: string }>();
  const revoked = active.results.map((r) => r.obi);
  const newKeyId = await keyIdOf(newKey);
  const at = timestamp(now);
  // The owner's active agents, as a subquery each statement reads before the members update.
  const mine = "SELECT obi FROM members WHERE sphere = ?1 AND owner = ?2 AND status = 'active'";
  const written = await guardedWrite(db, sphere.id, sphere.rev, [
    db.prepare(`UPDATE member_keys SET valid_until_seq = ?3 WHERE sphere = ?1 AND valid_until_seq IS NULL AND obi IN (${mine})`).bind(sphere.id, ownerId, sphere.head_seq),
    db.prepare(`UPDATE deliveries SET state = 'dropped' WHERE sphere = ?1 AND state = 'queued' AND to_obi IN (${mine})`).bind(sphere.id, ownerId),
    db.prepare(`DELETE FROM runner_status WHERE sphere = ?1 AND obi IN (${mine})`).bind(sphere.id, ownerId),
    db.prepare(`DELETE FROM relay_devices WHERE relay IN (SELECT id FROM relays WHERE sphere = ?1 AND obi IN (${mine}))`).bind(sphere.id, ownerId),
    db.prepare(`DELETE FROM relays WHERE sphere = ?1 AND obi IN (${mine})`).bind(sphere.id, ownerId),
    db.prepare("UPDATE members SET status = 'revoked', revoked_at = ?3 WHERE sphere = ?1 AND owner = ?2 AND status = 'active'").bind(sphere.id, ownerId, at),
    // Every token the owner holds: their own, and their agents' (the subject is the owner).
    db.prepare("UPDATE tokens SET revoked = 1 WHERE sphere = ?1 AND subject = ?2").bind(sphere.id, ownerId),
    // The new key; the admin flag as it was.
    db.prepare("UPDATE owners SET owner_key = ?3, owner_key_id = ?4 WHERE sphere = ?1 AND owner = ?2").bind(sphere.id, ownerId, newKey, newKeyId),
    db.prepare("INSERT INTO owner_events (sphere, owner, reason, at, old_key_id, new_key_id, revoked) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(sphere.id, ownerId, o.reason, at, owner.owner_key_id, newKeyId, JSON.stringify(revoked)),
    ...(o.statements ?? []),
  ]);
  if (!written) return null;
  // The revoked agents' public links go with them (sphere-api.md section 11).
  await deleteRevokedMembersLinks(env, sphere.id);
  const event = await db.prepare("SELECT * FROM owner_events WHERE sphere = ?1 AND owner = ?2 ORDER BY id DESC LIMIT 1").bind(sphere.id, ownerId).first<EventRow>();
  const bound = { owner_key: newKey, owner_key_id: newKeyId };
  return { bound, answer: { sphere: sphere.id, owner: ownerId, ...bound, admin: owner.admin === 1, event: eventJson(event!) } };
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

    const done = await replaceOwnerKey(env, sphere, owner, req.owner_key, now, {
      reason: "signed_in_again",
      statements: [
        // The sign-in, once: a second use fails the table's check and the whole batch.
        env.DB.prepare("UPDATE sign_ins SET used = used + 1 WHERE state = ?1").bind(signin.state),
        ...(joining ? joinStatements(env.DB, joining) : []),
      ],
    });
    if (!done) return null;
    return json(200, {
      ...done.answer,
      ...(joining ? { member: memberJson(joining.member, done.bound, [joining.key]) } : {}),
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
// The operator's and admins' supported acts (sphere-api.md section 3.3), in place of hand edits of
// the database: the same writes the API makes, each operator call logged.

/** POST /v0.1/spheres/{sphere}/owners/{owner}/reset: bind a key the owner gave out of band. */
export async function resetOwner(request: Request, env: Env, deps: Deps, sphereId: string, ownerId: string): Promise<Response> {
  const sphere0 = await requireSphere(env.DB, sphereId);
  const who = await adminOrOperator(request, env, sphere0, nowS(deps));
  const body = await readJson(request);
  const errors = schemaErrors("ownerResetRequest", body);
  if (errors.length) throw apiError("bad_request", "the body doesn't match owner-reset.request", errors);
  const newKey = (body as unknown as { owner_key: string }).owner_key;

  return withRetries(async () => {
    const sphere = await requireSphere(env.DB, sphere0.id);
    const now = nowS(deps);
    const owner = await getOwner(env.DB, sphere.id, ownerId);
    if (!owner) throw apiError("not_found", `no owner ${ownerId} in this Sphere`);
    if (newKey === owner.owner_key) throw apiError("conflict", "the owner is bound to this key already");
    const done = await replaceOwnerKey(env, sphere, owner, newKey, now, {
      reason: who.operator ? "operator_reset" : "admin_reset",
      statements: who.operator ? [operatorLogStatement(env.DB, sphere.id, now, "reset_owner", ownerId)] : [],
    });
    return done ? json(200, done.answer) : null;
  }, deps.retryBudgetMs);
}

/** GET /v0.1/spheres/{sphere}/owners: who is bound, with what key, who administers, and their agents. Never an account. */
export async function listOwners(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  const sphere = await requireSphere(env.DB, sphereId);
  const who = await adminOrOperator(request, env, sphere, nowS(deps));
  const [owners, members] = await env.DB.batch([
    env.DB.prepare("SELECT owner, owner_key_id, admin, account IS NOT NULL AS linked FROM owners WHERE sphere = ?1 ORDER BY owner").bind(sphere.id),
    env.DB.prepare("SELECT obi, owner, status FROM members WHERE sphere = ?1 ORDER BY joined_at, obi").bind(sphere.id),
  ]);
  if (who.operator) await operatorLogStatement(env.DB, sphere.id, nowS(deps), "show", null).run();
  const rows = owners!.results as unknown as { owner: string; owner_key_id: string; admin: number; linked: number }[];
  const byOwner = new Map<string, { obi: string; status: string }[]>();
  for (const m of members!.results as unknown as { obi: string; owner: string; status: string }[]) byOwner.set(m.owner, [...(byOwner.get(m.owner) ?? []), { obi: m.obi, status: m.status }]);
  const named = new Set(rows.map((r) => r.owner));
  return json(200, {
    sphere: sphere.id,
    owners: rows.map((r) => ({ owner: r.owner, owner_key_id: r.owner_key_id, admin: r.admin === 1, account_linked: r.linked === 1, members: byOwner.get(r.owner) ?? [] })),
    // Members whose owner has no row (a hand edit of the database), so the operator sees them too.
    unbound: [...byOwner.entries()].filter(([o]) => !named.has(o)).flatMap(([owner, ms]) => ms.map((m) => ({ owner, ...m }))),
  });
}

/** GET /v0.1/spheres/{sphere}/operator-log?after=&limit=: what the operator did here. */
export async function operatorLog(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  const sphere = await requireSphere(env.DB, sphereId);
  await adminOrOperator(request, env, sphere, nowS(deps));
  const url = new URL(request.url);
  const after = intParam(url, "after", 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = intParam(url, "limit", 1, 100, 50);
  const rows = await env.DB.prepare("SELECT id, at, action, target FROM operator_log WHERE sphere = ?1 AND id > ?2 ORDER BY id LIMIT ?3").bind(sphere.id, after, limit)
    .all<{ id: number; at: string; action: string; target: string | null }>();
  return json(200, { sphere: sphere.id, entries: rows.results.map((r) => ({ id: r.id, at: r.at, action: r.action, ...(r.target === null ? {} : { target: r.target }) })) });
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
  // The owner or their agents, an admin, or the operator (section 3.3).
  if (!(await isOperator(request, env))) {
    const caller = await bearer(request, env, sphere, nowS(deps));
    if (caller.subject !== ownerId && !caller.scopes.has("admin")) throw apiError("forbidden", `only ${ownerId}, their agents or an admin may read this`);
  }
  const owner = await getOwner(env.DB, sphere.id, ownerId);
  if (!owner) throw apiError("not_found", `no owner ${ownerId} in this Sphere`);
  return accountAnswer(sphere.id, ownerId, !!owner.account);
}
