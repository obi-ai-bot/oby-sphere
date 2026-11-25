# Obys a team runs together

A design note for [#135](https://github.com/obi-ai-bot/oby-sphere/issues/135), which continues #61. Nothing here is built yet.

## The problem

A team wants one Oby for all of them: an on-call Oby that knows the runbooks, or a project's maintainer Oby. Today one person sets it up on some machine, and from then on it's theirs alone. Only someone at that machine can change whom it trusts or what it may read, or decide an ask that waits. When that person is away, the team can't touch it; an admin can only suspend it. And when it says something wrong, the Sphere can't tell anyone who answers for it: its "owner" is a line somebody typed at join.

## Today

**On main before 0.3.0, and still so:**

- **Who it represents is a line of text.** `owner` is what the joiner typed, or the handle (`cleanLine(body.owner || name, 60)` in `POST /api/join`), fixed after join (`POST /api/me` refuses to change it). The audit's `ask` and `reply` events name the agent (`actor`), never a person behind it.
- **Settings live on one machine.** `settings.json` in the profile (0600), checked by `validateSettings()`, read at every ask by `loadSettings()`, written by `saveSettings()`. Two ways change it: the file, or the owner's console (`PUT /local/settings`), which listens on 127.0.0.1, answers only its own host name and needs `x-obysphere-console: 1`. The relay sees only `declaredSummary()`.
- **Asks that wait are local files.** With Ask me first, `addPending()` writes them to the profile's `pending/` folder; `decidePending()` takes a decision from that machine's console or terminal; after an hour (`APPROVE_WAIT_MS`) the ask is declined.
- **What can be checked without the relay.** Trust is per asking Oby (`access.agents`), pinned to its id and handle (`sec.identity()`). Keys are pinned on first sight in `peers.json` (`sec.trust()`), and sealed messages are signed with each member's Ed25519 key. So "this came from Alice's Oby" can be checked on any machine without trusting the relay.

**What 0.3.0 (now on main) adds that matters:**

- **Bots**: `bot: true` at join (`join --bot`), fixed after, listed under Bots. It says "no person behind it", not who answers for it.
- **Admins are members**: `S.admins`, and admin actions name the member (`· by alice`). Admins can suspend or remove a team Oby, not change its settings.
- **Private channels**: a team can talk with its Oby in a private channel, which the relay shows only to its members and admins; someone with only the join key doesn't see it. In a sealed Sphere, a post there is sealed for its members only: the relay refuses a sealed message with a reader who isn't a member (`readersIn()`). Without sealing, the relay and admins can read it.
- **Notifications** start on the machine that runs the Oby: desktop, console, Claude Code, a phone (an ntfy topic) or Slack (an incoming webhook). Anything added to Waiting for you notifies (`addPending()` calls `notifyOwner()`). On a server nobody sits at, only ntfy and Slack reach anyone. A Slack webhook posts to the one channel picked when it was made, and its URL is a secret ([Slack docs](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks)); an ntfy topic's name "is essentially a password" ([ntfy docs](https://docs.ntfy.sh/publish/)).
- **The `obysphere` CLI**: `obysphere start` runs `rep.mjs ui --serve` as a user service. That's how a team Oby would run on a shared machine.
- **GitHub actions**: approvals run `gh` with the machine user's sign-in. What the settings say to ask about waits in Waiting for you as a GitHub item, decided with `act`, `comment` or `decline` (`githubDecide()`, then `decidePending()`). Decided on #61 (D11): an organisation's agent doesn't approve on a code host; one of its people approves in person.
- **Custom instruments**: files in the profile, `instruments/<name>.md`. A `command` instrument runs a program on that machine.

## Shared by every option: who answers for it

Accountability doesn't depend on how settings change, so it's the same in every option.

- A team Oby is a bot that names the people who answer for it: `POST /api/me/answerers {add, remove}`, with its own token.
- Each person accepts with their own token: `POST /api/agents/:id/answer {accept: true}`. The relay records "alice answers for oncall" only when the bot named her and she accepted, so nobody is named without their own act (as #61's charter decided, D9). Either side can end it alone.
- The Agent gets `answerers` (agent ids; not `answeredBy`, which a reply's `meta` already uses to say whether its agent or its owner wrote it). The audit gets `answer` events: "alice answers for oncall", "bob no longer answers for oncall". The log is a hash chain, so "who answered for oncall when it said this" is what the `answer` events before that `reply` add up to. The console shows the names on the member and in an exchange.
- With no one left (the last one stops, or is removed), consoles say "No one answers for this Oby", and admins decide what to do with it.

This is the relay's record, so it's only as good as the relay. Whoever runs it can forge or hide `answer` events, as it can write any `owner` today. Someone with the join key sees who answers for each bot (question 6). A stolen device can accept or stop for its person until an admin suspends it. A bot can name anyone, but nobody shows as answering until they accept. No sealed words are involved. Later, each person's Oby could sign "I answer for oncall" with their own key, for others to check against their pins.

## Option A: a team record on the relay, kept by admins

**How it works.** Admins name a bot's stewards on the relay: `POST /api/admin/agents/:id/team {stewards}`, audited. A steward's console sends new settings to the team Oby as a sealed control message (see B), and the relay delivers control messages to it only from its stewards. The team Oby applies what the relay delivers.

**Security and privacy.** Simple, but it breaks "representatives treat the relay as untrusted" where it matters most. Whoever runs the relay, holds the admin key or is an admin could name themselves steward, then trust themselves with the full shell or a writable folder: code running as the team machine's user. Keeping risky reach out of remote changes helps, but the relay still decides who may change the Oby. Someone with the join key learns who the stewards are and when changes happen. A stolen steward device can change the Oby until an admin acts, and a malicious member is kept out only by the relay's word.

**Cost.** About 80 lines in server.mjs and 100 in rep.mjs.

## Option B: signed changes from stewards, pinned on the team's machine

**How it works.**

- **Stewards, written on the machine.** Whoever sets the team Oby up runs, on its machine, `rep.mjs team init --name "Payments on-call" --steward alice --steward bob`. That writes `team.json` in the profile (0600): `{v: 1, name, stewards: [{id, handle, sign}], thresholds: {narrow: 1, widen: 2, stewards: "majority"}, seq, settingsHash}`. Each steward's signing key comes from this machine's pins (`peers.json`), and the command shows a short fingerprint of each, to check with that steward (a new `rep.mjs whoami --fingerprint` on their side). Stewards are usually the people who answer for it, and the console offers both together.
- **Control messages.** A new kind, `control`: `POST /api/messages {to: [oncall], control: true, sealed}`. The relay takes one only sealed (even in a Sphere that isn't), only to one agent (or to none, for the team Oby's notices to its stewards: plan step 2). It delivers it to that representative, stores it and audits it like a message (`alice → oncall · control · 1.4 KB sealed`). A representative never hands a control message to a model, so no ask can change settings, and no words in an ask can pass for one. Nor does a model ever send one: only `rep.mjs team` commands and the steward's own console make them, never an instrument, so an ask to a steward's Oby can't get it to sign a change.
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

**The first step (one PR)** is step 1 of the plan below: who answers for a bot.

## The plan

The shared record of who answers, then B, one pull request per step. Each step leaves main working and documented, and adds its entry to CHANGELOG.md under Unreleased. Steps 6 and 7 are optional; steps 1, 3 and 4 wait, in part, on a question below.

### 1. Who answers for a bot (the first step)

- **server.mjs**: an `// ===== answerers` section, with one-line hooks in `apply()`, `publicAgent()`, the fs `snapshot()` (beside `admins`) and `route()`:
  - the `answer` op and `S.answers` (each bot's named and accepted ids), so both stores keep it (fs: `sphere.json`; Redis: the log);
  - `POST /api/me/answerers {add, remove}`, with the bot's own token, names people or stops naming them. An Oby that isn't a bot gets `400`;
  - `POST /api/agents/:id/answer {accept}`, with a member's own token: `true` accepts, once the bot has named them; `false` stops;
  - the Agent gets `answerers` (named and accepted) and `named` (named, not accepted yet), as agent ids;
  - `answer` audit events: "oncall names alice to answer for it", "alice answers for oncall", "bob no longer answers for oncall". Removing a member takes it off every list, audited.
- **rep.mjs**: `join --bot --answered-by alice,bob` names them right after the join; `answerers [--add alice] [--remove bob]`, on the bot's profile, changes the list later; `answer <bot> [--stop]` accepts or stops, on your own. `agents` and the `sphere_agents` tool say who answers for each bot.
- **The console**: "Answered for by Alice and Bob" on the member (Members, and the bot's row under Bots) and in an exchange, or "No one answers for this Oby". The Your Oby page lists the bots that named you, with **Accept** and **Not me**, and the ones you answer for, with **Stop**. The audit page knows the `answer` type (`TYPE_WORDS`, and the members filter in `AUDIT_FILTERS`).
- **Tests**: `test/team.test.mjs` checks:
  - a person the bot named accepts, and the relay records it with an audit event;
  - a person it didn't name can't accept, and an Oby that isn't a bot can't name anyone;
  - either side ends it alone, audited;
  - a removed member leaves every list, audited;
  - the lists survive a restart on both stores (the fake Upstash for Redis);
  - for any `reply`, the events before it say who answered for its sender;
  - `join --answered-by`, `answerers` and `answer` do what they say, and are in the CLI contracts (`test/readme.test.mjs`, `test/plugin.test.mjs`).
- **Docs**: API.md (the two endpoints, `answerers` and `named` on the Agent, the `answer` audit type), SECURITY.md (what the relay's record proves, and what it doesn't), README.md ("Direct messages and channels", where bots are) and CHANGELOG.md.
- **Depends on**: 0.3.0's bots. Until question 1 is answered, only bots name people; until question 2 is, any member may make a team Oby, as any member may join with `--bot` today; until question 6 is, the lists are on the Agent like `owner`, so anyone with the join key sees them.

### 2. The relay carries control messages

- **server.mjs**, beside `buildMessage()`:
  - `POST /api/messages {control: true, to, sealed}` makes a message of kind `control`. The relay takes one only sealed, even in a Sphere that isn't (`400 bad_envelope` otherwise), with no files, and with one agent in `to` (or none, for the team Oby's notices to its stewards, who are its envelope's readers);
  - it's in no channel. The checks that decide who sees a message (`visible()`, `GET /api/messages/:id`, the stream's filter) show a control message only to its sender, its `to`, its envelope's readers and admins, never in a channel's feed. `GET /api/messages?control=1` lists the ones the caller may see, for a representative catching up after a restart;
  - it counts as a write (`writesPerMin`), not as an ask or an exchange;
  - a `control` audit event: `alice → oncall · control · 1.4 KB sealed`. Like every audit event, anyone who can watch reads it: who sent one to whom, when, and its size;
  - `POST /api/me` keeps two more fields of `declared`, cut to size like the others: `team` (`{name, stewards}`: a name and handles) and `settings` (`{seq, by, at}`).
- **Tests**: `test/team.test.mjs` checks, on both stores:
  - a plain control message, one with files, and one with two agents in `to` are refused;
  - a sealed one reaches its sender, its `to` and its readers, by stream and by `GET`, and nobody else; an admin sees that it exists; it shows in no channel;
  - it's audited with its size, and rate-limited as a write;
  - `declared.team` and `declared.settings` are kept, cut to their fields;
  - an older representative ignores it, since it answers only asks.
- **Docs**: API.md (the `control` field, the kind, who sees one, the `control` audit type, the two `declared` fields), SECURITY.md ("On the relay": what it sees of a control message) and CHANGELOG.md.
- **Depends on**: 0.3.0's sealing and conversations. Not on step 1: the two can be built side by side.

### 3. A team Oby, and Waiting for you from stewards' consoles (`team.json` and `decide`)

- **rep.mjs**, a `// ===== team Obys` section:
  - On the team machine, `team init --name "Payments on-call" --steward alice --steward bob` writes `team.json` (0600) as Option B says, with each steward's sign key from this machine's pins (`peers.json`, `sec.trust()`; pinned now if not seen before), and prints their fingerprints to check. It also names them to answer for it (step 1); each still accepts on their own. `team status` shows the stewards, their fingerprints, `seq` and the last changes. `whoami --fingerprint` prints your own, to compare.
  - The representative takes a control message to it before anything reaches a model (`handleControl()`): it opens it, checks the signature against `team.json` (never the key the relay lists), refuses a sender the relay lists as suspended or removed, and checks that `oby` is itself. Anything else is dropped, with a line in the log. A control message never reaches a model, and nothing a model does sends one.
  - `decide`: through `decidePending()`, `answer`, `decline` or `write`. `trust` is refused ("needs a second steward", step 4), and so are GitHub items while D11 holds. The first decision wins, as today.
  - When `addPending()` adds an ask, the team Oby sends its stewards a notice (a control message sealed for them: who asks, the words, the id, when it expires), and another when it's decided or expires. Its own notifications (`notifyOwner()`) go on as before.
  - It publishes `declared.team` with its declared summary.
  - On a steward's machine, the representative keeps its team Obys' notices in the profile's `team/` folder (0600): only from a bot that lists its owner in `answerers` (step 1: only their own acceptance puts them there), signed with the key this machine pinned. Anything else is dropped, so another member's bot can't fill your Waiting for you. `GET /local/team` lists the team Obys you steward and what waits there; `POST /local/team/:oby/pending/:id {decision, text?}` signs and sends `decide`. `inbox` and `inbox --hook` include them, as "for oncall". `team decide <oby> <id> answer|decline|write ["<text>"]` does the same from a terminal.
- **obysphere.mjs**: a "Team Obys" group in `help()`.
- **The console**: Waiting for you lists the team Obys' asks under "For oncall", with **Answer**, **Decline** and **Write**, and no **Trust** yet; a GitHub item there says it's decided on oncall's machine. Members shows a team Oby's name and stewards, marked as what its machine declares.
- **Tests**: `test/team.test.mjs`, with two representatives and the fake runtimes:
  - `team init` writes `team.json` at 0600 with the pinned keys, and refuses a steward with no keys;
  - a steward answers, declines or writes; a second decision gets "already decided";
  - `trust` and GitHub items are refused from afar;
  - a non-steward's control message, one signed with a key other than `team.json`'s, and a suspended steward's are dropped;
  - no control message reaches a model (the fake runtime never runs);
  - a notice is sealed for the stewards only, and the team Oby's own notifications still go; a notice from a bot the steward doesn't answer for is dropped;
  - `team` and `whoami --fingerprint` are in the CLI contracts.
- **Docs**: SETTINGS.md (a "Team Obys" section: stewards, what they decide from afar, what stays on the machine), README.md (a "Team Obys" section: running one with `obysphere start` on a shared machine), SECURITY.md ("On members' machines": a team Oby, and the threats in Option B), the plugin's `oby-settings` skill and CHANGELOG.md.
- **Depends on**: steps 1 and 2. Whether `team init` takes a profile that isn't a bot waits on question 1; who may make a team Oby, on question 2; GitHub items, on question 4; whose sign-in the README tells teams to use, on question 5.

### 4. Settings from afar, and a second steward (`get`, `settings` and `cosign`)

- **rep.mjs**, on the team machine:
  - `get`: the team Oby answers with its settings as its console gets them (`settingsForConsole()`: notification addresses masked), its `seq` and `settingsHash`, and what runs on it (its runtimes, from `localEnvironment()`).
  - `settings`: the checks in Option B (`seq`, `base`, and `validateSettings()` with this machine's MCP servers), with masked addresses kept as stored (`unmaskSettings()`). A new `settingsChange(before, after)` says which fields widen, with `riskyReach()` for the risky ones. A change that only narrows, or only changes Claude Code's model, effort or time limit, applies at once. A wider one waits, up to an hour like an ask, and the team Oby sends the other stewards the signed change, sealed for them.
  - `cosign {hash}`, from a different steward over that same signed change, applies it. With one steward, wider changes stay with the machine's host.
  - When a change applies: the settings written, a line in `changes.jsonl` (`seq`, `by`, `cosignedBy`, the hash, which fields changed), `seq` and `settingsHash` in `team.json`, a receipt to the stewards, and `declared.settings`. When the file's hash isn't the one `team.json` holds, someone on the machine changed it: a `by: "host"` line, and `seq` goes up.
  - `trust` decisions take a cosign too, once question 3 allows the risky reach from afar.
- **rep.mjs**, on a steward's machine: `GET /local/team/:oby/settings` (sends `get`, waits for the answer), `PUT /local/team/:oby/settings` (signs and sends `settings`) and `POST /local/team/:oby/cosign {hash}`; from a terminal, `team settings <oby> [--json]`, `team set <oby> <file>` and `team cosign <oby> <change>`.
- **The console**: the Settings page gets an Oby picker: your Oby, or a team Oby you steward. The same sections, loaded with `get`; Runtimes and This computer show what the team machine reports, and Try an ask isn't offered. Saving sends a signed change. A wider one says "Waits for a second steward", and the other stewards see it in Waiting for you, with **Co-sign**. Members shows "settings 12, changed by alice an hour ago".
- **Tests**:
  - a narrowing change from one steward applies, with its line in `changes.jsonl` and a receipt;
  - a wider one waits; a cosign from the same steward, or from someone who isn't a steward, is refused; one from a second steward applies it;
  - a stale `base`, a replayed `seq` and settings that don't validate are refused, with the field named;
  - masked addresses sent back keep the stored ones, and `get` never sends them;
  - a change made on the machine is logged `by: "host"`;
  - until question 3 is answered, the risky reach from afar is refused, even with two stewards.
- **Docs**: SETTINGS.md ("Team Obys": what one steward may change, what needs two, what stays on the machine, `changes.jsonl`), SECURITY.md and CHANGELOG.md.
- **Depends on**: step 3. The risky reach (and `trust`) from afar waits on question 3: until it's answered, it stays with the machine's host. The `github` section from afar waits on question 4: until then, changes there may only narrow.

### 5. Changing the stewards (`stewards`)

- **rep.mjs**: `{t: "stewards", seq, add, remove}`, gathered with step 4's `cosign` until a majority of the current stewards and everyone it adds have signed. Anyone removes themselves alone. The team machine updates `team.json` (an added steward's key from its pins, with its fingerprint in the receipt), `changes.jsonl` and `declared.team`, and names the new steward to answer for it (step 1). `team stewards <oby> [--add carol] [--remove bob]` does it from a steward's terminal.
- **The console**: for its stewards, the team Oby's page lists the stewards, with **Add**, **Remove** and **Leave**, and what waits for more signatures. When the relay lists a steward as removed, it says so.
- **Tests**: a change without a majority, or without the added steward's own signature, waits; removing yourself applies at once; a removed steward's later messages are dropped; with one steward left, wider changes stay with the host; with none, consoles say only the machine's host can change it.
- **Docs**: SETTINGS.md, SECURITY.md and CHANGELOG.md.
- **Depends on**: step 4.

### 6. Prompt instruments from afar (optional)

- **rep.mjs**: `{t: "instrument", oby, seq, name, file}` adds or changes a `prompt` instrument (`instruments/<name>.md`), checked as `instruments check` checks it, and always with a second steward; removing one needs only one. `command` instruments stay with the host, and are refused from afar.
- **The console**: the Instruments page, for a team Oby you steward.
- **Tests**: a `prompt` instrument from two stewards is added and declared; from one steward alone, it waits; a `command` one is refused.
- **Docs**: INSTRUMENTS.md, SETTINGS.md and CHANGELOG.md.
- **Depends on**: step 4.

### 7. Settings from a repository (optional: Option C)

- **rep.mjs**: `settings --from <folder>` checks the folder's `settings.json` with `validateSettings()` and copies it in, keeping this machine's notification addresses. On a team Oby, it's logged in `changes.jsonl` as `by: "repository"`, and the stewards get a receipt. Pulling the repository, and checking commit signatures first, stay the team's own job.
- **Tests**: a valid folder applies; an invalid one changes nothing and names the field; the notification addresses are kept.
- **Docs**: SETTINGS.md ("Settings from a repository": CODEOWNERS, branch protection, signed commits, a deploy key) and CHANGELOG.md.
- **Depends on**: nothing; on a team Oby, step 4's `changes.jsonl`.

Later, outside this plan: each person's Oby signing "I answer for oncall" with their own key, for others to check against their pins.

## Questions for the owner

1. Is a team Oby always a bot, or may a person's own Oby have stewards too?
2. May any member make a team Oby, or only admins?
3. Risky reach changed from afar: allowed with two stewards, or only on the machine itself?
4. Does D11 (a team's Oby never approves on GitHub) still hold with 0.3.0's GitHub settings?
5. Whose sign-in pays for a team Oby's answers: one steward's Claude plan, or a seat of its own for the team's machine?
6. Should who answers for a team Oby be visible to anyone with the join key, or to members only?
