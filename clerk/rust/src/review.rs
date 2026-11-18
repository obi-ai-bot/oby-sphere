//! The review profile's tally (`spec/council/review.md`, section 6): from the chain's entries to the clerk's
//! count input. It reads only what stays readable when the words are sealed (types, members, times, outcomes,
//! commit ids, finding ids and severities, acceptance kinds and results), so anyone holding the chain can
//! count again without a key. The known-answer vectors in `clerk/vectors/review.json` pin it down, and the
//! TypeScript in `clerk/ts` gives the same answers.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};

use crate::draw::unix_seconds;
use crate::MAX_INT;

/// The most conditions one challenge request carries (protocol.md section 5.1: 1 to 10).
pub const MOST_CONDITIONS: usize = 10;

/// The verifier's requests are recorded at least this long before `deadlines.challenge` (review.md section 6).
pub const CHALLENGE_MARGIN_SECONDS: u64 = 600;

/// Why a tally input can't be used. The code is what the vectors name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TallyError {
    BadInput,
    BadPanel,
    TwoRequests,
}

impl TallyError {
    pub fn code(self) -> &'static str {
        match self {
            TallyError::BadInput => "bad_input",
            TallyError::BadPanel => "bad_panel",
            TallyError::TwoRequests => "two_requests",
        }
    }
}

impl std::fmt::Display for TallyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for TallyError {}

use TallyError::*;

fn id(v: Option<&Value>) -> Option<&str> {
    v?.as_str().filter(|s| !s.is_empty())
}

fn int(v: Option<&Value>) -> Option<u64> {
    v?.as_u64().filter(|n| *n <= MAX_INT)
}

/// A protocol timestamp's seconds since 1970, or `None` when it isn't one.
fn seconds(v: Option<&Value>) -> Option<u64> {
    unix_seconds(v?.as_str()?).ok()
}

fn list(v: Option<&Value>) -> &[Value] {
    v.and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn is_sha(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64)
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// The object `v`, when it has every member of `keys` and no member outside `keys` and `optional`.
fn exact<'a>(
    v: Option<&'a Value>,
    keys: &[&str],
    optional: &[&str],
) -> Option<&'a Map<String, Value>> {
    let o = v?.as_object()?;
    let fits = keys.iter().all(|k| o.contains_key(*k))
        && o.keys()
            .all(|k| keys.contains(&k.as_str()) || optional.contains(&k.as_str()));
    fits.then_some(o)
}

/// Repositories compare ignoring ASCII case (protocol.md section 5.9).
fn same_repo(a: Option<&Value>, b: &str) -> bool {
    a.and_then(Value::as_str)
        .is_some_and(|a| a.eq_ignore_ascii_case(b))
}

fn check_rule(rule: &Map<String, Value>, quorum: u64, seats: usize) -> Result<(), TallyError> {
    let ok = match rule.get("kind").and_then(Value::as_str) {
        Some("majority" | "unanimity") => rule.len() == 1,
        Some("supermajority") => {
            let num = int(rule.get("num"));
            let den = int(rule.get("den"));
            rule.len() == 3 && matches!((num, den), (Some(n), Some(d)) if 1 <= n && n <= d)
        }
        _ => false,
    };
    if !ok || quorum < 1 || quorum > seats as u64 {
        return Err(BadPanel);
    }
    Ok(())
}

struct Entry<'a> {
    at: u64,
    env: &'a Map<String, Value>,
}

impl Entry<'_> {
    fn field(&self, k: &str) -> &str {
        self.env.get(k).and_then(Value::as_str).unwrap_or_default()
    }
    fn body(&self) -> &Map<String, Value> {
        self.env["body"].as_object().expect("checked")
    }
}

