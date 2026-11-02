#!/usr/bin/env python3
"""Writes clerk/vectors/draw.json: the known-answer vectors for the draw (spec/council/draw.md).

This is a third implementation, in Python with its standard library only, written from draw.md and
kept apart from the Rust and TypeScript ones: the vectors' answers come from here, and both
implementations must give them. `python3 clerk/vectors/draw.py` rewrites the file; `--check` only
compares. Every input is listed below, by hand.
"""

import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

HEX = set("0123456789abcdef")
MAX_INT = 2**53 - 1
CLOCK_SKEW = 300


class DrawError(Exception):
    pass


def fail(code):
    raise DrawError(code)


# RFC 8785 canonical JSON, for the values the draw hashes: objects, arrays, strings, integers.
def canonical(v):
    if isinstance(v, dict):
        keys = sorted(v, key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(canonical_str(k) + ":" + canonical(v[k]) for k in keys) + "}"
    if isinstance(v, list):
        return "[" + ",".join(canonical(x) for x in v) + "]"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, str):
        return canonical_str(v)
    if v is None:
        return "null"
    raise TypeError(v)


def canonical_str(s):
    out = ['"']
    for ch in s:
        c = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif c < 0x20:
            out.append("\\u%04x" % c)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def sha(*parts):
    h = hashlib.sha256()
    for p in parts:
        h.update(p)
    return h.digest()


def is_obj(v):
    return isinstance(v, dict)


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= MAX_INT


def is_id(v):
    return isinstance(v, str) and len(v) > 0


def is_ids(v):
    return isinstance(v, list) and all(is_id(x) for x in v)


def is_hex(v):
    return isinstance(v, str) and len(v) == 64 and set(v) <= HEX


def exact(o, keys, optional=()):
    return is_obj(o) and set(o) >= set(keys) and set(o) <= set(keys) | set(optional)


def b(s):
    return s.encode("utf-8")


# --- Eligibility (draw.md section 2) ---------------------------------------------------------------


def check_terms(o):
    """The members a pool request and a pool record share: everything but the members or entries."""
    if not (is_id(o.get("sphere")) and is_hex(o.get("motion")) and is_id(o.get("request"))):
        fail("bad_input")
    at = o.get("at")
    if not (exact(at, ["seq", "hash"]) and is_int(at["seq"]) and is_hex(at["hash"])):
        fail("bad_input")
    if not is_ids(o.get("exclude")):
        fail("bad_input")
    if not (is_int(o.get("seats")) and is_int(o.get("verifiers"))):
        fail("bad_input")
    d = o.get("diversity")
    if not (exact(d, ["owners", "vendors"]) and is_int(d["owners"]) and is_int(d["vendors"])):
        fail("bad_input")


TERMS = ["sphere", "motion", "at", "request", "exclude", "seats", "verifiers", "diversity"]
VERSION = 1


def pool(inp):
    if not exact(inp, TERMS + ["members"]):
        fail("bad_input")
    check_terms(inp)
    members = inp["members"]
    if not isinstance(members, list):
        fail("bad_input")
    for m in members:
        if not exact(m, ["obi_id", "owner", "accepts"], ["vendors"]):
            fail("bad_input")
        if not (is_id(m["obi_id"]) and is_id(m["owner"]) and is_ids(m["accepts"])):
            fail("bad_input")
        if "vendors" in m and not is_ids(m["vendors"]):
            fail("bad_input")
    ids = [m["obi_id"] for m in members]
    if len(set(ids)) != len(ids):
        fail("bad_members")
    best = {}
    for m in members:
        if inp["request"] not in m["accepts"] or m["owner"] in inp["exclude"]:
            continue
        cur = best.get(m["owner"])
        if cur is None or b(m["obi_id"]) < b(cur["obi_id"]):
            best[m["owner"]] = m
    entries = [
        {"id": m["obi_id"], "owner": m["owner"], "vendors": sorted(set(m.get("vendors", [])), key=b)}
        for m in best.values()
    ]
    entries.sort(key=lambda e: b(e["id"]))
    out = {"draw": VERSION}
    out.update({k: inp[k] for k in TERMS})
    out["exclude"] = sorted(set(inp["exclude"]), key=b)
    out["entries"] = entries
    return out


# --- The anchor, the round and the seed (sections 3 and 4) ---------------------------------------


