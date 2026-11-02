// Policy: who may ask whose Obi for what (spec/sphere-api.md section 5).

import { describe, expect, it } from "vitest";
import { policyAllows } from "../src/routes/policy";
import { policyFeatures } from "../src/protocol/card";
import type { PolicyRule } from "../src/db";
import { BRIEF, TEAM_REVIEWS, World, expectSchema, makeCard, team } from "./helpers";

describe("GET and PUT /policy", () => {
  it("replaces the policy whole, version by version, rules in the order given", async () => {
    const w = new World();
    await w.create();
    expect((await w.join("ernesto", "obi-ernesto")).status).toBe(201);
    w.clock.advance(6);
    const rules = [TEAM_REVIEWS, { id: "questions", from_owner: "ernesto", to_owner: "*", actions: ["question"], repos: ["*"] }];
    const r = await w.putPolicy(rules);
    expect(r.status).toBe(200);
    expectSchema("policy", r.body);
    expect(r.body).toEqual({ version: 1, updated_at: "2026-10-14T12:00:06Z", rules });
    const got = await w.call("GET", "/v0.1/spheres/e2e/policy", { token: await w.ownerToken() });
    expect(got.body).toEqual(r.body);
    const stale = await w.putPolicy([], 0);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("conflict");
    expect((await w.putPolicy([], 1)).body.version).toBe(2);
  });

  it("refuses rule ids that repeat, and bodies outside the schema (400 bad_request)", async () => {
    const w = new World();
    await w.create();
    for (const rules of [[TEAM_REVIEWS, TEAM_REVIEWS], [{ ...TEAM_REVIEWS, actions: ["result"] }], [{ ...TEAM_REVIEWS, repos: ["a/b/c"] }], [{ ...TEAM_REVIEWS, note: "x" }]]) {
      const r = await w.putPolicy(rules);
      expect(r.status, JSON.stringify(rules)).toBe(400);
      expect(r.body.error.code).toBe("bad_request");
    }
  });

  it("names only owners who have joined, or * (409 conflict): an open link can't inherit a rule", async () => {
    const w = await team();
    for (const rule of [{ ...TEAM_REVIEWS, from_owner: "bob" }, { ...TEAM_REVIEWS, to_owner: "bob" }]) {
      const r = await w.putPolicy([rule], 1);
      expect(r.status, JSON.stringify(rule)).toBe(409);
      expect(r.body.error.code).toBe("conflict");
      expect(r.body.error.message).toContain("bob");
    }
    // Ernesto has joined; his Obi revoked, his owner id stays bound.
    await w.call("DELETE", "/v0.1/spheres/e2e/members/obi-ernesto", { token: await w.ownerToken() });
    expect((await w.putPolicy([{ ...TEAM_REVIEWS, from_owner: "ernesto", to_owner: "wellington" }], 1)).status).toBe(200);
  });

  it("is written by the admin only, and read with directory:read or admin", async () => {
    const w = await team();
    const ernesto = await w.ownerToken("ernesto", "directory:read");
    const put = await w.call("PUT", "/v0.1/spheres/e2e/policy", { token: ernesto, body: { expected_version: 1, rules: [] } });
    expect(put.body.error.code).toBe("insufficient_scope");
    expect((await w.call("GET", "/v0.1/spheres/e2e/policy", { token: ernesto })).status).toBe(200);
    expect((await w.call("GET", "/v0.1/spheres/e2e/policy", { token: await w.ownerToken("wellington", "admin") })).status).toBe(200);
    expect((await w.call("GET", "/v0.1/spheres/e2e/policy", { token: await w.ownerToken("wellington", "audit:read") })).body.error.code).toBe("insufficient_scope");
  });
});

