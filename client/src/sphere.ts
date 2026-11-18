// An Obysphere's HTTP API (spec/sphere-api.md): one method per call, each answer read with the
// protocol's strict JSON rules and checked against its wire schema before it is returned, so a
// client never acts on a body the spec doesn't allow. Two answers are checked part by part: the
// directory (an entry that breaks the member schema is left out) and the deliveries (each one's own
// fields; its envelope is the receiver's to judge, so it comes back unchecked). This is the raw layer: what it returns is
// the protocol's documents as they are (a card's name, a delivery's envelope); Member hands their
// words over as DataText. An error's message is the library's own words; the server's message is
// kept as a DataText.

import type { AgentCard } from "./card.ts";
import type { Envelope } from "./envelope.ts";
import type { AuditEntry } from "./chain.ts";
import { parseStrict } from "./json.ts";
import { matches, type SchemaName } from "./schemas.ts";
import { sphereBase } from "./invite.ts";
import { DataText } from "./text.ts";
import type { DpopKey } from "./dpop.ts";

export const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const JWT_TYPE = "urn:ietf:params:oauth:token-type:jwt";

/**
 * A failed call: the HTTP status and the error code the API answered (`bad_response` when the
 * answer itself broke the protocol, `unreachable` when there was none). `message` is the library's
 * own words; what the server wrote is `serverMessage`, data.
 */
export class SphereError extends Error {
  readonly status: number;
  readonly code: string;
  readonly serverMessage: DataText | undefined;
  /** Seconds to wait, from `Retry-After`, when the server sent one. */
  readonly retryAfter: number | undefined;

  constructor(status: number, code: string, message: string, serverMessage?: string, retryAfter?: number) {
    super(`${status} ${code}: ${message}`);
    this.name = "SphereError";
    this.status = status;
    this.code = code;
    this.serverMessage = serverMessage === undefined ? undefined : new DataText(serverMessage, { from: "the Sphere", type: "error", field: "/error/message" });
    this.retryAfter = retryAfter;
  }
}

/** The error codes the spec gives the API (sphere-api.md section 1) and the token endpoint (RFC 6749 5.2): anything else is reported as `http_error`. */
const ERROR_CODES = new Set([
  "bad_request", "invalid_envelope", "wrong_sphere", "unknown_key", "bad_signature", "expired", "clock_skew", "card_invalid", "unauthorized",
  "insufficient_scope", "forbidden", "policy_denied", "recipient_revoked", "not_sealed", "invitation_invalid", "not_found", "unknown_recipient",
  "duplicate", "bad_reply", "conflict", "payload_too_large", "rate_limited", "internal",
  "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type", "invalid_scope", "invalid_dpop_proof", "invalid_token",
]);
const errorCode = (c: unknown): string | undefined => (typeof c === "string" && ERROR_CODES.has(c) ? c : undefined);

export interface Health {
  status?: string;
  protocol?: string;
  seal?: boolean;
  [key: string]: unknown;
}
export interface TokenResponse {
  access_token: string;
  issued_token_type: string;
  token_type: "Bearer" | "DPoP";
  expires_in: number;
  scope: string;
}
export interface DirectoryKeyEntry {
  key_id: string;
  public_key: string;
  valid_from_seq: number;
  valid_until_seq: number | null;
}
export interface Member {
  obi: string;
  owner: string;
  owner_key: string;
  owner_key_id: string;
  status: "active" | "revoked";
  joined_at: string;
  revoked_at?: string;
  card: AgentCard;
  keys: DirectoryKeyEntry[];
  runner?: unknown;
}
export interface Invitation {
  invitation_id: string;
  sphere: string;
  secret: string;
  expires_at: string;
  max_uses: number;
  owner?: string;
  obi?: string;
  domain?: string;
  label?: string;
}
export interface InvitationPreview {
  sphere: string;
  name: string;
  member_count: number;
  expires_at: string;
  domain?: string;
}
export interface PolicyRule {
  id: string;
  from_owner: string;
  to_owner: string;
  actions: string[];
  repos: string[];
}
export interface Policy {
  version: number;
  updated_at: string;
  rules: PolicyRule[];
}
export interface SendReceipt {
  id: string;
  seq: number;
  entry_hash: string;
  recorded_at: string;
}
export interface Delivery {
  delivery_id: string;
  seq: number;
  relayed_at: string;
  envelope: Envelope;
}
export interface AuditPage {
  sphere: string;
  entries: AuditEntry[];
  head: { seq: number; hash: string };
}
/** A finished sign-in (sphere-api.md section 3.1). */
export interface Signin {
  state: string;
  code: string;
}

