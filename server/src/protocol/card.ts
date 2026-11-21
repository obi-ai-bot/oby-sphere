// The client library's card module (client/src/card.ts), as copied into lib/ by
// scripts/sync-client.mjs, with this server's own list of the additions it takes.

import { notTakenProblem as notTakenFor, type AgentCard } from "./lib/card.ts";
import { takenFeatures } from "./features.ts";

export * from "./lib/card.ts";

/** Why a message or a policy that uses `features` can't go in yet (sphere-api.md sections 5 and 6.1, check 11), against what this server takes (`env`: takenFeatures). */
export const notTakenProblem = (features: string[], active: { obi: string; card: AgentCard }[], env: { ARTIFACTS?: unknown }): string | null => notTakenFor(features, active, takenFeatures(env));
