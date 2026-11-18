# The Council's review profile

Status: **Draft**. Not part of `obi/0.1`; nothing here changes what an `obi/0.1` implementation must do.

This document specifies the first use of the Council process ([process.md](process.md)): a panel of members, drawn by lot, reviews a change, and the clerk counts their verdict. It runs on today's `obi/0.1` actions with no new wire types: `question` and `answer` call the pool, `review_request` and `result` carry each seat's review and the verifier's challenge, and every count is re-checkable from the Obysphere's chain without any key.

Companion documents: [process.md](process.md) (the process and its integrity rules I1 to I9), [draw.md](draw.md) (eligibility, anchors, the seed and the draw), [../protocol.md](../protocol.md) (the actions), [../sphere-api.md](../sphere-api.md) (the chain), and the clerk ([../../clerk/](../../clerk/)).

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as in RFC 2119 and RFC 8174 when, and only when, they appear in capitals. Terms from process.md, draw.md and protocol.md mean what they mean there.

## 1. Overview

```
convener                                                     the Obysphere's chain
 1  motion and pool (sections 2, 3)
 2  a call to every pool member: question, id from the pool hash ──►  anchors: the pool is fixed
       a member may stand aside: answer, choice 1                ◄──
 3  wait for quicknet's round R (> the first call + 300 s); draw
 4  one review_request to each seat                              ──►  one exchange per seat:
       accept, result (outcome, findings, acceptance)            ◄──   no seat sees another's
 5  one review_request to the verifier: one custom
    condition per blocking finding                               ──►
       result: met = the finding stands, not met = refuted       ◄──
 6  tally the chain, count with the clerk, sign the record: the verdict
```

The **convener** is the member that puts the motion, acting for its owner. It never sits on its own motion.

## 2. The motion

