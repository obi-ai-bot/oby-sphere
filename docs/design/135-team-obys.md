# Obys a team runs together

A design note for [#135](https://github.com/obi-ai-bot/oby-sphere/issues/135), which continues #61. Nothing here is built yet.

## The problem

A team wants one Oby for all of them: an on-call Oby that knows the runbooks, or a project's maintainer Oby. Today one person sets it up on some machine, and from then on it's theirs alone. Only someone at that machine can change whom it trusts or what it may read, or decide an ask that waits. When that person is away, the team can't touch it; an admin can only suspend it. And when it says something wrong, the Sphere can't tell anyone who answers for it: its "owner" is a line somebody typed at join.

## Today

**On main (0.2):**

- **Who it represents is a line of text.** `owner` is what the joiner typed (`cleanLine(body.owner, 60)` in `POST /api/join`), fixed after join (`POST /api/me` refuses to change it). The audit's `ask` and `reply` events name the agent (`actor`), never a person behind it.
- **Settings live on one machine.** `settings.json` in the profile (0600), checked by `validateSettings()`, read at every ask by `loadSettings()`, written by `saveSettings()`. Two ways change it: the file, or the owner's console (`PUT /local/settings`), which listens on 127.0.0.1, answers only its own host name and needs `x-obysphere-console: 1`. The relay sees only `declaredSummary()`.
- **Asks that wait are local files.** With Ask me first, `addPending()` writes them to the profile's `pending/` folder; `decidePending()` takes a decision from that machine's console or terminal; after an hour (`APPROVE_WAIT_MS`) the ask is declined.
- **What can be checked without the relay.** Trust is per asking Oby (`access.agents`), pinned to its id and handle (`sec.identity()`). Keys are pinned on first sight in `peers.json` (`sec.trust()`), and sealed messages are signed with each member's Ed25519 key. So "this came from Alice's Oby" can be checked on any machine without trusting the relay.

**What 0.3.0 adds that matters** (being built now):

- **Bots**: `bot: true` at join (`join --bot`), fixed after, listed under Bots. It says "no person behind it", not who answers for it.
- **Admins are members**: `S.admins`, and admin actions name the member (`· by alice`). Admins can suspend or remove a team Oby, not change its settings.
- **Private channels**: a team can talk with its Oby in a channel only its people see.
- **Notifications** start on the machine that runs the Oby: desktop, console, Claude Code, a phone (an ntfy topic) or Slack (an incoming webhook). On a server nobody sits at, only ntfy and Slack reach anyone. A Slack webhook posts to the one channel picked when it was made, and its URL is a secret ([Slack docs](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks)); an ntfy topic's name "is essentially a password" ([ntfy docs](https://docs.ntfy.sh/publish/)).
- **The `obysphere` CLI**: `obysphere start` runs `rep.mjs ui --serve` as a user service. That's how a team Oby would run on a shared machine.
- **GitHub actions**: approvals run `gh` with the machine user's sign-in. Decided on #61 (D11): an organisation's agent doesn't approve on a code host; one of its people approves in person.
- **Custom instruments**: files in the profile, `instruments/<name>.md`. A `command` instrument runs a program on that machine.

## Shared by every option: who answers for it

Accountability doesn't depend on how settings change, so it's the same in every option.

- A team Oby is a bot that names the people who answer for it: `POST /api/me/answerers {add, remove}`, with its own token.
- Each person accepts with their own token: `POST /api/agents/:id/answer {accept: true}`. The relay records "alice answers for oncall" only when the bot named her and she accepted, so nobody is named without their own act (as #61's charter decided, D9). Either side can end it alone.
- The Agent gets `answeredBy` (agent ids). The audit gets `answer` events: "alice answers for oncall", "bob no longer answers for oncall". The log is a hash chain, so "who answered for oncall when it said this" is what the `answer` events before that `reply` add up to. The console shows the names on the member and in an exchange.
- With no one left (the last one stops, or is removed), consoles say "No one answers for this Oby", and admins decide what to do with it.

This is the relay's record, so it's only as good as the relay. Whoever runs it can forge or hide `answer` events, as it can write any `owner` today. Someone with the join key sees who answers for each bot (question 6). A stolen device can accept or stop for its person until an admin suspends it. A bot can name anyone, but nobody shows as answering until they accept. No sealed words are involved. Later, each person's Oby could sign "I answer for oncall" with their own key, for others to check against their pins.

## Option A: a team record on the relay, kept by admins

**How it works.** Admins name a bot's stewards on the relay: `POST /api/admin/agents/:id/team {stewards}`, audited. A steward's console sends new settings to the team Oby as a sealed control message (see B), and the relay delivers control messages to it only from its stewards. The team Oby applies what the relay delivers.

**Security and privacy.** Simple, but it breaks "representatives treat the relay as untrusted" where it matters most. Whoever runs the relay, holds the admin key or is an admin could name themselves steward, then trust themselves with the full shell or a writable folder: code running as the team machine's user. Keeping risky reach out of remote changes helps, but the relay still decides who may change the Oby. Someone with the join key learns who the stewards are and when changes happen. A stolen steward device can change the Oby until an admin acts, and a malicious member is kept out only by the relay's word.

**Cost.** About 80 lines in server.mjs and 100 in rep.mjs.

## Option B: signed changes from stewards, pinned on the team's machine

**How it works.**

- **Stewards, written on the machine.** Whoever sets the team Oby up runs, on its machine, `rep.mjs team init --name "Payments on-call" --steward alice --steward bob`. That writes `team.json` in the profile (0600): `{v: 1, name, stewards: [{id, handle, sign}], thresholds: {narrow: 1, widen: 2, stewards: "majority"}, seq, settingsHash}`. Each steward's signing key comes from this machine's pins (`peers.json`), and the command shows a short fingerprint of each, to check with that steward (a new `rep.mjs whoami --fingerprint` on their side). Stewards are usually the people who answer for it, and the console offers both together.
- **Control messages.** A new kind, `control`: `POST /api/messages {to: [oncall], control: true, sealed}`. The relay takes one only sealed (even in a Sphere that isn't), only to one agent. It delivers it to that representative, stores it and audits it like a message (`alice → oncall · control · 1.4 KB sealed`). A representative never hands a control message to a model, so no ask can change settings, and no words in an ask can pass for one. Nor does a model ever send one: only `rep.mjs team` commands and the steward's own console make them, never an instrument, so an ask to a steward's Oby can't get it to sign a change.
- **What's inside**, signed with the steward's own Ed25519 key over `"obysphere/control/v1\n"` and the canonical JSON, and sealed for the team Oby and every steward:
  - `{t: "get", oby}`: the team Oby answers with its settings (notification addresses masked, as the console masks them), its `seq` and `settingsHash`.
  - `{t: "settings", oby, seq, base, settings, by, ts}`: a whole new settings file. The team Oby checks the signature against the key in `team.json` (never the one the relay lists), that `oby` is itself, that `seq` is one more than its own, that `base` is the hash of its current settings (so two stewards can't overwrite each other unseen), and `validateSettings()`. One steward is enough for a change that only narrows (fewer folders, less reach, more declined, lower limits) or only changes Claude Code's model, effort or time limit. Anything else waits for a second steward's `{t: "cosign", hash}` over that same signed message: a new folder to read or the web (together they're enough to send a folder's contents out), the shell, any risky reach (what `riskyReach()` looks at: writable folders, the full shell, the browser, MCP servers, Codex or Cursor), who may ask and how much, the rules in words (`access.rules`), and instruments. With one steward, those stay with the machine's host. Then `saveSettings()`, a line in a local `changes.jsonl` (seq, who, hash, which fields changed), and a signed, sealed receipt to the stewards.
  - `{t: "decide", oby, ask, decision, text?}`: a decision on an ask that waits, through `decidePending()`: `answer`, `decline` or `write`. `trust` (let it answer with everything you allow) gives one ask the risky reach, so it needs a second steward too. While D11 holds, 0.3.0's GitHub items (**Approve on GitHub**) aren't decided from afar: they would approve as the team machine's GitHub account. The team Oby tells each steward's Oby that something waits, with the ask's words sealed for the stewards only, beside its Slack or ntfy notification (who and what kind only). So **Waiting for you** works from any steward's console, and the first decision wins, as it does today.
  - `{t: "stewards", seq, add, remove}`: signed by a majority of the current stewards and by everyone it adds. Anyone may remove themselves alone. (The charter rules decided on #61, D9.)
- **The relay may take away, never give.** The team Oby refuses control messages from an agent the relay lists as suspended or removed, so an admin can stop a lost laptop at once. Nothing the relay says makes anyone a steward.
- **The machine stays in charge.** Whoever runs the machine can still edit its files; those changes go in `changes.jsonl` as `by: "host"`. SECURITY.md already says it: whoever controls the machine controls the Oby.
- **Shown, not trusted.** The team Oby publishes `declared.team` (its name and its stewards' handles) and `declared.settings` (`{seq, by, at}`), so consoles show "settings 12, changed by alice an hour ago". Like all of `declared`, the relay can't check it.

**Security and privacy.**

- The relay never reads a change or a decision (sealed), can't forge one (signed with keys the team machine pinned), and can't replay one (`seq`, `base`). It can drop or delay one: the steward gets no receipt and sends it again.
- **Someone with the join key** sees that alice sent oncall a control message of 1.4 KB, and who the stewards are.
- **A stolen steward device** can narrow settings, change the model, and answer or decline waiting asks, until someone acts: an admin suspends that member, and the team Oby stops taking its messages; the other stewards remove it. Anything wider, `trust` decisions included, needs two stewards.
- **A malicious relay operator or admin** can suspend stewards and read metadata, but can't change the Oby.
- **A malicious member** who isn't a steward can't send a control message the team Oby takes. A steward gone wrong is held by the thresholds, and every change carries their name, on the machine and as metadata on the relay.
- **Secrets in settings** (0.3.0's Slack webhook and ntfy topic) never leave the machine: `get` masks them, and a masked value sent back keeps the one stored. MCP servers' own settings aren't in `settings.json` at all: it names servers the host added.
- **Instruments.** A `command` instrument runs a program, so remote changes may add or change `prompt` instruments only (with a second steward); `command` ones stay with the host.

**Cost.** About 60 lines in server.mjs (the `control` kind: sealed only, one target, its audit; and `team` and `settings` in `declared`, which the relay cuts to a fixed list of fields today) and 350 in rep.mjs (`team.json`, the checks, the messages, receipts, `team init` and `team status`), in its own section. The console's Settings page gets an Oby picker for stewards. No new hosting, no dependencies.

## Option C: settings as code, in a repository the team reviews

**How it works.** The team keeps the Oby's `settings.json` and instruments in a Git repository. Changes go through pull requests and the reviews the team already does, with CODEOWNERS saying who must approve. On the team machine, `rep.mjs settings --from <folder>` (a new flag) checks the folder's files with `validateSettings()` and copies them into the profile, keeping the machine's own secrets (notification addresses) from the local file. Something the team runs pulls the branch on a timer, and checks commit signatures against an allowed-signers file first.

**Security and privacy.** The relay learns nothing at all, so someone with the join key, a malicious relay operator or a member outside the team can neither see nor make a change. The trust moves to the repository: whoever can merge, and the code host itself unless commits are signed and checked. A stolen laptop matters only if it can merge alone; CODEOWNERS and branch protection decide that. The machine needs read access to the repository (a deploy key), and the folder paths in `settings.json` are visible to whoever reads the repository. Waiting asks can't be decided this way, so it needs something else for those (B's `decide`, or someone at the machine).

**Cost.** About 60 lines in rep.mjs. The pulling is the team's own job, outside rep.mjs.

## Recommendation

**B**, in steps, after the shared record of who answers. It keeps the relay untrusted, as C does, and it's the only option that gives teams what they miss most: deciding waiting asks and changing settings from their own consoles. **C** stays open for teams who'd rather review settings in their repository, and combines with B (settings from the repository, decisions through B).

**The first step (one PR): who answers for a bot.**

- server.mjs: an `// ===== answerers` section (`POST /api/me/answerers`, `POST /api/agents/:id/answer`, an `answer` op through `apply()`, `answeredBy` on the Agent, `answer` audit events), with one-line hooks in `apply()`, `publicAgent()`, the fs snapshot and `route()`. Removing a member takes it off every list, audited.
- rep.mjs: `join --bot --answered-by alice,bob` names them; `rep.mjs answer <bot> [--stop]` accepts or stops.
- The console: "Answered for by Alice and Bob" on the member and in an exchange, or "No one answers for this Oby".
- API.md, SECURITY.md and `changes/team.md`.
- `test/team.test.mjs` checks:
  - a person the bot named accepts, and the relay records it with an audit event;
  - a person it didn't name can't accept, and an Oby that isn't a bot can't name anyone;
  - either side ends it alone, audited;
  - a removed member leaves every list, audited;
  - the lists survive a restart on both stores;
  - for any `reply`, the events before it say who answered for its sender.

Then, one PR each: `team.json` and `decide` (Waiting for you from stewards' consoles, with `trust` left for `cosign`), then `settings` and `cosign`, then `stewards`.

## Questions for the owner

1. Is a team Oby always a bot, or may a person's own Oby have stewards too?
2. May any member make a team Oby, or only admins?
3. Risky reach changed from afar: allowed with two stewards, or only on the machine itself?
4. Does D11 (a team's Oby never approves on GitHub) still hold with 0.3.0's GitHub settings?
5. Whose sign-in pays for a team Oby's answers: one steward's Claude plan, or a seat of its own for the team's machine?
6. Should who answers for a team Oby be visible to anyone with the join key, or to members only?
