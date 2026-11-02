// Invitations, pairing and the directory (spec/sphere-api.md section 4; spec/identity.md section 3).

import { bearer, requireActor, requireOwnerToken, requireScope } from "../auth.ts";
import {
  getKeys, getMember, getOwner, guardedWrite, loadMemberJson, memberJson, requireSphere, withRetries, type KeyRow, type MemberRow,
  type OwnerRow,
} from "../db.ts";
import type { Deps, Env } from "../env.ts";
import { apiError, json, readJson } from "../http.ts";
import { cardParams, featuresUsed, publishingProblem, verifyCard, type AgentCard } from "../protocol/card.ts";
import { constantTimeEqual, keyIdOf, randomToken, sha256, sha256Hex, uuid } from "../protocol/crypto.ts";
import { timestamp } from "../protocol/envelope.ts";
import { canonicalize, utf8 } from "../protocol/json.ts";
import { schemaErrors } from "../protocol/schemas.ts";
import { checkSignIn, signsIn, type SignIn } from "../signin.ts";
import { visibleRunners } from "./runner.ts";

const nowS = (deps: Deps) => Math.floor(deps.now() / 1000);

/** Whether `obi` is or was a member, or another member uses `keyId`. */
const obiTaken = async (db: D1Database, sphere: string, obi: string) => (await getMember(db, sphere, obi)) !== null;
const keyTaken = async (db: D1Database, sphere: string, keyId: string) =>
  (await db.prepare("SELECT 1 AS taken FROM member_keys WHERE sphere = ?1 AND key_id = ?2").bind(sphere, keyId).first()) !== null;

/** 409 feature_not_taken for a card that publishes an addition another active member doesn't take
 *  yet (identity.md section 2.3, "Publishing a card with an addition"). What the card it replaces
 *  (`current`) carries already isn't held back, so a member can always rotate its key. */
async function requirePublishable(db: D1Database, sphere: string, obi: string, card: AgentCard, current?: AgentCard): Promise<void> {
  const carried = new Set(current ? featuresUsed(cardParams(current)) : []);
  if (featuresUsed(cardParams(card)).every((f) => carried.has(f))) return;
  const rows = await db.prepare("SELECT obi, card FROM members WHERE sphere = ?1 AND status = 'active' AND obi != ?2").bind(sphere, obi).all<{ obi: string; card: string }>();
  const problem = publishingProblem(cardParams(card), rows.results.map((r) => ({ obi: r.obi, card: JSON.parse(r.card) as AgentCard })), carried);
  if (problem) throw apiError("feature_not_taken", problem);
}

// ---------------------------------------------------------------------------------------------
// POST /v0.1/spheres/{sphere}/invitations

export async function invite(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  const sphere = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere, nowS(deps));
  requireScope(caller, "admin");
  requireOwnerToken(caller);
  const body = await readJson(request);
  const errors = schemaErrors("invitationRequest", body);
  if (errors.length) throw apiError("bad_request", "the body doesn't match invitation.request", errors);
  // A named invitation (owner and obi) is used once; an open one by up to max_uses Obis.
  const req = body as unknown as { owner?: string; obi?: string; expires_in: number; max_uses?: number; domain?: string; label?: string };
  // Only a Sphere server that signs people in can tell who is at a domain (section 3.1).
  if (req.domain !== undefined && !signsIn(env)) throw apiError("forbidden", "this Sphere server has no sign-in, so it can't limit an invitation to a domain");
  if (req.obi !== undefined && (await obiTaken(env.DB, sphere.id, req.obi))) throw apiError("conflict", `${req.obi} is or was a member: Obi ids are never reused`);
  const id = uuid();
  const secret = randomToken(32);
  const expiresAt = nowS(deps) + req.expires_in;
  const maxUses = req.max_uses ?? 1;
  await env.DB.prepare(
    "INSERT INTO invitations (id, sphere, owner, obi, secret_sha256, expires_at_s, max_uses, domain, label, created_at_s) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
  )
    .bind(id, sphere.id, req.owner ?? null, req.obi ?? null, await sha256Hex(utf8(secret)), expiresAt, maxUses, req.domain ?? null, req.label ?? null, nowS(deps))
    .run();
  const named = req.owner !== undefined ? { owner: req.owner, obi: req.obi } : {};
  const domain = req.domain !== undefined ? { domain: req.domain } : {};
  const label = req.label !== undefined ? { label: req.label } : {};
  return json(201, { invitation_id: id, sphere: sphere.id, ...named, max_uses: maxUses, ...domain, ...label, secret, expires_at: timestamp(expiresAt) });
}

