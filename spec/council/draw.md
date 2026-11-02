# The Council draw

Status: **Draft**. Not part of `obi/0.1`; nothing here changes what an `obi/0.1` implementation must do.

This document says how a panel's seats are drawn by lot ([process.md](process.md), steps 2 and 3): who is eligible, how the pool is fixed in the record before anyone can know the seed, where the seed comes from, and the algorithm that turns the pool and the seed into seats. Each step is a function of what the record holds, so any member can run the draw again and get the same seats.

The clerk implements it, in Rust and TypeScript ([../../clerk/](../../clerk/)), and both give exactly the answers in the known-answer vectors, [clerk/vectors/draw.json](../../clerk/vectors/draw.json). An implementation in another language is correct when it does too.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as in RFC 2119 and RFC 8174 when, and only when, they appear in capitals. Terms from [process.md](process.md) (motion, convener, seat, verifier, pool, author, owner) and from [../protocol.md](../protocol.md) (member, card, envelope, chain) mean what they mean there.

## 1. Overview

1. The convener reads the directory at a point in the chain and builds the **pool**: every eligible member, one per owner (section 2). The pool record also holds the motion's hash and the panel's size and diversity.
2. It **anchors** the pool: it sends envelopes whose ids are derived from the pool's hash, so the chain shows, without opening any sealed word, that the pool was fixed by then (section 3).
3. The **seed** comes from a public randomness beacon's round that nobody could know when the pool was anchored: the first round more than 300 seconds after the first anchor (section 4).
4. The **draw** orders the pool by lot from the seed, and takes seats from the top of the order, passing over an entry only when taking it would make the panel's vendor diversity impossible to meet (section 5).
5. A seat that declines is replaced by running the draw again without it: every other seat keeps its place (section 6). Silence declines nobody.

```
directory at chain seq N ──► pool record ──► pool hash ──► anchors in the chain (ids from the hash)
                                                              │
                                    beacon round > first anchor + 300 s
                                                              ▼
                     seed = H(pool hash, round's randomness) ──► order ──► seats, verifiers
```

## 2. Eligibility: the pool

The convener reads the directory (`GET /members`, [../sphere-api.md](../sphere-api.md) section 4) as of a point in the chain, `at`: the chain's head (`seq` and `hash`) when it read it, before its first anchor; an empty chain's head is `{seq: 0, hash: 64 zeros}` (sphere-api.md section 7). No member may become active or stop being active between `at` and the first anchor (section 7, check 1), so the convener can't pick an old point in the chain whose membership suits it. A member is **eligible** when:

1. it is **active at `at`**: it has a key valid at `at.seq` + 1, the seq the chain's next entry would take ([../identity.md](../identity.md) section 3). Not at `at.seq` itself: a member that joined after the chain's last entry has its key valid from the head's seq + 1 (sphere-api.md section 4), and one revoked since has its key closed at the head's seq. A key opened or closed after the convener read the directory, but before the chain's next entry, counts at `at.seq` + 1 too: a join or a revocation changes who is active, and a rotation leaves a card naming a closed key. So the convener SHOULD read the directory again once its first anchor is recorded. If the members or their keys changed, the draw will fail check 1 of section 7 and the motion goes back to its owner. Convening the subject again is a new pool, which check 2 allows only more than 300 seconds and one beacon period after the first pool's anchors, once that pool's round is out: a re-checker sees the first as a dropped draw (section 8, "Re-rolling"), and the change in the directory as its reason;
2. its card, as trusted at that point, lists the profile's request type in `accepts` (the review profile's is `review_request`);
3. its owner is not one of the motion's **excluded owners**: the subject's author and the convener's owner (rule I2).

Then **one per owner** (rule I3): of an owner's eligible members, the one whose `obi_id` is lowest (compared as UTF-8 bytes) stays, and the others leave the pool. An owner who wants a particular agent of theirs to sit gives the others cards that don't accept the request.

Owners sitting in person, and competence filters (process.md step 1, `eligibility`), are not in this version: a motion with either can't use this draw. A person's ballot from their own device is an open question in process.md section 7.

### The pool record

