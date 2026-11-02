# The Council's evaluation: results

The question: do panels of independent reviewers find more of the bugs a later fix confirmed than a single reviewer does, at what cost, and does reviewing blind beat reviewing with the others' findings in view? [README.md](README.md) says how the cases were chosen, how a seat runs and how it is scored. Nothing here is judged by a model: a finding catches a bug when it points within 5 lines of what the later fix changed, and the clerk counts every panel's verdict.

**Scope of this run.**

- **Four cases.** Pull requests in obi-ai-bot/oby whose bug a later commit fixed: #120 (fixed by #129), #94 (#109), #1526 (#1527) and #113 (#140).
- **Seats.** Every seat runs Anthropic's Claude Sonnet through `claude -p`, with read-only tools and a $1.50 cap per seat. The model is the `sonnet` alias as Claude Code 2.1.204 resolved it on 2026-10-27; these records keep the alias, and the harness now also records the resolved model ids.
- **Conditions.**
  - Single seats against panels of three and five, all blind: five blind seats per case, with every subset of three and the set of five.
  - Blind against open: three blind seats against three where each sees the earlier seats' findings.
- **One vendor against mixed vendors: pending.** The second vendor's seats (`cursor-agent` with a non-Anthropic model) wait for the owner's Cursor subscription. A second Claude model isn't a second vendor, and nothing below counts one.

## The comparisons

| Comparison | Status |
|---|---|
| One seat against panels of three and five | Run: four cases, five blind Claude Sonnet seats each. |
| Blind against open | Run: three blind seats against three open ones, per case. |
| One vendor against mixed vendors | **Pending.** It needs seats on a second vendor's models: `cursor-agent` with a non-Anthropic model, which waits for the owner's Cursor subscription. Running a second Claude model in its place would test one vendor twice, so this row stays open until those runs exist. |

## The numbers

From `node eval/score.mjs`, on the records in [runs/](runs/):

#### Caught, per case (a finding within 5 lines of the fixed lines)

