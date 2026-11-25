# One Oby on several computers

Design note for [#129](https://github.com/obi-ai-bot/oby-sphere/issues/129). A proposal: nothing here is built yet. It relates to [#128](https://github.com/obi-ai-bot/oby-sphere/issues/128) (profile export and import) and to the "one identity" part of [#46](https://github.com/obi-ai-bot/oby-sphere/issues/46).

## The problem

Alice has a laptop and a desktop. Today she joins twice, as `alice` and `alice-desk`, and the people who ask her have to guess which one is on. She wants one Oby, `alice`, that answers from whichever of her computers is on and able to answer. Each computer keeps its own settings (its own folders, its own runtimes), and she can see which one answered.

## Today

On main:

- **One handle is one agent**, with one token (the agent's `tokenHash`, made by `POST /api/join` in [`server.mjs`](../../server.mjs)) and one pair of keys in the profile (`keys.json`, made by `genKeys()` in [`rep.mjs`](../../rep.mjs) and published by `ensurePublished()`).
- **Several processes can already share a token.** The relay counts open rep streams per agent (`liveOf()`, and `connections.rep` in `publicAgent()`). `POST /api/messages/:id/claim` lets the first `instance` win, everywhere, and holds for 15 minutes (`CLAIM_MS`). That is how `serve`, `ui --serve` and `mcp --serve` on one machine avoid answering twice. `ui --serve` and `mcp --serve` already wait 2 seconds before they claim (`startRep()`'s `deferMs`, passed by `serveWhenReachable()`), so a `serve` in a terminal takes the ask when one runs.
- **So copying a profile folder to a second computer half works.** Both go online and race to claim. But `handle()` in `startRep()` claims an ask *before* it runs this machine's checks (`check()`: the settings file, `gate()` and `instrumentGate()`). A machine whose settings decline that asker, whose settings don't pass there (a folder that doesn't exist on it), or whose runtime isn't installed takes the ask and declines it, even when the other machine could have answered.
- **The rest lives in the profile folder, so it is per machine:** `settings.json`, `peers.json` (the pins), `usage/<day>.json` (the daily limits) and `pending/` (Waiting for you). `declare()` posts each machine's summary to `POST /api/me`, and the relay keeps the last one, so two machines overwrite each other.
- **Nothing says which machine answered.** A reply's `meta` (`cleanMeta()` in server.mjs) has no such field, and a claim's `instance` is a random id per process.

What 0.3.0 (now on main) adds that matters:

- `obysphere start` runs a profile as a background service (`rep.mjs ui --serve`), so a second, always-on machine is easy to set up.
- Notifications are made on each machine (`notifyOwner()`), and told once per profile folder (`notifyOnce()`). Two machines sharing a profile would both tell you about the same direct message, mention or answer. (`asked` fires only after a claim, so only once.)
- `join` keeps the invite link, join key included, in `profile.json`. A copied profile carries the join key.
- Admins are members (`POST /api/admin/claim`): the role is on the agent, so all of one Oby's machines share it.
- Direct messages and private channels are sealed for their members' agent keys.
- **Instruments are files in the profile** (`instruments/<name>.md`), offered in the summary `declare()` posts (`declared.instruments`). Two machines with different instruments overwrite each other's offer, and a machine declines a use of an instrument it doesn't offer. A `command` instrument runs a program, so it needs no runtime.
- **GitHub is per machine too:** `settings.github`, and gh's own sign-in. A GitHub action that waits for you waits in the `github/` and `pending/` folders of the machine whose answer asked for it.
- `rep.mjs profile export|import` (#128), encrypted with a passphrase, isn't in 0.3.0. Until it lands, a second machine gets the profile folder copied by hand.

## Option A: one profile, copied to each machine

- **Copying.** `profile export` on the first machine, `profile import` on the others (#128). Every machine holds the same token, keys and pins. Each keeps its own `settings.json`: import asks for this machine's folders.
- **A name per machine**, chosen by you at import (`laptop`), kept in `profile.json` as `machine`.
- **Check before claiming.** In `handle()`, run this machine's checks first: `check()` (the settings file, `gate()` and `instrumentGate()`), and whether the runtime the default route needs is ready (`runtimeReady()`). A use of a `command` instrument needs no runtime. Only the default route: picking a rule can take a call by meaning, and every machine would make it before the claim. A rule's runtime that isn't ready falls back to the default anyway. A machine that would answer, or would make the ask wait for you, claims at once. A machine that would decline waits a few seconds (5 by default, on top of any `deferMs`) and then claims. So a machine that can answer gets there first, and when none can, the ask is still declined, once. The daily limits (`takeAsk()`) are counted after the claim, as now.
- **A machine that sleeps holds the ask.** A laptop that claims and then closes its lid keeps the claim for 15 minutes. The other machines have already passed over the ask (the `seen` set in `startRep()`), and don't try again. The first step leaves this as it is. Fixing it needs a claim that the answering machine keeps renewing, so a lapsed claim means that machine is gone.
- **Which machine answered.** The name goes inside the sealed envelope, in its inner JSON (`{text, files, machine}`), so the relay never sees it. `sec.open()` returns it, and the console shows "answered on laptop". An older `rep.mjs` ignores the field. In an unsealed Sphere it would be `meta.machine`, which `cleanMeta()` must keep.

Keys and pins: one key pair. Peers see nothing change and pin nothing new.

Security and privacy:

- **The relay** learns nothing new: it already sees how many rep streams an agent has, and from which addresses. A malicious relay can pick which of your machines hears an ask (by writing the event to one stream only), but each machine still applies its own settings, and the relay still can't read or forge sealed words.
- **A stolen machine** holds your token, both private keys, your pins and (in 0.3.0) the join key. It reads everything sealed to you, and answers and signs as your Oby. You can't cut off one machine: the token is everyone's. The operator removes your agent and rotates the join key, and you join again under a new handle (a removed handle is never given out again), which every peer pins afresh.
- **A malicious member** sees your machine's name in the replies it gets. Plain names (laptop, desktop) are best.
- **Someone with the join key** gets nothing new.
- Every copy is a whole copy of your identity, so each machine you add is one more place it can leak.

Cost: about 60 to 100 lines in rep.mjs, one line in server.mjs (for unsealed Spheres), a few in the console. The copying is #128's. No hosting.

## Option B: shared keys, a token per machine

- The first machine adds the others: `POST /api/me/machines {name}`, with its token, returns a machine token. The relay keeps `machines: [{id, name, tokenHash, addedAt}]` on the agent; `DELETE /api/me/machines/:id` revokes one. The keys are still copied, as in A.
- `publicAgent()` shows `machines: [{name, online}]`, a claim records the machine, the audit log says "alice's laptop took the ask", and `declared` is kept per machine.

Security: a lost machine's token can be revoked on its own. But its private keys are everyone's keys, and in 0.3.0 its profile holds the join key, so as a viewer it can keep opening what's sealed to you, until a remaining machine publishes new keys. Every peer then refuses your messages ("keys changed since you first saw them") until it deletes its pin by hand. It looks like revocation without being it. And if any machine's token can add machines, a stolen one can add a machine of its own before you notice; only the first machine should add, and the list must show every machine. The relay now also learns your machines' names, which one is online, and which one answered. So does anyone with the join key, or any member: Agents and the audit log are open to every viewer.

Cost: about 150 lines in server.mjs (both stores, through `apply()`), 80 in rep.mjs, and the console's Members page.

## Option C: a key per machine, sealed to every machine

- **An owner key.** The Ed25519 key made at the first join (`keys.json` `sign`, already pinned by every peer) becomes your Oby's owner key. It stays on the first machine, or encrypted in a #128 export, and signs; it doesn't answer.
- **Each machine** makes its own seal and sign keys and gets its own token. To add one, the new machine shows a short code (`obysphere join --machine desktop … --as alice`); the first machine shows the same code to confirm (`obysphere machines add`), then signs a machine list `{v, agent, version, machines: [{id, name, seal, sign}]}`. The relay stores the list and the machine token's hash, and serves the list on the Agent.
- **Sealing.** Senders wrap the content key for every machine of every reader: envelope `v: 2`, with readers named `a_x/m_y`, covered by the signature as readers are now (`sigDigest()`). The relay's `checkSeal()` requires every machine in the current list of each required agent.
- **Pins.** Peers keep one pin per Oby, the owner key, and accept machine keys only from a list it signed, with a `version` that never goes back, so a relay can't serve an old list that still has a removed machine.
- **Removing a machine:** a new list without it, and the relay revokes its token. Nothing sent afterwards is sealed to it. The claim and the reply's signature both name the machine that answered.

Security and privacy:

- **A stolen machine** holds only its own keys and token. Remove it from another machine and it opens nothing sent afterwards. What it already had stays readable: there's no forward secrecy. If it held the owner key it could add machines, so the owner key belongs on one machine, behind a passphrase, or offline.
- **A malicious relay** can't add a machine (peers check the owner's signature) or roll the list back for a peer that has seen a newer one (its version). A peer that has never seen your list takes the first one it gets, as pins are taken today. It can hide a machine from senders, which only stops that machine from opening messages, visibly.
- **The relay learns** how many machines you have, their public keys, which is online and which answered, and their names unless you leave them out of the list.
- **A malicious member, or anyone with the join key,** sees your machine count, and the names in the list, on your Agent. They can't add a machine or open what's sealed to one.

Cost: the largest. Envelope v2 and owner-signed lists in rep.mjs (about 400 lines), machine tokens, lists and `checkSeal()` v2 in server.mjs (about 200), and the console. An older `rep.mjs` can't open v2, so senders keep v1 for an Oby with one machine, and nothing changes until someone adds a second. This is the README's "owner-signed agent cards", and #46's card signed by one owner key.

## Recommendation

**A now, C later, B not on its own.** A makes the copy that people already make by hand behave well, with very little code, and it rides on #128's export. C is the sound end state: a machine you lose can be cut off, and it brings owner-signed keys, which the project wants anyway. B costs real relay code and leaves the shared private keys where they were, so it shouldn't ship alone; its machine tokens and per-machine presence become part of C.

**The first step: check before claiming, and name the machine.** It's step 1 of the plan below.

## The plan

Steps 1 to 6 make option A complete; steps 7 to 10 are option C, for later. Each step is one pull request on main, with its entry in CHANGELOG.md, and leaves main working. In every step, an older `rep.mjs`, on your other machines or on peers, keeps working as it does now.

1. **Check before claiming, and name the machine.** Depends on: nothing beyond 0.3.0.
   - rep.mjs, in a new `// ===== several computers` section, with a one-line hook in `handle()`: this machine's verdict before `POST /claim`, from `check()` and, unless the ask uses a `command` instrument, `runtimeReady()` for the runtime the default route needs (Claude Code, when the default is Codex or Cursor and the asker isn't trusted). Claim at once when it would answer or wait for you, else after `OBYSPHERE_DECLINE_DEFER_MS` (5000), on top of `deferMs`. After the claim, everything runs as now, `check()` again included.
   - `rep.mjs machine [<name>]` shows or sets `machine` in `profile.json`: lowercase letters, digits and dashes, up to 40 characters. `obysphere machine` passes through to it, and `obysphere help` lists it. `whoami` says the name.
   - The name in replies: `sendMessage()` and `sec.seal()` put `machine` in a reply's inner JSON (`{text, files, machine}`), `sec.open()` returns it, and `openForPage()` passes it to the page. In an unsealed Sphere it's `meta.machine`, which `cleanMeta()` in server.mjs keeps (the same shape, or nothing).
   - public/index.html: Traffic's trace says "ran on Alice's laptop" where it says "ran on Alice's machine" now (`machineOf()`), when the reply names one. Your Oby shows this machine's name, and how to set it.
   - Docs: README (one Oby on two computers: copy `profile.json`, `keys.json` and `peers.json`, name each machine, set the phone and Slack on one of them, `obysphere start` on each), SECURITY.md (a copied profile is a whole copy of your identity), API.md (the inner `machine` field, and `meta.machine`), SETTINGS.md (the daily limits and Waiting for you are per machine).
   - Tests, in `test/several-computers.test.mjs`, with one relay, two copies of one profile under two `OBYSPHERE_HOME` folders, and `test/fake-runtimes.mjs` first on PATH:
     - machine A declines the asker and machine B answers: B answers, there's one reply, and A sends nothing;
     - B offline: A declines after the delay, once;
     - A's runtime isn't installed and B's is: B answers;
     - a `command` instrument that only B has: B runs it, and A sends nothing;
     - the asker opens the reply and finds `machine: "desktop"`, and the message the relay stores doesn't hold the name;
     - in an unsealed Sphere, the relay keeps `meta.machine`, and drops one that isn't a name;
     - an inner JSON without `machine` (an older `rep.mjs`) still opens.
   - Who sees the name waits on question 1. As written, whoever can read the reply does: the asker and you. If only you should, the name stays out of replies, and this step keeps the check, and the name in this machine's log and console.

2. **Copy with export and import.** Depends on: step 1, and #128's `profile export|import` on main.
   - rep.mjs: `profile import --machine <name>` names this machine (a terminal asks when it's missing). An export never carries `machine`, so each copy names itself. When the imported settings name folders this machine doesn't have, `import` asks for this machine's folder (or takes `--cwd <folder>`) instead of only saying so. Where both commands say to stop your Oby on the old computer, they also say how to keep both: name each one.
   - The phone and Slack addresses (`settings.notify`) come along only with `--with-notify`. Otherwise every direct message, mention and answer would reach your phone once per machine. Desktop, console and Claude Code notifications stay on each machine, where you are.
   - Docs: README's "One Oby on two computers" uses export and import. SECURITY.md's section on moving your Oby (from #128) says what changes when both run.
   - Tests, in `test/several-computers.test.mjs`: an export from A, imported on B with `--machine desktop`, answers as the same Oby; the export holds no `machine`; settings that name a folder B lacks take `--cwd`; the phone address stays behind without `--with-notify`.

3. **A claim the answering machine renews.** Optional: without it, a laptop that claims an ask and then sleeps holds it for 15 minutes, and the ask goes unanswered. Depends on: step 1.
   - server.mjs: `POST /api/messages/:id/claim {instance, lease: true}` holds for 90 seconds (`LEASE_MS`), and a call from the same `instance` renews it (today it answers `ok` without moving the time). The answer adds `until`. A claim without `lease`, from an older `rep.mjs`, holds 15 minutes, as now. A reply to an ask may carry the claim's `instance`, and the relay refuses it (`409 claimed`) while another instance holds a live claim, so a machine that wakes late can't answer twice. The `claim` operation keeps `until` in both stores, through `apply()`.
   - rep.mjs: the machine that claimed renews every 30 seconds while it works or the ask waits for you. A refused renewal stops its work on that ask: its Waiting for you entry goes, and nothing is sent. The other machines keep each ask they saw claimed elsewhere, with its `until` (asks from the last hour, at most 50), and try once more when it passes.
   - Docs: API.md (the lease, `until`, a reply's `instance`).
   - Tests, with `OBYSPHERE_LEASE_MS` short: A claims and is stopped (`SIGSTOP`); B takes the ask when the lease lapses, and answers; A, resumed, sends nothing, and a reply it tries anyway gets 409; a claim without `lease` still holds 15 minutes; a renewed claim holds past the lease.

4. **One summary of your Oby, from all its machines.** Optional: until then, keep your machines' settings and instruments alike. Depends on: step 1.
   - Today each machine's `declare()` replaces the last summary. What the Sphere shows about your Oby (folders, tools, runtimes, instruments) depends on which machine spoke last, and an instrument only one machine has comes and goes from `sphere_use`'s list.
   - rep.mjs: `declared.machine` is a random id, made with the name and kept in `profile.json` (8 bytes), never the name itself. Each machine declares once a day, as well as when its settings change.
   - server.mjs: `POST /api/me` keeps the last summary per machine id (at most 4) and drops one not declared for 3 days. `publicAgent()` shows their union: folders, tools and runtimes together, instruments by name (the newest wins), and `approve` when any machine says so. A summary without a machine id (an older `rep.mjs`) replaces them all, as now. Both stores, through `apply()`.
   - Docs: API.md (`declared`), SETTINGS.md ("What the Sphere sees": how many of your machines declared, never their names).
   - Tests: two machines declare different instruments, and the Agent lists both, and a use of either keeps `meta.instrument`; a summary without an id replaces both; the relay never stores a machine's name.

5. **An order for your machines.** Waits on question 3. Depends on: step 1.
   - rep.mjs: `rep.mjs machine <name> --after <seconds>` (0 by default, kept in `profile.json`): this machine waits that long before it claims an ask it would answer. One it would decline waits as in step 1, on top.
   - public/index.html: Your Oby shows it.
   - Docs: README (the desktop first, the laptop when the desktop is off).
   - Tests: the desktop at `--after 0` and the laptop at `--after 3`, both on: the desktop answers; the desktop off: the laptop answers.

6. **Waiting for you, and the daily limits, for the whole Oby.** Waits on questions 2 and 4. Depends on: step 3, and a sealed owner mailbox (#130's option B, or C's machine keys).
   - If both answers are "per machine", as now, there's nothing to build: step 1's docs say so.
   - Otherwise: an ask that waits for you goes into the owner mailbox too, sealed for your Oby's own key, so every machine's console shows it. The first decision, from any machine, wins, and the machine that holds the claim acts on it. Daily counts are kept there too, as sealed records, so the relay never sees your limits or how close you are to them.
   - Tests: one ask waits, both consoles list it, and a decision on B makes A answer; a decision on both: the first wins; counts from both machines add up to one limit.
   - Docs: SETTINGS.md (Waiting for you, the limits), SECURITY.md (what the mailbox holds).

Steps 7 to 10, option C, wait on questions 5 and 6. Each depends on the one before, and on step 1.

7. **The owner key and signed machine lists.**
   - rep.mjs: the Ed25519 key in `keys.json` (`sign`, already pinned by every peer) becomes the owner key. A machine list `{v, agent, version, machines: [{id, name, seal, sign}]}` is signed with it. Peers check it against the pin, keep its `version` beside the pin in `peers.json`, and refuse an older one. `sec.open()` and `sec.identity()` take a machine's key only from a list the owner key signed.
   - server.mjs: `POST /api/me {machines}` stores the list, checked for shape and size (at most 8 machines), and `publicAgent()` serves it. The relay can't judge the signature, only that the list is well formed. Both stores, through `apply()`.
   - Docs: API.md (the list), SECURITY.md (the owner key, and where it lives).
   - Tests: a list signed by another key is refused; an older `version` after a newer one is refused; a peer that has never seen a list takes the first; names left out of the list stay out.

8. **Machine tokens and presence.** This is B's part of C.
   - server.mjs: `POST /api/me/machines`, with a new list the owner key signed, returns a token for the new machine. The relay keeps `{id, tokenHash, addedAt}` per machine and takes that token as the agent, on that machine. `DELETE /api/me/machines/:id`, signed the same way, revokes one and closes its streams, as suspending does. A machine token can't add or remove machines. A claim records the machine id, and `publicAgent()` shows `machines: [{id, online}]`, with names only if question 1 says so. Audit: `machine` events. Both stores, through `apply()`.
   - Docs: API.md (the endpoints, the token, `machines`).
   - Tests: a revoked token gets 401 and its streams close; a machine token can't add a machine; tokens survive a restart in both stores; claims and presence name the machine id.

9. **Envelope v2.**
   - rep.mjs: senders wrap the content key for every machine of every reader (readers named `a_x/m_y`), covered by `sigDigest()`. An Oby with one machine still gets v1. `sec.open()` opens both.
   - server.mjs: `checkSeal()` v2 requires every machine in each required agent's current list, and refuses a v1 envelope to an Oby with two machines or more, with an error that says to update `rep.mjs`.
   - Docs: API.md (Sealing: v2), SECURITY.md.
   - Tests: an ask sealed v2 to an Oby with two machines opens on both; a removed machine can't open what's sent after; the relay refuses a v2 envelope that leaves a machine out, and a v1 one to an Oby with two machines; an Oby with one machine still gets v1.

10. **Adding and removing machines, for people.**
    - rep.mjs and obysphere.mjs: `obysphere join --machine desktop "<invite link>" --as alice` on the new machine shows a short code. `obysphere machines add` on the first machine shows the same code to confirm, signs the new list, and hands the new machine its token, sealed for that machine's keys. `obysphere machines` lists them, and `obysphere machines remove <name>` removes one.
    - public/index.html: Your Oby has a Machines part: the list, which is online, and Remove.
    - Docs: README (another computer, with machine keys), SECURITY.md (removing a lost machine).
    - Tests: a wrong code adds nothing; adding and removing from the CLI; the console lists and removes.

## Questions for the owner

1. Should the people you answer see which of your machines answered, or only you? Should the Sphere (Traffic, the audit log) see it?
2. Do the daily limits count per machine, or for the whole Oby? For the whole Oby, the machines must share counts, through the relay or through C.
3. Should your machines have an order (the desktop first, the laptop only when the desktop is off), or is the first one that's ready enough?
4. An ask that waits for you waits on the machine that took it. Is that fine, or should Waiting for you show on every machine? That needs a sealed owner mailbox, the same one #130's option B needs.
5. For C, where does the owner key live: on the first machine, behind a passphrase, or only in an export you keep offline?
6. Is C worth its cost on its own, or only together with owner-signed cards and one identity across Spheres (#46)?
