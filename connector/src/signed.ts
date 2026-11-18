// What the owner signs on their own machine with their own key: a decision on one item of the
// mailbox, and the rules for what the host's agent may send without asking. The running connector
// applies one only when it verifies with the owner key the Sphere bound for this member's owner,
// so nothing the host's agent writes into the folder counts.
//
// Signing input: UTF-8 of "obysphere-connector <kind>\n" followed by the canonical JSON (RFC 8785)
// of the statement without `signature`; Ed25519, base64url. The prefix keeps these signatures from
// being valid as any protocol signature the owner key makes (a card, an assertion).

import { canonicalBytes, utf8, verifyEd25519, type JsonObject, type SigningKey } from "@obysphere/client";

export interface Decision {
  kind: "decision";
  sphere: string;
  obi: string;
  /** The mailbox item: the request's id. */
  item: string;
  decision: "approve" | "decline" | "answer";
  /** SHA-256 of what the owner saw (connector.ts itemDigest): the decision applies to that only. */
  digest: string;
  /** For the owner's own answer to a question: their words, and the choice. */
  text?: string;
  choice?: number;
  /** For a decline: the protocol's reason (`owner_declined` unless the owner says otherwise) and an optional one-line note, data. */
  reason?: string;
  note?: string;
  /** When the owner signed it: a timestamp. */
  at: string;
  signature?: string;
}

export interface SendRule {
  /** A member's obi_id, or `*` for every member. */
  to: string;
  /** The request types the host's agent may send to it without asking: `question`, `review_request`, `handoff`. */
  actions: string[];
}

export interface Rules {
  kind: "rules";
  sphere: string;
  obi: string;
  /** Grows with each new set of rules: an older one never replaces a newer one. */
  version: number;
  at: string;
  send: SendRule[];
  signature?: string;
}

const signingInput = (statement: { kind: string; signature?: string }): Uint8Array => {
  const { signature: _signature, ...rest } = statement;
  const prefix = utf8(`obysphere-connector ${statement.kind}\n`);
  const body = canonicalBytes(rest);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix);
  out.set(body, prefix.length);
  return out;
};

export async function signStatement<T extends Decision | Rules>(statement: T, ownerKey: SigningKey): Promise<T> {
  return { ...statement, signature: await ownerKey.sign(signingInput(statement)) };
}

export async function verifyStatement(statement: unknown, ownerPublicKey: string): Promise<boolean> {
  const s = statement as { kind?: unknown; signature?: unknown };
  if (!s || (s.kind !== "decision" && s.kind !== "rules") || typeof s.signature !== "string") return false;
  try {
    return await verifyEd25519(ownerPublicKey, signingInput(s as Decision | Rules), s.signature);
  } catch {
    return false;
  }
}

/** The rules a new member starts with: none, so everything the agent asks to send waits for the owner until they set rules. */
export const defaultSend = (): SendRule[] => [];

/** Whether `rules` let the host's agent send a `type` request to `to` without asking the owner. */
export const allows = (rules: Rules | null, to: string, type: string): boolean =>
  !!rules && rules.send.some((r) => (r.to === "*" || r.to === to) && r.actions.includes(type));

export const isDecision = (v: unknown): v is Decision => {
  const d = v as JsonObject;
  return !!d && d.kind === "decision" && typeof d.item === "string" && (d.decision === "approve" || d.decision === "decline" || d.decision === "answer") && typeof d.at === "string" && typeof d.digest === "string";
};
