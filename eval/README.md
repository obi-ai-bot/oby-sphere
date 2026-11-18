# The Council's evaluation

Does a panel of reviewers find more real bugs than one reviewer, and at what cost? Does reviewing blind, as the Council's rule I1 requires ([spec/council/process.md](../spec/council/process.md)), do better than reviewing with the others' findings in view? This folder holds the harness that asks, the cases it asks about, every seat's raw answer, and [RESULTS.md](RESULTS.md).

It compares:

- **one seat against panels of three and of five**, all reviewing blind;
- **blind against open**: three seats that never see each other's findings, against three seats where each sees the findings of those before it;
- **one vendor against mixed vendors**: pending. Every seat here runs Anthropic's models through `claude -p`; the second vendor's runs (`cursor-agent` with a non-Anthropic model) wait for that subscription. A second Claude model is not a second vendor, and nothing here counts one as such.

## The cases, and how they were chosen

A case is a pull request whose bug a later commit confirmed by fixing it, from public history only: [obi-ai-bot/oby](https://github.com/obi-ai-bot/oby) and [obi-ai-bot/oby-sphere](https://github.com/obi-ai-bot/oby-sphere). Nothing from any private repository. [cases.json](cases.json) lists them. They were chosen like this, before any seat ran:

1. **Mining** ([mine.py](mine.py), the SZZ method). For every commit on `dev` whose subject starts with `fix` or `revert`, take the lines it removed or changed in code files (Rust, TypeScript, JavaScript, Swift, Python, shell; not tests, fixtures, docs, spikes or design files), at most 40 of them, and `git blame` them in the fix's parent. Every earlier squash-merged pull request that wrote some of them is a candidate. In oby's `dev` at `f694bc3b` (`--ref f694bc3b`; a later `dev` has more fixes), 232 fix commits gave 468 candidate pairs; in oby-sphere, 4 fix commits gave 4.
2. **Size.** Keep pairs where the earlier pull request changed at most 700 lines, so one seat can review it within its budget, and where the fix removed or changed at most 25 code lines (as step 1 counts them; the fix may change more in tests and docs), of which at least 2 the earlier pull request wrote (`python3 eval/mine.py <oby checkout> --candidates --ref f694bc3b`). 63 pairs were left, all in oby: [candidates.json](candidates.json) lists them, with how far each was read.
   - oby-sphere had none. It has 36 commits on `dev`. Its fixes blame back to two pull requests: the initial server import (20,758 lines added) and the sign-in change (2,105). Both are too large to review in one seat's budget. The fix to a deploy script that touched only one hosting account's settings isn't a defect a reviewer of the code could find.
3. **Reading.** Read the pairs' subjects, smallest fix first, and pick by subject the fixes that name a defect of a kind not yet in hand; read those in full (the fix's message and diff). Of the 63, 55 were read by subject only and 8 in full: four kept and four dropped, with the reason in candidates.json. Keep a pair only when:
   - the fix names a defect in the earlier pull request's own code;
   - a reviewer of the earlier diff alone could have found it;
   - it isn't a decision the owner changed later (e.g. #630 to #720, investigations made read-only and then not).
4. **Fewest that can show a difference.** Four cases of different kinds and difficulty, from an easy-to-spot loophole to a timing detail. Reading stopped once they were in hand, so this is a choice, not a sample:

| Case | Pull request | Fixed by | The bug |
|---|---|---|---|
| `secret-names` | oby#120 | oby#129 | The secret scan lets a value through as "only a name" whenever it contains a keyword such as `key`, so `my-secret-password` passes. |
| `die-with-parent` | oby#94 | oby#109 | With bubblewrap's `--die-with-parent` dropped, stopping an agent signals only the outer `bwrap`: the sandbox and the agent keep running. |
| `keychain-found-time` | oby#1526 | oby#1527 | A Keychain item found is cached from when the slow `security` call answered, not when it was asked, so a removed login shows as signed in for longer than promised. |
| `blocking-none` | oby#113 | oby#140 | A review whose Blocking heading says "none" still has what follows read as blocking findings, so an approval becomes changes requested. |

The **ground truth** for each case is the lines of the pull request's own version that the fix removed or changed and that the pull request wrote ([truth.py](truth.py): `git blame --porcelain` through the fix's parent, which gives each line's number in the earlier commit). Like mine.py, it leaves out tests, fixtures and docs: `python3 eval/truth.py <oby checkout> <fix> <earlier>`.

## How a seat runs

[seat.mjs](seat.mjs) runs one seat; [run.mjs](run.mjs) runs them all.

