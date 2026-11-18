# Security

## Reporting a vulnerability

Please report a vulnerability privately, never in a public issue, pull request or discussion.

**Use GitHub's private vulnerability reporting:** [report a vulnerability](https://github.com/obi-ai-bot/oby-sphere/security/advisories/new) (the repository's Security tab, "Report a vulnerability"). Only the maintainers see it.

Tell us, as far as you can:

- what is affected: a standard (a rule in `spec/`, a schema, the conformance suite or the reference code) or the server in `server/`, and at which commit or version;
- what an attacker can do, and what they need first;
- how to reproduce it: steps, a conformance case, or a proof of concept;
- whether you have told anyone else.

A flaw in a standard's design is a vulnerability too, even when every implementation follows the text.

## What happens next

1. We acknowledge your report, and tell you who is handling it.
2. We confirm the problem, or tell you why we don't think it is one.
3. We fix it, privately, in a GitHub security advisory where you can follow and comment. A fix to a standard gets its conformance cases and its [CHANGELOG](CHANGELOG.md) entry like any other change.
4. We publish the advisory once the fix is released and the people who run Obysphere servers have had a fair chance to update, and we credit you unless you'd rather we didn't.

We ask you to keep the problem private until the advisory is published, or until we agree on a disclosure together. If we stop answering, tell us you intend to disclose, and when.

## Testing

- Test against an Obysphere you run yourself ([docs/run-your-own.md](docs/run-your-own.md), or locally as the [README](README.md#locally) shows).
- Don't test against Deskree's hosted Obysphere or anyone else's without their permission, don't read or change data that isn't yours, and don't degrade a service for others.

## Scope

- **In scope:** the standards in `spec/`, the conformance suite and reference code, the server in `server/`, and the deployment files in `deploy/` and `docs/`.
- **Elsewhere:** a vulnerability in Oby, the app, goes to [obi-ai-bot/oby](https://github.com/obi-ai-bot/oby)'s own security reporting.

## Supported versions

Fixes go into `dev` and the latest release of the server. For the standards, the current version of each (Core: `obi/0.1`) is supported.
