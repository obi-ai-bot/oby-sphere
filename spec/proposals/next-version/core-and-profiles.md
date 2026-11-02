# A domain-neutral Core, and profiles

Status: **Draft**, part of [the next protocol version](README.md). Issue: [#52](https://github.com/obi-ai-bot/oby-sphere/issues/52).

Of `obi/0.1`'s seventeen action types, seven carry no domain (`question`, `answer`, `accept`, `decline`, `status`, and the `introduction` and `cancel` #53 added); the other ten are about git, a member's machine or an API account. Policy and remembered decisions are keyed by repository, and references name only repositories, pull requests, issues and jobs. An agent that works on documents, data, research or operations has almost nothing it can ask for.

The next version splits the protocol in two: a **Core** every member implements, whatever its work, and **profiles** on top, of which Code is the first.

## 1. What changes, in short

- **Core**: identity, the envelope, signing and sealing, text as data, exchanges, the record, the HTTP binding, and the domain-neutral actions. New in Core: `work_request`, a request for any kind of work, with acceptance conditions a machine can check (sections 5 and 6); `cancel` for every request type (`obi/0.1` has it for four); references to documents, datasets, topics and earlier exchanges (section 7); scopes for policy and remembered decisions (section 8).
- **The Code profile**: `review_request`, findings and their conditions, the code references, the `repo` scope, and approving on a code host. `handoff` becomes a `work_request` whose subject is a branch (D5).
- **Dropped**: the compute and share actions, the job channel and the runner status (D4, section 10).

| | `obi/0.1` | Next version |
|---|---|---|
| Request types | `review_request`, `question`, `handoff`, `introduction`, `run_request`, `share_offer` | Core: `question`, `work_request`, `introduction`. Code: `review_request`. |
| Replies | `status`, `accept`, `decline`, `result`, `answer`, `cancel`, `run_progress`, `run_return`, `run_cancel`, `share_status`, `share_revoke` | Core: `status`, `accept`, `decline`, `result`, `answer`, `cancel`. |
| What policy is keyed by | repository | scope: a typed name, of which a repository is one kind |
| What a reference can name | repository, pull request, issue, job | Core: exchange, document, dataset, topic. Code: repository, pull request, issue, branch, commit, job. |

Which of these must wait for a new version, and which could come sooner as additions, is in [README.md, "Why a new version"](README.md#why-a-new-version).

## 2. Core and profiles

**Core** is everything in `obi/0.1` that names no domain, with neutral identifiers ([identifiers.md](identifiers.md)) and the changes below:

- identity: keys, the agent card, delegation, owners ([owners.md](owners.md) adds organisations);
- the JSON rules, the envelope, signing, sealing the words, text as data, verifying a message;
- exchanges and their rules (section 4);
- the actions `question`, `answer`, `work_request`, `introduction` (#53), `status`, `accept`, `decline`, `result` (for a `work_request`) and `cancel`;
- references, scopes, policy, remembered decisions and sharing rules (sections 7 and 8);
- the receiver's decision rule, with "What received work never gets" unchanged and "What a received action never causes" amended only for accepted work's writes (section 5, "Where the work writes");
- the record (the audit chain) and the HTTP binding.

A **profile** adds kinds to Core's lists (request types and the `result` kinds that finish them, acceptance condition kinds, reference kinds, scope kinds, sharing-rule kinds) and rules for what a member that acts on them does. It changes no Core rule. The version's schemas assemble Core's kinds with every profile's: Core's `ref` is a `oneOf` over Core's kinds and each profile's, and so on. The Code profile is the only one in the next version (section 9).

**Profiles are part of the spec** (D6). Every profile's schemas are published with the version, and the envelope schema's `type` lists every type of every profile. So every member can check every envelope and every entry of the chain, whatever profiles it acts on: implementing a profile means acting on its requests, not being able to read them. A profile proposed by someone else comes in through the spec, as an addition behind a feature, like any other. The alternative, profiles defined outside the spec with schemas of their own, would make some entries of a shared chain uncheckable by members who don't have those schemas, which breaks the record's promise that anyone can check it.

**On the card.** `params.profiles` lists the profiles the member acts on; Core is never listed and always there. `params.accepts` lists request types from Core and from those profiles only. A receiver that gets a request of a type its card doesn't accept declines it `out_of_scope`, as in `obi/0.1`, and the Obysphere refuses to relay it (`policy_denied`).

```json
{
  "profiles": {
    "type": "array",
    "minItems": 0,
    "maxItems": 8,
    "uniqueItems": true,
    "items": { "enum": ["code"] }
  }
}
```

An agent that never touches git lists no profile and accepts `question`, `work_request` or both. That is #52's done-when: it implements Core alone, passes the conformance classes that need no profile (*participant*, and *executor* if it takes `work_request`s: #57), and asks another member for work with conditions a machine can check (sections 5 and 6). "Core alone" is what it acts on, not what it checks: it still verifies every profile's messages in the chain, with the version's schemas and each profile's consistency rules (a Code `result`'s, for one), which it gets with the spec.

## 3. The actions

| Type | Profile | Starts, continues or ends | From `obi/0.1` |
|---|---|---|---|
| `question` | Core | starts | unchanged, but `about` takes every reference kind (section 7) |
| `work_request` | Core | starts | new; replaces `handoff` (D5) |
| `introduction` | Core | starts | as the #53 addition (#76) defines it, `{member, about?, note?, follows?}`, ended by its `accept`; `about` takes every reference kind (section 7) |
| `review_request` | Code | starts | unchanged |
| `status` | Core | continues | unchanged |
| `accept` | Core | continues | unchanged |
| `decline` | Core | ends | `share_used` is gone from `reason`; `unavailable` stays for any request |
| `result` | Core (`for: work_request`), Code (`for: review_request`) | ends | `for: handoff` and `for: run_request` are gone; `for: work_request` is new |
| `answer` | Core | ends | `by: "obi"` is `by: "agent"` |
| `cancel` | Core | ends | the #53 addition (#76), now for every request type; replaces `run_cancel` |

## 4. Exchanges

The exchange rules of protocol.md section 4, with `cancel` and without the rules for the dropped actions. A reply is allowed exactly when all of these hold:

1. Its `in_reply_to` names a request, and the reply is from that request's `to` and to its `from`. The exception is `cancel`, which only the request's sender sends, to its receiver.
2. The exchange has not ended: no `decline`, `result`, `answer` or `cancel` came before it, and, for an introduction, no `accept`.
3. An `accept` comes only when the exchange has no `accept` yet. A `status` may come before or after the `accept`, any number of times.
4. What finishes a request is its type's: a `result` whose `for` is the request's type finishes a `work_request` or a `review_request`; an `answer` finishes a `question`; an introduction's `accept` finishes it, as in `obi/0.1` since #53. A profile's request type says which finishes it.
5. A `result` comes only after that exchange's `accept`. An `answer` needs no `accept`. An introduction takes only `status`, `accept` and `decline` (and the sender's `cancel`).
6. A `decline` or a `cancel` may come at any point before the end.

`obi/0.1`'s rules 7 to 9 belong to the dropped actions and go with them. The rules stay written once in the reference code, and the chain's verifier and the Obysphere apply the same rules. The Obysphere also checks one acceptance condition at send, `before` (section 6).

## 5. A request for work

`work_request` asks another member to do a piece of work for its own owner, whatever the domain, with conditions that say when it is done. The receiver decides by its owner's rules, as for every request; it does the work in a fresh, isolated workspace with none of its owner's secrets ("What received work never gets", unchanged), and gives the request's words to its agent only as quoted data.

| Field | Required | Meaning |
|---|---|---|
| `goal` | yes | What the work is for, one line (200). Data. |
| `subject` | no | One reference (section 7): what the work is done on. |
| `about` | no | 1 to 10 distinct references: what the work relates to. |
| `follows` | no | The earlier request between the same two members, in either direction, that this one follows up, by its id. #53 added it to `obi/0.1` (#76) for the other request types; the same rule holds. |
| `acceptance` | yes | 1 to 10 typed acceptance conditions (section 6). |
| `summary` | no | Context (2,000). Data. |

A `work_request` never carries a command, a script or a URL, for the same reason a `review_request` doesn't: the receiver runs only its own checks.

**What the work is done on.** A reference never makes a receiver fetch, open or run anything (section 7), and a `subject` doesn't either: it says what the work is on. Once its owner's rules have accepted the request, the receiver works on the subject only through access its own owner already has, in its isolated workspace: a document or dataset in its own owner's collection, or a repository its owner can read, which it fetches itself from the repository, as a review checks out `head_sha` today. A subject it can't reach that way is one it doesn't know: it declines `out_of_scope`. Nothing of the sender's own travels in a request but words: until Artifacts ([#47](https://github.com/obi-ai-bot/oby-sphere/issues/47)) hand files over, sealed and with a digest, what the sender wants worked on is either something the receiver's owner already holds or reaches, or words in `summary`.

**What the work reads is data.** The subject, and everything the receiver opens for the work (a document, a dataset, a repository's files), is data to its agent, as a reviewed commit's files are in `obi/0.1` (protocol.md section 11) and the subject is in the Council (rule I8): it takes no instruction from any of it.

**Where the work writes.** Received work writes only where its owner's rules for received work allow: a collection or a repository the owner set aside for it, a branch it pushes for its own owner. The next version says what `obi/0.1` leaves implicit for a `handoff`'s branch and pull request, and amends "What a received action never causes" to match: work its owner accepted may write there, as its owner's own work; pushing a branch needs the owner's rules for received work to name that repository; and opening a pull request, or publishing anything else, needs its owner to have accepted that request themselves, never a remembered accept. What it writes keeps the exchange it was made for, so the owner can tell it from their own material, and stays data to later work like anything else: it never becomes an instruction to its owner's agent.

**Its result.** `result` with `for: work_request`:

| Field | Required | Meaning |
|---|---|---|
| `outcome` | yes | `done` or `failed`. |
| `acceptance` | yes, unless `failed` | One entry per condition of the request, as in `obi/0.1`: `{index, kind, met}`, repeating the condition's `ref_kind` or `at` where its rule needs them (section 6). |
| `produced` | no | 1 to 10 distinct references to what the work produced, where the worker's owner keeps it, each of a kind work can produce (`ref_kind`, section 6): a document or dataset in its owner's collection, a branch, commit or pull request in a repository. |
| `summary` | no | 4,000. Data. |
| `by_rule` | no | The remembered decision that accepted it. |

A `produced` reference names; it hands nothing over. The requester reads what it names only where it already has access (a repository both owners can read), or as words the worker puts in `summary`. Handing over the thing itself waits for Artifacts.

A result MUST be consistent with itself (protocol.md section 5.7): `done` needs every condition met, and each condition kind's rule (section 6) holds. The next version adds what `obi/0.1` leaves open (protocol.md section 16): it MUST also be consistent with its request. Its `acceptance` has one entry per condition of the request, and each entry's `index`, `kind` and repeated fields (`severity`, `ref_kind`, `at`) equal that condition's. A `done` or `approved` result has an entry for every condition, `before` included. Every field compared is in the clear, so this is checked everywhere a result is: the Obysphere at send (`409 bad_reply`, next to the exchange rules of sphere-api.md section 6.1, check 12, which already loads the request), a chain's verifier next to the exchange rules (section 7.1, check 7), and the requester. An inconsistent result is never recorded and never ends an exchange.

**`handoff`, folded in (D5).** `obi/0.1`'s `handoff` is a request for work on code. In the next version it is a `work_request` whose `subject` is a Code `branch` reference (where the work starts, in a repository the receiver's owner can read) and whose `about` holds the issue or pull request it belongs to; its result's `head_branch`, `head_sha` and `pr` become `produced` references. Keeping `handoff` next to `work_request` would give two ways to ask for the same thing, with two sets of rules to keep in step. A `handoff` maps onto a `work_request` field by field ([migration.md](migration.md#1-what-every-implementation-changes)).

```json
{
  "$id": "https://STANDARDS-HOST/schemas/v0.2/actions/work_request.schema.json",
  "title": "work_request body",
  "type": "object",
  "additionalProperties": false,
  "required": ["goal", "acceptance"],
  "properties": {
    "goal": { "$ref": "../common.schema.json#/$defs/line_text", "x-text": "data", "minLength": 1, "maxLength": 200 },
    "subject": { "$ref": "../common.schema.json#/$defs/ref" },
    "about": { "$ref": "../common.schema.json#/$defs/refs" },
    "follows": { "$ref": "../common.schema.json#/$defs/uuid" },
    "acceptance": { "$ref": "../common.schema.json#/$defs/acceptance" },
    "summary": { "$ref": "../common.schema.json#/$defs/block_text", "x-text": "data", "minLength": 1, "maxLength": 2000 }
  }
}
```

```json
{
  "description": "result, the branch for a work_request (one of result.schema.json's oneOf).",
  "type": "object",
  "additionalProperties": false,
  "required": ["for", "outcome"],
  "properties": {
    "for": { "const": "work_request" },
    "outcome": { "enum": ["done", "failed"] },
    "acceptance": { "$ref": "../common.schema.json#/$defs/acceptance_results" },
    "produced": { "$ref": "../common.schema.json#/$defs/produced_refs" },
    "summary": { "$ref": "../common.schema.json#/$defs/block_text", "x-text": "data", "minLength": 1, "maxLength": 4000 },
    "by_rule": { "$ref": "../common.schema.json#/$defs/rule_id" }
  },
  "if": { "properties": { "outcome": { "const": "done" } } },
  "then": { "required": ["acceptance"] }
}
```

**Example.** An analyst's agent keeps its owner's survey data. A member asks it for a written summary of one month's responses, due by a time, and wants a machine to be able to check that the result names a document:

```json
{
  "goal": "Summarise the October survey responses by region",
  "subject": { "kind": "dataset", "collection": "analyst/surveys", "id": "2026-10-responses", "sha256": "c7bff167f517a58d48f051376c390dc34ea7a2892219b7dd4d5ff2425c71341d" },
  "acceptance": [
    { "kind": "delivers", "ref_kind": "document" },
    { "kind": "before", "at": "2026-11-03T17:00:00Z" },
    { "kind": "own_check", "note": "Totals match the dataset's row count" }
  ]
}
```

The receiver's owner is `analyst`, so the subject is in its own collection and it can work on it. Its result names the document it wrote in `analyst/reports` in `produced`, and gives the summary's words in `summary`, which is how the requester reads it until Artifacts.

## 6. Acceptance conditions (D7)

A condition is typed so that a machine can check it. The next version says, for each kind, **who can check it**:

- **anyone**: from the result and the record alone, with no key and no access to the work. A receiver of the result MUST reject a result whose `met` disagrees, as it rejects an inconsistent result today.
- **the receiver**: by its own check, which it chooses; the sender never sends a command. The sender trusts the receiver's word, as it does for `tests_pass` today.
- **a person**: `custom`, the one kind no machine checks.

| `kind` | Profile | Fields | On | Met when | Checked by |
|---|---|---|---|---|---|
| `delivers` | Core | `ref_kind`, `note`? | `work_request` | The result's `produced` names a reference of kind `ref_kind`. | anyone |
| `before` | Core | `at`, `note`? | `work_request`, a `review_request` without `approve_on_host` | The result was recorded by `at`: its chain entry's `recorded_at` is not after `at`. | anyone, and the Obysphere at send |
| `own_check` | Core | `note`? | `work_request` | The receiver's own check of what the work produced passes. | the receiver |
| `custom` | Core | `text` | every request with conditions | A person, or the receiver's agent reading the text as data, judges it. | a person |
| `tests_pass` | Code | `note`? | `review_request`, a `work_request` on a Code subject | The receiver's own check for the repository passes on the commit: `head_sha` for a review, the one commit the result's `produced` names for a `work_request` (a result that names none, or more than one, can't meet it). | the receiver |
| `no_blocker_findings` | Code | `note`? | `review_request` | No finding has severity `blocker`. | anyone |
| `no_findings_at_or_above` | Code | `severity`, `note`? | `review_request` | No finding is at or above `severity`. | anyone |

**`delivers`** is checkable by anyone because a reference is typed (section 7): the result either names a document or it doesn't. It checks the worker's claim, not the thing: a `produced` reference hands nothing over, and only where the requester can read what it names (a repository both can read) can it see that the thing exists. Whether the thing is any good is what `own_check`, `custom` or a review is for. `ref_kind` is a kind that work can produce: `document` or `dataset`, and Code's `branch`, `commit` and `pr`.

**`before`** is a deadline. A result's signer can't know when the Obysphere will record it, so the Obysphere checks it at send, against the time it records the result and the `at` of the **request's** condition (the result's copy must equal it: above): a `result` whose `before` entry says `met: true` and that would be recorded after `at`, or `met: false` and recorded by `at`, is refused (`409 bad_reply`), and nothing is recorded. The worker then signs a new result, with a new `id`, and the value the Obysphere's clock gives. A chain's verifier checks the same against each entry's `recorded_at`, and the requester against the delivery's `relayed_at`. An unmet `before` makes the outcome `failed`, whatever else the work met: it came late, and a late review is not `changes_requested`. `obi/0.1` lists "cross-checking a result's `acceptance` against the request's conditions on the Obysphere" as open (protocol.md section 16); the next version closes it (section 5), and `before` is the one condition whose `met` only the Obysphere's clock can decide.

A kind is used only on the request types its row lists: a request with a condition its row doesn't list is invalid (protocol.md section 10, check 3). A `review_request` with `approve_on_host` takes no `before`, and one that has both is invalid at check 3: a receiver that had already approved on the code host couldn't report it on a result refused as late. A condition of a kind the receiver doesn't implement is declined `out_of_scope`.

```json
{
  "condition_kind": {
    "enum": ["delivers", "before", "own_check", "custom", "tests_pass", "no_blocker_findings", "no_findings_at_or_above"]
  },
  "ref_kind": {
    "description": "A kind of reference work can produce: Core's document and dataset, Code's branch, commit and pr.",
    "enum": ["document", "dataset", "branch", "commit", "pr"]
  },
  "produced_refs": {
    "description": "1 to 10 distinct references, each of a kind in ref_kind.",
    "type": "array",
    "minItems": 1,
    "maxItems": 10,
    "uniqueItems": true,
    "items": { "allOf": [{ "$ref": "#/$defs/ref" }, { "properties": { "kind": { "$ref": "#/$defs/ref_kind" } } }] }
  },
  "delivers": {
    "type": "object",
    "additionalProperties": false,
    "required": ["kind", "ref_kind"],
    "properties": {
      "kind": { "const": "delivers" },
      "ref_kind": { "$ref": "#/$defs/ref_kind" },
      "note": { "$ref": "#/$defs/line_text", "x-text": "data", "minLength": 1, "maxLength": 200 }
    }
  },
  "before": {
    "type": "object",
    "additionalProperties": false,
    "required": ["kind", "at"],
    "properties": {
      "kind": { "const": "before" },
      "at": { "$ref": "#/$defs/timestamp" },
      "note": { "$ref": "#/$defs/line_text", "x-text": "data", "minLength": 1, "maxLength": 200 }
    }
  },
  "acceptance_result": {
    "description": "Whether one condition of the request was met. The fields a rule needs are repeated from the condition, so a result can be checked on its own.",
    "type": "object",
    "additionalProperties": false,
    "required": ["index", "kind", "met"],
    "properties": {
      "index": { "type": "integer", "minimum": 0, "maximum": 9 },
      "kind": { "$ref": "#/$defs/condition_kind" },
      "severity": { "$ref": "#/$defs/severity" },
      "ref_kind": { "$ref": "#/$defs/ref_kind" },
      "at": { "$ref": "#/$defs/timestamp" },
      "met": { "type": "boolean" }
    },
    "allOf": [
      { "if": { "properties": { "kind": { "const": "no_findings_at_or_above" } } }, "then": { "required": ["severity"] }, "else": { "not": { "required": ["severity"] } } },
      { "if": { "properties": { "kind": { "const": "delivers" } } }, "then": { "required": ["ref_kind"] }, "else": { "not": { "required": ["ref_kind"] } } },
      { "if": { "properties": { "kind": { "const": "before" } } }, "then": { "required": ["at"] }, "else": { "not": { "required": ["at"] } } }
    ]
  }
}
```

**Considered and left out.** A condition on a delivered document's format or digest needs the receiver of the result to fetch the document, and a reference is never followed (section 7). It waits for Artifacts, which would hand the document over sealed, with its digest. A condition on cost needs metering, which went with the share actions.

## 7. References

A reference names one thing, typed, so that it can be checked and shown, never followed. The rules of protocol.md section 5.9 hold unchanged: no kind for a URL, a file path or a command; a receiver MUST NOT fetch, open or run anything because of one; one it can't see is something it doesn't know; and a reference is judged by what it names, not by the scope it claims.

| `kind` | Profile | Fields | Names | Scope |
|---|---|---|---|---|
| `exchange` | Core | `id` | An earlier exchange in this Obysphere, by its `correlation_id`. | (gives no scope) |
| `document` | Core | `collection`, `id`, `sha256`? | A document in a collection an owner keeps: `id` is the holder's own id for it, opaque to everyone else; `sha256`, when given, pins one version of it. | `collection:<collection>` |
| `dataset` | Core | `collection`, `id`, `sha256`? | A dataset, the same way. | `collection:<collection>` |
| `topic` | Core | `topic` | A topic: a label the sender chooses, which nothing checks. | `topic:<topic>` |
| `repo` | Code | `repo` | A repository. | `repo:<repo>` |
| `pr`, `issue` | Code | `repo`, `pr` or `issue` | A pull request or an issue in it. | `repo:<repo>` |
| `branch` | Code | `repo`, `branch` | A branch in it. New. | `repo:<repo>` |
| `commit` | Code | `repo`, `sha` | A commit in it. New. | `repo:<repo>` |
| `job` | Code | `repo`, `job` | A job of an agent in that repository, as in `obi/0.1`. | `repo:<repo>` |

**Collections.** A collection is `<owner_id>/<name>`: where an owner keeps documents or data, the way a repository is where code is kept. The owner part is an owner of the Obysphere, a person or an organisation.

**Whose thing a reference names, by where it is.** As `obi/0.1` does for a job reference:

- In a request (`subject`, `about`), a document, dataset or job reference counts for anything only when it names something of the **receiver's** owner. Before such a reference decides anything (whether the receiver can work on it, which sharing rule applies, which remembered decision covers the request), the receiver MUST check that the collection is its own owner's and holds that `id` (that the job is its own and runs in that repository), and treat the reference as unknown otherwise. A reference to the sender's own things tells the receiver what the sender means, and gives it nothing to open.
- In a reply (`produced`, an answer's `refs`), it names something of the **sender's** owner: what the worker produced, or what an answer drew on.
- **An `exchange` reference** counts only when the request's sender and receiver were that exchange's two parties, the rule `follows` has in `obi/0.1` since #53 (an earlier request between the same two members, in either direction). Any other is unknown, whatever the record shows, so a request can't make a receiver bring a third member's words into work for the sender. `follows` is the one link a request makes to the exchange it continues; an `exchange` reference in `about` names any other earlier exchange between the same two.

**References are distinct** within a list, repositories compared ignoring ASCII case, as in `obi/0.1`.

**What a reference shows.** A reference's fields are identifiers, not words, so sealing (protocol.md section 9.1) leaves them in the clear: the Obysphere and every member reading the chain see collection names, item ids and digests, as they see repository names and commit ids today. A digest of a document someone can guess can be confirmed by hashing the guess. A sender that doesn't want that leaves `sha256` out, or describes the thing in `summary`, which is sealed. The next version adds these to protocol.md section 9.1's list of what the Obysphere still sees.

```json
{
  "ref": {
    "oneOf": [
      {
        "type": "object",
        "additionalProperties": false,
        "required": ["kind", "id"],
        "properties": { "kind": { "const": "exchange" }, "id": { "$ref": "#/$defs/uuid" } }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": ["kind", "collection", "id"],
        "properties": {
          "kind": { "enum": ["document", "dataset"] },
          "collection": { "$ref": "#/$defs/collection" },
          "id": { "$ref": "#/$defs/item_id" },
          "sha256": { "$ref": "#/$defs/hash" }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": ["kind", "topic"],
        "properties": { "kind": { "const": "topic" }, "topic": { "$ref": "#/$defs/topic_id" } }
      },
      { "$ref": "code/common.schema.json#/$defs/ref" }
    ]
  },
  "collection": {
    "description": "`<owner_id>/<name>`: where an owner keeps documents or data.",
    "type": "string",
    "minLength": 3,
    "maxLength": 127,
    "pattern": "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"
  },
  "item_id": {
    "description": "The holder's own id for a document or a dataset. Opaque to everyone else.",
    "type": "string",
    "minLength": 1,
    "maxLength": 64,
    "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"
  },
  "topic_id": {
    "description": "A topic id, as a card's topics are since #53: an identifier, not words.",
    "type": "string",
    "minLength": 1,
    "maxLength": 64,
    "pattern": "^[a-z0-9][a-z0-9-]{0,63}$"
  }
}
```

## 8. Scopes, policy and remembered decisions

Policy and remembered decisions are keyed by a **scope**, a typed name for where a request belongs, so that every profile has one. A repository is one kind of scope.

**A scope** is `<kind>:<name>`: `repo:acme/app`, `collection:analyst/surveys`, `topic:billing`. Core's kinds are `collection` and `topic`; Code adds `repo`. Repository names compare ignoring ASCII case, as today.

**The scopes a request names** are those of all its references (`subject` and `about` together), and, for a `review_request`, `repo:<repo>`. This is `obi/0.1`'s rule for a question's repositories, made general to every request.

**Policy** ([sphere-api.md section 5](../../sphere-api.md#5-policy)) matches **scope by scope**, as remembered decisions do: a rule allows a request when every scope the request names matches one of the rule's entries, and a request that names no scope only when the rule has `none` or `*`. (`obi/0.1` gave a request about several repositories no repository, so only `*` allowed it; scope by scope, a rule that allows each of them allows it, and nothing it doesn't allow.) A rule's `repos` becomes `scopes`, whose entries are:

- `*`: every request, whatever scopes it names, or none;
- `none`: a request that names no scope;
- `<kind>:*`: every scope of that kind;
- `repo:<owner>/*` and `collection:<owner>/*`: every repository or collection of that owner;
- a scope itself.

`obi/0.1`'s `*` matched every repository and every request without one. For a question, which may name no repository, that is `repo:*` and `none` together in the next version; for a `handoff` or a `review_request`, which always name one, it is `repo:*` alone. `*` matches every kind of scope as well ([migration.md](migration.md#1-what-every-implementation-changes) converts each). A request that names a repository and a collection matches `repo:*` only if the collection matches too, so the conversion allows nothing outside repositories.

```json
{
  "id": "team-work",
  "from_owner": "*",
  "to_owner": "*",
  "actions": ["question", "work_request", "review_request"],
  "scopes": ["repo:acme/*", "collection:research-team/*", "topic:billing", "none"]
}
```

```json
{
  "scopes": {
    "type": "array",
    "minItems": 1,
    "maxItems": 50,
    "uniqueItems": true,
    "items": {
      "type": "string",
      "minLength": 1,
      "maxLength": 160,
      "pattern": "^(\\*|none|(repo|collection|topic):\\*|repo:[A-Za-z0-9]([A-Za-z0-9-]{0,38})/(\\*|[A-Za-z0-9_][A-Za-z0-9._-]{0,99})|collection:[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?/(\\*|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)|topic:[a-z0-9][a-z0-9-]{0,63})$"
    }
  }
}
```

**Remembered decisions** are keyed `(type, sender's owner, scope)`, where scope is a scope, `<kind>:*`, `none` or `*`. A decision covers a request **scope by scope**, as `obi/0.1` covers a question repository by repository (protocol.md section 11, step 5): for each scope the request names there is a decision for that scope, its kind's `*` or `*`, the most exact winning; a request that names no scope is covered by one for `none` or `*`. So a decision for one scope never covers work that also names another. **A remembered accept is never keyed by a topic** (`topic:<id>` or `topic:*`): a topic is a label the sender chooses and nothing checks, so it can't stand for what the work touches. Topics may key remembered declines and policy, as a way to sort, never as a boundary; a sharing rule keyed by a topic lets the agent tell only shared results.

**Nor does a remembered accept cover a `collection:` scope.** Work on what an owner keeps sends back what it draws from it, in `summary` and `produced`, so a standing accept would be a standing export of the owner's data to that sender, whatever its `goal` says. `obi/0.1` keeps questions away from remembered accepts for the same reason (protocol.md section 11, step 5). So, for a `work_request` that names a collection, only a remembered decline applies, and the owner decides each request, as for a question their agent can't answer by itself. Remembered accepts stay for `repo:` scopes, where the work's material is the repository, and for `none`, where it is only the request's words.

**A request whose scopes are covered by different decisions** (an accept for one, a decline for another, or none for a third) goes to the owner's inbox.

**Sharing rules** cover scopes the same way. What they let an agent tell is a list of kinds too: Core has **shared results** (what the owner already shared with that person); Code adds **job status** and **published pull requests**, as `obi/0.1` defines them. A Core-only agent answers by itself only from shared results.

**Topics as scopes.** Since #53 (#76), a card's topics are identifiers (`^[a-z0-9][a-z0-9-]{0,63}$`), not words, so `topic:<id>` uses them as they are.

## 9. The Code profile

What `obi/0.1` has for code collaboration, unchanged except as said:

- **`review_request`** and its `result` (`for: review_request`), with findings, `approve_on_host` and `host_review`, as in `obi/0.1`, with Core's `follows`, `cancel` and `before` and the consistency rule of section 5. A review of something other than a commit (a document, a design) waits until a real use needs it, such as the Council deciding about documents. Then findings, located by a reference instead of a file and line, would move to Core, with `no_blocker_findings` and `no_findings_at_or_above`.
- **Findings** (`file`, `line`, `end_line`, severity, `title`, `detail`) and their condition kinds.
- **The references** `repo`, `pr`, `issue`, `job`, and the new `branch` and `commit` (section 7); the `repo` scope kind; the sharing-rule kinds job status and published pull requests.
- **Approving on the code host**, as `obi/0.1` has it after the owner-confirmation rule (#38), with the neutral marker `by agent:` ([identifiers.md, section 4](identifiers.md#4-the-code-host-marker-d3)) and the rule for organisation owners ([owners.md, section 5](owners.md#5-what-an-organisations-agent-may-do-d11)). Since #53, `obi/0.1` already says that a `cancel` from the request's sender ends the exchange, and with it any confirmation the receiver's owner gave for it, so the receiver approves nothing after one. The Draft adds that the receiver checks for one among its deliveries right before it posts.
- **`handoff`** becomes a `work_request` on a `branch` subject (section 5, D5).

A member that lists `code` in its card's `profiles` may accept `review_request`, and may take `work_request`s whose subject is a Code reference.

## 10. The compute and share actions (D4)

`run_request`, `run_progress`, `run_return` and `run_cancel` run one member's job on another's machine, in a VM, through an end-to-end encrypted job channel that also carries the job's model calls; a runner status says who offers their machine. `share_offer`, `share_status` and `share_revoke` lend the use of a company-paid API account, metered by the key holder. Oby, the one implementation that had them, has removed them ([obi-ai-bot/oby#1515](https://github.com/obi-ai-bot/oby/pull/1515)), and no other implementation is known to have them.

**Decided: they are dropped from the next version** ([#52](https://github.com/obi-ai-bot/oby-sphere/issues/52#issuecomment-6456517732)), rather than carried as an optional profile, for these reasons.

1. **No standard ahead of use.** Nobody uses them now. A profile no implementation runs is text, schemas and fixtures that nobody tests against real use, and that every server keeps paying for (the job channel, the runner directory, their limits).
2. **They are the largest attack surface in the spec.** Running another person's code on one's machine; relaying a model API with credentials added on the way; metering money in cents against a budget; blurring when an owner is at their machine. Each needed careful rules (protocol.md sections 13 to 15), and each is a place for a mistake. A version meant to be the minimal Core for every agent shouldn't carry them.
3. **They are the part most tied to one product.** A Mac, two VM sizes, two named CLIs and their model API paths, US cents, one provider's way of paying for tokens. Making them neutral would be a redesign, not a rename.
4. **Lending a secret is the Exchange standard's work** ([#44](https://github.com/obi-ai-bot/oby-sphere/issues/44)), which is planned with a more general design. When a real use needs running work elsewhere or lending an account, it can start from `obi/0.1`'s text, which stays as it is (version rule 2), and come back as a profile through the spec.
5. **Dropping is cheap to undo; keeping is not.** A later version can add a profile. Once a profile is in a version, removing it is another breaking change.

**The alternative, not taken**: keeping them as an optional profile, "Compute": the actions and the job channel as in `obi/0.1`, with neutral identifiers (the channel's prefixes become `sphere/0.2 channel…`, its `obi` member `agent`, the bundle's `obi-base` branch `base`), and `agent`, the coding agent that runs a job, becomes `runtime`, an open runtime id from the registry ([runtimes.md](runtimes.md)), not the closed `claude`/`codex` enum.

**What goes with them.** The scopes `send:run_request` and `send:share_offer`; `decline`'s `share_used`; `result`'s `for: run_request`; the endpoints `/channels/{correlation_id}` and `/members/{agent}/runner`; protocol.md sections 13 to 15; and the conformance class *holder*, which has no action until Exchange gives it one.

## 11. Done when

#52 is done when an agent that never touches git can implement Core alone, pass its conformance class, and ask another member for a piece of work with conditions a machine can check, and the Code profile is one profile among others. In this Draft: Core alone is sections 2 to 8 without section 9; the work is a `work_request` on something the receiver's owner holds; the conditions are `delivers` and `before`, which anyone can check, and `own_check`, which the receiver's machine checks.
