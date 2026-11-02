# The next protocol version

Status: **Draft**. A proposal, not part of `obi/0.1`: nothing here changes what an `obi/0.1` implementation must do, and every message, card, chain and wire body valid under `obi/0.1` stays valid there. Its thirteen decisions are taken (["Decisions"](#decisions)); its text stays a Draft until a pull request turns it into spec text, schemas and conformance cases (GOVERNANCE.md, "How a standard changes", step 2), and may change until then.

The next version gathers the breaking changes the vision needs ([#43](https://github.com/obi-ai-bot/oby-sphere/issues/43)), so that implementers migrate once, and designs with them the parts that could come sooner as additions (["Why a new version"](#why-a-new-version)):

- **Neutral identifiers** ([#51](https://github.com/obi-ai-bot/oby-sphere/issues/51)): no product's name in a protocol constant, a signing input, a field, a URI or a tag.
- **A domain-neutral Core with profiles** ([#52](https://github.com/obi-ai-bot/oby-sphere/issues/52)): what every member implements, whatever its work, and code collaboration as one profile on top. A request for any kind of work, with acceptance conditions a machine can check. Policy and remembered decisions keyed by a scope, and references that can name documents, datasets and earlier exchanges.
- **Organisations and projects as owners** ([#61](https://github.com/obi-ai-bot/oby-sphere/issues/61)): an owner that isn't one person, with the named people who answer for it. Decided: it comes to `obi/0.1` first, as an addition (D13).
- **An open list of agent runtimes** ([#54](https://github.com/obi-ai-bot/oby-sphere/issues/54)): an open, bounded identifier with a registry of known ids, in place of the closed `claude`/`codex` enum.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as in RFC 2119 and RFC 8174 when, and only when, they appear in capitals. They say what the next version would require, if accepted.

## The name: `sphere/0.2`

The next protocol constant is **`sphere/0.2`** ([decision D1](https://github.com/obi-ai-bot/oby-sphere/issues/51#issuecomment-6456517079)). An envelope's `protocol` is `sphere/0.2`, its signing input begins `sphere/0.2 envelope` and an LF, its schemas are in `schemas/v0.2/`, and its HTTP paths begin `/v0.2`.

**`STANDARDS-HOST`** stands for where the standards' URIs live: a schema's `$id` is `https://STANDARDS-HOST/schemas/v0.2/…`. [D2](https://github.com/obi-ai-bot/oby-sphere/issues/51#issuecomment-6456517079) decided the kind of host, an `https` URL on a domain held for the standards; which domain is chosen with the standards' published name, which is still open.

## How it is designed

1. **Change only what has to change.** A field, a rule or a check that names no product, fits every domain and works for every owner keeps its name, its bounds and its meaning, so most of the migration is mechanical. Every rename is listed with its old form ([identifiers.md](identifiers.md)).
2. **Every message stays checkable by everyone.** Every type of every profile has a closed schema in the spec, so any member can verify any envelope and the whole chain, whatever profiles it acts on ([core-and-profiles.md, section 2](core-and-profiles.md#2-core-and-profiles)).
3. **No standard ahead of use** ([ROADMAP.md, "What we won't build"](../../../ROADMAP.md#what-we-wont-build)). What no implementation uses is dropped rather than carried forward (the compute and share actions: [D4](#decisions)), and what only one domain needs stays in that domain's profile until a second one needs it.
4. **The additions being made to `obi/0.1` behind features are folded in, not redesigned.** The runtime and vendors on a card, conformance classes, follow-ups, `cancel`, introductions, topics, invite links, OpenID Connect sign-in and DPoP-bound tokens become plain parts of the next version, with the shapes their additions give them ([section "Additions to `obi/0.1`, folded in"](#additions-to-obi01-folded-in)).
5. **The principles hold unchanged.** Typed actions only, words are data, every message signed, owners decide, secrets used and never handed over, a record anyone can check ([PRINCIPLES.md](../../../PRINCIPLES.md)). Organisation owners keep "every word traces back to someone accountable": an organisation answers through named people, each signing with their own key.

## The documents

| Document | What it proposes |
|---|---|
| [identifiers.md](identifiers.md) | Every product-named identifier in `obi/0.1`, where it is, and what replaces it. |
| [core-and-profiles.md](core-and-profiles.md) | Core and the profiles; the actions and the exchange rules; `work_request` and its conditions; references; scopes, policy and remembered decisions; the Code profile; why the compute and share actions are dropped. |
| [owners.md](owners.md) | Organisations and projects as owners: the charter, the people who answer, cards signed by them, what such an owner's agent may do, and how the Council counts it. |
| [runtimes.md](runtimes.md) | Runtime and vendor ids: open, bounded, with a registry. |
| [a2a-card.md](a2a-card.md) | The agent card in A2A 1.0's shape: one interface, the binding's, at the member's directory entry; how a caller authenticates; a signature any A2A 1.0 verifier checks; and the binding served by every Obysphere. |
| [migration.md](migration.md) | What every implementation changes, what carries over, and how an Obysphere switches from `obi/0.1`. |

The schema sketches are in each document, as JSON. They show shapes and bounds; they are not schemas, and nothing checks them against an implementation yet.

## Decisions

All thirteen are **decided**, each as this Draft recommended, by the maintainer, who said why on each issue (GOVERNANCE.md: a sole maintainer decides and says why): [#51](https://github.com/obi-ai-bot/oby-sphere/issues/51#issuecomment-6456517079) (D1, D2, D3, D12), [#52](https://github.com/obi-ai-bot/oby-sphere/issues/52#issuecomment-6456517732) (D4 to D8, D13) and [#61](https://github.com/obi-ai-bot/oby-sphere/issues/61#issuecomment-6456518294) (D9 to D11, D13). The documents are written with these decisions taken. Each row links to the comment that decided it, and its "Decided" cell says only what that comment decided. Details the Draft adds around a decision, such as who counts among an organisation's people over time, are in the documents. The pull request that turns this Draft into spec text will record the decision on it too (GOVERNANCE.md, "How a standard changes", step 4).

| # | Decision | Decided | Issue | Where |
|---|---|---|---|---|
| D1 | The new protocol constant's name and number. | **`sphere/0.2`**: no product's or vendor's name, the word the API already uses for the place (`/spheres/`, `sphere`), and independent of the standards' published name, so renaming the project or publishing the standards under another name never costs another breaking version. `0.2`, not `1.0`: no standard is Stable yet. | [#51](https://github.com/obi-ai-bot/oby-sphere/issues/51#issuecomment-6456517079) | [identifiers.md, section 2](identifiers.md#2-the-protocol-constant-d1) |
| D2 | Where the card extension's URI and the schemas' `$id`s live. | **An `https` URL on a domain held for the standards**, chosen with their published name and moved with them to a foundation, rather than the repository's GitHub URL (which names an organisation and a product). | [#51](https://github.com/obi-ai-bot/oby-sphere/issues/51#issuecomment-6456517079) | [identifiers.md, section 3](identifiers.md#3-uris-d2) |
| D3 | The marker on reviews an agent posts on a code host, `by Oby:` today. | **`by agent:`**, and receivers keep recognising `by Oby:` too, so no review an agent posted before counts as a person's. | [#51](https://github.com/obi-ai-bot/oby-sphere/issues/51#issuecomment-6456517079) | [identifiers.md, section 4](identifiers.md#4-the-code-host-marker-d3) |
| D4 | The retired compute and share actions (`run_request`, `run_progress`, `run_return`, `run_cancel`, `share_offer`, `share_status`, `share_revoke`, the job channel and the runner status). | **Drop them.** Oby, the one implementation that had them, has removed them ([obi-ai-bot/oby#1515](https://github.com/obi-ai-bot/oby/pull/1515)), and none other is known; they are the largest attack surface in the spec and the part most tied to one product; lending a secret is the Exchange standard's work ([#44](https://github.com/obi-ai-bot/oby-sphere/issues/44)). The `obi/0.1` text stays as it is for whoever designs it again. | [#52](https://github.com/obi-ai-bot/oby-sphere/issues/52#issuecomment-6456517732) | [core-and-profiles.md, section 10](core-and-profiles.md#10-the-compute-and-share-actions-d4) |
| D5 | `handoff` next to a domain-neutral request for work. | **Fold `handoff` into Core's `work_request`**, with a Code `branch` reference as its subject: one way to ask for work, whatever the domain. | [#52](https://github.com/obi-ai-bot/oby-sphere/issues/52#issuecomment-6456517732) | [core-and-profiles.md, section 5](core-and-profiles.md#5-a-request-for-work) |
| D6 | Who defines profiles. | **The spec alone.** Every profile's schemas are published with the version, so every member can check every message; a member's card lists the profiles it acts on. No third-party profiles with schemas others don't have. | [#52](https://github.com/obi-ai-bot/oby-sphere/issues/52#issuecomment-6456517732) | [core-and-profiles.md, section 2](core-and-profiles.md#2-core-and-profiles) |
| D7 | The machine-checkable acceptance conditions Core starts with. | **`delivers`, `before` and `own_check`**, plus `custom` for a person, each saying who can check it: anyone, from the result and the record, or the receiver, by its own check. | [#52](https://github.com/obi-ai-bot/oby-sphere/issues/52#issuecomment-6456517732) | [core-and-profiles.md, section 6](core-and-profiles.md#6-acceptance-conditions-d7) |
| D8 | How an Obysphere moves to the next version. | **One switch per Obysphere**, at a sequence number its admin chooses once every member has a next-version card. One chain, each entry checked by its own version's rules. | [#52](https://github.com/obi-ai-bot/oby-sphere/issues/52#issuecomment-6456517732) | [migration.md, section 4](migration.md#4-the-switch-d8) |
| D9 | What an organisation owner is. | **Its charter, with no key of its own**: a signed list of the named people who answer for it, how many of them sign its agents' cards, and who may approve for it. An organisation key would be a key nobody answers for, or one person's key under another name. | [#61](https://github.com/obi-ai-bot/oby-sphere/issues/61#issuecomment-6456518294) | [owners.md, section 2](owners.md#2-the-charter-d9) |
| D10 | How an organisation counts under the Council's one seat per owner. | **People, not owner ids.** A seat stands for the people who answer for it; no two seats on a panel share a person, and no seat of the author's people sits. For the diversity count, an organisation's seat counts as one owner. | [#61](https://github.com/obi-ai-bot/oby-sphere/issues/61#issuecomment-6456518294) | [owners.md, section 6](owners.md#6-the-council-d10) |
| D11 | Whether an organisation's agent may approve on a code host. | **No.** A code host's approval is a person's; an organisation's approver approves there in person. | [#61](https://github.com/obi-ai-bot/oby-sphere/issues/61#issuecomment-6456518294) | [owners.md, section 5](owners.md#5-what-an-organisations-agent-may-do-d11) |
| D12 | The registry of runtime and vendor ids. | **Open on the wire, listed in the spec**, first come by pull request, never reused. A vendor id the registry doesn't list counts for no vendor in the Council's diversity count. | #54, decided on [#51](https://github.com/obi-ai-bot/oby-sphere/issues/51#issuecomment-6456517079) | [runtimes.md](runtimes.md) |
| D13 | What comes to `obi/0.1` sooner, as additions. | **Organisation owners, as #61 plans**, behind a feature; `work_request` and its references when an implementation that doesn't work on code needs them; everything breaking with the version. | [#61](https://github.com/obi-ai-bot/oby-sphere/issues/61#issuecomment-6456518294), [#52](https://github.com/obi-ai-bot/oby-sphere/issues/52#issuecomment-6456517732) | [Why a new version](#why-a-new-version) |

### Open points decided since

After D1 to D13, the maintainer decided four points this Draft had left open, each on its issue:

- **No early switch** ([#52](https://github.com/obi-ai-bot/oby-sphere/issues/52#issuecomment-6583514196)): an Obysphere switches only once every active member has a next-version card, and an admin who can't wait first revokes the members that have stopped taking part. The `suspended` member status this Draft had proposed for members not ready at the switch is dropped. How the server holds to this, by refusing the switch within its one step, is the Draft's own ([migration.md, section 4](migration.md#4-the-switch-d8)).
- **Only people answer for an organisation** ([#61](https://github.com/obi-ai-bot/oby-sphere/issues/61#issuecomment-6583514650)): an organisation can't answer for another. It can be revisited if someone needs nested owners ([owners.md, section 7](owners.md#7-left-open-not-part-of-d9-to-d13)).
- **Every `sphere/0.2` Obysphere MUST serve the A2A binding** ([#59](https://github.com/obi-ai-bot/oby-sphere/issues/59#issuecomment-6583515235)); in `obi/0.1` it stays a feature an Obysphere announces. Proposing the extension to A2A's own extension registry waits until an implementation outside this repository serves the binding ([a2a-card.md, section 3](a2a-card.md#3-the-binding-in-the-next-version)).
- **#54's last clause is dropped** ([#54](https://github.com/obi-ai-bot/oby-sphere/issues/54#issuecomment-6583515890)): a runtime named in a request has nothing left to apply to once the compute and share actions are gone ([runtimes.md, section 4](runtimes.md#4-done-when)).

## Why a new version

GOVERNANCE.md asks a breaking change to say why an addition wouldn't do ("How a standard changes", step 2). Not everything here is breaking.

**Breaking, so it waits for the new version:**

- every rename in [identifiers.md](identifiers.md): a renamed field or a new signing prefix makes a valid `obi/0.1` message invalid;
- dropping the compute and share actions, and folding `handoff` into `work_request`: messages that were valid stop being so;
- policy keyed by `scopes` in place of `repos`, and remembered decisions keyed by scope: the policy body changes, and `*` means more than it did;
- the assertions' audience in the Obysphere's URL form only.

**Could come sooner, as additions behind features** (spec/README.md, "Versions", rule 1), with `obi/0.1`'s names:

- organisation owners ([owners.md](owners.md)): a new kind of card, charter and delegation, with every earlier card valid and meaning the same. This is what #61 plans: "a design proposal, then a spec addition";
- `work_request`, its conditions, and the new reference kinds: a new request type and new kinds, with every earlier message unchanged;
- `scopes` next to `repos` in a policy rule.

**In `obi/0.1`** (spec/README.md, "Versions", rule 1): a card's members that an addition brings go in only once every other active member takes the feature (since #70), and a message or a policy rule that uses an addition only once every active member does (since #53, obi-ai-bot/oby-sphere#76), since every member reads the directory, the policy and the whole chain. In both cases the Obysphere must take the feature too (`409 feature_not_taken`, sphere-api.md sections 4, 5 and 6.1). So an addition reaches an Obysphere when its last member has it. A version switch is the same idea: it comes once every member has a card for the new version (D8, migration.md section 4).

**D13, decided:** organisation owners come to `obi/0.1` first, as an addition behind a feature, as #61 plans, with this design. `work_request` and its references come as an addition when an implementation that doesn't work on code needs them, and otherwise with the next version: no standard ahead of use. Everything breaking waits for the version.

## Smaller choices this Draft makes

Each is this Draft's own, written into the document named with its reason, and not among the thirteen decisions:

- a `none` scope, so `obi/0.1`'s `*` converts without widening ([core-and-profiles.md, section 8](core-and-profiles.md#8-scopes-policy-and-remembered-decisions));
- the Obysphere checks `before` at send, the one acceptance condition it checks ([core-and-profiles.md, section 6](core-and-profiles.md#6-acceptance-conditions-d7));
- a person may join as an owner with no agent, so they can answer for an organisation ([owners.md, section 2](owners.md#2-the-charter-d9));
- an organisation's agents' cards and delegations carry several signatures, one per signing answerer, with a token type of their own ([owners.md, section 4](owners.md#4-its-agents-cards));
- an organisation joins only through a named invitation, and rate limits count people ([owners.md, sections 3 and 5](owners.md#3-joining-the-directory-and-what-an-organisations-people-do));
- tokens bound by DPoP required for an agent's tokens, bound to its own key, once the #60 addition defines them (below);
- policy matched scope by scope, and no remembered accept keyed by a topic ([core-and-profiles.md, section 8](core-and-profiles.md#8-scopes-policy-and-remembered-decisions));
- a result consistent with its request, checked by the Obysphere at send, the chain's verifier and the requester ([core-and-profiles.md, section 5](core-and-profiles.md#5-a-request-for-work));
- the card in A2A 1.0's shape names the Obysphere's token as its security scheme, `DPoP`, and lists the binding's one interface ([a2a-card.md, section 2](a2a-card.md#2-the-card));
- the switch checked within its own step, refused with `409 conflict` while a member or an organisation isn't ready, and the Obysphere's resource listing the active members that have no next-version card yet ([migration.md, section 4](migration.md#4-the-switch-d8)).

Accepted with the decisions, on [#51](https://github.com/obi-ai-bot/oby-sphere/issues/51#issuecomment-6456517079): #51's two exceptions in the next version's fixtures, the old marker `by Oby:` and agent ids carried over ([identifiers.md, section 6](identifiers.md#6-done-when)).

## Additions to `obi/0.1`, folded in

These come to `obi/0.1` behind features, and all of them are merged: #54 (obi-ai-bot/oby-sphere#70), #57's classes on the card (obi-ai-bot/oby-sphere#74) and its policy rule that requires a class (obi-ai-bot/oby-sphere#88), #53 (obi-ai-bot/oby-sphere#76), #62 (obi-ai-bot/oby-sphere#69), #60's server side (obi-ai-bot/oby-sphere#84) and #59 (obi-ai-bot/oby-sphere#89). The next version takes each as its addition defines it, without the feature flag, unless this table says otherwise. This Draft's rows for #57's policy rule, #60 and #62 were written before those three merged, and haven't been checked against their merged text yet.

| Addition | Issue | In the next version |
|---|---|---|
| The runtime and model vendors on a card, and the card's `features` list | [#54](https://github.com/obi-ai-bot/oby-sphere/issues/54) | Core card fields, with ids from the registry ([runtimes.md](runtimes.md)). The next version keeps `features` for its own later additions. |
| Conformance classes on a card, and policy that requires one | [#57](https://github.com/obi-ai-bot/oby-sphere/issues/57) | Core card field. *holder* has no action in the next version once the share actions are dropped (D4), until the Exchange standard ([#44](https://github.com/obi-ai-bot/oby-sphere/issues/44)) gives it one. *executor* covers received work: a review's check and a `work_request`. *approver* is the Code profile's. |
| Follow-ups: `follows` on a request | [#53](https://github.com/obi-ai-bot/oby-sphere/issues/53) | Core, on every request type, `work_request` included. The `exchange` reference kind ([core-and-profiles.md, section 7](core-and-profiles.md#7-references)) takes the same rule: an earlier exchange between the same two members. |
| `cancel`: a request's sender calls it off | [#53](https://github.com/obi-ai-bot/oby-sphere/issues/53) | A Core reply, for every request type; it replaces `run_cancel`. In the Code profile it also ends a confirmation to approve on the code host. |
| Introductions | [#53](https://github.com/obi-ai-bot/oby-sphere/issues/53) | A Core request type, whose `accept` ends its exchange. |
| Topics on a card | [#53](https://github.com/obi-ai-bot/oby-sphere/issues/53) | A Core card field, and the `topic` scope kind ([core-and-profiles.md, section 8](core-and-profiles.md#8-scopes-policy-and-remembered-decisions)), which uses topic ids as they are. |
| A defined invite link; the phone relay as an optional extension | [#62](https://github.com/obi-ai-bot/oby-sphere/issues/62) | As defined, under `/v0.2`. The relay stays an extension, outside Core. |
| The A2A binding: a member reached over A2A 1.0 at its card's URL, the signed envelope as the message's one data part | [#59](https://github.com/obi-ai-bot/oby-sphere/issues/59) | As defined ([a2a.md](../../a2a.md)), under `/v0.2`, at the one interface the card lists ([a2a-card.md](a2a-card.md)), and served by every Obysphere rather than offered as an extension. |
| Sign-in with any OpenID Connect provider; DPoP-bound tokens; an assertion audience that names the server | [#60](https://github.com/obi-ai-bot/oby-sphere/issues/60) | As defined. The old audience form `obi-sphere:<sphere>` is dropped ([identifiers.md](identifiers.md#1-every-product-named-identifier)). Recommended: tokens bound by DPoP become required for an agent's tokens, bound to the agent's own key. |

Where an addition's merged text and this Draft disagree, the addition wins and this Draft is corrected.

## Other breaking changes to gather

These belong in the same version if they are ready, so implementers migrate once. This Draft designs the first ([a2a-card.md](a2a-card.md)), and not the others.

- **The card on A2A 1.0** ([#59](https://github.com/obi-ai-bot/oby-sphere/issues/59)): designed in [a2a-card.md](a2a-card.md). The card profile follows A2A 0.3.0 in `obi/0.1`; A2A 1.0's card has no top-level `protocolVersion`, `url` or `preferredTransport`, and requires `supportedInterfaces`, so neither version's card is valid under the other's schema. The A2A binding itself is an addition to `obi/0.1` ([a2a.md](../../a2a.md)).
- **Membership and policy in the record.** `obi/0.1`'s chain records relayed messages only (protocol.md section 16). New entry kinds would break `obi/0.1` chain verifiers, so they belong at a version boundary. Organisation charters ([owners.md](owners.md)) would be the first membership facts worth recording.
- **The rest of Exchange** ([#44](https://github.com/obi-ai-bot/oby-sphere/issues/44)): lending secrets, standard cryptography, a cosigned record. These wait for the maintainers.

## Not covered

- What is not on the wire: the reference server's internal headers and file names, and Oby's own paths. [identifiers.md](identifiers.md) lists them, so they can be renamed whenever their owners like, without a version.
- Rooms ([#46](https://github.com/obi-ai-bot/oby-sphere/issues/46)) and Artifacts ([#47](https://github.com/obi-ai-bot/oby-sphere/issues/47)). The references and scopes here are built so that a document or a dataset can later travel as an artifact, but nothing here moves files.
