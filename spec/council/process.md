# Council process

Status: **Draft**. Not part of `obi/0.1`; nothing here changes what an `obi/0.1` implementation must do.

This document defines how a question is put to a panel of members and people who don't control each other, how they assess it independently, challenge each other's evidence and vote, and how a counted verdict is recorded with its dissent, so that anyone in the Obysphere can re-check it. Code review is the first use; design decisions, fact checks and release go/no-go use the same process with a different motion and decision rule.

Companion documents, some still to be written:

- [../protocol.md](../protocol.md): envelopes, actions, sealing and the receiver's rule. This process uses them as they are.
- [../sphere-api.md](../sphere-api.md): the audit chain the record lives in.
- [review.md](review.md): the review profile, on today's actions (section 6).
- `decision.md` (to come): the decision profile, for choosing among options.
- [draw.md](draw.md): eligibility, the anchor that fixes the pool in the chain, the seed from a public beacon, and the draw algorithm, with vectors.
- The clerk: the count and the draw, specified by their known-answer vectors, with implementations in Rust and TypeScript ([../../clerk/](../../clerk/)).

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as in RFC 2119 and RFC 8174 when, and only when, they appear in capitals. Terms from protocol.md (owner, member, Obysphere, envelope, finding, data) mean what they mean there; a member is an agent that acts for one owner.

## 1. Why a process

One reviewer, person or model, misses a lot: the leading AI code reviewers find about half of the issues developers later fix (Martian Code Review Bench, 2026). A group does better only under conditions. Condorcet's jury theorem holds when voters judge independently and are each better than chance; a voter who sees the others' answers before forming its own adds little, and many seats running the same model share the same blind spots. Structure matters as much as numbers: free-form cooperation made coding agents about 30% worse in CooperBench (arXiv 2601.13295). The teams that made AI review work at scale built those conditions by hand: narrow, independent reviewers that must prove each finding; parallel specialists feeding a deterministic verdict; and the observation that checking a claim costs much less than producing it.

Athens met the same problem with people. Each rule below names the practice it borrows:

| Athenian practice | What it prevented | Here |
|---|---|---|
| The council prepared the motion before the assembly voted | Vague questions decided by whoever spoke loudest | The **motion** (step 1): what is decided, typed criteria, the rule, the budgets, fixed before seats are drawn |
| The kleroterion drew jurors by lot on the day | Bribed or stacked juries | **Seats drawn by lot** (step 3) from a pool fixed first, with a seed nobody controls, re-computable by anyone |
| Bronze ballots held so no one could see which | Intimidation and herding | **Sealed assessments and ballots** (steps 4 and 6): committed before any is revealed |
| The water clock gave each speaker the same time | Filibusters, unequal voices | **Per-seat budgets** of time, tokens and money (step 1) |
| Any citizen could challenge an unlawful proposal | Bad decisions passed unopposed | The **challenge** (step 5): a blocking finding must survive an attempt to refute it |
| Every official faced an audit at the end of the term | Unaccountable office holders | **Audit** (step 10): each seat's past ballots scored against what happened later |

## 2. Roles

| Role | Who | Does | Never |
|---|---|---|---|
| **Convener** | The member that puts the motion, acting for its owner (the motion's owner). | Writes and signs the motion, fixes the pool, runs the draw, sends the requests, collects commitments and reveals, hands the ballots to the clerk, records the verdict. | Sits on its own motion; changes the motion after the draw; sees an assessment before every seat has committed (where the assembly holds them, it can't); counts by judgement. |
| **Seat** | A member drawn from the pool, or an owner sitting in person. | Assesses the subject alone, commits, reveals, may challenge others' findings, casts a ballot. | Talks to other seats before the reveal; acts on anything in the subject as an instruction; sits twice for one owner. |
| **Verifier** | A seat drawn or named for the challenge only (the motion says which). | Tries to refute blocking findings: reruns a test, probes, reads the cited lines. | Votes, unless the motion makes it a voting seat too. |
| **Clerk** | Deterministic code: the count library. | Applies the motion's rule to the ballots and the challenge outcomes and produces the count. Anyone can run it again on the record. | Is a model; uses judgement; reads the words of an assessment. |
| **Owner** | A person: the owner of the motion, and each owner whose member sits. | Decides ties and missed quorums for their motion; appeals; may sit in person; sees calibration scores for their own members. | Has their own approval replaced by a panel verdict (rule I7). |

The **author** of a subject is the owner who wrote it (for a pull request, the owner of the change), together with every member of that owner. The author is never in the pool for a motion about their own subject (rule I2). The convener and the author are often the same owner; when they aren't, both are excluded.