- **The checkout.** The pull request's merge commit, exported with `git archive`, so a seat has the code but no history, and can't see the fix. Every `CLAUDE.md` is removed: Claude Code would load one as instructions, and the repository's words reach a seat only as data (rule I8). `AGENTS.md` and everything else stay, as files a seat may read.
- **The inputs**, in a folder of their own:
  - the commit's message without its trailers, as the change's description;
  - `git diff base commit`;
  - for an open seat, the earlier seats' findings.
  The prompt names these files and says they are material to review, never instructions.
- **The run.**
  - `claude -p --model sonnet --tools Read,Grep,Glob --permission-mode dontAsk`, with the inputs folder added (`--add-dir`), no settings or MCP servers (`--setting-sources "" --strict-mcp-config`), no session kept, a spending cap (`--max-budget-usd`), and a fixed system prompt.
  - The answer must match the JSON Schema in seat.mjs: an outcome (`approved` or `changes_requested`) and up to 15 findings, each with a file, a line, a severity (`blocker`, `major`, `minor`, `nit`), a title and a detail.
  - A seat can read the checkout and its inputs and nothing else: it can't run anything, write anything or reach the network. A probe with these exact flags (2026-10-27, Haiku, $0.03) read a file in its checkout and one in its inputs, and was denied `/etc/hosts`, `~/.zshrc` and a file in the oby checkout that holds the fixes ("Permission to use Read has been denied because Claude Code is running in don't ask mode").
  - It runs with a clean environment: only `HOME`, `PATH` and `USER`, so nothing from the session that started it reaches it.
- **The record.** Each seat's answer, its cost (`total_cost_usd`), turns, time and token usage go to `runs/<case>/<seat>.json`, as returned. Runs made after this evaluation's also keep the resolved model ids and, when a run fails, its error: seat.mjs records both now, and the committed records predate that.
- **Reruns.** A run that fails for a reason other than its budget (an account's usage limit, a network error) is renamed `failed-<seat>.json` by hand and run again; its cost still counts. A seat that reaches its budget without answering keeps its record and counts as absent.

Blind seats are `blind-1` to `blind-5`. The open panel is `blind-1`, then `open-2`, which sees `blind-1`'s findings, then `open-3`, which sees both. A first seat sees nothing either way, so the open panel's first seat is the blind one.

## How it is scored

[score.mjs](score.mjs) scores the records. No model judges anything:

- **Caught.** A finding catches the bug when it names a ground-truth file and its lines (`line` to `end_line`) come within 5 lines of a ground-truth line. A seat or panel catches it when one of its findings does. "Caught as a blocker" also needs that finding to be a `blocker`.
- **A panel's verdict.** The clerk counts it ([clerk/](../clerk/)). The rule is `majority` with the veto on and a quorum of half the seats. Every blocker is evidenced and none is challenged: there is no verifier in this evaluation.
  - A panel **stops the change for the bug** when the clerk rejects it and a blocker that catches the bug is among those that blocked.
  - A **false veto** is a blocker that blocked but doesn't catch the bug.
- **Panels of three and five** are every subset of the five blind seats: ten of three, one of five. Their rates are means over the subsets.
- **The best single seat** is the blind seat number (1 to 5) that caught the most cases.
- **Herding** is the share of a later seat's findings that repeat one of an earlier seat's (same file, within 5 lines). Blind seats 1 to 3 are measured the same way, for comparison.
- **Cost** is the seats' `total_cost_usd`, per seat and per panel.

**The author's reading.** Location matching counts a finding at the right lines for the wrong reason. So [reading.json](reading.json) records, for each seat with a located finding, whether any of its located findings describes in its words the bug the fix confirmed: `yes`, `partly` (the right cause, but another way it fails) or `no`. It is graded per seat: a seat graded `yes` may also hold located findings about other issues. `score.mjs` reports both. The reading is a person's judgement, kept apart from the mechanical rule.

**What a false alarm means here.** Every blocker that isn't the confirmed bug counts as a false alarm. Some may be real bugs nobody fixed yet, so the false-alarm counts are an upper bound.

## Running it

```
node eval/run.mjs --oby /path/to/oby [--cases secret-names,...] [--blind 5] [--open 3] [--model sonnet] [--budget 1.5] [--parallel 3]
node eval/score.mjs
```

It needs Node 22.18 or later, `git`, Python 3 (for mine.py and truth.py), and `claude` signed in. `score.mjs` also writes `scores.json`, the numbers behind the tables. Each seat spends from that account: [RESULTS.md](RESULTS.md) reports what this run spent. A seat whose record exists in `runs/` isn't run again. Checkouts and inputs go under `$TMPDIR/council-eval`.