// ---------------------------------------------------------------------------------------------
// GET /v0.1/spheres/{sphere}/invitations: for its admins, those that can still be used, the
// newest first, with what each was for. Never a secret: only its hash is kept.

export async function listInvitations(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  const sphere = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere, nowS(deps));
  requireScope(caller, "admin");
  requireOwnerToken(caller);
  const { results } = await env.DB.prepare(
    `SELECT id, owner, obi, label, max_uses, uses, domain, created_at_s, expires_at_s FROM invitations
      WHERE sphere = ?1 AND uses < max_uses AND expires_at_s > ?2 ORDER BY created_at_s DESC, rowid DESC LIMIT 1000`,
  ).bind(sphere.id, nowS(deps)).all<{
    id: string; owner: string | null; obi: string | null; label: string | null; max_uses: number; uses: number; domain: string | null;
    created_at_s: number | null; expires_at_s: number;
  }>();
  return json(200, {
    sphere: sphere.id,
    invitations: results.map((r) => ({
      invitation_id: r.id,
      ...(r.owner !== null ? { owner: r.owner, obi: r.obi } : {}),
      ...(r.label !== null ? { label: r.label } : {}),
      max_uses: r.max_uses,
      uses: r.uses,
      ...(r.domain !== null ? { domain: r.domain } : {}),
      ...(r.created_at_s !== null ? { created_at: timestamp(r.created_at_s) } : {}),
      expires_at: timestamp(r.expires_at_s),
    })),
  });
}

// ---------------------------------------------------------------------------------------------
// DELETE /v0.1/spheres/{sphere}/invitations/{invitation_id}: withdrawn, at once.

export async function withdrawInvitation(request: Request, env: Env, deps: Deps, sphereId: string, invitationId: string): Promise<Response> {
  const sphere0 = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere0, nowS(deps));
  requireScope(caller, "admin");
  requireOwnerToken(caller);
  return withRetries(async () => {
    const sphere = await requireSphere(env.DB, sphere0.id);
    const found = await env.DB.prepare("SELECT 1 AS found FROM invitations WHERE id = ?1 AND sphere = ?2").bind(invitationId, sphere.id).first();
    if (!found) throw apiError("not_found", `no invitation ${invitationId}`);
    // A guarded write: a redeem that read the invitation before this loses its turn and reads again.
    const written = await guardedWrite(env.DB, sphere.id, sphere.rev, [
      env.DB.prepare("DELETE FROM invitations WHERE id = ?1 AND sphere = ?2").bind(invitationId, sphere.id),
    ]);
    if (!written) return null;
    return new Response(null, { status: 204 });
  }, deps.retryBudgetMs);
}

// ---------------------------------------------------------------------------------------------
// POST /v0.1/spheres/{sphere}/invitations/{invitation_id}/redeem

interface InvitationRow {
  id: string;
  sphere: string;
  owner: string | null;
  obi: string | null;
  secret_sha256: string;
  expires_at_s: number;
  max_uses: number;
  uses: number;
  domain: string | null;
}

const DUMMY_HASH = "0".repeat(64);

/** The invitation if it can still be used with `secret`: every way it can't answers the same. */
async function usableInvitation(db: D1Database, sphere: string, invitationId: string, secret: string, now: number): Promise<InvitationRow> {
  const givenHash = await sha256(utf8(secret));
  const inv = await db.prepare("SELECT * FROM invitations WHERE id = ?1 AND sphere = ?2").bind(invitationId, sphere).first<InvitationRow>();
  const secretOk = constantTimeEqual(givenHash, fromHex(inv?.secret_sha256 ?? DUMMY_HASH));
  if (!inv || inv.uses >= inv.max_uses || inv.expires_at_s <= now || !secretOk) throw apiError("invitation_invalid", "the invitation is unknown, used up, expired, or the secret is wrong");
  return inv;
}

// ---------------------------------------------------------------------------------------------
// POST /v0.1/spheres/{sphere}/invitations/{invitation_id}/preview: what a Join screen shows.

export async function previewInvitation(request: Request, env: Env, deps: Deps, sphereId: string, invitationId: string): Promise<Response> {
  const sphere = await requireSphere(env.DB, sphereId);
  const body = await readJson(request);
  const errors = schemaErrors("invitationPreviewRequest", body);
  if (errors.length) throw apiError("bad_request", "the body doesn't match invitation-preview.request", errors);
  const inv = await usableInvitation(env.DB, sphere.id, invitationId, (body as unknown as { secret: string }).secret, nowS(deps));
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE sphere = ?1 AND status = 'active'").bind(sphere.id).first<{ n: number }>();
  return json(200, { sphere: sphere.id, name: sphere.name, member_count: count?.n ?? 0, expires_at: timestamp(inv.expires_at_s), ...(inv.domain ? { domain: inv.domain } : {}) });
}

