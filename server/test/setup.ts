import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

// Every test file starts from a migrated database, and every test from an empty one, with an
// empty bucket for artifacts' blobs.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

beforeEach(async () => {
  await env.DB.batch(
    ["relay_devices", "relays", "sign_ins", "deliveries", "audit", "used_jtis", "tokens", "invitations", "member_keys", "members", "owners", "owner_events", "operator_log", "write_guard", "spheres", "deleted_spheres", "blob_recipients", "artifact_blobs", "blobs", "public_links", "public_hits"].map((table) =>
      env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
  const held = await env.ARTIFACTS?.list();
  if (held?.objects.length) await env.ARTIFACTS!.delete(held.objects.map((o) => o.key));
});
