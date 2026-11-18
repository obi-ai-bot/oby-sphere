// Health, Spheres and the operator (spec/sphere-api.md sections 1 to 3).

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { CLIENTS } from "../src/clients";
import { FEATURES } from "../src/protocol/features";
import { joinPageFor } from "../src/routes/spheres";
import { sha256Hex } from "../src/protocol/crypto";
import { utf8 } from "../src/protocol/json";
import { BASE, Clock, OPERATOR, World, expectSchema, makeCall, newKey } from "./helpers";

describe("health", () => {
  it("answers without authentication", async () => {
    const call = makeCall(new Clock());
    const r = await call("GET", "/v0.1/health");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, protocol: "obi/0.1", seal: true });
    expectSchema("healthResponse", r.body);
    expect(r.headers.get("Content-Type")).toBe("application/json");
  });

  it("lists the additions it takes and the extensions it offers at /v0.1/features, never in health (spec/README.md, Versions)", async () => {
    const r = await makeCall(new Clock())("GET", "/v0.1/features");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ features: [...FEATURES, "a2a", "dpop", "phone_relay", "signin_providers", "sphere_url_aud"].sort() });
    expectSchema("featuresResponse", r.body);
  });

  it("tells someone who opens an invite link in a browser how to join with any client", async () => {
    const r = await handle(new Request(`${BASE}/join`), env, { now: () => 0 });
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("text/html");
    const csp = r.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'none'");
    const page = await r.text();
    expect(page).toContain("Give the link to your agent's client");
    // The format, for a client's author.
    expect(page).toContain(`<a href="https://github.com/obi-ai-bot/oby-sphere/blob/main/spec/sphere-api.md#21-invite-links">sphere-api.md, section 2.1</a>`);
    expect(csp).toContain("frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    expect(page).toContain(`<a href="https://github.com/obi-ai-bot/oby-sphere#who-can-join-today">Who can join today</a>`);
    // Nothing on it is about one client: the Clients list names the clients that publish a report
    // (a factual list, tested below), and the rest of the page names no product, the standards' own
    // repository aside.
    expect(page.replace(/<ul>[\s\S]*?<\/ul>/, "").replaceAll("obi-ai-bot/oby-sphere", "")).not.toMatch(/\boby\b|Mac|Settings ›/i);
    // Its one script, the only one the CSP allows, reads the page's own address and sends nothing.
    const script = /<script>(.*)<\/script>/s.exec(page)![1]!;
    expect(script).not.toMatch(/fetch|XMLHttpRequest|sendBeacon|WebSocket|src=/);
    const hash = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(script)))));
    expect(csp).toContain(`script-src 'sha256-${hash}'`);
  });

  it("lists the clients that publish a conformance report, each with its own Open link", async () => {
    const page = await (await joinPageFor([
      { name: "Example Agent", page: "https://agent.example/", report: "https://agent.example/conformance", scheme: "example-agent" },
      { name: "Plain <Client>", page: "https://plain.example/", report: "https://plain.example/report" },
    ])).text();
    expect(page).toContain(`<li><a href="https://agent.example/">Example Agent</a> · <a class="open" data-scheme="example-agent">Open in Example Agent</a> · <a href="https://agent.example/conformance">Conformance report</a></li>`);
    // A client with no scheme of its own gets no Open link; what the list says is escaped.
    expect(page).toContain(`<li><a href="https://plain.example/">Plain &#60;Client&#62;</a> · <a href="https://plain.example/report">Conformance report</a></li>`);
    // The script builds each Open link as <scheme>://join/<host>#<fragment>, only on https (sphere-api.md section 2.1).
    expect(page).toContain(`if(location.protocol==="https:")for(const a of document.querySelectorAll("a[data-scheme]"))a.href=a.dataset.scheme+"://join/"+location.host+location.hash`);
  });

  it("lists only clients with a report, an https page and a scheme of the right form", () => {
    for (const c of CLIENTS) {
      expect(c.page, c.name).toMatch(/^https:\/\//);
      expect(c.report, c.name).toMatch(/^https:\/\//);
      if (c.scheme !== undefined) {
        expect(c.scheme, c.name).toMatch(/^[a-z][a-z0-9+.-]*$/);
        expect(["http", "https", "javascript", "data", "file", "blob", "about", "vbscript"], c.name).not.toContain(c.scheme);
      }
    }
  });

  it("answers 404 not_found for anything not in the API", async () => {
    const call = makeCall(new Clock());
    for (const [method, path] of [["GET", "/"], ["GET", "/v0.1/nothing"], ["DELETE", "/v0.1/health"], ["GET", "/v0.1/spheres"], ["POST", "/v0.1/spheres/e2e/audit"]] as const) {
      const r = await call(method, path);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.body.error.code).toBe("not_found");
    }
  });
});