| Case | Single seat (all five blind seats) | Single seat (seats that answered) | Caught as a blocker | Panel of 3 (all subsets) | Panel of 5 | Panel of 3 stops it for the bug |
|---|---|---|---|---|---|---|
| secret-names (#120, fixed by #129) | 100% | 100% (5 of 5) | 60% | 100% | 100% | 100% |
| die-with-parent (#94, fixed by #109) | 40% | 40% (5 of 5) | 0% | 90% | 100% | 0% |
| keychain-found-time (#1526, fixed by #1527) | 80% | 80% (5 of 5) | 0% | 100% | 100% | 0% |
| blocking-none (#113, fixed by #140) | 20% | 33% (3 of 5) | 0% | 60% | 100% | 0% |

Best single seat (the blind seat number that caught the most cases): 3 of 4 cases.

#### Caught, by the author's reading: the finding's words describe the confirmed bug (reading.json)

| Case | Single seat | Panel of 3 (all subsets) | Panel of 5 | Blind 1–3 | Open 1–3 |
|---|---|---|---|---|---|
| secret-names | 100% | 100% | 100% | yes | yes |
| die-with-parent | 0% | 0% | 0% | no | no |
| keychain-found-time | 0% | 0% | 0% | no | no |
| blocking-none | 0% | 0% | 0% | no | no |

Best single seat, by that reading: 1 of 4 cases; the panel of five: 1 of 4.

#### Blind against open, three seats each (seat 1 is the same run in both)

| Case | Blind 1–3 caught | Open 1–3 caught | Blind repeats | Open repeats | Blind false vetoes | Open false vetoes |
|---|---|---|---|---|---|---|
| secret-names | yes | yes | 100% | 100% | 0 | 0 |
| die-with-parent | no | yes | – | 50% | 0 | 0 |
| keychain-found-time | yes | yes | 75% | 100% | 0 | 0 |
| blocking-none | yes | yes | 0% | 0% | 0 | 0 |

#### False alarms and cost

| Case | False blockers per seat | False vetoes, panel of 3 | False vetoes, panel of 5 | Cost per seat | Panel of 3 | Panel of 5 | Seat runs: answered, out of budget | Failed and run again | Spent, failed runs included |
|---|---|---|---|---|---|---|---|---|---|
| secret-names | 0.0 | 0.0 | 0.0 | $0.48 | $1.43 | $2.38 | 7: 7, 0 | 2 | $2.92 |
| die-with-parent | 0.0 | 0.0 | 0.0 | $0.31 | $0.94 | $1.57 | 7: 7, 0 | 2 | $2.27 |
| keychain-found-time | 0.0 | 0.0 | 0.0 | $0.77 | $2.32 | $3.87 | 7: 7, 0 | 4 | $5.93 |
| blocking-none | 0.0 | 0.0 | 0.0 | $1.42 | $4.27 | $7.12 | 7: 4, 3 | 7 | $10.33 |

Total: 28 seat runs, 25 answered and 3 out of budget; 15 more failed on the account's usage limit and were run again; $21.45 in all.

## What it shows

1. **One model's seats share blind spots, and more of them didn't help.** By location, panels look strong: the panel of five "caught" all four bugs, and the best single seat three. But read the findings and only one bug was caught: the secret scan's loophole (#120), which every seat found.
   - On the Keychain timing bug (#1526), all nine located findings were other issues at the same lines: cache eviction, `keychain_on()`, and a missing regression test.
   - On "Blocking: none" (#113), both were another parsing gap.

   Independent runs of one model missed the same two bugs: all five on #1526, and on #113 the three of five that answered. So, by that reading, the best single seat caught 1 of 4 and the panel of five 1 of 4. This run does **not** show a panel finding more than its best single seat (the epic's done-when 2). It shows why rule I4 asks for more than one vendor, and that comparison is the pending row.
2. **Where one model is inconsistent, a panel does cover more, though not of the confirmed bug.** On #94 (`--die-with-parent`), two of five blind seats named the cleanup the change lost, but placed the failure in a runner that crashes outside systemd, not in Stop under systemd, which is what the fix confirmed (`partly` in [reading.json](reading.json)). Any panel of three held such a finding 90% of the time, and the panel of five did.
3. **Severity decides the verdict, and the seats under-rated.** Every finding that described a real cause on #94 was `minor`, and every seat approved. With the veto only on blockers, every panel approved a change whose bug was later fixed. On #120, three of five seats made the catch a blocker, and every panel of three rejected it for that reason. A panel can only count what its seats call blocking: calibration (process.md step 10) has to score severity as well as location.
4. **No false alarms at blocker level.** No seat raised a blocker that wasn't the confirmed bug, so no panel was vetoed by a false finding. With this model, the risk was missing or under-rating, not crying wolf.
5. **Blind against open: inconclusive here.** The open seats were told to report every finding they stand behind, "theirs included once you have checked it" ([seat.mjs](seat.mjs)). So their repeat rate measures that instruction, not herding. What each open panel had to see:
   - On #113, nothing: blind-1 and open-2 both ran out of budget before answering, so open-3 saw no findings.
   - On #94, the first seat found nothing, so open-2 saw an empty list and reviewed as blind as any blind seat. Its located finding is why the open panel caught #94 by location when blind seats 1 to 3 didn't. open-3 saw it and repeated it: the 50% in the table.

   Where they did see findings (open-3 on #94, #120, #1526), the open seats caught nothing the blind seats didn't, and repeated what they saw. A fair test needs an instruction that neither asks for repeats nor forbids them, and more cases. Nothing here argues for showing seats each other's findings before they answer (rule I1).
6. **Cost per change grows with the change's size.**
   - On average per case, one seat cost $0.31 to $1.42, a panel of three $0.94 to $4.27, and a panel of five $1.57 to $7.12. Single runs ranged from $0.20 to $1.58: a seat's last turn can take it past the $1.50 cap.
   - On the largest change (#113, a 553-line diff), three of seven seat runs ran out of their $1.50 budget before answering and count as absent: 25 of the 28 seat runs answered. Over the seats that answered, a single seat on #113 caught it (by location) 1 time in 3.
   - In all, the run spent $21.45, including 15 runs that failed on the account's usage limit and were run again.

## Limits of this run

- **Four cases, one model, chosen not sampled.** Each rate is over five seats on one change; the differences are directions, not measurements with error bars. The four cases were picked among 63 candidates to differ in kind, and reading stopped once four were in hand ([candidates.json](candidates.json) records how far each was read), so they say nothing about how often panels help on a typical change. Every seat is the same model, so the panels show what independent runs of one model add, and the vendor question stays open.
- **Location matching overcounts, and the reading is a person's.** A finding counts as catching the bug when its lines come within 5 of the lines the fix changed. On two of the four cases every such finding was about something else, so the results also give the author's reading of each located finding ([reading.json](reading.json)). That reading is a judgement, kept apart from the mechanical rule: the records in [runs/](runs/) hold every finding's words, for anyone who wants to read them and disagree.
- **False alarms are an upper bound.** Every blocker that isn't the confirmed bug counts as a false alarm, though some may be real bugs nobody has fixed yet.
- **Budget and reruns.** A seat that reached the $1.50 cap without answering is absent, as a seat with no result is in the review profile (process.md section 6, "Mapping"; review.md section 6, the tally's step 2): it counts as a miss in the "all five blind seats" column, and the next column leaves it out. A run that failed for another reason (the account's usage limit, during this run) was renamed `failed-*.json` and run again. Those records carry no error text: the first version of seat.mjs didn't keep it. Their cost is counted in "Spent".
- **No verifier.** No panel here challenges its blockers. The false vetoes are what a verifier would have to refute (review.md section 6).
