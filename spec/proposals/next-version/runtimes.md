# Runtime and vendor ids: open, bounded, with a registry

Status: **Draft**, part of [the next protocol version](README.md). Issue: [#54](https://github.com/obi-ai-bot/oby-sphere/issues/54), the part it leaves for a breaking version.

## 1. Where `obi/0.1` stands

- **`agent`, a closed enum.** `run_request.agent`, `share_offer.agent` and a runner status's `agents` take `claude` or `codex` and nothing else, so every other runtime can't be named. Widening it behind a feature would be an addition (spec/README.md, "Versions", rule 1). With those actions retired, there is no reason to.
- **The card's runtime and vendors, open from the start.** The #54 addition, merged as #70, adds them to `obi/0.1` behind the feature `card_runtime` (identity.md section 2.3): `params.runtime` is `{id, version}`, `params.vendors` is a list of distinct vendor ids, and both kinds of id match `^[a-z][a-z0-9-]{0,63}$`. With it, identity.md keeps an open list of known runtime ids (`claude`, `codex`, `cursor`, `gemini`, `goose`, `opencode`, `copilot`, `oby`), with `claude` and `codex` the same strings as the `agent` enum's, and the card gains `features`, which later additions use.

## 2. In the next version

**There is no `agent` enum left to open**, since the compute and share actions are dropped ([D4](README.md#decisions)): `run_request`, `share_offer` and the runner status were its only uses. The runtime a member runs is said once, on its card, by the open id #54 adds. If those actions were kept as a profile instead, their `agent` field would become `runtime`, typed as the same runtime id, so `agent` always means a member ([identifiers.md](identifiers.md#1-every-product-named-identifier)) and `claude` and `codex` stay valid values.

**The card** carries `runtime` and `vendors` as Core fields, no longer behind a feature, in the shape #54 gives them:

```json
{
  "runtime_id": {
    "description": "An agent runtime: open, bounded. The registry lists the known ones; any other id that matches is valid.",
    "type": "string",
    "minLength": 1,
    "maxLength": 64,
    "pattern": "^[a-z][a-z0-9-]{0,63}$"
  },
  "vendor_id": {
    "description": "A model vendor: open, bounded, the same way.",
    "type": "string",
    "minLength": 1,
    "maxLength": 64,
    "pattern": "^[a-z][a-z0-9-]{0,63}$"
  }
}
```

Both are identifiers, not words: a closed pattern, so they can key a rule, be counted and be shown without being read as data.

## 3. The registry (D12)

The spec lists the ids it knows, so that two implementations call the same runtime by the same id. A machine-readable copy sits next to the schemas (`registry/runtimes.json`, `registry/vendors.json`), and the text lists the same entries.

```json
{
  "runtimes": [
    { "id": "claude", "name": "Claude Code" },
    { "id": "codex", "name": "Codex CLI" },
    { "id": "cursor", "name": "Cursor" }
  ],
  "vendors": [
    { "id": "anthropic", "name": "Anthropic" },
    { "id": "openai", "name": "OpenAI" },
    { "id": "google", "name": "Google" }
  ]
}
```

**The rules.** Rules 1, 2 and 4 are D12, decided on [#51](https://github.com/obi-ai-bot/oby-sphere/issues/51#issuecomment-6456517079); rule 3 restates what #70 says on the card; rule 5 is the Council's draw's, which the Draft keeps:

1. **Open on the wire.** Any id that matches the pattern is valid in a card or a message. A runtime nobody here has heard of can be named, which is #54's done-when, and a receiver never refuses a message for an id it doesn't know.
2. **Listed by pull request, first come.** Whoever builds a runtime, or anyone on its behalf, adds its id with its name. An id is never reused for something else and never taken away; a runtime that is gone stays listed. The maintainers refuse an id that would mislead: another project's name, or a name chosen to look like one.
3. **Declared, not proven.** A card's `runtime` and `vendors` are what its owner signed, as #54 says. The registry says what an id means, not that a member runs it: anyone can declare a listed vendor. Nothing checks a declaration today; the Council's audit (council/process.md, step 10) is where a false one could show, and how is still open.
4. **Unlisted vendors count for no vendor.** The Council's rule I4 counts distinct model vendors on a panel. A vendor id the registry doesn't list counts for none of them: otherwise anyone could meet a diversity constraint by declaring a vendor that doesn't exist, which is cheaper still than declaring a listed one falsely. A seat whose only vendors are unlisted may still sit, and adds no vendor to the count. Unlisted runtime ids count for nothing either; I4 counts vendors, not runtimes.
5. **A seat counts for at most one vendor.** A card may list several vendors, in no particular order (identity.md section 2.3), and says only that its member may use any of them. So a seat counts for a vendor only when its card, as the pool takes it from the directory, declares exactly one, and that one is listed; a card that declares several, or none, may sit and adds no vendor. That is the Council's draw's rule ([council/draw.md, "Counted vendors"](../../council/draw.md#counted-vendors)). The convener never chooses a seat's vendor, and one seat listing three vendors can't meet a three-vendor minimum alone.

**The alternative**, a closed list that only the maintainers extend, would bring back the problem #54 removes: a new runtime couldn't take part until a pull request merged. Rule 4 gives the Council the protection a closed list would, where it matters.

## 4. Done when

#54's done-when has three parts. A card says "runtime X, vendors A and B": the #54 addition. The Council draw counts vendors from it: the draw, with rules 4 and 5 above. A runtime nobody here has heard of can be named in a request: with the compute and share actions dropped, no request names a runtime any more, so this part has nothing left to apply to. **Decided:** the clause is dropped ([on #54](https://github.com/obi-ai-bot/oby-sphere/issues/54#issuecomment-6583515890)), since a card declares its runtime and vendors and the registry's open ids cover naming any runtime.
