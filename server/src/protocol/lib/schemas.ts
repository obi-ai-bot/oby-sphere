// The server's own, not copied: the compiled validators (../schemas.ts, validators.generated.js)
// under the schema names the client library's modules use (`envelope`, `agent-card`…), so the
// copies in this folder validate with the validators the Worker already has.

import { matches as serverMatches, schemaErrors as serverErrors, type SchemaName as ServerName } from "../schemas.ts";

const NAMES = {
  envelope: "envelope",
  "sealed/envelope": "sealedEnvelope",
  "agent-card": "agentCard",
  "audit-entry": "auditEntry",
  "wire/jws-header": "jwsHeader",
} as const satisfies Record<string, ServerName>;

export type SchemaName = keyof typeof NAMES;

export const schemaErrors = (name: SchemaName, value: unknown, max = 5): string[] => serverErrors(NAMES[name], value, max);

export const matches = (name: SchemaName, value: unknown): boolean => serverMatches(NAMES[name], value);
