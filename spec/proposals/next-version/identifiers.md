# Neutral identifiers on the wire

Status: **Draft**, part of [the next protocol version](README.md). Issue: [#51](https://github.com/obi-ai-bot/oby-sphere/issues/51).

`obi/0.1` carries one product's name in its protocol constant, in every signing input, in field names, in a schema annotation, in the card's extension and skill tag, in the token assertions' audience, and in the marker an agent writes on a code host. An implementer from another vendor would ship that name inside theirs, in every signature and in the record, forever. The next version replaces each, and only those: everything else keeps its name ([README.md, "How it is designed"](README.md#how-it-is-designed), rule 1).

## 1. Every product-named identifier

Found by reading every schema in `schemas/v0.1/`, the three documents, the conformance contract and the reference server. [protocol.md section 1.1](../../protocol.md#11-names-on-the-wire), from #50, lists them for `obi/0.1`'s readers; this table has the same ones, with the fixtures' contract too, and says what replaces each. "Gone" means it goes with the compute and share actions ([D4](README.md#decisions)); if they were kept as a profile instead, each would take the neutral form in brackets.

| `obi/0.1` | Where | Next version |
|---|---|---|
| `obi/0.1` | `protocol` in the envelope, the card's `params`, the runner status, `GET /v0.1/health` and the Obysphere resource; the schemas folder `v0.1/`; the HTTP paths' `/v0.1` | `sphere/0.2` ([D1](#2-the-protocol-constant-d1)); `schemas/v0.2/`; `/v0.2` |
| `obi/0.1 envelope` + LF | an envelope's signing input (protocol.md section 9) | `sphere/0.2 envelope` + LF |
| `obi/0.1 audit` + LF | an audit entry's hash input (sphere-api.md section 7) | `sphere/0.2 audit` + LF |
| `obi/0.1 seal` + LF | the sealing key's HKDF info (protocol.md section 9.1) | `sphere/0.2 seal` + LF |
| `obi/0.1 channel` | the job channel hello's `protocol`, its signing input, and its keys' HKDF info (`obi/0.1 channel guest>host`, `host>guest`) | gone (`sphere/0.2 channel`) |
| `obi/0.1 runner_status` + LF | a runner status's signing input | gone (`sphere/0.2 runner_status` + LF) |
| | a charter's signing input (new: [owners.md](owners.md)) | `sphere/0.2 charter` + LF |
| `obi_id` | the shared definition in common.schema.json; the card's `params.obi_id`; the envelope's `from` and `to` are of that type | `agent_id` |
| `obi` | a member's id in the member, invitation request, invitation response and invitations list bodies; the path parameter `{obi}` in `/members/{obi}` | `agent`; `{agent}` |
| `obi` | the runner status's and the channel hello's member id | gone (`agent`) |
| `"obi"` | the value of `answer.by` for an answer the agent gave by itself | `"agent"` |
| `x-obi-text` (`data`, `sealed`) | the annotation on every text field of every schema (protocol.md section 8) | `x-text` |
| `urn:obi-sphere:ext:obi:0.1` | the card's one extension | `https://STANDARDS-HOST/ext/core/0.2` ([D2](#3-uris-d2)) |
| `obi_extension` | the extension's `$defs` name in agent-card.schema.json | `extension` |
| `obi-action` | the tag on each of the card's skills | `typed-action` |
| `obi-sphere:<sphere id>` | the `aud` of the owner's and the agent's assertions (identity.md section 4.1) | the Obysphere's URL, `<base URL>/v0.2/spheres/<sphere>`, the form planned as an addition to `obi/0.1` with #60; the old form is dropped |
| `obi-sphere://signin` | where a sign-in's callback sends the browser (sphere-api.md section 3.1) | a redirect that names no product: the client's own, as the OpenID Connect work (#60) will define it |
| `by Oby:` | the marker on every review an agent posts on a code host, and what a receiver looks for to tell an agent's review from a person's (protocol.md section 11) | `by agent:` ([D3](#4-the-code-host-marker-d3)), and both are recognised |
| `obi-base` | the branch a `run_request`'s bundle starts from | gone (`base`) |
| `https://github.com/obi-ai-bot/obi-sphere/raw/main/spec/schemas/v0.1/…` | every schema's `$id` | `https://STANDARDS-HOST/schemas/v0.2/…` ([D2](#3-uris-d2)) |
| `obi` in `context.keys{…}`, and `receiver` as an `obi_id` | the conformance fixtures' contract (conformance/README.md) | `agent` |
| `oby` and two companies' names among the reserved Obysphere ids | sphere-api.md section 3: ids nobody may create | the spec says only that a server may reserve ids; which ones is its operator's setting |

The run and share actions also carry `agent`, the coding agent's CLI that runs a job: a runtime, not a member. It is gone with them; if they were kept, it would become `runtime`, with an id from the registry ([runtimes.md](runtimes.md)), so that `agent` always means a member.

**Kept on purpose.** `sphere` (the field, the `sphere_id` type, `/spheres/` in paths) is a plain word for the place, and the spec's plain-names text (#50) calls the place an Obysphere in prose. If the maintainers want the place's word changed with the standards' published name, it is one more rename in this table, made the same way. `owner`, `owner_id`, `owner_key`, the key id prefixes `ed25519:` and `x25519:`, the seal suite's name, the scopes and the error codes name no product and stay.

**Not on the wire.** These carry the name too but are no part of the protocol, so they need no version: renaming them is up to whoever owns them, at any time.

- `X-Obi-Role`, `X-Obi-Sphere`, `X-Obi-Relay` and the other `X-Obi-*` headers: the reference server sets them on requests between its Worker and its own Durable Objects (`server/src/routes/channels.ts`, `server/src/routes/relays.ts`). No client sends or sees them, and the spec doesn't mention them.
- `.obi/inputs/`: protocol.md section 8 gives it as where one implementation writes quoted inputs. The rule is "a file"; the next version's text names no path.
- `oby://join/…`: one client's link on the reference server's join page; the invite link format the spec defines (#62) is the neutral one.
- The reference verifier's file `conformance/lib/obi.mjs` and the names inside it; the client library (#55) is where they will live.
- The schemas' `title` and `description` strings, which still say Obi and Sphere: words for readers, not identifiers. The next version's schemas are written with the plain names.

## 2. The protocol constant (D1)

The constant is every envelope's `protocol`, it begins every signing and hash input, it names the schemas folder, and it stays in the record forever. Whatever it is, renaming it again costs another breaking version. So the name should hold whatever happens to the project's or the standards' names.

| Option | For | Against |
|---|---|---|
| **A. `sphere/0.2`** (decided) | Names no product or vendor. It is the word the API already uses for the place (`/spheres/`, `sphere`, `sphere_id`), so the wire reads as one vocabulary. Independent of the standards' published name, which can then be chosen, and changed, freely. Short, lower-case ASCII. | A common word, which other projects may use too. That doesn't weaken domain separation: the prefix separates the kinds of signature one key makes in this protocol, and keys aren't shared across protocols. |
| B. The standards' published name, `<name>/0.2` | One name everywhere. | Waits on that decision, and ties the wire to a brand again: what #51 removes. A later rename of the standards would be another breaking version. |
| C. A descriptive phrase, such as `agent-exchange/0.2` | Says what it is. | Longer, and a generic phrase is more likely to be someone's product name. |

**The number.** `0.2`, continuing from `0.1`. `1.0` would read as Stable, which needs an external review and an implementation outside the company that started the project ([spec/README.md, "Statuses"](../../README.md#the-standards-by-instrument)). A later version reaches `1.0` when Core meets that bar.

**Decided:** option A, `sphere/0.2`, on [#51](https://github.com/obi-ai-bot/oby-sphere/issues/51#issuecomment-6456517079). The rest of this Draft writes it.

## 3. URIs (D2)

The card's extension URI and the schemas' `$id`s identify the standards. Today they are a URN in an unregistered namespace (`urn:obi-sphere:`) and the repository's GitHub URL, which names an organisation and a product and changes when the standards move to a foundation ([GOVERNANCE.md, "Neutrality"](../../../GOVERNANCE.md#neutrality)).

- **Decided** (on [#51](https://github.com/obi-ai-bot/oby-sphere/issues/51#issuecomment-6456517079)): an `https` URL on a domain held for the standards, chosen with their published name and moved with them to a foundation. The paths are this Draft's, for example `https://STANDARDS-HOST/ext/core/0.2` for the extension, `https://STANDARDS-HOST/schemas/v0.2/envelope.schema.json` for a schema (its folder is `schemas/v0.2/`, as for `obi/0.1`). A2A identifies extensions by URI, and a resolvable one can serve the extension's description. The URL is an identifier: nothing fetches it to check a message.
- The repository's GitHub URL: free and resolvable now, but it names an organisation and a product, and moves.
- A `urn:` in a namespace of the project's own: needs no host, but an unregistered URN namespace is not a URN, and it still needs a name.

## 4. The code-host marker (D3)

When an agent posts a review on a code host, its body carries a marker, and a receiver deciding whether code owners approved a change counts no review that carries one (protocol.md section 11, "Who counts as a code owner"). That rule is part of the Code profile ([core-and-profiles.md, section 9](core-and-profiles.md#9-the-code-profile)).

| Option | For | Against |
|---|---|---|
| **A. `by agent:`, and `by Oby:` still recognised** (decided on [#51](https://github.com/obi-ai-bot/oby-sphere/issues/51#issuecomment-6456517079)) | Plain words that name no product; a reader of the code host understands them. Recognising the old marker too keeps every review an agent posted under `obi/0.1` from counting as a person's. | Two strings to look for, for good; and `by agent:` is a phrase a person might write, which then only makes their review count for less, as the rule below says. |
| B. Keep `by Oby:` | Nothing changes. | Every implementation writes another product's name on every review it posts. |
| C. A marker with the constant's name, such as `by sphere agent:` | Ties the marker to the standards. | Ties a visible text to a name that may change, which D1 avoids for the wire. |

The same rule holds as today: writing a marker into a person's review only makes it count for less.

## 5. In the schemas

What the sketches in the other documents assume, as a fragment of the next version's common definitions:

```json
{
  "$id": "https://STANDARDS-HOST/schemas/v0.2/common.schema.json",
  "$defs": {
    "protocol": { "const": "sphere/0.2" },
    "agent_id": {
      "description": "A member agent's id, unique within its Obysphere and never reused. `obi_id` in obi/0.1, same pattern.",
      "$ref": "#/$defs/slug"
    },
    "slug": {
      "type": "string",
      "minLength": 1,
      "maxLength": 63,
      "pattern": "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"
    },
    "line_text": {
      "description": "One line of human-written text. Every use is annotated `x-text: data` and sets its own bounds.",
      "type": "string",
      "pattern": "^[^\\u0000-\\u001F\\u007F\\u202A-\\u202E\\u2066-\\u2069]*$"
    }
  }
}
```

An agent id's value doesn't change: `obi-lead` is as valid an `agent_id` as it was an `obi_id`, so no member is renamed by the migration ([migration.md](migration.md)).

## 6. Done when

#51 is done when the next version's schemas, signing inputs, headers and fixtures contain no product name, and the CHANGELOG lists every rename with its old form. Section 1's table is that list, ahead of time. Two exceptions, accepted on [#51](https://github.com/obi-ai-bot/oby-sphere/issues/51#issuecomment-6456517079):

- The fixtures that pin D3 contain `by Oby:` on purpose, since a receiver must still recognise it.
- Agent ids carried over from `obi/0.1` keep their values, such as `obi-…`. They are members' own names, not the protocol's. The next version's fixtures use neutral ids.