/// The clerk's count input for a review panel, from the chain's entries in chain order (review.md section 6).
pub fn tally(input: &Value) -> Result<Value, TallyError> {
    let keys = [
        "convener",
        "subject",
        "rule",
        "quorum",
        "veto",
        "seats",
        "round_at",
        "deadlines",
        "entries",
    ];
    let o = exact(Some(input), &keys, &["verifier"]).ok_or(BadInput)?;
    let subject = exact(o.get("subject"), &["repo", "head_sha"], &[]).ok_or(BadInput)?;
    let repo = id(subject.get("repo")).ok_or(BadInput)?;
    let head = subject
        .get("head_sha")
        .and_then(Value::as_str)
        .filter(|s| is_sha(s))
        .ok_or(BadInput)?;
    let convener = id(o.get("convener")).ok_or(BadInput)?;
    let rule = o["rule"].as_object().ok_or(BadInput)?;
    let veto = o["veto"].as_bool().ok_or(BadInput)?;
    let quorum = int(o.get("quorum")).ok_or(BadInput)?;
    let seats: Vec<&str> = o["seats"]
        .as_array()
        .ok_or(BadInput)?
        .iter()
        .map(|s| id(Some(s)))
        .collect::<Option<_>>()
        .ok_or(BadInput)?;
    let verifier = match o.get("verifier") {
        Some(v) => Some(id(Some(v)).ok_or(BadInput)?),
        None => None,
    };
    let round_at = seconds(o.get("round_at")).ok_or(BadInput)?;
    let deadlines = exact(o.get("deadlines"), &["reviews", "challenge"], &[]).ok_or(BadInput)?;
    let reviews_by = seconds(deadlines.get("reviews")).ok_or(BadInput)?;
    let challenge_by = seconds(deadlines.get("challenge")).ok_or(BadInput)?;
    let raw = o["entries"].as_array().ok_or(BadInput)?;
    let mut entries = Vec::with_capacity(raw.len());
    for e in raw {
        let e = exact(Some(e), &["seq", "recorded_at", "envelope"], &[]).ok_or(BadInput)?;
        int(e.get("seq")).ok_or(BadInput)?;
        let at = seconds(e.get("recorded_at")).ok_or(BadInput)?;
        let env = e["envelope"].as_object().ok_or(BadInput)?;
        let ok = ["id", "type", "from", "to", "correlation_id"]
            .iter()
            .all(|k| id(env.get(*k)).is_some())
            && env.get("body").is_some_and(Value::is_object);
        if !ok {
            return Err(BadInput);
        }
        entries.push(Entry { at, env });
    }

    check_rule(rule, quorum, seats.len())?;
    let distinct: HashSet<&str> = seats.iter().copied().collect();
    if distinct.len() != seats.len() || distinct.contains(convener) {
        return Err(BadPanel);
    }
    if verifier.is_some_and(|v| distinct.contains(v) || v == convener) {
        return Err(BadPanel);
    }
    // The challenge needs its margin twice after the reviews: time to send it, and time to replace a verifier.
    if !(round_at < reviews_by && reviews_by + 2 * CHALLENGE_MARGIN_SECONDS <= challenge_by) {
        return Err(BadPanel);
    }

    // The panel's review_requests to `member`: from the convener, for the subject, recorded after round R's time
    // and by `until`.
    let requests_to = |member: &str, until: u64| -> Vec<&Entry> {
        entries
            .iter()
            .filter(|e| {
                e.field("type") == "review_request"
                    && e.field("from") == convener
                    && e.field("to") == member
                    && same_repo(e.body().get("repo"), repo)
                    && e.body().get("head_sha").and_then(Value::as_str) == Some(head)
                    && e.at > round_at
                    && e.at <= until
            })
            .collect()
    };
    // The review's result, when its exchange ended with one from `member` by `deadline`, for the subject; checked.
    let review_result = |request: &Entry,
                         member: &str,
                         deadline: u64|
     -> Result<Option<&Map<String, Value>>, TallyError> {
        let rid = request.field("id");
        let end = entries.iter().find(|e| {
            e.field("correlation_id") == rid
                && e.field("from") == member
                && matches!(e.field("type"), "result" | "decline")
        });
        let Some(end) = end else { return Ok(None) };
        if end.field("type") != "result" || end.at > deadline {
            return Ok(None);
        }
        let b = end.body();
        let fits = b.get("for").and_then(Value::as_str) == Some("review_request")
            && b.get("head_sha").and_then(Value::as_str) == Some(head)
            && same_repo(b.get("repo"), repo);
        let outcome = b.get("outcome").and_then(Value::as_str);
        if !fits || !matches!(outcome, Some("approved" | "changes_requested")) {
            return Ok(None);
        }
        let findings_ok = match b.get("findings") {
            None => true,
            Some(v) => v.as_array().is_some_and(|a| {
                a.iter().all(|f| {
                    id(f.get("id")).is_some() && f.get("severity").is_some_and(Value::is_string)
                })
            }),
        };
        let acceptance_ok = match b.get("acceptance") {
            None => true,
            Some(v) => v.as_array().is_some_and(|a| {
                a.iter().all(|x| {
                    x.is_object()
                        && int(x.get("index")).is_some()
                        && x.get("kind").is_some_and(Value::is_string)
                        && x.get("met").is_some_and(Value::is_boolean)
                })
            }),
        };
        if !findings_ok || !acceptance_ok {
            return Err(BadInput);
        }
        let ids: Vec<&str> = list(b.get("findings"))
            .iter()
            .filter_map(|f| f["id"].as_str())
            .collect();
        let indexes: Vec<u64> = list(b.get("acceptance"))
            .iter()
            .filter_map(|a| a["index"].as_u64())
            .collect();
        if ids.iter().collect::<HashSet<_>>().len() != ids.len()
            || indexes.iter().collect::<HashSet<_>>().len() != indexes.len()
        {
            return Err(BadInput);
        }
        Ok(Some(b))
    };

    let mut ballots = Vec::new();
    let mut findings: Vec<(String, bool, &str)> = Vec::new();
    for seat in &seats {
        let requests = requests_to(seat, reviews_by);
        if requests.len() > 1 {
            return Err(TwoRequests);
        }
        let Some(request) = requests.first() else {
            continue;
        };
        let Some(result) = review_result(request, seat, reviews_by)? else {
            continue;
        };
        let vote = if result["outcome"] == "approved" {
            "approve"
        } else {
            "reject"
        };
        ballots.push(json!({"seat": seat, "vote": vote}));
        for f in result
            .get("findings")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            let fid = f["id"].as_str().unwrap_or_default();
            let blocking = f["severity"] == "blocker";
            findings.push((format!("{seat}/{fid}"), blocking, "none"));
        }
    }

    let blocking: Vec<usize> = (0..findings.len()).filter(|&i| findings[i].1).collect();
    if let Some(verifier) = verifier.filter(|_| !blocking.is_empty()) {
        let requests = requests_to(verifier, challenge_by - CHALLENGE_MARGIN_SECONDS);
        let conditions: Vec<Option<&Vec<Value>>> = requests
            .iter()
            .map(|r| match r.body().get("acceptance") {
                None => None,
                Some(v) => v.as_array(),
            })
            .collect();
        let shaped = !requests.is_empty()
            && conditions.iter().all(|c| {
                c.is_some_and(|c| {
                    (1..=MOST_CONDITIONS).contains(&c.len())
                        && c.iter()
                            .all(|x| x.get("kind").and_then(Value::as_str) == Some("custom"))
                })
            })
            && conditions
                .iter()
                .map(|c| c.map_or(0, Vec::len))
                .sum::<usize>()
                == blocking.len();
        if shaped {
            let mut offset = 0;
            for (request, c) in requests.iter().zip(&conditions) {
                let size = c.map_or(0, Vec::len);
                if let Some(result) = review_result(request, verifier, challenge_by)? {
                    let mut met = HashMap::new();
                    for a in result
                        .get("acceptance")
                        .and_then(Value::as_array)
                        .map(Vec::as_slice)
                        .unwrap_or_default()
                    {
                        if a["kind"] == "custom" {
                            met.insert(a["index"].as_u64().unwrap_or(u64::MAX), a["met"] == true);
                        }
                    }
                    for i in 0..size {
                        if let Some(&m) = met.get(&(i as u64)) {
                            findings[blocking[offset + i]].2 = if m { "stands" } else { "refuted" };
                        }
                    }
                }
                offset += size;
            }
        }
    }

    let findings: Vec<Value> = findings
        .into_iter()
        .map(|(fid, blocking, challenge)| {
            json!({"id": fid, "blocking": blocking, "evidence": true, "challenge": challenge})
        })
        .collect();
    Ok(json!({
        "rule": o["rule"],
        "quorum": quorum,
        "veto": veto,
        "seats": seats,
        "ballots": ballots,
        "findings": findings,
    }))
}