// ---------------------------------------------------------------------------------------------
// POST /v0.1/spheres/{sphere}/invitations/{invitation_id}/redeem

export async function redeem(request: Request, env: Env, deps: Deps, sphereId: string, invitationId: string): Promise<Response> {
  const sphere0 = await requireSphere(env.DB, sphereId);
  // 1. The body.
  const body = await readJson(request);
  const errors = schemaErrors("redeemRequest", body);
  if (errors.length) throw apiError("bad_request", "the body doesn't match redeem.request", errors);
  const req = body as unknown as { secret: string; owner_key: string; card: AgentCard; signin?: { state: string; code: string } };

  return withRetries(async () => {
    const sphere = await requireSphere(env.DB, sphere0.id);
    const now = nowS(deps);
    // 2. The invitation.
    const inv = await usableInvitation(env.DB, sphere.id, invitationId, req.secret, now);
    // An invitation for one Workspace: a sign-in from it, for this owner key (section 3.1).
    let signin: SignIn | null = null;
    if (inv.domain !== null) {
      if (!req.signin) throw apiError("forbidden", `this invitation is for ${inv.domain} accounts: sign in first`);
      signin = await checkSignIn(env.DB, req.signin, req.owner_key, now);
      if (signin.workspace !== inv.domain) throw apiError("forbidden", `this invitation is for ${inv.domain} accounts`);
    }
    // 3 and 4. The card, and that it is the invitation's. An open invitation's card names its own Obi and owner.
    const verdict = await verifyCard(req.card, { now });
    if (!verdict.ok) throw apiError("card_invalid", verdict.message);
    const p = cardParams(req.card);
    if (p.sphere !== sphere.id) throw apiError("card_invalid", "the card's sphere is not this Sphere");
    if (inv.owner !== null && (p.obi_id !== inv.obi || p.owner !== inv.owner)) throw apiError("card_invalid", "the card's obi_id or owner is not the invitation's");
    if (p.owner_key !== req.owner_key) throw apiError("card_invalid", "the card's owner_key is not the body's owner_key");
    // 5. The owner's bound key.
    const bound = await getOwner(env.DB, sphere.id, p.owner);
    if (bound && bound.owner_key !== req.owner_key) throw apiError("forbidden", "the owner already has another bound key");
    // One owner per account.
    if (signin) {
      if (bound?.account && bound.account !== signin.account) throw apiError("forbidden", "the owner is bound to another account");
      const other = await env.DB.prepare("SELECT owner FROM owners WHERE sphere = ?1 AND account = ?2").bind(sphere.id, signin.account).first<{ owner: string }>();
      if (other && other.owner !== p.owner) throw apiError("conflict", "this account joined as another owner");
    }
    // 6 and 7. Ids are never reused.
    if (await keyTaken(env.DB, sphere.id, p.key_id)) throw apiError("conflict", "another member uses this key_id");
    if (await obiTaken(env.DB, sphere.id, p.obi_id)) throw apiError("conflict", `${p.obi_id} is or was a member: Obi ids are never reused`);
    // 8. No addition another active member doesn't take.
    await requirePublishable(env.DB, sphere.id, p.obi_id, req.card);

    const joinedAt = timestamp(now);
    const owner: OwnerRow = bound ?? { sphere: sphere.id, owner: p.owner, owner_key: req.owner_key, owner_key_id: await keyIdOf(req.owner_key) };
    const member: MemberRow = { sphere: sphere.id, obi: p.obi_id, owner: p.owner, status: "active", joined_at: joinedAt, revoked_at: null, card: canonicalize(req.card), card_seq: p.card_seq };
    const key: KeyRow = { sphere: sphere.id, key_id: p.key_id, obi: p.obi_id, public_key: p.public_key, valid_from_seq: sphere.head_seq + 1, valid_until_seq: null };
    const written = await guardedWrite(env.DB, sphere.id, sphere.rev, [
      // Past max_uses, the table's check aborts the whole batch.
      env.DB.prepare("UPDATE invitations SET uses = uses + 1 WHERE id = ?1").bind(inv.id),
      env.DB.prepare("INSERT OR IGNORE INTO owners (sphere, owner, owner_key, owner_key_id) VALUES (?1, ?2, ?3, ?4)").bind(owner.sphere, owner.owner, owner.owner_key, owner.owner_key_id),
      ...(signin
        ? [
            env.DB.prepare("UPDATE owners SET account = ?3 WHERE sphere = ?1 AND owner = ?2 AND account IS NULL").bind(owner.sphere, owner.owner, signin.account),
            env.DB.prepare("UPDATE sign_ins SET used = used + 1 WHERE state = ?1").bind(signin.state),
          ]
        : []),
      env.DB.prepare("INSERT INTO members (sphere, obi, owner, status, joined_at, card, card_seq) VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6)").bind(
        member.sphere, member.obi, member.owner, member.joined_at, member.card, member.card_seq,
      ),
      env.DB.prepare("INSERT INTO member_keys (sphere, key_id, obi, public_key, valid_from_seq) VALUES (?1, ?2, ?3, ?4, ?5)").bind(key.sphere, key.key_id, key.obi, key.public_key, key.valid_from_seq),
    ]);
    if (!written) return null;
    return json(201, memberJson(member, owner, [key]));
  }, deps.retryBudgetMs);
}

