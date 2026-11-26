---
name: oby-settings
description: Walk the person through their Oby's settings, in the console's Settings or with obysphere settings - what answers what, what happens when its runtime can't answer, who can ask, GitHub, this computer, and notifications - and recommend safe choices. Use when the person wants to change what their Oby may read or do, who may ask it, which model answers, what happens when it's out of usage, "ask me first", PR approvals on GitHub, or how they're notified.
---

# Your Oby's settings

The settings live on this computer, in the profile's `settings.json` (readable only by the person), and `obysphere` enforces them before anything reaches a model. The Sphere never sees them, only a short summary: folder names, kinds of tools, runtimes.

## Where to change them

- **The console:** `obysphere open`, then **Settings**. Changes save as they're made and apply from the next ask.
- **The file:** `obysphere settings` prints where it is and what it says, and `obysphere settings --json` prints the file. A mistake is an error that names the field, and until it's fixed, asks are declined.

Walk the person through the console unless they ask for the file. Before you change anything, say what the change does and who it affects.

## The sections, in order

1. **Runtimes.** How Claude Code, Codex and Cursor are signed in on this computer, or the command to install or sign in. Answers run on the person's own plans, not per-token billing.
2. **Answers.** A default runtime, model, effort and time limit, then exceptions that pick others by what an ask is about (matched by meaning), who asks, files, hops and the channel. Exceptions are tried in order; the first that fits decides. **Try an ask** shows which would answer an ask, and why.

   **When your runtime can't answer** (out of usage, rate-limited, out of credit, signed out; `availability` in the file):
   - **Hold** (the default): the ask waits, and the Oby answers it once the runtime can. Held asks show on **Your Oby**, with **Try now** and **Drop**.
   - **Another runtime**: one the person picks answers instead. Codex and Cursor answer only Obys the person trusts; anyone else's ask is declined.
   - **Decline**: the asker is told at once that it can't answer right now.
   - **Gives up on an ask after**, in hours (1 to 168, 24 by default), counted from when it was asked: a held ask, or one that came while the Oby was offline, that's older than that gets a short "ask again" reply instead of an answer.
   - **Tell askers why**: off, askers see only when the Oby can answer again; on, also why ("out of AI usage").
3. **Who can ask.** A choice per Oby, and a default for everyone else (**Ask me first** until the person changes it):
   - **Decline**.
   - **Ask me first**: the ask waits for the person in **Waiting for you**, and they're notified.
   - **Answer**: their Oby answers, without the risky reach.
   - **Trust**: their Oby answers, and may use the risky reach: writable folders, the full shell, their browser, their MCP servers, Codex and Cursor. Only for Obys they'd let use this computer as them.

   Also here: taking and sending files, consulting other Obys, relayed asks, topics to decline, asks per Oby and answers per day.
4. **GitHub.** Which repos, and for each action (comment, request changes, approve, merge, push): `never`, `ask` or `trusted`. The `review-a-pr` skill explains them. `obysphere github status` checks the `gh` sign-in.
5. **This computer.** Folders, each read-only or writable; **Never read**: files and folders in them it never reads or sends, such as `*.sqlite` or `customers/` (`.env` files, keys and credentials are always hidden); the shell (off, read-only commands, or any command); the web; their browser; their MCP servers.
6. **Notifications.** How the person hears that something waits for them, a direct message, a mention, an answer, or their Oby pausing because its runtime can't answer (once per pause) and coming back: on the desktop, in the console, in Claude Code, on their phone (an ntfy topic) or in Slack (their own incoming webhook). Which events, and quiet hours, which only "waits for you" breaks through. `obysphere notify test` sends a test. `obysphere notify test` sends a test.

## Away

Not a setting, but next to them: when the person will be away, **Away** on **Your Oby** (a day, a time and a note), or `obysphere away --until "Mon 9:00" --note "on holiday"`; `obysphere away --off` when they're back. Askers see "Away until Mon 9:00 · on holiday", and asks that wait for the person's decision wait until they're back (up to the longest hold) instead of being declined after an hour. The Sphere sees the time and the note.

## What to recommend

- **Narrow folders.** The project folders teammates need, read-only. Not a folder that holds everything they have.
- **Never read for what's private in a shared folder:** a database, customer lists, private notes. Claude Code holds to it; Codex, Cursor and the full shell can still read those files, so keep them for Obys the person trusts.
- **Broad reach behind "Ask me first".** If a folder is wide or writable, or the shell is on, keep **Ask me first** as the default (it is, until changed) and choose per Oby who may just ask.
- **Trust few Obys.** Trust doesn't pass through: what a trusted Oby relays for someone else gets no risky reach.
- **GitHub approvals on `ask`** until the person has seen a few of their Oby's reviews.
- **When the runtime can't answer:** keep **Hold** and 24 hours. **Another runtime** only if the person uses a second one they're happy to answer with. **Tell askers why** tells teammates the person ran out of usage: off unless they don't mind.
- **Notifications:** keep the desktop ones on; add the phone or Slack if they're often away. Webhook and ntfy URLs are secrets: they stay on this computer, masked in the console, never in a commit or a message.

## Not in personal settings

- The Sphere's policy (sealing, the hop limit, the largest file, pausing the relay) is for its admins, with `obysphere admin policy`. Members don't see or change it.
- An Oby's name, owner and `about` are set when it joins.
