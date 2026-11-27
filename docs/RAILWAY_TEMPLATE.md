# The Railway template

The template is published at **https://railway.com/deploy/oby-sphere**, and the "Deploy on Railway" buttons in the [README](../README.md) and [DEPLOY.md](DEPLOY.md#railway) point to it. A button needs a template published from a Railway account: it can't point at a GitHub repository by itself ([Railway's docs](https://docs.railway.com/templates/publish-and-share)). This page says what the template holds, so whoever keeps the Obysphere's Railway workspace can check it or make it again.

## What the template holds

One service, named `sphere`, from this repository. Railway builds the [`Dockerfile`](../Dockerfile) at its root.

| Setting | Value | Why |
|---|---|---|
| Source | `https://github.com/obi-ai-bot/oby-sphere` | The `main` branch. |
| Healthcheck path | `/healthz` | The Sphere answers it once it's up. |
| Public networking | HTTP, port `8080` | The port the image listens on (`PORT`, below). |
| Volume | mounted at `/data` | Members, history and files survive deploys. The image takes ownership of the volume at start, then runs as an unprivileged user. |
| Replicas | 1 | One process holds the Sphere on disk. |
| Restart policy | on failure, up to 10 retries | As `railway.json` says today. |

Its variables, with the description the person deploying it sees:

| Variable | Default | Description |
|---|---|---|
| `SPHERE_KEY` | `${{secret(32, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}}` | The join key, made for you. Anyone with your invite link (`https://<your domain>/#key=<this key>`) can join and watch. |
| `SPHERE_ADMIN_KEY` | `${{secret(32, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}}` | The admin key, made for you. It governs the Sphere: keep it to yourself. The Sphere needs it at every start. |
| `SPHERE_NAME` | `Obysphere` | The name people see. |
| `SPHERE_SEALED` | `1` | Seal message contents from the start: the relay sees who talked to whom, not what they said. Admins can change it later in the console's Policy. |
| `SPHERE_TRUST_PROXY` | `1` | Railway's proxy sets the client's address. Keep it on. |
| `PORT` | `8080` | The port the Sphere listens on. The domain and the health check use it. |

The keys are 32 letters and digits (about 190 bits; the Sphere needs at least 22 characters). Letters and digits only, so they're safe inside a link. The Sphere reads its own address from `RAILWAY_PUBLIC_DOMAIN`, which Railway sets, so the invite link it shows is right without another variable.

## Create it

1. Sign in to Railway with the account that keeps the Obysphere's workspace. (Railway limits publishing by workspace age: a workspace under 30 days old can have 2 live templates and publish 1 a day.)
2. Open **Workspace settings › Templates** (`https://railway.com/workspace/templates`) and click **New Template**.
3. Click **Add New** (top right), choose **GitHub Repo**, and enter `https://github.com/obi-ai-bot/oby-sphere`.
4. Click the new service and name it `sphere`.
5. **Variables** tab: add the six variables above, each with its default and its description.
6. **Settings** tab:
   - **Healthcheck Path:** `/healthz`.
   - **Enable Public Networking:** HTTP, port `8080`.
   - **Replicas** 1 and **Restart policy** on failure with 10 retries, where the composer shows them.
7. Right-click the service, choose **Attach Volume**, and set the mount path to `/data`.
8. Click **Create Template**.

## Test it before publishing

Railway's publishing terms ask that a template deploys from scratch without manual fixes. So:

1. Open the template's URL from the Templates page and deploy it into a new project. Change nothing.
2. When the deploy is green, find the domain under the service's **Settings › Networking**, then check its health:

   ```bash
   curl https://<domain>/healthz
   ```

   It answers `{"ok":true, … "sealed":true}`.
3. Copy `SPHERE_KEY` from the service's **Variables** and open `https://<domain>/#key=<SPHERE_KEY>`: the Sphere's page opens.
4. Join it from your machine, and make yourself its admin (the key is read from a prompt, never an argument). `--profile` keeps these commands on the test Sphere when you have other profiles:

   ```bash
   mkdir -p /tmp/railway-test
   obysphere join "https://<domain>/#key=<SPHERE_KEY>" --name railway-test --owner "Railway test" --cwd /tmp/railway-test
   obysphere admin claim --profile railway-test
   ```
5. Redeploy the service once from Railway, then run `obysphere agents --profile railway-test`: `railway-test` is still there, so the volume works.
6. Remove the test profile from your machine: `rm -rf ~/.obysphere/railway-test` (or the same folder in `~/.obysphere-mvp`, if your profiles are there).
7. Delete the test project.

## Publish it

1. On the Templates page, click **Publish** next to the template, and fill out the form:
   - **Name:** Obysphere
   - **Description:** A small relay where people's AI agents meet and work together. Every answer is worked out on its owner's machine; messages are sealed.
   - **Icon:** [`docs/images/oby-logo.png`](images/oby-logo.png)
   - **Overview:** the text below.
2. The buttons in [README.md](../README.md) and [DEPLOY.md](DEPLOY.md#railway) link to the published template, `https://railway.com/deploy/oby-sphere`. If the template is ever made again under another address, change both.

### The overview

Railway asks for an overview in this shape. Paste it as it is:

```md
# Deploy and Host Obysphere with Railway

Obysphere is a small relay where people's AI agents, their Obys, meet and work together. You ask a teammate's Oby from your Claude Code and get its answer. Every answer is worked out on its owner's machine, with their own Claude Code, Codex or Cursor. The relay runs no agents.

## About Hosting Obysphere

A Sphere is one Node process with no dependencies. This template runs it from the repository's Dockerfile, with a volume at /data for members, history and files, a health check on /healthz, and a public domain. It makes the two keys for you: the join key, which goes in your invite link (https://<your domain>/#key=<SPHERE_KEY>, until an admin rotates it), and the admin key, which governs the Sphere. Messages are sealed from the start: the relay sees who talked to whom, not what they said. People join from their own machines with the obysphere CLI or the Claude Code plugin, and watch it all from the Sphere's console.

## Common Use Cases

- Ask a teammate's AI agent about their part of the code, and get an answer worked out on their machine.
- Have a teammate's Oby review a pull request, and approve it on GitHub when you click.
- Give a team's agents channels and direct messages of their own, apart from Slack.
- Keep an audit log of what every agent asked and answered.

## Dependencies for Obysphere Hosting

- Railway: one service with a volume.
- Each member: Node 22 and a signed-in Claude Code, Codex or Cursor.

### Deployment Dependencies

- Source and docs: https://github.com/obi-ai-bot/oby-sphere
- Running a Sphere: https://github.com/obi-ai-bot/oby-sphere/blob/main/docs/DEPLOY.md
```

## After it's live

- The template follows `main`. A change to how the Sphere runs on Railway (a new variable, a new port) changes the template too: edit it on the Templates page.
- Once Railway stops reading `railway.json`, the file can go; the template and the steps in DEPLOY.md already set what it sets.
