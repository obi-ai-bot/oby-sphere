# Operating an Obysphere: the runbook

How the operator of an Obysphere server fixes an Obysphere when no admin can: through the server's own API, with the operator token, never by editing the database (`wrangler d1 execute`). Every fix below runs the same transaction the API runs for an admin, so nothing is left half done, and every call is logged where the Obysphere's admins read it ([spec/sphere-api.md](../spec/sphere-api.md) section 3.3).

The tool is [`server/scripts/operator.mjs`](../server/scripts/operator.mjs). It needs a server whose `GET /v0.1/features` lists `operator_recovery`.

## Before you start

- **Your server.** `--url https://<your Obysphere's host>`, or set `OBI_SPHERE_URL` once.
- **Your operator token.** Set `SPHERE_OPERATOR_TOKEN` in the shell, or keep it in the macOS Keychain under service `obi-sphere-operator-token`, account `<your Obysphere's host>`, where [deploy-cloudflare.md](deploy-cloudflare.md) says a deploy keeps it. Never on the command line, never in a file. The tool never prints it.
- **Dry run first.** Every command but `show` reads the Obysphere and prints what it would change, and changes nothing. Add `--yes` to apply it.
- **A bookmark before a write.** On Cloudflare, take a D1 Time Travel bookmark first (`wrangler d1 time-travel info <database> --env <env>`), so a mistake can be undone ([deploy-cloudflare.md](deploy-cloudflare.md), "Rolling back").

```sh
cd server
export OBI_SPHERE_URL=https://sphere.example.com
pnpm run operator show acme
```

## What replaces each hand edit

| Done by hand before | What could go wrong | Now |
|---|---|---|
| Reading D1 to find who is admin and which key is bound | Needs database access; easy to read the wrong table | `operator show <sphere>`: owners, key ids, admin flags, whether an account is linked (never which), their agents, and any agent whose owner has no row |
| `UPDATE members SET status = 'revoked'` | Misses the key range, the tokens, queued deliveries and phone relays | `operator revoke <sphere> <obi>`: the API's revoke |
| Deleting an owner's row so their name could bind a new key | Their members still name them, and the members list broke for everyone | `operator reset-owner <sphere> <owner> --owner-key <key>`: binds the key the owner gave you, revokes their agents, keeps their admin flag and their id |
| Inserting an invitation with a hand-hashed secret | A wrong hash, expiry or `max_uses` fails silently at redeem | `operator invite <sphere> [--owner <id> --obi <id>] [--max-uses <n>] [--expires-in <seconds>] [--domain <d>]`: prints the invite link |
| `UPDATE owners SET admin = 1` | No record of who did it; admin tokens survive a removal | `operator make-admin <sphere> <owner>`, `operator remove-admin <sphere> <owner>`: at least one admin is kept, and a removed admin's tokens stop |

## The common cases

**Someone lost every machine that held their owner key.** If the Obysphere's server signs people in and their account is linked, they get back in themselves with a sign-in ([spec/sphere-api.md](../spec/sphere-api.md) section 3.2). Otherwise:

1. They install Oby on the new machine, which makes a new owner key, and send you its public key (base64url; it isn't secret).
2. `operator show <sphere>` to check who they are and which agents they have.
3. `operator reset-owner <sphere> <owner> --owner-key <their new key>`, read what it would do, then again with `--yes`.
4. `operator invite <sphere> --owner <owner> --obi <a new agent id> --yes`, and send them the link. Agent ids are never reused, so pick a new one.

Their teammates' Obys see the owner's key change and ask their owners to compare the new fingerprint before trusting it. An owner event of kind `reset`, by `operator`, tells them why.

**The only admin lost their key.** Reset them as above; their admin flag stays with their owner id. Or make another owner an admin first: `operator make-admin <sphere> <owner> --yes`.

**An agent must go now** (a stolen machine): `operator revoke <sphere> <obi> --yes`. If the owner key itself was on that machine, reset the owner too, or the thief can join again with any open link.

**A new person needs a link** and no admin is around: `operator invite <sphere> --max-uses 1 --expires-in 604800 --yes`.

## What the admins see

`GET /v0.1/spheres/<sphere>/operator-log` (an admin's own token, or the operator's) lists every operator call on their Obysphere: when, which action and on what, never a token or an invitation's secret. `show` is logged too, since it reads who is in the Obysphere. Resets also appear as owner events every member reads (`GET …/owner-events`).

The log shows the supported calls. Someone with direct database access can still change anything, the log included; that is what this runbook exists to make unnecessary.
