# The card on A2A 1.0

Status: **Draft**, part of [the next protocol version](README.md). It covers the part of [#59](https://github.com/obi-ai-bot/oby-sphere/issues/59) that breaks `obi/0.1`: the agent card in A2A 1.0's own shape. The rest of #59, the A2A binding, is an addition to `obi/0.1` ([a2a.md](../../a2a.md)), and comes into the next version as this document says (section 3).

Read against A2A 1.0: the a2aproject/A2A repository at tag `v1.0.1` (commit `3303592588e388e62e0f69f701af531d2f4e3991`), `docs/specification.md` sections 4.4, 8 and 11, and `specification/a2a.proto`'s `AgentCard`.

## 1. Why it waits for the version

An `obi/0.1` card follows A2A 0.3.0, and its schema pins that shape: a top-level `protocolVersion` that is `"0.3.0"`, a required `url` and `preferredTransport`, and no member it doesn't list ([identity.md](../../identity.md) section 2). A2A 1.0's `AgentCard` has none of those three at its top. It says where and how to reach the agent in `supportedInterfaces`, a list of `{url, protocolBinding, protocolVersion, tenant?}`, which it requires. So an A2A 1.0 card is no valid `obi/0.1` card, and an `obi/0.1` card is no A2A 1.0 card: whichever an implementation of the other reads, it refuses. That is a breaking change ([spec/README.md, "Versions"](../../README.md#versions), rule 2), and no feature can carry it, because a card in the new shape would be refused by every member from before.

The binding itself needs none of it: under `obi/0.1` the interface at a card's `url` speaks A2A 1.0, and a client learns so from the Obysphere's `a2a` feature ([a2a.md](../../a2a.md) section 1). What the next version adds is a card that says so itself.

## 2. The card

A sketch, with the next version's names ([identifiers.md](identifiers.md)):

```json
{
  "name": "An engineer's agent",
  "description": "A personal delegate for an engineer.",
  "supportedInterfaces": [
    {"url": "https://sphere.example.com/v0.2/spheres/acme/members/agent-a", "protocolBinding": "HTTP+JSON", "protocolVersion": "1.0"}
  ],
  "version": "1.4.0",
  "capabilities": {
    "streaming": false,
    "pushNotifications": false,
    "extensions": [{"uri": "https://STANDARDS-HOST/ext/core/0.2", "required": true, "params": { …as identifiers.md and the other documents say… }}]
  },
  "securitySchemes": {"obysphere": {"httpAuthSecurityScheme": {"scheme": "DPoP", "description": "The Obysphere's access token, bound to the caller's key (identity.md section 4.6): a member's, from its owner's delegation."}}},
  "securityRequirements": [{"schemes": {"obysphere": {"list": ["receive"]}}}],
  "defaultInputModes": ["application/json"],
  "defaultOutputModes": ["application/json"],
  "skills": [{"id": "question", "name": "Answer a question", "description": "Answers what its owner knows or decided.", "tags": ["typed-action"]}],
  "signatures": [{"protected": "<base64url JWS header>", "signature": "<base64url Ed25519 signature>"}]
}
```

What changes from `obi/0.1`'s profile:

- **One interface.** `supportedInterfaces` is exactly one entry: the member's entry in its Obysphere's directory, `<base>/v0.2/spheres/<sphere>/members/<agent_id>`, as `url` was; `protocolBinding` `HTTP+JSON`; `protocolVersion` `1.0`; no `tenant`, since the URL names the member. It is where the binding serves the member (section 3). A later A2A version the binding takes comes as a second entry, as an addition.
- **No `protocolVersion`, `url` or `preferredTransport`** at the top: A2A 1.0 has none.
- **How a caller authenticates**, which `obi/0.1` leaves out of the card (no `securitySchemes`): one fixed scheme, an HTTP authentication scheme `DPoP` with the description above, and one requirement naming it with the scope `receive`, which a member's token holds to use the binding (or `audit:read` in its place: [a2a.md](../../a2a.md) sections 4 and 5). The list is never empty: A2A's canonicalization drops an empty one, and the owner's signature would no longer cover what a verifier hashes. A client from any vendor then knows from the card that the interface wants a token; how a member gets one stays the extension's (identity.md section 4). It names DPoP because this Draft recommends tokens bound by DPoP for every agent's token in the next version ([README.md, "Additions to `obi/0.1`, folded in"](README.md#additions-to-obi01-folded-in)). If that recommendation isn't taken, the scheme is `Bearer`.
- **The extension** is the version's (`https://STANDARDS-HOST/ext/core/0.2`, [D2](README.md#decisions)), still `required: true`, still the card's one extension.
- **The signature.** A2A 1.0 signs a card as JWS over the RFC 8785 canonical JSON of the card without `signatures`, after leaving out every member at its protobuf default unless the schema marks it required or explicitly optional (A2A 1.0 sections 5.7 and 8.4). The profile allows no member at such a default (no empty string or list, no `required: false`, no member it doesn't list), so the canonical JSON the owner signs ([identity.md](../../identity.md) section 2.1) is exactly A2A 1.0's signing input: any A2A 1.0 verifier holding the owner key checks the owner's signature. The protected header stays `{alg: "EdDSA", kid: <owner key id>, typ: "JOSE"}`, with no `jku`: a member takes the owner key from the directory and pins it (identity.md section 3), never from a URL the card names. An organisation's agents' cards, which carry one signature per signing answerer ([owners.md, section 4](owners.md#4-its-agents-cards)), fit A2A's `signatures` list as they are.
- **Everything else is as in `obi/0.1`**: `name` and `description` are data, `skills` match `accepts` (tagged `typed-action`), streaming and push notifications are `false`, input and output are `application/json`, and the schema is closed.

Where cards are read doesn't change: from the Obysphere's directory, by members, with a token. An Obysphere publishes no member's card at A2A's well-known URI (`/.well-known/agent-card.json`): the directory is for members, and a card names its owner.

## 3. The binding in the next version

[a2a.md](../../a2a.md) as it is, under `/v0.2`, with the version's extension, at the interface the card lists. One change: **every Obysphere of the next version serves the binding**, rather than offering it as an extension (this Draft's proposal, [decided on #59](https://github.com/obi-ai-bot/oby-sphere/issues/59#issuecomment-6583515235)). A card that lists an interface says the member can be reached there, and only a binding every Obysphere serves keeps that true wherever the card is; the binding adds no reach beyond the relay's own checks ([a2a.md](../../a2a.md) section 7), so there is nothing an Obysphere would want to switch off. In `obi/0.1` it stays a feature an Obysphere announces.

Proposing the extension to A2A's own extension registry waits, by the same decision, until an implementation outside this repository serves the binding.

Not designed here, and still open ([protocol.md](../../protocol.md) section 16): pushing deliveries to an agent's own A2A endpoint, or agents talking over A2A without an Obysphere. Either needs the Obysphere, or a member, to call out to URLs another member chooses (a request forgery risk), credentials for those calls, and a record of what went past the Obysphere, which it couldn't keep.

## 4. Migration

| `obi/0.1` card | Next version |
|---|---|
| `protocolVersion: "0.3.0"` | Left out; `supportedInterfaces[0].protocolVersion` is `"1.0"` |
| `url` | `supportedInterfaces[0].url`, the same directory entry under `/v0.2` |
| `preferredTransport: "HTTP+JSON"` | `supportedInterfaces[0].protocolBinding: "HTTP+JSON"` |
| no `securitySchemes` | the one fixed scheme and requirement (section 2) |
| `urn:obi-sphere:ext:obi:0.1` | `https://STANDARDS-HOST/ext/core/0.2` ([identifiers.md](identifiers.md)) |
| `params`, `skills` tags | as [identifiers.md](identifiers.md) and the other documents say |

Each member's next-version card ([migration.md, section 3](migration.md#3-the-obysphere-server)) is in this shape, signed by its owner with the same owner key, and numbered in the one `card_seq` sequence; nothing else migrates for it. The `obi/0.1` binding records nothing a relay send wouldn't, so the chain needs nothing at the switch either, and a client that spoke it moves to the `/v0.2` paths with the card.

## 5. Conformance

The next version's card fixtures carry the shape above: a card with `url`, `preferredTransport` or a top-level `protocolVersion` refused, one with two interfaces, a `tenant`, another binding or another A2A version refused, one with a member at its protobuf default refused, and the owner's signature checked by an A2A 1.0 card verifier as well as by the spec's own.
