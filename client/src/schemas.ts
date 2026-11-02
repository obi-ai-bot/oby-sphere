// The spec's JSON Schemas (spec/schemas/v0.1), compiled ahead of time into generated/spec.js by
// scripts/gen.mjs, by the name of each schema's file: `envelope`, `sealed/envelope`,
// `agent-card`, `audit-entry`, `actions/question`, `wire/members.response`…

import { textPaths as generatedTextPaths, validators } from "./generated/spec.js";

export type SchemaName = keyof typeof validators;

export const isSchemaName = (name: unknown): name is SchemaName => typeof name === "string" && Object.hasOwn(validators, name);

/** The schema's complaints about `value`, at most `max` of them; empty when it matches. */
export function schemaErrors(name: SchemaName, value: unknown, max = 5): string[] {
  const validate = validators[name];
  if (validate(value)) return [];
  return (validate.errors ?? []).slice(0, max).map((e) => {
    const extra = typeof e.params?.additionalProperty === "string" ? ` (${e.params.additionalProperty})` : "";
    return `${e.instancePath || "/"} ${e.message ?? "is invalid"}${extra}`;
  });
}

export const matches = (name: SchemaName, value: unknown): boolean => validators[name](value);

/** Where each action's words are (`x-obi-text: data`), as JSON Pointers into its body, `*` for every item of an array. */
export const textPaths: Readonly<Record<string, readonly string[]>> = generatedTextPaths;
