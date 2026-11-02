import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

// Every test file starts from a migrated database, and every test from an empty one.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

beforeEach(async () => {
  await env.DB.batch(
    ["relay_devices", "relays", "sign_ins", "deliveries", "audit", "used_jtis", "tokens", "invitations", "member_keys", "members", "owners", "write_guard", "spheres", "deleted_spheres"].map((table) =>
      env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
});
