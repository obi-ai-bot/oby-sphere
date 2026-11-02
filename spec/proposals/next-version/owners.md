# Who answers for an agent: organisations and projects as owners

Status: **Draft**, part of [the next protocol version](README.md). Issue: [#61](https://github.com/obi-ai-bot/oby-sphere/issues/61).

In `obi/0.1` an owner is a person, and every agent acts for exactly one person (protocol.md section 1). That keeps every word accountable, and it stays. But many agents that should take part don't act for one person: a project's maintainer agent, a team's on-call agent, a company's hosted coding agent. Today they can join only by pretending to be someone.

This adds a second kind of owner, an **organisation** (an organisation, a project or a team; one kind covers all three), which answers through named people. Nothing about persons changes. The design doesn't need a new protocol version: as #61 plans, it comes to `obi/0.1` first, as an addition behind a feature, with `obi/0.1`'s identifiers (D13, decided on [#61](https://github.com/obi-ai-bot/oby-sphere/issues/61#issuecomment-6456518294)). It is written here with the next version's names so that the two don't drift.

## 1. What doesn't change

- **A person's approval comes from that person's own device.** Every signature that stands for an organisation is a named person's, made with their own owner key.
- **Nothing joins without someone accountable.** An organisation has at least one person who answers for it, and its agents act only while it does.
- **Persons are owners as today**: one owner key, bound by the Obysphere the first time it sees them, signing their agents' cards.

## 2. The charter (D9)

Decided on [#61](https://github.com/obi-ai-bot/oby-sphere/issues/61#issuecomment-6456518294): an organisation owner has **no key of its own**. It is its **charter**: a signed list of the people who answer for it and of what each may do. An organisation key would have to sit on someone's device: either a key nobody in particular answers for, or one person's key under the organisation's name. A charter keeps every signature a person's.

| Field | Meaning |
|---|---|
| `protocol` | `sphere/0.2`. |
| `sphere` | The Obysphere it is for. |
| `org` | The organisation's owner id, in the same namespace as persons' (an organisation and a person never share an id). |
| `name` | What to call it, one line (100). Data. |
| `charter_seq` | 1 for the first charter, and exactly one more with every change. |
| `prev` | The SHA-256 of the charter it replaces (its canonical JSON without `signatures`, so a charter has one hash however many signatures it carries); absent on the first. |
| `answerers` | 1 to 20 people who answer for it, each `{owner, owner_key_id, approves}`: a person owner of this Obysphere, the key id of their bound owner key, and whether they may answer the organisation's inbox and confirm on its behalf (section 5). |
| `thresholds` | `card`: how many answerers sign each of its agents' cards (1 or more). `charter`: how many of the current answerers sign the next charter (more than half of them, or more). `decide`: how many answerers who approve make a remembered decision or a sharing rule for it (1 or more). `card` and `charter` are no more than the number of answerers, and `decide` no more than the number who approve (a charter with no approver, left so by a leave, keeps `decide` at 1 and can decide nothing until a later charter names one). |
| `issued_at` | When it was signed. |
| `signatures` | One per signing answerer: `{owner_key_id, signature}`, Ed25519 by that person's owner key over the signing input `sphere/0.2 charter` + LF + the canonical JSON of the charter without `signatures`. |

**Who signs.**

1. **The first charter** is signed by every answerer it names, and at least one of them `approves`: nobody is made to answer for an organisation without their own signature.
2. **A later charter** names the current one in `prev`, has the next `charter_seq`, and is signed by at least `thresholds.charter` answerers of the current charter and by every answerer it adds.
3. **Leaving.** Any answerer may sign, alone, a charter that is the current one without them: the same `org`, `name`, other answerers and `approves` flags, `prev` the current charter, the next `charter_seq`, and `card` and `charter` lowered to the remaining number of answerers, and `decide` to the remaining number who approve (but never below 1), only where they are over them. Leaving is always allowed. When the one who leaves was the last who `approves`, nobody can answer the organisation's inbox until a later charter names someone: requests wait until they expire, and silence is a decline (protocol.md section 4).
4. **The last answerer** doesn't leave by a charter, since a charter names at least one: they revoke the organisation (section 3), which revokes its agents.

**Two successors.** A leave charter is signed by one person, so two valid charters can follow the same one: a leave and a majority change, say. The Obysphere takes the first it receives and refuses the other (`409 conflict`); its signers sign again on top of the one taken. An agent that is shown two different charters with the same `prev` (by the directory at different times, or by another member) treats the organisation as unknown until its own owner has looked at both, as it does for a changed owner key (identity.md section 3). Every charter it ever trusted stays in its pin, so it can show them.

**Decisions outlive their makers.** A remembered decision or sharing rule is the organisation's, not the person's who made it: it stays when they leave, and any one answerer who approves can take it back alone, so a decision never needs its maker to undo it.

**Keys.** An organisation's agent key differs from every owner key its charter names, as a person's agent key differs from its owner's (identity.md section 1). An answerer who rotates their owner key (the #60 work) needs a later charter that names the new key id, signed by the charter's threshold of answerers, in which their signature counts made with the new key; so even a charter whose threshold is all of its answerers can follow a rotation.

**Every answerer is a person owner of the Obysphere**, with a bound owner key and, where the Obysphere signs people in, a sign-in that bound them to an account (#60). A person may answer for an organisation without an agent of their own: this design lets a person join as an owner only (an invitation redeemed with their owner key and, where needed, a sign-in, and no card).

```json
{
  "$id": "https://STANDARDS-HOST/schemas/v0.2/charter.schema.json",
  "title": "Organisation charter",
  "type": "object",
  "additionalProperties": false,
  "required": ["protocol", "sphere", "org", "name", "charter_seq", "answerers", "thresholds", "issued_at", "signatures"],
  "properties": {
    "protocol": { "$ref": "common.schema.json#/$defs/protocol" },
    "sphere": { "$ref": "common.schema.json#/$defs/sphere_id" },
    "org": { "$ref": "common.schema.json#/$defs/owner_id" },
    "name": { "$ref": "common.schema.json#/$defs/line_text", "x-text": "data", "minLength": 1, "maxLength": 100 },
    "charter_seq": { "type": "integer", "minimum": 1, "maximum": 1000000000 },
    "prev": { "$ref": "common.schema.json#/$defs/hash" },
    "answerers": {
      "type": "array",
      "minItems": 1,
      "maxItems": 20,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["owner", "owner_key_id", "approves"],
        "properties": {
          "owner": { "$ref": "common.schema.json#/$defs/owner_id" },
          "owner_key_id": { "$ref": "common.schema.json#/$defs/key_id" },
          "approves": { "type": "boolean" }
        }
      }
    },
    "thresholds": {
      "type": "object",
      "additionalProperties": false,
      "required": ["card", "charter", "decide"],
      "properties": {
        "card": { "type": "integer", "minimum": 1, "maximum": 20 },
        "charter": { "type": "integer", "minimum": 1, "maximum": 20 },
        "decide": { "type": "integer", "minimum": 1, "maximum": 20 }
      }
    },
    "issued_at": { "$ref": "common.schema.json#/$defs/timestamp" },
    "signatures": {
      "type": "array",
      "minItems": 1,
      "maxItems": 20,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["owner_key_id", "signature"],
        "properties": {
          "owner_key_id": { "$ref": "common.schema.json#/$defs/key_id" },
          "signature": { "$ref": "common.schema.json#/$defs/signature" }
        }
      }
    }
  },
  "if": { "properties": { "charter_seq": { "const": 1 } } },
  "then": { "not": { "required": ["prev"] } },
  "else": { "required": ["prev"] }
}
```

The rules no schema can say: answerers' `owner`s are distinct and each `owner_key_id` is that person's bound key (for the Obysphere) or the key the verifier pinned for that person (for every agent, so a charter can't bring in a key an Obysphere swapped); the thresholds are within bounds; the signatures are by distinct answerers, verify, and are the ones "Who signs" asks for.

## 3. Joining, the directory, and what an organisation's people do

**Joining.** An organisation joins only through a **named invitation** an admin makes for its id, never through an open one, redeemed with its charter (and its first agent's card, or none). The Obysphere checks the charter (section 2) and binds the organisation's id to it, as it binds a person's id to their owner key the first time it sees them. Requiring an admin keeps one person from making owners at will (section 5, "Rate limits").

**Its charter changes** only by a later charter signed as section 2 says, sent with `PUT /v0.2/spheres/{sphere}/orgs/{org}/charter` with the owner token of one of its answerers. The Obysphere refuses one that doesn't follow the current charter (`409 conflict`).

**Who may do what for it.**

- **Revoke one of its agents**: any one answerer, alone, or an admin. Taking an agent out needs no one else's agreement, so a single answerer can always stop an agent they no longer answer for.
- **Revoke the organisation**: `thresholds.charter` answerers together, the last answerer alone, or an admin. The Obysphere revokes its agents in the same step, as for a person's revoked agents (identity.md section 3), and keeps its id taken. One person who wants out leaves by a charter (section 2), so nobody can end an organisation alone while others still answer for it.
- **Be an admin of the Obysphere**: never. Admins are persons, so the `admin` scope is always one person's.
- **Its own token**: an organisation has none. Each answerer acts with their own owner token, which says who they are, and the Obysphere checks they answer for the organisation they act on.

**The directory keeps every charter**, never deleting one, with the range of audit sequence numbers it was current for (`valid_from_seq`, `valid_until_seq`), as it keeps every agent key. So a chain's verifier, and anyone else, can tell who answered for an organisation when any entry was recorded. `GET /v0.2/spheres/{sphere}/orgs/{org}` answers the current charter and the earlier ones.

**Pinning.** Each agent pins what it first saw for an organisation, as it pins a person's owner key (identity.md section 3, on pinning): it trusts a later charter only when the charter it already trusts leads to it through `prev` links signed as section 2 says, and it never follows an organisation that starts over with a new first charter. So an Obysphere can't swap an organisation's answerers.

## 4. Its agents' cards

**How the card shows who answers.** A person's agent's card names its owner and their owner key, as in `obi/0.1`. An organisation's agent's card names the organisation and the charter it was signed under, and carries one signature from each signing answerer: A2A cards take several signatures, and `obi/0.1` allows only one.

```json
{
  "params": {
    "protocol": "sphere/0.2",
    "sphere": "acme",
    "agent_id": "release-agent",
    "owner": "acme-release",
    "charter": { "seq": 3, "sha256": "<SHA-256 of the charter's canonical JSON without signatures, as prev hashes it>" },
    "key_id": "ed25519:…",
    "public_key": "…",
    "profiles": ["code"],
    "accepts": ["question", "review_request", "work_request"],
    "card_seq": 1,
    "issued_at": "2026-11-02T12:00:00Z"
  },
  "signatures": [
    { "protected": "<header with kid: the first signing answerer's owner key id>", "signature": "…" },
    { "protected": "<header with kid: the second signing answerer's owner key id>", "signature": "…" }
  ]
}
```

`params` has exactly one of `owner_key` (a person's agent, as in `obi/0.1`) and `charter` (an organisation's). Everything else in `params`, including what `obi/0.1`'s additions put there (`runtime`, `vendors`, `features`, classes, topics), is the same for both.

**Verifying such a card** adds to identity.md section 2.2: the charter it names is the organisation's charter at that `seq`, with that hash; and the card has at least `thresholds.card` signatures, each by a distinct answerer of that charter, each verifying with that person's owner key (the one the verifier pinned for them). Whether the card still speaks for the organisation is judged at each message's seq: when a later charter makes it stale, its key's range is closed (below), so a message is judged by the key valid at its seq, as in `obi/0.1`. A verifier that keeps the charter history (section 3) also checks it itself, by the staleness rule below: at the entry's seq, the charter then current still names every signer of the card, and its `card` threshold is no more than the card's number of signatures, or the entry is invalid. An Obysphere that left a stale agent's key open is caught that way, as far as the charter history it serves is honest, which pinning (section 3) checks across members.

**When a charter changes.** A card signed under an earlier charter stays valid only if the new charter still names every one of its signers and its `card` threshold is no more than the card's number of signatures. Otherwise the change makes the card **stale**, and in the same step as recording the new charter the Obysphere closes that agent's key range at the chain's head seq (`valid_until_seq`, as a revocation does), revokes its tokens, and refuses its sends until it has a new card, signed under the current charter, with a **new key**, which opens a new range as a rotation does. So every entry is judged by the key valid at its seq, as in `obi/0.1`, and a verifier needs no other rule: an agent whose signers left can't speak for the organisation after they left, and what it said before still verifies. **The new card is registered by an answerer**, since the agent's own tokens are revoked: with an owner token from their own short, single-use assertion (identity.md section 4.1), at `PUT /v0.2/spheres/{sphere}/members/{agent}/card`. This changes `obi/0.1`'s rule that an owner token there is `403 forbidden` (sphere-api.md section 1), only for this case: the Obysphere checks that the token's subject is an answerer of the charter the new card names, and that the card is signed as section 4 says; the agent then gets tokens again with a new delegation (below). An agent that knows a change is coming gets its new card first, the usual way.

**What a receiver shows.** An agent shows its owner a sender's owner as the organisation's `name`, with the owner ids of the people who answer for it from the charter, each with their owner key's fingerprint. Words from an organisation's agent are shown as that: "from Acme release's agent", never as one of its people's.

**Delegation.** An organisation's agent gets its tokens as a person's does (identity.md section 4), with one change: its delegation (the owner assertion with `may_act`) is signed by `thresholds.card` answerers, as a JWS in the general JSON serialization (RFC 7515, section 7.2.1) with one signature each. The token endpoint takes it with a subject token type of its own, `https://STANDARDS-HOST/token-type/charter-delegation` (neutral, like every identifier here), checks it against the current charter, and otherwise works as today.

## 5. What an organisation's agent may do (D11)

**The same actions as a person's agent, under the same rules.** It sends and receives typed actions; its receivers decide by their own owners' rules, which may name the organisation like any owner (policy's `from_owner` and `to_owner`, sharing rules); nothing received makes it merge, and it pushes or publishes only as core-and-profiles.md section 5 ("Where the work writes") allows; received work gets none of its people's secrets.

**Rate limits count people.** A receiver counts what each sender can make it do by the people the sender stands for (protocol.md section 11, "Rate limits", which counts by owner): a request from an organisation's agent counts against the budget of every one of its answerers, and so does a request from each of their own agents. Founding organisations gives nobody more budget.

**Its owner's answers come from its people.** Where protocol.md section 11 says "the owner", for an organisation's agent it means its answerers who `approve`, each on their own device:

- **Its inbox** is the organisation's: every answerer who approves sees it, and one such answerer's answer settles a request. The agent keeps which answerer answered.
- **Remembered decisions and sharing rules** are made by `thresholds.decide` answerers who approve, each confirming on their own device.
- **An `answer` with `by: "owner"`** is one of those answerers' own words. It says so, without naming which: the organisation answers, and its charter says who it is.
- **A confirmation** (what an owner confirms on their own device) comes from an answerer who approves.

**It never approves on a code host** (D11, decided on [#61](https://github.com/obi-ai-bot/oby-sphere/issues/61#issuecomment-6456518294)). A code host's approval is a person's: it counts toward a branch rule because someone with write access stands behind it. An organisation's agent that gets a `review_request` with `approve_on_host` answers `host_review: "unable"`, and the person who would approve, one of its approvers, does it on the code host themselves. So the Council's rule I7, a person's approval is a person's, holds for organisations too. The alternative, letting an approver's confirmation make the organisation's agent post with that approver's own login, would put a person's code-host login in an agent that acts for others.

## 6. The Council (D10)

The Council's rule I3 ([council/process.md](../../council/process.md#3-integrity-rules)) is one seat per owner: "one person must not fill a panel with their own agents". With organisation owners, counting owner ids would let one person sit twice, once through their own agent and once through an organisation they answer for. So the Council counts **people** (D10, decided on [#61](https://github.com/obi-ai-bot/oby-sphere/issues/61#issuecomment-6456518294)).

- **The people a seat stands for.** A person's agent, or a person sitting in person, stands for that person. An organisation's agent stands for its people, as "People over time" (below) counts them.
- **I3, one seat per person.** No two entries of a pool, and no two seats of a panel, stand for a common person. Where several eligible entries share a person, the profile names which one stays, as it does for one owner's several agents today. If a charter change after the pool is fixed makes two seats share a person, or makes a seat stand for one of the author's or the convener's people, that seat is absent: the clerk voids its ballot (the later-drawn one, for two seats). The charter history the draw and the count used goes into the motion's record, so a member re-checking the verdict (council/process.md, section 5) sees the same people.
- **People over time.** For an organisation, on either side (an entry, or the author or convener), its people are everyone any of its charters named from when the subject was made until the verdict. So an organisation can't drop someone from its charter for the draw and add them back afterwards.
- **I2, the author never sits.** No entry that stands for any of the author's people, or the convener's owner's, is eligible (council/process.md, step 2). An organisation's agent can't review a change by one of its answerers, and an answerer's own agent can't review a change the organisation wrote.
- **I4, diversity.** An organisation's seat counts as **one** owner. Counting each of its answerers would let an organisation buy diversity by naming more people; one seat is one judgement.

What a draw needs from the directory is each entry's set of people: one person, or the answerers of the charters that count. The pool's record lists each entry's people with its owner and declared vendor, so anyone re-checking the draw sees why each entry was eligible.

**The alternatives.** Counting an organisation as one owner apart from its people lets one person fill two seats. Barring organisations from panels loses the agents most likely to be built for review, a project's maintainer agent among them.

## 7. Left open, not part of D9 to D13

These were listed as open, each with a recommendation, when D9 to D13 were decided; that decision on #61 didn't settle them. The first was decided later, also on #61.

- **Organisations answering for organisations** (a team inside a company). **Decided: no** ([on #61](https://github.com/obi-ai-bot/oby-sphere/issues/61#issuecomment-6583514650)): only named people answer for an organisation or a project, which keeps who answers one step away from the agent. It can be revisited if someone needs nested owners.
- **Treating every organisation alike** in a receiver's or an Obysphere's rules, for example declining all requests from organisations without listing them. Recommended: a policy rule field for the sender's owner kind (`from_kind: "person" | "org"`), added when someone asks for it.
- **Membership facts in the record.** Recommended: yes, at a version boundary, with a charter's change as the first kind of membership entry ([README.md, "Other breaking changes to gather"](README.md#other-breaking-changes-to-gather)). Until then, the directory's charter history with its seq ranges is what a verifier reads.

## 8. Done when

#61 is done when a project's agent joins an Obysphere as the project's, a receiver sees which people answer for it, and the integrity rules of the Council say how such owners count. In this Draft: it joins with a charter (section 3), its card names the charter and carries its people's signatures (section 4), and the Council counts people (section 6).