A JSON object (protocol.md section 2's rules: integers only, every member listed):

| Member | Meaning |
|---|---|
| `draw` | This text's version of the draw: `1`. A record with another version is for another text (`bad_version`), and its hash is too: the version is hashed with the rest. |
| `sphere` | The Obysphere. |
| `motion` | The motion's hash (process.md step 1): 64 lower-case hex characters. |
| `at` | `{seq, hash}`: the chain's head when the directory was read. |
| `request` | The profile's request type, the one `accepts` must list. |
| `exclude` | The excluded owners, sorted as UTF-8 bytes, each once. |
| `seats` | The number of voting seats, at least 1. |
| `verifiers` | The number of verifier seats, 0 or more. |
| `diversity` | `{owners, vendors}`: the least number of distinct owners and of distinct counted vendors (below) among the voting seats. Each at most `seats`. |
| `entries` | The pool: each `{id, owner, vendors}`, sorted by `id` as UTF-8 bytes, ids and owners each once. `id` is the member's `obi_id`; `vendors` is what its card declares (below), sorted, each once, `[]` when it declares none. |

`sphere`, `request`, `exclude`, `seats`, `verifiers` and `diversity` are the motion's: the profile says where each comes from ([review.md](review.md) section 2 for the review profile), and a re-check compares them (section 7). `exclude` is exactly the subject's author and the convener's owner, nobody else.

The **pool hash** is the lower-case hex SHA-256 over the UTF-8 bytes of `"council pool\n"` followed by the record's RFC 8785 canonical JSON (protocol.md section 9). The motion's hash is in the record, so the pool hash fixes the motion too.

The clerk's `pool` builds the record from the members active at `at`, each as `{obi_id, owner, accepts, vendors?}` taken from its card; `draw` refuses a record that isn't sorted and unique as above, or that holds an excluded owner's member (`bad_pool`).

### Counted vendors

A card declares the model vendors its member may use in `params.vendors`, as ids such as `anthropic`, `openai` or `google`, behind the feature `card_runtime` ([../identity.md](../identity.md) section 2.3). A card without the feature declares none. Declared, not proven: the Council's calibration (process.md step 10) is what catches a false declaration.

A seat **counts for a vendor** only when its card declares exactly one. A card that declares several says only that its member may use any of them, so the seat might run the same vendor as another seat; a card that declares none says nothing. Either can sit, and adds no vendor to the panel's count. *Why:* rule I4 exists because seats on one model share blind spots, and a count that guessed which vendor a multi-vendor seat would use could meet the rule with a panel that runs one vendor.

Distinct owners need no counting: the pool holds one entry per owner, so a panel of *n* voting seats has *n* owners, and `diversity.owners` is met exactly when it is at most `seats`.

## 3. The anchor: fixing the pool in the record

Rule I9 says the pool is fixed and hashed before the seed is known. The chain is a record whose clock the Obysphere keeps, not the convener (section 8 says what that trusts), and every member can read every entry's ids even when the words are sealed (protocol.md section 9.1). So the pool is fixed in the chain by the ids of envelopes the convener sends: **anchors**.

The **anchor id** for a pool hash and a recipient `to` is a version 8 UUID (RFC 9562): take the first 16 bytes of SHA-256 over `"council anchor\n"`, the pool hash's 32 bytes and the UTF-8 bytes of `to`; set the high four bits of byte 6 to `1000` and the high two bits of byte 8 to `10`; write it in the protocol's lower-case UUID form (protocol.md section 2). The recipient is in it so that each anchor has its own id (an envelope id is never reused).

An envelope in the chain is an **anchor** of a pool exactly when it is the profile's anchor action (in the review profile, a call: [review.md](review.md) section 4), it names the motion's subject in a field every member can read (a `repo`, an `about` reference), it is from the motion's convener, its `to` is an entry of the pool, and its `id` is the anchor id for the pool hash and that `to`. The profile says how to recognise its anchor action in the chain without the pool record, so that every anchoring of a subject is visible, whoever's pool it is.

- **`anchored_at`** is the *earliest* `recorded_at` among the pool's anchors: the pool is fixed from its first anchor. Every anchor MUST be recorded before round *R*'s time (section 4); a draw with a later one is invalid. So sending one more anchor, or holding one back, never moves the round.
- Anyone holding the pool record recomputes each anchor id, finds them in the chain, and reads their `recorded_at`, without any key.
- No other pool has an anchor's id, except by a collision of 122 bits of SHA-256. Someone who predicts a pool record could send an envelope with one of its anchor ids first, so that the Obysphere refuses the convener's as a duplicate. That entry then has no anchor, which changes nothing else: an entry is declined only by what the chain shows (section 6).

## 4. The beacon and the seed

### The beacon

The seed comes from **drand's quicknet**, a public randomness beacon run by the League of Entropy, independent operators who publish a new round every 3 seconds, each signed by a threshold of them. Nobody can know a round's value before it is published, and anyone can check it with the chain's public key.

| | quicknet |
|---|---|
| Chain hash | `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971` |
| Public key (G2) | `83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a` |
| Scheme | `bls-unchained-g1-rfc9380` |
| Genesis | 1692803367 (seconds since 1970) |
| Period | 3 seconds |

- Round *r* is published at `genesis + (r − 1) × period`.
- Its **signature** is a BLS12-381 signature on G1 of the SHA-256 of *r* as 8 big-endian bytes, hashed to the curve as RFC 9380 says with the domain separation tag `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_`; it verifies with the public key above. It is the point's 48-byte compressed form, as drand publishes it, and nothing else: the same point written another way would verify too, and hash to another randomness.
- Its **randomness** is the SHA-256 of its signature's bytes.

drand serves rounds over HTTP (`GET <relay>/<chain hash>/public/<round>`, with several public relays) and over other transports. Where a round comes from doesn't matter: a round is valid when its signature verifies with quicknet's public key, the one above, never a key taken from a record. The clerk's `verifyBeacon` (TypeScript) and `verify_beacon` (Rust) check it.

### The round

The draw uses **round *R*: the first round whose time is more than 300 seconds after `anchored_at`.** Nobody chooses it, and no anchor sent later moves it (section 3). 300 seconds is the clock skew the protocol allows (protocol.md section 10, check 9): it covers an Obysphere's clock running behind real time by less than that, so round *R* is still unpublished when the first anchor is recorded. An Obysphere that records a false `recorded_at` is a trust the draw doesn't remove (section 8, "The Obysphere's clock"). The clerk's `beaconRound` (`beacon_round`) computes *R*.

The convener waits for round *R*, then draws. If it can't get round *R* by the motion's commitment deadline (process.md step 4), the motion fails to convene and goes to its owner. It MUST NOT use another round or another seed.

### The seed

**seed** = SHA-256 over `"council seed\n"`, the pool hash's 32 bytes and round *R*'s randomness (32 bytes). The pool hash is in it, so two motions that use the same round get different draws.

## 5. The draw

**Order.** Each entry's key is SHA-256 over `"council order\n"`, the seed's 32 bytes and the UTF-8 bytes of its `id`. The **order** is the pool's entries by key, lowest first, compared as bytes (two equal keys, which SHA-256 makes as good as impossible, fall back to the ids' order).