The convener writes the motion before anything else and keeps it in its record (section 8). It is a JSON object (protocol.md section 2's rules):

| Member | Meaning |
|---|---|
| `profile` | `"review"`. |
| `sphere` | The Obysphere. |
| `convener` | The convening member's `obi_id`. |
| `owner` | The convener's owner: the motion's owner. |
| `author` | The owner who wrote the change (rule I2). Often the motion's owner too. |
| `subject` | `{repo, pr?, base_branch, head_branch, head_sha}`: the change, as `review_request` names one (protocol.md section 5.1). |
| `acceptance` | 1 to 10 acceptance conditions (protocol.md section 6): what every seat's review checks. |
| `rule` | `{"kind": "majority"}`, `{"kind": "unanimity"}` or `{"kind": "supermajority", "num", "den"}`, as the clerk takes them. |
| `quorum` | The least number of seats whose review counts, 1 to `seats`. |
| `veto` | `true` when a blocking finding that stands rejects the change whatever the votes (process.md step 7). SHOULD be `true`: finding problems is this profile's purpose. |
| `seats` | The number of voting seats. |
| `verifiers` | 0 or 1: whether a verifier challenges the blocking findings. |
| `diversity` | `{owners, vendors}` (draw.md section 2). |
| `deadlines` | `{seats, reviews, challenge}`, timestamps in this order, `seats` at least 600 seconds before `reviews` and `challenge` at least 1,200 seconds after it (time to send the challenge, and to replace a verifier): until `seats` a seat that declines is replaced; a seat's result counts only when it is recorded by `reviews`, and the verifier's only by `challenge`. |
| `words` | `{goal, summary}`: the lower-case hex SHA-256 of the UTF-8 bytes of the `goal` and `summary` every seat's request carries (`summary` null when there is none). Each seat checks the words it opens against them (section 5). |
| `created_at` | When the convener wrote it. |

The motion's hash is the lower-case hex SHA-256 over the UTF-8 bytes of `"council motion\n"` followed by its RFC 8785 canonical JSON. The motion holds no words, only their hashes: what a seat is asked to look at is the `subject` and the `acceptance`, and the convener's words go in each request's `goal` and `summary`, sealed for that seat.

In this profile a blocking finding is one of severity `blocker`, and its evidence is its citation: `file`, `line` and `detail` (process.md step 1, `evidence`: `citation`). Budgets (process.md step 1) aren't carried by any `obi/0.1` request: a seat keeps to its own.

## 3. The pool

The pool is draw.md section 2's, with `request` `review_request` and `exclude` the motion's `author` and `owner`. The convener reads the directory at the chain's head and keeps, in its record, the card of every member active at that point.

## 4. Calls: fixing the pool, and standing aside

Before the draw, the convener sends every pool entry a **call**: a `question` (protocol.md section 5.2) that is both an anchor (draw.md section 3) and a summons.

- `id` is the anchor id for the pool hash and the entry's `obi_id`.
- `about` is the subject: `[{"kind": "pr", "repo", "pr"}]`, or `[{"kind": "repo", "repo"}]` when the change has no pull request. Every member can read it, so every anchoring of a subject is visible in the chain (draw.md section 8, "Re-rolling").
- `choices` is exactly `["sit", "stand aside"]`: index 0 means the member will sit if drawn, index 1 that it stands aside. The words are fixed so that each receiver can check its own: they are sealed like every text, so only the receiver sees whether the convener kept to them (section 9, "Sealed words").
- `text` says, as data, what the panel is and gives the motion hash and the pool hash, so its receiver can later check the record against what it was told. A RECOMMENDED form: `Council call: a review of acme/app#7 at 6d20146f. Motion <hash>. Pool <hash>. Seats are drawn by lot from drand's quicknet round more than 300 seconds after the first call.`
- `expires_at` is the motion's `deadlines.seats`.

A call is a question like any other: its receiver's owner decides whether and how to answer, and its text is data (protocol.md sections 8 and 11). It asks for an answer in words and a choice, never for work. A receiver whose call's `choices` aren't exactly these two SHOULD treat the call as invalid and tell its owner.

**Recognising calls.** A call is a `question` `about` the subject whose `id` is a version 8 UUID; any member can tell one in the chain without the record. Every call MUST be recorded before round *R*'s time. From `anchored_at` less 300 seconds and one beacon period, up to round *R*'s time, the only calls about the subject from any member of the convener's owner are this pool's (draw.md section 7, check 2).

**anchored_at** is the earliest `recorded_at` among the calls in the chain (draw.md section 3). A call the Obysphere refuses (its policy, a revoked member) isn't sent: that entry has no call and stays in the pool, as an entry is declined only by what the chain shows.

**Standing aside.** A pool member stands aside when its call's exchange ends, before round *R*'s time, with an `answer` whose `choice` is 1, or with a `decline`. Members that stood aside are the first draw's `declined` (draw.md section 6). An answer after round *R*'s time changes nothing: a member drawn after it declines its review request instead.

## 5. The draw and the seats' requests

The convener waits for round *R*, the first quicknet round more than 300 seconds after `anchored_at` (draw.md section 4), checks its signature, and draws (draw.md section 5) with the members that stood aside as `declined`. An unmet draw ends the motion: it goes to its owner.

Each voting seat gets **one `review_request`**, its own envelope and exchange:

- `repo`, `pr`, `base_branch`, `head_branch` and `head_sha` are the motion's `subject`; `acceptance` is the motion's.
- `goal` and `summary` are the convener's words, as data, the same for every seat: their SHA-256 are the motion's `words`. A seat checks the words it opens against them; when they differ it MUST decline with reason `other` and tell its owner, and a re-checker treats the verdict as invalid (section 8).
- It MUST NOT carry `approve_on_host`: a panel's verdict never stands in for a person's approval on the code host (rule I7).
- `expires_at` is the motion's `deadlines.reviews`, the same instant for every seat.
- It is recorded after round *R*'s time, and no later than 600 seconds after it, or after the decline that gave the seat its place (draw.md section 7, check 5). A seat whose request isn't in the chain by then makes the verdict invalid: the convener can't leave a seat out, or hold a request back to time a replacement.

**Blind to the words** (rule I1). The Obysphere relays each exchange between its two members only, so a seat never receives another seat's request or result, and the words of a result are sealed for the convener. The convener MUST NOT pass a seat's result, outcome or findings to another seat before every seat has answered or `deadlines.reviews` has passed, and in this profile it never passes them to a seat at all: there is no reveal, and each seat's result is its final ballot. This needs the convener's card to have a seal key, which it SHOULD have: a convener without one gets the results' words in the clear, readable by the Obysphere (section 9). What the chain shows every member is not blind: a result's outcome, and its findings' severities, files and lines, are readable by anyone who reads the chain, so a seat that answers late could see how the others voted. A seat SHOULD NOT read the chain's entries about the subject before it answers; nothing in this profile can prove it didn't (section 9).

A seat reviews the subject as data, in a sandbox with none of its owner's secrets (rule I8; protocol.md section 11).

**Declines and replacements.** A seat whose exchange ends in a `decline` before `deadlines.seats` is declined, and the convener runs the draw again with it in `declined` (draw.md section 6) and sends the replacement its request; every other seat keeps its place. Silence declines nobody: a seat that never accepts, or answers after `deadlines.reviews`, is absent, and nobody takes its place. A declined seat's later result never counts: it is no longer a seat.

## 6. The challenge and the tally

### The challenge

The **blocking findings** are the findings of severity `blocker` in the seats' counted results (below), in the order of the seats as the last draw took them, and within a result in its own order.

With a verifier and at least one blocking finding, once every seat has answered or `deadlines.reviews` has passed, the convener sends the verifier `review_request`s for the same subject whose `acceptance` together hold one `custom` condition per blocking finding, in that order: ten to a request (the most a request carries), in as many requests as it takes, all recorded by `deadlines.challenge` less 600 seconds. Each condition's text is exactly `Finding <n>: <file>:<line>`, then a line break and the finding's title: *n* counts from 1 across the requests, and `file` and `line` are the finding's, which the chain shows to everyone. The verifier MUST compare each condition's file and line with the blocking findings it reads in the chain, in order, and refuse the challenge (decline, reason `other`) when they differ: so a convener can't send it to refute a finding other than the one the chain holds. `expires_at` is `deadlines.challenge`.

The verifier tries to refute each finding, by reading the cited lines and running what it can in its own sandbox, and answers each request with a `result`: an acceptance entry `met: true` means the finding **stands**, `met: false` that it is **refuted**. Its own findings aren't counted.

A finding stays standing when nobody refutes it: with no verifier, or when the verifier fails or doesn't answer by `deadlines.challenge` (process.md step 5: the burden is on the challenger). A verifier that declines any of its challenge requests by `deadlines.challenge` less 1,200 seconds MUST be replaced: the convener runs the draw again with it in `declined`, and sends the new verifier the same challenge requests within 600 seconds of that decline. A verifier that declines later leaves the findings standing. With a verifier, a challenge in this shape is required: a verdict whose blocking findings were never put to the verifier is invalid (section 8).

### The tally

The **tally** turns the chain into the clerk's count input. It reads only what stays readable when the words are sealed (types, members, times, outcomes, commit ids, finding ids and severities, acceptance kinds and results: protocol.md section 9.1), so any member holding the chain can tally again without a key. Its input:

| Member | Meaning |
|---|---|
| `convener` | The convener's `obi_id`. |
| `subject` | `{repo, head_sha}`. |
| `rule`, `quorum`, `veto` | The motion's. |
| `seats` | The voting seats, as the last draw took them. |
| `verifier` | The verifier, when there is one. |
| `round_at` | Round *R*'s time. |
| `deadlines` | `{reviews, challenge}`, the motion's. |
| `entries` | The chain's entries (`{seq, recorded_at, envelope}`), in chain order. |

The tally, as the clerk implements it (`reviewTally` in TypeScript, `review::tally` in Rust):

1. **Requests.** The panel's requests to a member are the `review_request`s from the convener to it whose `repo` is the subject's (ignoring ASCII case) and whose `head_sha` is the subject's, recorded after `round_at` and by `deadlines.reviews` for a seat, or by `deadlines.challenge` less 600 seconds for the verifier. A review the convener asked for before the round or after those times, an ordinary one or a dropped panel's, is never the panel's. Two such requests to one seat make the input invalid (`two_requests`); the verifier may have several (the challenge).
2. **Counted results.** A request's exchange ends with its receiver's first `result` or `decline`. It counts when that is a `result` for `review_request`, for the subject's `repo` and `head_sha`, with outcome `approved` or `changes_requested`, recorded by the deadline: `deadlines.reviews` for a seat, `deadlines.challenge` for the verifier. A `failed` result, a decline, no answer, a late answer, or a review of another commit is absent. A counted result whose findings lack an `id` or a `severity` or repeat an `id`, or whose acceptance entries lack an integer `index`, a `kind` or a boolean `met` or repeat an `index`, makes the input invalid (`bad_input`).
3. **Ballots.** For each seat in order whose result counts: `approve` for `approved`, `reject` for `changes_requested`.
4. **Findings.** Each counted result's findings, in order, as `{id: "<seat>/<finding id>", blocking: severity is blocker, evidence: true, challenge: "none"}`.
5. **Challenge.** With a verifier and at least one blocking finding: when every one of the verifier's requests has 1 to 10 conditions, all `custom`, and together one per blocking finding, each blocking finding takes `stands` or `refuted` from the `custom` acceptance entry at its place in its request's counted result, and keeps `none` without one. Otherwise every finding keeps `none`.
6. The count input is `{rule, quorum, veto, seats, ballots, findings}`.

Since nothing after the deadlines counts, the tally of a chain read at any time after `deadlines.challenge` is the same.

Errors, the first that applies: `bad_input` (the shape: a missing or unknown member, a `head_sha` that isn't a commit id, a time that isn't a protocol timestamp from 1970, an entry without an integer `seq`, a `recorded_at` or an envelope with `id`, `type`, `from`, `to`, `correlation_id` and an object `body`); `bad_panel` (a rule other than the three or with members it doesn't take, a quorum below 1 or above the seats, a seat twice, the convener or the verifier among the seats, deadlines out of order, not after `round_at`, or a `challenge` less than 1,200 seconds after `reviews`); then, while tallying, `two_requests`, or `bad_input` for a counted result's malformed findings or acceptance.

### The count

The clerk counts the tally (clerk/README.md): `approve`, `reject` (by the votes, or because a blocking finding stands, listed in `blocked_by`), `tie`, `no_quorum` or `no_votes`. A tie, a missed quorum or no votes go to the motion's owner (process.md step 9).

## 7. Signing the verdict

The convener counts once `deadlines.challenge` has passed, or sooner once every seat's exchange and the verifier's have ended. The verdict is the convener's **record**, signed. A JSON object:

| Member | Meaning |
|---|---|
| `motion`, `motion_hash` | The motion and its hash. |
| `pool`, `pool_hash` | The pool record and its hash (draw.md section 2). |
| `cards` | The card of every member active at the pool's `at` (draw.md section 2: a key valid at `at.seq` + 1), as the convener trusted it (draw.md section 7, check 1). |
| `calls` | `[{to, id}]`: each call in the chain. |
| `anchored_at` | The earliest call's `recorded_at`. |
| `beacon` | `{chain, round, signature, randomness}`: quicknet's round *R*. |
| `draws` | Each run of the draw: its `declined` and its output (draw.md section 5). The last gives the seats and the verifier. |
| `through` | `{seq, hash}`: the chain's head when the convener counted. |
| `tally`, `count` | The clerk's count input and its count. |
| `key_id` | The convener's key that signs it. |
| `signature` | Ed25519 over the UTF-8 bytes of `"council record\n"` followed by the record's canonical JSON without `signature`, base64url without padding. The prefix keeps it from ever being valid as an envelope's signature. |

The record holds no words: the reasons are in the seats' results, sealed for the convener. Its structure (who sat, the ballots, the severities, the outcomes) is readable by everyone, and the **minority opinion** is in it: the ballots on the losing side, and the findings of the seats that cast them. In this profile the record isn't in the chain: no `obi/0.1` action carries it. The convener keeps it and gives it to anyone who asks, and the calls in the chain show that a panel was convened.

## 8. Re-checking a verdict

A member re-checks a verdict from the record and the chain:

1. The chain verifies (sphere-api.md section 7.1, `verifyChain`), and `through` is in it.
2. The motion hashes to `motion_hash`, and the record's signature verifies with the convener's key `key_id`, valid at `through.seq`.
3. The draw re-checks (draw.md section 7): the pool, the calls as its anchors, the round, and each draw run, with the first run's `declined` exactly the members that stood aside before round *R*'s time, and each later run's adding exactly the seats that declined before `deadlines.seats` and the verifier that declined by `deadlines.challenge` less 1,200 seconds.
4. Every `review_request` from the convener for the subject recorded after round *R*'s time and by `deadlines.challenge` less 600 seconds went to a member of some draw run, and every recipient outside the last run is in its `declined`. Every seat of the last run got its request within 600 seconds of round *R*'s time, or of the decline that gave it its place, with `expires_at` equal to `deadlines.reviews` and the same readable fields as every other seat's.
5. With a verifier and blocking findings, the verifier's requests hold the challenge section 6 describes, recorded by `deadlines.challenge` less 600 seconds (a replacement verifier's within 600 seconds of the decline that seated it).
6. No envelope passed between two members of the panel (its seats and its verifier) from round *R*'s time to `deadlines.challenge`: seats that can tell who else sits must not confer (rule I1).
7. The tally of the chain is the record's `tally`, and the clerk's count of it is the record's `count`.

Each check is deterministic. A verdict that fails one is invalid, whoever signed it. A seat, or the verifier, that found its opened words don't match the motion's `words`, or a condition that doesn't match the chain's finding, says so to its owner: that verdict is invalid too, though only the receivers of the sealed words can tell.

## 9. What this profile leaves out

- **Reveals and second ballots.** No seat sees another's review, so there is no reveal, no commitment step and no change of mind: each result is a final ballot. Whether reveals improve verdicts or only herd them is the evaluation's question (eval/), and the assembly profile's.
- **Typed evidence.** A finding's evidence is its citation; the clerk trusts the profile's mapping (process.md section 7, "Evidence in findings").
- **A convener without a seal key.** Results' words are sealed only for a receiver whose card has a seal key (protocol.md section 9.1). A convener without one gets them in the clear, which the Obysphere can read: a convener SHOULD publish a seal key before it convenes.
- **Sealed words.** A request's words are sealed for each receiver, so only that receiver can compare them with the motion's `words`, only a called member can check its call's `choices`, and only the verifier can compare a condition's text with the chain's finding. A convener could word one seat's request to provoke a decline, and only that seat would know: the check is the receivers', and what they report is their owners' word.
- **Strategic declines.** A seat that declines on purpose hands its place to the next entry, whom everyone can compute (draw.md section 8).
- **What the chain shows.** A result's outcome and its findings' severities, files and lines are readable by every member, so a seat that answers after others could follow their votes. Commitments made before any result is revealed (the assembly profile's `commit` and `reveal`) close this; on today's actions a seat only SHOULD NOT look.
- **Persons.** Owners can't sit in person, and the verdict never replaces a person's approval (rule I7).
- **The record in the chain.** It waits for the assembly actions (process.md section 6).

## 10. The vectors

[clerk/vectors/review.json](../../clerk/vectors/review.json) has the tally's vectors: the chain's entries, with sealed words, round *R*'s time and the deadlines, and the count input they give, or the error. They cover a refuted, an upheld, an unanswered and a late challenge, eleven blockers challenged in two requests, challenges that don't count, declines, absences, a late result, a review asked for before the round, requests after their deadlines, deadlines at the 1,200-second edge, a review of another commit, a reply from someone else, repeated finding ids and acceptance indexes, and every error. The answers come from [clerk/vectors/review.py](../../clerk/vectors/review.py), a third implementation in Python's standard library, written apart from the Rust and TypeScript ones; every output is a count input the clerk counts.
