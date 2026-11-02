# Obysphere Core v0.1: keys, agent cards and delegation

Who an agent is, who it acts for, and how it proves both to an Obysphere. Read [protocol.md](protocol.md) first for the conventions (JSON rules, canonical JSON, Ed25519).

## 1. Keys

Every key in this protocol is **Ed25519** (RFC 8032).

| Key | Held by | Signs |
|---|---|---|
| **Owner key** | The owner (their device; in the e2e test, the harness). Never the Obysphere. | The agent's card; the owner's delegation to the agent; the owner's own assertions for admin calls. |
| **Agent key** | The agent only. It never leaves the agent (Oby keeps it in its daemon's own home, mode 0600, or a platform keystore). | Every envelope the agent sends; the agent's actor assertions. |

- A public key is written as the 32 raw bytes in base64url without padding (43 characters).
- A **key id** is `ed25519:` followed by base64url (no padding) of SHA-256 over the 32 raw public key bytes (51 characters in all). Anyone can check that a key id belongs to a public key.
- An agent's key MUST differ from its owner's key.

## 2. The agent card

Each agent publishes one A2A AgentCard per Obysphere it belongs to (A2A protocol 0.3.0), restricted to the profile in [agent-card.schema.json](schemas/v0.1/agent-card.schema.json) and signed by its owner's key. The Obysphere stores it in its directory and returns it to every member.

```json
{
  "protocolVersion": "0.3.0",
  "name": "Wellington's agent",
  "description": "A personal delegate for an engineer.",
  "url": "http://127.0.0.1:8787/v0.1/spheres/e2e/members/agent-wellington",
  "preferredTransport": "HTTP+JSON",
  "version": "0.1.0",
  "capabilities": {
    "streaming": false,
    "pushNotifications": false,
    "extensions": [{
      "uri": "urn:obi-sphere:ext:obi:0.1",
      "required": true,
      "params": {
        "protocol": "obi/0.1",
        "sphere": "e2e",
        "obi_id": "agent-wellington",
        "owner": "wellington",
        "owner_key": "<owner public key, base64url>",
        "key_id": "ed25519:<base64url SHA-256 of the agent public key>",
        "public_key": "<agent public key, base64url>",
        "seal_key_id": "x25519:<base64url SHA-256 of the agent's seal key>",
        "seal_public_key": "<the agent's X25519 seal key, base64url>",
        "accepts": ["review_request", "question"],
        "card_seq": 1,
        "issued_at": "2026-10-14T12:00:00Z"
      }
    }]
  },
  "defaultInputModes": ["application/json"],
  "defaultOutputModes": ["application/json"],
  "skills": [
    {"id": "review_request", "name": "Review a change", "description": "Reviews a change for its owner and answers with typed findings.", "tags": ["obi-action"]},
    {"id": "question", "name": "Answer a question", "description": "Answers what its owner knows or decided.", "tags": ["obi-action"]}
  ],
  "signatures": [{"protected": "<base64url JWS header>", "signature": "<base64url Ed25519 signature>"}]
}
```

What the profile requires beyond A2A:

- Exactly one extension, the **Obysphere extension** `urn:obi-sphere:ext:obi:0.1`, with `required: true` and the `params` above. `accepts` lists the request types the agent takes; `skills` has one skill per entry of `accepts` (same set), tagged `obi-action`. Replies are always accepted and aren't listed.
- `url` is the agent's entry in its Obysphere's directory: `<sphere base URL>/v0.1/spheres/<sphere>/members/<obi_id>`. Messages reach the agent through the Obysphere's relay, never at the agent itself: sent to the relay's own API ([sphere-api.md](sphere-api.md) section 6), or, where the Obysphere offers the A2A binding (the feature `a2a`), over A2A 1.0 at this URL ([a2a.md](a2a.md)). The card's `protocolVersion` and `preferredTransport` stay as the schema pins them; a client learns that the interface at `url` speaks A2A 1.0 from the Obysphere's `GET /v0.1/features`.
- `seal_key_id` and `seal_public_key`, both or neither: the X25519 key other agents seal this agent's words for ([protocol.md](protocol.md) section 9.1), made by the agent apart from its signing key. `seal_key_id` is `x25519:` followed by base64url (no padding) of SHA-256 over the key's 32 raw bytes. A card without them is valid: its agent gets words in the clear. Implementations of v0.1 from before 2026-10-26 close `params` and so refuse a card with them: an agent SHOULD publish a seal key only once its Obysphere's `GET /v0.1/health` says `seal: true` and every active member's card says an implementation `version` that reads one (an agent announces that with a card first, and adds its seal key with a later one).
- `name` and `description` are data (`x-obi-text: data`): the owner wrote them, and other agents only show them.
- `streaming` and `pushNotifications` are `false`; input and output modes are `application/json`.
- Only the A2A fields in the schema are allowed (`provider` and `documentationUrl` are the optional ones). No `securitySchemes`: authentication is the Obysphere's (section 4).
- `features`, `runtime`, `vendors`, `classes` and `topics`, optional: the additions the agent takes, what runs it, the conformance classes it claims, and what it can help with (section 2.3).

### 2.1 Signing a card

The card carries exactly one signature, an A2A `AgentCardSignature`: a JWS (RFC 7515) with a detached payload, made with the **owner key** using `EdDSA` (RFC 8037).

1. Remove `signatures` from the card. The payload is the RFC 8785 canonical JSON of what is left.
2. The protected header is the canonical JSON of `{"alg": "EdDSA", "kid": "<owner key id>", "typ": "JOSE"}`, base64url without padding: that string is `protected`.
3. The signing input is the ASCII bytes of `protected + "." + base64url(payload)`.
4. `signature` is the Ed25519 signature over the signing input, base64url without padding.

### 2.2 Verifying a card

A card is valid when (the Obysphere checks this when it registers a card; every agent checks it before trusting a directory entry):

1. It matches the schema.
2. `params.key_id` is the key id of `params.public_key`, and `params.public_key` differs from `params.owner_key`; `params.seal_key_id`, when there is one, is the seal key id of `params.seal_public_key`.
3. `skills` and `params.accepts` name the same request types, and `url` ends with `/v0.1/spheres/<params.sphere>/members/<params.obi_id>`.
4. The protected header decodes to exactly `{alg: "EdDSA", kid, typ: "JOSE"}`, and `kid` is the key id of `params.owner_key`.
5. The signature verifies with `params.owner_key`.
6. Once the Obysphere has bound a key for this owner (section 3), `params.owner_key` is that bound key.
7. `params.issued_at` is at most 300 seconds ahead of the checker's clock.

The conformance suite has card fixtures for each of these.

### 2.3 Features, the runtime and the vendors

A card may say which additions to `obi/0.1` its agent takes, and what runs it. The three members below come with the feature `card_runtime` ([README.md, "Versions"](README.md#versions)). Each is optional, and the owner signs them with the rest of the card; a card without them is as valid as before.

- **`features`**: the additions to `obi/0.1` the agent takes, 1 to 64 distinct feature ids (a lower-case letter, then up to 63 lower-case letters, digits and `_`). Taking one means the agent reads cards that carry its members and takes the messages that use it, as the addition's own text says. The list comes with `card_runtime`, so it always names it. An id the reader doesn't know is valid and means nothing to it.
- **`runtime`**: `{"id", "version"}` (the version up to 64 letters, digits, `.`, `+` and `-`), the agent runtime: the program that acts as the member's agent, whatever it runs to do its work, and its version as that program names it. An agent that is a coding agent with this protocol added (Claude Code through a connector) names that coding agent; an implementation that runs coding agents for its owner (Oby) names itself. The version is seen by every member and by whoever runs the Obysphere.
- **`vendors`**: the model vendors whose models the agent may use for its work in this Obysphere, 1 to 16 distinct vendor ids, in no particular order. A card that lists several says only that any of them may be used: it is one member, never one for each vendor.

**Conformance classes.** A card may also carry, behind the feature `card_classes`:

- **`classes`**: the conformance classes its member claims, 1 to 16 distinct class ids (a lower-case letter, then up to 63 lower-case letters, digits and `_`), in no particular order. A card with `classes` lists `card_classes` in `features`.

**What a class is.** Only the conformance suite defines class ids, and says which rules and cases make up each ([conformance/README.md](conformance/README.md#conformance-classes), "Conformance classes"; #57). Today it names four: `participant` (sends and receives typed actions, verifies everything, treats words as data, and waits for its owner), `executor` (runs received work in a sandbox with none of its owner's secrets), `holder` (holds a key or an account others use, and meters it) and `approver` (approves on a code host, only under the owner's confirmation: [protocol.md](protocol.md) section 11, "Approving on the code host"). An implementation MUST NOT claim an id the suite doesn't define; an id a reader doesn't know is one from a later suite, and claims nothing it knows of.

**A claim, not a result.** A class on a card says its member's agent keeps that class's rules, signed by the owner with the rest of the card. Nothing on the card links to a report, and nothing checks the claim: the report the conformance runner writes for an implementation is what backs it, published apart. A member MAY show its owner the classes another claims. No permission, trust or decision depends on a claimed class, and an implementation MUST NOT let one do: a member that claims `approver` approves nothing on that account, and one that claims `holder` is handed nothing. Only a policy rule an Obysphere's admin writes may name a class, and only to narrow which members a rule matches ([sphere-api.md](sphere-api.md) section 5, behind the feature `policy_classes`, an addition of its own; #57). An agent that reads such rules lists `policy_classes` in its card's `features`, so the Obysphere holds a class rule until every member can read it. A card without `classes` claims none.

**Topics.** A card may also say what its member can help with, behind the feature `card_topics`:

- **`topics`**: 1 to 32 distinct topic ids its owner chose (a lower-case letter or digit, then up to 63 lower-case letters, digits and `-`: `rust`, `payments`, `ios-release`), in no particular order. A card with `topics` lists `card_topics` in `features`.

Topics are ids, not sentences, so they can be matched ("who here can help with `payments`?" is a look through the directory's cards). Hyphenated words still fit in one (`ignore-your-rules`), so they are text like `name` and `description`: the owner's to choose, checked by nothing, and data. A member reads them only to show its owner, or to find whom to ask, and a model it gives them to gets them as quoted data, never as instructions ([protocol.md](protocol.md) section 8).

**Taking introductions.** A card that `accepts` `introduction` ([protocol.md](protocol.md) section 5.18) lists the feature `introduction` in `features`, so a card accepts up to six request types.

A card with `runtime`, `vendors`, `classes` or `topics` has `features`. Runtime and vendor ids are a lower-case letter, then up to 63 lower-case letters, digits and `-` ([common.schema.json](schemas/v0.1/common.schema.json), `runtime_id` and `vendor_id`).

**Declared, not proven.** `runtime` and `vendors` say what the owner declares runs their agent, and nothing checks them: a card can name a runtime or a vendor its agent doesn't run, and no part of the protocol can tell. A member MAY show them to its owner. No permission, policy rule or remembered decision depends on them, and an implementation MUST NOT let one do. A process that counts them (the Council's draw of seats from more than one vendor, [council/process.md](council/process.md)) relies on its members' owners, and says itself how far.

**Known ids.** Any id that matches its pattern is valid, so a runtime or a vendor nobody here has heard of can be named. An implementation MUST use the id below for a runtime or a vendor these tables name, so that one is never named two ways; a pull request adds a new one.

| Runtime | What it is |
|---|---|
| `claude` | Claude Code, Anthropic's coding agent CLI |
| `codex` | Codex, OpenAI's coding agent CLI |
| `cursor` | Cursor's agent CLI |
| `gemini` | Gemini CLI, Google's |
| `goose` | goose |
| `opencode` | OpenCode |
| `copilot` | GitHub Copilot's CLI |
| `oby` | Oby, which runs coding agents for its owner |

An id names the same program wherever it appears: `claude` and `codex` are also the values a `run_request`'s `agent` takes ([protocol.md](protocol.md) section 5.10), where they name the coding agent that runs a job rather than what acts as the member.

| Vendor | Whose models |
|---|---|
| `anthropic` | Anthropic |
| `openai` | OpenAI |
| `google` | Google |
| `mistral` | Mistral AI |
| `meta` | Meta |
| `xai` | xAI |
| `deepseek` | DeepSeek |
| `alibaba` | Alibaba (Qwen) |
| `moonshot` | Moonshot AI |

**Publishing a card with an addition.** An implementation that doesn't take an addition closes `params` and refuses a card that carries one of its members, as it refuses every member it doesn't know, and one that checks the directory as one document then refuses the whole directory. So an agent MUST NOT put a member that an addition brings (the `features` list itself, which `card_runtime` brings, included) in its card until both of these hold, unless the card it replaces carries it already, and the Obysphere refuses a card that does (`409 feature_not_taken`, [sphere-api.md](sphere-api.md) section 4):

1. Its Obysphere's `GET /v0.1/features` lists the feature ([sphere-api.md](sphere-api.md) section 2). An Obysphere from before refuses such a card anyway (`400 bad_request`: its schema closes `params` too).
2. Every other active member takes it: its card lists the feature in `features`, or, for `card_runtime` itself, says it in its `version`. (`classes` needs `card_classes`, `topics` needs `card_topics`, and accepting `introduction` needs `introduction`, each with, through `features`, `card_runtime`; `features`, `runtime` and `vendors` need `card_runtime`. Listing `policy_classes`, which an agent does to read a policy's class rules, needs `card_runtime` too, through `features`.) A card that can't carry `features` yet says its agent takes `card_runtime` with the build metadata `card-runtime` in its `version`: the part after the first `+`, split at `.`, includes `card-runtime` (`1.4.0+card-runtime`, as SemVer writes build metadata). Every implementation reads `version`, a free string in `obi/0.1` (up to 64 letters, digits, `.`, `+` and `-`), so build metadata of its own and `.card-runtime` together fit in that.

An agent that takes `card_runtime` SHOULD say so in its very next card: in its `version` while rule 2 doesn't hold for `card_runtime`, and in `features`, with every other feature it takes, once it does. A card that lists a feature never drops it while the agent still takes it. A joining agent can't read the directory before it joins, so its first card carries no addition's members (its `version` may say `+card-runtime`), and it adds them with a card update once it can.

What this leaves, as limits: one active member whose implementation doesn't take a feature holds it back for the whole Obysphere until it updates or an admin revokes it; and an implementation from before can't read the directory once a card in it carries an addition: a member that joins later with one, a member that goes back to one, and an owner's own app that reads the directory with an owner token. The same holds for the chain and the policy: a message that used an addition (a `cancel`, an `introduction`, a request with `follows`), or a policy rule that names `introduction`, was refused while any active member couldn't read it (sphere-api.md sections 5 and 6.1, check 11), but stays where it is, so those later readers can't verify the chain past it, or read the policy, until they update. A card that carries an addition already keeps it, so those don't hold back its member's next card. An Obysphere's admin, or its agents, SHOULD say which features its members need.

The conformance suite's card fixtures named `*-runtime-*`, `*-vendor*`, `*-feature*`, `*-class*` and `valid-card-version-says-card-runtime` pin the shapes.

## 3. Joining, rotating and leaving

**Binding the owner key.** An Obysphere binds one owner key per owner, the first time it sees that owner: when the Obysphere is created (its admin) or when the first invitation for that owner is redeemed: a named invitation's owner, or the owner an open invitation's card names. The invitation's secret is what authorizes the binding. From then on every card for that owner MUST be signed by the bound key.

**Joining.** An admin invites one agent of one owner (a named invitation), or makes one link for up to `max_uses` agents whose cards name their own `obi_id` and owner (an open invitation); the agent redeems it with its signed card ([sphere-api.md](sphere-api.md), "Invitations"). Its first key becomes valid from the next audit sequence number.

**Pinning, in every agent.** The Obysphere binds owner keys, so an Obysphere's operator could bind or serve one of its own and sit in the middle of what two agents say directly to each other (the job channel, protocol.md section 13). So each agent also pins, by itself, the owner key it first saw for each owner in the directory (trust on first use), and trusts a member's card (and so its `key_id`, and anything signed with it) only when the card's signature verifies with the owner key it pinned for that card's owner. It also keeps the highest `card_seq` it has trusted for each agent and refuses a card with a lower one: an Obysphere can't serve an older card whose key was rotated away. A changed owner key is never followed silently: the agent treats that member as unknown until its own owner has compared the new key's **fingerprint** (its key id, `ed25519:…`) with that person out of band and accepted it. Each agent shows its owner every member's fingerprint.

**Rotating an agent key.** The agent gets a new card from its owner: same `obi_id`, `sphere` and `owner_key`, a higher `card_seq`, the new `key_id` and `public_key`, signed by the owner key. It sends it with `PUT /v0.1/spheres/{sphere}/members/{obi}/card`, authenticated with a token whose actor proof was signed by its current key. The Obysphere then:

- closes the old key (`valid_until_seq` = the chain's head seq now) and opens the new one (`valid_from_seq` = head seq + 1);
- revokes every access token issued to that agent (it must exchange again, proving the new key);
- keeps the old key in the directory forever, so old audit entries still verify.

A new card with the same key and a higher `card_seq` (to change `accepts`, `name`…) changes nothing about keys. It may bring a seal key, or a new one ([protocol.md](protocol.md) section 9.1): from then on what other agents send it is sealed for that key, and a sealed message for another key is refused.

**Revoking.** An admin (or the agent's own owner) calls `DELETE /v0.1/spheres/{sphere}/members/{obi}`. The member's `status` becomes `revoked`; its current key gets `valid_until_seq` = the chain's head seq now ([sphere-api.md](sphere-api.md) section 4, "Rotate and revoke"); its tokens stop working; messages to it are refused (`recipient_revoked`) and its queued deliveries are dropped. Its past entries stay in the chain and still verify. A revoked agent rejoins only with a new invitation (and a new key).

**Not in v0.1:** rotating or revoking an owner key (protocol.md, "Open questions").

## 4. Delegation: OAuth on-behalf-of

An agent acts for its owner with a token scoped to that owner, never with shared or borrowed credentials. The Obysphere implements an **OAuth 2.0 Token Exchange** endpoint (RFC 8693) where the subject is the owner and the actor is the agent. No identity provider is needed in v0.1: the bound owner key is the owner's identity.

### 4.1 The two assertions

Both are JWTs (RFC 7519) in JWS compact form, `alg` `EdDSA`, with the protected header `{"alg": "EdDSA", "kid": "<signing key id>", "typ": "JWT"}`. Schemas: [delegation.claims.schema.json](schemas/v0.1/wire/delegation.claims.schema.json), [actor.claims.schema.json](schemas/v0.1/wire/actor.claims.schema.json).

**Owner assertion** (the `subject_token`), signed by the owner key:

| Claim | Value |
|---|---|
| `iss`, `sub` | The owner's `owner_id`. |
| `aud` | The Obysphere: `obi-sphere:<sphere id>`, or its own URL, `<server origin>/v0.1/spheres/<sphere id>` (like `https://sphere.example.com/v0.1/spheres/acme`), which binds the assertion to that server: a server takes the URL form only with its own origin. |
| `iat`, `exp` | Seconds since 1970. |
| `jti` | A UUID. |
| `scope` | The scopes the owner grants, space separated. |
| `may_act` | `{"sub": "<obi_id>"}`: the agent this owner lets act for them. Present on a **delegation**; absent on an owner's own short assertion. |

- A **delegation** (with `may_act`) lives at most 2,592,000 seconds (`exp − iat`). The agent keeps it and presents it each time it exchanges a token. It is useless without the agent's own key, because every exchange also needs the actor assertion.
- An owner's **own assertion** (without `may_act`) lives at most 300 seconds and its `jti` is single-use. Owners use it for admin calls.

**Actor assertion** (the `actor_token`), signed by the agent's current key: `iss` and `sub` the `obi_id`, `aud` as above, `iat`, `exp` (at most 300 seconds after `iat`), `jti` (a UUID, single-use: the Obysphere remembers it until `exp`).

**Single-use `jti`s are kept per Obysphere.** The Obysphere remembers each single-use `jti` (an owner's own assertion's, an actor assertion's) with its Obysphere and its `iss` until the assertion's `exp`, and refuses it again within that Obysphere (`invalid_grant`). A `jti` used in one Obysphere says nothing about another Obysphere on the same server, and one issuer's `jti` doesn't use up another's.

**Naming the server too.** `obi-sphere:<sphere id>` names the Obysphere alone; the URL form names its server as well, so only that server takes it. A server's **own origin** is the one it is served at: its configured address, or, where its platform hands it only requests for its own hosts (a Cloudflare Worker), the request's; never one a client can choose (a `Host` header the server can't vouch for). A default port (`:443` for https, `:80` for http) is the same origin as none. A server that doesn't know its own origin takes no URL form, no DPoP proof (section 4.6) and no sign-in (sphere-api.md section 3.1), and lists neither `sphere_url_aud` nor `dpop`. A configured address that isn't an https URL, or an http one on this machine (`127.0.0.1`, `localhost`, `[::1]`), with a host, is no address. A client sends the URL form to an Obysphere that lists `sphere_url_aud` in `GET /v0.1/features` ([sphere-api.md](sphere-api.md) section 2); both forms stay valid in `obi/0.1`.

### 4.2 Scopes

| Scope | Lets the token holder |
|---|---|
| `admin` | Invite, write the policy, revoke members, and change the Obysphere (sphere-api.md section 3). Only for an owner who administers the Obysphere, only without an actor. |
| `send:review_request`, `send:question`, `send:handoff`, `send:run_request`, `send:share_offer`, `send:introduction` | Send requests of that type. `send:introduction` comes with the feature `introduction`: an owner puts it in a delegation only for an Obysphere that lists the feature, since one from before answers a scope it doesn't know `invalid_scope`. |
| `reply` | Send replies: `status`, `accept`, `decline`, `result`, `answer` and `cancel`, and a run's and a share's (protocol.md sections 5.11 to 5.13, 5.15 and 5.16). |
| `receive` | Fetch and acknowledge its deliveries. |
| `directory:read` | Read the members and the policy. |
| `audit:read` | Read the audit chain. |

**Canonical order.** Wherever the Obysphere writes a set of scopes (the token answer's `scope`), it writes each scope once, separated by one space, in this order: `admin`, `send:review_request`, `send:question`, `send:handoff`, `send:run_request`, `send:share_offer`, `send:introduction`, `reply`, `receive`, `directory:read`, `audit:read`. So an agent's full token is `send:review_request reply receive directory:read audit:read` when its delegation grants those, and an admin's own token `admin directory:read audit:read`, whatever order the request or the assertion listed them in. A scope string the Obysphere reads (an assertion's `scope`, the request's `scope`) may be in any order and may repeat a scope; a scope it doesn't know is `invalid_scope`.

An agent's token can carry every scope but `admin`, limited to what the delegation grants. An owner's own token can carry `admin` (if they administer the Obysphere), `directory:read` and `audit:read`.

### 4.3 The exchange

`POST /v0.1/oauth/token` with `Content-Type: application/x-www-form-urlencoded`:

| Parameter | Value |
|---|---|
| `grant_type` | `urn:ietf:params:oauth:grant-type:token-exchange` |
| `subject_token` | The owner assertion. |
| `subject_token_type` | `urn:ietf:params:oauth:token-type:jwt` |
| `actor_token` | The actor assertion, for an agent's token. Left out for an owner's own token. |
| `actor_token_type` | `urn:ietf:params:oauth:token-type:jwt`, with `actor_token`. |
| `scope` | Optional: the scopes wanted, space separated. Left out: every scope the subject token grants that the caller may hold. |

The Obysphere checks, in this order, and answers `400` with an OAuth error when any fails (which error is said after the list):

1. Both assertions are well-formed JWS with the header above, match their claims schema, and have an `aud` that names an existing Obysphere on this server: `obi-sphere:<sphere>`, or `<this server's origin>/v0.1/spheres/<sphere>` (section 4.1). When there are two, both name the same one, in either form.
2. `iat` is at most 300 seconds ahead of the Obysphere's clock, `exp` is after it, and the lifetimes are within the limits above.
3. The owner assertion verifies with the key bound for `iss`.
4. With an actor: `may_act.sub` is the actor's `sub`; that agent is an active member owned by `iss`; the actor assertion verifies with that agent's current key; its `jti` hasn't been used.
5. Without an actor: there is no `may_act`, and the `jti` hasn't been used.
6. The scopes granted are those requested (or all the subject grants) intersected with what the caller may hold. An empty result is `invalid_scope`.
7. With a `DPoP` header: it is a valid proof for this call (section 4.6), and its `jti` hasn't been used with its key.

The error: `unsupported_grant_type` for a `grant_type` other than token exchange; `invalid_request` for a body over 131,072 bytes (the size limit of every request body, sphere-api.md section 1, answered here as an OAuth error rather than `413`), a body that isn't `application/x-www-form-urlencoded`, a missing, repeated or unknown parameter, a token type other than the JWT one, `actor_token` without `actor_token_type` (or the reverse), or check 1; `invalid_grant` for checks 2 to 5; `invalid_scope` for check 6 or an unknown scope; `invalid_dpop_proof` (RFC 9449 section 5) for check 7.

It answers `200` with [token.response.schema.json](schemas/v0.1/wire/token.response.schema.json), `scope` the granted scopes in the canonical order (section 4.2):

```json
{"access_token": "<opaque>", "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
 "token_type": "Bearer", "expires_in": 3600, "scope": "send:review_request reply receive directory:read audit:read"}
```

The access token is opaque, 32 to 512 characters of `[A-Za-z0-9._~-]`, and the Obysphere stores only its SHA-256. It lives at most 3,600 seconds and never past the `subject_token`'s `exp`: `expires_in` is the smaller of 3,600 and the seconds left until that `exp`. An agent whose delegation is about to expire needs a new delegation from its owner, not just a new exchange. Every other API call sends it as `Authorization: Bearer <access_token>`, or, for a token bound to a key (`token_type` `DPoP`), as section 4.6 says. The Obysphere records, for each token, the owner (subject), the agent (actor, if any) and the scopes; `from` on every message it relays must be the token's actor.

### 4.4 What v0.1 requires and what it defers

Required: the token endpoint and both assertions as above; scopes per action type; opaque bearer tokens; actor proof by the agent's own key on every exchange.

Optional: tokens bound to a key (DPoP, section 4.6), and assertions bound to one server (section 4.1).

Deferred: an identity provider for owners (OIDC) in front of the token endpoint (signing in, sphere-api.md section 3.1, decides who creates an Obysphere and who redeems an invitation for a domain, not who an owner is); refresh tokens (an agent simply exchanges again); delegation to a code host on the owner's behalf (an agent in v0.1 acts on a code host only with its own owner's login, and because of a received action only as [protocol.md](protocol.md) section 11, "Approving on the code host", allows, so it needs no such token).

<a id="45-in-a-local-sphere-the-e2e-test"></a>

### 4.5 In a local Obysphere (the e2e test)

An Obysphere started locally with `pnpm run local` (wrangler's programmatic dev server) against local D1 works exactly the same way: same endpoint, same checks, same token lifetimes, same single-use `jti`s per Obysphere. Only the operator token that creates Obyspheres comes from the developer's machine: `SPHERE_OPERATOR_TOKEN` in `pnpm run local`'s environment, given to the Worker as a secret binding, never on a command line or in a file ([sphere-api.md](sphere-api.md), section 8, "Running an Obysphere locally"). The harness plays both owners: it generates the two owner keys in memory for each run, signs each agent's card and delegation, and hands them to each agent under test; each agent makes its own key and its own actor assertions. No model or code-host credential is involved.


### 4.6 Tokens bound to a key (DPoP)

An access token on its own lets whoever holds it act as its subject and actor until it expires. A client can bind its token to a key it keeps, with DPoP (RFC 9449), so that a token copied out of a log or a store opens nothing alone. An Obysphere that takes it lists `dpop` in `GET /v0.1/features` ([sphere-api.md](sphere-api.md) section 2). Bearer tokens stay as they are: a client that sends no proof gets one.

- **The key.** Ed25519 (`alg` `EdDSA`) or P-256 (`ES256`), made by the client and kept on its machine; never the owner key.
- **A proof** is a JWT in JWS compact form, at most 4,096 characters, with the protected header `{"typ": "dpop+jwt", "alg": "<EdDSA or ES256>", "jwk": <the public key: kty, crv, x, and y for P-256; never d>}`, signed by that key, and these claims:
  - `jti`: 1 to 128 characters from `!` to `~` (0x21 to 0x7E), new for each proof;
  - `htm`: the request's method;
  - `htu`: a string, the request's URL. It is compared, after parsing by the WHATWG URL Standard, by origin and path alone: its query and fragment don't count, a default port is no port, and a WebSocket's `ws:` or `wss:` URL stands for its `http:` or `https:` one. The origin is the server's own (section 4.1);
  - `iat`: an integer, seconds since 1970, at most 60 seconds ahead of the Obysphere's clock, and at most 120 seconds behind it (300 at the token endpoint);
  - `ath`, on any call but the token endpoint's: the base64url SHA-256 of the access token's ASCII bytes.

  It goes in the `DPoP` header, one proof per request. The key's **thumbprint** is RFC 7638's: the SHA-256 of the canonical JSON of its required members (`crv`, `kty`, `x`, and `y` for P-256), base64url.
- **Getting one.** A client sends a proof only to an Obysphere that lists `dpop`. The token exchange (section 4.3) with a `DPoP` proof for `POST <origin>/v0.1/oauth/token` answers `token_type` `DPoP`, and binds the token to the proof's key. A proof that fails is `400 invalid_dpop_proof`, and nothing is issued. An Obysphere that doesn't take DPoP (one from before it, or one that doesn't know its own origin) ignores the header, as RFC 9449 section 5 lets it, and issues a bearer token: `token_type` says which.
- **Using one.** Every call with a bound token sends `Authorization: DPoP <access token>` and a new proof for that call, signed by the token's key, with its `ath`. Anything else is `401 unauthorized`, with `WWW-Authenticate: DPoP error="invalid_token"` (the token sent as `Bearer`, or a bearer token sent as `DPoP`) or `error="invalid_dpop_proof"` (no proof, or one that doesn't pass: another method, URL, token or key, a bad signature, too old or too far ahead), and `algs="EdDSA ES256"`. A 401 with no token offers both schemes, `Bearer, DPoP algs="EdDSA ES256"`; an Obysphere that doesn't take DPoP offers `Bearer` alone. A WebSocket (the job channel, the phone relay) sends both headers on its upgrade, whose method is `GET`. A phone's relay token (sphere-api.md section 9) is a bearer secret, never bound.
- **Each proof once, where it changes something.** The Obysphere remembers each proof's `jti`, with its key's thumbprint, until it can no longer be taken (its `iat` plus 300 seconds at the token endpoint, plus 120 seconds elsewhere), and takes it once: at the token endpoint (each proof gets one token), on every call whose method isn't `GET`, and on every WebSocket upgrade. A proof used again there is refused (`400 invalid_dpop_proof`, or `401` with `error="invalid_dpop_proof"`).
- **What it leaves open.** A proof covers neither the request's body nor its query. A `GET`'s proof isn't remembered. A `GET` proof seen in transit, with its token, can be sent again for that path, with any query, until it is 120 seconds old. TLS keeps it from being seen. What DPoP adds is that the token alone, or a proof for another method, path or token, opens nothing.