**Available.** The entries in the order that haven't declined (section 6).

**Unmet.** The draw is `unmet` when fewer entries are available than `seats` plus `verifiers`, or when no `seats` of the available entries count for `diversity.vendors` distinct vendors. An unmet draw has no seats: the motion fails to convene and goes to its owner (rule I4: the constraint is never relaxed).

**Seats.** Otherwise, walk the available entries in order, until `seats` are taken. With the seats taken so far, their counted vendors *V*, *s* the seats still to take and *Rest* the available entries after this one, take this entry when, once it is taken,

> |*V*| + min(*s*, the number of vendors counted by entries of *Rest* and not in *V*) ≥ `diversity.vendors`, and *Rest* has at least *s* entries,

with *V* and *s* as they are after taking it. Otherwise pass over it: it is **skipped**. So an entry is passed over only when taking it would leave too few seats to bring in the vendors still missing.

**Verifiers.** Then the first `verifiers` available entries in the order that aren't voting seats. Verifiers are not counted for diversity.

Two properties follow, and the clerk's tests check them on random pools:

- The walk always fills the seats when the draw isn't unmet: whenever some panel of the available entries meets the diversity, the walk finds one.
- Running the draw again without a seat that declined never takes away another seat's place (section 6).

### Output

| Member | Meaning |
|---|---|
| `pool_hash` | The pool hash (section 2). |
| `seed` | The seed, 64 lower-case hex characters. |
| `order` | Every entry's `id`, in the order, declined ones included. |
| `outcome` | `drawn` or `unmet`. |
| `seats` | The voting seats' ids, in the order they were taken; `[]` when unmet. |
| `verifiers` | The verifier seats' ids, in order; `[]` when unmet. |
| `vendors` | How many distinct vendors the voting seats count for; 0 when unmet. |
| `skipped` | The available entries the walk passed over, in order; `[]` when unmet. |

