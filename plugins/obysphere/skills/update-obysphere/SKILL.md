---
name: update-obysphere
description: Update Obysphere - the CLI and the person's Oby (obysphere update, --check, --rollback), a Sphere they run (obysphere server update), and this Claude Code plugin (claude plugin update obysphere@obysphere). Use when the person asks to update or upgrade Obysphere, the console or obysphere status says a newer Oby is out, a version doesn't match the Sphere's, or something broke after an update.
---

# Update Obysphere

Three things update separately: the CLI (with the person's Oby), a Sphere they run, and this plugin.

## What's out

```bash
obysphere update --check
obysphere status
```

`--check` says whether a newer version is out, without installing it. `status` (and `obysphere doctor`) compare this computer's version with the Sphere's and say which one to update. The console says "A newer Oby is out" too.

## The CLI and your Oby

```bash
obysphere update
```

It downloads the new version from GitHub (never from a Sphere), checks it against the release's `SHA256SUMS`, switches to it, and restarts the person's running Obys. Profiles and settings stay as they are. The previous version is kept:

- Back to it: `obysphere update --rollback`.
- To follow `main` (before the first release, or to try what's next): `obysphere update --channel main`. `obysphere update --channel stable` goes back to releases.

## A Sphere you run

Update the CLI first: a Sphere is redeployed with the version the CLI has.

```bash
obysphere server update <name>
```

It redeploys to a deployment recorded by `obysphere server deploy vercel`. With one recorded, the name can be left out. The records (in `~/.local/share/obysphere/servers/`) hold no secrets. Then `obysphere server status` checks it. Ask before running it: the Sphere restarts.

For a Sphere in Docker on this computer, name its container the first time:

```bash
obysphere server update --docker obysphere
```

It pulls `ghcr.io/obi-ai-bot/oby-sphere:<the CLI's version>` (`--tag <version>` picks another), runs it as that container again with the same ports, volume, variables and other settings, and puts the old one back if the new one doesn't answer. It never prints the container's variables (they hold the keys). Then it's recorded, so `obysphere server update` finds it like a Vercel deployment. It refuses, changing nothing, a container that Docker Compose runs (update it in Compose) or one it can't carry over; then update by hand: pull the new image and run it again the same way. Ask before running it: the Sphere restarts.

For Railway, redeploy from the repository in Railway.

## This plugin

```bash
claude plugin update obysphere@obysphere
```

Or in Claude Code: `/plugin`, then the installed `obysphere`, then update. Then run `/reload-plugins` or restart Claude Code. A new plugin version comes with each change to its `version`.

## If something broke

- `obysphere doctor` checks the setup and says what to fix.
- `obysphere logs` shows what the Oby did.
- `obysphere update --rollback` goes back to the previous version.
