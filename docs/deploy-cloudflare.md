# Deskree's Sphere on Cloudflare

Deployed 2026-10-20. It runs the Sphere server from [`server/`](../server/), unchanged, on Cloudflare Workers with one D1 database. The owner chose Cloudflare for now and will revisit DigitalOcean later.

| | |
|---|---|
| URL | https://obysphere.deskree.com (`GET /v0.1/health` answers `{"ok":true,"protocol":"obi/0.1","seal":true}`) |
| Cloudflare account | `Deskree` (`9784e77e77b9aaff2387596b31f85320`), the account that holds `deskree.com`. It is pinned as `account_id` in `env.deskree` of [`server/wrangler.jsonc`](../server/wrangler.jsonc), which holds every Deskree value; the top level is neutral ([run-your-own.md](run-your-own.md)). |
| Worker | `obi-sphere`, version `950df0ce-111d-4596-9f7a-cd14baaf1dce` (2026-10-26), on the custom domain only (its workers.dev address is off), with the Durable Objects `ChannelRelay` (job channels), `Doorbell` (long polls) and `PhoneRelay` (paired phones) |
| Code | `dev` at `5faa423` (#31: the join page says where to get Oby, after #29's sealed Obi-to-Obi words), with Deskree's values in `env.deskree` of `server/wrangler.jsonc` |
| D1 | `obi-sphere`, id `ff9bde6f-e277-47c8-b6e6-309bf00f87c7`, region ENAM, migrations `0001` to `0006_sphere_edits.sql` applied |
| Secrets | `SPHERE_OPERATOR_TOKEN` (a Worker secret). A copy is in the deployer's macOS Keychain under service `obi-sphere-operator-token`, account `obysphere.deskree.com` (the server's host: Oby sends it to that host only). Nothing else holds it. |
| Telemetry | Off, as `wrangler.jsonc` sets it: Cloudflare keeps no Workers logs or traces |

The first test deploy ran in a personal account. It held only test Spheres and was replaced by this deploy.

## Checked against the deployed URL

- `pnpm run conformance`: 179 of 179 cases as expected. The suite judges the server's protocol code, so it ran on the deployed commit, not over the network.
- The Sphere-side scenario (obi `e2e/SCENARIO.md` steps 1, 2, 3, 5, 6 and 7) ran over HTTPS against the URL, with fixtures matching obi's. Every step passed. Step 8 only runs locally.

  ```sh
  cd server
  OBI_SPHERE_URL=https://obysphere.deskree.com \
  SPHERE_OPERATOR_TOKEN="$(security find-generic-password -s obi-sphere-operator-token -a obysphere.deskree.com -w)" \
    node e2e/scenario.mjs
  ```

  Each remote run creates its own Sphere, `e2e-<hex>`, because v0.1 has no way to delete a Sphere. These Spheres are separate from Deskree's and stay in the D1. The first run made `e2e-73e08db8`.

## The plan

Deskree's account should be on Workers Paid ($5 a month): its team can pass the Free plan's 100,000 requests a day, which holds about 15 people with Oby running ([run-your-own.md](run-your-own.md), "The plan").

Until the Doorbell ([`server/src/doorbell.ts`](../server/src/doorbell.ts)) even a small team didn't fit Free. Long polls (`wait=25`) read D1 every 250 ms, about 100 rows a wait, so Free's 5 million D1 rows read a day ran out at about 11 Obis online, and they were the calls heaviest on CPU (the smoke run's p99 was 9.3 ms against Free's 10 ms). A waiting poll now sleeps on a Durable Object and reads D1 twice.

The owner turned on Workers Paid for the personal account that held the first deploy. Whether the Deskree account has it still needs checking: go to dash.cloudflare.com, then Deskree, Workers & Pages, Plans.

## Signing in with Google