describe("matching", () => {
  const rule = (o: Partial<PolicyRule>): PolicyRule => ({ id: "r", from_owner: "*", to_owner: "*", actions: ["review_request"], repos: ["*"], ...o });

  it("matches owners, the action, and the repository ignoring ASCII case", () => {
    expect(policyAllows([rule({})], "a", "b", "review_request", "x/y")).not.toBeNull();
    expect(policyAllows([rule({ actions: ["question"] })], "a", "b", "review_request", "x/y")).toBeNull();
    expect(policyAllows([rule({ from_owner: "a" })], "a", "b", "review_request", "x/y")).not.toBeNull();
    expect(policyAllows([rule({ from_owner: "c" })], "a", "b", "review_request", "x/y")).toBeNull();
    expect(policyAllows([rule({ to_owner: "b" })], "a", "b", "review_request", "x/y")).not.toBeNull();
    expect(policyAllows([rule({ to_owner: "c" })], "a", "b", "review_request", "x/y")).toBeNull();
    expect(policyAllows([rule({ repos: ["Obi-E2E/Fixture-App"] })], "a", "b", "review_request", "obi-e2e/fixture-app")).not.toBeNull();
    expect(policyAllows([rule({ repos: ["OBI-E2E/*"] })], "a", "b", "review_request", "obi-e2e/other")).not.toBeNull();
    expect(policyAllows([rule({ repos: ["obi-e2e/*"] })], "a", "b", "review_request", "obi-e2ex/other")).toBeNull();
    expect(policyAllows([rule({ repos: ["obi-e2e/fixture-app"] })], "a", "b", "review_request", "obi-e2e/fixture-app2")).toBeNull();
  });

  it("matches a request without a repo only with `*`", () => {
    expect(policyAllows([rule({ actions: ["question"], repos: ["x/*", "x/y"] })], "a", "b", "question", undefined)).toBeNull();
    expect(policyAllows([rule({ actions: ["question"], repos: ["*"] })], "a", "b", "question", undefined)).not.toBeNull();
  });

  it("allows nothing with no rules", () => {
    expect(policyAllows([], "a", "b", "review_request", "x/y")).toBeNull();
  });
});

describe("policy at send", () => {
  it("refuses a request no rule allows (403 policy_denied), and applies a new policy to the next send", async () => {
    const w = await team();
    const token = await w.obiToken("obi-ernesto");
    const other = await w.send(await w.envelope("obi-ernesto", "obi-wellington", "review_request", { ...BRIEF, repo: "obi-e2e/other-app" }), token);
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe("policy_denied");
    expect((await w.putPolicy([{ ...TEAM_REVIEWS, repos: ["obi-e2e/*"] }], 1)).status).toBe(200);
    const now = await w.send(await w.envelope("obi-ernesto", "obi-wellington", "review_request", { ...BRIEF, repo: "obi-e2e/other-app" }), token);
    expect(now.status).toBe(202);
  });

  it("takes a question's repository from its about: one repository, or none", async () => {
    const w = await team();
    await w.putPolicy([{ id: "q", from_owner: "*", to_owner: "*", actions: ["question"], repos: ["obi-e2e/*"] }], 1);
    expect((await w.join("ernesto", "obi-ernesto-q", ["question"])).status).toBe(201);
    const token = await w.obiToken("obi-wellington");
    const ask = async (about?: unknown[]) => (await w.send(await w.envelope("obi-wellington", "obi-ernesto-q", "question", { text: "Is it ready?", ...(about ? { about } : {}) }), token)).status;
    const pr = { kind: "pr", repo: "obi-e2e/fixture-app", pr: 1 };
    expect(await ask([pr, { kind: "issue", repo: "OBI-E2E/Fixture-App", issue: 2 }])).toBe(202);
    expect(await ask([pr, { kind: "repo", repo: "other/app" }])).toBe(403);
    expect(await ask()).toBe(403);
  });

  it("refuses a request type the receiver's card doesn't accept (403 policy_denied)", async () => {
    const w = await team();
    await w.putPolicy([{ id: "all", from_owner: "*", to_owner: "*", actions: ["review_request", "question", "handoff"], repos: ["*"] }], 1);
    const token = await w.obiToken("obi-ernesto");
    const r = await w.send(await w.envelope("obi-ernesto", "obi-wellington", "question", { text: "Which?" }), token);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("policy_denied");
  });
});

