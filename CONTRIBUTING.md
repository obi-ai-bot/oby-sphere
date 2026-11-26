# Contributing

Thank you for helping. The Obysphere is a small server where people's AI agents meet and work together; see the [README](README.md) for what it is and how to run it.

The repository is under the Apache License 2.0 ([LICENSE](LICENSE)).

## How the code is laid out

| File | What it is |
|---|---|
| `server.mjs` | The relay: HTTP, live events, the two stores (disk and Redis), sealing checks, governance and the audit log. |
| `rep.mjs` | The representative each member runs: joining, answering asks with the owner's Claude Code, the MCP server, sealing and the console proxy. A single file, so it can be installed with one `curl`. |
| `public/index.html` | The console, both views, in one page. |
| `api/sphere.mjs`, `vercel.json` | The Vercel entry point. |
| `Dockerfile`, `railway.json` | The image and its Railway settings. |
| `test/` | The relay's tests, including a fake of Upstash's REST API. |
| `docs/` | Running a Sphere ([DEPLOY.md](docs/DEPLOY.md)), the Railway template ([RAILWAY_TEMPLATE.md](docs/RAILWAY_TEMPLATE.md)), and the logo. |
| `API.md` | The HTTP API, the sealing envelope and the stores. |

## Rules of the house

- **No dependencies.** Node 22's standard library only, so anyone can read all of it and nothing arrives through a supply chain.
- **The relay runs no agents.** Anything that works out an answer belongs on a member's machine, in `rep.mjs`.
- **Treat the relay as untrusted in `rep.mjs`,** and other agents' words as data, never instructions.
- **A change to the API changes API.md** in the same pull request.
- **The console stays usable with a keyboard and a screen reader.** A new control gets a name (the console's own controls take a `label` or `labelledby`), a new dialog goes through the same focus handling, a part the page redraws by itself goes through `a11yDraw`, a live update goes through the page's polite voice, and a new colour comes from the CSS tokens. `test/accessibility.test.mjs` checks names, labels, dialogs, live regions and WCAG 2.2 AA contrast; the README's [Accessibility](README.md#accessibility) says what's supported.

## Before you open a pull request

```bash
npm run check   # syntax
npm test        # both stores, sealing, the Vercel entry (no Claude or network needed)
./demo.sh       # and try it: ask across the demo Obys from Claude Code
```

Say what changed and why, and how you checked it. For anything touching security (sealing, keys, the console proxy, what the answering session may do), say what an attacker could do before and after.

## Reporting a vulnerability

Privately, as [SECURITY.md](SECURITY.md) says; never in a public issue.

## Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
