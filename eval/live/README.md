# A live Council panel

[panel.mjs](panel.mjs) runs the Council's review profile ([spec/council/review.md](../../spec/council/review.md)) end to end on a local Obysphere, with real processes, real keys and real signatures, and then re-checks the verdict from nothing but the record and the chain. It is the Council epic's first done-when (#45): a panel drawn by lot from several owners assesses a real change blind, a finding is challenged, the clerk's count gives a verdict, and anyone gets the same draw and count from the record.

## What it does

1. **The Obysphere and the team.**
   - A local Obysphere starts (`server/scripts/local.mjs`, port 8794 by default).
   - Its admin, `ada`, joins her convener: the scripted client of [server/e2e/client.mjs](../../server/e2e/client.mjs), with a seal key, so the seats' words are sealed for it alone. Its card says it takes `card_runtime` ([spec/identity.md section 2.3](../../spec/identity.md#23-features-the-runtime-and-the-vendors)).
   - Five members join through the [connector](../../connector/), each for an owner of its own: `bea`, `cai`, `dov`, `eli` and `fay`.
   - Each member's card then says what runs its agent (`obysphere-connector card --runtime claude --runtime-version <claude's> --vendor anthropic`): one declared vendor, `anthropic`.
2. **The motion and the pool.**
   - The subject is Oby's end-to-end fixture: a small repository whose `feature/average` branch has two known bugs.
   - `ada` is the author, so her agents are out of the pool. The pool is the five members active at the chain's head (a key valid at its seq + 1, draw.md section 2), one per owner (the clerk's `pool`).
   - The motion asks for 3 owners and 1 vendor among the seats: every card declares exactly one vendor, so each seat counts for `anthropic`.
3. **Calls.**
   - The convener sends every pool member a `question` whose id is the pool's anchor id (draw.md section 3), sealed for that member, then reads the directory again: the members active at the pool's point, and their keys, must be the same.
   - `fay`'s owner stands aside, declining with her passphrase through the connector's CLI.
4. **The draw.**
   - The script waits for drand quicknet's round more than 300 seconds after the first call, checks its signature with quicknet's key, and draws three seats and a verifier (the clerk's `draw`, with `fay` declined).
5. **Blind reviews.**
   - Each seat gets one `review_request`, the same for every seat and all expiring at `deadlines.reviews`.
   - Each seat's owner approves it with their passphrase. Then `claude -p`, with the connector as its only MCP server and read-only tools on a checkout of the change, reviews it alone and replies. Each seat's result is sealed for the convener.
6. **The challenge.**
   - Once every seat has answered (or `deadlines.reviews` has passed), the verifier gets one `custom` condition per blocking finding (`Finding n: file:line` and its title), ten to a request. With no blocking finding there is nothing to challenge.
   - Its owner approves, and `claude -p` checks each finding against the code and answers with `met` per condition.
7. **The count and the record.**
   - The clerk's `reviewTally` turns the chain's entries into a count input, and `count` gives the verdict.
   - The convener signs the record (`council record\n`, review.md section 7).
   - The run folder keeps it as `record.json`, next to `chain.json`: the chain's entries and the directory as any member reads it (owners, bound owner keys, key histories, cards).
8. **The re-check**, from `record.json` and `chain.json` alone. It takes neither the record's list of calls nor its cards on trust, and does each check of draw.md section 7 and review.md section 8. Anything it can't use fails a check; it never throws:
   - `verifyChain` over the whole chain; `through` in it; the motion's hash; the record's signature with the convener's key valid at `through.seq`.
   - The pool: its version, motion, the motion's owner as the directory binds the convener, `request`, `exclude` (exactly the author and that owner), `seats`, `verifiers` and `diversity` against the motion; `at` in the chain (or its empty head) before the first anchor; the same members active at `at` and at the first anchor; each card verified with its owner's bound key and a key valid at `at`, and the cards exactly the active members'; the clerk's `pool` on them gives the record's pool.
   - The anchors, found from the pool's own entries (`anchorId`), compared with the record's calls; every one before the round; no other call about the subject from any member of the convener's owner from `anchored_at` less 300 seconds and one period to the round.
   - The round re-derived from the first anchor, its signature checked with quicknet's key.
   - Every draw run made again, its `declined` exactly what the chain shows: stand-asides by `in_reply_to` before the round; then each later run adds the earliest declines after the run before it, each by a member of that run in its role there (a seat before `deadlines.seats`, the verifier by `deadlines.challenge` less 1,200 seconds); none left over after the last run.
   - Every `review_request` about the subject in the window went to a member of a run; each seat got one, in the seats' shape (the motion's subject and acceptance, no `approve_on_host`, expiring at `deadlines.reviews`), within 600 seconds of the round or of the decline that seated it.
   - The verifier's challenge: every request to the verifier in the window in its shape (as the tally reads them all), after the seats were done and the verifier drawn, and by `deadlines.challenge` less 600 seconds (or within 600 seconds of the decline that seated it).
   - No envelope between two members of the panel from the round to `deadlines.challenge`.
   - The tally and the count made again.

   It names what it can't check: the sealed words (each request's against the motion's `words`, each call's choices, each condition's text), which only their receivers can open; the subject's author, which only the code host shows; and the directory itself (draw.md section 8). The verdict must be the same.

   What it proves: that the record agrees with the chain and the directory in `chain.json`. A folder forged as a whole re-checks clean, so a member who doesn't trust the run folder puts in `chain.json` the chain and the directory it reads from the Obysphere itself (`GET /audit`, `GET /members`).

## Running it

```
cd client && pnpm install --frozen-lockfile
cd ../connector && pnpm install --frozen-lockfile && pnpm run build
cd ../server && pnpm install --frozen-lockfile
cd ../spec && pnpm install --frozen-lockfile
cd ../clerk/ts && pnpm install --frozen-lockfile
cd ../.. && node eval/live/panel.mjs --oby <an obi-ai-bot/oby checkout> [--port 8794] [--model sonnet] [--keep]
node eval/live/panel.mjs --recheck <the run folder it kept>
```

- **What it needs.** Node 22.18 or later, `git`, network access to a drand relay (`api.drand.sh` or another), and `claude` signed in. The script never signs in, and runs `claude` with only `HOME`, `PATH` and `USER` from its environment. `--recheck` needs only the spec's, the server's and the clerk's dependencies, not the connector.
- **Time and cost.** About ten minutes, mostly waiting for the round. The four `claude` runs cost about $0.50 to $0.70 with Sonnet; the script prints `total_cost_usd`.
- **Its state** goes under `$TMPDIR/obysphere-council/`, one folder per run, deleted when the run passes unless `--keep`.
- **Secrets on this machine.** The invitation link, secret included, is on the connector's command line while each member joins, so other users of the machine can see it in `ps`; it expires within the hour. A kept run folder holds every member's keys (the owners' encrypted with passphrases the script made and didn't keep) and the Obysphere's state: delete it when you are done. Ctrl-C stops the Obysphere, the connectors and the `claude` runs with the script.

## What the runs have shown

- **Agreement, and a split.** In most runs the three seats agreed (3 to 0, reject). In one run, two seats approved and rated the bug `major`, and one called it a `blocker`. The verifier found the blocker stands, so the veto made the verdict `reject` against the 2-to-1 vote, and the record keeps the minority's ballot and finding (the PR's evidence).

## What it doesn't show yet

- **Two vendors.** Every seat runs Anthropic's models through `claude -p`, and every card declares `anthropic`. So the panel asks for 1 vendor, and the draw's vendor count is exercised with one vendor only. A panel with seats on a second vendor (`cursor-agent` with a non-Anthropic model) waits for that subscription. A second Claude model would not be a second vendor.
- **Oby as a seat or the convener.** The convener here is the scripted client, not Oby's `obid`. Oby's convener ([obi-ai-bot/oby#1546](https://github.com/obi-ai-bot/oby/pull/1546)) sends the seats' requests, but not the calls or the draw.
- **A refuted finding.** The verifier tries to refute each finding, but in the runs so far every blocker it checked stood. The tally's vectors cover refutation (clerk/vectors/review.json).

- **A replacement.** No seat or verifier declined its request, so every live run so far had one draw. The re-check handles later runs (a forged chain where two seats decline one after the other re-checks its three runs), and the draw's vectors cover replacements (clerk/vectors/draw.json); a live run doesn't.
- **Standing aside by answer.** `fay` stands aside by declining her call. Answering it with choice 1 ("stand aside") counts the same (review.md section 4), but the connector's `answer` command isn't used here.
- **The receivers' own checks.** Each seat would check its request's words against the motion's `words`, each called member its choices, and the verifier each condition against the chain (review.md section 9). The connector doesn't do these yet; the seats here are told what to do by their prompt.