const fromHex = (h: string): Uint8Array => new Uint8Array((h.match(/../g) ?? []).map((b) => parseInt(b, 16)));

// ---------------------------------------------------------------------------------------------
// GET /members, GET /members/{obi}

export async function listMembers(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  const sphere = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere, nowS(deps));
  requireScope(caller, "directory:read");
  // One batch: a consistent snapshot of members, owners and keys.
  const [members, owners, keys] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM members WHERE sphere = ?1 ORDER BY joined_at, obi").bind(sphere.id),
    env.DB.prepare("SELECT * FROM owners WHERE sphere = ?1").bind(sphere.id),
    env.DB.prepare("SELECT * FROM member_keys WHERE sphere = ?1 ORDER BY valid_from_seq, rowid").bind(sphere.id),
  ]);
  const ownerBy = new Map((owners!.results as unknown as OwnerRow[]).map((o) => [o.owner, o]));
  const keysBy = new Map<string, KeyRow[]>();
  for (const k of keys!.results as unknown as KeyRow[]) keysBy.set(k.obi, [...(keysBy.get(k.obi) ?? []), k]);
  const runners = await visibleRunners(env.DB, sphere.id, caller, nowS(deps));
  const list = (members!.results as unknown as MemberRow[]).map((m) => {
    const member = memberJson(m, ownerBy.get(m.owner)!, keysBy.get(m.obi) ?? []);
    const runner = runners.get(m.obi);
    return runner ? { ...member, runner } : member;
  });
  return json(200, { sphere: sphere.id, members: list });
}

export async function getMemberRoute(request: Request, env: Env, deps: Deps, sphereId: string, obi: string): Promise<Response> {
  const sphere = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere, nowS(deps));
  requireScope(caller, "directory:read");
  const member = await loadMemberJson(env.DB, sphere.id, obi);
  const runner = (await visibleRunners(env.DB, sphere.id, caller, nowS(deps), obi)).get(obi);
  return json(200, runner ? { ...member, runner } : member);
}

// ---------------------------------------------------------------------------------------------
// PUT /members/{obi}/card: a new card, maybe a new key (identity.md section 3, "Rotating").

