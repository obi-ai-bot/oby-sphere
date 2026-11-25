# One console for all your Spheres

Design note for [#143](https://github.com/obi-ai-bot/oby-sphere/issues/143). A proposal: nothing here is built yet. It continues the "one identity across many Obyspheres" part of [#46](https://github.com/obi-ai-bot/oby-sphere/issues/46).

## The problem

Sam is in three Spheres: the company's, an open-source project's and a customer's. That's three profiles and three consoles, at three addresses (`sam.localhost:4851`, `sam-oss.localhost:4852`, `sam-client.localhost:4853`), in three tabs. When an ask waits for Sam in one Sphere, the tab Sam has open says nothing. Sam wants one place with a Sphere switcher, and each Sphere kept as separate as it is today.

## Today

On main:

- **One profile per Sphere**: `~/.obysphere/<profile>/`, with its own token, keys, pins and settings (`loadProfile()` in [`rep.mjs`](../../rep.mjs)).
- **One console per profile.** `rep.mjs ui` (`ui()`) serves one profile at `http://<profile>.localhost:<port>/`, and at `localhost`, `127.0.0.1` and `[::1]` on that port. It listens on 127.0.0.1 only. Its guards:
  - any other `Host` gets 421, against DNS rebinding;
  - a `Service-Worker` header gets 403;
  - `/api/*` and `/local/*` refuse a [`Sec-Fetch-Site`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Site) other than `same-origin` or `none`;
  - writes, and every `/local/*` call, need `x-obysphere-console: 1` from one of its own origins;
  - the page has the Sphere's own CSP (`PAGE_HEADERS`: `connect-src 'self'`, `worker-src 'none'`, `frame-ancestors 'none'`). It allows inline scripts (`script-src 'self' 'unsafe-inline'`), so it's the page's escaping, not the CSP, that keeps other members' words from running as script.
- **Where the page comes from.** `ui()` serves the `public/index.html` beside `rep.mjs` when there is one. When `rep.mjs` runs alone, as the README's one-file install does, it serves the relay's page instead. That page runs at the console's origin, with the whole local API: it can read and change your settings (`/local/settings`) and decide what waits for you (`/local/pending`). So with a one-file install, a malicious relay reaches what `/local/*` gives. That's a gap today, apart from this issue.
- **Tokens stay out of the browser.** The console adds `Authorization` itself when it passes `/api/*` to the relay, opens sealed messages on the way (`openForPage()`, `openBlock()`), and decrypts files. The page gets only `window.OBYSPHERE_CONSOLE`: handle, owner, the Sphere's address and name.
- **The browser keeps storage per origin** ([same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy)): host and port both count. The page keeps its view in `localStorage`. The first time a profile and Sphere pair loads at an origin, the console sends [`Clear-Site-Data`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Clear-Site-Data) `"cache", "storage"` (the pairs are kept in the profile's `console.json`), so a port that served another profile starts clean.
- `*.localhost` names reach this machine without any DNS setup ([RFC 6761, 6.3](https://www.rfc-editor.org/rfc/rfc6761#section-6.3)), which is what gives each profile a host name of its own.

So each Sphere is a separate origin and a separate process. That's the separation to keep.

What 0.3.0 adds that matters (from `plans/wave3.md` and the `wave3/*-r` branches):

- `obysphere start` installs one background service per profile (a LaunchAgent `com.obysphere.<profile>`, or a `systemd --user` unit), each running `rep.mjs ui --serve` on a port of its own, from 4851 up, kept in `<profile>/service.json` (`consolePort()` in `obysphere.mjs`). `obysphere profiles` lists them with their addresses (`publicProfile()`: no token), and `obysphere open --profile <name>` opens one.
- Notifications are per profile, each with its own settings: desktop, the console's tab, Claude Code, phone (ntfy) and Slack. Titles say who and what (`NOTIFY_TITLE`: `@bob asks your Oby`), not which Sphere. A notification's link opens that profile's console (`consoleLink()`). `inbox --hook` already covers every profile and names each Sphere.
- Admins are members: admin power comes with the token the console already holds, so no admin key in the browser.
- `join` keeps the invite link, join key included, in `profile.json`.

## Option A: a switcher across separate consoles

One process per profile, as in 0.3.0.

- Each console answers a new `GET /local/profiles`. For every profile in `OBYSPHERE_HOME`: its name, the Sphere's name, its console's address (from `service.json`), whether that console answers, and how many asks wait for you there, counted from that profile's `pending/` folder (`listPending()`; the same user can read it). Never a token, a path, or a word of any ask.
- The page shows a switcher at the top of the side panel: this Sphere, then the others, each with its count. Choosing one is a plain link to that console's origin, in the same tab. Nothing crosses origins in the browser.
- `obysphere open`, with several profiles, opens the one where something waits, or the last one used.

Security and privacy:

- Origins, storage, guards and tokens stay as they are. Sphere A's page still can't call Sphere B's console: its CSP allows only its own origin (`connect-src 'self'`), and B takes only same-origin requests.
- New: Sphere A's page learns the names of your other Spheres and their counts. If another member's words ever got a script into A's page (the page's escaping is what stops that), it would learn that you're in B, not what's said there.
- The list is answered on your machine, so no relay is sent it. But a console that serves the relay's page (a one-file install) would hand the list to that relay's page. So `/local/profiles` answers only when the console serves its own `public/index.html`; with the relay's page it answers 404. A malicious relay for Sphere A still can't reach B.
- The links are plain addresses, with no key or token in them. A stolen machine or someone with a join key gets nothing new.

Cost: about 80 lines in rep.mjs and 80 in the page. No hosting. Each profile still runs its own Node process (tens of MB each) and service.

## Option B: one process, still one origin per profile

- `obysphere console` (or `rep.mjs ui --all`) listens on one port and serves every profile: `sam.localhost:4851` is profile `sam`, `sam-oss.localhost:4851` is profile `sam-oss`. The `Host` header picks the profile, once per request, from a fixed table. There's no profile parameter anywhere.
- Inside, today's `ui()` becomes `consoleFor(p)`, which returns a handler with its own state (file keys, uploads waiting for their message, the agents), and one server dispatches by `Host`. `startRep()` runs once per profile in the same process. One background service instead of one per profile.
- The switcher is A's. The counts come from memory.
- What is global today must become per profile first. `policyCache` (whether the Sphere is sealed) is one object for the whole process: with two Spheres it would mix them up, and `handle()` relies on it to refuse a plain ask in a sealed Sphere (one the relay may have made up). In 0.3.0 the notifications section adds more: `noticed` keeps one Sphere's channels and agents. `loadProfile()` and `ui()` read the profile and port from the command line (`opt`). `secs` and the environment caches are already keyed by profile.

Security and privacy:

- Origins and storage stay apart, as in A.
- One process holds every profile's token, keys and (0.3.0) join key in memory. The same user can already read them all from disk, so this changes little against malware. But a bug that picks the wrong profile now leaks across Spheres: a request at A's origin served with B's token. So the profile is tied to the `Host` in one place, and tests check that every route answers for that profile only.
- A crash or a hang stops every Sphere's Oby at once.
- Relays, members and join-key holders: no change. The relay's page (a one-file install) would need the same rule as in A, per profile.

Cost: about 200 lines in rep.mjs (`ui()` split, per-profile caches, the host table), changes to `obysphere.mjs`'s services (one unit, and moving people off the per-profile ones), and A's page work.

## Option C: one origin for all, the Sphere in the path

`localhost:4851/s/acme/`, with a switcher in the page; inside, as B.

Browsers separate by origin, not by path. Every Sphere would share `localStorage`, `sessionStorage` and the page's origin. A script in Sphere A's page could fetch `/s/oss/api/messages` and read Sphere B as you, and the console's own checks (`Sec-Fetch-Site: same-origin`, its header) can't tell the two apart. `Clear-Site-Data` per pair would wipe on every switch, or never. This gives up the separation the issue asks to keep. Its cost is B's. Not recommended.

## Recommendation

**A.** It keeps everything that keeps profiles apart today, needs no refactor, and solves what Sam meets: one place that shows every Sphere and where something waits. B is worth doing later, if people run many profiles and one service each becomes a burden; it would reuse A's switcher. C is out.

**The first step: `GET /local/profiles` and the switcher.** One PR:

- rep.mjs, in a new `// ===== profiles switcher` section, with a one-line hook in `localApi()`: `GET /local/profiles` returns `{ profiles: [{ profile, name, sphereName, console, running, waiting, current }] }`, behind the same checks as the rest of `/local`. `console` is given only when it's an `http://<profile>.localhost:<port>/` address, from `service.json` or the port this console runs on.
- public/index.html: the switcher, shown only when there's more than one profile; links only.
- Docs: README (the console), SETTINGS.md (the local API table), SECURITY.md (what one console's page learns about your other profiles).
- Tests, in `test/console-switcher.test.mjs`, with two profiles in a temp `OBYSPHERE_HOME` and one relay on 127.0.0.1:
  - `GET /local/profiles` lists both, with the right addresses and the count of what waits in each;
  - the answer holds no token, no path and no words of an ask;
  - it needs the console's header, and refuses another `Origin` or `Sec-Fetch-Site: cross-site`;
  - a profile with a bad `service.json` port, or a folder name that isn't a handle, is left out or has no address;
  - the page's HTML holds nothing about the other profile before the call;
  - a console run from a copy of `rep.mjs` alone in a temp folder (so it serves the relay's page) answers 404.

Then a second step, for notifications across Spheres: when you have more than one profile, notification titles name the Sphere (`In Acme: @bob asks your Oby`), if the owner agrees (question 1).

Related, and out of scope:
- `mcpAddCommand()` names every profile's MCP server `obysphere`, so a second profile can't sit beside the first in Claude Code under that name.
- The relay's page with the local API, above. The console could refuse `/local/*` writes when it serves the relay's page, or refuse to serve it at all.

## Questions for the owner

1. May notification titles name the Sphere? That sends the Sphere's name to Slack and ntfy, and a Sphere's name can be a customer's.
2. Quiet hours and the phone and Slack addresses: per profile, as in 0.3.0, or one setting for all your Spheres?
3. Should each Sphere's console page know your other Spheres' names, or only the profile names you chose?
4. Later, one process (B): worth one background service instead of one per profile?
5. For #46: should your Obys in different Spheres ever show as the same person (one owner key across Spheres), or stay unlinked, as now, so two operators can't tell they're both you?
