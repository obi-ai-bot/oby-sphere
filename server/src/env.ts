// The Worker's bindings (wrangler.jsonc).

export interface Env {
  DB: D1Database;
  /** One ChannelRelay per run_request exchange: its job channel (src/channel.ts). */
  CHANNELS: DurableObjectNamespace<import("./channel.ts").ChannelRelay>;
  /** One Doorbell per Obi in a Sphere: what wakes its deliveries long poll (src/doorbell.ts). */
  DOORBELLS: DurableObjectNamespace<import("./doorbell.ts").Doorbell>;
  /** One PhoneRelay per phone relay: a Mac and its paired phones (src/relay.ts). */
  RELAYS: DurableObjectNamespace<import("./relay.ts").PhoneRelay>;
  /** The operator token that creates Spheres: a Worker secret, at least 32 characters. Unset: every operator call is 403. */
  SPHERE_OPERATOR_TOKEN?: string;
  /** Only the operator token's SHA-256, lower-case hex: a self-hosted Sphere's, kept from its claim (node/main.ts). SPHERE_OPERATOR_TOKEN wins when both are set. */
  SPHERE_OPERATOR_TOKEN_SHA256?: string;
  /** The Google OAuth client whose ID tokens sign people in (src/signin.ts): Google as one provider, `google`. Empty: no Google. */
  GOOGLE_CLIENT_ID?: string;
  /**
   * The other OpenID Connect providers that sign people in, a JSON list of
   * `{"id", "name", "issuer", "client_id", "domain" or "domain_claim", "email_verified"}` (src/signin.ts).
   * No provider at all: no sign-in, and every sign-in call is 403.
   */
  SIGNIN_PROVIDERS?: string | unknown[];
  /** More schemes a sign-in's code may go back to, comma-separated, beside Oby's and the listed clients' (src/signin.ts, `returnTo`): only schemes of clients installed on people's own machines. */
  SIGNIN_RETURN_SCHEMES?: string;
  /**
   * This server's public address. Set, its origin is the server's own: the one an assertion's `aud`
   * URL must name, and the one DPoP proofs and the sign-in's callback are for. Unset, a Worker takes
   * the request's own (Cloudflare routes only its own hosts to it). The Node build sets it from
   * SPHERE_URL, and leaves it empty without one: then, or for one that isn't an http or https
   * address, the server signs nobody in, takes no DPoP proof (it ignores one at the token endpoint)
   * and no URL form of `aud`, and lists neither `dpop` nor `sphere_url_aud`.
   */
  SPHERE_URL?: string;
  /** The domains, comma-separated, whose people may create a Sphere with a sign-in (a Google Workspace, or a provider's `domain`). Empty: only the operator creates. */
  CREATOR_WORKSPACES?: string;
  /** How many Spheres one account may be the admin owner of before a create with a sign-in is 429. Unset: 3. */
  SPHERE_CREATE_LIMIT?: string;
  /** `off`: no phone relay (spec/sphere-api.md section 9, the optional extension `phone_relay`); its paths answer 404 and /v0.1/features doesn't list it. Unset or `on`: the relay is offered; any other value turns it off. */
  PHONE_RELAY?: string;
}

/** What the handlers take besides the request and the bindings; tests pass their own clock. */
export interface Deps {
  /** Milliseconds since 1970: the Sphere's clock. */
  now(): number;
  /** How long a write keeps retrying against concurrent writes before `429 rate_limited`, in milliseconds (src/db.ts). */
  retryBudgetMs?: number;
  /** Every sign-in provider's discovery document and keys (src/signin.ts); the tests pass their own issuers. */
  issuers?: import("./signin.ts").Issuers;
}