export async function updateCard(request: Request, env: Env, deps: Deps, sphereId: string, obi: string): Promise<Response> {
  const sphere0 = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere0, nowS(deps));
  if (!(await getMember(env.DB, sphere0.id, obi))) throw apiError("not_found", `no member ${obi}`);
  if (requireActor(caller) !== obi) throw apiError("forbidden", `only ${obi}'s own token may change its card`);
  const body = await readJson(request);
  const errors = schemaErrors("cardUpdateRequest", body);
  if (errors.length) throw apiError("bad_request", "the body doesn't match card-update.request", errors);
  const card = (body as unknown as { card: AgentCard }).card;

  return withRetries(async () => {
    const sphere = await requireSphere(env.DB, sphere0.id);
    const member = (await getMember(env.DB, sphere.id, obi))!;
    const owner = (await getOwner(env.DB, sphere.id, member.owner))!;
    const verdict = await verifyCard(card, { now: nowS(deps), bound_owner_key: owner.owner_key });
    if (!verdict.ok) throw apiError("card_invalid", verdict.message);
    const p = cardParams(card);
    if (p.sphere !== sphere.id || p.obi_id !== obi || p.owner !== member.owner || p.owner_key !== owner.owner_key) {
      throw apiError("card_invalid", "a new card keeps the sphere, obi_id, owner and bound owner_key");
    }
    if (p.card_seq <= member.card_seq) throw apiError("conflict", `card_seq must be above ${member.card_seq}`);
    const keys = await getKeys(env.DB, sphere.id, obi);
    const current = keys.find((k) => k.valid_until_seq === null);
    const rotate = current?.key_id !== p.key_id;
    if (rotate && (await keyTaken(env.DB, sphere.id, p.key_id))) throw apiError("conflict", "this key_id is in use");
    await requirePublishable(env.DB, sphere.id, obi, card, JSON.parse(member.card) as AgentCard);
    const h = sphere.head_seq;
    const statements = [env.DB.prepare("UPDATE members SET card = ?1, card_seq = ?2 WHERE sphere = ?3 AND obi = ?4").bind(canonicalize(card), p.card_seq, sphere.id, obi)];
    let newKeys = keys;
    if (rotate) {
      statements.push(
        env.DB.prepare("UPDATE member_keys SET valid_until_seq = ?1 WHERE sphere = ?2 AND obi = ?3 AND valid_until_seq IS NULL").bind(h, sphere.id, obi),
        env.DB.prepare("INSERT INTO member_keys (sphere, key_id, obi, public_key, valid_from_seq) VALUES (?1, ?2, ?3, ?4, ?5)").bind(sphere.id, p.key_id, obi, p.public_key, h + 1),
        env.DB.prepare("UPDATE tokens SET revoked = 1 WHERE sphere = ?1 AND actor = ?2").bind(sphere.id, obi),
      );
      newKeys = [
        ...keys.map((k) => (k.valid_until_seq === null ? { ...k, valid_until_seq: h } : k)),
        { sphere: sphere.id, key_id: p.key_id, obi, public_key: p.public_key, valid_from_seq: h + 1, valid_until_seq: null },
      ];
    }
    if (!(await guardedWrite(env.DB, sphere.id, sphere.rev, statements))) return null;
    return json(200, memberJson({ ...member, card: canonicalize(card), card_seq: p.card_seq }, owner, newKeys));
  }, deps.retryBudgetMs);
}

// ---------------------------------------------------------------------------------------------
// DELETE /members/{obi}: revoke.

export async function revoke(request: Request, env: Env, deps: Deps, sphereId: string, obi: string): Promise<Response> {
  const sphere0 = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere0, nowS(deps));
  requireOwnerToken(caller);
  const member0 = await getMember(env.DB, sphere0.id, obi);
  if (!member0) throw apiError("not_found", `no member ${obi}`);
  if (!caller.scopes.has("admin") && caller.subject !== member0.owner) throw apiError("forbidden", "only the admin or the Obi's own owner may revoke it");

  return withRetries(async () => {
    const sphere = await requireSphere(env.DB, sphere0.id);
    const member = (await getMember(env.DB, sphere.id, obi))!;
    if (member.status === "revoked") return json(200, await loadMemberJson(env.DB, sphere.id, obi));
    const revokedAt = timestamp(nowS(deps));
    const written = await guardedWrite(env.DB, sphere.id, sphere.rev, [
      env.DB.prepare("UPDATE member_keys SET valid_until_seq = ?1 WHERE sphere = ?2 AND obi = ?3 AND valid_until_seq IS NULL").bind(sphere.head_seq, sphere.id, obi),
      env.DB.prepare("UPDATE members SET status = 'revoked', revoked_at = ?1 WHERE sphere = ?2 AND obi = ?3").bind(revokedAt, sphere.id, obi),
      env.DB.prepare("UPDATE deliveries SET state = 'dropped' WHERE sphere = ?1 AND to_obi = ?2 AND state = 'queued'").bind(sphere.id, obi),
      env.DB.prepare("UPDATE tokens SET revoked = 1 WHERE sphere = ?1 AND actor = ?2").bind(sphere.id, obi),
      env.DB.prepare("DELETE FROM runner_status WHERE sphere = ?1 AND obi = ?2").bind(sphere.id, obi),
      // Its phone relays and their phones' hashes (sphere-api.md section 9.2): each relay's alarm closes its sockets.
      env.DB.prepare("DELETE FROM relay_devices WHERE relay IN (SELECT id FROM relays WHERE sphere = ?1 AND obi = ?2)").bind(sphere.id, obi),
      env.DB.prepare("DELETE FROM relays WHERE sphere = ?1 AND obi = ?2").bind(sphere.id, obi),
    ]);
    if (!written) return null;
    return json(200, await loadMemberJson(env.DB, sphere.id, obi));
  }, deps.retryBudgetMs);
}
