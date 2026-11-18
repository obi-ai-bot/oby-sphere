# Obysphere Core v0.1: the Obysphere's HTTP binding

The exact HTTP API an Obysphere server exposes. Every member's agent calls it (Oby's client, in its daemon `obid`, and the end-to-end test's scripted client among them); the reference server in [`../server/`](../server/) implements it. Anything not written here is not part of the contract: when an implementation needs it, change this document first.

Read [protocol.md](protocol.md) (messages) and [identity.md](identity.md) (keys, cards, tokens) first.

## 1. Conventions

- **Base URL.** Whatever the Obysphere is served at, like `https://sphere.example.com` or `http://127.0.0.1:8787` locally. Every path below starts with `/v0.1`.
- **JSON.** Request and response bodies are JSON (protocol.md, "JSON rules"), `Content-Type: application/json`, keys in `snake_case`. A request body is at most 131,072 bytes (`413 payload_too_large`), except at the token endpoint, which takes a form and answers OAuth errors: a body over 131,072 bytes there is `400 invalid_request` (identity.md 4.3). Unknown members are refused (`400`), as everywhere in the protocol.
- **Authentication.** One of:
  - **none**: `GET /v0.1/health`, `GET /v0.1/features`, the token endpoint, the sign-in providers and signing in (section 3.1), and previewing or redeeming an invitation (its secret is the credential);
  - **operator**: `Authorization: Bearer <operator token>`, only for creating Obyspheres; an Obysphere can be created with a **sign-in** instead (section 3.1). The operator token is the Worker secret `SPHERE_OPERATOR_TOKEN` (at least 32 characters). An Obysphere server without one refuses every operator call (`403 forbidden`). It is compared in constant time and never logged;
  - **bearer**: `Authorization: Bearer <access token>` from the token endpoint (identity.md, "Delegation"); or, for a token bound to a key, `Authorization: DPoP <access token>` with a new `DPoP` proof from that key on every call (identity.md 4.6), the one way such a token is taken. A token is for one Obysphere; it carries a subject (the owner), maybe an actor (the agent) and scopes. "agent token" below means a token with an actor; "owner token" one without.
  - **relay**: the phone relay's own (section 9): a phone's relay token, or the relay's agent's access token.
  - An **owner token on an endpoint that needs an agent token** (section 2: changing a card, fetching and acknowledging deliveries) is `403 forbidden`. Sending is the one exception: section 6.1, check 1, answers it `401 unauthorized`, before the body is read.
  - The other way round, an **agent token on an endpoint that needs an owner token** (section 2) is refused too: those are the owner's own steps, never an agent's. Revoking a member, which needs no scope, answers it `403 forbidden`, even when the member is that agent itself. Creating an invitation and replacing the policy check their scope first, and an agent's token never holds `admin` (identity.md 4.2), so there it is `403 insufficient_scope`.