export interface SphereInfo {
  sphere: string;
  name: string;
  protocol: string;
  admin_owner: string;
  admins: string[];
  created_at: string;
  [key: string]: unknown;
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface SphereApiOptions {
  /** A fetch to use instead of the global one. */
  fetch?: Fetch;
}

/** A started sign-in (sphere-api.md section 3.1): the provider's page to open, and its `state`. */
export interface SigninStarted {
  url: string;
  state: string;
}

/** The API of the Sphere server at `base` (its origin: `https://sphere.example.com`). */
export class SphereApi {
  readonly base: string;
  readonly #fetch: Fetch;
  /** A DPoP key (identity.md section 4.6): set it, and the token exchange sends a proof; the tokens it binds are sent as `DPoP` with a proof each time. */
  dpop: DpopKey | null = null;
  /** Each token the server bound, with the key it was bound to and when it expires. */
  readonly #bound = new Map<string, { key: DpopKey; until: number }>();

  constructor(base: string, opts: SphereApiOptions = {}) {
    this.base = sphereBase(base);
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  /** One call: the parsed answer, checked against `schema`; a SphereError for anything else. */
  async call<T>(
    method: string,
    path: string,
    o: { token?: string; json?: unknown; form?: Record<string, string>; schema?: SchemaName; ok?: number[]; dpopKey?: DpopKey } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    let body: string | undefined;
    const proofKey = path === "/v0.1/oauth/token" && !o.token ? (o.dpopKey ?? null) : null;
    if (o.token) Object.assign(headers, await this.authHeaders(method, this.base + path, o.token));
    else if (proofKey) headers.DPoP = await proofKey.proof(method, this.base + path);
    if (o.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(o.form).toString();
    } else if (o.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(o.json);
    }
    const what = `${method} ${path.replace(/\?.*$/, "")}`;
    let res: Response;
    try {
      res = await this.#fetch(this.base + path, { method, headers, body, redirect: "error" });
    } catch {
      throw new SphereError(0, "unreachable", `${what}: no answer from ${this.base}`);
    }
    const text = await res.text();
    let parsed: unknown = undefined;
    let strict = true;
    if (text) {
      try {
        parsed = parseStrict(text);
      } catch {
        strict = false;
      }
    }
    if (!(o.ok ?? [200]).includes(res.status)) {
      const retry = res.headers.get("Retry-After");
      const retryAfter = retry && /^[0-9]{1,6}$/.test(retry) ? Number(retry) : undefined;
      const err = (parsed as { error?: unknown; error_description?: unknown } | undefined) ?? {};
      const oauth = errorCode(err.error);
      if (oauth) throw new SphereError(res.status, oauth, what, typeof err.error_description === "string" ? err.error_description : undefined, retryAfter);
      const e = err.error as { code?: unknown; message?: unknown } | undefined;
      throw new SphereError(res.status, errorCode(e?.code) ?? "http_error", what, typeof e?.message === "string" ? e.message : undefined, retryAfter);
    }
    if (!strict) throw new SphereError(res.status, "bad_response", `${what}: the answer isn't JSON as the protocol writes it (a repeated member name, a fraction or a negative number)`);
    if (o.schema && !matches(o.schema, parsed)) throw new SphereError(res.status, "bad_response", `${what}: the answer doesn't match ${o.schema}`);
    return parsed as T;
  }

  #sphere(sphere: string, rest = ""): string {
    if (!/^[a-z0-9-]{1,63}$/.test(sphere)) throw new Error(`${sphere} is not a Sphere id`);
    return `/v0.1/spheres/${sphere}${rest}`;
  }

