# Answer "Waiting for you" from your phone

Design note for [#130](https://github.com/obi-ai-bot/oby-sphere/issues/130). A proposal: nothing here is built yet.

## The problem

An ask from bob waits for Alice's decision. In 0.3.0 her phone hears about it. But to let her Oby answer, decline the ask, or write the answer herself, she has to be at her computer: the console that decides runs at `localhost`. If she doesn't decide within the hour, the ask is declined ("no answer from its owner").

## Today

On main:

- **An ask waits** when your settings say *Ask me first* for that Oby, or with `serve --approve` (`gate()`, then `ownerDecides()` in `startRep()`, in [`rep.mjs`](../../rep.mjs)).
- **It waits as a file.** `addPending()` writes `pending/w_<12 hex>.json` (0600), with the ask's words, who asked, the channel and `expiresAt` (`APPROVE_WAIT_MS`, an hour). Any of this profile's processes on this machine can decide: the console's `POST /local/pending/:id` and the terminal both call `decidePending()`, which writes `w_….decision.json` with the `wx` flag, so the first decision wins and a later one gets 409. `waitPending()` reads it, declines at the deadline, and removes both files.
- **The decisions:** `answer`, `trust` (let it answer with everything you allow), `decline`, and `write` (with your text).
- **Only this machine can reach them.** `/local/*` answers on 127.0.0.1, from the console's own origin, with its header (`ui()`).
- **No web push.** The console refuses service workers (`worker-src 'none'` in `PAGE_HEADERS`, and 403 for a `Service-Worker` header), and the browser's [Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API) needs one. So a phone hears about asks through a service like ntfy, not through the console.

What 0.3.0 adds that matters (from `plans/wave3.md` and the `wave3/*-r` branches):

- **Phone notifications.** `addPending()` notifies (`notifyOwner()`, type `waiting`), so anything that waits reaches your phone when you've set an ntfy topic: `notifySend()` posts to it with a `Title` and `Priority: high`, and says only who and what kind unless you choose the full text. The topic's address is a secret in `settings.json`, never sent to the Sphere and masked in the console. Slack gets a one-way message through your own incoming webhook.
- **More things wait for you:** a GitHub action your Oby wants to take as you (approve, request changes, merge), and someone you don't trust using one of your `command` instruments.
- **Your Oby keeps running while you're away** (`obysphere start`), which is exactly when you'd decide from your phone.

So in 0.3.0 a decision can approve a pull request as you, or run a program. Deciding from the phone needs care.

## Option A: buttons in the ntfy notification

- **The buttons.** When an ask waits, the `waiting` notification gets two [ntfy action buttons](https://docs.ntfy.sh/publish/#action-buttons) of type `http`: **Let it answer** and **Decline**. ntfy allows up to three, and its Android, iOS and web apps all support `http` actions.
- **One ask per notification.** 0.3.0 gathers events of one kind that come within 3 seconds into one notification ("2 asks wait for you", `notifyFlush()` and `notifyNote()`), and `notifyNote()` drops the pending id. So only a notification for a single ask gets buttons, and `notifyNote()` must keep that ask's pending id for it.
- **Where they post.** Not to your computer: it's behind your router, and the console listens on 127.0.0.1 only. A button posts to a second topic on the same ntfy server, the reply topic (32 random characters, made once and kept in the profile). Your representative listens to it ([`GET <server>/<reply topic>/json`](https://docs.ntfy.sh/subscribe/api/), one JSON line per message) only while something waits, and stops after.
- **A one-time code in each button's body:** `{v: 1, w: "w_…", d: "answer", exp: <expiresAt>, mac}`, with `mac = HMAC-SHA256(k, "obysphere/phone/v1" ‖ agent id ‖ w ‖ d ‖ exp)`. `k` is 32 random bytes in the profile (0600) that never leave this machine. The representative checks the `mac` (in constant time) and the expiry, checks that the ask still waits, then calls `decidePending()`. The first decision wins, from the phone or the console. `clear=true` removes the notification once the post succeeds.
- **What a phone may decide:** `answer` and `decline` only. Not `trust`; not `write` (ntfy buttons take no text); and no buttons on a GitHub action or a command instrument, which need you at the console.

Security and privacy:

- **Whoever reads your notification topic can press.** An ntfy topic is "essentially a password" ([picking a topic](https://docs.ntfy.sh/publish/#picking-a-topic)), and an ntfy server keeps messages for 12 hours by default ([message caching](https://docs.ntfy.sh/publish/#message-caching)). So someone who knows the topic, or ntfy.sh's operator, can let your Oby answer or decline what waits, until it expires. They can't read the ask (the summary has no words), write an answer, give the risky reach, or decide anything else: each code is bound to one ask, one decision and one expiry. A self-hosted ntfy server with access control narrows this to you. (0.3.0 refuses addresses with a user name or password in them, so an ntfy access token would be a new setting, sent as an `Authorization` header.)
- **The reply topic:** a post without a valid code is ignored. The representative reads small lines only, and few of them.
- **Replay:** a code works once (the decision file is made with `wx`) and only before `exp`.
- **You decide without the words.** In `summary` mode the phone shows who asked, not what. Pressing **Let it answer** lets your Oby answer an ask you haven't read, which is the check *Ask me first* was there for. With `full`, up to 600 characters of the ask go to the ntfy server.
- **What ntfy's operator learns:** who asked (the title names the Oby), when, and what you chose (the reply topic carries it). It can press too, as above.
- **A stolen phone** can press the buttons on the notifications it holds, for up to an hour each. Removing the topic from the phone, or changing it, ends that.
- **The relay** isn't involved. It learns nothing, and a malicious relay never sees a code. Neither does someone with the join key, or another member: the topics never reach the Sphere.
- **Keys:** `k` stays on your machine, and the code is in a body, not a URL. The codes do travel in the notification: that's the trade-off above.

Cost: about 120 lines in rep.mjs (the buttons in `notifySend()`, the reply-topic stream, the check) and one setting. Nothing in server.mjs, no hosting.

## Option B: a sealed approval page, the relay as a mailbox

- **Pairing, once.** In the console, **Add your phone** shows a QR code: the phone page's address, with a fragment that holds a one-time pairing code (128 random bits; it works once, for 10 minutes) and your Oby's public keys. The fragment goes from your screen to the phone's camera, never to a server, and the page takes it out of the address bar at once. The phone makes its keys and registers them through the relay, with an HMAC over them under the pairing code; your representative checks it, then pins the phone's keys. The phone takes your Oby's keys from the QR code, not from the relay. The relay gives the phone a device token that opens only the mailbox, never your agent token. (Six digits to compare, computed from the keys, wouldn't do: a relay in the middle can try key pairs until its own give the same six, about a million tries, minutes for a computer.)
- **The phone's keys.** A passkey ([WebAuthn](https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API)) signs decisions, and is unlocked with a face, a fingerprint or the phone's passcode each time. Passkeys usually sync to your other devices through your Apple or Google account ([Apple's note](https://support.apple.com/en-us/102195)), so that account guards them too. The browser hands over the public key in a standard form ([`getPublicKey()`](https://developer.mozilla.org/en-US/docs/Web/API/AuthenticatorAttestationResponse/getPublicKey)), and Node's `crypto` checks the signatures, so no dependency is needed. An X25519 key made with WebCrypto ([`deriveBits`](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveBits): Chrome 133, Firefox 130 and Safari 17 have it, per MDN's data) opens what's sealed for the phone.
- **An ask that waits** is sealed by your representative for the phone, with the envelope messages use (AES-256-GCM under a key wrapped with X25519 and HKDF-SHA256), together with its pending id, a fresh nonce and `exp`. It goes to a new mailbox on the relay, `POST /api/owner/items` (agent token), kept until `exp` and then dropped. The ntfy notification says "Open it on your phone".
- **On the phone**, the page lists the items (`GET /api/owner/items`, device token) and opens one. You let it answer, decline, or write. The decision `{v, w, askId, d, nonce, exp, textHash}` is signed with the passkey: its hash is the WebAuthn challenge, so the signature covers it. Written text is sealed for your Oby's own key. The phone posts it (`POST /api/owner/decisions`), and the relay pushes it to your representative's streams only, as a new `owner` event.
- **Your representative** checks the signature against the pinned passkey, and that what it signed holds that challenge, the phone page's origin, and the flag that says the passkey was unlocked (user verified). Then the nonce, `exp`, and that the ask still waits; then it calls `decidePending()`.
- **The relay stores** device token hashes, sealed items (with their size, time and expiry) and decisions, in both stores through `apply()`.
- **Where the page comes from decides most of its safety.** If the relay served it, a malicious relay could serve a page that shows "Decline" while it asks the passkey to sign "Let it answer", and that reads what it opens. `ui()` serves the page beside `rep.mjs` for this reason, because that page makes decisions. (With `rep.mjs` alone it still falls back to the relay's page: a gap today.) So the phone page should come from the project, as `rep.mjs` does: a static page from this repository, at one fixed address with an origin of its own, calling the relays' mailboxes with [CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS) allowed for that origin only. On [GitHub Pages](https://docs.github.com/en/pages), every project site of one account shares one origin, so it would need a custom domain or an account of its own.

Security and privacy:

- **A malicious relay** can't read items or written answers, can't forge or replay decisions (signature, nonce, expiry), and can't slip in its own phone at pairing (the pairing code). It can withhold or delay, and the ask then times out as today. It learns that you have a phone paired, when asks wait, and when you decide.
- **Whoever controls the page's address** is trusted as much as this repository: a page served there could show one decision and have the passkey sign another, and read what it opens.
- **A stolen phone** must unlock the passkey for each decision (face, fingerprint or passcode), and you unpair it from the console. While it's unlocked and paired, it can read the asks that wait. With a WebCrypto key instead of a passkey, an unlocked phone could also decide. Someone who takes over your Apple or Google account may get a synced passkey, but not the device token or the X25519 key, which stay in the page's storage on the phone.
- **Someone with the join key, or a malicious member,** sees nothing: the mailbox is per agent and needs a device token.
- **Still no `trust` from a phone** by default. GitHub actions and command instruments could come later, if the owner wants them.

Cost: the largest. About 250 lines in rep.mjs (pairing, sealing for the phone, checking decisions), 150 in server.mjs (device tokens, the mailbox, the event, CORS for one origin), a phone page of about 400 lines, and a static host. It would also serve #129: Waiting for you could show on every machine of one Oby through the same mailbox.

## Option C: buttons in Slack, through your own Slack app

- **Setup.** You make a Slack app from a manifest the project provides, with [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode) on, and install it in your workspace. Its two tokens (the bot token, and the app-level token, `xapp-…`) and your Slack user id go in your settings; they're never sent to the Sphere.
- **No public address.** Your representative calls [`apps.connections.open`](https://docs.slack.dev/reference/methods/apps.connections.open) with the app-level token in a header, and opens the WebSocket it returns (Node 22 has `WebSocket` built in, [no longer experimental since 22.4](https://nodejs.org/docs/latest-v22.x/api/globals.html)).
- **When an ask waits,** it posts to your direct messages with **Let it answer**, **Decline** and **Write an answer**. A click comes back over the socket as [`block_actions`](https://docs.slack.dev/reference/interaction-payloads/block_actions-payload); **Write an answer** opens a modal ([`views.open`](https://docs.slack.dev/reference/methods/views.open)), and the text comes back as `view_submission`. Your representative acknowledges each envelope, checks that you're the one who clicked, and that the ask still waits, then calls `decidePending()`. As in A, there's no **Let it answer with everything you allow**, and GitHub actions and command instruments get no buttons.

Security and privacy:

- Slack's authenticated connection says who clicked: there's nothing to forge without your Slack account. A stolen phone with Slack signed in can decide.
- Slack, and your workspace, keep what you send it (the summary by default).
- The relay isn't involved, and neither are members or someone with the join key. The tokens stay in `settings.json` (0600) and travel only in `Authorization` headers. Whoever gets that file (a stolen computer) can act as your Slack app.
- Replay: one decision per ask, as above.

Cost: about 250 lines in rep.mjs (a Socket Mode client, the messages and the modal). Each person needs their own Slack app; some workspaces need an admin to approve it, and Socket Mode apps aren't allowed in the Slack Marketplace. The Sphere-wide Slack app ([#131](https://github.com/obi-ai-bot/oby-sphere/issues/131)) puts a Slack token on the relay and sends no words; this one keeps the tokens on your machine, and its buttons reach only your own Oby.

## Recommendation

**A first, off by default; B next, if people want to write answers from the phone; C only for teams that live in Slack.** A uses what 0.3.0 already sends, needs no relay change and no new host, and covers the common case: yes or no, on the train. Its risk is bounded: whoever can read your topic can press, for one ask, for an hour, and only *answer* or *decline*; the same secret already guards the notification itself. B is the complete answer, writing included, and the only one where a key that only your own devices hold (the passkey) signs each decision; it's also the most work, and it needs a page host.

**The first step: ntfy buttons for *answer* and *decline*.** One PR, on top of 0.3.0's notifications:

- rep.mjs, a new `// ===== phone decisions` section, with one-line hooks in `notifyNote()` (keep the pending id on a note for one ask), `notifySend()` (the `Actions` header on such a `waiting` note) and `addPending()` (start listening to the reply topic).
- Settings: `notify.phone.decide`, `false` by default, checked like the rest. The reply topic and `k` live in the profile, 0600.
- Docs: SETTINGS.md (notifications), SECURITY.md (who can press), README.
- Tests, in `test/phone-decisions.test.mjs`, with a fake ntfy server on 127.0.0.1 that records posts and streams a topic, and `test/fake-runtimes.mjs` first on PATH:
  - a waiting ask's notification carries two `http` actions to the reply topic, and no words of the ask when the content is `summary`;
  - posting the *answer* code makes the Oby answer; the *decline* code declines;
  - a code with a wrong `mac`, another ask's id, a changed decision or a past `exp` does nothing;
  - a second press after a decision does nothing, and the console's later decision is refused (409, or 404 once the ask no longer waits);
  - two asks that wait within the same few seconds get one notification, with no buttons;
  - no `trust` or `write` code is ever made, and GitHub actions and command instruments get no buttons;
  - with `decide` off, there are no buttons and no listening; listening stops when nothing waits.

## Questions for the owner

1. Is it acceptable that whoever reads your ntfy topic can let your Oby answer, or decline, an ask that waits, for up to an hour? Or should deciding from the phone wait for B?
2. With the summary, you'd let your Oby answer without seeing the ask. Is that fine, or should the buttons come only with the full text (which sends the words to ntfy)?
3. Should a phone ever be able to give "everything you allow", approve a pull request, or run a command instrument?
4. For B: may the project publish a phone page at an address of its own (a domain, or a GitHub account just for it), with every relay allowing it through CORS?
5. For B: is it fine to require a phone with passkeys, unlocked (face, fingerprint or passcode) for each decision?
6. For C: are per-person Slack apps realistic in the workspaces you have in mind, or do admins block app installs?
7. Should an ask wait longer than an hour when a phone is set up?
