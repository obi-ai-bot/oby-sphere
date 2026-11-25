# A Slack app for the whole Sphere

Design note for [#131](https://github.com/obi-ai-bot/oby-sphere/issues/131). Status: a proposal, written 2026-11-25. No code yet.

## The problem

Sam's Oby asks Alice's Oby something that needs Alice. Her laptop is closed, so her Oby is offline, and nothing tells her. When she opens it an hour later, the ask has been waiting all that time.

In 0.3.0 her Oby can post to Slack, but only through an incoming webhook she makes herself, in a Slack app she creates herself, and only while her laptop is awake. Most people in a team won't set that up. A Sphere-wide app makes it one step for the whole team: an admin installs it once, each member links their Slack user, and the relay sends a direct message with no content in it: "Sam's Oby asked your Oby something. Open your console."

## Today

**On main**, the only notification is `serve --notify` (`macNotify()` in `rep.mjs`, called from `startRep()`, macOS only). The relay calls nothing outside itself but Upstash (`redisFetch()` in `redisStore()`). It knows each message's metadata (who, to whom, kind, channel, when) and each member's presence (`store.counts()`: is its representative online, is its owner in a session), never sealed words.

**In 0.3.0** (read from the `wave3/*-r` branches):

- **Notifications start on the owner's machine** (`notifyOwner()` and `notifyDispatch()` in `rep.mjs`): desktop, console, Claude Code, phone (an ntfy topic) and Slack (your own incoming webhook), for `waiting`, `asked`, `direct`, `mention`, `answered` and `failed`, with quiet hours, summary by default. The webhook address stays in `settings.json` (0600) and never reaches the relay. So nothing reaches you while your machine is off or asleep, and Slack takes setup from each person.
- **`obysphere start`** runs your Oby as a background service, online whenever your computer is awake. What's left is the closed laptop.
- **Admins are members** (`S.admins`, `POST /api/admin/claim`, audited `role` events). **Channels** get `kind: public | private | dm`, and `POST /api/dm` opens a direct conversation. A bot (`join --bot`) has no person to notify. Custom instruments change nothing here.

## What options A and B share

### The app

Each Sphere's admin makes the app in their own workspace, from a manifest the console's Admin page shows with the Sphere's address filled in:

```yaml
display_information: { name: Obysphere }
features:
  bot_user: { display_name: Obysphere }
  app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: true }
  slash_commands:
    - { command: /oby, url: "https://<your sphere>/api/slack/command",
        description: "Link your Slack user to your Oby", usage_hint: "link <code> | unlink | status" }
oauth_config:
  scopes: { bot: [chat:write, commands] }
```

They install it from the app's own settings page and copy two values to the relay: the bot token (`xoxb-…`) and the signing secret. In a workspace that restricts apps, a workspace admin approves the install first. There's no OAuth redirect, no client secret on the relay, and nothing in a URL. Two scopes only:

- `chat:write`: post to a member's DM with the app, by passing their Slack user id as `channel`.
- `commands`: the `/oby` command.

The app can't read channels, messages or the member list.

Where the two secrets live:

| Store | Where | Never |
|---|---|---|
| fs (Docker, Railway, plain Node) | `SPHERE_SLACK_BOT_TOKEN` and `SPHERE_SLACK_SIGNING_SECRET` in the environment | in `sphere.json`, `keys.txt`, logs, the audit log or any response |
| Redis (Vercel) | the same two, as Vercel Sensitive environment variables | in the Redis log, where anyone who reads the Upstash database would read them |

At start, the relay calls `auth.test` once to learn its workspace (`team_id`) and its bot user. A later step could let an admin paste the two values in the console (`POST /api/admin/slack`), stored encrypted under a key derived from the admin key, the way the audit chain's key already is (`useAdminKey()`). Not in the first step.

### Linking: proving a Slack user is that member

1. Alice clicks **Link Slack** in her console (or runs `obysphere slack link`). Her Oby calls `POST /api/slack/link` with its token. The relay answers a one-time code such as `OBY-7K2M-Q9XD` (40 random bits). It's valid 10 minutes and used once, and the relay keeps only its hash, with Alice's agent id: in memory on fs, and as a Redis key with a 10-minute expiry on Vercel, so any instance can take it.
2. In Slack, Alice types `/oby link OBY-7K2M-Q9XD`. Slack sends the relay a form post with `team_id`, `user_id` and the text, signed with the signing secret.
3. The relay checks the signature (HMAC-SHA256 over `v0:<timestamp>:<raw body>`, compared in constant time, the timestamp within 5 minutes), checks that `team_id` is its workspace, and takes the code. A bad signature counts as a failed credential, like a wrong key (`authFailed()`). It keeps only `team_id` and `user_id` from the form, stores `agent → { user, linkedAt }` through `apply()` (a `slack-link` op), audits a `slack` event ("alice linked Slack", with no Slack id), and answers privately: "Linked to alice's Oby in Our Sphere." Slack waits 3 seconds for that answer. A cold Vercel instance that is still reading its log may miss it: Slack then shows a timeout, and the relay confirms through the command's `response_url` (Slack takes up to 5 answers there within 30 minutes).

Both halves are needed: Slack vouches for who typed the command, and only Alice's token could have got the code. After five wrong codes in 10 minutes, a Slack user gets no more tries until the 10 minutes are up. Linking to another Slack user tells the old one, in a DM, that the link moved.

Sign in with Slack (OpenID Connect) would prove the same, but needs a client secret on the relay, a `nonce`, and an authorization code that comes back in a URL. The slash command needs none of that.

### Revocation

- **Alice:** `/oby unlink` in Slack, or **Unlink** in her console (`DELETE /api/slack/link`).
- **An admin:** unlinks any member (`DELETE /api/admin/agents/:id/slack`). Removing a member drops its link: one line in `apply()`, where an `agent` op marks it removed.
- **Slack:** when a send fails with `invalid_auth`, `account_inactive` or `token_revoked`, the relay stops sending, and admins see "The Slack app's token no longer works" in the console. A Slack user it can no longer reach (`channel_not_found`) is unlinked after three failures.
- **At once:** a workspace admin removes the app in Slack, or the Sphere's admin removes the two variables.

## Options

### A. The relay sends what it can see

**How it works.** A new `// ===== slack` section in `server.mjs`, with one-line hooks after a message is committed and where a member is removed. The relay sends a DM (`chat.postMessage` with `channel` set to the member's Slack user id, `unfurl_links: false`, `unfurl_media: false`) for two things it can see in metadata alone:

- An ask to a linked member whose representative is offline (`store.counts(id).rep === 0`), or that is still unclaimed a minute later (below): "Sam's Oby asked your Oby something, and your Oby is offline. Start it, or open your console."
- A post to a linked member in a direct conversation (0.3.0's `kind: 'dm'`), while that member has no console or session open: "Sam wrote to you. Open your console."

**Offline, as the relay sees it.** The presence count alone lags a closed lid. The relay drops a stream only when its connection closes, and a sleeping laptop doesn't close it: on fs it can look online for minutes, until TCP gives up; on Vercel, until the stream's time limit (280 s) ends it. So the relay also sends when an ask is still unclaimed (`claimedAt` unset) a minute after it was sent. An online representative claims an ask within seconds of getting it (`handle()` in `startRep()`), before it waits for its owner, so this never fires for an ask that waits for you. On fs a timer checks. On Redis, each instance checks in its sync loop, which runs while the asker long-polls for the reply (best effort).

The templates are fixed in the code. They hold only handles and the Sphere's name: never words, file names or links. Each member gets at most one DM per 10 minutes; the first one already sends them to their console, which shows the rest. The mark that a DM was sent is a key that expires after 10 minutes and is set only if absent (`SET … NX PX 600000` on Redis, a map in memory on fs), so only one instance sends, and nothing about it is added to the Redis log, which is never compacted. On Vercel, the send is awaited right after the commit, with a 2-second timeout, so the function isn't frozen mid-send; a failed send never fails the ask.

While the representative is online and takes the ask, the relay stays quiet: the Oby answers by itself, or the ask waits for its owner and 0.3.0's notifications tell them from their own machine. So for asks, the two never overlap.

**Security and privacy.**

- **Sealed words** never go to Slack: the relay doesn't have them. In an unsealed Sphere the templates still never quote anything.
- **Keys and tokens.** The bot token goes only in an `Authorization: Bearer` header to `slack.com`. The signing secret only keys an HMAC. The link code travels in Slack's request body, not a URL, and is worthless after one use or 10 minutes.
- **What the relay learns:** each linked member's Slack user id, and the workspace id. The map is never in `GET /api/agents`, the audit log or a viewer's stream. A member sees `me.slack: { linked }`; an admin sees who has linked, not as whom.
- **What Slack learns:** which of its users have an Oby in this Sphere; when each one is asked or written to, and by whom (the handles in the template); when each one's Oby is offline (the DM says so); the Sphere's name and address (the command's URL). Not the words, the files, the channels or anyone's console address. Slack keeps these DMs as the workspace's retention says, and on Business+ and Enterprise plans the workspace's owners can apply to export DMs, so they can learn the same.
- **Someone with the join key** can join and link a Slack user, but only one in the same workspace. They can't read the map.
- **A stolen device.** The token in the profile can unlink, or link the thief's own Slack user (if they're in the workspace) and so learn when the victim is asked. The old Slack user is told the link moved. That token can already do far more.
- **A malicious relay operator** holds the bot token, so can DM anyone in the workspace as the app: a phishing risk. With these two scopes it can't read Slack messages or list users. Workspace admins see the app and its scopes, and can remove it. A rule members can learn: a real Obysphere DM never has a link.
- **A malicious member** can make a linked member's Slack buzz by asking while their Oby is offline, bounded by the 10-minute window and the existing asks-per-minute limit. Their handle is the one thing of theirs the app's DM carries. Handles are only a-z, 0-9 and dashes, so it can't hold a link or a mention, but it can still read like a lure (`it-helpdesk`). They could talk someone into typing their code, but the reply names whose Oby it links, so it shows.

**Cost.** About 250 to 300 lines in `server.mjs`: the configuration, `auth.test`, one `fetch` to Slack, the signature check and form parsing (`URLSearchParams`), the codes, the one-minute check, two `apply()` ops (link and unlink) and two hooks. About 50 lines in `rep.mjs` for `slack link|unlink|status`, and about 100 in the console (a Slack line in Settings › Notifications, the manifest on the Admin page). No dependencies. The Sphere needs a public HTTPS address for the command, so a Sphere on `localhost` can't link (Socket Mode would need an app-level token and a WebSocket held open, which Vercel can't do). Slack's free plan allows 10 apps per workspace; this uses one.

### B. Your Oby decides, the relay delivers

**How it works.** The same app, token and linking, but the relay sends nothing on its own. 0.3.0's notifications get one more way, `slackApp`: when `notifyDispatch()` fires, your representative calls `POST /api/slack/notify { type, ref, count }`. The relay checks that you're linked, that `type` is one of the six events, that `ref` is a message you're in, and that you call at most once a minute. Then it builds the DM from its own template and its own metadata (the `from` of `ref`). It never takes words from the call.

**Security and privacy.** As in A, plus: your own settings decide (events, quiet hours), and `waiting` and `failed` become possible, since only your machine knows them. The relay learns one new thing: which asks wait for you, a hint about your access settings beyond the `declared.approve` it has today. A compromised representative can only send its own owner the fixed templates.

**Cost.** About 120 lines in `server.mjs` and 40 in the notifications section of `rep.mjs`. But it sends nothing while your machine is off, which is the gap this issue is about.

### C. One app, your own webhook

**How it works.** The admin's app asks for `incoming-webhook` instead of a bot, and the relay holds its client id and client secret. A member clicks **Add to Slack**, picks a channel, and Slack sends them back to `https://<your sphere>/api/slack/oauth?code=…&state=…`. The relay trades the code (`oauth.v2.access`) for `incoming_webhook.url`, seals that address for the member's representative, and forgets it. From then on it's 0.3.0's personal Slack way.

**Security and privacy.** No bot token on the relay, and the words can go to Slack if you choose. But an authorization code comes back in a URL (short-lived and worthless without the client secret, still a credential in a URL), and a malicious operator could keep the webhook addresses it hands over. Slack documents webhooks for channels, not DMs, so each member likely needs a channel of their own.

**Cost.** About 150 lines on the relay, a setup flow in the console, and a client secret to keep. Like B, it sends nothing while the machine is off.

## Recommendation

**A.** It's the only option that reaches someone whose laptop is closed, it keeps every word on members' machines, and for asks it never doubles 0.3.0's notifications. The two sit side by side: the Sphere's app covers the time your machine is away, and your own webhook (if you set one) covers the rest, with the words if you want them and the events only your machine knows. Only a direct message could reach you both ways, while your Oby is online but your console is closed (question 4). Add B's `POST /api/slack/notify` later, if members want `waiting` in Slack through the shared app. Leave C.

## First step

One PR: **the app, linking, and a DM for an ask while your Oby is offline**, configured by environment variables only.

- `server.mjs`: the `// ===== slack` section; `POST /api/slack/link`, `DELETE /api/slack/link`, `POST /api/slack/command` (`link`, `unlink`, `status`); the ask hook; removal drops the link; `me.slack` in `GET /api/info`. `SPHERE_SLACK_API` (a loopback address only, for tests) points it at a fake Slack.
- `rep.mjs`: `slack link|unlink|status`, in a section of its own.
- Docs: API.md (the endpoints and the manifest), SECURITY.md (what Slack and the relay learn), a paragraph in README.md, and `changes/slack.md`.
- Tests in `test/slack.test.mjs`, with `test/fake-slack.mjs` (a local server answering `auth.test` and `chat.postMessage`), on both stores:
  - A good signature passes. A wrong secret, a changed body, and a timestamp 6 minutes old are refused.
  - A code works once, is gone after 10 minutes, and is refused from another workspace; after five wrong tries, even the right code is refused.
  - An ask to a linked member whose representative is offline sends one DM; while it's online and claims the ask, none; an ask still unclaimed after the minute (shortened for tests) while it looks online, one; ten asks in a minute, one, also from two Redis instances at once.
  - In a sealed and in an unsealed Sphere, the ask's words appear nowhere in what the fake Slack received.
  - The token appears in no response, audit event or log line.
  - Unlinking, removing the member, and a `token_revoked` answer each stop the DMs.

DMs for direct conversations come in a second PR, once 0.3.0's channels are on main.

## Questions for the owner

1. Should the DM name who asks ("Sam's Oby asked…"), which tells Slack who talks to whom, or only say "Your Oby has a new ask"?
2. One app per Sphere, made by its own admin (no accounts for the project), or one published app the project runs? The second needs a Slack developer account, a central server holding every workspace's token, and Slack's review.
3. Is "while your Oby is offline, and direct messages" the right line? Or should the Sphere's app also carry `waiting` from the owner's machine (B)?
4. When someone has both the app and their own webhook, should a direct message notify through both?
5. Should admins see which members have linked Slack?
6. Enterprise Grid (one install across an organization): now, or when someone asks?

## Sources

- Slack: [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage) (posting to a user id, `unfurl_links`, errors, about one message a second per channel), [verifying requests from Slack](https://docs.slack.dev/authentication/verifying-requests-from-slack), [slash commands](https://docs.slack.dev/interactivity/implementing-slash-commands) (form fields, the 3-second reply), [the `commands` scope](https://docs.slack.dev/reference/scopes/commands), [app manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests) and [their reference](https://docs.slack.dev/reference/app-manifest).
- Slack: [`response_url`](https://docs.slack.dev/interactivity/handling-user-interaction) (5 answers within 30 minutes), [exporting workspace data](https://slack.com/help/articles/201658943) (DMs on Business+ and Enterprise).
- Slack: [installing with OAuth](https://docs.slack.dev/authentication/installing-with-oauth) (the code in the redirect, its 10 minutes, HTTPS redirects), [token rotation](https://docs.slack.dev/authentication/using-token-rotation), [`app_uninstalled`](https://docs.slack.dev/reference/events/app_uninstalled), [Sign in with Slack](https://docs.slack.dev/authentication/sign-in-with-slack), [incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks), [free plan limits](https://slack.com/help/articles/115002422943) (10 apps).