def anchor_id(pool_hash_hex, to):
    d = bytearray(sha(b"council anchor\n", bytes.fromhex(pool_hash_hex), b(to))[:16])
    d[6] = (d[6] & 0x0F) | 0x80
    d[8] = (d[8] & 0x3F) | 0x80
    h = d.hex()
    return f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


TIMESTAMP = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")


def beacon_round(anchored_at, genesis_time, period):
    """The first round whose time is more than CLOCK_SKEW seconds after anchored_at."""
    if not (isinstance(anchored_at, str) and TIMESTAMP.match(anchored_at)):
        fail("bad_input")
    try:
        t = int(datetime.strptime(anchored_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())
    except ValueError:
        fail("bad_input")
    if t < 0:
        fail("bad_input")
    t += CLOCK_SKEW
    if t < genesis_time:
        return 1
    return (t - genesis_time) // period + 2


def pool_hash(record):
    return sha(b"council pool\n", canonical(record).encode("utf-8")).hex()


# --- The draw (sections 5 to 7) ----------------------------------------------------------------------


def counted(entry):
    return entry["vendors"][0] if len(entry["vendors"]) == 1 else None


def can_meet(taken_vendors, slots, rest, need):
    """Whether `slots` more seats from `rest` can bring the counted vendors to `need`."""
    new = {counted(e) for e in rest if counted(e) is not None} - taken_vendors
    return len(rest) >= slots and len(taken_vendors) + min(slots, len(new)) >= need


def draw(inp):
    if not exact(inp, ["pool", "randomness"], ["declined"]):
        fail("bad_input")
    rec = inp["pool"]
    if not exact(rec, ["draw"] + TERMS + ["entries"]):
        fail("bad_input")
    check_terms(rec)
    if not is_int(rec["draw"]):
        fail("bad_input")
    if not is_hex(inp["randomness"]):
        fail("bad_input")
    declined = inp.get("declined", [])
    if not is_ids(declined):
        fail("bad_input")
    entries = rec["entries"]
    if not isinstance(entries, list):
        fail("bad_input")
    for e in entries:
        if not (exact(e, ["id", "owner", "vendors"]) and is_id(e["id"]) and is_id(e["owner"]) and is_ids(e["vendors"])):
            fail("bad_input")

    if rec["draw"] != VERSION:
        fail("bad_version")

    ids = [b(e["id"]) for e in entries]
    if any(ids[i] >= ids[i + 1] for i in range(len(ids) - 1)):
        fail("bad_pool")
    if len({e["owner"] for e in entries}) != len(entries):
        fail("bad_pool")
    for e in entries:
        vs = [b(v) for v in e["vendors"]]
        if any(vs[i] >= vs[i + 1] for i in range(len(vs) - 1)):
            fail("bad_pool")
    ex = [b(x) for x in rec["exclude"]]
    if any(ex[i] >= ex[i + 1] for i in range(len(ex) - 1)):
        fail("bad_pool")
    if any(e["owner"] in rec["exclude"] for e in entries):
        fail("bad_pool")

    seats, verifiers, div = rec["seats"], rec["verifiers"], rec["diversity"]
    if seats < 1 or div["owners"] > seats or div["vendors"] > seats:
        fail("bad_panel")

    if len(set(declined)) != len(declined) or any(d not in {e["id"] for e in entries} for d in declined):
        fail("bad_declined")

    ph = pool_hash(rec)
    seed = sha(b"council seed\n", bytes.fromhex(ph), bytes.fromhex(inp["randomness"]))
    keyed = sorted(entries, key=lambda e: (sha(b"council order\n", seed, b(e["id"])), b(e["id"])))
    order = [e["id"] for e in keyed]
    out = {"pool_hash": ph, "seed": seed.hex(), "order": order}

    avail = [e for e in keyed if e["id"] not in declined]
    need = div["vendors"]
    if len(avail) < seats + verifiers or not can_meet(set(), seats, avail, need):
        out.update({"outcome": "unmet", "seats": [], "verifiers": [], "vendors": 0, "skipped": []})
        return out

    taken, vendors, skipped = [], set(), []
    for i, e in enumerate(avail):
        if len(taken) == seats:
            break
        v = counted(e)
        after = vendors | ({v} if v is not None else set())
        if can_meet(after, seats - len(taken) - 1, avail[i + 1 :], need):
            taken.append(e["id"])
            vendors = after
        else:
            skipped.append(e["id"])
    assert len(taken) == seats and len(vendors) >= need
    ver = [e["id"] for e in avail if e["id"] not in taken][:verifiers]
    out.update({"outcome": "drawn", "seats": taken, "verifiers": ver, "vendors": len(vendors), "skipped": skipped})
    return out


# --- The vectors ---------------------------------------------------------------------------------------

MOTION = sha(b"motion: example").hex()
AT = {"seq": 41, "hash": sha(b"chain head: example").hex()}
# drand quicknet, round 1000000 (draw.md section 4, "The beacon"): its signature and randomness.
Q_ROUND = 1000000
Q_SIG = "83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72"
Q_RANDOMNESS = "b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3"
assert sha(bytes.fromhex(Q_SIG)).hex() == Q_RANDOMNESS
R2 = sha(b"randomness: second").hex()
QUICKNET = {"genesis_time": 1692803367, "period": 3}
QUICKNET_CHAIN = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"
# quicknet's public key, a point on G2 (draw.md section 4): public, not a secret.
QUICKNET_G2_POINT = "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a"


def terms(seats=3, verifiers=0, owners=0, vendors=0, exclude=("alice",)):
    return {
        "sphere": "e2e",
        "motion": MOTION,
        "at": AT,
        "request": "review_request",
        "exclude": list(exclude),
        "seats": seats,
        "verifiers": verifiers,
        "diversity": {"owners": owners, "vendors": vendors},
    }


def m(obi, owner, vendors=None, accepts=("review_request", "question")):
    out = {"obi_id": obi, "owner": owner, "accepts": list(accepts)}
    if vendors is not None:
        out["vendors"] = list(vendors)
    return out


def e(obi, owner, vendors=()):
    return {"id": obi, "owner": owner, "vendors": list(vendors)}


def with_entries(t, entries):
    return {"draw": VERSION, **t, "entries": entries}


TEAM = [
    e("obi-bob", "bob", ["anthropic"]),
    e("obi-carol", "carol", ["anthropic"]),
    e("obi-dan", "dan", ["openai"]),
    e("obi-erin", "erin", ["anthropic"]),
    e("obi-frank", "frank", ["google"]),
    e("obi-grace", "grace", []),
    e("obi-heidi", "heidi", ["anthropic", "openai"]),
]
ONE_VENDOR = [e("obi-bob", "bob", ["anthropic"]), e("obi-carol", "carol", ["anthropic"]), e("obi-dan", "dan", ["anthropic"]), e("obi-erin", "erin", ["anthropic"])]


def pool_cases():
    cases = []

    def ok(name, inp):
        cases.append({"name": name, "input": inp, "output": pool(inp)})

    def err(name, inp):
        try:
            pool(inp)
        except DrawError as x:
            cases.append({"name": name, "input": inp, "error": str(x)})
            return
        raise AssertionError(name)

    ok(
        "pool: the author's agents are out, one agent per owner (the lowest id), cards that don't take the request are out",
        {
            **terms(),
            "members": [
                m("obi-alice", "alice", ["anthropic"]),
                m("obi-dan", "dan", ["openai"]),
                m("obi-bob-2", "bob", ["openai"]),
                m("obi-bob", "bob", ["anthropic"]),
                m("obi-carol", "carol", ["anthropic"], accepts=["question"]),
                m("obi-erin", "erin"),
                m("obi-frank", "frank", ["openai", "anthropic", "openai"]),
            ],
        },
    )
    ok(
        "pool: two excluded owners (author and convener), given unsorted",
        {
            **terms(exclude=["zed", "alice"]),
            "members": [m("obi-zed", "zed", ["openai"]), m("obi-alice", "alice"), m("obi-bob", "bob", ["anthropic"])],
        },
    )
    ok("pool: nobody eligible", {**terms(), "members": [m("obi-alice", "alice")]})
    ok(
        "pool: entries and exclude sorted as UTF-8 bytes; the lowest obi_id of an owner by bytes",
        {**terms(exclude=["\U0001f600", "\ufb01"]), "members": [m("obi-\U0001f600", "z"), m("obi-\ufb01", "z"), m("obi-a", "\ufb01"), m("obi-b", "y")]},
    )
    err("pool error: an obi_id twice", {**terms(), "members": [m("obi-bob", "bob"), m("obi-bob", "carol")]})
    err("pool error: a member without accepts", {**terms(), "members": [{"obi_id": "obi-bob", "owner": "bob"}]})
    err("pool error: an unknown member", {**terms(), "members": [], "extra": 1})
    err("pool error: motion is not 64 lower-case hex", {**terms(), "motion": MOTION.upper(), "members": []})
    err("pool error: an empty vendor id", {**terms(), "members": [m("obi-bob", "bob", [""])]})
    return cases


def draw_cases():
    cases = []

    def ok(name, inp):
        cases.append({"name": name, "input": inp, "output": draw(inp)})

    def err(name, inp, code):
        try:
            draw(inp)
        except DrawError as x:
            assert str(x) == code, (name, str(x))
            cases.append({"name": name, "input": inp, "error": code})
            return
        raise AssertionError(name)

    t = terms
    ok("draw: three seats from seven, no diversity asked", {"pool": with_entries(t(3), TEAM), "randomness": Q_RANDOMNESS})
    ok(
        "draw: three seats, two vendors, one verifier",
        {"pool": with_entries(t(3, 1, 3, 2), TEAM), "randomness": Q_RANDOMNESS},
    )
    ok(
        "draw: three seats, three vendors (skips seats whose vendor is already there)",
        {"pool": with_entries(t(3, 0, 3, 3), TEAM), "randomness": Q_RANDOMNESS},
    )
    ok(
        "draw: another seed, another order",
        {"pool": with_entries(t(3, 1, 3, 2), TEAM), "randomness": R2},
    )
    first = draw({"pool": with_entries(t(3, 1, 3, 2), TEAM), "randomness": Q_RANDOMNESS})
    ok(
        "draw: the first seat declined; the others keep their seats",
        {"pool": with_entries(t(3, 1, 3, 2), TEAM), "randomness": Q_RANDOMNESS, "declined": [first["seats"][0]]},
    )
    ok(
        "draw: two seats and the verifier declined",
        {"pool": with_entries(t(3, 1, 3, 2), TEAM), "randomness": Q_RANDOMNESS, "declined": [first["seats"][1], first["verifiers"][0], first["seats"][2]]},
    )
    ok(
        "draw: one vendor in the pool, two asked: unmet",
        {"pool": with_entries(t(3, 0, 3, 2), ONE_VENDOR), "randomness": Q_RANDOMNESS},
    )
    ok(
        "draw: one vendor, none asked: drawn",
        {"pool": with_entries(t(3, 0, 3, 0), ONE_VENDOR), "randomness": Q_RANDOMNESS},
    )
    ok(
        "draw: too few left for the seats and the verifier after declines: unmet",
        {"pool": with_entries(t(3, 1), ONE_VENDOR), "randomness": Q_RANDOMNESS, "declined": ["obi-carol"]},
    )
    ok(
        "draw: agents declaring no vendor or several sit but count for none",
        {
            "pool": with_entries(t(2, 0, 2, 2), [e("obi-bob", "bob", ["anthropic", "openai"]), e("obi-carol", "carol", []), e("obi-dan", "dan", ["openai"]), e("obi-erin", "erin", ["anthropic"])]),
            "randomness": Q_RANDOMNESS,
        },
    )
    ok(
        "draw: only multi-vendor agents: they can't make two vendors, unmet",
        {"pool": with_entries(t(2, 0, 2, 2), [e("obi-bob", "bob", ["anthropic", "openai"]), e("obi-carol", "carol", ["google", "openai"])]), "randomness": Q_RANDOMNESS},
    )
    ok("draw: an empty pool is unmet", {"pool": with_entries(t(1), []), "randomness": Q_RANDOMNESS})
    plain = draw({"pool": with_entries(t(3, 1), TEAM), "randomness": Q_RANDOMNESS})
    ok("draw: three seats and a verifier, no diversity", {"pool": with_entries(t(3, 1), TEAM), "randomness": Q_RANDOMNESS})
    ok(
        "draw: a seat declines and the verifier, next in the order, becomes a seat",
        {"pool": with_entries(t(3, 1), TEAM), "randomness": Q_RANDOMNESS, "declined": [plain["seats"][0]]},
    )
    promoted = draw({"pool": with_entries(t(3, 1), TEAM), "randomness": Q_RANDOMNESS, "declined": [plain["seats"][0]]})
    assert plain["verifiers"][0] in promoted["seats"]
    ok(
        "draw: ids sort as UTF-8 bytes, not UTF-16 code units (U+FB01 before U+1F600)",
        {"pool": with_entries(t(2, 0, 0, 0, exclude=["\ufb01", "\U0001f600"]), [e("obi-z", "z"), e("obi-\ufb01", "o-\ufb01", ["openai"]), e("obi-\U0001f600", "o-\U0001f600", ["anthropic"])]), "randomness": Q_RANDOMNESS},
    )
    ok("draw: every entry a seat", {"pool": with_entries(t(4, 0, 4, 1), ONE_VENDOR), "randomness": R2})

    good = with_entries(t(3, 1, 3, 2), TEAM)
    err("draw error: not an object", [], "bad_input")
    err("draw error: no randomness", {"pool": good}, "bad_input")
    err("draw error: randomness in upper case", {"pool": good, "randomness": Q_RANDOMNESS.upper()}, "bad_input")
    err("draw error: an unknown member in the pool", {"pool": {**good, "note": "x"}, "randomness": Q_RANDOMNESS}, "bad_input")
    err("draw error: an entry without vendors", {"pool": with_entries(t(1), [{"id": "obi-bob", "owner": "bob"}]), "randomness": Q_RANDOMNESS}, "bad_input")
    err("draw error: a seat count that isn't an integer", {"pool": {**good, "seats": "3"}, "randomness": Q_RANDOMNESS}, "bad_input")
    err("draw error: declined isn't a list of ids", {"pool": good, "randomness": Q_RANDOMNESS, "declined": "obi-bob"}, "bad_input")
    err("draw error: entries out of order", {"pool": with_entries(t(1), [e("obi-carol", "carol"), e("obi-bob", "bob")]), "randomness": Q_RANDOMNESS}, "bad_pool")
    err("draw error: an entry twice", {"pool": with_entries(t(1), [e("obi-bob", "bob"), e("obi-bob", "bob")]), "randomness": Q_RANDOMNESS}, "bad_pool")
    err("draw error: an owner twice", {"pool": with_entries(t(1), [e("obi-bob", "bob"), e("obi-bob-2", "bob")]), "randomness": Q_RANDOMNESS}, "bad_pool")
    err("draw error: vendors out of order", {"pool": with_entries(t(1), [e("obi-bob", "bob", ["openai", "anthropic"])]), "randomness": Q_RANDOMNESS}, "bad_pool")
    err("draw error: an excluded owner's agent in the pool", {"pool": with_entries(t(1), [e("obi-alice", "alice")]), "randomness": Q_RANDOMNESS}, "bad_pool")
    err("draw error: entries in UTF-16 order, not UTF-8", {"pool": with_entries(t(1), [e("obi-\U0001f600", "a"), e("obi-\ufb01", "b")]), "randomness": Q_RANDOMNESS}, "bad_pool")
    err("draw error: a draw version this text doesn't define", {"pool": {**good, "draw": 2}, "randomness": Q_RANDOMNESS}, "bad_version")
    err("draw error: no draw version", {"pool": {k: v for k, v in good.items() if k != "draw"}, "randomness": Q_RANDOMNESS}, "bad_input")
    err("draw error: exclude out of order", {"pool": with_entries(t(1, exclude=["zed", "alice"]), [e("obi-bob", "bob")]), "randomness": Q_RANDOMNESS}, "bad_pool")
    err("draw error: no seats", {"pool": with_entries(t(0), TEAM), "randomness": Q_RANDOMNESS}, "bad_panel")
    err("draw error: more owners asked than seats", {"pool": with_entries(t(2, 0, 3, 0), TEAM), "randomness": Q_RANDOMNESS}, "bad_panel")
    err("draw error: more vendors asked than seats", {"pool": with_entries(t(2, 0, 2, 3), TEAM), "randomness": Q_RANDOMNESS}, "bad_panel")
    err("draw error: a declined id not in the pool", {"pool": good, "randomness": Q_RANDOMNESS, "declined": ["obi-zed"]}, "bad_declined")
    err("draw error: a declined id twice", {"pool": good, "randomness": Q_RANDOMNESS, "declined": ["obi-bob", "obi-bob"]}, "bad_declined")
    return cases


def anchor_cases():
    rec = with_entries(terms(3, 1, 3, 2), TEAM)
    ph = pool_hash(rec)
    out = [{"name": f"anchor for {to}", "pool_hash": ph, "to": to, "id": anchor_id(ph, to)} for to in ["obi-bob", "obi-dan"]]
    ph2 = "00" * 32
    out.append({"name": "anchor for a pool hash of zeros", "pool_hash": ph2, "to": "obi-bob", "id": anchor_id(ph2, "obi-bob")})
    return out


def round_cases():
    def r(name, at):
        return {"name": name, "anchored_at": at, **QUICKNET, "round": beacon_round(at, **QUICKNET)}

    return [
        r("quicknet: anchored exactly 300 seconds before round 1000000's time: the round after it", "2023-09-27T08:24:24Z"),
        r("quicknet: anchored 301 seconds before round 1000000's time: that round", "2023-09-27T08:24:23Z"),
        r("quicknet: one second later: still the round after it", "2023-09-27T08:24:25Z"),
        r("quicknet: three seconds later: the next one", "2023-09-27T08:24:27Z"),
        r("quicknet: 2026", "2026-10-27T12:00:00Z"),
        r("before the beacon began: round 1", "2020-01-01T00:00:00Z"),
        r("the Unix epoch itself", "1970-01-01T00:00:00Z"),
        {"name": "a beacon with a 30-second period", "anchored_at": "2026-10-27T12:00:00Z", "genesis_time": 1595431050, "period": 30, "round": beacon_round("2026-10-27T12:00:00Z", 1595431050, 30)},
    ]


def flip(hex_text, i):
    b_ = bytearray(bytes.fromhex(hex_text))
    b_[i] ^= 1
    return b_.hex()


def beacon_checks():
    # Python's standard library has no BLS12-381: the signature checks' answers are drand's own (the real
    # round verifies, as drand's client does; anything changed doesn't), and both implementations must agree.
    # Each is checked with quicknet's own public key: a check never takes the key from the record.
    return [
        {"name": "quicknet round 1000000, as drand published it", "round": Q_ROUND, "signature": Q_SIG, "valid": True},
        {"name": "the same signature for another round", "round": Q_ROUND + 1, "signature": Q_SIG, "valid": False},
        {"name": "one bit of the signature changed", "round": Q_ROUND, "signature": flip(Q_SIG, 47), "valid": False},
        {"name": "a signature that isn't a curve point", "round": Q_ROUND, "signature": "00" * 48, "valid": False},
        {"name": "a signature of the wrong length", "round": Q_ROUND, "signature": Q_SIG[:-2], "valid": False},
        {"name": "the identity point as the signature", "round": Q_ROUND, "signature": "c0" + "00" * 47, "valid": False},
        # The same point, uncompressed (96 bytes): a signature is the 48-byte compressed form only, since another
        # encoding of one point would hash to another randomness, and so another seed.
        {"name": "the same signature, uncompressed", "round": Q_ROUND, "signature": "03ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe7201776ff7408b39c5f6f9fa50746efd7eea17fbb61f2e7b9c849ff0528e5a3deeedd029d0df345199963d75ba93b5a02a", "valid": False},
        {"name": "round 0, which no beacon has", "round": 0, "signature": Q_SIG, "valid": False},
    ]


def vectors():
    return {
        "description": "Known-answer vectors for the Council draw (spec/council/draw.md). `pool` builds a pool record from the directory; `draw` draws seats from a pool record and a beacon's randomness; `anchor` gives the envelope id that fixes a pool hash in the chain; `round` gives the beacon round that follows an anchor; `beacon` is drand's quicknet and one real round of it, whose randomness is the SHA-256 of its signature; `beacon_checks` say whether a round's signature verifies with quicknet's public key. Outputs compare as JSON values: member order doesn't matter, array order does. The answers come from clerk/vectors/draw.py, written apart from both implementations.",
        "version": 1,
        "beacon": {"chain": QUICKNET_CHAIN, "public_key": QUICKNET_G2_POINT, **QUICKNET, "round": Q_ROUND, "signature": Q_SIG, "randomness": Q_RANDOMNESS},
        "beacon_checks": beacon_checks(),
        "pool": pool_cases(),
        "draw": draw_cases(),
        "anchor": anchor_cases(),
        "round": round_cases(),
    }


if __name__ == "__main__":
    path = Path(__file__).with_name("draw.json")
    text = json.dumps(vectors(), indent=1, ensure_ascii=False) + "\n"
    if "--check" in sys.argv:
        if path.read_text() != text:
            sys.exit("clerk/vectors/draw.json is not what draw.py writes")
        print("draw.json matches draw.py")
    else:
        path.write_text(text)
        print(f"wrote {path}")
