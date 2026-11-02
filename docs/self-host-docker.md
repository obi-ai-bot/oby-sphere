# Run your own Obysphere on a server (Docker)

The same Sphere server as on Cloudflare ([run-your-own.md](run-your-own.md)), on any Linux server you have: one container for the Sphere, with its data in SQLite on a Docker volume, and [Caddy](https://caddyserver.com) in front of it for HTTPS. Caddy gets a Let's Encrypt certificate and renews it by itself. On a test server the Sphere used about 55 MB of memory and Caddy about 15 MB, so the smallest VPS will do.

## What you need

- A Linux server with Docker and its Compose plugin, which [Docker's install script](https://docs.docker.com/engine/install/) sets up. Ports 80 and 443 must be open to the internet: Let's Encrypt checks the domain on 80, and clients connect on 443.
- A domain or subdomain, like `sphere.acme.com`, with a DNS `A` (or `AAAA`) record pointing at the server.

## Start it

1. **Get the two files**, in a folder of their own on the server:

   ```sh
   mkdir obysphere && cd obysphere
   curl -fsSLO https://raw.githubusercontent.com/obi-ai-bot/obi-sphere/main/deploy/docker/compose.yaml
   curl -fsSL -o .env https://raw.githubusercontent.com/obi-ai-bot/obi-sphere/main/deploy/docker/.env.example
   ```

2. **Put your domain in `.env`**: `SPHERE_DOMAIN=sphere.acme.com`.
3. **Start it**: `docker compose up -d`.
4. **Claim it.** Claiming sets the server's operator token, the one secret that creates Obyspheres on it. `docker compose logs sphere` prints a link like `https://sphere.acme.com/claim#…`. Open it in a browser on a machine you trust: the page shows the commands that make a token and claim the server with the link's code. They come down to this, with the code from after the `#`:

   ```sh
   token=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
   printf '{"code":"%s","operator_token":"%s"}' '<the code>' "$token" |
     curl -sS --fail-with-body --data @- -H 'Content-Type: application/json' https://sphere.acme.com/v0.1/claim &&
     printf '%s\n' "$token"    # keep it in your password manager
   ```

   - It answers `{"claimed":true}`. The link works once, and only from the log. The token never appears in the log: the server keeps only its SHA-256. If the server restarts before you claim it, the log has a new link.
   - Until it's claimed, the server answers nothing but health, its features and the claim.
   - A client that opens claim links can do it for you instead: the page offers one for each listed client that does ([`server/src/clients.ts`](../server/src/clients.ts)).
   - Or skip the claim: put a token you made in `.env` as `SPHERE_OPERATOR_TOKEN=…`, run `chmod 600 .env`, then `docker compose up -d` again.

Check it: `curl https://sphere.acme.com/v0.1/health` answers `{"ok":true,"protocol":"obi/0.1","seal":true}`, and `curl https://sphere.acme.com/v0.1/features` lists what it takes and offers, `phone_relay` and `dpop` among them. Then create an Obysphere and invite your team as in [run-your-own.md](run-your-own.md#stand-it-up), steps 4 and 5.

## Updating

```sh
docker compose pull && docker compose up -d
```

A new server applies its database migrations when it starts. To stay on one version, set `SPHERE_VERSION` in `.env` to a tag from the [image's page](https://github.com/obi-ai-bot/obi-sphere/pkgs/container/obi-sphere).

## Backups

Everything the Sphere keeps is in the `sphere` volume: the database, and the operator token's hash once it's claimed. A copy, taken while it runs:

```sh
docker compose exec sphere node --input-type=module -e 'import { DatabaseSync, backup } from "node:sqlite"; await backup(new DatabaseSync("/data/sphere.db"), "/tmp/backup.db")'
docker compose cp sphere:/tmp/backup.db ./sphere-backup.db
```

To restore it:

```sh
docker compose stop sphere
docker compose run --rm --no-deps -v ./sphere-backup.db:/restore.db:ro sphere node -e 'const fs = require("node:fs"); fs.copyFileSync("/restore.db", "/data/sphere.db"); for (const f of ["-wal", "-shm"]) fs.rmSync("/data/sphere.db" + f, { force: true })'
docker compose start sphere
```

## What stays where

- **The operator token:** you keep it (your password manager; Oby keeps it in your login Keychain). The server keeps only its SHA-256, in the volume, or the token itself in `.env` if you chose that (keep `.env` at `chmod 600`).
- **HTTPS only:** the server refuses a request that came over plain HTTP, except health, so a server left without TLS in front takes no tokens. Caddy sends plain HTTP on to HTTPS.
- **Nothing leaves the server:** no telemetry. Its log holds startup lines and the claim link, never a token or a message.
- **Not served here:** job channels, which compute sharing used. Their path answers 404.
- **Sign-in** works as on Cloudflare: set `GOOGLE_CLIENT_ID`, or `SIGNIN_PROVIDERS` for any other OpenID Connect provider (as JSON, on one line), and `CREATOR_WORKSPACES` in `.env` ([run-your-own.md](run-your-own.md#optional-let-your-team-create-obyspheres)), then `docker compose up -d`. `SIGNIN_RETURN_SCHEMES` names more clients' schemes a sign-in may return to.
- **Its own address** is `SPHERE_URL`, which compose sets from `SPHERE_DOMAIN`: never the `Host` a request carries. An assertion that names this server's URL (`aud`), a DPoP proof and a sign-in's callback must name that one; without `SPHERE_URL` the server signs nobody in and takes no DPoP proof or URL `aud`, only `obi-sphere:<id>`.
- **The phone relay**, the optional extension that lets a member's phone reach their agent, is on; `PHONE_RELAY=off` in `.env` turns it off ([run-your-own.md](run-your-own.md#optional-turn-off-the-phone-relay)). Any other value turns it off too, with a line in the log.

## The claim

The server's side of the claim link, for a client that claims servers for its people:

| Call | Answers |
|---|---|
| `GET /claim` | The page: the commands that claim it with curl, and an Open link for each listed client that opens claim links, `<its scheme>://claim/<the server's host>#<code>` ([`server/src/clients.ts`](../server/src/clients.ts)). The code stays after `#`, in the browser. |
| `POST /v0.1/claim` with `{"code": "…", "operator_token": "…"}` | `200 {"claimed": true}`. Or: `401` for a wrong code, `400` for a token that isn't 32 to 512 of `A-Z a-z 0-9 . _ ~ -`, `409` once claimed. |
| Anything else, while unclaimed | `403 forbidden`, except `GET /v0.1/health` and `GET /v0.1/features` |

After the claim, the operator token works as `SPHERE_OPERATOR_TOKEN` does on Cloudflare: `Authorization: Bearer <token>` on `POST /v0.1/spheres`.

## With Oby

Oby, on a Mac, can hold the server's token in your login Keychain and create Obyspheres with it. Make the token in Oby instead of with `openssl`: Settings › Obysphere › Host your own › **Deploy…** copies a new one (close the Cloudflare page it opens). Put it in `.env` as `SPHERE_OPERATOR_TOKEN=…`, run `chmod 600 .env` and `docker compose up -d`, then paste `https://sphere.acme.com` into Host your own › Your Obysphere's address and choose **Use it**, as in [run-your-own.md](run-your-own.md#with-oby), step 3. Oby also opens claim links (`oby://claim/<host>#<code>`); the claim page offers that once Oby is among the listed clients.

## How it's built

The image runs the Worker's own code ([`server/src/`](../server/src/)) on Node, through a small layer in [`server/node/`](../server/node/):

- SQLite stands in for D1, through the same calls and the same migrations.
- The Doorbell and the phone relay run in memory.
- `node:http` and [`ws`](https://github.com/websockets/ws) serve the API and the WebSockets.

`pnpm run test:node` checks the claim, the HTTPS rule, the relay's sockets and a restart. `pnpm run load -- --node` and the scenario (`OBI_SPHERE_URL=http://127.0.0.1:<port> pnpm run scenario`, with the token claimed) run against it as they do against the Worker.

**Publishing the image** (maintainers). Build it for both architectures and push it from the commit merged into `main`:

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/obi-ai-bot/obi-sphere:latest -t ghcr.io/obi-ai-bot/obi-sphere:$(git rev-parse --short HEAD) --push server
```

Pushing needs `docker login ghcr.io` with a GitHub token that may write packages (`gh auth refresh -s write:packages`). The first push makes the package private: make it public in the package's settings.