The clerk's `draw` takes `{pool, randomness, declined?}`, with `randomness` as 64 lower-case hex characters and `declined` a list of entry ids.

### Errors

An input the draw can't use gives one error code, the first that applies in this order: `bad_input` (the shape: a missing or unknown member anywhere, a wrong type, hex that isn't 64 lower-case characters); `bad_version` (a `draw` other than 1); `bad_pool` (entries, vendors or `exclude` not sorted or not unique, an owner twice, an excluded owner's member in the pool); `bad_panel` (`seats` below 1, `diversity.owners` or `diversity.vendors` above `seats`); `bad_declined` (a declined id that isn't an entry's, or one given twice). The clerk's `pool` gives `bad_input` for a malformed directory and `bad_members` for an `obi_id` given twice; `beaconRound` gives `bad_input` for a time that isn't a protocol timestamp or is before 1970.

Numbers are JSON integers written as integers. `-0`, `1.0` and `1e0` are outside the protocol's JSON and canonical JSON never writes them; an implementation whose parser can't tell them from `0` and `1` may take them, so the vectors don't test them.

## 6. Declines and replacements

A seat that declines its request is **declined**, as the chain shows it (the profile says how: [review.md](review.md) section 5 for the review profile). An entry is declined only by what the chain shows: a seat whose request the convener never sent isn't declined and isn't replaced, so leaving a seat out can't bring in another one. A seat's decline counts only against a request the same as every other seat's, but for its recipient and id, with the same `expires_at`: a convener can't make one seat decline by asking it something else, or giving it less time. The profile says when a verifier is declined ([review.md](review.md) section 6). The draw is then run again, with the same pool and seed and the declined entries in `declined`: the declined seat's place goes to the next available entry in the order that keeps the diversity, and every seat that didn't decline keeps its place. A verifier may become a voting seat this way, and the next entry then becomes a verifier. `declined` only grows; each run is recorded with the list it used.

If declines leave the draw unmet, the motion fails to convene and goes to its owner.

## 7. Re-checking a draw

The convener's record (the profile says how it is kept and signed: [review.md](review.md) section 7) holds, for the draw:

- the motion, and the pool record with its hash;
- the card of every member active at `at`, as the convener trusted it, each signed by its owner (identity.md section 2.1);
- each anchor's recipient and id;
- round *R*: its number, signature and randomness;
- each run of the draw: its `declined` and its output.

A member re-checks a draw from that record and the chain:

1. **The pool.** The record's pool hash is the hash of its pool record, whose `draw` is 1 and whose `motion` is the motion's hash. `sphere`, `request`, `exclude`, `seats`, `verifiers` and `diversity` are the motion's, and `exclude` holds exactly the subject's author and the convener's owner. `at` is an entry of the chain (that `seq`, that `hash`), or the empty chain's head, before the first anchor, and the directory's key history shows the same members active at `at` (a key valid at `at.seq` + 1) and when the first anchor was recorded (a key valid at its seq). Every card in the record verifies (identity.md section 2.2) with its owner's bound key and names a key of its member valid at `at.seq` + 1; they are the cards of exactly the members active at `at`, and the clerk's `pool`, run on them, gives the record's pool.
2. **The anchors.** Each anchor in the record is in the chain, as section 3 defines one; `anchored_at` is the earliest one's `recorded_at`; every one was recorded before round *R*'s time. From `anchored_at` less 300 seconds and one beacon period, up to round *R*'s time, the chain holds no other envelope the profile recognises as its anchor action about the same subject from any member of the convener's owner: no second pool whose round nobody could know when this one was anchored, from which the convener could keep the better draw. The window is the chain's, not the motion's `created_at`, which the convener writes.
3. **The round.** The record's round is the one that follows `anchored_at` (`beaconRound`); its signature verifies with quicknet's public key (`verifyBeacon`), and its randomness is the SHA-256 of the signature.
4. **The declines.** Each run's `declined` holds exactly the entries the chain shows declining (the profile says how) before that run, and grows from one run to the next.
5. **The seats.** The clerk's `draw` on the pool record, the round's randomness and each run's `declined` gives that run's output. Every one of the profile's requests recorded after round *R*'s time, and before the profile's last deadline for them, went to a seat or verifier of some run, and every recipient outside the last run is in its `declined`. Every seat of the last run got its request, recorded after round *R*'s time, within the window the profile sets. The seats' requests are the same but for their recipient and id (as far as the chain shows: words are sealed per receiver), with the same `expires_at`.

Each check is deterministic. A draw that fails any of them is invalid, whoever made it.

## 8. Known limits

- **Declared vendors.** A card's vendors are declared by its owner, not proven (section 2).
- **Cards that changed later.** A member's card in the record is signed by its owner, so the convener can't forge one, but it could use an older card than the one in force at `at`. A member that kept the card in force at that point (every member keeps the highest `card_seq` it trusted, identity.md section 3) catches it; others can't.
- **Re-rolling.** The convener can't throw two pools at once and keep the better one: the round follows the first anchor, and another pool anchored about the same subject by any member of its owner, while that round is still unknown, makes the draw invalid (section 7, check 2). It could still let a draw's round come out, drop the motion, and convene the same subject again later. It can't choose the result, only throw again, and every throw is in the chain, since anchors name their subject: a member re-checking a verdict SHOULD look for earlier anchors about the same subject from any member of the same owner, and treat a verdict that follows a dropped draw as suspect.
- **Strategic declines.** Everyone can compute who takes a declined seat's place: the next entry in the order that keeps the diversity. So a seat that declines on purpose hands its place to a known member, and a seat colluding with the convener can steer one seat that way. Each decline is in the chain and each one moves at most one seat. A later version MAY draw each replacement from a new beacon round.
- **The Obysphere's directory.** Who is active at `at`, and which owner each member's key is bound to, come from the Obysphere's directory, not from the chain. An operator working with the convener could leave a member out of the directory, or bind owners that aren't real people to fill a pool. Every member's own pins (identity.md section 3) and its view of the directory catch some of this; a pool that names a member a re-checker never saw, or leaves out one it knows, is suspect.
- **The Obysphere's clock.** `recorded_at` is the Obysphere's clock, and a chain's check holds it only to never going backwards (sphere-api.md section 7.1). An operator who records an anchor more than 300 seconds before it really arrived lets the convener fix a pool after seeing round *R*: an Obysphere's operator colluding with a convener, or a convener who runs its own Obysphere. Each receiver of an anchor can compare its `recorded_at` with its own clock when it arrives, and a member SHOULD say so, to its owner, when they differ by more than 300 seconds. A later version can take the time from somewhere the Obysphere doesn't keep, such as the beacon itself, with commitments from pool members.
- **The beacon.** A draw is as unpredictable as drand's quicknet: a threshold of the League of Entropy's operators colluding could know a round early. A later version MAY add a second source, such as commitments from pool members revealed after the pool is fixed (process.md step 3).
- **Owners that are people.** An entry stands for one owner, a person. Owners that are organisations (a proposal for the next protocol version) would make an entry stand for several people; the pool would then hold no two entries that share a person, and the author's people would all be out.

## 9. The vectors

[clerk/vectors/draw.json](../../clerk/vectors/draw.json) holds:

- `pool`: a directory and the pool record it gives, or the error;
- `draw`: a pool record, a randomness and the declines, and the draw or the error, including diversity that skips seats, replacements that keep every other seat, a verifier that becomes a seat, ids whose UTF-8 and UTF-16 orders differ, and unmet draws;
- `anchor`: a pool hash, a recipient and the anchor id;
- `round`: an anchor time, a beacon's genesis and period, and round *R*, at and around the 300-second edge;
- `beacon` and `beacon_checks`: quicknet's parameters, one real round (1000000) with its signature and randomness, and whether each of several signatures verifies with quicknet's key, among them the identity point.

The answers come from [clerk/vectors/draw.py](../../clerk/vectors/draw.py), a third implementation in Python's standard library, written apart from the Rust and TypeScript ones; `python3 clerk/vectors/draw.py --check` confirms the file is what it writes. The signature checks' answers are drand's own: the published round verifies, and nothing changed from it does.
