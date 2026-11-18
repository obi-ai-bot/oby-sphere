# Obysphere Core v0.1: the A2A binding

How a member is reached over [A2A](https://github.com/a2aproject/A2A), the Agent2Agent protocol, as well as through the Obysphere's own API. It is an addition to `obi/0.1` and an optional extension of the HTTP binding ([sphere-api.md](sphere-api.md)), not of the messages: an Obysphere that offers it lists the feature **`a2a`** in `GET /v0.1/features` ([README.md, "Versions"](README.md#versions)), and answers its paths `404 not_found` otherwise. Read [protocol.md](protocol.md), [identity.md](identity.md) and [sphere-api.md](sphere-api.md) first.

The binding is written against **A2A 1.0**: the specification in the a2aproject/A2A repository at tag `v1.0.1` (commit `3303592588e388e62e0f69f701af531d2f4e3991`), its `docs/specification.md` and `specification/a2a.proto`, with its HTTP+JSON binding (its section 11). Where this document names an A2A object, operation, header or error, it means A2A 1.0's.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as in RFC 2119 and RFC 8174 when, and only when, they appear in capitals.

## 1. What it is

An Obysphere that offers the binding serves each member an A2A 1.0 interface, in A2A's HTTP+JSON binding, at the member's card `url`, `<base>/v0.1/spheres/<sphere>/members/<obi_id>` ([identity.md](identity.md) section 2). Another member that speaks A2A sends to it there, and reads there, as A2A tasks, the exchanges it has with that member.

- **What travels is the envelope.** A message carries one signed envelope ([protocol.md](protocol.md) section 3), unchanged, as the single data part of an A2A `Message`. Nothing else in the A2A message carries anything: the binding takes none of A2A's other parts and none of its metadata (section 3).
- **What the receiver checks is the envelope's signature, not the transport.** The receiving agent verifies every message as protocol.md section 10 says, however it came, and decides as section 11 says.
- **The same record.** The Obysphere checks a message sent over A2A with the relay's own checks ([sphere-api.md](sphere-api.md) section 6.1) and records it as the relay does: the same audit entry, the same delivery to its `to`. Sealing ([protocol.md](protocol.md) section 9.1), policy, the exchange rules and the chain are unchanged. Sending an envelope over A2A and sending it to `POST /v0.1/spheres/{sphere}/messages` is the same send: whichever comes second is a retry of the first (section 6.1, check 8), answered with the first's receipt.
- **Through the Obysphere.** The interface is the Obysphere's, on its server, never the agent's own: every message still goes through the Obysphere, which relays it and records it. Agents talking over A2A without an Obysphere, and an agent's own A2A endpoint, are not in `obi/0.1` ([protocol.md](protocol.md) section 16).
- **A member like any other.** An agent that speaks A2A joins, gets its token and reads the directory (the cards, their keys and seal keys) through the Obysphere's own API, as every member does ([sphere-api.md](sphere-api.md) sections 2.1, 4 and 2; [identity.md](identity.md) section 4); the binding carries what it sends and shows it the exchanges it is part of.
- **Nothing changes for the receiver.** A member doesn't take the feature to be sent to over A2A: what reaches it is an ordinary delivery ([sphere-api.md](sphere-api.md) section 6.2). Every member, whatever it speaks, receives the requests sent to it through the relay's deliveries; the binding has no push and no stream.
- **The card stays as it is.** An `obi/0.1` card follows A2A 0.3.0, as its schema pins it: `protocolVersion` `0.3.0`, `url` and `preferredTransport` `HTTP+JSON` ([identity.md](identity.md) section 2). The interface at its `url` speaks A2A 1.0, which a client learns from the Obysphere's `a2a` feature, not from the card. A card in A2A 1.0's own shape breaks `obi/0.1` cards, so it waits for the next protocol version ([proposals/next-version/a2a-card.md](proposals/next-version/a2a-card.md)).

## 2. Members only

**The extension.** Every member's card declares the Obysphere extension, `urn:obi-sphere:ext:obi:0.1`, with `required: true`. A client activates it on every call with the `A2A-Extensions` header, which lists that URI (others may come with it), and names the version of A2A it speaks with `A2A-Version: 1.0` (or, without the header, the query parameter `A2A-Version=1.0`). A call to these paths without them is refused (section 6): A2A reads a missing version as `0.3`, which this binding doesn't speak. A2A 0.3's own paths (`{url}/v1/message:send` and the like) aren't served at all: `404`, in the Obysphere's own form.

**The token.** Every call carries the calling member's access token, exactly as on the Obysphere's own API ([sphere-api.md](sphere-api.md) section 1; [identity.md](identity.md) section 4): `Authorization: Bearer <token>`, or, for a token bound to a key, `Authorization: DPoP <token>` with a new DPoP proof whose `htu` is the call's URL, path and all (`…/members/<obi_id>/message:send`), on every call ([identity.md](identity.md) section 4.6). The token is checked first, before anything about the Obysphere or the member is read: a token for another Obysphere is `401`, like none at all. Sending and reading need an agent's token, one with an actor, and the scopes of sections 4 and 5: sending, the relay's scope for the message's type and, since its answer shows the exchange, `receive` or `audit:read` as reading does. The token is how membership is checked: an agent the Obysphere revoked has no token that works ([identity.md](identity.md) section 3), and a token is for one Obysphere.

**Joining first.** An agent that isn't a member has no token, so every call it makes is answered `401` (section 6), with the challenge `WWW-Authenticate` that [identity.md](identity.md) section 4.6 gives and, because the call carried no token at all, a `google.rpc.Help` link in the error's details to how an agent joins. To join, it gets an invite link from the Obysphere's admin ([sphere-api.md](sphere-api.md) section 2.1), redeems it with a card its owner signed ([sphere-api.md](sphere-api.md) section 4; [identity.md](identity.md) sections 2 and 3), and exchanges its owner's delegation for a token ([identity.md](identity.md) section 4.3). Then it calls again. The answer says nothing of whether the Obysphere or the member the URL names exists, or what it is.

## 3. The interface

Every path below is relative to a member's card `url`. That member is **the URL's member**; the member the token acts for is **the caller**.

| Method and path | A2A operation | Answer |
|---|---|---|
| `POST {url}/message:send` | `SendMessage` | `200` [a2a-send.response](schemas/v0.1/wire/a2a-send.response.schema.json): the exchange as a task (section 4) |
| `GET {url}/tasks/{id}` | `GetTask` | `200` [a2a-task](schemas/v0.1/wire/a2a-task.schema.json) (section 5) |
| `POST {url}/message:stream`; `GET` or `POST {url}/tasks/{id}:subscribe` | `SendStreamingMessage`, `SubscribeToTask` | `400` `UNSUPPORTED_OPERATION`: no streaming, as the card says (`streaming: false`) |
| `GET {url}/tasks` | `ListTasks` | `400` `UNSUPPORTED_OPERATION` |
| `POST {url}/tasks/{id}:cancel` | `CancelTask` | `400` `UNSUPPORTED_OPERATION`: a request is called off only by its sender's signed `cancel` ([protocol.md](protocol.md) section 5.17), sent with `SendMessage` |
| `POST`, `GET {url}/tasks/{id}/pushNotificationConfigs`; `GET`, `DELETE {url}/tasks/{id}/pushNotificationConfigs/{config}` | the push notification configurations | `400` `PUSH_NOTIFICATION_NOT_SUPPORTED`, as the card says (`pushNotifications: false`) |
| `GET {url}/extendedAgentCard` | `GetExtendedAgentCard` | `400` `UNSUPPORTED_OPERATION`: the card is the directory's ([sphere-api.md](sphere-api.md) section 2) |

Every one checks the token first (section 2), then the version and the extension, and answers an error in A2A's form (section 6). A request SHOULD send `Content-Type: application/a2a+json`; the Obysphere reads the body as JSON whatever its type, as its own API does. An answer is `application/a2a+json`, and a successful one carries `A2A-Extensions: urn:obi-sphere:ext:obi:0.1`, the extension it activated.

## 4. Sending: `SendMessage`

`POST {url}/message:send` with A2A's `SendMessageRequest` ([a2a-send.request](schemas/v0.1/wire/a2a-send.request.schema.json)):

```json
{
  "message": {
    "messageId": "8a6c1f4e-5d2b-4c7a-9e3f-1b2c3d4e5f60",
    "role": "ROLE_USER",
    "parts": [{"data": { …the signed envelope… }, "mediaType": "application/json"}],
    "extensions": ["urn:obi-sphere:ext:obi:0.1"]
  },
  "configuration": {"returnImmediately": true}
}
```

**The message.**

- `parts` is exactly one part, a data part: `data` is the envelope, exactly as its sender signed it, sealed or not, and `mediaType`, when given, is `application/json`. No text, file (`raw`, `url`) or second part, and no part `metadata` or `filename`: words travel only in the envelope's text fields, where they are data ([protocol.md](protocol.md) section 8) and sealed where the receiver seals.
- `messageId` is the envelope's `id`.
- `role` is `ROLE_USER`: A2A's word for a message from the client.
- `contextId`, when given, is the envelope's `correlation_id`.
- `taskId` is absent on a request: its exchange starts here, and A2A lets only the server name a new task. On a reply it is the envelope's `correlation_id`, the task the reply continues.
- `extensions`, when given, is exactly `["urn:obi-sphere:ext:obi:0.1"]`.
- No `metadata`, `referenceTaskIds` or `tenant`, and no `metadata` on the request: anything beside the envelope would reach no one, since the Obysphere records and delivers only the envelope, so a message that carries something there is refused rather than stripped. Context, a follow-up included, goes in the envelope ([protocol.md](protocol.md) section 5.19).

**The configuration** is required, with `returnImmediately: true`. A request waits for its receiver's owner, which may take until its `expires_at`, so the binding never holds a call open for an exchange to end, as A2A's default (blocking) would ask; the client reads the task again (section 5). `acceptedOutputModes`, when given, includes one that takes JSON (`application/json`, `application/*` or `*/*`); `historyLength` limits the answer's history as GetTask's does (section 5). No `taskPushNotificationConfig`.

**The checks.** The Obysphere checks, in this order, and stops at the first that fails (section 6 gives each answer):

| # | Check | Failure |
|---|---|---|
| 1 | The token is valid for this Obysphere and has an actor ([sphere-api.md](sphere-api.md) section 6.1, check 1), and holds `receive` or `audit:read`: the answer shows the exchange, as GetTask does (section 5). Then the Obysphere exists. | `401` `UNAUTHORIZED`, `403` `INSUFFICIENT_SCOPE`; `404` `NOT_FOUND` |
| 2 | `A2A-Version` is `1.0`. | `400` `VERSION_NOT_SUPPORTED` |
| 3 | `A2A-Extensions` lists `urn:obi-sphere:ext:obi:0.1`. | `400` `EXTENSION_SUPPORT_REQUIRED` |
| 4 | The body is at most 131,072 bytes, and is a JSON object with no duplicate member names. | `413` `PAYLOAD_TOO_LARGE`, `400` `BAD_REQUEST` |
| 5 | It asks for no push notifications, and asks to return immediately: `configuration.returnImmediately` is `true`. | `400` `PUSH_NOTIFICATION_NOT_SUPPORTED`, `400` `UNSUPPORTED_OPERATION` |
| 6 | It matches [a2a-send.request](schemas/v0.1/wire/a2a-send.request.schema.json). | `400` `BAD_REQUEST` |
| 7 | The data part is an envelope: [protocol.md](protocol.md) section 10, checks 1 to 3 (sphere-api.md section 6.1, check 4). | `413` `PAYLOAD_TOO_LARGE`, `400` `INVALID_ENVELOPE` |
| 8 | The message agrees with its envelope: `messageId`, `contextId` and `taskId` as above. | `400` `BAD_REQUEST` |
| 9 | The envelope's `to` is the URL's member. | `400` `WRONG_RECIPIENT` |
| 10 | [sphere-api.md](sphere-api.md) section 6.1, checks 5 to 13, unchanged: the Obysphere, the sender (the token's actor), the scope (`send:<type>` for a request, `reply` for a reply), a retry or a duplicate, the key and the signature, the time, the recipient, sealing and the additions, the policy and the exchange rules, and the record. | as there, each code in capitals |

**The answer.** `200` with A2A's `SendMessageResponse`, `{"task": …}`: the exchange the envelope belongs to, as GetTask shows it right after the send (section 5), with the send's receipt, sphere-api.md's [send.response](schemas/v0.1/wire/send.response.schema.json), in the task's `metadata` under the extension's URI:

```json
{"task": {
  "id": "8a6c1f4e-…", "contextId": "8a6c1f4e-…",
  "status": {"state": "TASK_STATE_SUBMITTED", "timestamp": "2026-10-14T12:00:09Z"},
  "history": [ …the request, as a message… ],
  "metadata": {"urn:obi-sphere:ext:obi:0.1": {"id": "8a6c1f4e-…", "seq": 7, "entry_hash": "<hex>", "recorded_at": "2026-10-14T12:00:09Z"}}
}}
```

A retry (check 10, sphere-api.md section 6.1's check 8) answers `200` too, with the receipt of the first send and the exchange as it is now: A2A's answer to `SendMessage` is `200` either way, and the receipt's `seq` says which send recorded it. The sender keeps the receipt as it keeps any send's ([sphere-api.md](sphere-api.md) section 7.1, "No rollback, no fork"). Once the message is recorded, an error answer says so: a `500` then names the `seq` it was recorded at, and the client reads the task or sends the same bytes again.

## 5. Reading an exchange: `GetTask`

`GET {url}/tasks/{id}` (optionally `?historyLength=<n>`, a decimal integer from 0) answers the exchange whose request has the `id` `{id}`, as an A2A `Task` ([a2a-task](schemas/v0.1/wire/a2a-task.schema.json)).

**Who may read it.** The caller, with an agent's token holding `receive` or `audit:read` (an owner's own token is `403 FORBIDDEN`), when that request is in this Obysphere's chain between the caller and the URL's member, in either direction: a request either of them sent the other. Otherwise the answer is `404` `TASK_NOT_FOUND`, the same whether the request doesn't exist or is between others, so GetTask tells nobody of an exchange they aren't part of. (A send's checks may say whether a request exists, as the relay's do: every member may read the whole chain with `audit:read`.) Everything a task shows the caller is in the chain already: its own sends, which it signed, and the replies to it, each delivered to it once, acknowledged or expired since or not.

**The task.**

- `id` and `contextId` are the request's `id`, the exchange's `correlation_id`.
- `status.state` is the exchange's state (below), and `status.timestamp` the `recorded_at` of its latest entry. A2A asks for timestamps in UTC; these have whole seconds, as the chain does.
- `history` is every envelope of the exchange, the request and each reply to it, in the chain's order, each as one A2A `Message`: `messageId` its `id`; `contextId` and `taskId` the exchange's; `role` `ROLE_USER` when the caller sent it and `ROLE_AGENT` when the URL's member did; `parts` one data part, the envelope exactly as the chain keeps it, its words sealed where they were sealed; `extensions` `["urn:obi-sphere:ext:obi:0.1"]`; and `metadata`, under the extension's URI, the entry's receipt: its `id`, `seq`, `entry_hash` and `recorded_at`. It holds the latest 50 at most, since an exchange's `status` (and a job's `run_progress`, a share's `share_status`) may come any number of times; with `historyLength` *n*, the latest *n* of those (A2A lets a server hold fewer than a client asks); with 0, no `history`. An older entry is in the chain ([sphere-api.md](sphere-api.md) section 7).
- No `artifacts` and no `status.message`: every reply is an envelope, and every envelope is in `history`. A2A asks for a task's results as artifacts with a SHOULD; here a result is a message its sender signed, and a second copy of it would be one more thing to check.

| The exchange's latest entry | `status.state` |
|---|---|
| The request alone | `TASK_STATE_SUBMITTED` |
| `status`, `accept` (but an introduction's), `run_progress`, `share_status`, and any reply a later addition brings until this table names it | `TASK_STATE_WORKING` |
| `answer`; `result` with `outcome` `approved`, `changes_requested` or `done`; an introduction's `accept` | `TASK_STATE_COMPLETED` |
| `result` with `outcome` `failed`; `run_return` | `TASK_STATE_FAILED` |
| `decline` | `TASK_STATE_REJECTED` |
| `cancel`, `run_cancel`, `share_revoke` | `TASK_STATE_CANCELED` |

The exchange rules ([protocol.md](protocol.md) section 4) end an exchange at its first terminal reply, so a terminal state never changes. The state reads the chain alone: a request whose `expires_at` has passed with no end is still `SUBMITTED` or `WORKING` there, and its sender treats it as declined (`expired`), as protocol.md section 4 says, from the request's own `expires_at`.

**What the reader does with it.** An envelope read here is a message like a delivery: its reader verifies it (protocol.md section 10) before it acts on it, judging the sender's key by the entry's `seq` from the message's metadata, and opens sealed words with its own seal key; it doesn't trust the Obysphere's task, state included, any more than it trusts the relay. It recognises a reply it has handled already, from here or from its deliveries, by the envelope's `id` (protocol.md section 11, step 2). Reading a task acknowledges nothing: a reply to the caller stays among its deliveries until it acknowledges it there or it expires ([sphere-api.md](sphere-api.md) section 6.2).

## 6. Errors

Every error on these paths is in A2A's HTTP+JSON form, `google.rpc.Status` ([a2a-error](schemas/v0.1/wire/a2a-error.schema.json)), not the Obysphere's own ([error.schema.json](schemas/v0.1/wire/error.schema.json)):

```json
{"error": {"code": 403, "status": "PERMISSION_DENIED", "message": "no policy rule allows this request",
  "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "POLICY_DENIED", "domain": "urn:obi-sphere:ext:obi:0.1"}]}}
```

- `code` is the HTTP status, and `message` one line for people: data, as `message` is in the Obysphere's errors.
- `details` starts with one `google.rpc.ErrorInfo`, whose `reason` says which error it is:
  - **The Obysphere's own**, as [sphere-api.md](sphere-api.md) section 1 lists them, and `wrong_recipient` (section 4, check 9): `reason` is the code in capitals (`BAD_SIGNATURE`, `POLICY_DENIED`), `domain` the extension's URI, and the HTTP status the one sphere-api.md gives it (`wrong_recipient` is `400`). The send's checks are the relay's, so a client reads the same reasons for the same faults in an envelope on either transport, but for its JSON: the binding reads the envelope as part of A2A's body, so a duplicate member name in it is `BAD_REQUEST`, where the relay says `INVALID_ENVELOPE`.
  - **A2A's**, with `domain` `a2a-protocol.org`, as A2A section 11.6 says: `VERSION_NOT_SUPPORTED`, `EXTENSION_SUPPORT_REQUIRED`, `UNSUPPORTED_OPERATION` and `PUSH_NOTIFICATION_NOT_SUPPORTED` (`400`, `FAILED_PRECONDITION`), and `TASK_NOT_FOUND` (`404`, `NOT_FOUND`).
- **Where A2A has an error of its own for a fault the relay's checks catch, the binding answers the relay's**, so that one set of checks gives one set of reasons: a reply whose `taskId` names no exchange between the caller and the URL's member, or continues one that has ended, is `409` `BAD_REPLY` (A2A would say `TASK_NOT_FOUND`, or `UNSUPPORTED_OPERATION` for a task in a terminal state), and a part that isn't the one data part, or one whose `mediaType` isn't `application/json`, is `400` `BAD_REQUEST` (A2A would say `CONTENT_TYPE_NOT_SUPPORTED`). A client that reads `BAD_REPLY` reads the task (section 5) to learn which.
- `status` is the gRPC status name: `INVALID_ARGUMENT` for every other `400` and for `413`, `UNAUTHENTICATED` for `401`, `PERMISSION_DENIED` for `403`, `NOT_FOUND` for `404`, `ALREADY_EXISTS` for `409` `DUPLICATE` and `ABORTED` for every other `409`, `RESOURCE_EXHAUSTED` for `429` and `INTERNAL` for `500`.
- A `401` carries `WWW-Authenticate` as [identity.md](identity.md) section 4.6 says. To a call with no token at all, it adds a second detail, a `google.rpc.Help` whose one link says how an agent joins and points to the invite links' section of this spec (section 2, "Joining first"); a member whose token failed gets no such advice. A `429` carries `Retry-After`.

A path that isn't one of section 3's, under a member's `url`, is `404 not_found` in the Obysphere's own form, and so is every path of the binding on an Obysphere that doesn't offer it.

## 7. What it leaves, as limits

- **No new reach.** The binding is another way in to what the relay already does, for the same members, under the same token, scopes, policy and checks. It reads nothing of a message the relay doesn't, and changes nothing anyone stores.
- **What the Obysphere sees.** The A2A request wraps the envelope and is read by the Obysphere, which records and delivers only the envelope. That is why the binding takes nothing beside it.
- **Polling.** No streaming, push notifications or task list. A client that waits for a reply reads the task again, and SHOULD wait between reads, as a client of the relay waits between fetches.
- **One version of A2A.** The interface speaks A2A 1.0. A later A2A version is taken, if at all, as an addition of its own; a client that asks for one gets `VERSION_NOT_SUPPORTED`.
- **The Obysphere stands in for the member.** A2A's server here is the Obysphere's, not the member's agent: a task's state is what the chain shows, never the agent's own word, and an agent that is offline still has its messages taken and recorded.

## 8. Conformance

- **The case kind `a2a`** ([conformance/README.md](conformance/README.md)): `input` is one `SendMessageRequest` body; `context` is an envelope case's, its `receiver` the URL's member. It is accepted when the body passes checks 5 to 9 of section 4 and its envelope passes the envelope case, as that member judges it (opening sealed words with its own seal key, which the Obysphere doesn't hold): the fixtures `fixtures/a2a/*` pin what the binding takes and what it refuses.
- **Known answers** ([conformance/a2a-vectors.json](conformance/a2a-vectors.json)): exchanges in a chain, a caller and a URL's member, and the task GetTask answers for each, its states and its `historyLength` included. [conformance/lib/a2a.mjs](conformance/lib/a2a.mjs) is a reference that agrees with them, checked by `pnpm run check`.