  health(): Promise<Health> {
    return this.call("GET", "/v0.1/health", { schema: "wire/health.response" });
  }

  /** The additions to obi/0.1 the Obysphere takes (`GET /v0.1/features`); none when it answers a 4xx or a 200 that isn't the list, as an older one does. */
  async features(): Promise<string[]> {
    try {
      return (await this.call<{ features: string[] }>("GET", "/v0.1/features", { schema: "wire/features.response" })).features;
    } catch (e) {
      // An Obysphere that answers, but not with a valid list, takes none; one that doesn't answer, or fails (a 5xx), says nothing.
      if (e instanceof SphereError && e.status !== 0 && e.status < 500) return [];
      throw e;
    }
  }

  /** Creates a Sphere with the server's operator token (section 3). */
  createSphere(operatorToken: string, body: { sphere: string; name: string; admin: { owner: string; owner_key: string } }): Promise<SphereInfo> {
    return this.call("POST", "/v0.1/spheres", { token: operatorToken, json: body, schema: "wire/sphere", ok: [201] });
  }

  /** The token exchange (identity.md section 4.3): an owner's own token without `actor`, an Obi's with it. */
  async token(form: { subject: string; actor?: string; scope?: string }): Promise<TokenResponse> {
    const f: Record<string, string> = { grant_type: TOKEN_EXCHANGE, subject_token: form.subject, subject_token_type: JWT_TYPE };
    if (form.actor) Object.assign(f, { actor_token: form.actor, actor_token_type: JWT_TYPE });
    if (form.scope) f.scope = form.scope;
    // The key the proof is signed with, taken once: the token is bound to that key, whatever `dpop` is set to later.
    const key = this.dpop;
    const t = await this.call<TokenResponse>("POST", "/v0.1/oauth/token", { form: f, schema: "wire/token.response", ...(key ? { dpopKey: key } : {}) });
    // Bound to the DPoP key only when the Obysphere says so: one that doesn't take DPoP issues a bearer token.
    const now = Math.floor(Date.now() / 1000);
    for (const [token, b] of this.#bound) if (b.until <= now) this.#bound.delete(token);
    if (t.token_type === "DPoP" && key) this.#bound.set(t.access_token, { key, until: now + t.expires_in });
    return t;
  }

  /**
   * The headers that carry `token` on a call to `url` (any call, the library's or one it doesn't
   * make, such as a WebSocket upgrade, whose method is `GET`): `Authorization: DPoP` and a new proof
   * signed with the key the token was bound to, or `Authorization: Bearer` for a token that isn't bound.
   */
  async authHeaders(method: string, url: string, token: string): Promise<Record<string, string>> {
    const bound = this.#bound.get(token);
    if (!bound) return { Authorization: `Bearer ${token}` };
    return { Authorization: `DPoP ${token}`, DPoP: await bound.key.proof(method, url, token) };
  }

  /** The sign-in providers this server offers (`GET /v0.1/signin`): their `name`s are data. An older server answers 404 (a SphereError `not_found`): it signs in with `google` alone, if at all. */
  async signinProviders(): Promise<{ id: string; name: string }[]> {
    return (await this.call<{ providers: { id: string; name: string }[] }>("GET", "/v0.1/signin", { schema: "wire/signin-providers.response" })).providers;
  }

  /**
   * Starts a sign-in with `provider` for `ownerKey` (sphere-api.md section 3.1): the page to open in
   * a browser, and the `state` to match the code that comes back. `returnTo` is where the browser
   * comes back, a place on this machine the server knows; send it only to a server that lists
   * `signin_providers` in its features.
   */
  async signinStart(provider: string, ownerKey: string, returnTo?: string): Promise<SigninStarted> {
    if (!/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(provider)) throw new Error(`${provider} is not a provider id`);
    return this.call("POST", `/v0.1/signin/${provider}`, { json: { owner_key: ownerKey, ...(returnTo !== undefined ? { return_to: returnTo } : {}) }, schema: "wire/signin.response", ok: [201] });
  }

  sphere(token: string, sphere: string): Promise<SphereInfo> {
    return this.call("GET", this.#sphere(sphere), { token, schema: "wire/sphere" });
  }

  createInvitation(
    ownerToken: string,
    sphere: string,
    body: { owner?: string; obi?: string; expires_in: number; max_uses?: number; domain?: string; label?: string },
  ): Promise<Invitation> {
    return this.call("POST", this.#sphere(sphere, "/invitations"), { token: ownerToken, json: body, schema: "wire/invitation.response", ok: [201] });
  }

  previewInvitation(sphere: string, invitationId: string, secret: string): Promise<InvitationPreview> {
    return this.call("POST", this.#sphere(sphere, `/invitations/${encodeURIComponent(invitationId)}/preview`), { json: { secret }, schema: "wire/invitation-preview.response" });
  }

  redeem(sphere: string, invitationId: string, body: { secret: string; owner_key: string; card: AgentCard; signin?: Signin }): Promise<Member> {
    return this.call("POST", this.#sphere(sphere, `/invitations/${encodeURIComponent(invitationId)}/redeem`), { json: body, schema: "wire/member", ok: [201] });
  }

  /**
   * The directory. Each entry is checked on its own: one that breaks the member schema (another
   * version's card, say) is left out rather than failing the whole answer.
   */
  async members(token: string, sphere: string): Promise<Member[]> {
    const answer = await this.call<{ sphere?: unknown; members?: unknown }>("GET", this.#sphere(sphere, "/members"), { token });
    const keys = answer && typeof answer === "object" ? Object.keys(answer).sort().join(",") : "";
    if (keys !== "members,sphere" || answer.sphere !== sphere || !Array.isArray(answer.members) || answer.members.length > 1000) {
      throw new SphereError(200, "bad_response", "the directory isn't a members answer for this Sphere");
    }
    return answer.members.filter((m): m is Member => matches("wire/member", m));
  }

  member(token: string, sphere: string, obi: string): Promise<Member> {
    return this.call("GET", this.#sphere(sphere, `/members/${encodeURIComponent(obi)}`), { token, schema: "wire/member" });
  }

  updateCard(token: string, sphere: string, obi: string, card: AgentCard): Promise<Member> {
    return this.call("PUT", this.#sphere(sphere, `/members/${encodeURIComponent(obi)}/card`), { token, json: { card }, schema: "wire/member" });
  }

  revoke(ownerToken: string, sphere: string, obi: string): Promise<Member> {
    return this.call("DELETE", this.#sphere(sphere, `/members/${encodeURIComponent(obi)}`), { token: ownerToken, schema: "wire/member" });
  }

  policy(token: string, sphere: string): Promise<Policy> {
    return this.call("GET", this.#sphere(sphere, "/policy"), { token, schema: "wire/policy" });
  }

  putPolicy(ownerToken: string, sphere: string, body: { expected_version: number; rules: PolicyRule[] }): Promise<Policy> {
    return this.call("PUT", this.#sphere(sphere, "/policy"), { token: ownerToken, json: body, schema: "wire/policy" });
  }

  /** Sends a signed envelope (section 6.1): `202` when recorded, `200` with the original receipt for a retry of the same bytes. */
  send(token: string, envelope: Envelope): Promise<SendReceipt> {
    return this.call("POST", this.#sphere(envelope.sphere, "/messages"), { token, json: envelope, schema: "wire/send.response", ok: [200, 202] });
  }

  /** The deliveries waiting for the token's Obi (section 6.2); `wait` up to 25 seconds holds the call until one arrives. */
  /**
   * Each delivery's own fields are checked here; its envelope is the receiver's to judge (protocol.md
   * section 10), so one that is invalid comes back for the receiver to refuse and acknowledge rather
   * than failing the whole answer.
   */
  async deliveries(token: string, sphere: string, o: { limit?: number; wait?: number } = {}): Promise<Delivery[]> {
    const q = new URLSearchParams();
    if (o.limit !== undefined) q.set("limit", String(o.limit));
    if (o.wait !== undefined) q.set("wait", String(o.wait));
    const qs = q.size ? `?${q}` : "";
    const answer = await this.call<{ deliveries?: unknown }>("GET", this.#sphere(sphere, `/deliveries${qs}`), { token });
    const ok = answer && typeof answer === "object" && Object.keys(answer).join(",") === "deliveries" && Array.isArray(answer.deliveries) && answer.deliveries.length <= 100;
    if (!ok) throw new SphereError(200, "bad_response", "the answer isn't a deliveries answer");
    const shaped = (d: unknown): d is Delivery => {
      const x = d as Record<string, unknown>;
      return !!x && typeof x === "object" && Object.keys(x).sort().join(",") === "delivery_id,envelope,relayed_at,seq" &&
        typeof x.delivery_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x.delivery_id) &&
        Number.isSafeInteger(x.seq) && (x.seq as number) >= 1 && typeof x.relayed_at === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(x.relayed_at) &&
        !!x.envelope && typeof x.envelope === "object" && !Array.isArray(x.envelope);
    };
    if (!(answer.deliveries as unknown[]).every(shaped)) throw new SphereError(200, "bad_response", "a delivery's own fields don't match the protocol");
    return answer.deliveries as Delivery[];
  }

  async ack(token: string, sphere: string, deliveryIds: string[]): Promise<number> {
    return (await this.call<{ acked: number }>("POST", this.#sphere(sphere, "/deliveries/ack"), { token, json: { delivery_ids: deliveryIds }, schema: "wire/ack.response" })).acked;
  }

  audit(token: string, sphere: string, o: { fromSeq?: number; limit?: number } = {}): Promise<AuditPage> {
    const q = new URLSearchParams();
    if (o.fromSeq !== undefined) q.set("from_seq", String(o.fromSeq));
    if (o.limit !== undefined) q.set("limit", String(o.limit));
    const qs = q.size ? `?${q}` : "";
    return this.call("GET", this.#sphere(sphere, `/audit${qs}`), { token, schema: "wire/audit.response" });
  }

  /** The whole chain from seq 1, page by page, up to the head the first page answered (section 7.1), and at most `maxEntries`. */
  async auditAll(token: string, sphere: string, o: { maxEntries?: number } = {}): Promise<AuditPage> {
    const first = await this.audit(token, sphere, { fromSeq: 1, limit: 1000 });
    if (first.head.seq > (o.maxEntries ?? 1_000_000)) throw new SphereError(200, "bad_response", `the chain says it has ${first.head.seq} entries, more than ${o.maxEntries ?? 1_000_000} this call reads`);
    const entries = [...first.entries];
    while (entries.length < first.head.seq) {
      const page = await this.audit(token, sphere, { fromSeq: entries.length + 1, limit: 1000 });
      const fresh = page.entries.filter((e) => e.seq <= first.head.seq);
      // A page short of what it could hold, before the head, is a Sphere dragging it out.
      if (!fresh.length || fresh[0]!.seq !== entries.length + 1 || (fresh.length < 1000 && entries.length + fresh.length < first.head.seq)) throw new SphereError(200, "bad_response", `the chain stops at ${entries.length}, short of its head ${first.head.seq}`);
      entries.push(...fresh);
    }
    return { sphere: first.sphere, entries, head: first.head };
  }
}
