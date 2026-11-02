// An owner (spec/identity.md): a person's key, which signs their Obis' cards and delegations, and
// their own short assertions for the calls only an owner makes (inviting, the policy, revoking).

import { newCard, signCard, type AgentCard, type NewCard } from "./card.ts";
import { SigningKey } from "./crypto.ts";
import { ownerAssertion } from "./jws.ts";
import type { SphereApi, TokenResponse } from "./sphere.ts";

/** What an Obi's delegation grants unless its owner says otherwise: every request the connector makes, replies, its deliveries, the directory and the chain. */
export const DEFAULT_OBI_SCOPES = "send:review_request send:question send:handoff reply receive directory:read audit:read";
/** An admin owner's own token. */
export const ADMIN_SCOPES = "admin directory:read audit:read";

export class Owner {
  readonly id: string;
  readonly key: SigningKey;

  constructor(id: string, key: SigningKey) {
    if (!/^[a-z0-9-]{1,63}$/.test(id)) throw new Error(`${id} is not an owner id`);
    this.id = id;
    this.key = key;
  }

  static async generate(id: string): Promise<Owner> {
    return new Owner(id, await SigningKey.generate());
  }

  /** A delegation to `obi` in `sphere` (identity.md 4.1): the owner lets that Obi act for them, with these scopes, for at most 30 days. */
  delegation(sphere: string, obi: string, o: { scope?: string; lifetime?: number; aud?: string } = {}): Promise<string> {
    return ownerAssertion(this.key, { owner: this.id, sphere, scope: o.scope ?? DEFAULT_OBI_SCOPES, mayAct: obi, lifetime: o.lifetime, ...(o.aud ? { aud: o.aud } : {}) });
  }

  /** The owner's own token for `sphere`, from a new single-use assertion. */
  async token(api: SphereApi, sphere: string, scope = ADMIN_SCOPES, o: { aud?: string } = {}): Promise<TokenResponse> {
    return api.token({ subject: await ownerAssertion(this.key, { owner: this.id, sphere, scope, ...(o.aud ? { aud: o.aud } : {}) }) });
  }

  /** A card for one of this owner's Obis, signed with this owner's key. */
  card(c: Omit<NewCard, "owner" | "owner_key">): Promise<AgentCard> {
    return signCard(newCard({ ...c, owner: this.id, owner_key: this.key.publicKey }), this.key);
  }
}
