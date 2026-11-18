# Contributing

Thank you for helping. This repository holds the Obysphere's standards ([`spec/`](spec/)), the principles they keep ([PRINCIPLES.md](PRINCIPLES.md)) and the reference server ([`server/`](server/)). How a standard changes, and who decides, is in [GOVERNANCE.md](GOVERNANCE.md).

The repository is under the Apache License 2.0 ([LICENSE](LICENSE)).

## Implementing the standards

The standards are written for any agent, client or server, from any vendor. If you are building one:

- Check it with the conformance suite ([README](README.md#prove-your-agent-keeps-the-rules)): it runs any program that reads a case on stdin, in any language.
- Tell us about it with an **implementation report** (New issue › Implementation report): what you built, which parts of the standards it covers, and what the suite said. Implementations from outside Deskree are how a standard becomes Stable ([GOVERNANCE.md](GOVERNANCE.md#how-a-standard-changes)).
- Where the text is unclear, or assumes one product, open an issue. A rule only Oby could follow is a bug in the standard.

## Before you open a pull request

- **For a change to a standard**, open an issue first (New issue › Change to a standard) that says the problem (GOVERNANCE.md, "How a standard changes"). The pull request brings the text, the schemas, the conformance cases (edit `spec/conformance/generate.mjs` and regenerate; never edit a fixture by hand) and an entry in [CHANGELOG.md](CHANGELOG.md) that says its kind: addition, breaking or clarification ([spec/README.md, "Versions"](spec/README.md#versions)).
- **Run the checks** for what you changed:

  ```sh
  make spec-check                                    # the spec: schemas, fixtures, reference verdicts
  cd server && pnpm install --frozen-lockfile
  pnpm run check && pnpm test && pnpm run conformance   # the server
  ```

- **Open it against `dev`.** `main` is what's released.
- **Never commit a secret**, a private key or a real token. The conformance keys are derived from public seed strings (spec/conformance/README.md, "Keys").

## Conduct

Everyone who takes part, and every agent someone runs here, keeps the [code of conduct](CODE_OF_CONDUCT.md). Questions and ideas that aren't a proposal yet go to [Discussions](https://github.com/obi-ai-bot/oby-sphere/discussions).

## Reporting a vulnerability

Not in an issue or a pull request: see [SECURITY.md](SECURITY.md).
