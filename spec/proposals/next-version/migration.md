# Migrating from `obi/0.1`

Status: **Draft**, part of [the next protocol version](README.md).

What an implementation and an Obysphere do to move from `obi/0.1` to `sphere/0.2`, with the decisions taken on [#51](https://github.com/obi-ai-bot/oby-sphere/issues/51#issuecomment-6456517079), [#52](https://github.com/obi-ai-bot/oby-sphere/issues/52#issuecomment-6456517732) and [#61](https://github.com/obi-ai-bot/oby-sphere/issues/61#issuecomment-6456518294). The `obi/0.1` documents stay as they are (spec/README.md, "Versions", rule 2), and the next version's CHANGELOG entry lists every rename with its old form ([identifiers.md, section 1](identifiers.md#1-every-product-named-identifier)).

## 1. What every implementation changes

Mostly mechanical:

- **Constants.** `obi/0.1` becomes `sphere/0.2` in `protocol` and in every signing and hash input: `sphere/0.2 envelope`, `sphere/0.2 audit` and `sphere/0.2 seal`, each followed by an LF. The schemas are `schemas/v0.2/`, the HTTP paths `/v0.2`.
- **Renames.** `obi_id` → `agent_id`; the `obi` members and the `{obi}` path parameter → `agent`; `answer.by: "obi"` → `"agent"`; `x-obi-text` → `x-text` (in schemas only); the card extension's URI and the `obi-action` tag; the assertions' `aud`, which is the Obysphere's URL only; the code-host marker `by Oby:` → `by agent:`, still recognising the old one.
- **New delegations.** A delegation's `aud` names the Obysphere and the version's path, so every agent needs a new delegation from its owner for `sphere/0.2`. An owner signs it with the same owner key, before the switch. Its scopes are converted: `send:handoff` becomes `send:work_request`, and `send:run_request` and `send:share_offer` are gone.
- **Policy, remembered decisions and sharing rules by scope**, converted so that nothing is allowed outside what a rule named before. The one difference is deliberate: matching scope by scope, a request about several repositories that a rule names one by one is allowed by that rule, where `obi/0.1` allowed it only under `*`.
  - a repository `r` becomes `repo:r`, and `owner/*` becomes `repo:owner/*`;
  - in a policy rule, a sharing rule or a remembered **accept**, `obi/0.1`'s `*` matched every repository and, for a question, a question about none. For `question` and `introduction`, which may name no repository, it becomes `repo:*` and `none` together; for `handoff` and `review_request`, which always name a repository, `repo:*` alone, so a converted rule never covers work described only in words. It never becomes `*`, which in the next version also matches documents, datasets and topics. A policy rule whose `actions` list a `question` or an `introduction` with a `handoff` or a `review_request` under `*` is split in two, one rule per conversion;
  - in a remembered **decline**, `*` stays `*`: a sender an owner turned away from everything stays turned away from the new kinds too;
  - a rule, decision or sharing rule for `handoff` becomes the same one for `work_request`, with its scopes converted as above, so it covers work in repositories only;
  - an owner who wants more widens it themselves, after the switch.
- **`handoff` becomes `work_request`.** `{goal, repo, base_branch, issue?, pr?, acceptance, summary?}` becomes `{goal, subject: {kind: "branch", repo, branch: base_branch}, about?: [the issue or pull request], acceptance, summary?}`. Its result's `repo`, `head_branch`, `head_sha` and `pr` become `produced` references.
- **The card endpoint.** `PUT …/members/{agent}/card` also takes an owner token in one case: an organisation's answerer, registering a card for an agent whose own tokens are gone ([owners.md, section 4](owners.md#4-its-agents-cards)).
- **Dropped.** The compute and share actions, the job channel, the runner status and their endpoints and scopes ([core-and-profiles.md, section 10](core-and-profiles.md#10-the-compute-and-share-actions-d4)). An implementation that never had them changes nothing here.
- **New, to implement or not.** `work_request` and its conditions; the new reference and scope kinds; organisation owners (a receiver must at least verify their cards and show who answers: [owners.md](owners.md)). What is being added to `obi/0.1` behind features comes without the feature flag ([README.md, "Additions to `obi/0.1`, folded in"](README.md#additions-to-obi01-folded-in)).

## 2. What carries over unchanged

- **Keys.** Owner keys, agent keys and seal keys, with their ids. Nobody makes a new key to migrate.
- **Ids.** Owner ids, agent ids (an `obi_id` such as `obi-lead` is a valid `agent_id`), Obysphere ids and rule ids: the values stay, only the field names change.
- **The record.** The chain goes on: same sequence, the hash links unbroken across the switch (section 4).
- **The directory's key history**, with its sequence ranges, so every earlier entry still verifies.
- **Owner bindings and sign-ins.** A person bound to a key and an account stays bound.
- **Everything else in a message**: the JSON rules, canonical JSON, Ed25519, the seal suite, the size and time limits, every bound and pattern not listed above.

## 3. The Obysphere server

A server speaks both versions while its Obyspheres move: `/v0.1/…` as today, and `/v0.2/…` with the next version's bodies. `GET /v0.2/health` lists the protocols it speaks. Each Obysphere on the server is on one version at a time and moves on its own, at its own switch.

**Before the switch**, each member registers a card for the next version, signed by its owner: the same agent id, the next `card_seq`, and the same keys as its current `obi/0.1` card. The server keeps it next to the member's `obi/0.1` card and doesn't use it yet. The Obysphere's resource says how many active members have one, and this Draft adds that it lists the active members that don't and the organisations that aren't revoked with no waiting charter (section 5), so an admin can see who the switch waits for. It also adds that revoking a member (identity.md section 3) voids its waiting card, and revoking an organisation (owners.md section 3) voids its waiting charter, cards and delegations.

- **One `card_seq` across versions.** A member's cards of either version are numbered in one sequence, so pinning (identity.md section 3) keeps working across the switch: an agent never trusts a card with a lower `card_seq` than one it has seen, whatever its version.
- **A later `obi/0.1` card voids it.** Any `obi/0.1` card update after a next-version card was registered (a rotated signing key, a new seal key, a new `accepts`) voids the waiting next-version card. The member registers another, with a higher `card_seq` and the new keys. So the switch can never bring back a key the member rotated away.

## 4. The switch (D8)

**Decided: one switch per Obysphere** ([#52](https://github.com/obi-ai-bot/oby-sphere/issues/52#issuecomment-6456517732)), made by its admin, at a sequence number of its chain, once every active member has a next-version card. It is the same idea as `obi/0.1`'s rule for a message or a policy rule that uses an addition (spec/README.md rule 1; since #53, `409 feature_not_taken`; README.md, "Why a new version"): since every member reads and verifies the whole chain, a new version is used only once every member can read it.

1. **When.** The admin chooses when, once every active member has a waiting next-version card (D8). **No earlier** ([decided on #52](https://github.com/obi-ai-bot/oby-sphere/issues/52#issuecomment-6583514196)): an admin can't switch before every active member is ready and suspend the rest. An admin who can't wait first revokes the members that have stopped taking part (identity.md section 3), so nobody is cut off without notice. This Draft adds the same for the rest of what holds a switch back: an admin may revoke an organisation that won't sign a waiting charter (owners.md section 3), and may withdraw open invitations so that no member joins without a next-version card; a member that joins before the switch can register its next-version card at once. This Draft had proposed a `suspended` member status for members not ready at the switch; that proposal is dropped with the decision.
2. **What happens at the switch.** In one step, at the chain's head seq *s*, the server:
   - checks, first, that the switch may happen (this check is the Draft's own way of holding to the decision): every active member has a waiting card that isn't voided and names the same keys as its current `obi/0.1` card, and every organisation that isn't revoked has a waiting charter that can become current (section 5). If any doesn't, nothing changes: the server refuses the switch with `409 conflict` (in the next version, `conflict` also covers a switch while a member or an organisation isn't ready), with the first 20 not ready in `details` and the full list on the resource. Since the check is part of the same step, a card update or a new member that lands before it is counted, and none can land between the check and the switch. The call that makes the switch isn't designed here; it is an admin's, like the Obysphere's other admin edits (sphere-api.md section 3);
   - makes each active member's waiting card current;
   - converts the policy (section 1) into a new policy version;
   - revokes every `/v0.1` access token for the Obysphere;
   - drops every delivery not yet acknowledged, as it drops expired ones. They stay in the chain, so a member can read what it missed there.
   - From then on it takes only `sphere/0.2` envelopes for that Obysphere, and issues tokens only on next-version delegations (section 1).
3. **Open exchanges end at the switch.** A reply to an `obi/0.1` request is refused after it (`409 bad_reply`), and the request's sender treats the silence as a decline, as it treats silence today. As with a `cancel`, an exchange that ends at the switch ends any confirmation to approve on the code host given for it. An implementation SHOULD answer, decline or cancel its open exchanges before a switch it was told of.
4. **One chain.** Entries up to *s* are `obi/0.1` entries: their envelopes say `obi/0.1`, and their hash input begins `obi/0.1 audit`. Entry *s* + 1 is the first next-version entry: its `prev` is the hash of entry *s*, as always, and its envelope and hash input say `sphere/0.2`. No `obi/0.1` entry may follow a `sphere/0.2` entry. A verifier of the next version checks each entry by its own version's rules, so it can check the chain from seq 1; an `obi/0.1` verifier checks it up to *s* and stops there.
5. **One sequence.** Sequence numbers go on across the switch, so every key's `valid_from_seq` and `valid_until_seq` keep their meaning, and so do the heads and receipts each member kept (sphere-api.md section 7.1, "No rollback, no fork").

**The alternative: both versions at once in an Obysphere.** Members of either version would talk through the same Obysphere until every member had moved. But an `obi/0.1` member can't read a next-version envelope or card, so the Obysphere would need two directories, a rule to route each envelope only to members of its version, and a chain that `obi/0.1` verifiers stop checking at its first next-version entry anyway. It keeps two versions' rules alive in every server and client for as long as one member hasn't moved, which is the cost one switch avoids.

## 5. Organisations

Since organisation owners come to `obi/0.1` first, as an addition (D13), an Obysphere may have organisations at its switch. Before it, each organisation:

- **signs a next-version charter**: the same answerers, approvers and thresholds, `protocol` `sphere/0.2`, the next `charter_seq`, `prev` the hash of its last `obi/0.1` charter, signed by `thresholds.charter` answerers under the `sphere/0.2 charter` prefix. Pinning follows that `prev` link across the versions as it follows any other;
- has each of its agents' next-version cards and delegations signed by `thresholds.card` answerers, as section 3 says for every member.

Its waiting cards name the waiting charter. A waiting charter is not a successor until the switch: it never counts in the "two successors" rule (owners.md, section 2). **A later `obi/0.1` charter voids it**, with the organisation's waiting cards and delegations, as a later `obi/0.1` card voids a waiting card (section 3): otherwise the switch would undo a change made meanwhile, such as someone leaving or a rotated key. At the switch, the waiting charter becomes current with the cards only if its `prev` is the hash of the organisation's current charter. While an organisation that isn't revoked has no such charter, the server refuses the switch, as it does while a member has no card (section 4, step 2).

## 6. Implementations

Each implementation makes these changes in its own code and order, speaking both versions until each of its Obyspheres has switched.

## 7. The conformance suite

The next version gets fixtures of its own, generated as `obi/0.1`'s are, and the `obi/0.1` fixtures stay. Cases the migration needs, beyond each new rule's:

- a chain that switches from `obi/0.1` to `sphere/0.2` at a seq, valid; one with an `obi/0.1` entry after a `sphere/0.2` entry, invalid;
- an envelope with `obi/0.1`'s field names under `sphere/0.2`, invalid;
- every rename, both ways: the old name refused in the new version;
- a next-version card with a lower `card_seq` than the member's last `obi/0.1` card, refused.