describe("a rule may require a conformance class (the policy_classes feature, sphere-api.md section 5)", () => {
  const base: PolicyRule = { id: "r", from_owner: "*", to_owner: "*", actions: ["run_request"], repos: ["*"] };

  it("matches only when the member claims every class the rule names (from and to sides)", () => {
    const ok = (rule: PolicyRule, from: string[], to: string[]) => policyAllows([rule], "a", "b", "run_request", "x/y", from, to);
    // No class requirement: unchanged behaviour.
    expect(ok(base, [], [])).not.toBeNull();
    // to_classes: only a member that claims every listed class matches; none claimed denies.
    expect(ok({ ...base, to_classes: ["executor"] }, [], ["executor"])).not.toBeNull();
    expect(ok({ ...base, to_classes: ["executor"] }, [], [])).toBeNull();
    expect(ok({ ...base, to_classes: ["executor"] }, [], ["participant"])).toBeNull();
    expect(ok({ ...base, to_classes: ["executor", "holder"] }, [], ["executor"])).toBeNull();
    expect(ok({ ...base, to_classes: ["executor", "holder"] }, [], ["holder", "executor"])).not.toBeNull();
    // from_classes constrains the sender the same way.
    expect(ok({ ...base, from_classes: ["holder"] }, ["holder"], [])).not.toBeNull();
    expect(ok({ ...base, from_classes: ["holder"] }, [], [])).toBeNull();
    // Both sides at once.
    const bothSides: PolicyRule = { ...base, from_classes: ["holder"], to_classes: ["executor"] };
    expect(ok(bothSides, ["holder"], ["executor"])).not.toBeNull();
    expect(ok(bothSides, ["holder"], [])).toBeNull();
    expect(ok(bothSides, [], ["executor"])).toBeNull();
  });

  it("policyFeatures maps a rule with class fields to policy_classes, so putPolicy's gate covers it", () => {
    expect(policyFeatures([{ actions: ["review_request"] }])).toEqual([]);
    expect(policyFeatures([{ actions: ["review_request"], to_classes: ["executor"] }])).toEqual(["policy_classes"]);
    expect(policyFeatures([{ actions: ["review_request"], from_classes: ["holder"] }])).toEqual(["policy_classes"]);
    expect(policyFeatures([{ actions: ["introduction"] }, { actions: ["review_request"], to_classes: ["executor"] }]).sort()).toEqual(["introduction", "policy_classes"]);
  });

  it("holds a class rule until every active member's card lists policy_classes (feature_not_taken); then it goes in", async () => {
    const w = await team();
    const adopt = async (obi: string, owner: string, cardSeq: number, params?: Record<string, unknown>, version?: string) => {
      const card = await makeCard({ sphere: "e2e", obi, owner, ownerKey: await w.ownerKey(owner), obiKey: w.obis.get(obi)!.key, cardSeq, issuedAt: w.clock.ts(), ...(version ? { version } : {}), ...(params ? { params } : {}) });
      return w.call("PUT", `/v0.1/spheres/e2e/members/${obi}/card`, { token: await w.obiToken(obi), body: { card } });
    };
    const classRule = { id: "exec", from_owner: "*", to_owner: "*", actions: ["review_request"], repos: ["*"], to_classes: ["executor"] };
    // Neither member's card lists policy_classes, so a member from before couldn't read the rule.
    const refused = await w.putPolicy([classRule], 1);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("feature_not_taken");
    expect(refused.body.error.message).toContain("policy_classes");
    // Both take card_runtime, then list policy_classes and card_classes; obi-wellington claims executor.
    expect((await adopt("obi-ernesto", "ernesto", 2, undefined, "0.3.0+card-runtime")).status).toBe(200);
    expect((await adopt("obi-wellington", "wellington", 2, undefined, "0.3.0+card-runtime")).status).toBe(200);
    expect((await adopt("obi-ernesto", "ernesto", 3, { features: ["card_classes", "card_runtime", "policy_classes"] })).status).toBe(200);
    expect((await adopt("obi-wellington", "wellington", 3, { features: ["card_classes", "card_runtime", "policy_classes"], classes: ["executor"] })).status).toBe(200);
    // Now the rule is taken and round-trips.
    const put = await w.putPolicy([classRule], 1);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expectSchema("policy", put.body);
    expect(put.body.rules[0]).toEqual(classRule);
    // It matches obi-wellington (claims executor) but not obi-ernesto (claims none).
    expect((await w.send(await w.envelope("obi-ernesto", "obi-wellington", "review_request", BRIEF), await w.obiToken("obi-ernesto"))).status).toBe(202);
    const denied = await w.send(await w.envelope("obi-wellington", "obi-ernesto", "review_request", BRIEF), await w.obiToken("obi-wellington"));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("policy_denied");
  });

  it("rejects a class id outside the schema pattern (400 bad_request)", async () => {
    const w = await team();
    for (const bad of [["Executor"], [""], ["a b"], Array.from({ length: 17 }, (_, i) => `c${i}`)]) {
      const r = await w.putPolicy([{ ...base, id: "r", to_classes: bad }], 1);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.error.code).toBe("bad_request");
    }
  });
});
