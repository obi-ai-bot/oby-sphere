// The API client: errors as the API answers them, and answers that break their schema refused.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SphereApi, SphereError } from "../src/index.ts";

const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => async () =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

test("an API error keeps its status, code and Retry-After", async () => {
  const api = new SphereApi("http://127.0.0.1:1", { fetch: answer(429, { error: { code: "rate_limited", message: "slow down" } }, { "Retry-After": "3" }) });
  const e = await api.health().catch((x) => x);
  assert.ok(e instanceof SphereError);
  assert.equal(e.status, 429);
  assert.equal(e.code, "rate_limited");
  assert.equal(e.retryAfter, 3);
});

test("an OAuth error from the token endpoint", async () => {
  const api = new SphereApi("http://127.0.0.1:1", { fetch: answer(400, { error: "invalid_grant", error_description: "jti used" }) });
  const e = await api.token({ subject: "x" }).catch((x) => x);
  assert.equal(e.code, "invalid_grant");
});

test("an answer that breaks its schema is refused, never returned", async () => {
  const api = new SphereApi("http://127.0.0.1:1", { fetch: answer(200, { deliveries: [{ delivery_id: "d", seq: 1, relayed_at: "now", envelope: {}, extra: "instructions" }] }) });
  const e = await api.deliveries("t".repeat(32), "acme").catch((x) => x);
  assert.equal(e.code, "bad_response");
});

test("a Sphere's address is an origin: https, or http on this machine", () => {
  assert.throws(() => new SphereApi("http://sphere.example.com"));
  assert.throws(() => new SphereApi("https://sphere.example.com/prefix"));
  assert.equal(new SphereApi("https://sphere.example.com/").base, "https://sphere.example.com");
});

test("an unreachable server is a SphereError too", async () => {
  const api = new SphereApi("http://127.0.0.1:1", { fetch: async () => { throw new TypeError("fetch failed"); } });
  const e = await api.health().catch((x) => x);
  assert.equal(e.code, "unreachable");
});
