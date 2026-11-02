# Self-hosting the Obysphere: the plan

The owner's ask of 2026-10-25: anyone hosts their team's Obysphere with the easiest setup in the world, on the platform they already use: Cloudflare (the button Deskree uses, kept and polished), Railway, Coolify, Docker on any VPS, and Vercel if it can work. This is the plan. Its first two steps are built in the same pull request: the container (`server/node/`, `server/Dockerfile`) and your own server (`deploy/docker/`, [self-host-docker.md](self-host-docker.md)). The rest is still a plan.

**Since then** ([#69](https://github.com/obi-ai-bot/oby-sphere/pull/69), [#84](https://github.com/obi-ai-bot/oby-sphere/pull/84)): the server and its pages serve any client, not Oby alone. Hosting starts with a token you make (or one a client makes for you), and the container's claim page shows the `curl` that claims it. The join and claim pages offer an Open link only for clients that publish a conformance report, and none does yet. The phone relay is an optional extension (`PHONE_RELAY`), listed at `GET /v0.1/features`. Sign-in takes any OpenID Connect provider (`SIGNIN_PROVIDERS`), and the Node build needs `SPHERE_URL` for sign-in, DPoP and assertions that name the server.

**In short:** keep the Worker and its Deploy to Cloudflare button as the main path. Add **one Docker image** of the same server (Node, SQLite on one volume, a thin layer standing in for D1 and the Durable Objects), which serves Railway, Coolify, a plain VPS, Fly.io and Render. Skip Vercel for now.

## What the Sphere needs (from the code, `dev` at 3554f8c)

| Part | Where | What it takes from Cloudflare | Off Cloudflare |
|---|---|---|---|
| The HTTP API | `server/src/app.ts`, `routes/`, `protocol/` | A `fetch(request, env)` handler | Runs as it is on Node |
| The database | `server/src/db.ts` and 13 other files; `server/migrations/` (5) | 104 queries through D1's API: `prepare`, `bind`, `first`, `all`, `run`, and `batch` as one transaction | A D1-shaped adapter over SQLite keeps every call and migration as it is |
| The Doorbell | `server/src/doorbell.ts` | A Durable Object per agent holding hibernating WebSockets that wake its long poll | In-process: one wake-up per agent. If it can't be reached, polls already fall back to reading the database every 250 ms |
| The phone relay | `server/src/relay.ts` | A Durable Object per relay (a member's machine and its phones): tagged WebSockets, ping/pong auto-response, alarms, its own storage | In-process registry, one WebSocket server, `setTimeout` for alarms, storage in memory |
| The job channel | `server/src/channel.ts` | A Durable Object per run_request exchange | Only compute sharing uses it (spec §6.3), which Oby, its one user so far, is cutting (obi-ai-bot/oby, docs/trim.md): left out of the container |
| Settings | `server/src/env.ts`, `wrangler.jsonc` | `SPHERE_OPERATOR_TOKEN` (secret), `GOOGLE_CLIENT_ID`, `SIGNIN_PROVIDERS`, `SIGNIN_RETURN_SCHEMES`, `CREATOR_WORKSPACES`, `SPHERE_CREATE_LIMIT`, `PHONE_RELAY` | Environment variables, and `SPHERE_URL`, the server's own address, never read from a request (optional on the Worker, needed off it) |
| An address | Invite links, a client confirms the host | `*.workers.dev`, or a custom domain on the account | HTTPS from the platform, or Caddy on a VPS |

No crons. About 3,100 lines of TypeScript in `server/src`.

## Two shapes, one codebase

1. **The Worker**, as today, from the Deploy to Cloudflare button: free for a small team, and the only button that makes D1, the Durable Objects and the secret together.
2. **One container**: the same app on Node, with a small platform layer:
   - `sqlite.ts`: the only file that names the runtime's SQLite (`node:sqlite`, built into Node). Bun can't load `node:sqlite` (tried on Bun 1.3.14), so Bun support later is a second copy of this one file over `bun:sqlite`.
   - `d1.ts`: D1's shape over it, so `db.ts` and the routes don't change, and the same migrations apply at start, recorded as D1 records them.
   - `objects.ts`: one in-process instance per Doorbell and per phone relay, WebSockets with tags, alarms on `setTimeout`, storage in memory. A restart closes every socket, and sockets are all that storage and those alarms are about, so nothing there needs to outlive the process.
   - `main.ts`: reads the settings from the environment, keeps everything in `/data`, serves the claim, refuses plain HTTP except from localhost, and sends no telemetry.

   Images go to `ghcr.io/obi-ai-bot/obi-sphere`, with a version tag and `latest`. The acceptance test is what already runs against the Worker passing against the container too: the end-to-end scenario (`pnpm run scenario`) and the load test (`pnpm run load -- --node`). The container's own test, `pnpm run test:node`, adds the claim, the HTTPS rule, the relay's sockets and a restart.

**Why not run the Worker unchanged in a container?** The repository already runs it outside Cloudflare (`scripts/local.mjs`, wrangler's own dev server on workerd), and Oby's end-to-end suite does exactly that. But:

- **Spike (2026-10-25, this Mac):** a local Sphere on `scripts/local.mjs` used about **410 MB idle and 440 MB after 300 requests** (wrangler's Node process 240 MB, two workerd processes about 80 MB each). That's a 1 GB VPS at least, for tooling not built for production. The Node container, measured the same day: **54 MB in its container** (Caddy beside it 14 MB), and 73 to 80 MB as a process on the Mac after 300 requests.
- **workerd itself:** its Durable Objects are single-instance and "not production-ready" (Cloudflare, 2026-10-09).
- **celld** (the Deno team's runtime for Workers apps): it needs an object-storage bucket even on one node.
- **Later:** Cloudflare is merging the two into a first-class self-hosted workerd, with no dates. When it ships, the container could become the Worker itself and the platform layer could go.

## Every target

| Target | Works? | How | One click? | A small team, per month | Updates |
|---|---|---|---|---|---|
| **Cloudflare** | Yes, today | The Worker, D1, the Durable Objects | Yes: the button makes all of it and asks for the token | $0 on Free (about 15 people with Oby running, docs/run-your-own.md); $5 Workers Paid past that | Cloudflare copies `server/` into the user's own repository and redeploys on each push. Taking a newer server is a copy by hand today |
| **Railway** | Yes, with the container | The image plus a volume | Yes: a template and its button | About $5 (Hobby, which includes $5 of use) | A template built from this repository tells its users when it changes, and they choose to update. Not for templates built from an image, so ours builds from the repository |
| **Coolify** | Yes, with the container | `compose.yaml` from the repository (Compose build pack) | Close: "Docker Compose from a public repository" with its URL. The service catalog is paused for outside contributions and needs 1,000 stars | A VPS Coolify accepts (at least 2 GB and 2 CPUs) | Redeploy from Git in Coolify |
| **Any VPS (Docker)** | Yes, with the container | `compose.yaml` (the Sphere and Caddy) and `.env` | Two downloaded files and `docker compose up -d` | The cheapest VPS: 512 MB is plenty (the Sphere 54 MB, Caddy 14 MB) | `docker compose pull && docker compose up -d` |
| **Fly.io** | Yes | The image, `fly.toml`, one volume | No button: `fly launch` from the repository | About $2.35 (256 MB plus a 1 GB volume) | `fly deploy` |
| **Render** | Paid plans only | `render.yaml` and a disk | Yes, a Deploy to Render button | About $7.25 (Starter plus 1 GB disk) | Render's own deploys, set not to follow every push here |
| **Vercel** | Not now | — | — | Pro, at least $20, plus Redis and a database | — |

### Vercel, plainly

Vercel's Functions have taken WebSockets since 2026-10-20. Still, a Sphere there is the wrong fit:

- **Connections end:** each connection stays on the instance that took it and closes at the function's maximum duration (300 s on Hobby, 800 s on Pro).
- **Fan-out needs Redis:** reaching sockets on other instances needs Upstash Redis's pub/sub, by Vercel's own advice.
- **D1 has to be replaced:** by Neon or Turso, which for Postgres means changing the SQL.
- **Memory is billed while a connection is open:** a Mac's relay, always open, keeps an instance alive all month, about four times Hobby's allowance.

If it's ever wanted, the smallest working shape is Vercel Pro, Upstash Redis and Turso.

Sources for all of this are at the end.

## The steps, counted

Every path starts with an operator token: one you make (`openssl rand`), or one a client makes for you (Oby: Settings › Obysphere › Host your own). A client may add a choice of where (Cloudflare, Railway, Coolify, your own server), open that platform's page, and end by joining the new Sphere. "Paste" is the token, or the server's address.

| Target | From nothing to "your client joined" | Pastes |
|---|---|---|
| Cloudflare today | Deploy…, sign in to Cloudflare and GitHub, paste the token, Deploy, find the address in the dashboard, paste it into your client | 2 |
| **Cloudflare, polished** | Deploy…, sign in, paste the token, Deploy, **Visit** (the button at the end of Cloudflare's deploy), a listed client's **Open** on the Sphere's first page (it hands the client its own address); a client that isn't listed takes the address pasted | 1 (2) |
| Railway | Deploy…, sign in, Deploy, open the claim link in the deploy's log, claim it with a listed client's Open, or with the page's `curl` and then the token and the address into your client | 0 (2) |
| Coolify | New resource, Docker Compose, the repository's URL, set a domain, Deploy, open the claim link in its log, claim it | 0 (2) |
| Your own server | Point a domain at it, run the two download lines, put the domain in `.env`, `docker compose up -d`, open the claim link it prints, claim it | 0 (2) |

The counts in brackets are for a client that isn't listed in `server/src/clients.ts`. Listing needs a published conformance report, and no client has one yet (step 6).

Two things make this the easiest:

- **The Sphere's first page hands a client its address.** A Sphere's first page offers each listed client's Open link (its own scheme, with the server's own origin); on a container's claim page, the `curl` is there for everyone else. A client that made the token holds it already, so nobody copies an address again. Clicked first by someone else, it gives away nothing: the token never leaves the person's machine until their client checks the server.
- **On containers the token paste goes too (decided).** Started with no `SPHERE_OPERATOR_TOKEN`, the container writes a one-time claim link to its own log (as PocketBase does), never on a page. The link carries a claim code, never the operator token: whoever claims it makes the token (the page's `curl`, or a listed client), the server keeps only its hash, and the code works once. A restart before anyone claims prints a new code, and until it's claimed the Sphere answers only health, its features and the claim. Setting `SPHERE_OPERATOR_TOKEN` still works and skips the claim. On Cloudflare the button keeps asking for the token: a Worker's logs are harder to reach than the field.
  - The claim page's Open links appear for clients listed in `server/src/clients.ts` that open claim links (`claims: true`), each through its own `<scheme>://claim/<host>#<code>`. Anyone else claims with the `curl` the page shows, or sets `SPHERE_OPERATOR_TOKEN` (`.env` on a VPS, the platform's variable on Railway or Coolify).

## The rules hold on every target

- **The same checks everywhere:** the same code means the same checks. The relay is for members only and its frames stay sealed; the container runs the same routes and the same Durable Object classes, through the platform layer.
- **The operator token:** a platform secret (Cloudflare, Railway, Render), a Coolify secret, or `.env` at 0600 on a VPS. Never in git, never in a log (the claim link is single-use and isn't the token).
- **HTTPS only:** Railway, Coolify and Render give it, and Caddy on a VPS gets a certificate the moment the domain points there. The container refuses plain HTTP from anywhere but localhost, so a misconfigured proxy fails closed.
- **No telemetry:** the container sends nothing, like the Worker.
- **Backups:** everything is in `/data`. The guide's backup is one line with Node's own SQLite (`node:sqlite`'s `backup`, so the image needs no `sqlite3`), tested with its restore. Railway backs volumes up for you.

## Updates

- **The container:** versioned images, migrations applied at start (the same files, in order), and the guides' one line: pull, then up.
- **A client tells you:** the server says its version at an endpoint of its own, an addition the spec gains first and the server lists at `GET /v0.1/features`. Not in `GET /v0.1/health`, which stays as it is for clients that check it strictly, and not in the features answer, which never gains members. A client shows one line when your Sphere is behind.
- **Cloudflare:** the user's copy redeploys on push, but nothing brings our changes to it. The polish ships a small optional GitHub Action in `server/` that opens a pull request in the user's repository when a newer server is released.

## Order

1. **The platform layer and the image** (done in this pull request): the scenario, the load test and `pnpm run test:node` pass against the container, and it uses 54 MB against the spike's 410 MB.
2. **Your own server** (done in this pull request): `compose.yaml` with Caddy (its Caddyfile inline, so there are two files to download), `.env.example`, and [self-host-docker.md](self-host-docker.md). Tested end to end in Docker: the scenario over HTTPS through Caddy, and the phone relay's WebSockets through it.
3. **Railway:** the template, built from this repository, with `SPHERE_URL` set from Railway's domain variable, and its button in `docs/run-your-own.md`.
4. **Coolify:** the compose file with Coolify's magic variables (`SPHERE_URL` from its domain), and the guide (the catalog when contributions reopen).
5. **Cloudflare polish:** the Sphere's first page with the listed clients' Open links, the server's version at an endpoint of its own, the update Action.
6. **Clients:** a client publishes its conformance report and is listed in `server/src/clients.ts`, which puts its Open links on the join and claim pages. Oby already opens `oby://join` and `oby://claim` links; it needs its report. Then, in any client: where to host, and the "your Sphere is behind" line.
7. **Later:** Render's button, a Fly page, Vercel if asked again, and the self-hosted workerd once Cloudflare ships it.

## Decided (the owner, 2026-10-25)

1. **Node only** for the container, with the SQLite code in one small file (`sqlite.ts`) so Bun can be added later. One runtime means one set of checks, run on the Mac (Actions is off here).
2. **The job channel stays out** of the container.
3. **A one-time claim link** on containers, as above; the token paste stays on Cloudflare.
4. **Vercel is skipped** for now.
5. **Images are published** as `ghcr.io/obi-ai-bot/obi-sphere`, built for amd64 and arm64 on the Mac and pushed from there. The first push needs a GitHub login allowed to write packages (`gh auth refresh -s write:packages`, the owner's step), and the package is made public by hand after it. Railway builds from the repository, so it doesn't wait on the image.

## Sources

Read on 2026-10-25. Prices and limits change; recheck before publishing a guide.

- **Cloudflare:**
  - Deploy buttons: https://developers.cloudflare.com/workers/platform/deploy-buttons/
  - Durable Objects pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
  - Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
  - Custom domains: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
  - Self-hosted workerd and celld: https://blog.cloudflare.com/deno-joins-cloudflare/ (2026-10-09) · https://github.com/cloudflare/workerd · https://celld.dev/
- **Vercel:**
  - WebSockets: https://vercel.com/changelog/websocket-support-is-now-generally-available (2026-10-20) · https://vercel.com/docs/functions/websockets
  - Limits and pricing: https://vercel.com/docs/functions/limitations · https://vercel.com/docs/functions/usage-and-pricing
  - Realtime and storage: https://vercel.com/kb/guide/publish-and-subscribe-to-realtime-data-on-vercel · https://vercel.com/docs/storage
- **Railway:** https://docs.railway.com/templates/publish-and-share · https://docs.railway.com/templates/updates · https://docs.railway.com/reference/pricing/plans · https://docs.railway.com/networking/public-networking/specs-and-limits · https://docs.railway.com/volumes
- **Coolify:** https://coolify.io/docs/get-started/contribute/service · https://coolify.io/docs/knowledge-base/docker/compose · https://coolify.io/docs/get-started/installation
- **Caddy:** https://caddyserver.com/docs/automatic-https · https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- **Fly.io:** https://docs.fly.io/about/pricing · https://docs.fly.io/volumes/overview
- **Render:** https://render.com/docs/deploy-to-render · https://render.com/docs/free · https://render.com/docs/disks
- **Projects that make self-hosting easy, and what we take from each:**
  - PocketBase (one binary, SQLite, a one-time install link in its log): https://pocketbase.io/docs/going-to-production/
  - Uptime Kuma (one container, a `/data` volume, pull then up): https://github.com/louislam/uptime-kuma
  - n8n (SQLite by default, the volume holds its key): https://docs.n8n.io/hosting/installation/docker/
  - Vaultwarden (one container, `/data`): https://github.com/dani-garcia/vaultwarden
  - Immich (download the compose file and `.env`, version pinned): https://docs.immich.app/install/docker-compose
  - Coolify (pre-set the first admin, because whoever registers first wins): https://coolify.io/docs/get-started/installation
- **Running one codebase on several runtimes:** https://hono.dev/docs/helpers/websocket · https://orm.drizzle.team/docs/get-started-sqlite · https://nodejs.org/api/sqlite.html
