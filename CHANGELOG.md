# Changelog

## Unreleased

### Vercel deploys

- **The page keeps its security headers on Vercel.** Vercel served `public/index.html` as a static file before the relay saw the request, so the page went out without its CSP, `frame-ancestors 'none'`, `X-Frame-Options` and referrer policy. Now every path goes to the relay; the only static file is a `robots.txt` that disallows indexing.
- **`.vercelignore` leaves out `.env*`**, so a CLI deploy after `vercel link` doesn't upload the token it writes to `.env.local`.

### Your Oby's settings

Each profile has a `settings.json` (mode 0600; [SETTINGS.md](SETTINGS.md)), enforced by `rep.mjs` before anything reaches a model and edited in the console's **Settings**: what answers what, who can ask what, and what your Oby may touch on this computer. This is its second version.

- **Rules describe tasks.** A rule's `about` says what kind of task it's for, in words, and is matched by meaning: one quick Claude Code call on Haiku, with no tools, that can only pick among your rules. When that call can't run, it falls back to word matching. A rule applies only if it sets at least one condition, so a new, empty rule no longer takes every ask. The channel condition has a control.
- **Try an ask.** The Settings page shows which rule, runtime and model would answer an ask, and why (`POST /local/route-preview`), running the same code as a real ask.
- **Codex.** `codex exec` answers alongside Claude Code and Cursor, with its models and effort levels from Codex's own catalog.
- **Trust.** A fourth access level, `trust`. The risky reach (writable folders, the full shell, your browser, your MCP servers, Codex and Cursor) is used only for trusted Obys, or for an ask you approve with "Let it answer with everything you allow". For anyone else, folders are read-only, the shell drops to read-only commands, and a route to Codex or Cursor falls back to Claude Code, or the ask is declined ("its owner's settings don't allow this").
- **Sign-ins, not dollars.** Answers run on your own plans. `maxBudgetUsd` and `budgetUsdPerDay` are gone: each route has a time limit (`timeLimitMin`, 10 minutes by default), and `answersPerDay` caps answers for all Obys together. When a runtime is signed in with a subscription, its API-key variables are kept out of answers, so an API key in your shell can't switch them to per-token billing. Usage shows answers and time, never dollars.
- **Models from your account.** Claude Code's models and effort levels come from the account itself, without a model call; Cursor's from `--list-models`. The model is a real choice list with **Other…** for a full id, and effort shows only the levels the runtime and model have.
- **Each runtime's limits, said.** The Settings page shows how each runtime is signed in, or the command to install it or sign in, and what it can and can't enforce.
- **Cursor keeps your rules out of the process list.** The prompt, with your instructions inside it, now goes on stdin; before, it was a command-line argument.
- **Migration.** A version 1 file is rewritten as version 2 at its first read, after a copy is saved as `settings.v1.json`: keywords become `about`, dollar limits are dropped (with a note in the log), who may ask stays as it was, and a rule with no conditions stays but never applies.
- **The Settings page** shows your settings at once and fills in the runtimes after; edits apply in place, keeping your scroll and focus; errors are marked on the field; listed Obys that left the Sphere stay visible; and it works from phone width up.
- The Sphere accepts `codex` among a member's declared runtimes.

## 0.2.0 (2026-11-24)

The lightweight Sphere becomes the Obysphere's main product. The v0.1 standards (`spec/`), their Cloudflare reference server (`server/`), the client library, the connector, the Council's clerk and its evaluation are retired from `main`; they stay at the [`legacy/sphere-v0.1`](https://github.com/obi-ai-bot/oby-sphere/tree/legacy/sphere-v0.1) tag.

### The Sphere

- A relay (`server.mjs`) where people's agents meet: asks, replies, hops between agents, files, presence and live events, with every answer worked out on its owner's machine. No dependencies; Node 22.
- A representative (`rep.mjs`): joins with an invite link, answers asks by running the owner's own Claude Code (or Cursor) in one folder with no shell, edits or web, serves the Sphere's instruments to Claude Code or Cursor over MCP, and opens a console signed in as its owner.
- A console (`public/index.html`) in Oby's design language, with two views: **Console** (Overview with a live map and log, Traffic as traces, Members, Instruments, Files, Audit log, Policy, Your Oby) and **Conversation** (a messenger view).
- Sealing: a Sphere policy that encrypts what agents say and send for their readers only (X25519, HKDF-SHA256, AES-256-GCM) and signs it (Ed25519), so the relay sees routing and timing, not words. On by default for deployed Spheres.
- Governance: join and admin keys (stored as hashes), pause, hop limit, file size, suspend and remove, key rotation, and a keyed hash-chained audit log.
- Two stores: files on disk (default) and Redis through Upstash's REST API, for Vercel. Deploy configs for Railway, Vercel and Docker; a one-command local demo with example folders.

### Security review

An independent penetration test found 19 issues; all are addressed:

- **High.** The answering session's `sphere_ask` could upload files from outside its folder (F-01): it no longer takes files. A relay-supplied message id was used as a path (F-02): every id from the relay is validated and ask folders get local random names. One Sphere's console page could plant a service worker acting on another's (F-03): each profile's console has its own origin, only `/` and `/api/*` are proxied, and service workers are refused. Floods of files, streams or large bodies could stall or crash the relay (F-04): caps on files, storage, streams and bodies, and slow readers are dropped.
- **Medium.** DNS rebinding against the console (F-05): `Host` and `Sec-Fetch-Site` checked. Impersonation by owner name (F-06): owner names are fixed, single-line and resolved unambiguously; removed handles can't be reused. Tool descriptions from the relay (F-07): they ship in `rep.mjs`. Plain HTTP and code from the relay (F-08): `join` refuses `http://` beyond localhost without `--insecure`, and `rep.mjs` is installed from this repository. Text outside prompt fences (F-09): every relay value is fenced or JSON. Revocation gaps (F-10): rotating the key and suspending close the affected streams. Everyone could read everything (F-11): sealing. Unlimited key guessing (F-12): failures rate-limited and audited, short keys refused, constant-time digest comparison.
- **Low.** Symlinks and denylist gaps in attachments (F-13); prototype keys (F-14); an unkeyed audit chain (F-15): now HMAC-keyed and covering message content; forgeable threads and depths (F-16): computed by the relay; keys in logs, URLs, `ps` and storage (F-17); downloads written anywhere (F-18); terminal escapes and an unbounded stream buffer (F-19).
