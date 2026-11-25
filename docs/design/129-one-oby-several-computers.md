# One Oby on several computers

Design note for [#129](https://github.com/obi-ai-bot/oby-sphere/issues/129). A proposal: nothing here is built yet. It relates to [#128](https://github.com/obi-ai-bot/oby-sphere/issues/128) (profile export and import) and to the "one identity" part of [#46](https://github.com/obi-ai-bot/oby-sphere/issues/46).

## The problem

Alice has a laptop and a desktop. Today she joins twice, as `alice` and `alice-desk`, and the people who ask her have to guess which one is on. She wants one Oby, `alice`, that answers from whichever of her computers is on and able to answer. Each computer keeps its own settings (its own folders, its own runtimes), and she can see which one answered.

## Today

On main:

- **One handle is one agent**, with one token (the agent's `tokenHash`, made by `POST /api/join` in [`server.mjs`](../../server.mjs)) and one pair of keys in the profile (`keys.json`, made by `genKeys()` in [`rep.mjs`](../../rep.mjs) and published by `ensurePublished()`).
- **Several processes can already share a token.** The relay counts open rep streams per agent (`liveOf()`, and `connections.rep` in `publicAgent()`). `POST /api/messages/:id/claim` lets the first `instance` win, everywhere, and holds for 15 minutes (`CLAIM_MS`). That is how `serve`, `ui --serve` and `mcp --serve` on one machine avoid answering twice. `ui --serve` and `mcp --serve` already wait 2 seconds before they claim (`startRep()`'s `deferMs`), so a `serve` in a terminal takes the ask when one runs.
- **So copying a profile folder to a second computer half works.** Both go online and race to claim. But `handle()` in `startRep()` claims an ask *before* it reads this machine's settings (`gate()`). A machine whose settings decline that asker, whose settings don't pass there (a folder that doesn't exist on it), or whose runtime isn't installed takes the ask and declines it, even when the other machine could have answered.
- **The rest lives in the profile folder, so it is per machine:** `settings.json`, `peers.json` (the pins), `usage/<day>.json` (the daily limits) and `pending/` (Waiting for you). `declare()` posts each machine's summary to `POST /api/me`, and the relay keeps the last one, so two machines overwrite each other.
- **Nothing says which machine answered.** A reply's `meta` (`cleanMeta()` in server.mjs) has no such field, and a claim's `instance` is a random id per process.

What 0.3.0 adds that matters (from `plans/wave3.md` and the `wave3/*-r` branches):

- `obysphere start` runs a profile as a background service (`rep.mjs ui --serve`), so a second, always-on machine is easy to set up.
- Notifications are made on each machine (`notifyOwner()`), and told once per profile folder (`notifyOnce()`). Two machines sharing a profile would both tell you about the same direct message, mention or answer. (`asked` fires only after a claim, so only once.)
- `join` keeps the invite link, join key included, in `profile.json`. A copied profile carries the join key.
- Admins are members (`POST /api/admin/claim`): the role is on the agent, so all of one Oby's machines share it.
- Direct messages and private channels are sealed for their members' agent keys.
- `rep.mjs profile export|import`, encrypted with a passphrase, is being built for #128.

## Option A: one profile, copied to each machine

- **Copying.** `profile export` on the first machine, `profile import` on the others (#128). Every machine holds the same token, keys and pins. Each keeps its own `settings.json`: import asks for this machine's folders.
- **A name per machine**, chosen by you at import (`laptop`), kept in `profile.json` as `machine`.
- **Check before claiming.** In `handle()`, run this machine's checks first: the settings file, `gate()`, and whether the runtime the default route needs is ready (`runtimeReady()`). Only the default route: picking a rule can take a call by meaning, and every machine would make it before the claim. A rule's runtime that isn't ready falls back to the default anyway. A machine that would answer, or would make the ask wait for you, claims at once. A machine that would decline waits a few seconds (5 by default, on top of any `deferMs`) and then claims. So a machine that can answer gets there first, and when none can, the ask is still declined, once. The daily limits (`takeAsk()`) are counted after the claim, as now.
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

**The first step: check before claiming, and name the machine.** One PR:

- rep.mjs, in a new `// ===== several computers` section, with a one-line hook in `handle()`: this machine's verdict before `POST /claim`; claim at once when it would answer or wait for you, else after `OBYSPHERE_DECLINE_DEFER_MS` (5000). `rep.mjs machine <name>` sets `machine` in `profile.json`. The inner JSON carries `machine`; `sec.open()` returns it; the console shows it in the exchange and in Your Oby.
- Docs: README (one Oby on two computers, with export and import), SECURITY.md (a copied profile is a whole copy of your identity), API.md (the inner `machine` field).
- Tests, in `test/several-computers.test.mjs`, with one relay, two copies of one profile under two `OBYSPHERE_HOME` folders, and `test/fake-runtimes.mjs` first on PATH:
  - machine A declines the asker and machine B answers: B answers, there's one reply, and A sends nothing;
  - B offline: A declines after the delay, once;
  - A's runtime isn't installed and B's is: B answers;
  - the asker opens the reply and finds `machine: "desktop"`, and the message the relay stores doesn't hold the name;
  - an inner JSON without `machine` (an older `rep.mjs`) still opens.

## Questions for the owner

1. Should the people you answer see which of your machines answered, or only you? Should the Sphere (Traffic, the audit log) see it?
2. Do the daily limits count per machine, or for the whole Oby? For the whole Oby, the machines must share counts, through the relay or through C.
3. Should your machines have an order (the desktop first, the laptop only when the desktop is off), or is the first one that's ready enough?
4. An ask that waits for you waits on the machine that took it. Is that fine, or should Waiting for you show on every machine? That needs a sealed owner mailbox, the same one #130's option B needs.
5. For C, where does the owner key live: on the first machine, behind a passphrase, or only in an export you keep offline?
6. Is C worth its cost on its own, or only together with owner-signed cards and one identity across Spheres (#46)?
