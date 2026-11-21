/// <reference types="@cloudflare/vitest-plugin/types" />
import type { D1Migration } from "cloudflare:test";
import type { Env as WorkerEnv } from "../src/env";

// What `env` from cloudflare:test holds in the tests: the Worker's bindings and the migrations.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
      SPHERE_OPERATOR_TOKEN: string;
      GOOGLE_CLIENT_ID: string;
      PUBLIC_ORIGIN: string;
    }
  }
}

export {};