describe("POST /v0.1/spheres", () => {
  it("creates a Sphere: admin bound, policy version 0 with no rules, empty chain", async () => {
    const w = new World();
    const r = await w.create();
    expect(r.status).toBe(201);
    expectSchema("sphere", r.body);
    expect(r.body).toEqual({ sphere: "e2e", name: "E2E sphere", protocol: "obi/0.1", admin_owner: "wellington", admins: ["wellington"], created_at: "2026-10-14T12:00:00Z" });

    const token = await w.ownerToken();
    const policy = await w.call("GET", "/v0.1/spheres/e2e/policy", { token });
    expect(policy.body).toEqual({ version: 0, updated_at: "2026-10-14T12:00:00Z", rules: [] });
    const audit = await w.call("GET", "/v0.1/spheres/e2e/audit", { token });
    expect(audit.body).toEqual({ sphere: "e2e", entries: [], head: { seq: 0, hash: "0".repeat(64) } });
    const got = await w.call("GET", "/v0.1/spheres/e2e", { token });
    expect(got.status).toBe(200);
    expect(got.body).toEqual(r.body);
  });

  it("is 409 conflict when the id is taken", async () => {
    const w = new World();
    expect((await w.create()).status).toBe(201);
    const again = await w.create();
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("conflict");
  });

  it("needs the operator token: 401 when it is missing or wrong", async () => {
    const w = new World();
    const key = await newKey();
    const body = { sphere: "e2e", name: "E2E sphere", admin: { owner: "wellington", owner_key: key.publicKey } };
    for (const token of [undefined, "wrong-token-wrong-token-wrong-token-wrong", OPERATOR + "x"]) {
      const r = await w.call("POST", "/v0.1/spheres", { token, body });
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe("unauthorized");
    }
  });

  it("refuses every operator call (403 forbidden) when no operator token is configured", async () => {
    const key = await newKey();
    const body = JSON.stringify({ sphere: "e2e", name: "E2E sphere", admin: { owner: "wellington", owner_key: key.publicKey } });
    for (const configured of [undefined, "short"]) {
      const res = await handle(
        new Request(`${BASE}/v0.1/spheres`, { method: "POST", headers: { Authorization: `Bearer ${configured ?? "x"}` }, body }),
        { DB: env.DB, CHANNELS: env.CHANNELS, DOORBELLS: env.DOORBELLS, RELAYS: env.RELAYS, SPHERE_OPERATOR_TOKEN: configured },
        { now: () => Date.now() },
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    }
  });

  it("takes the token whose SHA-256 a self-hosted Sphere kept from its claim, and only that token", async () => {
    const key = await newKey();
    const body = JSON.stringify({ sphere: "claimed", name: "Claimed sphere", admin: { owner: "wellington", owner_key: key.publicKey } });
    const kept = { DB: env.DB, CHANNELS: env.CHANNELS, DOORBELLS: env.DOORBELLS, RELAYS: env.RELAYS, SPHERE_OPERATOR_TOKEN_SHA256: await sha256Hex(utf8(OPERATOR)) };
    const create = (token: string) =>
      handle(new Request(`${BASE}/v0.1/spheres`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body }), kept, { now: () => Date.now() });
    expect((await create(OPERATOR + "x")).status).toBe(401);
    expect((await create(OPERATOR)).status).toBe(201);
  });

  it("is 400 bad_request for a body that doesn't match the schema", async () => {
    const w = new World();
    const key = await newKey();
    const good = { sphere: "e2e", name: "E2E sphere", admin: { owner: "wellington", owner_key: key.publicKey } };
    for (const body of [
      {},
      { ...good, extra: 1 },
      { ...good, sphere: "E2E" },
      { ...good, name: "two\nlines" },
      { ...good, admin: { owner: "wellington" } },
      { ...good, admin: { ...good.admin, owner_key: "short" } },
    ]) {
      const r = await w.call("POST", "/v0.1/spheres", { token: OPERATOR, body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.code).toBe("bad_request");
    }
    const dup = await w.call("POST", "/v0.1/spheres", { token: OPERATOR, raw: `{"sphere":"e2e","sphere":"x","name":"n","admin":{"owner":"a","owner_key":"${key.publicKey}"}}` });
    expect(dup.status).toBe(400);
    const notJson = await w.call("POST", "/v0.1/spheres", { token: OPERATOR, raw: "{" });
    expect(notJson.status).toBe(400);
  });

  it("is 409 conflict for a reserved id, even for the operator, and answers GET for one 401, taken", async () => {
    const w = new World();
    const key = await newKey();
    for (const sphere of ["avenga", "tetrix", "oby", "app", "www", "admin", "api", "help", "acme"]) {
      const r = await w.call("POST", "/v0.1/spheres", { token: OPERATOR, body: { sphere, name: "Taken", admin: { owner: "wellington", owner_key: key.publicKey } } });
      expect(r.status, sphere).toBe(409);
      expect(r.body.error.code).toBe("conflict");
      const got = await w.call("GET", `/v0.1/spheres/${sphere}`);
      expect(got.status, sphere).toBe(401);
      expect(got.body.error.code).toBe("unauthorized");
    }
    await w.create();
    expect((await w.call("GET", "/v0.1/spheres/oby", { token: await w.ownerToken() })).status).toBe(401);
    expect((await w.call("GET", "/v0.1/spheres/oby-two")).status).toBe(404);
  });

  it("is 413 payload_too_large past 131,072 bytes", async () => {
    const w = new World();
    const r = await w.call("POST", "/v0.1/spheres", { token: OPERATOR, raw: `{"sphere":"${"a".repeat(131072)}"}` });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe("payload_too_large");
  });

  it("answers GET /spheres/{sphere} 404 for a Sphere that doesn't exist, 401 for a token of another Sphere", async () => {
    const w = new World();
    await w.create();
    const token = await w.ownerToken();
    const missing = await w.call("GET", "/v0.1/spheres/nope", { token });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("not_found");

    const other = new World("other");
    other.clock.ms = w.clock.ms;
    await other.create("ernesto");
    const r = await w.call("GET", "/v0.1/spheres/other", { token });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("unauthorized");
    expect((await w.call("GET", "/v0.1/spheres/e2e")).status).toBe(401);
    expect((await w.call("GET", "/v0.1/spheres/e2e", { token: "not-a-token-not-a-token-not-a-token" })).status).toBe(401);
  });
});