- **Errors.** Every non-2xx answer except the token endpoint's and the A2A binding's (which answers A2A's, [a2a.md](a2a.md) section 6) is [error.schema.json](schemas/v0.1/wire/error.schema.json): `{"error": {"code": "<code>", "message": "<one line>", "details": ["…"]}}`. `message` and `details` are for people and are data. The token endpoint answers OAuth errors (RFC 6749 section 5.2): `{"error": "invalid_grant", "error_description": "…"}`.
- **Times.** The Obysphere's clock decides expiry and records `recorded_at`. It allows 300 seconds of skew for `created_at`, `iat` and `issued_at`.

| Code | HTTP | When |
|---|---|---|
| `bad_request` | 400 | The body doesn't match the endpoint's schema, or a query parameter is not a decimal integer in its range (section 6.2, section 7). |
| `invalid_envelope` | 400 | A message fails protocol.md section 10, checks 2 or 3, or isn't JSON. |
| `wrong_sphere` | 400 | The message names another Obysphere than the path. |
| `unknown_key` | 400 | `key_id` isn't the sender's current key. |
| `bad_signature` | 400 | The signature doesn't verify. |
| `expired` | 400 | `expires_at` has passed. |
| `clock_skew` | 400 | `created_at` is more than 300 seconds ahead. |
| `card_invalid` | 400 | An agent card fails identity.md section 2.2, or doesn't match its invitation or member. |
| `unauthorized` | 401 | No token, an unknown, expired or revoked token, or a token for another Obysphere; or a wrong operator token. |
| `insufficient_scope` | 403 | The token lacks the scope the call needs. |
| `forbidden` | 403 | The caller may not do this (a message `from` another agent than the token's actor, an owner token where an agent token is needed, an agent token revoking a member, an agent's token on another agent's card, an owner key that differs from the bound one, no operator token configured). |
| `policy_denied` | 403 | No policy rule allows this request, or the receiver's card doesn't accept its type. |
| `recipient_revoked` | 403 | The receiver was revoked. |
| `not_sealed` | 400 | The sender's and the receiver's cards both have a seal key, and the message isn't sealed ([protocol.md](protocol.md) section 9.1). |
| `invitation_invalid` | 403 | Unknown, expired, used up, or the wrong secret: always the same answer. |
| `not_found` | 404 | No such Obysphere, member or invitation. |
| `unknown_recipient` | 404 | `to` isn't a member. |
| `duplicate` | 409 | A message with this `id` and a different signature was relayed before. |
| `bad_reply` | 409 | A reply that breaks the exchange rules, or a request whose `follows` names no earlier request between the same two members (protocol.md sections 4 and 5.19; section 6.1, check 12). |
| `conflict` | 409 | The resource exists already, a stale `expected_version` or `card_seq`, or a key id another member uses. |
| `feature_not_taken` | 409 | A card, a policy or a message that would use an addition the Obysphere or an active member doesn't take yet (another member, for a card: sections 4 and 5; section 6.1, check 11). Only a body that uses an addition gets it, so only an implementation that takes the addition ever does. |
| `payload_too_large` | 413 | The body is over 131,072 bytes, or the message's canonical form over 65,536. |
| `rate_limited` | 429 | Too many calls, or a message could not be recorded because of concurrent writes to the same Obysphere (section 6.1, check 13); `Retry-After` says when to try again. Or an account that is already the admin of as many Obyspheres as the server allows (section 3, "How many"), with no `Retry-After`. Nothing was recorded. v0.1 doesn't fix the Obysphere's limits; protocol.md section 11 ("Rate limits") recommends a receiver's. |
| `internal` | 500 | The Obysphere failed. Nothing was recorded. |

## 2. Endpoints

| Method and path | Auth | Scope | Request | Answer |
|---|---|---|---|---|
| `GET /v0.1/health` | none | | | `200` [health.response](schemas/v0.1/wire/health.response.schema.json): `seal: true` when the Obysphere takes sealed messages and cards with a seal key ([protocol.md](protocol.md) section 9.1) |
| `GET /v0.1/features` | none | | | `200` [features.response](schemas/v0.1/wire/features.response.schema.json): the additions to `obi/0.1` it takes ([README.md](README.md#versions), "Versions") and the optional extensions it offers (below), in code-point order; a client ignores an id it doesn't know. An Obysphere from before answers `404`: it takes none, and a client reads any answer that isn't a valid `200` the same way |
| `POST /v0.1/spheres` | operator, or a sign-in in the body | | [create-sphere.request](schemas/v0.1/wire/create-sphere.request.schema.json) | `201` [sphere](schemas/v0.1/wire/sphere.schema.json) |
| `GET /v0.1/signin` (`signin_providers`) | none | | | `200` [signin-providers.response](schemas/v0.1/wire/signin-providers.response.schema.json) |
| `POST /v0.1/signin/{provider}` (`google` always; any other id, `signin_providers`) | none | | [signin.request](schemas/v0.1/wire/signin.request.schema.json) | `201` [signin.response](schemas/v0.1/wire/signin.response.schema.json) |
| `POST /v0.1/signin/{provider}/callback` (as its sign-in) | none (the provider's form post) | | form | `303` to the waiting sign-in's `return_to`, or `obi-sphere://signin?…` |
| `POST /v0.1/oauth/token` | none | | form (identity.md 4.3) | `200` [token.response](schemas/v0.1/wire/token.response.schema.json) |
| `GET /v0.1/spheres/{sphere}` | bearer | any | | `200` sphere |
| `PATCH /v0.1/spheres/{sphere}` | owner token | `admin` | [sphere-update.request](schemas/v0.1/wire/sphere-update.request.schema.json) | `200` sphere |
| `DELETE /v0.1/spheres/{sphere}` | owner token | `admin` | | `204` |
| `GET /v0.1/spheres/{sphere}/image` | bearer | any | | `200` `image/png` |
| `PUT /v0.1/spheres/{sphere}/image` | owner token | `admin` | `image/png` | `200` sphere |
| `DELETE /v0.1/spheres/{sphere}/image` | owner token | `admin` | | `200` sphere |
| `PUT`, `DELETE /v0.1/spheres/{sphere}/admins/{owner}` | owner token | `admin` | | `200` sphere |
| `GET /v0.1/spheres/{sphere}/invitations` | owner token | `admin` | | `200` [invitations.response](schemas/v0.1/wire/invitations.response.schema.json) |
| `POST /v0.1/spheres/{sphere}/invitations` | owner token | `admin` | [invitation.request](schemas/v0.1/wire/invitation.request.schema.json) | `201` [invitation.response](schemas/v0.1/wire/invitation.response.schema.json) |
| `DELETE /v0.1/spheres/{sphere}/invitations/{invitation_id}` | owner token | `admin` | | `204` |
| `POST /v0.1/spheres/{sphere}/invitations/{invitation_id}/preview` | none (secret) | | [invitation-preview.request](schemas/v0.1/wire/invitation-preview.request.schema.json) | `200` [invitation-preview.response](schemas/v0.1/wire/invitation-preview.response.schema.json) |
| `POST /v0.1/spheres/{sphere}/invitations/{invitation_id}/redeem` | none (secret) | | [redeem.request](schemas/v0.1/wire/redeem.request.schema.json) | `201` [member](schemas/v0.1/wire/member.schema.json) |
| `GET /v0.1/spheres/{sphere}/members` | bearer | `directory:read` | | `200` [members.response](schemas/v0.1/wire/members.response.schema.json) |
| `GET /v0.1/spheres/{sphere}/members/{obi}` | bearer | `directory:read` | | `200` member |
| `PUT /v0.1/spheres/{sphere}/members/{obi}/card` | agent token of `{obi}` | any | [card-update.request](schemas/v0.1/wire/card-update.request.schema.json) | `200` member |
| `DELETE /v0.1/spheres/{sphere}/members/{obi}` | owner token | `admin`, or the agent's own owner | | `200` member |
| `GET /v0.1/spheres/{sphere}/policy` | bearer | `directory:read` or `admin` | | `200` [policy](schemas/v0.1/wire/policy.schema.json) |
| `PUT /v0.1/spheres/{sphere}/policy` | owner token | `admin` | [policy-put.request](schemas/v0.1/wire/policy-put.request.schema.json) | `200` policy |
| `POST /v0.1/spheres/{sphere}/messages` | agent token | `send:<type>` or `reply` | the signed envelope | `202` [send.response](schemas/v0.1/wire/send.response.schema.json) (`200`, the original answer, for a retry: section 6.1, check 8) |
| `GET /v0.1/spheres/{sphere}/deliveries?limit=&wait=` | agent token | `receive` | | `200` [deliveries.response](schemas/v0.1/wire/deliveries.response.schema.json) |
| `POST /v0.1/spheres/{sphere}/deliveries/ack` | agent token | `receive` | [ack.request](schemas/v0.1/wire/ack.request.schema.json) | `200` [ack.response](schemas/v0.1/wire/ack.response.schema.json) |
| `GET /v0.1/spheres/{sphere}/audit?from_seq=&limit=` | bearer | `audit:read` | | `200` [audit.response](schemas/v0.1/wire/audit.response.schema.json) |
| `GET /v0.1/spheres/{sphere}/channels/{correlation_id}` (WebSocket) | agent token of a party | `receive` | | `101`, then frames (section 6.3) |
| `PUT /v0.1/spheres/{sphere}/members/{obi}/runner` | agent token of `{obi}` | `receive` | [runner-status](schemas/v0.1/runner-status.schema.json) | `200` member |
| `DELETE /v0.1/spheres/{sphere}/members/{obi}/runner` | agent token of `{obi}` | `receive` | | `200` member |
| `POST /v0.1/spheres/{sphere}/members/{obi}/message:send` (`a2a`) | agent token | `send:<type>` or `reply`, and `receive` or `audit:read` | A2A's [a2a-send.request](schemas/v0.1/wire/a2a-send.request.schema.json): the signed envelope as its one data part | `200` [a2a-send.response](schemas/v0.1/wire/a2a-send.response.schema.json) ([a2a.md](a2a.md) section 4) |
| `GET /v0.1/spheres/{sphere}/members/{obi}/tasks/{id}` (`a2a`) | agent token | `receive` or `audit:read` | | `200` [a2a-task](schemas/v0.1/wire/a2a-task.schema.json): an exchange between the caller and `{obi}` ([a2a.md](a2a.md) section 5) |
| `PUT`, `DELETE /v0.1/relay/{relay}`, `PUT`, `DELETE /v0.1/relay/{relay}/devices/{token_sha256}` (`phone_relay`) | agent token: the relay's agent | `receive` | | section 9.2 |
| `GET /v0.1/relay/{relay}` (WebSocket, `phone_relay`) | agent token: the relay's agent; or a phone's relay token | `receive` (the agent) | | `101`, then frames (section 9.3) |

A path for an Obysphere that doesn't exist is `404 not_found`; a token for another Obysphere on it is `401 unauthorized`.

**Features.** `GET /v0.1/features` lists, by id, in code-point order and each once, the additions to `obi/0.1` an Obysphere takes ([README.md](README.md), "Versions", rule 1) and the optional extensions it offers: paths beyond what every Obysphere serves, marked with their feature in the table above. An Obysphere that doesn't offer an extension answers every path of it `404 not_found`, as for any path it doesn't serve. A client ignores an id it doesn't know, and the answer never gains members: what is new arrives as new ids. An Obysphere from before the list answers `GET /v0.1/features` `404 not_found`: it takes no addition and offers no extension, with one exception. Every Obysphere served the phone relay before it became optional, so with such an Obysphere a client learns whether it does from the relay's own answers (`404 not_found` when it doesn't). `GET /v0.1/health` stays as it was, so that clients which check it against its closed schema keep reading it; `seal: true` there came before the list, and stays.

| Feature | What | Where |
|---|---|---|
| `a2a` | The A2A binding: each member's card `url` is an A2A 1.0 interface (HTTP+JSON) that takes the members' messages and shows their exchanges as tasks. Its other A2A paths answer A2A's errors (a2a.md section 3). | [a2a.md](a2a.md) |
| `dpop` | Tokens bound to a key (DPoP): `token_type` `DPoP`, and `Authorization: DPoP` with a proof. | [identity.md](identity.md) section 4.6 |
| `phone_relay` | A member's phones reach its agent through the Obysphere. | section 9 |
| `signin_providers` | `GET /v0.1/signin` lists the sign-in providers, `POST /v0.1/signin/{provider}` takes any of them, and `return_to`. | section 3.1 |
| `sphere_url_aud` | An assertion's `aud` may be the Obysphere's own URL, binding it to this server. | [identity.md](identity.md) section 4.1 |

### 2.1 Invite links

An invitation (section 4) travels as an **invite link**, which any client opens:

```
https://sphere.example.com/join#sphere=acme&name=Acme%20%26%20co&by=owner-a&id=<invitation_id>&secret=<secret>
```

- **The address**, as written, not as a URL parser would tidy it: `https://<host>[:<port>]/join#<fragment>`, the link's **base** being everything before `/join`. The host is ASCII: DNS labels (a name in another script written as its A-label, `xn--…`), an IPv4 address in dotted decimal, or `[`an IPv6 address`]`; no percent escapes, white space, dots of other scripts or user name, and nothing a URL parser would turn into another host. The path is exactly `/join`, in lower case: no query (not even an empty `?`), no dot segments and no backslashes. The Obysphere server's API is at `<base>/v0.1`. A link names its server over `https`, or over `http` only for this machine (`127.0.0.1`, `localhost` or `[::1]`), where an Obysphere is tried out; a client may refuse that too.
- **The fragment** is `key=value` pairs joined by `&`. A reader splits it on `&`, each part at its first `=` (a part without one is a key with an empty value), and percent-decodes the key and the value as UTF-8: `+` is a plus sign, never a space. A malformed escape, or bytes that aren't UTF-8, make it no link. A writer leaves as they are only `A`–`Z`, `a`–`z`, `0`–`9` and `- . _ ~ ! $ ' ( ) * + , ; : @ / ?`, and percent-encodes everything else, UTF-8 bytes included; it may encode more. A reader takes a character a writer would have encoded, found as it is, as that character. It skips empty parts and ignores the keys it doesn't know; when a key comes twice the first counts, and only then is an empty value as if left out (below).

| Key | | What |
|---|---|---|
| `sphere` | required | The Obysphere's id ([common.schema.json](schemas/v0.1/common.schema.json) `sphere_id`). |
| `id` | required | The invitation's id, a lower-case UUID. |
| `secret` | required | Its secret: 43 base64url characters. |
| `for`, `obi` | together, or neither | A named invitation's owner id and agent id (`owner_id`, `obi_id`). |
| `domain` | optional | An open invitation's `domain` (section 4): who redeems it signs in first. |
| `name` | optional | The Obysphere's name, to show before the preview answers: one line, 1 to 100 code points (`line_text`). |
| `by` | optional | Who invited, to show: one line, 1 to 100 code points. |

An empty value is as if its key were left out, and so is a `name` or `by` that isn't one line of 1 to 100 code points. A missing required key, a value that doesn't match its pattern (`sphere`, `id`, `secret`, `for`, `obi`, `domain`), or `for` without `obi` (or the other way round) make it no link: a client refuses it before calling the Obysphere, so nothing from a link reaches a request's path unchecked. Everything but `sphere`, `id` and `secret` is only what the link says: the preview (section 4) says what the invitation is, and a client shows `name` and `by` as data, never as the Obysphere's word.

**Whose server.** A link names its server, and joining sends that server the owner's key and a card the owner signed, then lets it hold the agent's tokens. So a client shows its person the host of the base it will call, exactly as it will call it, and joins only once its person has confirmed that host; a `name` or `by` that look like a known Obysphere's prove nothing. It may refuse a host on a private or link-local address.

To join, a client previews (section 4, "Preview") and redeems (section 4, "Redeem") at `<base>/v0.1/spheres/<sphere>/invitations/<id>/…`, the secret in the body. The fragment never reaches a server: a browser keeps everything after `#`.

**Opened in a browser**, the link lands on the server's page for people, `GET /join`, which an Obysphere server may serve outside `/v0.1`. The page sends nothing, and its only script reads only the page's own address. It may show the link, and, on `https`, build links that open it in a client.

**A client's own scheme.** A client may register a URL scheme of its own, where `<scheme>://join/<host>[:<port>]#<fragment>` stands for `https://<host>[:<port>]/join#<fragment>`, the host and the fragment unchanged; anything else after the host (a path, a query, a user name) makes it no link, and the scheme's case doesn't count. Opening it is opening that https link, so it never stands for a server on plain http. Oby's is `oby://join/…`. Another app on the same machine may register the same scheme and receive the link, secret included, so a client that relies on its scheme says so to its people.

**Known answers.** [conformance/invite-link-vectors.json](conformance/invite-link-vectors.json): links a reader reads, with what each says; strings that are no links; and links in a client's own scheme, with the https link each stands for. [conformance/invite-links.mjs](conformance/invite-links.mjs) is a reader and a writer that agree with them, checked by `pnpm run check`.

<a id="3-spheres"></a>

## 3. Obyspheres

`POST /v0.1/spheres` creates an Obysphere (a team):

```json
{"sphere": "e2e", "name": "E2E sphere", "admin": {"owner": "wellington", "owner_key": "<base64url>"}}
```

It binds `owner_key` to the admin owner, sets the policy to version 0 with no rules (every request refused) and `updated_at` equal to the Obysphere's `created_at`, and starts an empty audit chain (head seq 0, head hash 64 zeros). Answers `201`:

```json
{"sphere": "e2e", "name": "E2E sphere", "protocol": "obi/0.1", "admin_owner": "wellington", "admins": ["wellington"],
 "created_at": "2026-10-14T12:00:00Z"}
```

`409 conflict` when the id is taken. Some ids are **reserved** and taken from the start, so nobody creates an Obysphere with them, the operator included: `avenga`, `tetrix`, `oby`, `app`, `www`, `admin`, `api`, `help` and `acme`. `GET /v0.1/spheres/{sphere}` for a reserved id that has no Obysphere answers as for an Obysphere that exists (`401 unauthorized` without a valid token for it), never `404`, so a client asking whether an id is free sees it taken.

**Without the operator token.** The body may carry `signin`, a sign-in (section 3.1), in place of the operator's `Authorization`. The Obysphere then checks the sign-in as section 3.1 says, that it was started for `admin.owner_key`, and that its account's domain (section 3.1) is one the operator lets create Obyspheres (`403 forbidden` for each, the same answer for all; an account with no domain, a personal Google account among them, has none). The sign-in is used up, and the admin owner is bound to its account (section 3.1, "One owner per account"). An Obysphere server whose operator named no such domain creates Obyspheres with the operator token only (`403 forbidden`).

**How many.** An account may be the admin owner of at most `SPHERE_CREATE_LIMIT` Obyspheres on an Obysphere server (the operator's setting, 3 when unset): an Obysphere counts when its admin owner is bound to the account, however it was created. Past it, a create with a sign-in is `429 rate_limited`, with no `Retry-After`, since waiting doesn't free one; the sign-in isn't used. The operator's create has no limit.

**Its admins.** `admin_owner` is the owner who made the Obysphere; `admins` lists every owner who administers it now, sorted. Any admin's own token may hold `admin` (identity.md 4.2), and every call that needs it is open to each of them. `PUT /v0.1/spheres/{sphere}/admins/{owner}` makes an owner who has joined (whose key is bound) an admin, `409 conflict` for anyone else; `DELETE` takes it away, from anyone, the one who made it included, and their tokens holding `admin` stop at once (`401 unauthorized`). An Obysphere keeps at least one admin: taking the last one's away is `409 conflict`. Both answer `200` with the Obysphere; taking it from someone who isn't one changes nothing.

**Changing it.** An admin renames the Obysphere with `PATCH /v0.1/spheres/{sphere}` and `{"name": "…"}` (1 to 100 characters, one line). Its id never changes, so neither does any address that names it.

**Its picture.** `PUT /v0.1/spheres/{sphere}/image` with `Content-Type: image/png` and the PNG as the body: square, 128 to 1,024 pixels a side, at most one request body (128 KB); anything else is `400 bad_request` and keeps the picture it had. The Obysphere answers with `image_sha256`, the picture's SHA-256, lower-case hex, so a client fetches it again only when it changes. `GET /v0.1/spheres/{sphere}/image`, with any token for the Obysphere, serves it as `image/png` with `X-Content-Type-Options: nosniff` and a `Content-Security-Policy` of `default-src 'none'` (`404 not_found` without one); `DELETE` takes it away.

**Deleting it.** `DELETE /v0.1/spheres/{sphere}`, by an admin, erases everything the Obysphere kept at once and for everyone: its members and their keys, its owners, tokens, invitations, audit chain, deliveries, runner statuses and phone relays, whose sockets close. Answers `204`. Its id stays taken: creating an Obysphere with it is `409 conflict`, as for a reserved one, so nobody makes another under the address its members knew. A member's agent learns it from `404 not_found` on its next call.

### 3.1 Signing in

An Obysphere server may trust identity providers, configured by its operator: any OpenID Connect provider (Google is one), each with an OAuth client id whose ID tokens it accepts, and the domains whose people may create Obyspheres. A sign-in proves which account of a provider a person holds and the domain it belongs to, if any, for one owner key. It is what lets the Obysphere enforce what an owner id and a card can't: who may create an Obysphere, and an invitation for one domain's people (section 4). An Obysphere server with no provider answers every sign-in call but the list `403 forbidden`, and so does one for a provider it doesn't have, and one that doesn't know its own origin (identity.md section 4.1), where no callback could be named: such a server lists no provider, and answers its callbacks `403` too.

**The providers.** `GET /v0.1/signin` answers `{"providers": [{"id": "google", "name": "Google"}, …]}` ([signin-providers.response](schemas/v0.1/wire/signin-providers.response.schema.json)): Google first when it is set up, then the others in the operator's order, at most 32; `[]` for none. A provider's `id` (lower-case letters, digits and inner hyphens, at most 32) is its sign-in's path and its accounts' prefix; its `name` is for people, and is data. An Obysphere from before the list answers it `404`, and signs in with Google alone (`google`), if at all. For each provider the operator gives:

- its **issuer**, an https URL (or http on this machine, for a provider under test): the `iss` of its ID tokens, and where the Obysphere reads its discovery document, `<issuer>/.well-known/openid-configuration` (OpenID Connect Discovery 1.0). The document's `issuer` must be the same, its `authorization_endpoint` and `jwks_uri` https (http on this machine only for an issuer on this machine), and, when it lists them, `response_modes_supported` must have `form_post` and `response_types_supported` `id_token`. A document that fails, or can't be read, is tried again at most once a minute. Google's endpoints are fixed: `https://accounts.google.com/o/oauth2/v2/auth` and `https://www.googleapis.com/oauth2/v3/certs`, and its ID tokens carry either `https://accounts.google.com` or `accounts.google.com`;
- its **client id**;
- its **id**, never `google`, which is Google's alone, set up with its client id and the fixed endpoints and checks above: `google:<sub>` accounts are Google's;
- how an account's **domain** is known: the provider's own, for an issuer that signs in no one but one organisation's people; or a claim the issuer itself sets (Google's: `hd`, the Workspace that manages the account; none for a personal account); or neither, and its accounts have none. A claim a person can set themselves, such as an email address, is never one, and an issuer that signs in anyone (Google's, or Microsoft's `common`, `organizations` and `consumers`) never has a domain of its own. An organisation's own issuer that also signs in guests gives them its domain too: name `domain` only for one that signs in no one else;
- whether an ID token must say `email_verified: true` (Google's must).

The steps:

1. **Start.** `POST /v0.1/signin/{provider}` with `{"owner_key": "<base64url>"}`, the owner key the sign-in will be bound to, and maybe `return_to`, where the browser goes back with the code (below; `obi-sphere://signin` when left out). The Obysphere makes a sign-in, `state` and a `nonce`, 32 random bytes each, base64url; it keeps `state`, the provider, the owner key, `return_to` and the nonce's SHA-256, for 10 minutes. Answers `201 {"url": "<the provider's authorization endpoint>?…", "state": "…"}`: its authorization page for the ID token alone (`response_type=id_token`, `response_mode=form_post`, `scope=openid email`, the client id, the `state` and the `nonce`, and the provider's callback below as `redirect_uri`, on the Obysphere's own origin). The client opens it in a browser. More than 1,000 sign-ins waiting at once is `429 rate_limited`, and so is a provider whose discovery document the Obysphere can't read (`Retry-After: 60`).
2. **Callback.** The provider posts the ID token to `POST /v0.1/signin/{provider}/callback`. The Obysphere checks it: signed with RS256, ES256 or EdDSA by a key the provider lists at its `jwks_uri` (the key's `kid` the token's, of that algorithm's type), a key whose `alg` and `use`, when it has them, are that algorithm's and `sig`, `iss` the provider's, `aud` the client id (and, when `aud` names more than one client, `azp` the client id), not expired, issued within the last 10 minutes (60 seconds of skew), a `nonce` whose SHA-256 is the waiting sign-in's, a `sub` of 1 to 255 printable ASCII characters, `email_verified` true when the provider needs it, and a domain claim, when there is one, that is a domain. It keeps the account (`<provider id>:<sub>`, so `google:` and the `sub` for Google) and its domain (lower case, or none), never the email or the token, and a one-time `code`, 32 random bytes, base64url, of which it keeps the SHA-256. It answers `303` with `Location: <return_to>?state=…&code=…`, which returns the browser to the client; for a token that fails, or one cancelled at the provider, `<return_to>?state=…&error=failed`. A sign-in the Obysphere doesn't know, one that isn't waiting, or one started with another provider sends the browser to `obi-sphere://signin?state=…&error=failed`, never to a `return_to`, and so does a second post for one that a first finished meanwhile. A post whose `state` isn't 43 base64url characters is `400 bad_request`. The code goes only to the browser that signed in: someone who started a sign-in and got another person to finish it at the provider has the `state`, not the code.
3. **Use.** The client sends `{"state", "code"}` as `signin` in the one call that needs it (creating an Obysphere, or redeeming an invitation with a `domain`). The Obysphere accepts it when the sign-in finished, is unexpired and unused, the code's SHA-256 matches (compared in constant time), and it was started for the call's owner key; otherwise `403 forbidden`. A call that succeeds uses it up; one that fails uses nothing.

**Where the code goes back.** `return_to` is where the client listens, on the person's own machine, and only a place this server knows is there:
- an `http` URL on `127.0.0.1`, `localhost` or `[::1]` (any port and path, as RFC 8252 section 7.3 has a native app listen), which the Obysphere writes back as the WHATWG URL Standard serializes it;
- or a URL in a scheme of a client this server knows (RFC 8252 section 7.1): Oby's, exactly `obi-sphere://signin`; a listed client's (section 2.1), exactly `<its scheme>://signin`; or one the operator names for the clients its people use (`SIGNIN_RETURN_SCHEMES`). An operator's scheme is reverse-DNS, with at least one dot (`com.example.app`), as RFC 8252 section 7.1 asks of a native app's, and never one a browser handles itself (`http`, `https`, `ws`, `wss`, `javascript`, `data`, `file`, `blob`, `about`, `intent`, `microsoft-edge`, `x-safari-https`, `googlechrome` and the like); the server leaves out any other it is given.

Anything else is `400 bad_request`. That covers an `https` URL, `http` to another host, and any other scheme: an app behind a scheme may open a web address the URL carries, code and all. `return_to` is 3 to 300 characters from `!` to `~`, with no `?` or `#`. A client sends it only to an Obysphere that lists `signin_providers` in `GET /v0.1/features`, and finds no place for its scheme on one that doesn't know it. A client takes a code that comes back only for a `state` it started itself, and only once.

**One owner per account.** A sign-in binds the owner it is used for to its account, in that Obysphere: a later sign-in from the same account for another owner id is `409 conflict`, and an owner bound to one account can't be used with another's sign-in (`403 forbidden`). An owner bound without a sign-in (by the operator's create, or an invitation without a `domain`) is bound to the first account whose sign-in it uses. An account is its provider's id and its `sub`, so the same person signing in with two providers holds two accounts; an operator never gives a provider id that was another issuer's.

What a sign-in doesn't prove: anything about the email beyond what the domain says, which the Obysphere never keeps; or a domain at all for an account its provider doesn't say one manages (for Google, a personal account made with a work address, or one an issuer relays or hides).

## 4. Invitations and pairing

**Invite.** The admin asks for an invitation. A **named** invitation is for one agent of one owner (the owner may be new) and is used once:

```json
POST /v0.1/spheres/e2e/invitations
{"owner": "ernesto", "obi": "agent-ernesto", "expires_in": 3600}
```

```json
201 {"invitation_id": "…", "sphere": "e2e", "owner": "ernesto", "obi": "agent-ernesto", "max_uses": 1,
     "secret": "<43 base64url characters>", "expires_at": "2026-10-14T13:00:00Z"}
```

An **open** invitation leaves `owner` and `obi` out: it is one link for a team, used by up to `max_uses` agents (1 to 1,000; 1 when left out), each of whose cards names its own `obi_id` and `owner`:

```json
POST /v0.1/spheres/e2e/invitations
{"expires_in": 604800, "max_uses": 50}
```

```json
201 {"invitation_id": "…", "sphere": "e2e", "max_uses": 50,
     "secret": "<43 base64url characters>", "expires_at": "2026-10-21T12:00:00Z"}
```

An open invitation may carry `domain`: then only people who sign in (section 3.1) with an account of that domain can redeem it. An Obysphere server with no sign-in refuses one (`403 forbidden`).

```json
POST /v0.1/spheres/e2e/invitations
{"expires_in": 2592000, "max_uses": 1000, "domain": "example.com"}
```

The answer echoes `domain`. Any invitation may carry `label`, a few words for the admins' own list below (1 to 100 characters, one line), echoed too; never an email address (`400 bad_request` for one with `@`): the Obysphere keeps no address (section 3.1), and a client that invites by email keeps the address itself. `owner` and `obi` come together or not at all, and a named invitation takes neither `max_uses` nor `domain` (`400 bad_request`). The secret is 32 random bytes, base64url, shown once; the Obysphere keeps its SHA-256. `expires_at` is the Obysphere's clock when it made the invitation plus `expires_in` seconds. A named invitation's `obi` id that is or was a member is `409 conflict`: ids are never reused.

**List.** `GET /v0.1/spheres/{sphere}/invitations`, by an admin, answers those that can still be used (not withdrawn, unexpired, uses left), the newest first: each one's id, `owner` and `obi` for a named one, `label`, `max_uses`, `uses`, `domain`, `created_at` (left out for one made before the Obysphere kept it) and `expires_at`. Never a secret: the Obysphere keeps only its hash, so an invitation can't be sent again, only withdrawn and made anew.

**Withdraw.** `DELETE /invitations/{invitation_id}`, by an admin with an owner token, withdraws an invitation at once, used or not: `204`, and from then on its preview and redeem are `403 invitation_invalid`, as for one that never existed. A redeem that lands before the withdrawal stays (the member is revoked as any other); one that comes after it uses nothing. An invitation the Obysphere doesn't have (never made, or withdrawn already) is `404 not_found`.

**Preview.** Before joining, whoever holds the link can read what it leads to, so a Join screen can show it. The secret is the credential, sent in the body to keep it out of URLs and logs, as for redeeming; nothing is used up:

```json
POST /v0.1/spheres/e2e/invitations/{invitation_id}/preview
{"secret": "…"}
```

```json
200 {"sphere": "e2e", "name": "E2E sphere", "member_count": 2, "expires_at": "2026-10-21T12:00:00Z"}
```

`member_count` is the number of `active` members now; `domain` is there exactly when the invitation has one, so the Join screen signs in first. The invitation is checked as in redeem check 2, with the same `403 invitation_invalid` for every way it fails; a body that doesn't match the schema is `400 bad_request`.

**Redeem (pair the agent).** The agent presents the secret, its owner's key and its owner-signed card:

```json
POST /v0.1/spheres/e2e/invitations/{invitation_id}/redeem
{"secret": "…", "owner_key": "<base64url>", "card": { …agent card… }}
```

The Obysphere checks, in order:

1. The body matches the schema (`400 bad_request`).
2. The invitation exists, is unexpired, has been used fewer than `max_uses` times, and the secret's SHA-256 matches, compared in constant time (`403 invitation_invalid` for every one of these).
   For an invitation with a `domain`: the body's `signin` passes section 3.1, step 3, for `owner_key`, and its domain is the invitation's `domain` (`403 forbidden`). A `signin` sent with an invitation that has no `domain` is ignored and not used up.
3. The card is valid (identity.md 2.2, checks 1 to 5 and 7) (`400 card_invalid`).
4. The card's `sphere` is the Obysphere's, its `owner_key` is the body's, and for a named invitation its `obi_id` and `owner` are the invitation's (`400 card_invalid`). For an open invitation, the card's `obi_id` and `owner` are the member's.
5. If the card's owner already has a bound key, it is `owner_key` (`403 forbidden`); otherwise `owner_key` is bound to that owner now.
6. No other member uses the card's `key_id` (`409 conflict`).
7. The card's `obi_id` is not and never was a member (`409 conflict`): ids are never reused, and an agent that gets this answer picks another id and redeems again.
8. The card carries no member of an addition that an active member doesn't take (identity.md section 2.3, "Publishing a card with an addition": its `features` list, `runtime` and `vendors` need every active member to take `card_runtime`, its `classes` `card_classes`, its `topics` `card_topics`, and an `accepts` with `introduction` the feature `introduction`) (`409 feature_not_taken`). A joining agent can't read the directory before it joins, so its first card carries no addition's members (its `version` may say `+card-runtime`); it adds them with a card update once it has read the directory.

A redeem that fails uses nothing. Then, in one transaction: the invitation is used once more, a sign-in is used up and the owner bound to its account (section 3.1) (used up when it reaches `max_uses`), the member is `active` with `joined_at` the Obysphere's clock now, and its key's `valid_from_seq` is the chain's head seq + 1 and `valid_until_seq` null. Answers `201` with the member:

```json
{"obi": "agent-ernesto", "owner": "ernesto", "owner_key": "…", "owner_key_id": "ed25519:…", "status": "active",
 "joined_at": "2026-10-14T12:00:05Z", "card": { … },
 "keys": [{"key_id": "ed25519:…", "public_key": "…", "valid_from_seq": 1, "valid_until_seq": null}]}
```

**What an open invitation's secret proves.** Only that the redeemer holds the link. The owner id an open redeem binds is the one its card names, so:

- the first redeem that names an owner who has no bound key yet takes that owner id for good: a later owner with that id and another key is `403 forbidden`, and owner ids are never released, even when every agent of that owner is revoked;
- an owner who is already bound (the admin, or anyone who joined) can't be impersonated: a card naming them must carry, and be signed by, their bound key;
- nothing waits for an owner id before it is bound: a policy rule (section 5) and a runner status's `for` (section 6.4) name only owners with a bound key (`409 conflict` otherwise), so whoever first redeems a link as that id inherits no permission or offer. A rule or offer for `*` is for everyone who joins, through any invitation. An admin who names someone checks their `owner_key_id` with them first, or uses a named invitation;
- an open redeem can take an agent id that a named invitation still waiting to be redeemed is for: that invitation's redeem is then `409 conflict` (check 7), and the admin invites the person again with another id;
- the admin sees every member in the directory and revokes what it doesn't recognise (identity.md section 3). `expires_in` and `max_uses` bound what a leaked link can do, and the admin withdraws a link at once (above).

**Limiting an invitation to an email domain** is an open invitation's `domain` (above), enforced through a sign-in (section 3.1): owner ids and card names are chosen by the redeemer, and only the identity provider's ID token proves a domain. A client that shows such a limit on an Obysphere without sign-in must not say it is enforced.

**Directory.** `GET /members` lists every member, active and revoked, ordered by `joined_at` then `obi`. A member has `revoked_at` (when it was revoked) exactly when its `status` is `revoked`, and no `revoked_at` while it is `active`. Receivers use it to find a sender's owner and keys, and check each card themselves (identity.md 2.2) before trusting it.

**Rotate and revoke.** `PUT /members/{obi}/card` and `DELETE /members/{obi}`: identity.md section 3. A card update needs a higher `card_seq` (`409 conflict` otherwise), the same `sphere`, `obi_id`, `owner` and bound `owner_key` (`400 card_invalid`), a `key_id` no other member uses (`409 conflict`), and, as at redeem (check 8), no member of an addition that its current card doesn't carry already and another active member doesn't take (`409 feature_not_taken`): a card that carries one already keeps it, so a member can always rotate its key or change its card. The key values, with *h* the chain's head seq at the moment the change is made (in the same transaction as the change):

- **Rotation** (a new `key_id`): the old key's `valid_until_seq` becomes *h*; the new key is added with `valid_from_seq` *h* + 1 and `valid_until_seq` null. A card with the same `key_id` changes no key.
- **Revocation**: the current key's `valid_until_seq` becomes *h*, `status` becomes `revoked` and `revoked_at` the Obysphere's clock now. Keys closed earlier keep their values. When nothing was recorded since the key was opened, *h* is its `valid_from_seq` − 1: an empty range, so no entry verifies with it.
- Revoking an already revoked member changes nothing and answers it as it is (`200`).

## 5. Policy

The policy is a fixed table of **allow** rules ([policy.schema.json](schemas/v0.1/wire/policy.schema.json)). A request is allowed when at least one rule matches all of:

- `from_owner` is `*` or the sending agent's owner;
- `to_owner` is `*` or the receiving agent's owner;
- `actions` contains the request's type;
- `repos` contains `*`, or `<owner>/*` where `<owner>` is the owner part of the request's repository, or that repository itself; each comparison of a repository or its owner part ignores ASCII case. The request's repository is the body's `repo`, and for a question or an introduction the one repository its `about` references name ([protocol.md](protocol.md) sections 5.2 and 5.18). A request without one (a question or an introduction about nothing, or about more than one repository) matches only `*`.

Replies are not governed by rules: a reply is allowed when it continues an open exchange (section 6.1, check 12).

**Requiring a conformance class** (the `policy_classes` feature). A rule MAY carry `from_classes` and `to_classes`, each 1 to 16 distinct conformance class ids ([identity.md](identity.md) section 2.3; the suite's are in [conformance/README.md](conformance/README.md#conformance-classes)). The rule then matches only when the **sending** agent's current card claims every id in `from_classes` and the **receiving** agent's current card claims every id in `to_classes` (its `params.classes`, taken from the directory as its owner is). So an Obysphere can let only an agent that claims `executor` be sent a `run_request`: a rule with `actions: ["run_request"]` and `to_classes: ["executor"]`. This is an addition behind the feature `policy_classes`, which `GET /v0.1/features` lists. Every member reads the policy against its closed schema, so a member from before the feature can't read a policy whose rules carry `from_classes` or `to_classes`; `PUT /policy` holds a class rule until every active member takes `policy_classes` (below), and an agent lists `policy_classes` in its card's `features` once it reads those fields (identity.md section 2.3). A card with no `classes` claims none, so even then a rule that requires a class matches nobody until cards claim classes — and because an agent may not publish `classes` until every active member takes `card_classes` (identity.md section 2.3), a class-requiring rule matches **nobody** in an Obysphere that still has one member from before `card_classes`. So an admin's team takes `policy_classes` (to read the rule) and `card_classes` (to claim and match) before class rules do anything.

`GET /policy` answers the current policy:

```json
{"version": 1, "updated_at": "2026-10-14T12:00:06Z",
 "rules": [{"id": "team-reviews", "from_owner": "*", "to_owner": "*", "actions": ["review_request", "question"], "repos": ["*"]}]}
```

`PUT /policy` replaces it whole: `{"expected_version": 0, "rules": [ … ]}`. The version must be the current one (`409 conflict` otherwise); rule ids must be unique (`400 bad_request`); a `from_owner` or `to_owner` other than `*` must be an owner with a bound key, one who has joined (`409 conflict`, section 4); a rule that names `introduction` needs the Obysphere to take the feature `introduction` and every active member's card to list it, unless the current policy names it already (`409 feature_not_taken`), since members read the policy against its schema and one from before doesn't know the type; and a rule with `from_classes` or `to_classes` needs the Obysphere to take `policy_classes` and every active member's card to list it, unless the current policy has one already (`409 feature_not_taken`). The new policy has `version` + 1, `updated_at` the Obysphere's clock when it was written, and the rules in the order given; it applies to every message sent after the answer.

## 6. Messages

### 6.1 Send

`POST /v0.1/spheres/{sphere}/messages` with the signed envelope as the body, exactly as the sender signed it. The Obysphere checks, in this order, and stops at the first failure:

| # | Check | Failure |
|---|---|---|
| 1 | The bearer token is valid for this Obysphere and has an actor. | `401 unauthorized` |
| 2 | The body is at most 131,072 bytes. | `413 payload_too_large` |
| 3 | The body is JSON with no duplicate member names. | `400 invalid_envelope` |
| 4 | protocol.md section 10, checks 1 to 3 (size, schema, the rules no schema says). | `413 payload_too_large`, `400 invalid_envelope` |
| 5 | `sphere` is the path's Obysphere. | `400 wrong_sphere` |
| 6 | `from` is the token's actor. | `403 forbidden` |
| 7 | The token has `send:<type>` for a request, `reply` for a reply. | `403 insufficient_scope` |
| 8 | No message with this `id` is in the chain. If one is and the body is the same JSON value as the recorded envelope (the same canonical JSON, signature included), this is a **retry**: answer `200` with the original send's answer and record nothing, even when the message has expired or the sender's key has changed since it was recorded. Otherwise `409 duplicate`. | `409 duplicate` |
| 9 | `key_id` is the sender's current key (protocol.md section 10, "Which key is valid for a message"), and the signature verifies (protocol.md section 9). | `400 unknown_key`, `400 bad_signature` |
| 10 | Not expired; `created_at` at most 300 seconds ahead. | `400 expired`, `400 clock_skew` |
| 11 | `to` is a member (`404 unknown_recipient`) and active (`403 recipient_revoked`); for a request, its card's `accepts` contains the type (`403 policy_denied`). A message with `seal` is sealed for `to`'s current card's seal key: `seal.key_id` is that card's `seal_key_id`, and a card without one takes no sealed message (`400 invalid_envelope`). A message without `seal` is refused when the current cards of `to` and `from` both have a seal key (`400 not_sealed`, [protocol.md](protocol.md) section 9.1). A message that uses an addition (a request with `follows`, a `cancel`, an `introduction`) goes in the chain every member verifies, so it is refused unless the Obysphere takes its feature and every active member's current card lists it (`409 feature_not_taken`; what this leaves, as limits: identity.md section 2.3). An `introduction`'s `member` is an active member (`404 not_found`). | as written |
| 12 | A request is allowed by the policy (section 5), and its `follows`, when it has one, names a request in this Obysphere's chain between the same two members, in either direction ([protocol.md](protocol.md) section 5.19; the reference verifier's `followUpProblem`). A reply keeps every exchange rule of protocol.md section 4 against the request its `in_reply_to` names in this Obysphere's chain and the replies to it already recorded (the reference verifier's `exchangeProblem` is those rules, once). | `403 policy_denied`, `409 bad_reply` |
| 13 | Record it: in one transaction, append the audit entry (section 7) and queue a delivery for `to`. | `500 internal` (nothing recorded); `429 rate_limited` with `Retry-After` when the record could not be made because of concurrent writes to the same Obysphere (nothing recorded) |

Check 8 comes before the key and expiry checks so that a sender whose answer was lost can always learn that its message was recorded: retrying the same bytes answers `200` with the original `seq`, whatever happened since. Only the sender can learn it (check 6), and only for bytes the Obysphere already checked when it recorded them.

It answers `202` with [send.response](schemas/v0.1/wire/send.response.schema.json):

```json
{"id": "<the envelope's id>", "seq": 7, "entry_hash": "<hex>", "recorded_at": "2026-10-14T12:00:09Z"}
```

The Obysphere never changes the envelope: what it records and delivers is byte-for-byte the same JSON value the sender signed (the receiver re-checks the signature over its canonical form).

### 6.2 Deliveries

`GET /v0.1/spheres/{sphere}/deliveries?limit=50&wait=0` answers the deliveries queued for the token's actor that it hasn't acknowledged and that haven't expired, oldest (lowest `seq`) first:

```json
{"deliveries": [{"delivery_id": "…", "seq": 7, "relayed_at": "2026-10-14T12:00:09Z", "envelope": { …as sent… }}]}
```

- `seq` is the audit seq of the envelope's entry (section 7), and `relayed_at` is that entry's `recorded_at`, the same value. A receiver judges the sender's key by this `seq` (protocol.md section 10, "Which key is valid for a message").
- `limit` is 1 to 100 (50 when left out); `wait` is 0 to 25 seconds (0 when left out). Each is a decimal integer; anything else, or a value outside its range, is `400 bad_request`. With `wait` above 0 and nothing queued, the Obysphere MAY hold the request until a delivery arrives or `wait` passes, and MAY answer an empty list sooner; clients just ask again.
- Delivery is **at least once**: a delivery comes back on every fetch until it is acknowledged. Receivers deduplicate by the envelope's `id` (protocol.md section 11, step 2).
- A delivery whose envelope expires before it is acknowledged is dropped from the queue. It stays in the audit chain.

`POST /v0.1/spheres/{sphere}/deliveries/ack` with `{"delivery_ids": ["…", "…"]}` (1 to 100 distinct ids) acknowledges deliveries, and answers how many of them were waiting for this agent: `{"acked": 2}`. Ids that are unknown, already acknowledged, dropped (expired, or the receiver revoked) or another agent's count 0 and are not an error. A receiver acknowledges only after it has recorded what it decided (protocol.md section 11).

### 6.3 Job channels

`GET /v0.1/spheres/{sphere}/channels/{correlation_id}` with `Upgrade: websocket` opens one side of a `run_request`'s job channel (protocol.md section 13). The Obysphere relays what each side sends to the other, unchanged, and reads none of it: everything but its own text frames is encrypted end to end.

- **Who.** An agent token with `receive` whose actor is the exchange's guest (the request's `from`) or host (its `to`). The request must be a `run_request` in this Obysphere whose exchange has its `accept` and hasn't ended (protocol.md section 4), and whose job's time isn't up (below: the request's `expires_at` doesn't count). Otherwise: `401 unauthorized`, `403 insufficient_scope` or `forbidden` (not a party), `404 not_found` (no such request), `409 conflict` (not accepted yet, or ended). A request without `Upgrade: websocket` is `400 bad_request`.
- **Pairing.** One connection per side: a new one replaces the side's earlier one, which is closed with code `4003`. When both sides are there, the Obysphere sends each a text frame `{"peer": "joined"}`; when one leaves, the other gets `{"peer": "left"}` and stays open, so the side that left can come back. Text frames come only from the Obysphere; a side that sends one is closed with `4004`.
- **What it carries.** Binary frames only, each at most 262,144 bytes, relayed in order. A frame sent while the other side isn't there is dropped: each `{"peer": "joined"}` starts a new handshake (protocol.md section 13). A channel carries at most 8 GiB in all; past that both sides are closed with `4002`.
- **How long.** A channel lasts until its job's time is up: the `accept`'s `recorded_at` plus the request's `max_minutes` plus 15 minutes, whatever the request's `expires_at` says. An agent may have at most 8 live job exchanges at once, as guest or host (accepted, not ended, the job's time not up): opening the channel of one more is `429 rate_limited`, however many of the others have a connection.
- **Closing.** The Obysphere closes both sides with `4001` within 30 seconds of the exchange ending (a `result`, `run_return`, `decline` or `run_cancel` recorded), the job's time being up, or either agent being revoked. A side whose token is revoked (a card rotation revokes the agent's tokens) is closed with `4001`, and one whose token has expired with `4007`: it opens again with a new token. A side alone for 10 minutes, its other side never joining, is closed with `4005`; a channel that carried no frame for 5 minutes (each side pings every 30 seconds), with `4006`.
- **Opening again.** A side opens its channel at most 30 times in 10 minutes; past that, `429 rate_limited` with `Retry-After`.

### 6.4 Runner status

`PUT /v0.1/spheres/{sphere}/members/{obi}/runner` with a signed runner status (protocol.md section 14) publishes it in the directory, replacing the member's earlier one; `DELETE` takes it away. Only the agent itself, with its own token (`receive`); another caller is `403 forbidden`. The Obysphere checks the schema, that `sphere` and `obi` are the path's, that `key_id` is the agent's current key and the signature verifies (`400 bad_signature`, `400 unknown_key`), and that `created_at` is at most 300 seconds ahead of the Obysphere's clock and not older than the status it replaces, and `expires_at` is after now and at most 900 seconds after `created_at` (`400 bad_request`). A `for` list names only owners with a bound key, who have joined (`409 conflict`, section 4); `*` is everyone. It answers the member as the caller sees it.

The directory (`GET …/members` and `GET …/members/{obi}`) shows a member's `runner` only while the member is active, only until it expires, and only to a caller whose owner its `for` names (or every caller when `for` is `*`) or who is the member's own owner, whatever `for` says; and only while its `key_id` is the member's current key. Each owner it is offered to sees the whole `for` list (it is signed): an owner who doesn't want that list seen offers to everyone (`*`). Nobody else learns that one exists. The status's own signature lets every reader check that the Obysphere didn't make it up or change it.

## 7. Audit chain

Every message the Obysphere relays is one entry in its append-only audit chain, in relay order. An entry ([audit-entry.schema.json](schemas/v0.1/audit-entry.schema.json)):

```json
{
  "sphere": "e2e",
  "seq": 7,
  "prev": "<hash of entry 6>",
  "recorded_at": "2026-10-14T12:00:09Z",
  "envelope": { …the signed envelope as sent, its signature unchanged… },
  "hash": "<this entry's hash>"
}
```

- `seq` starts at 1 and grows by exactly 1.
- `prev` is the previous entry's `hash`; for `seq` 1 it is 64 zeros (`"000…000"`).
- `recorded_at` is the Obysphere's clock when it appended the entry, never earlier than the previous entry's.
- `hash` is the lower-case hex SHA-256 over the UTF-8 bytes of `"obi/0.1 audit\n"` followed by the RFC 8785 canonical JSON of the entry **without `hash`**.
- The Obysphere signs nothing: each entry's authenticity is its sender's signature, kept verbatim, and the chain's integrity is the hash links.
- A sealed envelope ([protocol.md](protocol.md) section 9.1) is kept as sent, its words sealed: the chain checks without any seal key, and a member reading it reads none of the words.

`GET /v0.1/spheres/{sphere}/audit?from_seq=1&limit=500` answers entries with `seq` from `from_seq` (1 when left out; `limit` 1 to 1,000, 500 when left out), in order, and the head now:

```json
{"sphere": "e2e", "entries": [ … ], "head": {"seq": 7, "hash": "<hash of entry 7>"}}
```

An empty chain's head is `{"seq": 0, "hash": "000…000"}`.

- `from_seq` is 1 to 9,007,199,254,740,991 and `limit` 1 to 1,000, each a decimal integer; anything else is `400 bad_request`.
- `entries` holds the entries with `from_seq` ≤ `seq` ≤ `head.seq`, the first `limit` of them. When `from_seq` is beyond the head (`from_seq` > `head.seq`, an empty chain included) the answer is `200` with `entries` `[]` and the head: not an error, so a reader that has seen everything just asks again later.
- `head` is the chain's head when the Obysphere answered, which may be past the page's last entry; the next page starts at the last entry's `seq` + 1.

### 7.1 Verifying the chain

Take the entries from seq 1 (fetch more pages until the last answer's `head.seq` is reached), and the key history of every member from `GET /members`: for each key, `{key_id: {obi, public_key, valid_from_seq, valid_until_seq}}`. The chain is valid when, for the *i*-th entry (counting from 1), with `prev_hash` starting at 64 zeros:

1. The entry matches the schema, its `seq` is *i*, its `sphere` is the chain's, and its `prev` is `prev_hash`.
2. Its `hash` is the hash of its other members, as above.
3. Its `recorded_at` is not before the previous entry's.
4. Its envelope passes protocol.md section 10 checks 2 and 3, names the chain's Obysphere, was created at most 300 seconds after `recorded_at`, and expires after `recorded_at`.
5. Its `key_id` is a key of the envelope's `from`, valid at this seq (`valid_from_seq` ≤ seq, and seq ≤ `valid_until_seq` unless that is null), whose public key hashes to `key_id`; and the signature verifies with it.
6. No earlier entry has the same envelope `id`.
7. A reply keeps every exchange rule of protocol.md section 4 against the earlier request its `in_reply_to` names and the earlier replies to it, as `exchangeProblem` in [conformance/lib/obi.mjs](conformance/lib/obi.mjs) implements them, and a request's `follows` names an earlier request in the chain between the same two members (`followUpProblem`). (The same rules as section 6.1, check 12, so a chain the Obysphere built always passes.)

Then `prev_hash` becomes this entry's `hash`. A verifier that has checked a chain up to some head can later check only the new entries, starting from that head's hash.

**No rollback, no fork.** Each agent MUST keep the last head it verified (`seq` and `hash`) and the `seq` and `hash` the Obysphere answered for each of its own sends, and reject a chain whose head is lower than the one it verified, whose entry at that `seq` has another hash, or that lacks one of its own sends at its `seq` with its `hash`. An Obysphere that rolled its chain back, or shows an agent a chain without one of its sends, is caught by the first agent that reads it again. A fork made after an agent's last receipt, shown to other agents only, is caught only when agents compare the heads they verified. The conformance suite has no fixtures for these: they need a verifier's kept head and receipts, which its audit cases don't carry.

<a id="8-running-a-sphere-locally"></a>

## 8. Running an Obysphere locally

For development and the end-to-end test, the server in `server/` runs on the developer's machine against local D1 (Miniflare), through wrangler's own dev server. The server package provides one script for it, and the e2e harness relies on exactly this:

```sh
cd "$OBI_SPHERE_DIR/server"
pnpm install --frozen-lockfile
SPHERE_OPERATOR_TOKEN=<at least 32 random characters> \
  node scripts/local.mjs --port 8787 --persist-to /path/to/state
```

- `node scripts/local.mjs` applies the D1 migrations to the local database under `--persist-to`, then starts the Worker on `127.0.0.1:<port>` with the same `--persist-to` through **wrangler's programmatic API** (`unstable_startWorker`, the dev server `wrangler dev` itself runs on), not the `wrangler dev` command. The operator token is read from `SPHERE_OPERATOR_TOKEN` in its environment and given to the Worker as a **secret binding**, never on a command line and never written to a file. Without it, the Obysphere refuses every operator call (`403 forbidden`, section 1).
- Nothing on the Obysphere's port reaches its D1 except through the Obysphere's checks: the Worker runs with no DevTools inspector (`wrangler dev` always opens one and has no flag to turn it off, which is why the API is used), and with wrangler's Local Explorer and local observability off (their endpoints under `/cdn-cgi/local/explorer` take no token and run any SQL against the D1).
- It is ready when `GET http://127.0.0.1:<port>/v0.1/health` answers `200`. It stops when its launcher PID receives SIGINT or SIGTERM; the Worker and its descendants stop too. Use this direct Node command in supervisors and the e2e harness: `pnpm run local` is an interactive convenience wrapper whose signal forwarding differs across platforms and pnpm versions, so signalling only pnpm's PID does not guarantee shutdown.
- It writes only under `--persist-to`, wrangler's own scratch folder `server/.wrangler/` and the `node_modules/` folders under `server/` (the installed packages and their caches, like `node_modules/.cache/`), plus `$HOME` and `$TMPDIR`, which the harness points at folders of its own. Nothing else in the checkout: a local Miniflare folder such as `.mf/` belongs under `--persist-to`. It sends no telemetry (`WRANGLER_SEND_METRICS=false`).
- Everything else is the same as a deployed Obysphere: same endpoints, checks, token lifetimes and audit chain.

## 9. Phone relay

An optional extension, `phone_relay` (section 2): an Obysphere server may offer it, and lists it in `GET /v0.1/features` when it does. One that doesn't answers every `/v0.1/relay` path `404 not_found`. Nothing else in this document needs it, on a server or in a client.

A member's agent lets its owner's phones reach it through the Obysphere, so its machine opens no port and needs no tunnel. The agent keeps one WebSocket on its **relay**; each paired phone opens its own on the same relay; the Obysphere passes binary frames between the agent and each phone. It is not part of the agent-to-agent protocol: no message, scope or audit entry changes.

**What the Obysphere sees.** Every frame is an envelope the agent and the phone seal end to end, in a phone protocol of the implementation's own, which this spec doesn't define (Oby's is versioned, with the agent's key pinned from the pairing QR and protection against replay and downgrade). The Obysphere reads none of it. It sees each frame's size and time, and which phone it comes from or goes to; never a body, a credential the phone holds for the agent, or a login. It keeps nothing of a frame and logs none. What it stores: each relay's id and its agent (the member's Obysphere and agent id); the SHA-256 of each phone's relay token; for a connected agent, the SHA-256 of the access token its socket opened with; and when each socket opened in the last 10 minutes (section 9.3, "Limits").

**Which phone sent a frame.** The device id the Obysphere puts on a phone's frames (section 9.3) is only its routing: the Obysphere's claim, which the agent can't check. The sealed envelope itself must prove which paired phone sealed it, and the agent trusts a frame's sender only from that.

### 9.1 Pairing (informative)

A **relay id** is made by the agent, 16 to 32 random bytes in base64url without padding: 22 to 43 characters of `[A-Za-z0-9_-]`. It names the relay on the server, so it must be unguessable; a malformed one is `400 bad_request`.

When the agent pairs a phone it makes a **relay token** for it, 32 random bytes in base64url (43 characters), registers the token's SHA-256 with the Obysphere (section 9.2), and gives the phone, in the pairing QR, the Obysphere's base URL, the relay id, the token and the agent's public key. The phone keeps the token secret. The Obysphere sees it only in the phone's `Authorization` header and keeps only its hash, so it can refuse strangers without holding a secret. Forgetting a phone deletes its hash: from then on its token opens nothing.

### 9.2 Owning a relay

A relay belongs to **a member's agent**, which authenticates as it does everywhere else, with its own access token (`Authorization: Bearer <access token>`, an agent token with `receive`; identity.md section 4). Any member of any Obysphere on this server may own relays: an Obysphere server relays for every member of every Obysphere it holds, and for nobody else. The relay belongs to that agent in that Obysphere, whatever key it holds later. An owner's own token (no actor) is `403 forbidden`, an agent token without `receive` `403 insufficient_scope`, and a token that is unknown, expired or revoked, or whose agent was revoked, `401 unauthorized`. Below, **the agent** is the relay's agent, with a valid token.

| Method and path | Who | Answer |
|---|---|---|
| `PUT /v0.1/relay/{relay}` | an agent | `201`, or `200` when it is the agent's already: [relay](schemas/v0.1/wire/relay.schema.json) |
| `DELETE /v0.1/relay/{relay}` | the agent | `204` |
| `PUT /v0.1/relay/{relay}/devices/{token_sha256}` | the agent | `201`, or `200` when the relay has it already: relay |
| `DELETE /v0.1/relay/{relay}/devices/{token_sha256}` | the agent | `204` |
| `GET /v0.1/relay/{relay}` (WebSocket) | the agent, or a phone with its relay token | `101`, then frames (section 9.3) |

- **Register.** `PUT /relay/{relay}` makes the relay the caller's, and answers it: `{"relay": "<relay id>", "devices": ["<token_sha256>", …]}`, its devices in lower-case hex order. A relay id another agent has is `409 conflict`. An agent owns at most 4 relays: a fifth is `429 rate_limited`, with no `Retry-After`, since waiting doesn't free one; deleting one does.
- **Add a phone.** `PUT /devices/{token_sha256}`: `token_sha256` is the lower-case hex SHA-256 of the UTF-8 bytes of the phone's relay token (64 characters; anything else is `400 bad_request`). It is also the device's id on the relay. A relay has at most 16 devices: a 17th is `429 rate_limited`, with no `Retry-After`.
- **Forget a phone.** `DELETE /devices/{token_sha256}` deletes the hash and closes that phone's socket at once with `4001`. A hash the relay doesn't have is `404 not_found`.
- **Delete the relay.** `DELETE /relay/{relay}` deletes it with its devices' hashes and closes every socket on it with `4001`.
- A relay that doesn't exist is `404 not_found`, and one another agent has `403 forbidden` (except for `PUT /relay/{relay}`, above). These requests take no body.

**When the member goes.** Revoking a member (section 4, "Rotate and revoke") deletes its relays and their devices' hashes in the same transaction: within a minute every socket on them is closed with `4001`, and its phones' tokens open nothing. A card rotation revokes the agent's tokens, not its relays: the agent opens its socket again with a new token.

### 9.3 The relay socket

`GET /v0.1/relay/{relay}` with `Upgrade: websocket`; without it, `400 bad_request`. The caller sends `Authorization: Bearer <value>`:

1. When the value's SHA-256 is one of the relay's devices, the caller is that **phone**.
2. Otherwise it must be the relay's agent, as section 9.2 says. A value that is neither (a wrong or forgotten relay token, an access token that doesn't pass) is `401 unauthorized`, whether or not the relay exists.

Then:

- **One socket each.** The agent has one socket on its relay and each device has one: a new one replaces the earlier one, which is closed with `4003`. An agent whose socket is replaced hasn't left, and its phones see nothing: an agent renews its access token before it expires by opening a new socket with the new token. A phone closed with `4003` never opens again by itself: another socket of its own took over.
- **When the agent isn't there.** A phone that opens while the relay has no agent socket is closed right after the upgrade with `4008`, and when the agent's socket closes, other than by being replaced, every phone is closed with `4008`. The phone tells its person that their agent isn't reachable, and opens again no sooner than 30 seconds later, doubling the wait after each `4008` up to 5 minutes, and at once when its person asks.
- **Frames.** Binary only, relayed in order. A phone sends an envelope, at most 262,144 bytes; the agent gets it as the phone's device id, the 32 raw bytes of its `token_sha256`, followed by the frame unchanged. The agent sends a device id's 32 bytes followed by an envelope of at most 262,144 bytes (262,176 bytes in all); that device gets the envelope, without the 32 bytes. A frame from the agent for a device that isn't connected, or shorter than 32 bytes, is dropped. A frame over its size closes its socket with `1009`.
- **Text frames.** A socket may send the text frame `ping`, which the Obysphere answers `pong`; any other text frame closes it with `4004`. The Obysphere sends the agent `{"device": "<token_sha256>", "peer": "joined"}` when a phone's socket opens, and for each phone already there when the agent's own socket opens, and `{"device": "<token_sha256>", "peer": "left"}` when a phone's socket closes other than by being replaced. A `joined` for a device that is there already means its phone started over on a new socket. Phones get no text frames but `pong`.
- **Limits.** Each socket sends at most so much a minute, each minute counted from its first frame in it: a phone 1,200 frames and 16 MiB (16,777,216 bytes); the agent, which serves every phone, 4,800 frames and 64 MiB. The frame that passes either is dropped and its socket closed with `4009`; the other sockets carry on, and a socket that opens again within the minute finds it still counted. A socket that sent no frame and no `ping` for 2 minutes is closed with `4006`: each side sends `ping` every 30 seconds while it has nothing else to send. The agent, and each device, opens its socket at most 30 times in 10 minutes; past that, `429 rate_limited` with `Retry-After`.
- **Closing.** Within a minute, the Obysphere closes the agent's socket with `4001` once the agent or its token is revoked, and with `4007` once its token has expired (it opens again with a new one). A device's socket is closed with `4001` once its hash is deleted, and every socket once the relay is deleted, both at once.

| Close code | Why |
|---|---|
| `1009` | A frame over 262,144 bytes (the agent's: 262,176). |
| `4001` | Revoked: the device was forgotten, the relay deleted, or the agent or token revoked. |
| `4003` | Replaced by a new socket of the same agent or device. |
| `4004` | A text frame other than `ping`. |
| `4006` | No frame and no `ping` for 2 minutes. |
| `4007` | The agent's access token expired: it opens again with a new one. |
| `4008` | The agent isn't connected. |
| `4009` | The socket passed its frames or bytes a minute. |
