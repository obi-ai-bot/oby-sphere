# Per-person invites and sign-in

A design note for [#127](https://github.com/obi-ai-bot/oby-sphere/issues/127), which continues the identity part of #60. Nothing here is built yet.

## The problem

To bring Alice in, an admin sends her the Sphere's invite link. That link holds the one join key everyone joined with. Whoever sees it (a forwarded email, a chat log, a screenshot, the AI agent Alice pasted it into) can join under any handle and any name, and can watch the Sphere. Nothing records who a link was for. The only way to stop a leaked link is to rotate the key, and that breaks every link not used yet. A company that already knows its people through Google or another sign-in can't use that to let them in.

## Today

**On main (0.2):**

- **One key opens two doors.** `POST /api/join` in `route()` (server.mjs) checks `x-sphere-key` (or `key` in the body) against `S.sphere.keyHash` with `secretOk()`, limits joins per address (`joinsPerMinPerIp`, 20 a minute), and counts wrong keys through `joinRefused()`. The same key makes the caller a `viewer` of every `GET`, the stream and the files.
- **What joiners say about themselves is theirs.** The handle is first come, first served (`nameIndex`, `tombstones`). `owner` and `about` are what the joiner typed (`cleanLine()`), fixed after join (`POST /api/me` refuses to change them). The audit says "alice joined, representing Alice", in the joiner's own words.
- **Rotating is all-or-nothing.** `POST /api/admin/rotate-key` makes a new key, and the `sphere` op in `apply()` closes viewer streams on the old one. Members keep their tokens.
- **The link goes on the command line.** `join()` in rep.mjs takes the link as an argument (`pos[0]`), reads `#key=` from the fragment (or `?key=`, or `--key`), and sends it in `x-sphere-key`. While it runs, the key is in the process list and the shell history: a gap against "no keys in argv" that goes unnoticed only because the key is shared anyway.

**What 0.3.0 adds that matters** (being built now):

- **Admins are members**: `S.admins`, `POST /api/admin/claim`, `POST /api/admin/agents/:id/role`, and every `/api/admin/*` route takes an admin member's own token. So an admin can make invites from their own console, with no admin key in a browser, and the audit names them (`· by bob`).
- **Bots and private channels**: `bot: true`, set at join (`join --bot`) and fixed after. Someone holding only the join key sees public channels only.
- **Invite member for AI agents**: one text, with the real join key in it, that the teammate pastes into Claude Code, Codex or Cursor. `join` keeps the link in `profile.json` (0600), and the console reads it from `GET /local/invite`. Convenient, and it makes the problem sharper: the shared key now travels through AI chat transcripts.
- **The `obysphere` CLI**: `obysphere join "<invite link>"` hands the link to `rep.mjs join` as an argument.
- The admins' Policy page keeps a "Join key" row with **Rotate join key**. Invites belong beside it.

## Option A: invites made for one person, on the relay

**How it works.**

- **Making one.** An admin calls `POST /api/admin/invites {handle, owner?, bot?, admin?, hold?, expiresIn?, note?}` with their own token (or the admin key). The relay checks the handle is free (`nameIndex`, `tombstones`, other open invites), makes an id (`inv_` and 12 random characters) and a secret (24 random bytes), and returns the link once: `https://<sphere>/#invite=inv_….<secret>`.
- **What the relay keeps.** `{id, secretHash, handle, owner, bot, admin, createdBy, createdAt, expiresAt, usedAt, usedBy, revokedAt, note}`, as an `invite` operation through `apply()`, so both stores keep it (fs: `sphere.json`; Redis: the log). Never the secret.
- **Joining.** `POST /api/join` with `x-sphere-invite: inv_….<secret>`. Inside `store.commit()` the relay checks the invite exists, the secret matches (`secretOk()`, constant time), it isn't used, revoked or expired, and the handle is the invite's. Then it pushes the `agent` op and the invite's "used" op in one commit. On Redis, the compare-and-append (`APPEND_LUA`) makes that first-wins across instances, as claims already are, so an invite can't be used twice. The `owner` is the admin's words, and the audit says "alice joined with an invite from bob".
- **Managing them.** `GET /api/admin/invites` lists them, never with a secret. `DELETE /api/admin/invites/:id` revokes one. Both are audited (`invite`). Wrong invite secrets count like wrong keys (`authFailed()`, rate-limited per address).
- **Roles at join.** `admin: true` makes the new member an admin in the same commit (a `role` op), so later admins never need the admin key. `bot: true` makes a bot.
- **The shared key.** A new policy field, `join: "key" | "invites"`, the admins' switch (audited). With `invites`, joining with the join key is refused (`invite_required`), but the key still opens the read-only page. A later `off` would close that too.
- **rep.mjs** reads `#invite=` links as it reads `#key=` ones, from a prompt that doesn't echo, from stdin, or from `OBYSPHERE_INVITE`, never as an argument. A `#key=` link as an argument keeps working for now, with a warning, and goes when the shared key goes. A spent invite isn't kept.
- **The console.** An admin page lists invites (for whom, by whom, expiry, used, **Revoke**) with **New invite**. Invite member makes a fresh invite when you're an admin and puts it in the text for the AI agent, instead of the shared key, with the join command reading it from stdin. Anyone else sees "Ask an admin for an invite".

**Security and privacy.**

- **An invite isn't a viewer credential.** Before use it can only join, once, as that handle, before it expires. After use it's worthless, so pasting it into an AI chat or an email leaks nothing that lasts.
- **Never in a URL the server sees.** The secret sits in the fragment (browsers don't send it) and travels in a header. The relay keeps only its hash, and the audit never holds it.
- **Someone who gets the link first** joins as Alice. Alice's own join then fails ("this invite was already used"), she tells the admin, who removes the impostor and sends a new invite. Short expiries narrow the window. An invite with `hold: true` makes the new member start suspended until an admin resumes it, with the `suspended` state that exists today.
- **Someone with the join key** can still watch, but not join, once the policy says `invites`.
- **A stolen device** holds a member token, as today. Under `invites` it no longer lets anyone else join, though in 0.3.0 its `profile.json` keeps the join key. A stolen admin's device can make invites, `admin: true` ones too, and the members they make outlast the device. So when an admin loses one, the other admins revoke its open invites and check who joined through it: every invite and join is audited, with who made it.
- **A malicious relay operator** can still make members without invites: membership is the relay's word, as today, and representatives still pin keys on first sight. (Later, the inviting admin's Oby could sign the new member's id, handle and keys, for other representatives to check against the admin's pinned key: that would narrow "the first key exchange" in SECURITY.md.)
- **A malicious member** can't invite unless admins let members invite.
- **What the relay learns:** who invited whom, when, the handle and name the admin typed, and when the invite was used. Nothing about what members say.

**Cost.** About 150 lines in server.mjs (the op, four routes, the join check, the switch), 30 in rep.mjs and 150 in the console. No new hosting, no outbound calls, no dependencies.

## Option B: sign-in with an OpenID Connect provider, checked by the relay

For a company's Sphere: "anyone with a verified example.com account may join", or "this invite needs Alice's own account".

**How it works.**

- **Setup.** The operator registers an OAuth client with their provider (Google, or any OpenID Connect issuer, their company's own included) and sets `SPHERE_SIGNIN` to `[{id, name, issuer, clientId, clientSecret?, domains?}]` (`clientSecret` only for a client that can't keep one, below). `GET /api/signin` lists them: public data.
- **The person's own machine gets the ID token, not the relay.** `rep.mjs join` signs in as a native app ([RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)). It asks the relay for a ticket (`POST /api/signin/ticket`) and makes the nonce itself: `SHA-256("obysphere/signin/v1" ‖ the origin of the Sphere it's joining ‖ ticket)`. It listens on `http://127.0.0.1:<random port>/`, and opens the provider's page with `state`, a PKCE challenge (S256, [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)) and that nonce. The browser comes back to that address with the code, rep.mjs checks `state` (and `iss`, when sent, [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207)), and exchanges the code and its verifier for the ID token. On a machine with no browser (a team's server, #135) it can use the device flow ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)): "open this page and type ABCD-EFGH". That flow carries no nonce (Google's device request takes only `client_id` and `scope`, [Google docs](https://developers.google.com/identity/protocols/oauth2/limited-input-device)), so its ID token isn't bound to this Sphere: see below.
- **So the code does arrive in a URL query**, but only at the person's own loopback address, never at the relay or its logs, and with PKCE it's useless without the verifier, which never leaves rep.mjs. The ID token goes to the relay in a header (`x-sphere-id-token`) with the join.
- **The relay checks the ID token** as [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation) says, with `node:crypto` alone ([Node's crypto docs](https://nodejs.org/api/crypto.html)):
  - the header's `alg` is one the issuer lists (Google: RS256 only), never `none` or HS256;
  - the key comes by `kid` from the issuer's JWKS, imported with `crypto.createPublicKey({ key: jwk, format: 'jwk' })` and checked with `crypto.verify()`;
  - `iss` matches exactly, `aud` (and `azp`) is the client id, `exp` is still ahead and `iat` at most five minutes old, with a minute's leeway for clocks;
  - `nonce` is the hash above, made with this Sphere's own origin and a ticket this relay made (a random value and its time, with an HMAC under a key derived from the admin key, as the audit key is), under ten minutes old and not used before; the join's commit marks it used. A device-flow token has no nonce: the relay takes one only when the client is this Sphere's own, and marks the token's hash used until it expires;
  - `email_verified` is true, and `hd` is among `domains` when they're set. Google sends `hd` only for accounts in a Google Workspace or Cloud organization ([Google docs](https://developers.google.com/identity/openid-connect/openid-connect)). The email's own domain proves nothing, since a personal Google account can have a verified address at any domain. Other providers name the organization with their own claim (Microsoft Entra: `tid`).
  The JWKS and discovery document are cached as their HTTP headers say, and fetched again for an unknown `kid` at most once a minute, as the v0.1 server did (`server/src/signin.ts` at the `legacy/sphere-v0.1` tag).
- **Who the member is.** `iss` and `sub`, which don't change, not the email, which can (Google's docs say not to use it as an id). The relay keeps a hash of `iss|sub` and the domain. Whether it also keeps the email, for admins to see, is the owner's choice.
- **State on Vercel.** A ticket needs no state: any instance checks the HMAC. Only used ones are kept, in the join's commit to the Redis log, so any instance can refuse a second use, and asking for tickets can't grow the log (which isn't compacted on Redis yet). Tickets are rate-limited per address all the same.
- **With invites.** An invite may carry `signin: {provider, email?}` (only Alice's account opens it), or be a domain invite: `{provider, domain, uses, expiresAt}`, many uses, no handle fixed, one person's Oby per account.

**Security and privacy.**

- No code or token reaches the relay in a URL. An ID token grants nothing at the provider. Bound to a fresh nonce used once, a stolen one can't be replayed here.
- **Another Sphere's operator.** `aud` names the client, not the Sphere. So when one client serves many Spheres (owner question 3), a Sphere that receives Alice's ID token could replay it to another Sphere and join there as her. The nonce stops this for the loopback flow, because rep.mjs hashes in the origin of the Sphere it's joining, never what the relay says. The device flow has no nonce, so it needs a client of the Sphere's own.
- **Someone with the join key** can't join, once joining needs a sign-in, without an account the Sphere accepts.
- **A stolen device** holds a member token, as today. Sign-in later lets a person rejoin from a new computer and keep their handle (#128), with peers warned about the new keys.
- **A malicious relay operator** runs the client and the check, so it can still let anyone in. It also learns members' verified accounts (at least their domain), which a sealed Sphere otherwise keeps from it. Sealed words stay sealed: sign-in only decides who joins. Representatives can't check a sign-in themselves unless the relay passes the ID token on, which would show every member's email to every other: not proposed.
- **GitHub doesn't fit here.** GitHub's sign-in for people is OAuth 2.0 with no ID token ([GitHub docs](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps); `github.com/.well-known/openid-configuration` answers 404). Its OpenID Connect issuer is for Actions workflows only ([GitHub docs](https://docs.github.com/en/actions/concepts/security/openid-connect)). Using GitHub means the relay receives a GitHub access token and calls the API with it: Option C.
- **What Google needs.** A "Desktop app" client for the loopback flow: Google calls these public clients that can't keep a secret, and makes the secret optional when the code is exchanged ([Google docs](https://developers.google.com/identity/protocols/oauth2/native-app)). Or a "TVs and Limited Input devices" client for the device flow, which returns an ID token ([Google docs](https://developers.google.com/identity/gsi/web/guides/devices)); its secret is sent when polling, so `GET /api/signin` would list it, and it is no secret. Google's [discovery document](https://accounts.google.com/.well-known/openid-configuration) lists S256 PKCE, the device grant and RS256.

**Cost.** About 300 lines in server.mjs (the JWT and JWKS check is about 120; then providers, tickets and the join path) and 200 in rep.mjs (the loopback listener, PKCE, the token exchange, the device flow), with `node:crypto` and `fetch` only. The relay makes outbound HTTPS calls to the issuer (one JWKS fetch per cold instance on Vercel). Each operator registers an OAuth client.

## Option C: the relay runs the web sign-in

The relay is a confidential OAuth client, with a client secret in its environment. The person opens `https://<sphere>/api/signin/google/start`; the provider sends them back to `/api/signin/google/callback`; the relay exchanges the code and checks the ID token (or, for GitHub, calls `GET /user` and `GET /user/orgs` with the access token and drops it), and marks the flow done in the log. `rep.mjs join`, polling with a secret only it holds, then collects a one-time join grant.

**For:** it works from a browser alone, and it covers GitHub.

**Security and privacy.**

- **Codes in URLs.** The code comes to the relay in a URL query wherever the provider doesn't post it back (`form_post`, which Google lists and GitHub doesn't). There it lands in browser history and in the platform's and proxies' request logs ([RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html), sections 3 and 4.3.1). PKCE and single-use codes limit the harm, but "no keys in URLs" bends.
- **Secrets on the relay.** The relay holds a client secret, and for GitHub a person's access token (with `read:org`, to see private org membership). A GitHub OAuth app's token lasts until it's revoked or goes unused for a year ([GitHub docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation)).
- **A malicious relay operator** can let anyone in, as in B, and can also keep people's GitHub tokens and use them. In A and B the relay never holds a token that works at the provider.
- **Someone with the join key** and **a stolen device**: as in B.
- **A malicious member** can send people a copy of the sign-in page: a page in the middle of a sign-in is what phishing copies.
- **What the relay learns:** as in B, plus, for GitHub, each person's organizations.

**Cost.** The most code: about 450 lines, and a page. The flow's state must live in the Redis log for Vercel's many instances.

## Recommendation

Build **A** first. It fixes the problem as people meet it (a leaked link stops being a lasting key) and needs no outside service. Then **B**, as a condition an invite can carry and as domain invites, for companies. Leave **C** aside, and GitHub with it, unless GitHub sign-in matters more than keeping codes and tokens off the relay.

**The first step (one PR): per-person invites and the `join: "invites"` switch.**

- server.mjs: a `// ===== invites` section (the `invite` op, `POST` and `GET /api/admin/invites`, `DELETE /api/admin/invites/:id`, the check in `POST /api/join`, the policy field), with one-line hooks in `apply()`, the fs snapshot and `route()`.
- rep.mjs: `#invite=` links, from a prompt, stdin or `OBYSPHERE_INVITE`.
- The console: the invites list and **New invite** on the admin page; Invite member uses a fresh invite when you're an admin.
- API.md, SECURITY.md, README.md and `changes/invites.md`.
- `test/invites.test.mjs` checks:
  - an admin member and the admin key make invites; a member who isn't an admin gets 403;
  - only the hash is stored, and the secret appears in no response but the first, in no list and in no audit event;
  - an invite joins once; a second use is refused; two joins at once on the fake Upstash make one member;
  - expired, revoked and wrong-secret invites are refused, and wrong secrets are rate-limited and audited;
  - the handle is the invite's, and `admin` and `bot` carry over;
  - with `join: "invites"`, the join key no longer joins but still watches;
  - invites survive a restart on both stores;
  - `rep.mjs join` takes the link on stdin, and refuses an invite link given as an argument.

## Questions for the owner

1. Once invites exist, what should a new Sphere do with the shared join key: keep joining, watch only, or off?
2. Who may invite: admins only, or every member (with a cap each)?
3. Which sign-in providers first: Google Workspace only, or Microsoft Entra and Okta too? And does each operator register their own OAuth client, or does the project run one shared client (an app identity the project owns and gets verified; it would work for the loopback sign-in, not the device flow)?
4. Is GitHub sign-in worth the relay holding people's GitHub tokens (Option C), or do we skip GitHub?
5. Should the relay keep members' verified emails for admins to see, or only the domain and a hash of the account?
6. How long should an invite last by default (a day? a week?), and should joins from invites wait for an admin's OK by default?
