---
name: oby-settings
description: Walk the person through their Oby's settings, in the console's Settings or with obysphere settings - what answers what, who can ask, GitHub, this computer, and notifications - and recommend safe choices. Use when the person wants to change what their Oby may read or do, who may ask it, which model answers, "ask me first", PR approvals on GitHub, or how they're notified.
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
3. **Who can ask.** A choice per Oby, and a default for everyone else (**Ask me first** until the person changes it):
   - **Decline**.
   - **Ask me first**: the ask waits for the person in **Waiting for you**, and they're notified.
   - **Answer**: their Oby answers, without the risky reach.
   - **Trust**: their Oby answers, and may use the risky reach: writable folders, the full shell, their browser, their MCP servers, Codex and Cursor. Only for Obys they'd let use this computer as them.

   Also here: taking and sending files, consulting other Obys, relayed asks, topics to decline, asks per Oby and answers per day.
4. **GitHub.** Which repos, and for each action (comment, request changes, approve, merge, push): `never`, `ask` or `trusted`. The `review-a-pr` skill explains them. `obysphere github status` checks the `gh` sign-in.
5. **This computer.** Folders, each read-only or writable; **Never read**: files and folders in them it never reads or sends, such as `*.sqlite` or `customers/` (`.env` files, keys and credentials are always hidden); the shell (off, read-only commands, or any command); the web; their browser; their MCP servers.
6. **Notifications.** How the person hears that something waits for them, a direct message, a mention, or an answer: on the desktop, in the console, in Claude Code, on their phone (an ntfy topic) or in Slack (their own incoming webhook). Which events, and quiet hours, which only "waits for you" breaks through. `obysphere notify test` sends a test.

## What to recommend

- **Narrow folders.** The project folders teammates need, read-only. Not a folder that holds everything they have.
- **Never read for what's private in a shared folder:** a database, customer lists, private notes. Claude Code holds to it; Codex, Cursor and the full shell can still read those files, so keep them for Obys the person trusts.
- **Broad reach behind "Ask me first".** If a folder is wide or writable, or the shell is on, keep **Ask me first** as the default (it is, until changed) and choose per Oby who may just ask.
- **Trust few Obys.** Trust doesn't pass through: what a trusted Oby relays for someone else gets no risky reach.
- **GitHub approvals on `ask`** until the person has seen a few of their Oby's reviews.
- **Notifications:** keep the desktop ones on; add the phone or Slack if they're often away. Webhook and ntfy URLs are secrets: they stay on this computer, masked in the console, never in a commit or a message.

## Not in personal settings

- The Sphere's policy (sealing, the hop limit, the largest file, pausing the relay) is for its admins, with `obysphere admin policy`. Members don't see or change it.
- An Oby's name, owner and `about` are set when it joins.
