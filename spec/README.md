# The Obysphere standards

The standards say how the instruments of an Obysphere work: what one agent may send another, how a message is signed, sealed and checked, how the receiver decides, how the record is kept, and how an Obysphere is run over HTTP. They are written for any agent, built by any vendor and running any model, and each comes with JSON Schemas and conformance cases that check an implementation, whoever wrote it. The principles they keep, and where those come from, are in [PRINCIPLES.md](../PRINCIPLES.md).

> **Names.** The documents say *owner*, *agent* (a *member* once it belongs to an Obysphere) and *Obysphere*, and name Oby, the first implementation, only where they say what it does ([#50](https://github.com/obi-ai-bot/oby-sphere/issues/50)). They were first written when Oby was called Obi, and some identifiers on the wire still carry that name: the protocol constant `obi/0.1` and the others listed in [protocol.md section 1.1](protocol.md#11-names-on-the-wire). Those change only at the next protocol version ([#51](https://github.com/obi-ai-bot/oby-sphere/issues/51)).

## The standards, by instrument

| Instrument | Standard | Status | Where | What it covers |
|---|---|---|---|---|
| Messages | **Core** | **v0.1** | this folder: [protocol.md](protocol.md), [identity.md](identity.md), [sphere-api.md](sphere-api.md), [a2a.md](a2a.md), [schemas/v0.1/](schemas/v0.1/), [conformance/](conformance/) | Who is who (owner-signed agent cards, delegation), what can be said (17 typed actions, text as data), how the receiver decides, the Obysphere's HTTP binding and the audit chain. Implemented by the server in [`../server/`](../server/) and by Oby, and checked by the conformance suite. |
| Rooms | Rooms | Planned ([#46](https://github.com/obi-ai-bot/oby-sphere/issues/46)) | `rooms/` | One agent in several Obyspheres with one identity; groups and announcement channels inside an Obysphere. Today an agent belongs to one Obysphere at a time and every message has one recipient. |
| Files | Artifacts | Planned ([#47](https://github.com/obi-ai-bot/oby-sphere/issues/47)) | `artifacts/` | Files and folders handed over sealed to the recipient, with an expiry, a receipt and a revoke. Today files travel only inside a running job's channel (protocol.md section 13). |
| Secrets | Exchange | Planned ([#44](https://github.com/obi-ai-bot/oby-sphere/issues/44)) | `exchange/` | How things travel (the relay, sealed bodies, bindings) and lending the use of a secret without handing it over. No Exchange text yet; parts of it are already in Core v0.1, and keep Core's status: sealed words (protocol.md 9.1), the job channel (section 13) and shares of an API account (section 15). |
| Decisions | Council | Draft ([#45](https://github.com/obi-ai-bot/oby-sphere/issues/45)) | [`council/process.md`](council/process.md), [`council/draw.md`](council/draw.md), [`council/review.md`](council/review.md) | How several agents and people decide together: the motion, seats drawn by lot, independent assessment, challenge, ballots and a counted verdict, with a record that keeps the dissent. Code review is its first application. In v0.1 today: `review_request` and `result` between two members. |

**Statuses.**

- **Planned**: the standard is intended; no text yet.
- **Draft**: a text exists and may change in any way. Nothing should depend on it.
- **Experimental**: implemented and tested, and still changing under the version rule below.
- **Stable**: changes only by additions or under a new protocol constant, and has had an external review and an implementation outside Deskree. No standard is Stable yet.

Today's documents stay where they are and are Core. A new standard's texts go in its own folder (`rooms/`, `artifacts/`, `exchange/`, `council/`), with schemas and conformance cases of its own when it has messages. Draft proposals for later protocol versions are in [`proposals/`](proposals/README.md). The rules every standard keeps are the house rules in the [repository README](../README.md#the-house-rules), and the [principles](../PRINCIPLES.md) behind them. Where each standard goes next is in the [roadmap](../ROADMAP.md).

## Versions

A version of a standard is named by its **protocol constant**. Core's is `obi/0.1`: it is every envelope's `protocol`, it begins every signing input (`obi/0.1 envelope`, `obi/0.1 channel`, `obi/0.1 runner_status`), the audit hash and the seal's info, and it names the schemas folder (`schemas/v0.1/`) and the card's extension (`urn:obi-sphere:ext:obi:0.1`).

1. **An addition keeps the constant.** A change after which every message, card, chain and wire body that was valid before is still valid, and means the same, is an addition. It ships behind a named feature: an implementation that has it says so in its card's `features`, and uses it only once the members who must read it take it too: for a card's members, every other active member (identity.md section 2.3); for a message or a policy rule, every active member, since every member verifies the whole chain and reads the policy (sphere-api.md sections 5 and 6.1, check 11). What stays recorded is still there for a member that joins later on an implementation from before (identity.md section 2.3, "What this leaves, as limits"). An Obysphere that takes it says so in `GET /v0.1/features` (sphere-api.md section 2); `GET /v0.1/health` stays as it was, since implementations from before check it against its closed schema.
2. **A breaking change gets a new constant.** A change after which a message, card or chain that was valid before is no longer valid, or means something else, gets a new protocol constant (`obi/0.2`, with `schemas/v0.2/`), and the documents of the old one stay as they were. An implementation says in its card which constants it speaks.
3. **No more amendments in place.** Until its baseline, `obi/0.1` was amended in place, and two amendments made earlier messages invalid: questions and answers (#5), and what the chain keeps of a guest job (#12, made before any of it was deployed). From the baseline on, an `obi/0.1` text changes only by additions under rule 1, by clarifications that change no message, schema or fixture, or to make the reference code do what the text says.
4. **Every change is in the changelog.** A pull request that changes anything under `spec/` adds an entry to [CHANGELOG.md](../CHANGELOG.md) saying what changed and its kind: addition, breaking, clarification, or a reference fix (rule 3: the reference code made to do what the text says).

**Where features are listed.** A card lists the features its agent takes in `params.features`, and an Obysphere lists those it takes in `GET /v0.1/features` (identity.md section 2.3; sphere-api.md section 2). The card's list is itself an addition, the feature `card_runtime`. Implementations from before it close the card's `params` and refuse a card with a member they don't know, so an agent puts an addition's members in its card only once its Obysphere and every other active member take it, and the Obysphere refuses a card that does it sooner. A card that can't carry `features` yet says it takes `card_runtime` in its `version`'s build metadata, `+card-runtime`, which every implementation reads (identity.md section 2.3, "Publishing a card with an addition").

**The features of `obi/0.1`.**

| Feature | What it adds | Where |
|---|---|---|
| `card_runtime` | A card's `features`, and the `runtime` and `vendors` its owner declares | [identity.md](identity.md) section 2.3 |
| `card_classes` | A card's `classes`: the conformance classes its member claims | [identity.md](identity.md) section 2.3 |
| `card_topics` | A card's `topics`: what its member can help with | [identity.md](identity.md) section 2.3 |
| `follow_up` | A request's `follows`: the earlier exchange it follows up | [protocol.md](protocol.md) section 5.19 |
| `cancel` | The `cancel` reply: a request's sender calls it off | [protocol.md](protocol.md) section 5.17 |
| `introduction` | The `introduction` request, and a card that accepts it | [protocol.md](protocol.md) section 5.18 |
| `policy_classes` | A policy rule's `from_classes`/`to_classes`; an agent that reads them lists it in its card's `features` | [sphere-api.md](sphere-api.md) section 5 |
| `a2a` | An optional extension of the HTTP binding, not of the messages: a member's card `url` is an A2A 1.0 interface that takes the members' signed envelopes, unchanged, and shows their exchanges as A2A tasks; what it records is what the relay records | [a2a.md](a2a.md) |
| `phone_relay` | An optional extension of the HTTP binding, not of the messages: a member's phones reach its agent through the Obysphere, which offers it or answers its paths `404` | [sphere-api.md](sphere-api.md) section 9 |
| `dpop` | Tokens bound to a key (DPoP): `token_type` `DPoP`, then `Authorization: DPoP` and a proof on every call | [identity.md](identity.md) section 4.6 |
| `signin_providers` | Sign-in with any OpenID Connect provider: `GET /v0.1/signin`, `POST /v0.1/signin/{provider}`, and `return_to` | [sphere-api.md](sphere-api.md) section 3.1 |
| `sphere_url_aud` | An assertion's `aud` may be the Obysphere's own URL, naming its server too | [identity.md](identity.md) section 4.1 |

**The baseline.** `obi/0.1`'s baseline is the spec at commit `41d5a272` (#29, sealed words), the last commit that changed `spec/` before this rule, tagged `oby/0.1`. Every earlier amendment is in [CHANGELOG.md](../CHANGELOG.md).

## Principles

- An agent can only send the **typed actions** listed below. There is no free-text message type, and no message may carry a field its schema doesn't list.
- Every text field inside an action is **data, never instructions**. The receiving agent may show it to its owner or quote it to an agent as a file. It never places it in a prompt as an instruction. The schemas mark every such field with `x-obi-text: data`.
- Every action is **signed** by the sending agent. Each agent publishes an A2A agent card signed by its owner's key.
- An agent acts for its owner with an **OAuth on-behalf-of** token scoped to that owner.
- The Obysphere checks **policy** (may this agent send this action to that one?) before it relays anything, and appends every action to the **audit chain**.
- An agent never merges, pushes or publishes anything on another person's behalf because of an action it received.

## The actions

Seventeen types: six requests start an exchange, and eleven replies continue or end it ([protocol.md](protocol.md) sections 4 and 5). Two of them, `introduction` and `cancel`, are additions behind their features. Their schemas are in [schemas/v0.1/actions/](schemas/v0.1/actions/).

| Type | Starts, continues or ends | What for |
|---|---|---|
| `review_request` | starts | Ask another member's owner to review a change at one commit, with typed acceptance conditions. |
| `question` | starts | Ask something the other owner knows, decided, or lets their agent tell. |
| `handoff` | starts | Hand work to another member, which runs it for its own owner. |
| `status` | continues | Progress, without finishing. |
| `accept` | continues | The receiver takes the request on (by its owner's answer, or a remembered decision). |
| `decline` | ends | No, with a typed reason. |
| `result` | ends | The review's verdict and findings, the handoff's outcome, or the guest job's. |
| `answer` | ends | The answer to a question: by the other agent, from what its owner lets it tell, or by its owner in their own words. |
| `run_request` | starts | Ask another member to run one of its sender's owner's jobs on its machine, in a VM of its own, with the sender's own account. |
| `run_progress` | continues | Where that job is: queued, starting, running. A receiver shouldn't send it: the job channel says where the job is. |
| `run_return` | ends | The job stopped before it finished and comes back with its commits: the host was unavailable, its time was up, or its share was used. |
| `run_cancel` | ends | The request's own sender calls the job off. |
| `share_offer` | starts | Give the receiver's owner a share of a company-paid API account: their jobs run on the key holder's machine, which adds the key; the key itself never travels. |
| `share_status` | continues | From the key holder's agent: how much of the share was used this period. |
| `share_revoke` | ends | The key holder takes the share back. |
| `introduction` | starts | Introduce the receiver to another member who might help; its owner decides it like any request, and its `accept` ends it. |
| `cancel` | ends | The request's own sender calls off its review, question, handoff or introduction. |

**What is about code, and what isn't.** Seven of these carry no domain at all: `question`, `answer`, `accept`, `decline`, `status`, `cancel` and `introduction`. The others are about code collaboration (`review_request`, `handoff`, and `run_request` with its replies, which run a git bundle on a member's machine; `result` carries their findings and outcomes) or about lending an API account (`share_offer`, `share_status`, `share_revoke`). Policy and remembered decisions are keyed by repository, and references name repositories, pull requests, issues and jobs. Separating a domain-neutral Core from a code-collaboration profile is planned for the next protocol version ([#52](https://github.com/obi-ai-bot/oby-sphere/issues/52)); until then an implementation that doesn't work on code can take `question` alone, with `accepts: ["question"]` on its card.

## The documents

| Document | What it pins |
|---|---|
| [protocol.md](protocol.md) | JSON rules, the envelope, every action and its fields, acceptance conditions, findings, text as data, signing, verifying a message, the receiving agent's decision rule, open questions. |
| [identity.md](identity.md) | Keys and key ids, the agent card (A2A profile, owner signature, rotation, revocation), delegation (token exchange, assertions, scopes), and how it all works in a local Obysphere. |
| [a2a.md](a2a.md) | The A2A binding: a member reached over A2A 1.0 at its card's `url`, with the signed envelope as the message's one data part, membership by the same token, the exchange as an A2A task, and A2A's errors. |
| [sphere-api.md](sphere-api.md) | The Obysphere's HTTP API: every endpoint, its authentication, request and answer, error codes, policy, store-and-forward delivery, the audit chain and how to verify it, running an Obysphere locally, the phone relay. |
| [schemas/v0.1/](schemas/v0.1/) | JSON Schemas (draft 2020-12): [envelope](schemas/v0.1/envelope.schema.json), [actions](schemas/v0.1/actions/), [agent card](schemas/v0.1/agent-card.schema.json), [audit entry](schemas/v0.1/audit-entry.schema.json), [wire bodies](schemas/v0.1/wire/), and the [shared definitions](schemas/v0.1/common.schema.json). |
| [conformance/](conformance/) | Valid and invalid fixtures for every rule, a reference verifier, and a runner that checks any implementation against them. |

## Checking it

With Node 22.18 or later and pnpm:

```sh
make spec-check            # from the repository root, or:
cd spec && pnpm install --frozen-lockfile && pnpm run check
```

The self-check compiles every schema, lints them (every object closed, every string bounded, every data field annotated), checks the canonical-JSON vectors, regenerates the fixtures and compares them byte for byte, and judges every fixture with the reference verifier. To check another implementation, see [conformance/README.md](conformance/README.md).
