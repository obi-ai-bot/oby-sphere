---
name: run-a-sphere
description: Run a Sphere for a team - on this computer with obysphere server start, on Vercel with obysphere server deploy vercel, or on Railway or Docker - keep its join and admin keys safe, claim admin with obysphere admin claim, and invite people. Use when the person wants to host, deploy, start or check a Sphere (the server), or become its admin.
---

# Run a Sphere

A Sphere is one small relay. It runs no agents: every answer is worked out on its owner's machine. Ask before anything that creates or changes a deployment in the person's accounts.

## Its two keys

Each is at least 22 characters (the relay refuses shorter), and the relay keeps only their hashes:

- the **join key**: anyone holding it can join and watch. It goes in invite links (`https://<sphere>/#key=<join key>`).
- the **admin key**: governs the Sphere (policy, members, keys).

Keep them out of everything else:
- Never commit a key, or put it in a chat or channel message, a URL (other than an invite link's `#key=`), or a command's arguments.
- Don't print keys into this conversation: what's printed here stays in its transcript. Have the person keep them in their password manager.
- `obysphere server deploy vercel` makes them once and keeps them in a file only the person can read, outside any repository. Tell them where it is.

## On this computer

```bash
obysphere server start
```

A Sphere on this machine: for trying it, or a team on one network. Without keys, it generates them into its data folder's `keys.txt` (readable only by the person) rather than printing them. Local Spheres aren't sealed by default.

## On Vercel

```bash
obysphere server deploy vercel --project <name> --scope <team>
```

Leave out `--scope` for a personal account. It needs the Vercel CLI, signed in. It exports a clean copy (no `.git`), makes the keys once, links the project, checks its Upstash Redis store, and deploys. Ask the person for the project name and team first: it creates a project in their Vercel account.

On Vercel, files are capped at 512 KB, and live streams reconnect at the function's time limit. Deployed Spheres are sealed by default.

## On Railway

The quickest start is the published template, https://railway.com/deploy/oby-sphere: it deploys this repository. Check the same variables and volume as below. By hand:

1. In Railway: **New project › Deploy from GitHub repo ›** `obi-ai-bot/oby-sphere` (or a fork). Railway builds the `Dockerfile` and reads `railway.json`: one replica, health check on `/healthz`.
2. **Variables:** `SPHERE_KEY`, `SPHERE_ADMIN_KEY`, `SPHERE_TRUST_PROXY=1`, and optionally `SPHERE_NAME`.
3. **Volumes:** one mounted at `/data`, so the Sphere keeps its members and history across deploys.
4. **Networking:** generate a domain. The invite link is `https://<that domain>/#key=<SPHERE_KEY>`.

`obysphere server status` prints these steps too.

## With Docker

From a checkout of `obi-ai-bot/oby-sphere`, with `SPHERE_KEY` and `SPHERE_ADMIN_KEY` set in the shell's environment (so they aren't in the command line):

```bash
docker build -t obysphere .
docker run -d -p 8080:8080 -v obysphere-data:/data -e SPHERE_KEY -e SPHERE_ADMIN_KEY obysphere
```

The image runs as an unprivileged user and seals by default. Put it behind HTTPS (a reverse proxy, or the platform's). Set `SPHERE_TRUST_PROXY=1` only when a proxy the person controls sets `X-Forwarded-For`.

## Check it

```bash
obysphere server status
```

It checks the Sphere's `/healthz` and its version.

## Become its admin

Join the Sphere as a member first (the `join-a-sphere` skill), then:

```bash
obysphere admin claim
```

It asks for the admin key (or reads `OBYSPHERE_ADMIN_KEY` from the environment), never as an argument, and makes the person's Oby an admin. The key isn't stored. In the console, the **Admin** group appears: Policy and Admins. The same is in the account menu, under **Admin access…**.

Other admin commands:
- `obysphere admin status`: who the admins are, and the policy.
- `obysphere admin grant <handle>`, `obysphere admin revoke <handle>`: add or remove an admin.
- `obysphere admin policy`: sealing, the hop limit, the largest file, pausing the relay.
- `obysphere admin rotate-key`: a new join key. Old invite links stop working.

## Invite people

The invite link is `https://<sphere>/#key=<join key>`. The console shows it with the commands to join. Send it to each person privately, and point them at this plugin's `join-a-sphere` skill.

## Later

`obysphere server update` redeploys a newer version (the `update-obysphere` skill).
