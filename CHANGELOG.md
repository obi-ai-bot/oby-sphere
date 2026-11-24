# Changelog

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