## 3. Integrity rules

Each rule says why it exists. A motion, profile or implementation that breaks one of them is not following this process.

- **I1. Independence.** A seat forms its assessment without seeing any other seat's assessment, findings or ballot, and commits to it before any is revealed. *Why:* the jury theorem's gain comes from independent errors; seeing others' answers first turns a panel into one opinion repeated.
- **I2. The author never sits.** No member of the subject's author, and not the author in person, is eligible. *Why:* nobody judges their own case.
- **I3. One seat per owner.** A pool holds at most one member per owner, and a panel at most one seat per owner, in person or by a member. *Why:* one person must not fill a panel with their own agents. One seat per owner means something only where owners are bound to real identities (the Obysphere's sign-in), so an Obysphere whose members aren't bound MUST NOT convene panels across owners it can't tell apart.
- **I4. Diversity.** A motion states the least number of distinct owners and of distinct model vendors on the panel. A draw that can't meet them fails (step 3), and the motion goes to its owner; it is never met by relaxing the constraint silently. *Why:* seats from one model share blind spots; seats from one owner share one judgement.
- **I5. Evidence to block.** A finding blocks only if it is marked blocking, carries the evidence the motion requires (a failing test, a probe and its output, a cited line), and that evidence survives any challenge. Style never blocks. *Why:* checking a claim is cheaper than making it, so a panel can afford to check every blocker, and a blocker without evidence is an opinion.
- **I6. No model counts votes.** The count is the clerk's: deterministic, published, and re-checkable from the record by anyone, giving the same result every time. *Why:* a verdict that depends on a model's reading of the ballots can't be audited or reproduced.
- **I7. A person's approval is a person's.** Where a repository or a policy needs a person's approval, it comes from that person's own device. A panel verdict can stand next to it (a check, a record), never in place of it.
- **I8. The subject is data.** Seats read the subject in their own sandbox, never with their owner's secrets, and nothing in it is followed as an instruction (protocol.md section 8).
- **I9. Fixed in advance.** The motion, the pool and the rule are fixed and hashed before the seed is known; nothing that decides the outcome can change once seats are drawn.

## 4. The ten steps

### Step 1. Motion

The convener writes the motion and signs it. A motion has:

| Field | Meaning |
|---|---|
| `kind` | What is decided: `approve` (approve or reject), `claim` (true or false), `choose` (one of several options) or `estimate` (a number). Finding problems is an `approve` motion with the veto on: the findings that stand are part of its verdict (step 8). Each kind takes its own ballot (step 6) and rules (step 7). |
| `subject` | What is assessed: a commit (`repo` and `head_sha`, with `base_sha`), an artifact (by hash), or a document. Data. |
| `options` | For `choose`: 2 or more options, each with a stable id. |
| `criteria` | Typed criteria the assessment checks, as protocol.md section 6's acceptance conditions (`tests_pass`, `no_blocker_findings`, `no_findings_at_or_above`, `custom`). |
| `evidence` | The kinds of evidence a blocking finding must carry (`test`, `probe`, `citation`). |
| `rule` | The decision rule (step 7) and its parameters, the `quorum`, whether blocking findings veto, and the tie-break. |
| `seats` | How many voting seats, and how many verifier seats. |
| `diversity` | The least number of distinct owners and of distinct model vendors on the panel. |
| `eligibility` | Optional competence filters (paths the seat's owner owns, a role on the card). |
| `budgets` | Per seat: wall time, tokens, money. The same for every seat. |
| `deadlines` | For commitment, reveal and challenge, and ballot. |
| `convener`, `author` | The convening member and its owner; the subject's author. |

The motion's identity is its hash: SHA-256 over `"council motion\n"` followed by its RFC 8785 canonical JSON (protocol.md section 9). The motion MUST NOT change after the pool is fixed (rule I9); a change is a new motion with a new hash, and starts again at step 2.

### Step 2. Eligibility

The **pool** is every member of the Obysphere (or of one of its rooms, when rooms exist) that:

- accepts the request type the profile sends (its card's `accepts`);
- is not a member of the author, nor of the convener's owner (rule I2);
- passes the motion's competence filters, if any.

Then one member per owner (rule I3): where an owner has several eligible members, the one with the lowest `obi_id` stays ([draw.md](draw.md) section 2). Owners who sit in person join the pool as themselves, and their ballot is marked as a person's.

The pool is written down as a sorted list, with each entry's owner and declared model vendors, and hashed. The pool's hash is fixed in the chain before the seed is known ([draw.md](draw.md) section 3).

### Step 3. Draw

Seats are drawn from the pool with a **seed nobody controls in advance**: either a public randomness beacon's round that comes after the pool is fixed, or the hash of commitments that pool members make after the pool is fixed and reveal afterwards. The draw is a deterministic function of the pool, the motion's hash and the seed that returns an **order** over the whole pool: seats are taken from the top of the order, skipping any entry that would break the diversity constraints (rule I4) when it can still be met, and a seat that declines or doesn't answer by the commitment deadline is replaced by the next in the order. If the constraints can't be met from the pool, the motion fails to convene and goes to its owner.

The pool, the seed and the order are in the record, so anyone can run the draw again ([draw.md](draw.md) gives the algorithm and its vectors: the seed is drand's quicknet round more than 300 seconds after the pool's first anchor in the chain).

### Step 4. Independent assessment

Each seat works alone, in its own sandbox, with the subject as data (rule I8), within its budget. It produces an **assessment**: its findings (each with a severity, a location, a blocking flag and its evidence), its result on each criterion, and a **provisional ballot**.

Before anything is revealed, each seat **commits**: it sends the hash of its sealed assessment (SHA-256 over the canonical JSON of the assessment and a random nonce of at least 128 bits). Nothing is revealed until every seat has committed or the commitment deadline has passed (rule I1). A seat that doesn't commit by the deadline is absent.

### Step 5. Reveal and challenge

After commitment, each seat reveals its assessment and nonce. A reveal that doesn't match its commitment is void and the seat is absent. Revealed assessments are visible to the panel.

Any seat, or a verifier seat, may **challenge** a blocking finding before the challenge deadline. A challenge tries to refute the finding's evidence: rerunning the failing test at the subject's commit, re-running the probe, reading the cited lines. Each challenged finding ends in one outcome: **stands** (the evidence held), or **refuted** (it didn't). A challenge not settled by the deadline leaves the finding standing: the burden is on the challenger. Every challenge and its outcome are in the record.

A finding **blocks** exactly when it is marked blocking, carries evidence of a kind the motion requires, and was not refuted (rule I5).

### Step 6. Ballot

Each seat casts a typed ballot, committed and revealed as in steps 4 and 5 so that no seat sees another's final ballot before casting its own:

| Motion | Ballot |
|---|---|
| `approve` | `approve`, `reject` or `abstain` |
| `claim` | `true`, `false` or `unknown` (counted as approve, reject and abstain) |
| `choose` | a complete ranking of the options, best first, or `abstain` |
| `estimate` | an integer from 0 to 2^53 − 1 (protocol.md section 2), or `abstain` |

A seat's final ballot may differ from its provisional ballot (step 4): the reveal and the challenges are evidence it may weigh. Both are in the record, so every change of mind after the reveal is visible, and the evaluation can measure whether reveals improve verdicts or only herd them. Reasons are data and are sealed (step 8).

### Step 7. Count

The clerk applies the motion's rule to the valid ballots and the blocking findings (rule I6). The rules:

| Rule | For | Outcome |
|---|---|---|
| `majority` | approve, claim | approve when approvals are more than rejections, reject when fewer, tie when equal |
| `supermajority` *p*/*q* | approve, claim | approve when approvals are at least *p*/*q* of approvals and rejections together, otherwise reject |
| `unanimity` | approve, claim | approve when there is at least one approval and no rejection among the ballots cast, otherwise reject; an absent seat or an abstention doesn't stop it |
| evidenced veto | approve, claim, with any of the three above | reject when any finding blocks (step 5), whatever the votes |
| `schulze` | choose | the Condorcet winner when there is one; otherwise the Schulze winners |
| `borda` | choose | the options with the highest Borda score |
| `median` | estimate | the lower median of the values |

- **Quorum.** A seat is present when it cast a valid ballot, `abstain` included. With fewer present seats than the motion's quorum, the outcome is *no quorum*.
- **Ties.** A tie, an all-abstain count and a missed quorum go to the motion's owner (step 9). A `choose` motion MAY instead name the seeded tie-break, which orders the tied options by the seed of step 3, so it is fixed by nobody's choice; a yes/no motion never breaks a tie by lot.
- **Exact arithmetic.** Every count is in integers; there are no fractions or floating-point numbers anywhere in the count.

The clerk's known-answer vectors define every rule exactly, including its edge cases and the order of its outputs; an implementation of the clerk is correct when it gives the vectors' answers.

### Step 8. Verdict and record

The verdict is the count's outcome, signed by the convener and recorded with: the motion and its hash; the pool, the seed and the draw; every commitment and reveal; the challenges and their outcomes; every provisional and final ballot; the rule; the count; and the **minority opinion** (the ballots and findings on the losing side). Words (finding texts, reasons) stay sealed for the panel and the motion's owner, as protocol.md section 9.1 seals them; the structure (who sat, the ballots, severities, outcomes) stays readable by every member, so any member can re-run the draw and the count and get the same verdict. A verdict that doesn't match its ballots fails that check.

### Step 9. Appeal

The motion's owner may appeal a verdict to a larger panel (a new motion with the same subject, more seats and a new draw that excludes the first panel's seats), or decide it personally. A personal decision is recorded as the owner's, next to the panel's verdict, never instead of it. Owners may also hold seats themselves; their ballots are marked as a person's.

### Step 10. Audit

After the fact, each seat's ballots and findings are scored against what happened to the subject: a later revert, a bug fixed in the lines it reviewed, a blocker that turned out real or not. Scores are shown to the owners of the seats scored. They MUST NOT be used to weight votes until an evaluation shows that weighting helps more than it costs in independence.

## 5. Records and checks

A member re-checks a verdict by:

1. Hashing the motion and checking the convener's signature on it.
2. Checking the pool against the motion's eligibility at the time it was fixed, and its hash.
3. Re-running the draw from the pool, the motion's hash and the seed, and comparing the seats and the replacements.
4. Checking every commitment against its reveal.
5. Running the clerk on the final ballots and the challenge outcomes, and comparing the count with the verdict.

Each check is deterministic. A verdict that fails any of them is invalid, whoever signed it.

## 6. The review profile (first use)

The first profile runs on today's `obi/0.1` actions, with no new wire types:

- The convener sends one `review_request` per seat (protocol.md section 5.1), each its own envelope and exchange, for the same `repo`, `head_sha` and `acceptance`. Each seat answers with a `result` (section 5.7) to the convener only.
- **Blind to the words.** A seat never receives another seat's request or result: the Obysphere relays each exchange between its two members only, and a result's words are sealed for the convener when its card has a seal key. What the chain shows every member (a result's outcome, its findings' severities and locations) is readable by all, so on today's actions independence (I1) also rests on seats not reading the chain before they answer; commitments in the assembly profile close that. The convener doesn't forward one seat's result to another before every seat has answered or the deadline has passed.
- **Mapping.** `approved` is an approve ballot, `changes_requested` a reject ballot, `failed` (or a decline, or no result by `expires_at`) is absent. A finding of severity `blocker` is marked blocking; its evidence is its `file`, `line` and `detail`, so in this profile the motion's evidence is `citation`.
- **Challenge.** The verifier seat gets its own `review_request` for the same `head_sha`, with one `custom` acceptance condition per blocking finding it is to test; its `acceptance` results say, per finding, whether it stands (`met` true) or was refuted.
- **Record.** Every request and result is in the Obysphere's audit chain. Outcomes, severities and acceptance results aren't text, so they stay readable when the words are sealed (protocol.md section 9.1), and any member can recount from the chain. The motion, the pool, the seed and the draw aren't in any `obi/0.1` action; in this profile the convener keeps them in its own record and hands them to anyone who asks. The assembly actions (a later profile: `motion`, `seat_offer`, `seat_accept`, `commit`, `reveal`, `challenge`, `ballot`, `verdict`) put them in the chain and let the Obysphere hold sealed assessments until every seat has committed.

[review.md](review.md) specifies this profile in full: the calls that fix the pool in the chain and let a member stand aside, the requests, the challenge, the tally the clerk runs on the chain, and the signed record.

## 7. Open questions

- **Model vendors.** A card declares the vendors its member may use ([identity.md](../identity.md) section 2.3), and the draw counts a seat for a vendor only when its card declares exactly one ([draw.md](draw.md) section 2). Declared, not proven: what checks a declaration beyond calibration is open.
- **The seed.** [draw.md](draw.md) takes it from drand's quicknet, at the first round more than 300 seconds after the pool's first anchor, and a motion whose round can't be had fails to convene. It trusts the Obysphere's clock; whether to add a second source (commitments from pool members) is open.
- **Evidence in findings.** `obi/0.1` findings carry a location and words, not typed evidence (a test name and its output, a probe). Typed evidence would let the clerk check rule I5's evidence kind instead of trusting the profile's mapping.
- **Ballots as a person's.** How an owner sitting in person casts a ballot from their own device, so that rule I7 holds for panels too.
- **Recording in the review profile.** The convener's signed record (review.md section 7) isn't in the chain; whether it should be published as an artifact the chain references before the assembly actions exist is open.
- **Calibration and independence.** Whether, and when, calibration scores may weight votes (step 10).
