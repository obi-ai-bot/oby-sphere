// Policy: who may ask whose Obi for what (spec/sphere-api.md section 5).

import { bearer, requireOwnerToken, requireScope } from "../auth.ts";
import { guardedWrite, requireBound, requireSphere, withRetries, type PolicyRule, type SphereRow } from "../db.ts";
import type { Deps, Env } from "../env.ts";
import { apiError, json, readJson } from "../http.ts";
import { notTakenProblem, policyFeatures, type AgentCard } from "../protocol/card.ts";
import { timestamp } from "../protocol/envelope.ts";
import { schemaErrors } from "../protocol/schemas.ts";

const nowS = (deps: Deps) => Math.floor(deps.now() / 1000);

export const policyJson = (s: SphereRow) => ({ version: s.policy_version, updated_at: s.policy_updated_at, rules: JSON.parse(s.policy_rules) as PolicyRule[] });

/**
 * Whether a rule allows a request of `type` from an Obi of `fromOwner` to an Obi of `toOwner`
 * about `repo` (undefined when the body has none). Repository comparisons ignore ASCII case.
 * `fromClasses`/`toClasses` are the conformance classes the sending and receiving members' current
 * cards claim; a rule with `from_classes`/`to_classes` matches only when the member claims every one
 * (spec/sphere-api.md section 5, the policy_classes feature). A member whose card has no `classes`
 * claims none, so a rule that requires a class never matches it.
 */
export function policyAllows(
  rules: PolicyRule[],
  fromOwner: string,
  toOwner: string,
  type: string,
  repo: string | undefined,
  fromClasses: string[] = [],
  toClasses: string[] = [],
): PolicyRule | null {
  const lower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const repoOk = (pattern: string) => {
    if (pattern === "*") return true;
    if (repo === undefined) return false;
    const r = lower(repo);
    const p = lower(pattern);
    if (p.endsWith("/*")) return r.split("/")[0] === p.slice(0, -2);
    return r === p;
  };
  const claims = (required: string[] | undefined, held: string[]) => !required || required.every((c) => held.includes(c));
  return (
    rules.find(
      (rule) =>
        (rule.from_owner === "*" || rule.from_owner === fromOwner) &&
        (rule.to_owner === "*" || rule.to_owner === toOwner) &&
        rule.actions.includes(type) &&
        rule.repos.some(repoOk) &&
        claims(rule.from_classes, fromClasses) &&
        claims(rule.to_classes, toClasses),
    ) ?? null
  );
}

export async function getPolicy(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  const sphere = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere, nowS(deps));
  requireScope(caller, "directory:read", "admin");
  return json(200, policyJson(sphere));
}

export async function putPolicy(request: Request, env: Env, deps: Deps, sphereId: string): Promise<Response> {
  const sphere0 = await requireSphere(env.DB, sphereId);
  const caller = await bearer(request, env, sphere0, nowS(deps));
  requireScope(caller, "admin");
  requireOwnerToken(caller);
  const body = await readJson(request);
  const errors = schemaErrors("policyPutRequest", body);
  if (errors.length) throw apiError("bad_request", "the body doesn't match policy-put.request", errors);
  const req = body as unknown as { expected_version: number; rules: PolicyRule[] };
  const ids = new Set<string>();
  for (const r of req.rules) {
    if (ids.has(r.id)) throw apiError("bad_request", `the rule id ${r.id} appears twice`);
    ids.add(r.id);
  }
  await requireBound(env.DB, sphere0.id, req.rules.flatMap((r) => [r.from_owner, r.to_owner]), "the policy");
  return withRetries(async () => {
    const sphere = await requireSphere(env.DB, sphere0.id);
    if (req.expected_version !== sphere.policy_version) throw apiError("conflict", `the policy is at version ${sphere.policy_version}`);
    // Members read the policy against its schema: a rule that uses an addition waits until every
    // active member takes it, unless the current policy uses it already (sphere-api.md section 5).
    const carried = new Set(policyFeatures(JSON.parse(sphere.policy_rules) as PolicyRule[]));
    const uses = policyFeatures(req.rules).filter((f) => !carried.has(f));
    if (uses.length > 0) {
      const active = await env.DB.prepare("SELECT obi, card FROM members WHERE sphere = ?1 AND status = 'active'").bind(sphere.id).all<{ obi: string; card: string }>();
      const problem = notTakenProblem(uses, active.results.map((m) => ({ obi: m.obi, card: JSON.parse(m.card) as AgentCard })));
      if (problem) throw apiError("feature_not_taken", problem);
    }
    const version = sphere.policy_version + 1;
    const updatedAt = timestamp(nowS(deps));
    const rules = req.rules.map((r) => ({
      id: r.id, from_owner: r.from_owner, to_owner: r.to_owner, actions: r.actions, repos: r.repos,
      ...(r.from_classes ? { from_classes: r.from_classes } : {}),
      ...(r.to_classes ? { to_classes: r.to_classes } : {}),
    }));
    const written = await guardedWrite(env.DB, sphere.id, sphere.rev, [
      env.DB.prepare("UPDATE spheres SET policy_version = ?1, policy_rules = ?2, policy_updated_at = ?3 WHERE id = ?4").bind(version, JSON.stringify(rules), updatedAt, sphere.id),
    ]);
    if (!written) return null;
    return json(200, { version, updated_at: updatedAt, rules });
  }, deps.retryBudgetMs);
}
