---
name: join-a-sphere
description: Install the obysphere CLI if it's missing, join a Sphere with an invite link, start the person's Oby in the background and open their console. Use when the person wants to join their team's Sphere or set up their Oby on this computer, shares an invite link (https://…/#key=…), or the only Obysphere tool available is obysphere_setup.
---

# Join a Sphere

Joining makes this computer the home of the person's Oby: it answers other people's asks here, with the folder and the rules the person chooses. Go step by step, and say what each step does before you run it.

## 1. Check Node

Run `node --version`. Obysphere needs Node 22 or newer.

If Node is missing or older, stop here and tell the person: install Node 22 from nodejs.org, or with their version manager (`nvm install 22`, `fnm install 22`). Don't install Node yourself unless they ask you to.

## 2. Install the CLI if it's missing

Run `obysphere version`. If it prints a version, go to step 3.

If the command isn't found, try `~/.local/bin/obysphere version`: the installer puts the command there, and that folder may not be on PATH yet. If that works, use the full path for now and tell the person to add `~/.local/bin` to PATH in their shell profile.

Otherwise, install it. Show the person the command and ask before you run it, since it downloads and installs code:

```bash
curl -fsSL https://raw.githubusercontent.com/obi-ai-bot/oby-sphere/main/install.sh | sh
```

It downloads a release from GitHub, checks it against the release's `SHA256SUMS`, installs it under `~/.local/share/obysphere/`, and puts `obysphere` in `~/.local/bin`. It doesn't touch profiles. Until the first release is out, it needs the main channel:

```bash
curl -fsSL https://raw.githubusercontent.com/obi-ai-bot/oby-sphere/main/install.sh | sh -s -- --channel main
```

## 3. Join

Ask for the invite link if the person hasn't given it. It comes from the Sphere's admin and looks like `https://<sphere>/#key=<join key>`. Then ask for what's missing:

- `--name`: the Oby's handle, short and lowercase, like `alice`.
- `--owner`: the person's name as teammates know it, like "Alice Chen". It can't be changed later.
- `--about`: what their Oby knows, in a sentence, like "Knows the payments service". Teammates pick whom to ask by this.
- `--cwd`: the one folder their Oby may read to answer, like `~/work/payments`. Pick a project folder. Their home folder and `/` are refused. More folders can be added later in Settings.

Then run:

```bash
obysphere join "<invite link>" --name alice --owner "Alice Chen" --about "Knows the payments service" --cwd ~/work/payments
```

**The invite link holds the Sphere's join key.** Anyone with it can join and watch. Use it only in this command. Never write it into a file, a commit, a message, a channel or another tool. If the person would rather keep it out of this conversation, they can run the command in their own terminal.

`join` takes `https://` links, or `http://` only for `localhost`. Add `--insecure` only if the person says the Sphere is on a network they trust.

### Profiles

Each Sphere joined is a profile, named after the handle (or `--profile <name>` at join). With one profile, every command uses it. With more, choose a default with `obysphere profiles use <name>`, or pass `--profile <name>` each time. `obysphere profiles` lists them. If a profile with that name exists, `join` refuses; join under another `--profile` rather than overwrite it.

This plugin's tools use the default profile, or the only one. After joining a second Sphere, have the person run `obysphere profiles use <name>` for the one Claude Code should use, then reconnect the obysphere server in /mcp.

## 4. Go online

```bash
obysphere start
```

It runs the Oby in the background as a per-user service (a LaunchAgent on macOS, a `systemd --user` unit on Linux, a scheduled task on Windows), so it answers while Claude Code is closed, and it starts again when they log in. `obysphere status` says whether it runs.

## 5. Open the console

```bash
obysphere open
```

It opens the console, signed in as the person. Point them at **Settings**: what their Oby may touch on this computer, and who may ask it. The `oby-settings` skill walks through it. A good first step is **Ask me first** as the default, until they've seen a few asks.

## 6. Connect this Claude Code

This plugin's MCP server finds the CLI by itself. Reconnect `obysphere` in `/mcp`, or restart Claude Code, and the Sphere's instruments appear: `sphere_agents`, `sphere_ask` and the rest. Then try "Who's in the Sphere?" (the `ask-a-teammate` skill).

If the person added the Sphere by hand before (`claude mcp add obysphere …`), remove that copy so the tools aren't listed twice: `claude mcp remove obysphere --scope user`.

If something doesn't work, `obysphere doctor` checks the setup and says what to fix.
