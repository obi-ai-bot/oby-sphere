#!/usr/bin/env python3
"""Writes clerk/vectors/review.json: the known-answer vectors for the review profile's tally
(spec/council/review.md, section 6): from the chain's entries to the clerk's count input.

Like draw.py, a third implementation in Python's standard library, written from review.md apart from the
Rust and TypeScript ones; the vectors' answers come from here. `python3 clerk/vectors/review.py` rewrites
the file; `--check` only compares.
"""

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

MAX_INT = 2**53 - 1
SHA = re.compile(r"^[0-9a-f]{40}$|^[0-9a-f]{64}$")
TIMESTAMP = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")
CHALLENGE_MARGIN = 600
ASCII_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")
MOST_CONDITIONS = 10


class TallyError(Exception):
    pass


def fail(code):
    raise TallyError(code)


def is_obj(v):
    return isinstance(v, dict)


def is_id(v):
    return isinstance(v, str) and len(v) > 0


def is_int(v):
    return isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= MAX_INT


def exact(o, keys, optional=()):
    return is_obj(o) and set(o) >= set(keys) and set(o) <= set(keys) | set(optional)


def seconds(t):
    """A protocol timestamp's seconds since 1970, or None when it isn't one (a real date from 1970, whole seconds, Z)."""
    if not (isinstance(t, str) and TIMESTAMP.match(t)):
        return None
    try:
        s = int(datetime.strptime(t, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())
    except ValueError:
        return None
    return s if s >= 0 else None


def same_repo(a, b):
    """Repositories compare ignoring ASCII case (protocol.md section 5.9)."""
    return isinstance(a, str) and isinstance(b, str) and a.translate(ASCII_LOWER) == b.translate(ASCII_LOWER)


def check_rule(rule, quorum, seats):
    kind = rule.get("kind")
    if kind in ("majority", "unanimity"):
        ok = set(rule) == {"kind"}
    elif kind == "supermajority":
        ok = set(rule) == {"kind", "num", "den"} and is_int(rule["num"]) and is_int(rule["den"]) and 1 <= rule["num"] <= rule["den"]
    else:
        ok = False
    if not ok or not (1 <= quorum <= len(seats)):
        fail("bad_panel")


def tally(inp):
    keys = ["convener", "subject", "rule", "quorum", "veto", "seats", "round_at", "deadlines", "entries"]
    if not exact(inp, keys, ["verifier"]):
        fail("bad_input")
    subj = inp["subject"]
    if not (exact(subj, ["repo", "head_sha"]) and is_id(subj["repo"]) and isinstance(subj["head_sha"], str) and SHA.match(subj["head_sha"])):
        fail("bad_input")
    if not (is_id(inp["convener"]) and is_obj(inp["rule"]) and isinstance(inp["veto"], bool) and is_int(inp["quorum"])):
        fail("bad_input")
    seats = inp["seats"]
    if not (isinstance(seats, list) and all(is_id(s) for s in seats)):
        fail("bad_input")
    verifier = inp.get("verifier")
    if "verifier" in inp and not is_id(verifier):
        fail("bad_input")
    round_at = seconds(inp["round_at"])
    d = inp["deadlines"]
    if round_at is None or not exact(d, ["reviews", "challenge"]):
        fail("bad_input")
    reviews_by, challenge_by = seconds(d["reviews"]), seconds(d["challenge"])
    if reviews_by is None or challenge_by is None:
        fail("bad_input")
    entries = inp["entries"]
    if not (isinstance(entries, list) and all(is_obj(e) for e in entries)):
        fail("bad_input")
    for e in entries:
        env = e.get("envelope")
        if not (exact(e, ["seq", "recorded_at", "envelope"]) and is_int(e["seq"]) and seconds(e["recorded_at"]) is not None and is_obj(env)):
            fail("bad_input")
        if not all(is_id(env.get(k)) for k in ("id", "type", "from", "to", "correlation_id")) or not is_obj(env.get("body")):
            fail("bad_input")

    check_rule(inp["rule"], inp["quorum"], seats)
    if len(set(seats)) != len(seats) or inp["convener"] in seats:
        fail("bad_panel")
    if verifier is not None and (verifier in seats or verifier == inp["convener"]):
        fail("bad_panel")
    # The challenge needs its margin twice after the reviews: time to send it, and time to replace a verifier.
    if not (round_at < reviews_by and reviews_by + 2 * CHALLENGE_MARGIN <= challenge_by):
        fail("bad_panel")

    def requests_to(member, until):
        """The panel's review_requests to `member`: from the convener, for the subject, recorded after round R's time and by `until`."""
        return [
            e
            for e in entries
            if e["envelope"]["type"] == "review_request"
            and e["envelope"]["from"] == inp["convener"]
            and e["envelope"]["to"] == member
            and same_repo(e["envelope"]["body"].get("repo"), subj["repo"])
            and e["envelope"]["body"].get("head_sha") == subj["head_sha"]
            and round_at < seconds(e["recorded_at"]) <= until
        ]

    def review_result(request, member, deadline):
        """The review's result, when its exchange ended with one from `member` by `deadline`, for the subject; checked."""
        rid = request["envelope"]["id"]
        end = next((e for e in entries if e["envelope"]["correlation_id"] == rid and e["envelope"]["from"] == member and e["envelope"]["type"] in ("result", "decline")), None)
        if end is None or end["envelope"]["type"] != "result" or seconds(end["recorded_at"]) > deadline:
            return None
        b = end["envelope"]["body"]
        if b.get("for") != "review_request" or b.get("head_sha") != subj["head_sha"] or not same_repo(b.get("repo"), subj["repo"]):
            return None
        if b.get("outcome") not in ("approved", "changes_requested"):
            return None
        findings, acc = b.get("findings", []), b.get("acceptance", [])
        if not (isinstance(findings, list) and all(is_obj(f) and is_id(f.get("id")) and isinstance(f.get("severity"), str) for f in findings)):
            fail("bad_input")
        if not (isinstance(acc, list) and all(is_obj(a) and is_int(a.get("index")) and isinstance(a.get("kind"), str) and isinstance(a.get("met"), bool) for a in acc)):
            fail("bad_input")
        if len({f["id"] for f in findings}) != len(findings) or len({a["index"] for a in acc}) != len(acc):
            fail("bad_input")
        return b

    ballots, findings = [], []
    for seat in seats:
        reqs = requests_to(seat, reviews_by)
        if len(reqs) > 1:
            fail("two_requests")
        res = review_result(reqs[0], seat, reviews_by) if reqs else None
        if res is None:
            continue
        ballots.append({"seat": seat, "vote": "approve" if res["outcome"] == "approved" else "reject"})
        for f in res.get("findings", []):
            findings.append({"id": f"{seat}/{f['id']}", "blocking": f["severity"] == "blocker", "evidence": True, "challenge": "none"})

    blocking = [f for f in findings if f["blocking"]]
    if verifier is not None and blocking:
        reqs = requests_to(verifier, challenge_by - CHALLENGE_MARGIN)
        conds = [r["envelope"]["body"].get("acceptance", []) for r in reqs]
        shaped = (
            reqs
            and all(isinstance(c, list) and 1 <= len(c) <= MOST_CONDITIONS and all(is_obj(x) and x.get("kind") == "custom" for x in c) for c in conds)
            and sum(len(c) for c in conds) == len(blocking)
        )
        if shaped:
            offset = 0
            for r, c in zip(reqs, conds):
                res = review_result(r, verifier, challenge_by)
                if res is not None:
                    met = {a["index"]: a["met"] for a in res.get("acceptance", []) if a["kind"] == "custom"}
                    for i in range(len(c)):
                        if i in met:
                            blocking[offset + i]["challenge"] = "stands" if met[i] else "refuted"
                offset += len(c)

    return {"rule": inp["rule"], "quorum": inp["quorum"], "veto": inp["veto"], "seats": seats, "ballots": ballots, "findings": findings}


# --- The vectors ---------------------------------------------------------------------------------------

REPO = "acme/app"
HEAD = "6d20146f366b1a4b5e7f8c9d0e1f2a3b4c5d6e7f"
OTHER = "aeab70f30251c0d1e2f3a4b5c6d7e8f9a0b1c2d3"
CONVENER = "agent-alice"
SEATS = ["agent-bob", "agent-carol", "agent-dan"]
VERIFIER = "agent-erin"
# Sealed words look like this in the chain: the tally never opens them.
SEALED = "q83vEjRWeJA5Z6gNmV1vXyt7lH8K0oX2u_4T-9wq0aBc"
T0 = datetime(2026, 10, 27, 12, 0, 0, tzinfo=timezone.utc)


def at(n):
    """Entry n is recorded n × 10 seconds after T0; round R's time is T0 + 5 s, so entries 1 and later follow it."""
    return (T0 + timedelta(seconds=10 * n)).strftime("%Y-%m-%dT%H:%M:%SZ")


ROUND_AT = (T0 + timedelta(seconds=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
DEADLINES = {"reviews": at(60), "challenge": at(180)}


def uid(n):
    return f"00000000-0000-4000-8000-{n:012d}"


def entry(n, typ, frm, to, body, corr=None):
    env = {"protocol": "obi/0.1", "id": uid(n), "type": typ, "from": frm, "to": to, "sphere": "e2e", "correlation_id": uid(corr or n), "body": body}
    if corr:
        env["in_reply_to"] = uid(corr)
    return {"seq": n + 100, "recorded_at": at(n), "envelope": env}


def acceptance():
    return [{"kind": "no_blocker_findings"}]


def request(n, to, head=HEAD, conds=None, repo=REPO):
    body = {"goal": SEALED, "repo": repo, "base_branch": "main", "head_branch": "feature/average", "head_sha": head, "acceptance": conds or acceptance()}
    return entry(n, "review_request", CONVENER, to, body)


def finding(fid, sev, line=4):
    return {"id": fid, "severity": sev, "file": "src/average.js", "line": line, "title": SEALED, "detail": SEALED}


def result(n, req, frm, outcome, findings=(), head=HEAD, met=None):
    body = {"for": "review_request", "outcome": outcome, "repo": REPO, "head_sha": head, "findings": list(findings)}
    if outcome != "failed":
        body["acceptance"] = met if met is not None else [{"index": 0, "kind": "no_blocker_findings", "met": not any(f["severity"] == "blocker" for f in findings)}]
    return entry(n, "result", frm, CONVENER, body, corr=req)


def accept(n, req, frm):
    return entry(n, "accept", frm, CONVENER, {}, corr=req)


def decline(n, req, frm, reason="busy"):
    return entry(n, "decline", frm, CONVENER, {"reason": reason}, corr=req)


def custom(k):
    return [{"kind": "custom", "text": SEALED} for _ in range(k)]


def met_list(values):
    return [{"index": i, "kind": "custom", "met": v} for i, v in enumerate(values)]


def base(entries, verifier=True, rule=None, quorum=2, veto=True, seats=SEATS):
    out = {"convener": CONVENER, "subject": {"repo": REPO, "head_sha": HEAD}, "rule": rule or {"kind": "majority"}, "quorum": quorum, "veto": veto, "seats": list(seats), "round_at": ROUND_AT, "deadlines": dict(DEADLINES), "entries": entries}
    if verifier:
        out["verifier"] = VERIFIER
    return out


def panel(outcomes):
    """Three seats' requests, accepts and results; outcomes is a list of (outcome, findings), "decline" or None."""
    es, n = [], 1
    for seat, oc in zip(SEATS, outcomes):
        es.append(request(n, seat))
        req = n
        n += 1
        if oc is None:
            continue
        es.append(accept(n, req, seat))
        n += 1
        es.append(decline(n, req, seat) if oc == "decline" else result(n, req, seat, oc[0], oc[1]))
        n += 1
    return es, n


def cases():
    out = []

    def ok(name, inp):
        out.append({"name": name, "input": inp, "output": tally(inp)})

    def err(name, inp, code):
        try:
            tally(inp)
        except TallyError as x:
            assert str(x) == code, (name, str(x))
            out.append({"name": name, "input": inp, "error": code})
            return
        raise AssertionError(name)

    es, _ = panel([("approved", []), ("approved", [finding("f-1", "minor")]), ("changes_requested", [finding("f-2", "major")])])
    ok("three seats answer: two approve, one requests changes; no blocker", base(es))

    es, n = panel([("approved", []), ("approved", []), ("changes_requested", [finding("f-9", "blocker"), finding("f-3", "nit", 9)])])
    ok("a blocker and no verifier: it stands unchallenged", base(es, verifier=False))
    es2 = es + [request(n, VERIFIER, conds=custom(1))]
    ok("a blocker, the verifier asked but not answering: it stands", base(es2))
    ok("a blocker the verifier refutes", base(es2 + [accept(n + 1, n, VERIFIER), result(n + 2, n, VERIFIER, "changes_requested", met=met_list([False]))]))
    ok("a blocker the verifier upholds", base(es2 + [accept(n + 1, n, VERIFIER), result(n + 2, n, VERIFIER, "approved", met=met_list([True]))]))
    late = [accept(n + 1, n, VERIFIER), result(185, n, VERIFIER, "changes_requested", met=met_list([False]))]
    ok("the verifier's refutation after the challenge deadline doesn't count", base(es2 + late))

    es3 = es2 + [accept(n + 1, n, VERIFIER), result(n + 2, n, VERIFIER, "changes_requested", met=met_list([False]))]
    es3 += [request(125, VERIFIER, conds=acceptance()), request(81, "agent-bob")]
    ok("requests after their deadlines (an ordinary review of the verifier, a re-review of a seat) aren't the panel's", base(es3))

    es, n = panel([("changes_requested", [finding("f-a", "blocker"), finding("f-b", "blocker", 7)]), ("changes_requested", [finding("f-a", "blocker")]), ("approved", [])])
    es += [request(n, VERIFIER, conds=custom(3)), accept(n + 1, n, VERIFIER), result(n + 2, n, VERIFIER, "changes_requested", met=met_list([True, False, True]))]
    ok("three blockers from two seats, challenged in seat order: one refuted", base(es))

    many = [finding(f"f-{i}", "blocker", 10 + i) for i in range(11)]
    es, n = panel([("changes_requested", many), ("approved", []), ("approved", [])])
    es += [request(n, VERIFIER, conds=custom(10)), request(n + 1, VERIFIER, conds=custom(1))]
    es += [accept(n + 2, n, VERIFIER), result(n + 3, n, VERIFIER, "changes_requested", met=met_list([True] * 9 + [False]))]
    es += [accept(n + 4, n + 1, VERIFIER), result(n + 5, n + 1, VERIFIER, "changes_requested", met=met_list([False]))]
    ok("eleven blockers, challenged in two requests of ten and one", base(es))

    es, n = panel([("changes_requested", [finding("f-a", "blocker")]), ("approved", []), ("approved", [])])
    es += [request(n, VERIFIER, conds=custom(2)), accept(n + 1, n, VERIFIER), result(n + 2, n, VERIFIER, "changes_requested", met=met_list([False, False]))]
    ok("a challenge with the wrong number of conditions doesn't count", base(es))

    es, n = panel([("changes_requested", [finding("f-a", "blocker")]), ("approved", []), ("approved", [])])
    es += [request(n, VERIFIER, conds=[{"kind": "tests_pass"}]), accept(n + 1, n, VERIFIER), result(n + 2, n, VERIFIER, "approved", met=[{"index": 0, "kind": "tests_pass", "met": True}])]
    ok("a challenge whose condition isn't custom doesn't count", base(es))

    es, n = panel([("changes_requested", [finding("f-a", "blocker")]), ("approved", []), ("approved", [])])
    es += [request(n, VERIFIER, conds=custom(1)), accept(n + 1, n, VERIFIER), decline(n + 2, n, VERIFIER)]
    ok("the verifier declines after accepting: the blocker stands", base(es))

    es, _ = panel(["decline", ("approved", []), None])
    ok("one seat declines, one never answers: one ballot", base(es, verifier=False, quorum=1))

    es, _ = panel([("failed", []), ("approved", []), ("changes_requested", [])])
    ok("a failed review is absent, and its findings with it", base(es, verifier=False))

    es, n = panel([("approved", []), ("approved", []), None])
    es += [accept(n, n - 1, "agent-dan"), result(n + 1, n - 1, "agent-dan", "approved", head=OTHER)]
    ok("a result for another commit is absent", base(es, verifier=False))

    es, n = panel([("approved", []), ("approved", []), None])
    es += [accept(n, n - 1, "agent-dan"), result(61, n - 1, "agent-dan", "changes_requested", [finding("f-late", "blocker")])]
    ok("a seat's result after the reviews deadline is absent, and its blocker with it", base(es, verifier=False))

    old = [request(0, "agent-bob"), accept(0, 0, "agent-bob"), result(0, 0, "agent-bob", "approved")]
    for e in old:
        e["recorded_at"] = (T0 - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
        e["seq"] = 7
    for e, i in zip(old, (900, 901, 902)):
        e["envelope"]["id"] = uid(i)
        e["envelope"]["correlation_id"] = uid(900)
        if "in_reply_to" in e["envelope"]:
            e["envelope"]["in_reply_to"] = uid(900)
    es, _ = panel([None, ("approved", []), ("changes_requested", [])])
    ok("a review the convener asked for before the round is not the panel's", base(old + es, verifier=False))

    es = [request(1, "agent-bob", repo="Acme/App"), accept(2, 1, "agent-bob"), result(3, 1, "agent-bob", "approved")]
    es += [request(4, "agent-carol", head=OTHER), accept(5, 4, "agent-carol"), result(6, 4, "agent-carol", "changes_requested", head=OTHER)]
    ok("repositories compare ignoring case; a request for another commit isn't the panel's", base(es, verifier=False, quorum=1))

    es, _ = panel([("approved", []), ("approved", []), ("approved", [])])
    es.append(entry(50, "result", "agent-mallory", CONVENER, {"for": "review_request", "outcome": "changes_requested", "repo": REPO, "head_sha": HEAD, "findings": [finding("f-x", "blocker")], "acceptance": [{"index": 0, "kind": "no_blocker_findings", "met": False}]}, corr=1))
    ok("a reply from anyone but the seat doesn't count", base(es, verifier=False))

    es, _ = panel([("approved", []), ("changes_requested", []), ("approved", [])])
    ok("a supermajority rule with no veto passes straight through", base(es, verifier=False, rule={"kind": "supermajority", "num": 2, "den": 3}, veto=False))

    es, n = panel([("approved", []), ("approved", []), ("approved", [])])
    es.append(request(n, "agent-bob"))
    err("two requests to one seat after the round", base(es, verifier=False), "two_requests")
    err("not an object", [], "bad_input")
    err("a head_sha that isn't a commit id", {**base([], verifier=False), "subject": {"repo": REPO, "head_sha": "main"}}, "bad_input")
    err("an entry without its recorded_at", base([{"seq": 1, "envelope": request(1, "agent-bob")["envelope"]}], verifier=False), "bad_input")
    err("an envelope without a body", base([{"seq": 1, "recorded_at": at(1), "envelope": {"id": uid(1), "type": "review_request", "from": CONVENER, "to": "agent-bob", "correlation_id": uid(1)}}], verifier=False), "bad_input")
    err("a round time that isn't a timestamp", {**base([], verifier=False), "round_at": "soon"}, "bad_input")
    err("an unknown member", {**base([], verifier=False), "note": "x"}, "bad_input")
    es, _ = panel([("approved", [{"severity": "minor", "file": "a", "line": 1, "title": SEALED, "detail": SEALED}]), None, None])
    err("a counted result's finding without an id", base(es, verifier=False, quorum=1), "bad_input")
    es, _ = panel([("approved", []), None, None])
    es[2]["envelope"]["body"]["acceptance"] = [{"index": 0, "kind": "no_blocker_findings", "met": 1}]
    err("a counted result's acceptance with a met that isn't a boolean", base(es, verifier=False, quorum=1), "bad_input")
    err("a rule the review profile doesn't take", base([], verifier=False, rule={"kind": "schulze"}), "bad_panel")
    err("a supermajority without its fraction", base([], verifier=False, rule={"kind": "supermajority"}), "bad_panel")
    err("a rule with a member it doesn't take", base([], verifier=False, rule={"kind": "majority", "num": 1}), "bad_panel")
    err("a quorum of 0", base([], verifier=False, quorum=0), "bad_panel")
    err("a quorum above the seats", base([], verifier=False, quorum=4), "bad_panel")
    err("no seats", base([], verifier=False, seats=[]), "bad_panel")
    err("a seat twice", base([], verifier=False, seats=["agent-bob", "agent-bob"]), "bad_panel")
    err("the convener sits", base([], verifier=False, seats=[CONVENER, "agent-bob"]), "bad_panel")
    err("the verifier sits", {**base([], verifier=False), "verifier": "agent-bob"}, "bad_panel")
    err("deadlines out of order", {**base([], verifier=False), "deadlines": {"reviews": at(90), "challenge": at(60)}}, "bad_panel")
    plus = lambda s: (T0 + timedelta(seconds=s)).strftime("%Y-%m-%dT%H:%M:%SZ")
    err("a challenge deadline 1,199 seconds after the reviews'", {**base([], verifier=False), "deadlines": {"reviews": plus(600), "challenge": plus(1799)}}, "bad_panel")
    es, _ = panel([("approved", []), ("approved", []), ("approved", [])])
    ok("a challenge deadline exactly 1,200 seconds after the reviews'", {**base(es, verifier=False), "deadlines": {"reviews": plus(600), "challenge": plus(1800)}})
    es, _ = panel([("approved", [finding("f-1", "minor"), finding("f-1", "nit", 9)]), None, None])
    err("a counted result that repeats a finding id", base(es, verifier=False, quorum=1), "bad_input")
    es, _ = panel([("approved", []), None, None])
    es[2]["envelope"]["body"]["acceptance"] = [{"index": 0, "kind": "no_blocker_findings", "met": True}, {"index": 0, "kind": "tests_pass", "met": True}]
    err("a counted result that repeats an acceptance index", base(es, verifier=False, quorum=1), "bad_input")
    err("a timestamp with digits that aren't ASCII", {**base([], verifier=False), "round_at": "\uff12026-10-27T12:00:05Z"}, "bad_input")
    return out


def vectors():
    return {
        "description": "Known-answer vectors for the review profile's tally (spec/council/review.md, section 6): the chain's entries in chain order, round R's time and the motion's deadlines, and the clerk's count input they give, or the error. Words are sealed (any text value may be; the tally reads none). Outputs compare as JSON values: member order doesn't matter, array order does. The answers come from clerk/vectors/review.py, written apart from both implementations; every output is a count input the clerk counts.",
        "version": 4,
        "tally": cases(),
    }


if __name__ == "__main__":
    path = Path(__file__).with_name("review.json")
    text = json.dumps(vectors(), indent=1, ensure_ascii=False) + "\n"
    if "--check" in sys.argv:
        if path.read_text() != text:
            sys.exit("clerk/vectors/review.json is not what review.py writes")
        print("review.json matches review.py")
    else:
        path.write_text(text)
        print(f"wrote {path}")
