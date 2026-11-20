import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The tests run inside workerd (Miniflare) with a real, empty D1 that test/setup.ts migrates.
// They call the Worker's `handle` (src/app.ts) with a clock they move themselves.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(fileURLToPath(new URL("migrations", import.meta.url)));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, SPHERE_OPERATOR_TOKEN: "test-operator-token-0123456789-abcdefghijkl", GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com", CREATOR_WORKSPACES: "example.com, Other.example", PUBLIC_ORIGIN: "http://public.test" } },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"], include: ["test/**/*.test.ts"] },
  };
});
