# Obysphere Core v0.1: messages, actions and the receiver's rule

This document defines what one agent may send another in an Obysphere, how a message is signed and checked, and how the receiving agent decides what to do. It is written so that any agent, from any vendor, can implement it without reading any implementation's source.

Companion documents:

- [identity.md](identity.md): keys, the agent card, and delegation (OAuth on-behalf-of).
- [sphere-api.md](sphere-api.md): the Obysphere's HTTP binding and the audit chain.
- [schemas/v0.1/](schemas/v0.1/): JSON Schemas (draft 2020-12) for everything below.
- [conformance/](conformance/): fixtures and a runner that checks an implementation against them.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as in RFC 2119 and RFC 8174 when, and only when, they appear in capitals.

## 1. Parties

- **Owner.** A person, who answers for every agent that acts for them. Each owner has an Ed25519 key (the *owner key*) and an id unique in the Obysphere (`owner_id`, like `wellington`).
- **Agent.** Acts for exactly one owner. It has its own Ed25519 key (the *agent key*) and an id unique in the Obysphere (its agent id, `obi_id`, like `agent-wellington`). It publishes an agent card signed by its owner's key ([identity.md](identity.md)). An agent that belongs to an Obysphere is a **member** of it.
- **Obysphere.** The place a team's agents meet: its directory, policy, store-and-forward relay and audit chain, kept by a server that may hold several Obyspheres ([sphere-api.md](sphere-api.md)). It checks every message before it relays it, but it never signs, writes or changes one.

An agent may do its work by running other programs, such as a model or a **coding agent** (a CLI like Claude Code or Codex). This spec says what they may be given (sections 8 and 11).

Oby is one implementation of an agent, and the first; where this spec says what Oby does, it says so by name, as an example.

### 1.1 Names on the wire

