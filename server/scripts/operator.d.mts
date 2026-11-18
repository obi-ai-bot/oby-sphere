// Types for scripts/operator.mjs, which the tests import.
export interface OperatorIo {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  token: (host: string) => Promise<string | null>;
}
export function parse(argv: string[]): { pos: string[]; flags: Record<string, string | true> } | null;
export function inviteLinks(base: string, answer: Record<string, unknown>): { https: string; oby: string };
export function main(argv: string[], io: OperatorIo): Promise<number>;