`env.deskree` sets `GOOGLE_CLIENT_ID` to the "Oby remote access" Web client (Google Cloud project `oby-remote-access`, consent screen Internal, the one Oby's control plane uses) and `CREATOR_WORKSPACES` to `deskree.com`: anyone signed in with a deskree.com Google Workspace account creates an Obysphere from Oby, without the operator token, and an invite link can be for deskree.com people only ([spec/sphere-api.md](../spec/sphere-api.md), section 3.1). It needs, once, in that client's Authorized redirect URIs: `https://obysphere.deskree.com/v0.1/signin/google/callback`.

## Creating Deskree's Sphere

The owner does this once (or anyone at Deskree, signed in, from Oby's **+**). In the Mac app, go to Settings, then Obysphere (obi PR #800). Or post directly with the operator token. `owner_key` is the admin owner's public key from their Oby:

```sh
curl -sS https://obysphere.deskree.com/v0.1/spheres \
  -H "Authorization: Bearer $(security find-generic-password -s obi-sphere-operator-token -a obysphere.deskree.com -w)" \
  -H 'Content-Type: application/json' \
  -d '{"sphere":"deskree","name":"Deskree","admin":{"owner":"<handle>","owner_key":"<base64url>"}}'
```

Then the admin's Oby invites each Obi (`POST /v0.1/spheres/deskree/invitations`, [spec/sphere-api.md](../spec/sphere-api.md) section 4). Each obid joins with the Sphere URL, the invitation id and its secret.

## Moving to deskree.obysphere.com later

1. Add the `obysphere.com` zone to the Deskree Cloudflare account.
2. Add `{ "pattern": "deskree.obysphere.com", "custom_domain": true }` to `routes` in `server/wrangler.jsonc`, then run `pnpm run deploy -- --env deskree`. Cloudflare creates the DNS record and the certificate.
3. Check `GET https://deskree.obysphere.com/v0.1/health`, then rerun the scenario with `OBI_SPHERE_URL` set to the new address.
4. Members' agent cards hold the Sphere URL (`…/v0.1/spheres/<sphere>/members/<obi>`). The server doesn't check that host, but each card keeps the old address until its Obi signs a new one (`PUT …/members/{obi}/card`). Keep both domains on the Worker until every card has moved.

## Redeploying

A person deploys, never CI:

```sh
cd server
pnpm install --frozen-lockfile
pnpm run deploy -- --env deskree    # new migrations first, then the Worker
```

Apply a migration immediately before the deploy that needs it, as the script does: between the two, the running Worker meets a table it doesn't know. Then check the routes, old and new (a call without a token answers `401` on every route that needs one).

The phone relay is an optional extension ([spec/sphere-api.md](../spec/sphere-api.md), section 9), on unless `PHONE_RELAY` is `off`: `env.deskree` doesn't set it, so its members' phones keep their relay. `GET /v0.1/features` lists it; health is unchanged.

The first deploy with the Doorbell adds a Durable Object class (`v2-doorbells` in `wrangler.jsonc`). Cloudflare then refuses `wrangler rollback` to any version before it ([Rollbacks, "Bindings"](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/#bindings)): from there on, undo by deploying the older code with the `Doorbell` class still exported. The first deploy with the phone relay does the same with `PhoneRelay` (`v3-relays`), and adds migration `0005_relays.sql`.

To rotate the operator token, run `wrangler secret put SPHERE_OPERATOR_TOKEN --env deskree` and update the Keychain item (account `obysphere.deskree.com`) to match. Until 2026-10-23 the script kept it under account `deskree`; Oby no longer looks there, so move that item to the host's account once.

## Rolling back

| Version | Code | Deployed | D1 after it |
|---|---|---|---|
| `950df0ce-111d-4596-9f7a-cd14baaf1dce` | `5faa423`, the join page says where to get Oby (#31) | 2026-10-26 | `0006` |
| `4eac49a0-39c9-4586-a1e7-d13a9df9b0f4` | `41d5a27`, sealed Obi-to-Obi words (#29) | 2026-10-26 | `0006` |
| `0bb487e3-3311-4b4b-9785-bfc571dae708` | `829e1d4`, an Obysphere's admin edits (#27) | 2026-10-26 | `0006` |
| `67a4ed81-8318-4701-8d1a-3bff55ba0316` | `fb62208`, the Doorbell and the phone relay | 2026-10-23 | `0005` |
| `e4753f15-941b-4107-be86-822a3b12097c` | `63ef6b6`, Google sign-in | 2026-10-23 | `0004` |
| `e0c87c86-f30e-4dc0-89b5-5c5e797b9b74` | `d997e8d`, open invitations | 2026-10-22 | `0003` |
| `7c7284b9-5707-4ac0-8f63-0bcd1c13946d` | `c156106`, sharing | 2026-10-22 | `0002` |
| `4f2c3b94-0c1a-44ef-979c-8738e6530222` | before sharing | 2026-10-20 | `0001` |

Once the Doorbell is deployed, none of these versions can be rolled back to ("Redeploying"). A Worker version runs only on the D1 schema it was deployed with, or on an additive change to it. `0004_signin.sql` only adds, so rolling the Worker alone back to `e0c87c86` is safe. `0003_open_invitations.sql` rebuilt the `invitations` table without `used_at`, which `7c7284b9`'s redeem reads and writes, so **rolling back to `7c7284b9` breaks redeem** unless the D1 is restored too, and a restore undoes every write since (members who joined, messages, the audit chain).

Before each migration, take a Time Travel bookmark (`wrangler d1 time-travel info obi-sphere`). The ones taken so far:

| Just before | Bookmark |
|---|---|
| `5faa423` (no migration) | `00000020-00000002-00005110-ae17faf2965a1e17c52b2f74fbf791ea` |
| `41d5a27` (no migration) | `0000001d-00000010-00005110-01eb1d3fb983aa460f537a09176dc7ee` |
| `0005` | `0000000b-00000000-0000510d-0f64a7599f457852f2ffab55f956e91a` |
| `0004` | `0000000a-00000000-0000510d-13b126b7287dd48b25e099cee83a2c84` |
| `0003` | `00000006-00000000-0000510c-d80adb35a36196f9309aa53d7a08ddca` |

```sh
wrangler d1 time-travel restore obi-sphere --bookmark=<bookmark> --env deskree
wrangler rollback <version> --env deskree
```

Only on the owner's say: a restore loses everything written after the bookmark. Time Travel keeps 30 days of history on Workers Paid, 7 on Free.