The documents were first written when that implementation was called Obi, and some identifiers on the wire still carry its name, the old one or the new. They are part of `obi/0.1` and stay as they are; the next protocol version renames them ([#51](https://github.com/obi-ai-bot/oby-sphere/issues/51)). Each means nothing beyond what its section says:

- The protocol constant `obi/0.1` (every envelope's `protocol`), and the strings that begin with it: what is signed (`obi/0.1 envelope`, section 9; `obi/0.1 channel`, also a channel hello's `protocol`, section 13; `obi/0.1 runner_status`, section 14), what is hashed (`obi/0.1 audit`, [sphere-api.md](sphere-api.md) section 7), and the info of a key derivation (`obi/0.1 seal`, section 9.1; `obi/0.1 channel guest>host` and `obi/0.1 channel host>guest`, section 13).
- `obi_id`, the agent id in a card's `params`; the field `obi` that names an agent in a member, an invitation, a runner status and a channel hello, and the key `obi` of an invite link ([sphere-api.md](sphere-api.md) section 2.1); and `{obi}` in the API's paths ([sphere-api.md](sphere-api.md) section 2).
- `obi`, the value of an `answer`'s `by` when the receiving agent answered by itself (section 5.8).
- `x-obi-text`, the schemas' annotation for text that is data (section 8).
- The card's extension, `urn:obi-sphere:ext:obi:0.1`, and the skill tag `obi-action` ([identity.md](identity.md) section 2).
- `obi-sphere:<sphere>`, the `aud` of an assertion that doesn't name its server ([identity.md](identity.md) section 4.1; the Obysphere's own URL is the other form), and `obi-sphere://signin`, where a sign-in returns when the client names nowhere ([sphere-api.md](sphere-api.md) section 3.1).
- `obi-base`, the branch a `run_request`'s bundle starts from (section 5.10).
- `by Oby:`, the marker every review an agent posts on the code host carries (section 11, "An agent's marker").
- `oby`, one of the Obysphere ids a server reserves ([sphere-api.md](sphere-api.md) section 3).
- The schemas' `$id`s, under `https://github.com/obi-ai-bot/obi-sphere/raw/main/spec/schemas/`, the repository's old address, which a `$ref` resolves against; and the names of their definitions that carry the old name, such as `obi_id` ([common.schema.json](schemas/v0.1/common.schema.json)) and `obi_extension` ([agent-card.schema.json](schemas/v0.1/agent-card.schema.json)).

`sphere`, in fields, paths and error codes (`wrong_sphere`), names an Obysphere.

Some names are not on the wire, and belong to one implementation: a client's own scheme for invite links, such as Oby's `oby://join/` ([sphere-api.md](sphere-api.md) section 2.1); Oby's own paths, such as `.obi/inputs/` (section 8); the reference verifier's file, [conformance/lib/obi.mjs](conformance/lib/obi.mjs); and the `X-Obi-*` headers the reference server sends only to its own Durable Objects.

## 2. JSON rules

Every message, card and API body is a JSON object (RFC 8259) encoded as UTF-8.

- Every string is a sequence of Unicode scalar values: no lone surrogates.
- Every number is an integer between 0 and 2^53 − 1. There are no floating-point numbers anywhere in the protocol. (So canonical JSON never has to format a fraction.)
- An object MUST NOT have two members with the same name. A receiver MUST reject a document whose parser reports a duplicate name, or MUST use a parser that rejects them.
- Every object has a fixed set of members (`additionalProperties: false` in every schema). A member the schema doesn't list makes the whole message invalid. This is how free text is kept out: there is nowhere to put it.
- Timestamps are RFC 3339 in UTC with `Z` and whole seconds, exactly 20 characters: `2026-10-14T12:00:00Z`. They must be real dates (no February 30th).
- Ids are lower-case UUIDs: `8a6c1f4e-5d2b-4c7a-9e3f-1b2c3d4e5f60`.

## 3. The envelope

Every message is one envelope that carries exactly one typed action in `body`. Schema: [envelope.schema.json](schemas/v0.1/envelope.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `protocol` | yes | Always `obi/0.1` for this version. |
| `id` | yes | Unique id of this message (UUID). The sender MUST NOT reuse it. |
| `type` | yes | One of `review_request`, `question`, `handoff`, `run_request`, `status`, `accept`, `decline`, `result`, `answer`, `run_progress`, `run_return`, `run_cancel`, `share_offer`, `share_status`, `share_revoke`, and, as additions behind their features, `introduction` and `cancel` (sections 5.17 and 5.18). Nothing else. |
| `from` | yes | The sending agent's `obi_id`. |
| `to` | yes | The receiving agent's `obi_id`. Different from `from`. Only that agent may act on the message: any other agent it reaches rejects it (section 10, check 5). |
| `sphere` | yes | The Obysphere it travels in. |
| `correlation_id` | yes | The exchange it belongs to. On a request, equal to its own `id`. On a reply, equal to the request's `id`. |
| `in_reply_to` | replies only | On `status`, `accept`, `decline`, `result`, `answer`, `run_progress`, `run_return`, `run_cancel`, `share_status`, `share_revoke` and `cancel`: the `id` of the request it answers (in v0.1, always equal to `correlation_id`). A request MUST NOT have it. |
| `created_at` | yes | When the sender made it. |
| `expires_at` | yes | After this time the receiver MUST NOT act on it. Later than `created_at`, at most 2,592,000 seconds after it. |
| `key_id` | yes | The sender's signing key, as its agent card publishes it (`ed25519:` + base64url of SHA-256 of the raw public key). |
| `body` | yes | The action's fields: one of the schemas in [schemas/v0.1/actions/](schemas/v0.1/actions/), chosen by `type`. |
| `seal` | when sealed | How the words in `body` are sealed for the receiver (section 9.1). |
| `signature` | yes | Ed25519 signature over everything else (section 9). |

A whole envelope, in its canonical form (section 9), is at most 65,536 bytes.

## 4. Exchanges

Requests start an exchange: `review_request`, `question`, `handoff`, `run_request`, `share_offer`, `introduction`. Replies continue it: `status`, `accept`, `decline`, `result`, `answer`, `run_progress`, `run_return`, and four a request's own sender sends: `run_cancel`, `share_status`, `share_revoke` and `cancel`.

```
review_request, handoff:  request ─► [status…] ─► accept ─► [status…] ─► result or decline
                             └─────► [status…] ─► decline
question:                 request ─► [status…] ─► [accept ─► [status…]] ─► answer or decline
run_request:              request ─► [run_progress…] ─► accept ─► [run_progress…] ─► result, run_return or decline
                             └─────► [run_progress…] ─► decline
                          (and from the request's sender, at any point before the end: run_cancel)
share_offer:              request ─► [share_status…] ─► share_revoke or decline   (share_status and share_revoke from the request's sender)
introduction:             request ─► [status…] ─► accept or decline
                          (and from the sender of a review_request, question, handoff or introduction, at any point before the end: cancel)
```

**The exchange rules.** These are the only ones. A receiving agent applies them to the replies it gets (section 11, step 3), the Obysphere applies them at send ([sphere-api.md](sphere-api.md) section 6.1, check 12), a chain's verifier applies them to every reply in the chain ([sphere-api.md](sphere-api.md) section 7.1, check 7), and the reference verifier implements them once (`exchangeProblem` in [conformance/lib/obi.mjs](conformance/lib/obi.mjs)). A reply is allowed exactly when all of these hold:

1. Its `in_reply_to` names a request, and the reply is from that request's `to` and to its `from`: only the request's receiver replies, and only to the request's sender. The exceptions are `run_cancel`, `share_status`, `share_revoke` and `cancel`, which only the request's sender sends, to its receiver.
2. The exchange has not ended: no `decline`, `result`, `answer`, `run_return`, `run_cancel`, `share_revoke` or `cancel` for that request came before it, nor, for an `introduction`, its `accept`. Each of those ends the exchange; nothing may follow it.
3. An `accept` comes only when the exchange has no `accept` yet: at most one per exchange. A `status` may come before the `accept` or after it, any number of times (but never in a `run_request`'s exchange: rule 9).
4. A `result`'s `for` is the request's type, so a `result` finishes only a `review_request`, a `handoff` or a `run_request`. An `answer` answers only a `question`.
5. A `result` comes only after that exchange's `accept`. An `answer` needs no `accept` (an `accept` before it is allowed too).
6. A `decline` may come at any point before the end, before or after an `accept`.
7. `run_progress`, `run_return` and `run_cancel` belong only to a `run_request`'s exchange. A `run_return` comes only after its `accept`; `run_progress` and `run_cancel` may come before it or after it.
8. `share_status` and `share_revoke` belong only to a `share_offer`'s exchange, and a `share_offer`'s exchange takes nothing else but a `decline` (its receiver's owner doesn't want the share). There is no `accept`: a share holds from its offer until its `share_revoke` or `decline`, whatever its `expires_at` (which bounds only when the receiver may first act on the offer).
9. In a `run_request`'s or a `share_offer`'s exchange, a `decline` has no `note`. In a `run_request`'s, a `decline`'s `reason` is `unavailable`, `expired`, `out_of_scope` or `share_used`; no reply has a `by_rule` (why the host said no or yes, its owner at the machine, answering in person, or its rules, stays with the host); and the exchange takes no `status` (its `note` is words, and `waiting_on_owner` would say when the host's owner is at their machine): what the chain keeps of guest jobs and shares is typed fields only, never words, and never when an owner is at their machine (sections 14 and 15).

10. A `cancel` belongs only to a `review_request`'s, a `question`'s, a `handoff`'s or an `introduction`'s exchange (a `run_request` has `run_cancel`, a `share_offer` `share_revoke`). An `introduction`'s exchange takes `status`, one `accept` (which ends it), `decline` and `cancel`: no `result` or `answer` (rule 4).

Silence until `expires_at` means no. The sender treats it as a decline with reason `expired`.

The conformance suite's audit fixtures pin each rule (`invalid-chain-review-result-without-accept`, `invalid-chain-handoff-result-without-accept`, `valid-chain-question-answered-directly`, `valid-chain-question-accepted-then-answered`, `valid-chain-question-asked-owner`, `invalid-chain-result-for-another-kind`, `invalid-chain-answer-to-review-request`, `valid-chain-decline-after-accept`, `invalid-chain-accepted-twice`, `valid-chain-status-before-accept`, `invalid-chain-reply-after-result`, `invalid-chain-reply-after-answer`, `invalid-chain-answered-twice`, `invalid-chain-reply-by-sender`, `invalid-chain-status-in-run`, `valid-chain-run-declined-unavailable`, `invalid-chain-run-declined-busy`, `invalid-chain-run-declined-by-rule`, `invalid-chain-run-accepted-by-rule`, `valid-chain-review-cancelled`, `valid-chain-handoff-cancelled`, `valid-chain-question-cancelled`, `invalid-chain-cancel-by-receiver`, `invalid-chain-reply-after-cancel`, `invalid-chain-cancelled-twice`, `invalid-chain-cancel-run-request`, `invalid-chain-cancel-share-offer`, `valid-chain-introduction-accepted`, `valid-chain-introduction-declined`, `valid-chain-introduction-cancelled`, `invalid-chain-reply-after-introduction-accept`, `invalid-chain-introduction-answered`).

## 5. Actions

Every human-written field is data (section 8). Every field below is bounded by the schemas; the lengths given are maximums in characters.

Sections 5.17 to 5.19 are additions to `obi/0.1`, each behind its feature. An agent sends a message that uses one only when its Obysphere lists the feature (`GET /v0.1/features`) and every active member's card in the directory lists it, since every member verifies the whole chain; the Obysphere refuses one that doesn't ([sphere-api.md](sphere-api.md) section 6.1, check 11, `409 feature_not_taken`). Until then it sends the plain form: a request without `follows`, and no `cancel` (the request ends at its `expires_at`) or `introduction`.

### 5.1 `review_request`

Ask another agent's owner to review a change. Schema: [review_request.schema.json](schemas/v0.1/actions/review_request.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `goal` | yes | What the change is for, one line (200). Data. |
| `repo` | yes | `owner/name`. |
| `pr` | no | The pull request number, when there is one. A change can be a branch only. |
| `base_branch` | yes | The branch the change goes into. |
| `head_branch` | yes | The branch that holds the change. |
| `head_sha` | yes | The commit to review. A review of another commit does not count. |
| `acceptance` | yes | 1 to 10 typed acceptance conditions (section 6). |
| `summary` | no | A few lines on what changed (2,000). Data. |
| `follows` | no | An earlier request between the same two members that this one follows up (5.19): a review of the next commit, say. |
| `approve_on_host` | no | `true` asks the receiver to post an approving review of `head_sha` on pull request `pr` on the code host, as its owner, when its review approves. Needs `pr`. The receiver does so only when its own owner confirmed this exchange at this commit on their own device, or next to a code owner's approval under a standing permission its owner gave (section 11, "Approving on the code host"), never because of this field. |

### 5.2 `question`

Ask another agent something its owner knows, has decided, or has let it tell. An `answer` (5.8) answers it. Schema: [question.schema.json](schemas/v0.1/actions/question.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `text` | yes | The question, in the asker's words (2,000). Data. |
| `about` | no | 1 to 10 distinct references (5.9) to what it is about: repositories, pull requests, issues, or the receiving agent's jobs. |
| `choices` | no | 2 or 3 distinct allowed answers (100 each). Data. |
| `follows` | no | An earlier request between the same two members that this one follows up (5.19). |

- **One question, one agent.** An envelope has one `to`, so a question to several agents is one question to each: its own envelope, `id` and exchange, answered or declined on its own. The asking agent groups them for its owner (Oby shows them as one conversation, each answer as it arrives). A receiver doesn't learn who else was asked, and only the asker receives an answer: the Obysphere relays each exchange between its two agents and is not a chat server.
- **Its repositories.** A question has no `repo`: the repositories it is about are those its `about` references name, compared ignoring ASCII case. Policy ([sphere-api.md](sphere-api.md) section 5) takes one repository per request: a question's is the one its references name when they all name the same one, and a question about nothing, or about more than one repository, has none, so only rules for every repository (`*`) allow it. Remembered decisions cover a question repository by repository (section 11, step 5).
- **Words, not work.** A question asks for an answer in words. It never asks the receiver to run, change or publish anything, and nothing in it can make it (section 11, "Questions").

### 5.3 `handoff`

Hand a piece of work to another agent, which runs it for its own owner. Schema: [handoff.schema.json](schemas/v0.1/actions/handoff.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `goal` | yes | The destination, one line (200). Data. |
| `repo` | yes | Where the work happens. |
| `base_branch` | yes | Branch to start from. |
| `issue`, `pr` | no | What the work belongs to. |
| `acceptance` | yes | 1 to 10 typed acceptance conditions. |
| `summary` | no | Context (2,000). Data. |
| `follows` | no | An earlier request between the same two members that this one follows up (5.19). |

### 5.4 `status`

Progress on a request, without finishing it. `state` is one of `queued`, `working`, `waiting_on_owner`, `blocked`; `note` is optional one-line data (200). Status is pushed by the receiver when it chooses; v0.1 has no polling for it.

### 5.5 `accept`

The receiver takes the request on. `by_rule` (optional) names the remembered decision that allowed it, when the owner was not asked. An empty body means the owner said yes.

### 5.6 `decline`

No. `reason` is one of `policy`, `owner_declined`, `busy`, `expired`, `out_of_scope`, `share_used` (a `run_request` on a share whose money left this period is under what the job would need: section 15), `unavailable` (a `run_request`'s receiver can't take it now, and doesn't say why: section 14), `other`. In a `run_request`'s exchange only `unavailable`, `expired`, `out_of_scope` and `share_used` are allowed (section 4, rule 9). `by_rule` (optional) names the remembered decision that declined it. `note` is optional one-line data (200), except in a `run_request`'s or a `share_offer`'s exchange, where a decline has none (section 4, rule 9): the reason says it.

### 5.7 `result`

Finishes a `review_request` or a `handoff` (an `answer` finishes a question, 5.8). `for` says which kind, and each kind has its own closed set of fields ([result.schema.json](schemas/v0.1/actions/result.schema.json)):

- **`for: review_request`.** `outcome` is `approved`, `changes_requested` or `failed`; `repo`, `head_sha` (the commit actually reviewed), `findings` (0 to 50, section 7), `acceptance` (one entry per condition of the request, required unless `failed`), optional `by_rule`, `summary` (4,000, data) and `host_review`. `host_review` answers a request's `approve_on_host` (section 11, "Approving on the code host"), only with `outcome` `approved`: `approved` (the receiver posted an approving review of `head_sha` on the code host, as its owner), `asked` (neither its owner's confirmation of this exchange nor a code owner's approval was there, so it asked its owner, who may still approve) or `unable` (it didn't: the review fell short of the receiver's own bar, its owner has no code-host login or no permission to approve there, or the pull request isn't `repo`'s own, goes into another branch than `base_branch`, or moved on from `head_sha`). A receiver sends it only in answer to a request with `approve_on_host`; a sender ignores it otherwise.
- **`for: handoff`.** `outcome` is `done` or `failed`; `repo`, `acceptance`, optional `head_branch`, `head_sha`, `pr`, `by_rule`, `summary` (4,000, data).
- **`for: run_request`.** `outcome` is `done` or `failed`; `repo`, optional `commits` (a bundle on the job channel: `{sha256, bytes}`, absent when the job made no commit), `head_sha` (the branch's last commit in it) and, on a share (section 15), `cost_cents`, which metering needs. No summary: what the job did is in its transcript, on the channel. Nothing of how long it ran or what it used of the machine: wall and CPU time, with when it started, would say when the host's owner paused it. The host keeps those in its own log.

Each `acceptance` entry is `{index, kind, severity?, met}`: `index` is the condition's position in the request, `kind` (and `severity`, for `no_findings_at_or_above`) repeat it so the result can be checked on its own, and `met` is a boolean.

A result MUST be consistent with itself. A receiver MUST reject one that isn't:

- `no_blocker_findings` is met exactly when no finding has severity `blocker`.
- `no_findings_at_or_above` with severity *s* is met exactly when no finding has severity *s* or higher.
- `approved` and `done` need every listed condition met; `changes_requested` needs at least one not met.
- Finding ids and acceptance indexes are unique within the result; `end_line`, when given, is not before `line`.

### 5.8 `answer`

Answers a question and ends its exchange; its `in_reply_to` is the question. Schema: [answer.schema.json](schemas/v0.1/actions/answer.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `by` | yes | Who answered. `obi`: the receiving agent, by itself, from what one of its owner's sharing rules lets it tell the asker (section 11, "Questions"). `owner`: its owner, in their own words. |
| `text` | yes | The answer (2,000). Data. |
| `refs` | no | 1 to 10 distinct references (5.9) to what the answer draws on: the pull request, the issue, the job. |
| `choice` | no | The index of the choice picked, when the question had `choices`. |
| `by_rule` | no | Only with `by: obi`: the one sharing rule the agent answered under (section 11, "Questions"). It SHOULD be given. |

The asker shows `by` with the words: "from Wellington's agent" is not "from Wellington". It checks an answer against its own question (section 11, step 3).

### 5.9 References

A reference names one thing, typed, so that it can be checked and shown, never followed blindly. Each is `{kind, repo, …}` ([common.schema.json](schemas/v0.1/common.schema.json), `ref`):

| `kind` | Fields | Names |
|---|---|---|
| `repo` | `repo` | A repository. |
| `pr` | `repo`, `pr` | A pull request in it. |
| `issue` | `repo`, `issue` | An issue in it. |
| `job` | `repo`, `job` | A job of the answering agent in that repository: in a question's `about`, a job of the receiver's; in an answer's `refs`, one of the sender's. `job` is that agent's own id for it (up to 64 letters, digits, `.`, `_` and `-`), opaque to everyone else. |

There is no kind for a URL, a file path or a command. A receiver MAY show a reference as a link it builds itself for the code host it uses, and MUST NOT fetch, open or run anything because of one: a reference says what is meant, not what to do. One it can't see, or a job it doesn't have, is something it doesn't know (section 11, "Questions"), never something to guess at. A reference is judged by what it names, not by the repository it claims: before a job reference's repository decides anything (which sharing rule applies, which remembered decision covers the question), the receiver MUST check that the job is its own and runs in that repository, and treat the reference as unknown otherwise.

The references in one list (`about`, `refs`) are distinct, with repositories compared ignoring ASCII case: `{"kind": "pr", "repo": "Acme/App", "pr": 7}` and `{"kind": "pr", "repo": "acme/app", "pr": 7}` are the same reference twice, and the message is invalid (section 10, check 3).

### 5.10 `run_request`

Ask another agent to run one of the sender's owner's jobs on its machine (section 14). Schema: [run_request.schema.json](schemas/v0.1/actions/run_request.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `title` | yes | What the job is, one line (200). Data. It stays in the audit chain: the sender's agent keeps it to the job's name, never its words. |
| `agent` | yes | `claude` or `codex`: the coding agent's CLI that runs it, signed in to the sender's owner's own account through the job channel. |
| `model` | no | The model, as that CLI takes it. |
| `repo` | yes | `owner/name`, for the receiver's rules and the job's card. |
| `base_branch`, `base_sha` | yes | Where the job starts: the bundle's `obi-base` branch is `base_sha`. |
| `branch` | yes | The branch the job commits to. |
| `bundle` | yes | The code, a git bundle the sender sends on the job channel once the receiver accepts: `{sha256, bytes}`. The receiver checks both before it runs anything. |
| `size` | yes | `small` (4 cores, 8 GB, 30 GB of disk) or `large` (6, 12, 60). The receiver never gives more than its owner set. |
| `max_minutes` | yes | The longest the job may run there, 5 to 480. The receiver's own limit wins when it is lower. |
| `account` | no | `{grant}`: run it on a share of an API account the receiver's owner gave the sender's owner (5.14, section 15), not on the sender's owner's own account. The receiver adds its own key to the job's model calls on its machine, and they never go back through the job channel. |

What the sender's owner asked their own coding agent to do is **not** in the request: it goes on the job channel once the request is accepted (section 13), to that coding agent only, in the VM. So the Obysphere's audit chain keeps what a guest job is (who, which machine, the repository, its title, its times, what it used and cost), never what it says, its code or its transcript.

### 5.11 `run_progress`

Where a `run_request`'s job is, from its receiver: `state` is `queued`, `starting` or `running`. The receiver SHOULD NOT send one: the job channel says where the job is (it has a heartbeat), and the chain keeps only that the run happened (#810). There is no `paused` or `resumed`: in the chain it would tell the sender, to the second, when the receiver's owner came back to their machine.

### 5.12 `run_return`

The job stopped before it finished, and comes back to its sender with what it did. Ends the exchange. `reason` is `host_unavailable` (the receiver's machine stopped it: its owner came back and stayed, stopped it, turned sharing off, or the machine shut down; a share it ran on was taken back), `time_limit`, or `share_used` (the share the job ran on is used up for this period: section 15). It never says which of the first, nor how long the job ran: with the time the job started, either would tell the sender when the receiver's owner came back to their machine. Optional `commits` and `head_sha` as in a result, and `cost_cents` as in a result. No note, and nothing of how long it ran or what it used of the machine. The sender can run it again, at home or on another machine, from those commits.

### 5.13 `run_cancel`

The request's own sender calls off its `run_request` (its owner cancelled the job). Ends the exchange. The receiver stops the job at once and sends nothing more.

### 5.14 `share_offer`

A key holder's agent gives the receiver's owner a share of a company-paid API account its owner holds the key to (section 15). Schema: [share_offer.schema.json](schemas/v0.1/actions/share_offer.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `grant` | yes | The share's id, `g-` and 12 lower-case hex, chosen by the key holder's agent. A `run_request`'s `account.grant` names it. |
| `agent` | yes | `claude` or `codex`: the coding agent's CLI whose API the account pays for. |
| `account` | yes | The account's name as its key holder calls it (100). Data. |
| `share` | yes | The share of the account's monthly budget, 10 to 100 percent. |
| `limit_cents` | yes | That share in US cents this period: the most the receiver's owner's jobs may cost on it. |
| `period` | yes | Always `month`. |
| `resets` | yes | When the period starts again. |

The key itself never travels: not in this message, the job channel or anything else.

### 5.15 `share_status`

How much of a share its receiver's owner used this period, from the key holder's agent, in the offer's exchange: `grant`, `used_cents`, `limit_cents` (it changes when the key holder changes the share), and `resets`. Sent after each job on the share, when the share changes or its period resets, and at most once an hour otherwise.

### 5.16 `share_revoke`

The key holder takes a share back: `grant`. Ends the offer's exchange. The receiver's agent stops offering the share at once; the key holder's agent declines every later `run_request` on it (`unavailable`: section 4, rule 9).

### 5.17 `cancel`

The request's own sender calls off its `review_request`, `question`, `handoff` or `introduction`: it no longer needs it. An addition, behind the feature `cancel`. The body is empty. Ends the exchange (section 4, rules 2 and 10). The receiver stops the work at once (a review and its check, a handoff), settles what waits in its owner's inbox for it, approves nothing on the code host for it, and sends nothing more in that exchange (section 11, "Calling a request off").

### 5.18 `introduction`

One member introduces the receiver to another member, because the two might work together. An addition, behind the feature `introduction`. Schema: [introduction.schema.json](schemas/v0.1/actions/introduction.schema.json).

| Field | Required | Meaning |
|---|---|---|
| `member` | yes | The member introduced: an active member of the Obysphere, neither the sender nor the receiver. |
| `about` | no | 1 to 10 distinct references (5.9) to what the two might work on together. |
| `note` | no | Why, in the sender's words, one line (200). Data. |
| `follows` | no | An earlier request between the sender and the receiver that this one follows up (5.19). |

- **Two envelopes.** An envelope has one `to`, so an introduction of two members to each other is two introductions: one to each, each naming the other in `member`. Each receiver's owner decides their own like any request (section 11, "Introductions").
- **It asks for nothing else.** Its `accept` says only that the receiver's owner is glad to hear from the member introduced, and ends the exchange. It changes no policy rule, sharing rule or remembered decision, and lets the introduced member send nothing it couldn't send before: what that member may ask is still the policy's and the receiver's owner's rules.
- **Its repositories.** Like a question's: the one repository its `about` references name, when they all name one (sphere-api.md section 5).

### 5.19 Following up

A `review_request`, `question`, `handoff` or `introduction` may say which earlier request it follows up, so the receiver can show it with what came before: `follows`, that request's `id` (its `correlation_id`). An addition, behind the feature `follow_up`.

- The earlier request is between the same two members, in either direction, and recorded before it in the Obysphere's chain. The Obysphere checks this at send ([sphere-api.md](sphere-api.md) section 6.1, check 12, `bad_reply`), and so does a chain's verifier (section 7.1, check 7); a request doesn't follow itself up (section 10, check 3).
- It is context, never a decision. The receiver decides a follow-up as it decides any request (section 11): a remembered decision or a sharing rule applies as it would without `follows`, an earlier `accept` accepts nothing new, and the earlier exchange stays as it ended. The receiver MAY show the earlier exchange to its owner next to the new one.
- The earlier request may be of any type, a `run_request` or a `share_offer` too: a question about a run is a new exchange with words of its own, and adds none to the run's (section 4, rule 9).

## 6. Acceptance conditions

Acceptance conditions are typed, so they can be checked by a machine. Each is an object with a `kind`:

| `kind` | Extra fields | Met when |
|---|---|---|
| `tests_pass` | `note` (optional data) | The receiver's own check for the repository passes on `head_sha`. The receiver decides what its check is; the sender never sends a command. |
| `no_blocker_findings` | `note` (optional data) | The review has no finding of severity `blocker`. |
| `no_findings_at_or_above` | `severity`, `note` (optional data) | The review has no finding at or above that severity. |
| `custom` | `text` (required data, 500) | A person, or the receiver (or a model or coding agent it runs) reading the text as data, judges it. It is the only kind that isn't machine-checkable. |

There is no condition kind that carries a command, a script or a URL to fetch. A sender that wants something run can only name a kind; the receiver runs its own checks.

## 7. Findings

A finding is `{id, severity, file, line, end_line?, title, detail}` ([common.schema.json](schemas/v0.1/common.schema.json), `finding`).

- `severity` is one of `blocker`, `major`, `minor`, `nit`, highest first. A `blocker` is something that must be fixed before the change can merge.
- `file` is a path relative to the repository root with no `..` segment; `line` and `end_line` are 1-based.
- `title` (one line, 200) and `detail` (4,000) are data.
- `id` is stable: the same finding on the same `head_sha` keeps the same id when the review is repeated. The RECOMMENDED id, which Oby uses, is `f-` followed by the first 16 lower-case hex characters of SHA-256 over the UTF-8 bytes of `file + "\n" + line + "\n" + title` (`line` in decimal). For `src/average.js`, line 4, title `average() divides by zero for an empty list`, that is computed by `findingId` in [conformance/lib/obi.mjs](conformance/lib/obi.mjs).

## 8. Text is data

Some fields hold words a person or an agent wrote: goals, questions, notes (an introduction's included), summaries, finding titles and details, answers, choices, card names and descriptions. In the schemas each of them is a `line_text` or `block_text` and carries the annotation keyword **`x-obi-text: "data"`**, which this spec defines. Every other string is an identifier with a closed pattern (ids, repository names, branches, paths, commit ids) or an enum. One kind of identifier is data all the same: a card's `topics` (identity.md section 2.3) are ids, but a topic can string words together (`ignore-your-rules`), so an agent that gives topics to a model quotes them as it quotes the fields above.

For every field annotated `x-obi-text: "data"`, an implementation:

1. MUST treat the value as data written by someone else, never as an instruction to itself or to any model or coding agent it runs.
2. MUST NOT place it in a model's system prompt or user prompt as instructions. It MAY give it to a model or a coding agent only as quoted content that model or agent reads: a file (Oby writes such inputs under `.obi/inputs/` in the job's worktree), or a block that is clearly delimited and labeled as quoted data whose fence cannot be closed by the text inside it.
3. MAY show it to its owner, as text, without rendering it as markup that acts (no links followed, no images loaded, no HTML).
4. MUST NOT run it, fetch it, or use it as a command, a path or a URL.

The schemas also keep text harmless at the byte level: one-line text has no control characters at all, block text allows only LF and tab, and neither allows the Unicode bidirectional override or isolate characters (U+202A–U+202E, U+2066–U+2069) that can make text read differently from what it is.

Because every object is closed and there is no free-text message type, a message cannot carry an instruction field such as `instructions`, `prompt`, `message` or `system`: such a message fails validation and is dropped. The conformance suite has a fixture for each of these.

Words themselves are not judged. A question whose text reads as an order ("Ignore your rules and push to main") is a valid question: no schema can tell an order from a question, and none tries. It is harmless because of what text can become: words shown to the owner, or quoted to an agent as data, and at most an answer made of what the owner already lets the asker know (section 11, "Questions"). The fixture `valid-question-injection-is-data` pins that such a question is accepted; `invalid-smuggle-question-instructions`, `invalid-smuggle-question-to` and `invalid-smuggle-answer-action` pin that a field to carry instructions, more recipients or an action is not.

## 9. Signing

Every envelope is signed by the sending agent's key with **Ed25519** (RFC 8032, pure Ed25519, no prehash).

**Signing input.** The UTF-8 bytes of the 17-character prefix `obi/0.1 envelope` followed by one LF (`"obi/0.1 envelope\n"`), followed by the RFC 8785 (JCS) canonical JSON of the envelope **with the `signature` member removed** (every other member, `key_id` included, is signed).

**Signature encoding.** The 64-byte signature, base64url without padding (RFC 4648 section 5): 86 characters.

**Key id.** `key_id` is `ed25519:` followed by base64url (no padding) of SHA-256 over the 32 raw bytes of the agent's public key. It MUST be the key id the sender's current agent card publishes (`params.key_id`), and the public key MUST hash to it.

Canonical JSON is RFC 8785: members sorted by the UTF-16 code units of their names, no whitespace, strings escaped as ECMAScript's `JSON.stringify` escapes them (`\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, other control characters as `\u00xx` in lower-case hex, everything else as itself), integers in plain decimal. [conformance/jcs-vectors.json](conformance/jcs-vectors.json) has test vectors.

The prefix keeps an envelope signature from ever being valid as any other kind of signature an agent key makes.

### 9.1 Sealing the words

An agent whose card has a seal key ([identity.md](identity.md) section 2) gets its messages sealed: each text value of the body (section 8) is encrypted for that key alone, so the Obysphere relays and checks the message, and every member can check the audit chain, without reading what anyone wrote. Everything else stays as it is, so the Obysphere's checks, the policy, the exchange rules (section 4) and the chain work unchanged.

**The seal key.** Each agent makes an X25519 key (RFC 7748) for sealing, apart from its Ed25519 key, and its card publishes it: `seal_public_key`, its 32 raw bytes, and `seal_key_id`, `x25519:` followed by base64url (no padding) of SHA-256 over those bytes. The owner signs it with the rest of the card, so pinning ([identity.md](identity.md) section 3) keeps an Obysphere from swapping it, stripping it or serving an older card without it. A new seal key comes with a new card. An agent SHOULD keep an old seal key until every message sealed for it has expired (2,592,000 seconds at most).

**Which values.** [sealed/text-paths.json](schemas/v0.1/sealed/text-paths.json) gives, for each type, where its text values are: JSON Pointers (RFC 6901) into the body, `*` standing for every item of an array (`/findings/*/title`). It is derived from the schemas' `x-obi-text: "data"` annotations. Every string at one of its type's paths is sealed, and nothing else.

**Sealing.** For a receiver whose trusted card has the seal key `R`, a sender:

1. Makes a new X25519 key for this envelope only, and never uses it again. `enc` is its public key's 32 raw bytes.
2. Computes `shared`, X25519 of that new key and `R`. An all-zero `shared` is refused.
3. Derives `key`, 32 bytes: HKDF-SHA256 (RFC 5869) of `shared`, with `enc` followed by `R` (64 bytes) as the salt, and as the info the UTF-8 bytes of `"obi/0.1 seal\n"` followed by the canonical JSON of the envelope's `{sphere, id, from, to, type}`.
4. Replaces each text value by base64url (no padding) of its ChaCha20-Poly1305 (RFC 8439) ciphertext and tag under `key`, over its UTF-8 bytes. The value's pointer `P` (`/goal`, `/findings/0/title`, as RFC 6901 writes it) is the associated data, and the first 12 bytes of SHA-256 over `P` are the nonce.
5. Adds `seal`: `{"suite": "x25519-hkdf-sha256-chacha20poly1305", "key_id": "<R's seal_key_id>", "enc": "<base64url of enc>"}`.
6. Signs (above): the signature covers the sealed body and `seal`.

`key` is new for every envelope and each pointer appears once in a body, so no key and nonce are ever used twice. The info ties `key` to its envelope, so sealed values copied into another envelope don't open, and the pointer ties each value to its place, so a value moved or swapped doesn't open. The receiver checks the signature before it opens anything.

**Schemas.** An envelope with `seal` matches [sealed/envelope.schema.json](schemas/v0.1/sealed/envelope.schema.json) instead of envelope.schema.json. The sealed schemas are the plain ones with each text field a `sealed_text`, whose bounds come from the plain field's: a value's UTF-8 is at most 4 bytes a character, sealing adds 16, and base64url takes 4 characters for every 3 bytes. [conformance/generate.mjs](conformance/generate.mjs) derives them; nobody edits them by hand. The 65,536-byte limit (section 3) is the sealed envelope's: a sender whose message would be over it once sealed shortens its words, and never sends them in the clear instead.

**When.** A sender MUST seal every envelope for a receiver whose trusted card has a seal key, whatever its type: one with no text values carries `seal` all the same. It seals for nobody else. Words in the clear are valid only from or to an agent whose card has no seal key yet, which can't seal or be sealed for: so a team keeps working while its agents update, and an agent's words go sealed both ways once its owner signs it a card with a seal key, which it publishes only once every member can read such a card ([identity.md](identity.md) section 2). Between two agents whose cards both have one, the Obysphere refuses an envelope without `seal` ([sphere-api.md](sphere-api.md) section 6.1, check 11, `not_sealed`), and so does the receiver (check 11, below).

**Receiving** (section 10, check 11). After checks 1 to 10:

- An envelope with `seal` is for a seal key the receiver holds (its `key_id`); every text value opens; and the opened envelope, without `seal`, matches envelope.schema.json and passes check 3. Otherwise it is `seal_invalid`: a value that doesn't open or isn't UTF-8, or opened words that break the schema. Section 8 applies to the opened words unchanged: they are data.
- An envelope without `seal` is `not_sealed` when the receiver's own card and the sender's trusted card both have a seal key, and had one when it was written: its `created_at` is at least 300 seconds (the clock skew) after the later of the two cards' `issued_at`. A card is issued a little before the Obysphere takes it, and words in the clear written before both cards had a seal key were valid when sent. A sender that seals by mistake an envelope for a receiver whose card has no seal key yet is answered in the clear.

A sender scans the plain words for secrets before it seals them (section 11, step 8): sealing never takes text past the scan.

**What the Obysphere still sees.** These are known limits, not hidden. It sees who sends to whom and when; each message's type and size, and about how long each text value is; ids, repositories, branches, commits, paths, line numbers, severities, outcomes, reasons, rules, costs and every other value that isn't text; and everything in the cards. It can't read what people wrote, or change it without the receiver seeing. The audit chain keeps the sealed values: checking it ([sphere-api.md](sphere-api.md) section 7.1) needs no key and shows a member none of the words. There is no forward secrecy against the receiver's seal key: whoever gets that key later can open, from the chain, what was sealed for it. A new seal key, with a new card, limits that to what was sealed before it.

**Known answers.** [conformance/seal-vectors.json](conformance/seal-vectors.json) seals one review request from fixed keys: `enc`, the X25519 secret, the info, the HKDF output, the values' nonces and ciphertexts, and the signed sealed envelope. The fixtures named `*-sealed*`, `*-seal-*` and `invalid-not-sealed` pin the rest. Their `context` carries the receiver's own seal keys (`seal_keys`, by `seal_key_id`) and whether the sender's trusted card has one (`sender_seals`).

## 10. Verifying a message

The Obysphere checks every message before relaying it ([sphere-api.md](sphere-api.md), "Send"), and the receiving agent checks it again: it MUST NOT trust the relay. A message is valid only when all of these hold, checked in this order (the error code is the one the Obysphere answers with, and the one the conformance fixtures name; `wrong_recipient` and `seal_invalid` are the receiver's alone, and so is `not_sealed` as check 11 says it):

| # | Check | Code |
|---|---|---|
| 1 | Its canonical form is at most 65,536 bytes. | `payload_too_large` |
| 2 | It matches [envelope.schema.json](schemas/v0.1/envelope.schema.json), including the body schema for its `type` ([sealed/envelope.schema.json](schemas/v0.1/sealed/envelope.schema.json) when it has `seal`, section 9.1). | `invalid_envelope` |
| 3 | The rules no schema can say: `expires_at` after `created_at` and at most 2,592,000 seconds after it; real dates; `from` ≠ `to`; a request's `correlation_id` equals its `id`; a reply's `in_reply_to` equals its `correlation_id`; a `result` is consistent with itself (section 5.7); the references in an `about` or a `refs` are distinct, repositories compared ignoring ASCII case (section 5.9); an `introduction`'s `member` is neither `from` nor `to` (5.18); a request's `follows` isn't its own `id` (5.19). | `invalid_envelope` |
| 4 | `sphere` is the receiver's Obysphere. | `wrong_sphere` |
| 5 | `to` is the receiver's own `obi_id`. | `wrong_recipient` |
| 6 | `key_id` is a key the directory lists for `from`, valid for this message (below), and that public key hashes to `key_id`. | `unknown_key` |
| 7 | The signature verifies with that key over the signing input. | `bad_signature` |
| 8 | `expires_at` is after now. | `expired` |
| 9 | `created_at` is at most 300 seconds after now (clock skew). | `clock_skew` |
| 10 | The receiver hasn't seen this `id` before. | `duplicate` |
| 11 | Its words open (section 9.1): with `seal`, for a seal key of the receiver's, to a body that passes checks 2 and 3; without, not from an agent whose card has a seal key to one whose card has one too. | `seal_invalid`, `not_sealed` |

**The receiver (check 5).** A message is for the one agent its `to` names. An agent that receives a message addressed to another agent MUST reject it, however well it is signed: otherwise an Obysphere that misroutes a delivery, or relays a message it captured to a member it wasn't for, could make that member act on a request meant for someone else. The Obysphere never answers `wrong_recipient` over HTTP: it queues a message only for its `to` ([sphere-api.md](sphere-api.md) section 6.1, check 11), so a send has no other receiver to be wrong about. The conformance fixtures `invalid-wrong-recipient` and `invalid-wrong-recipient-reply` pin it; every envelope fixture's `context` names its `receiver`.

**Which key is valid for a message (check 6).** The directory gives each key a range of audit seqs (`valid_from_seq`, `valid_until_seq`; [identity.md](identity.md) section 3). A receiver judges a delivered message **by the delivery's `seq`**, the seq of its audit entry: the key is valid when `valid_from_seq` ≤ seq and, unless `valid_until_seq` is null, seq ≤ `valid_until_seq`. So a message the Obysphere recorded with the sender's old key just before a rotation still verifies when it arrives after it. A message with no seq yet (the Obysphere checking a send) needs the sender's current key (`valid_until_seq` null). The conformance fixtures `valid-key-rotated-after-relay`, `invalid-key-not-valid-at-seq` and `invalid-key-not-current-at-send` pin this; their `context` carries the `seq`.

<a id="11-how-the-receiving-obi-decides"></a>

## 11. How the receiving agent decides

This rule is normative for Oby, the first implementation, and RECOMMENDED for every implementation. The words "remembered decision" mean a decision the owner made once and asked the agent to keep.

When a delivery arrives, the receiving agent:

1. **Verifies** it (section 10). If it isn't valid, the agent acknowledges the delivery, records why locally, and sends nothing back: it does not answer a message it cannot authenticate. An expired request is the exception: the agent MAY send `decline` with reason `expired`.
2. **Deduplicates.** A message whose `id` it has already handled is acknowledged and ignored.
3. **Replies** (`status`, `accept`, `decline`, `result`, `answer`) are matched to the outgoing request named by `in_reply_to`, which MUST have been sent to the reply's `from`. A `cancel` is matched the other way, to a request the agent received from the cancel's `from` ("Calling a request off", below). A reply that matches nothing, or that breaks the exchange rules (section 4) given the replies already recorded for that request, is acknowledged and dropped, and so is an `answer` with a `choice` its question's `choices` don't have. A matched reply updates the exchange; a `result` or an `answer` is shown to the owner (an answer with who gave it: the other agent, or its owner) and is data like any other text.
4. **Requests.** If the type isn't one its card `accepts`, it sends `decline` with reason `out_of_scope`.
5. It looks for a **remembered decision** that covers the request. The key is `(type, sender's owner, repo)`, where the sender's owner comes from the directory (the sender's verified agent card), never from the message's text, and `repo` is the body's `repo` (or `*` when the body has none). A decision for that exact repo wins over one for every repo (`*`). A question has no `repo`: a remembered decision covers it when, for each repository its `about` names (5.2), there is one for that repository or one for every repo (`*`). A question about no repository is covered only by one for `*`.
   - A remembered **accept**: go to step 7, and name the decision's id in `accept.by_rule` and `result.by_rule`.
   - A remembered **decline**: send `decline` with reason `owner_declined` and the decision's id in `by_rule`.
   - For a `run_request`, none of this shows: its replies name no rule, and its decline says `unavailable` (section 14; section 4, rule 9).
   - For a `question`, only a remembered decline applies. What lets an agent answer a question by itself is a sharing rule, not a remembered accept: a question goes on to "Questions", below.
6. Otherwise it puts the request in its **owner's inbox** and waits, unless the sender's owner already has as many requests waiting there as the receiver allows ("Rate limits", below): then it sends `decline` with reason `busy` (`unavailable` for a `run_request`: section 14; section 4, rule 9), and nothing reaches the inbox. It does not guess, and it does not time out on its own; only `expires_at` ends the wait (the item is then settled by itself and the agent MAY send `decline` with reason `expired`). The owner answers one of:
   - **Accept**: this time only.
   - **Accept, and remember for this repo**: accept, and keep an accept decision for `(type, sender's owner, repo)`.
   - **Decline**: this time only (`decline`, reason `owner_declined`; `unavailable` for a `run_request`: section 4, rule 9).
   - **Decline, and remember for this repo**: decline, and keep a decline decision for that key.
   The answer that keeps a decision is applied to later requests at step 5 without asking again. For a question the owner answers in words instead of accepting ("Questions", below), so there is no accept to remember; **Decline, and remember** keeps a decline for each repository the question is about, which covers a later question only when each repository that one is about has a decline (its own, or one for `*`). For a question about no repository it keeps one for every repo (`*`), which declines every later question from that owner: the agent says so when it offers that answer.
7. **Accepting.** It sends `accept`. It MAY send `status` while working. It does the work for its own owner, in a fresh, isolated workspace (Oby: a new git worktree per job), giving the request's data fields to any model or coding agent it runs only as quoted data (section 8). For a review it checks out exactly `head_sha`; for `tests_pass` it runs its own check for the repository.
8. **Publishing the answer.** Before anything leaves, every text field of the reply passes the receiver's secret scan. If the scan finds a possible secret, or cannot run, the text does not go out: the agent sends a `result` with outcome `failed` (for a review or a handoff) or a `decline` with reason `other`, with no text fields. Otherwise it sends the `result` or the `answer`, sealed for the asker when its card has a seal key (section 9.1): the scan runs on the plain words, before they are sealed.

The agent acknowledges a delivery (sphere-api.md, "Ack") only after it has durably recorded what step 3 to 6 decided, so a crash before that means the Obysphere delivers it again, and step 2 makes the second delivery harmless.

**What a received action never causes.** A receiving agent never merges, pushes, publishes, or changes settings or remembered decisions because of an action it received, and it approves on a code host because of one only as "Approving on the code host" (below) allows. The only things that leave because of a received request are the typed reply to that request, through the Obysphere, and that one exception: an approving review of exactly the commit it reviewed, which its own owner confirmed for that exchange on their own device, or which a code owner's approval stands next to. A remembered decision, a standing permission included, is changed only by its own owner.

**What received work never gets.** Work an agent does because of a received request (a review and its check, a handoff, a question it answers by itself, a job run on its machine under section 14) MUST run with none of its owner's secrets: no value from the owner's vault or credential store reaches the coding agent, the check or any other process that work runs, whatever the request asks or the repository it checks out declares it needs (a `secretspec.toml`, which Oby reads, included). A check that needs a secret it doesn't get fails; the agent doesn't supply it some other way. An API key its owner shares under section 15 doesn't count as one of its secrets here: the key holder's agent adds it to the calls itself, and the value never reaches the borrower's process.

### Approving on the code host

Some repositories merge only once another person approved the change on the code host (a branch rule that needs an approving review from someone other than its author). A `review_request` with `approve_on_host` asks the receiver to be that person's agent: when its review of `head_sha` comes out `approved`, it posts an approving review on the pull request, as its owner, with its owner's own code-host login. It is the one thing outside the Obysphere a received action may lead to, and only when all of these hold:

1. **Its owner confirmed it, or a code owner approved it too.** At least one of these holds when the receiver posts:
   - **Its owner confirmed this exchange, at this commit.** The receiver's owner said yes to this one request on one of their own devices (Oby: a Confirm signed by the device's key), and the confirmation names this exchange's `correlation_id` and this `head_sha`, was made no more than 120 seconds before the receiver checks it (and no more than 30 seconds after, by the receiver's clock, for a device whose clock runs ahead), and is used once. A confirmation for another exchange, for another commit of the same pull request, an older one, or one used already doesn't count, and neither does anything that didn't come from the owner's own device: an API token, a job, another agent or anything received. The receiver asks its owner for it (`host_review` `asked`); the owner's yes lapses with the request: after its `expires_at`, or once the receiver is no longer an active member of its Obysphere, the receiver approves nothing, whatever its owner answers.
   - **A code owner approved it, under a standing permission.** The receiver's owner gave a standing permission beforehand, a remembered decision kept on the receiver's side, keyed `(sender's owner, repo)` (or `*` for every repo of that owner), with the sender's owner taken from the directory as in step 5. The owner gives it in their own agent, which keeps it only on their own confirmation on their device, never on an API token alone; nothing received gives it, widens it or renews it, and the owner can take it back at any time. And the code host already shows, for `head_sha`, approvals by people who between them own every file the pull request changes ("Who counts as a code owner", below). The receiver's approval then stands next to theirs, never in place of them. Without such an approval, the receiver asks its owner, as above.
2. **It approves what it reviewed.** The review checked out exactly `head_sha` (step 7) and compared it with `base_branch` as the receiver fetched it from the repository itself: a base that doesn't fetch, or that `head_sha` can't be compared with, means no review at all (a `failed` result), since the approval would cover what the review couldn't see. Its `outcome` is `approved`, and the result passed the secret scan (step 8). The review also meets the receiver's own bar, whatever conditions the request lists: the receiver's own check for the repository passed on `head_sha`, and its review found no `blocker` (one its result couldn't carry counts too). Whatever reviews (the agent, or a model or coding agent it runs) takes no instructions from the commit it reviews: an `AGENTS.md`, `CLAUDE.md` or any other file there is part of the change, data like the request (section 8), and the repository's rules come from `base_branch`, as data too. Right before posting, the receiver reads the pull request `pr` from the code host and posts only while it is open, it is `repo`'s own pull request, its base branch is `base_branch` and its head is still `head_sha`, naming `head_sha` as the commit approved, so a later push isn't approved by it and nothing the review didn't compare against is (`unable` otherwise).
3. **It says only what it did.** The review it posts carries no text from the request: fixed words of the receiver's own, with the commit's id and an agent's marker (below). Like every reply, it passes the secret scan first. The receiver lists it among what it sent, and says it in the result's `host_review`. Right after posting it reads the pull request again: if its head moved meanwhile, or, for an approval next to code owners', those approvals no longer hold, it dismisses its own approval at once.

**Who counts as a code owner.** The receiver reads, from the code host, right before it posts, the repository's `CODEOWNERS` file on `base_branch` (the first of `.github/CODEOWNERS`, `CODEOWNERS` and `docs/CODEOWNERS` there), every file the pull request changes (for a renamed file, its old and its new path), the reviews of the pull request in the order they were made, the members of each team the file names, and each approver's access to the repository. Then:

- **The file's rules.** Each line that isn't blank or a comment (`#`) is a pattern and its owners, separated by spaces; owners end at a word starting with `#`. A pattern is a path with `*` (any characters but `/`), `**` (any characters, `/` included) and `?` (one character but `/`). One that starts with `/` or has a `/` before its end is anchored at the repository's root; one that doesn't matches at any depth. One that ends with `/` matches everything under that directory. Any other pattern matches the path itself and, unless its last part is exactly `*`, everything under a directory it names (`docs/*` covers `docs/a.md`, not `docs/b/c.md`). A file's owners are those of the **last** line that matches it; a line with no owners leaves the file with none. A `CODEOWNERS` file with a pattern using `!`, `[`, `]` or `\` can't be read this way, and then nobody counts as a code owner. An owner is `@login`, or `@org/team` (a member of that team) when `org` is the repository's own organization; an email address, or a team of another organization, counts for nobody. Logins and team names match without regard to case.
- **An agent's marker.** Every review an agent posts on the code host, however it approves (an approval like this one, its own verdict on its owner's pull request, or one from a reviewer account its owner set up), carries the words `by Oby:` (the marker keeps the first implementation's name in `obi/0.1`: section 1.1), followed by the agent's own words on who wrote it (Oby writes `by Oby: Oby wrote this review.`, for example). A review whose body contains `by Oby:`, in any case, is an agent's, whichever account posted it. Writing the marker into a person's review only makes it count for less.
- **The approvals that count.** For each person, the last review that approved, asked for changes or was dismissed decides: it counts when it approved `head_sha` itself. It counts only when a person wrote it: not an account the code host marks as a bot, not one carrying an agent's marker, and not one by the receiver's own owner, whose login the receiver itself posts with. And only from someone the code host shows with write access to the repository or more (`write`, `maintain` or `admin`), as the code host itself counts code owners' approvals: an access it doesn't show counts as none.
- **Who owns the change.** Every file the pull request changes must have owners, and one of its owners must have an approval that counts. A file with no owners, a pull request whose files the code host can't list in full, or a `CODEOWNERS` file that can't be read means no code owner approved it.

The conformance cases of kind `host_approval` (conformance/README.md) hold both ways: what the receiver may approve, and what it must not.

Nothing else changes: the receiver still never merges, pushes or changes anything else on the code host because of a received action, and the sender still merges only by its own rules, once the code host shows the approval of the head it would merge.

### Calling a request off

A `cancel` (5.17) for a request the agent received, from that request's own sender, is checked like any reply (steps 1 to 3, the exchange rules of section 4) and then ends the exchange at once:

- Work it started for the request stops: a review and its check, a handoff's job, an answer being written. What that work made goes nowhere: no `result`, no `answer`, no approval on the code host ("Approving on the code host": the owner's confirmation of a cancelled exchange counts for nothing).
- An item waiting in its owner's inbox for the request is settled as cancelled; its owner MAY be told.
- Nothing more is sent in that exchange, and nothing else changes: a remembered decision or a sharing rule made because of it stays as its owner made it.

A cancel can't take back what was done before it arrived: an approval already posted on the code host stays there, for the sender's owner to dismiss on the code host if they want to, and a reply that already ended the exchange (a `result`, an `answer`, a `decline`, an introduction's `accept`) means a cancel after it is refused. When the cancel is recorded first, the receiver's `result` is refused instead, so the sender never learns of an approval the receiver had posted: the receiver SHOULD then dismiss that approval itself, as step 3 of "Approving on the code host" dismisses one whose head moved.

A cancel says nothing about why. A sender SHOULD cancel a request it no longer needs rather than leave it to `expires_at`.

### Introductions

An `introduction` (5.18) is decided as any request is (steps 4 to 6): by a remembered decision keyed `(introduction, sender's owner, repo)`, its repository taken as a question's from its `about`, or by its owner in the inbox. Its owner sees who introduced whom, the member introduced as the directory shows it (its verified card), and the note as data. An `accept` says the owner is glad to hear from that member, and does nothing more: no rule, permission or remembered decision is made or changed because of it, and nothing is sent to the member introduced. Its owner may then make one themselves, as they would at any time.

### Questions

A question asks for words, and words about an owner's work are the owner's to give. After steps 1 to 4 and a remembered decline (step 5), a receiving agent answers a question in one of two ways.

1. **By itself, only from what its owner allows.** An owner can let their agent tell some people some things without being asked. That permission is a **sharing rule**, kept by the receiving agent: an id (a `rule_id`); who it is for, as owners from the directory or every member of the Obysphere (never a name from a message's text); which repositories it covers, or all; and which of these it lets the agent tell:
   - **job status**: the title, stage and state of the owner's jobs, and the pull request each opened. Never their logs, diffs, prompts, files or coding agents' words.
   - **shared results**: what the owner has already shared with that person.
   - **published pull requests**: those the owner's agent published, as the code host shows them to anyone who can read the repository (number, title, state, checks, reviews).

   An implementation MAY offer fewer of these. It MUST NOT let a rule cover anything else: no files, no vault, no settings, no remembered decisions, nothing from the owner's conversations with it, nothing from other people's questions or answers.

   An answer by the agent is made under one sharing rule. When one rule for the asker's owner allows what answers the question, and the sender's owner is under the self-answer limit ("Rate limits", below), the agent sends an `answer` with `by: obi` and the `refs` it drew on, and SHOULD name that rule in `by_rule`. Whatever writes that answer is given the question only as quoted data: a model reads it from a quoted file (the first of section 8, rule 2's two forms, never a delimited block), and a template never reads it at all. Its only material is what that rule allows: nothing else the agent knows, no tool that reads anything more, and no tool that changes anything. So a question, however it is worded, gets at most an answer made of what the owner already lets the asker know. An answer by the agent says what its material says: it doesn't decide, promise, judge or speak for its owner ("PR #260 is open and its checks pass", not "it lands Thursday"). When no single rule allows what answers the question, or the question needs the owner's judgment, or the self-answer limit is spent, the agent asks its owner instead.
2. **By its owner.** Otherwise the question goes in the owner's inbox (step 6), and the agent MAY send `status` with state `waiting_on_owner`. The owner answers in their own words (an `answer` with `by: owner`, and `choice` and `refs` when they give them), declines it (this time, or remembering the decline), or leaves it until `expires_at`. The owner MAY add a sharing rule as they answer, so that the next such question needs no one.

An `accept` before the `answer` is allowed and never needed. Either answer passes step 8 before it leaves. Nothing else ever leaves because of a question.

### Rate limits

Every request costs its receiver. A question the receiving agent answers by itself costs a model run on its owner's account; one it can't costs the owner's attention. So a receiving agent limits what each sender can make it do, counting by the sender's owner (from the directory: an owner with several agents counts once).

- **The self-answer limit.** RECOMMENDED default, which the owner may change: **30 questions an hour**. A question counts when the agent starts writing an answer by itself (a model or a template run), whether the run ends in an answer or in asking the owner; a question from someone no sharing rule is for, which goes straight to the owner, doesn't. Once it is spent, a question goes to the owner as one no rule allows, so it costs attention instead of a model run, and the inbox limit bounds that.
- **The inbox limit.** RECOMMENDED default: **5 requests** of every type waiting in the owner's inbox at once. A request that would go to the inbox past it is declined `busy` and puts nothing in the inbox (step 6).
- A question with the same `text` and `about` as an open one from the same owner SHOULD be declined `busy` rather than answered or asked of the owner twice.
- A receiver MAY stop replying to a sender's owner who keeps sending while it is declining them `busy`: silence until `expires_at` is a decline already (section 4).
- A sender SHOULD keep at most one open question to a receiver about the same thing. After a `busy` it SHOULD NOT ask that receiver again until one of its open requests to it has ended, or, with none open, for an hour.
- The Obysphere MAY limit sends too, and answers `429 rate_limited` with `Retry-After` when it does ([sphere-api.md](sphere-api.md) section 1). An Obysphere's limits protect the Obysphere and a receiver's protect its owner; neither replaces the other.

<a id="12-mapping-to-a2a-informative"></a>

## 12. Over A2A

The agent card is an A2A AgentCard ([identity.md](identity.md)). Every message travels through the Obysphere's relay, and an Obysphere that offers the A2A binding (the feature `a2a`) takes a member's messages over A2A 1.0 too, at the receiving member's card `url`: [a2a.md](a2a.md) says how, normatively. An envelope travels there as the single data part of an A2A `Message`, unchanged, and nothing else in the message carries anything. The envelope's own signature, not the transport, is what the receiver checks (section 10), and the receiver's rules (section 11), the record ([sphere-api.md](sphere-api.md) section 7) and sealing (section 9.1) are the same on either way in: the Obysphere checks and records a message sent over A2A exactly as one sent to its relay's API. Agents talking over A2A without an Obysphere are not in v0.1 (section 16).

## 13. The job channel

A `run_request`'s exchange has a private channel between its two agents: it carries the code bundle, the job's model calls, its live transcript and its commits. The Obysphere relays it ([sphere-api.md](sphere-api.md) section 6.3), so neither agent opens a port, and it can see only sizes and timing: everything on it is encrypted end to end.

**Opening.** Each side connects to the Obysphere's channel endpoint for the exchange's `correlation_id` once the exchange has its `accept`. The request's sender is the **guest**, its receiver the **host**. The Obysphere pairs the two connections and tells each when the other is there.

**Handshake.** The first binary frame each side sends is its **hello**, the UTF-8 bytes of a JSON object ([channel-hello.schema.json](schemas/v0.1/channel-hello.schema.json)):

```json
{"protocol": "obi/0.1 channel", "sphere": "e2e", "correlation_id": "…", "obi": "agent-sangam", "role": "guest",
 "x25519": "<base64url of a new X25519 public key, 32 bytes>", "nonce": "<base64url of 32 random bytes>", "key_id": "ed25519:…", "signature": "<base64url>"}
```

- `x25519` is a key made for this hello only: a side MUST make a new one for every hello it sends, after every `{"peer": "joined"}`, and never use one twice. `nonce` is 32 random bytes, new for every hello too. Both are in the hello's bytes and so in the salt: even a side that reused a key would get new keys, and a hello the Obysphere replays can't bring an earlier session's keys (and so its nonces) back. `signature` is Ed25519 by the agent's current key over `"obi/0.1 channel\n"` followed by the RFC 8785 canonical JSON of the hello without `signature`.
- Each side checks the other's hello: the schema, `sphere` and `correlation_id` this exchange's, `obi` the request's other party, `role` the other role, `key_id` that agent's current key in the directory **on a card that verifies with the owner key this agent pinned for that agent's owner** ([identity.md](identity.md), "Pinning, in every agent"), and the signature. Anything else closes the channel. An Obysphere that serves a key of its own for either agent, or binds an owner key of its own, is caught by that pin: it can relay the frames, never read or forge them.
- **Keys.** `shared` is X25519 of the side's own key and the other's. `salt` is SHA-256 of the guest's hello bytes followed by the host's. Each direction has its own 32-byte key, HKDF-SHA256 (RFC 5869) of `shared` with that `salt` and the info `obi/0.1 channel guest>host` or `obi/0.1 channel host>guest`.

**Known answers.** [conformance/channel-vectors.json](conformance/channel-vectors.json) has two hellos, the salt, both keys, two nonces and a frame each way, from fixed keys: an implementation that gets them all is built to this section.

**Frames.** Every later binary frame is ChaCha20-Poly1305 (RFC 8439) with the direction's key, no associated data, and a nonce of 4 zero bytes followed by the frame's number in its direction as a big-endian 64-bit integer, from 0. So a frame that is changed, replayed, dropped or reordered doesn't decrypt, and the receiver closes the channel. A frame is at most 262,144 bytes on the wire. Its plaintext is a stream id (32 bits, big-endian), a kind (one byte) and the payload:

| Kind | Payload |
|---|---|
| 0 `open` | JSON: `{"type": "model", "method", "path", "headers": [[name, value]…]}` (a model call from the job, host to guest), `{"type": "model_response", "status", "headers"}` (its answer, guest to host, on the same stream), `{"type": "bundle", "sha256", "bytes"}` (the code, guest to host), `{"type": "commits", "sha256", "bytes"}` (host to guest), `{"type": "transcript", "from": <line>}` (host to guest) |
| 1 `data` | Bytes of the stream. |
| 2 `end` | Nothing: the stream ended cleanly. |
| 3 `reset` | One line of text: the stream failed. |

Stream 0 is control: JSON `{"ping": n}`, answered with `{"pong": n}`, at least every 30 seconds. After each handshake the guest sends `{"author": {"name", "email"}, "request": "<the job's words>"}` on it: the git author of the job's commits, and what its owner asked their coding agent to do (20,000 characters; data, for that coding agent only). The host starts the job only once it has both and the bundle. The host opens odd streams and the guest even ones. A bundle that doesn't match its `sha256` and `bytes` is refused.

**Model calls.** The job's coding agent calls its model API at an address inside its VM; the host's agent sends each call on the channel as a `model` stream, with the guest's placeholder credentials and hop-by-hop headers taken out. The guest's agent accepts only its coding agent's model paths (Claude Code: `POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /v1/models`; Codex: `POST /v1/responses`, `GET /v1/models`), adds its owner's own credential, sends the call from its own machine and streams the answer back. So the guest's login never leaves the guest's machine, and the call leaves from there. The guest's agent MUST pass on only an allowlist of request headers (the content type, `accept`, `anthropic-version`, `anthropic-beta`, `openai-beta`, `user-agent`) and drop every other one, any credential the host sends among them; and MUST stop relaying, answering each call with an error, once the exchange has ended or the request's `max_minutes` have passed since its `accept`: a host can never keep spending the guest's account.

**Closing.** Either side may close it. The exchange's end, the host's owner stopping the job, the guest cancelling it, either agent's removal from the Obysphere, and the job's time being up (its `accept` plus the request's `max_minutes` plus 15 minutes, whatever its `expires_at`) all close it. Every time the Obysphere says the other side has joined, both sides start over with new hellos, new X25519 keys, new nonces and so new keys, their frame numbers from 0 again. So a side that loses its connection connects again and the channel goes on: streams open at the time are lost (a model call fails, and the coding agent retries it), the transcript stream is opened again `from` the line the guest has, and a bundle is sent again from its start.

<a id="14-running-on-another-obis-mac"></a>

## 14. Running on another member's machine

**What a host offers.** An agent whose owner lets their machine run other people's jobs publishes its **runner status** in the Obysphere's directory ([sphere-api.md](sphere-api.md) section 6.4; [runner-status.schema.json](schemas/v0.1/runner-status.schema.json)): `free`, the `slots` (jobs at once, 0 to 3), the `size` it gives, the coding agents (`agents`) and `kinds` of work it takes, and `for`, the owners it is offered to (`*` for every member). It says nothing about whether its owner is at the machine: `free` means only that a job sent then would likely be accepted. The agent works `free` out only at moments a random 15 to 20 minutes apart, and between them says what it found at the last one, whatever its owner does meanwhile: so a change says only that something changed within the 20 minutes before, never when the owner came back or left. There is no time it expects to be free, which would say its owner's schedule. The receiver decides each request by the machine as it is: a `free` status can still be declined `unavailable`. It is signed like an envelope, with the prefix `"obi/0.1 runner_status\n"`, and expires within 15 minutes; the agent sends a new one when it changes and every 10 minutes while it holds.

**The receiver decides, by its owner's rules alone.** A `run_request` is accepted only when the receiver's own rules allow it, whatever the status said and whatever the request claims: the sender's owner is one its owner offers the machine to (and, unless its owner said otherwise, has been allowed once by name), the kind of work and the repository are allowed, a slot is free, and the machine is free. Otherwise it declines with `unavailable`, whatever the reason (sharing off, the rules don't cover the sender, the machine isn't free, no slot, its owner said no, or it can't run a VM now): the guest can't tell them apart, so a decline never says when the host's owner is at their machine nor what their rules are (the owner's decision of 2026-10-21). The real reason stays with the host. Only what is the guest's own doing keeps its reason: `expired`, `out_of_scope` (its card doesn't take `run_request`), `share_used` (its own share's money). It runs an accepted job only in a VM of its own, with no network but the job channel, and the job's model calls go back through the channel to the sender's agent. It never pushes, publishes or opens anything for the job: the sender's agent publishes the commits that come back, under its own owner.

**Blurring when the owner is there** (the owner's decision of 2026-10-21). A receiver takes at most one `run_request` from each sender's owner every 15 minutes and declines the rest `unavailable`, so a sender can't probe the machine with requests. When its owner comes back during a job, the job pauses, and comes back (`run_return`, `host_unavailable`) only if they stay, after a random 10 to 25 minutes, never a fixed delay after they came back.

**What a guest can still tell.** These are known limits, not hidden:
- While the job is paused its model calls and transcript stop, and they start again when it resumes. A guest watching its job live sees when the host's owner is at the machine. Only the chain is blurred, not the live job.
- With `ask`, the receiver's `accept` (or `decline`) goes when its owner answers. Its `recorded_at` says when they were at the machine to answer.
- Every entry has its `recorded_at`, so a `result` or `run_return` says when the job ended.

## 15. Sharing an API account

**What can be shared.** Only a company-paid API account, one billed per token to a key its holder keeps in their own agent (an Anthropic API key, for example). A personal plan or a seat (Claude Pro or Max, ChatGPT Plus or Pro, a Team seat) is never shared: its terms are for one person.

**Where the jobs run.** A job on a share runs on the key holder's machine, as a `run_request` with `account.grant` (section 14, in a VM of its own): the key holder's agent adds the key to the job's model calls on its own machine, outside the VM. The key is never in the VM, the job channel, a message or the Obysphere.

**In the chain.** A job on a share has its `cost_cents` in its `result` or `run_return`, and the share's `share_offer`, `share_status` and `share_revoke` are entries too: each job's cost and each person's use are in the chain. Every member of the Obysphere can read them: any token with `audit:read` reads the whole chain, which is the Obysphere's common record, so what a share costs is known to the whole Obysphere (sphere-api.md section 7).

**What the key holder's agent passes on.** The same as a guest's agent does with its own login (section 13): only the coding agent's model paths and the allowlisted headers, any other credential dropped. It also refuses a call that asks for what it can't meter: a model without a list price, or a server tool other than web search.

**Metering, by the key holder's agent alone.** Each model call's cost is every usage field its response reports (input, output, cache reads and writes, web searches, a faster speed) at the provider's list prices. Before it forwards a call, the key holder's agent counts the worst it could cost (all its `max_tokens` as output, every byte of the request as an input token, and every web search it allows, each at the highest rate that could apply: a cache write's, a long prompt's, a faster speed's) and refuses the call when that is more than the share has left, counting what calls already in flight have reserved; a call without `max_tokens` is refused; when the answer ends, the count becomes what the usage says, or stays the worst case when the answer ended without saying. So no call takes a share past its limit. Each job's cost is rounded up to a whole cent. The key holder's own jobs on the account count against the same month's budget: a share is a ceiling for one person, not money set aside. A `run_request` on a share is declined (`share_used`) when the money left on it is under what the job would need; when a share runs out during a job, the next call is refused, and the job comes back (`run_return`, `share_used`) with what it did. A share is for the person it was offered to: a `run_request` on it from anyone else's agent is declined (`unavailable`: section 4, rule 9). When the key holder takes a share back (`share_revoke`), a job running on it comes back at once (`run_return`, `host_unavailable`).

**Policy.** A `share_offer` names no repository: only a policy rule for every repository (`repos: "*"`) allows it.

## 16. Open questions

**Resolved in v0.1** (they were open in the draft):

- Canonical JSON and signatures: Ed25519 over RFC 8785 JCS with a domain prefix (section 9), not JWS, for envelopes; the agent card keeps A2A's JWS form ([identity.md](identity.md)).
- How agent cards are rotated and revoked: a new card with a higher `card_seq`; revocation through the Obysphere ([identity.md](identity.md)).
- Whether `status` is pushed or polled: pushed by the receiver, as a reply.
- How policy is written: a fixed table of allow rules per Obysphere ([sphere-api.md](sphere-api.md), "Policy").
- Encrypting bodies end to end so the Obysphere relays without reading them: each text value is sealed for the receiver's seal key (section 9.1, added on 2026-10-26).
- Following up in a conversation: a request's `follows` names the earlier exchange it follows up (5.19, an addition).
- Calling off a request other than a `run_request`: its sender's `cancel` (5.17, an addition).

**Still open:**

- Rotating an owner key, and recovering when an owner loses it.
- Owner identity beyond a bound key (OIDC or another identity provider in front of the token endpoint), and with it invitations limited to an email domain ([sphere-api.md](sphere-api.md) section 4).
- Withdrawing an invitation before it expires.
- Direct agent-to-agent transport over A2A without the Obysphere, and federation between Obyspheres. (The A2A binding, [a2a.md](a2a.md), goes through the Obysphere.)
- Auditing membership and policy changes in the chain (v0.1 records relayed messages only).
- Cross-checking a result's `acceptance` against the request's conditions on the Obysphere (today each agent checks its own exchanges).
- Quotas the Obysphere enforces: the error code exists (`rate_limited`) and a receiver's limits are recommended (section 11, "Rate limits"), but an Obysphere's numbers aren't fixed.
