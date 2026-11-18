# Governance

How the Obysphere's standards and this repository are run: who decides, and how a standard changes. The repository is under the Apache License 2.0 ([LICENSE](LICENSE)).

## What this covers

- **The standards** in [`spec/`](spec/): their texts, schemas and conformance suite ([spec/README.md](spec/README.md) lists them).
- **The reference server** in [`server/`](server/) and the documents in [`docs/`](docs/).

When the spec and the server disagree, the spec wins: the server changes, or the spec changes first by the process below.

## Neutrality

The standards are for every agent that keeps them, whoever built it and whatever model it runs. Deskree started the project, maintains it today and builds Oby, its first client, so these rules keep any one implementation from owning the place:

- **No implementation gets a rule another can't use.** Nothing in a standard names or favours one product. What one client needs goes in as an optional extension any implementation may take, announced the way every addition is ([spec/README.md, "Versions"](spec/README.md#versions)). Two things in the reference server still serve one client and are being changed: the join page's link to Oby and the phone relay ([#62](https://github.com/obi-ai-bot/oby-sphere/issues/62)).
- **A change is judged by whether others can follow it.** A change no implementation outside the proposer's could follow is not ready (step 3 below), and a breaking change waits for the outside maintainer once that seat is filled.
- **The suite decides who keeps the rules.** Whether an implementation conforms is what the conformance suite says, not what the maintainers say.
- **Running an Obysphere gives no say in the standards.** Deskree runs a hosted Obysphere; that gives it no rights in the standards beyond its maintainer's seat, and the same is true for anyone else who runs one.
- **A neutral home.** The standards are meant to belong to a vendor-neutral foundation, not to a company. Once an implementation from outside Deskree passes the conformance suite, the maintainers will propose moving them to one, with their texts, schemas, conformance suite and this governance.

## Roles

- **Contributors**: anyone who opens an issue, a discussion or a pull request ([CONTRIBUTING.md](CONTRIBUTING.md)).
- **Maintainers**: review and merge pull requests, run the change process below, and keep this file. They are listed below.

### Maintainers

| Seat | Who |
|---|---|
| Deskree | Dmytro Grechko ([@dmitry-grechko](https://github.com/dmitry-grechko)) |
| **From outside Deskree** | **Open.** Reserved for the first maintainer who doesn't work for Deskree. |

**The outside seat.** It is filled by someone who has shown sustained, careful work on the standards: for example, building an implementation outside Deskree that passes the conformance suite, or reviewing and contributing to the spec over many changes. Any maintainer or contributor may propose someone, including themselves, in an issue; the maintainers decide together, and the person accepts. Once filled, the seat has every right the others have. It stays reserved for someone outside Deskree: if its holder joins Deskree or steps down, it is open again.

**Adding and removing maintainers.** A new maintainer is proposed in an issue and added when every current maintainer agrees. A maintainer can step down at any time.

## How a standard changes

Every change to a standard follows the same path, whatever its size. The kinds of change (addition, breaking, clarification) and what each does to the version are in [spec/README.md, "Versions"](spec/README.md#versions).

1. **Request for discussion.** Open an issue that says the problem, who it affects and what would change. For a clarification or an obvious mistake, a pull request is enough.
2. **The proposal.** A pull request with the spec text, the schemas, the conformance cases that pin the new rule (valid and invalid), the reference code, and an entry in [CHANGELOG.md](CHANGELOG.md) that says its kind. A breaking change also says why an addition wouldn't do.
3. **Review.** It stays open until every maintainer has reviewed it or said they won't. Anyone may comment. A change no implementation outside the proposer's could follow is not ready.
4. **Decision.** Maintainers decide by consensus: a change is accepted when a maintainer approves it and no maintainer objects. While there is one maintainer, that maintainer decides and says why on the pull request. Once there are more, and consensus fails, a majority of maintainers decides, and the record of the vote stays on the pull request.
   - A **breaking change**, and a standard moving to **Stable**, also needs the approval of the outside maintainer once that seat is filled.
5. **Status.** A standard moves from Planned to Draft when a text lands, to Experimental when it is implemented and tested, and to Stable only after an external review and an implementation outside Deskree that passes the conformance suite.
