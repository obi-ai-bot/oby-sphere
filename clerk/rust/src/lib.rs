//! The clerk: a deterministic vote count.
//!
//! [`count`] takes a count request (JSON, `clerk/README.md`, "Input") and returns the count (JSON,
//! "Output") or an error code. [`verify`] says whether a recorded verdict is exactly the count of its
//! input. Everything is integer arithmetic; the same input always gives the same output, and the
//! known-answer vectors in `clerk/vectors/count.json` pin every rule down. The [`draw`] module draws a
//! panel's seats by lot (`spec/council/draw.md`), pinned down by `clerk/vectors/draw.json`, and [`review`]
//! tallies a review panel's envelopes into a count input (`spec/council/review.md`, `clerk/vectors/review.json`).

pub mod draw;
pub mod review;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// The largest integer an input may hold: 2^53 − 1, so every value is exact in JSON and JavaScript.
pub const MAX_INT: u64 = (1 << 53) - 1;

/// Why an input can't be counted. The code is what the vectors name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    BadInput,
    BadRule,
    BadOptions,
    BadSeats,
    BadQuorum,
    BadFinding,
    UnknownSeat,
    DuplicateBallot,
    WrongBallot,
    BadRanking,
}

impl Error {
    pub fn code(self) -> &'static str {
        match self {
            Error::BadInput => "bad_input",
            Error::BadRule => "bad_rule",
            Error::BadOptions => "bad_options",
            Error::BadSeats => "bad_seats",
            Error::BadQuorum => "bad_quorum",
            Error::BadFinding => "bad_finding",
            Error::UnknownSeat => "unknown_seat",
            Error::DuplicateBallot => "duplicate_ballot",
            Error::WrongBallot => "wrong_ballot",
            Error::BadRanking => "bad_ranking",
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for Error {}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Rule {
    Majority,
    Supermajority { num: u64, den: u64 },
    Unanimity,
    Schulze,
    Borda,
    Median,
}

impl Rule {
    fn yes_no(self) -> bool {
        matches!(
            self,
            Rule::Majority | Rule::Supermajority { .. } | Rule::Unanimity
        )
    }
    fn ranked(self) -> bool {
        matches!(self, Rule::Schulze | Rule::Borda)
    }
}

enum Choice<'a> {
    Vote(&'a str),
    Ranking(Vec<&'a str>),
    Value(u64),
}

struct Ballot<'a> {
    seat: &'a str,
    choice: Choice<'a>,
}

struct Finding<'a> {
    id: &'a str,
    blocking: bool,
    evidence: bool,
    challenge: &'a str,
}

fn has_only(obj: &Map<String, Value>, allowed: &[&str]) -> bool {
    obj.keys().all(|k| allowed.contains(&k.as_str()))
}

fn int(v: &Value) -> Option<u64> {
    v.as_u64().filter(|n| *n <= MAX_INT)
}

fn id(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.is_empty())
}

fn ids(v: &Value) -> Option<Vec<&str>> {
    v.as_array()?.iter().map(id).collect()
}

fn unique(items: &[&str]) -> bool {
    let mut seen = std::collections::HashSet::new();
    items.iter().all(|s| seen.insert(*s))
}

/// Stage 1: the shape of the input (README.md, "Errors", bad_input).
fn shape(input: &Value) -> Result<(), Error> {
    let obj = input.as_object().ok_or(Error::BadInput)?;
    if !has_only(
        obj,
        &[
            "rule",
            "quorum",
            "veto",
            "options",
            "tie_break",
            "seats",
            "ballots",
            "findings",
        ],
    ) {
        return Err(Error::BadInput);
    }
    let rule = obj.get("rule").ok_or(Error::BadInput)?;
    rule.as_object().ok_or(Error::BadInput)?;
    rule.get("kind")
        .and_then(Value::as_str)
        .ok_or(Error::BadInput)?;
    int(obj.get("quorum").ok_or(Error::BadInput)?).ok_or(Error::BadInput)?;
    if let Some(v) = obj.get("veto") {
        v.as_bool().ok_or(Error::BadInput)?;
    }
    if let Some(v) = obj.get("options") {
        ids(v).ok_or(Error::BadInput)?;
    }
    if let Some(v) = obj.get("tie_break") {
        v.as_object().ok_or(Error::BadInput)?;
    }
    ids(obj.get("seats").ok_or(Error::BadInput)?).ok_or(Error::BadInput)?;
    for b in obj
        .get("ballots")
        .and_then(Value::as_array)
        .ok_or(Error::BadInput)?
    {
        let b = b.as_object().ok_or(Error::BadInput)?;
        if !has_only(b, &["seat", "vote", "ranking", "value"]) {
            return Err(Error::BadInput);
        }
        id(b.get("seat").ok_or(Error::BadInput)?).ok_or(Error::BadInput)?;
        let choices = ["vote", "ranking", "value"]
            .iter()
            .filter(|k| b.contains_key(**k))
            .count();
        if choices != 1 {
            return Err(Error::BadInput);
        }
        if let Some(v) = b.get("vote") {
            v.as_str().ok_or(Error::BadInput)?;
        }
        if let Some(v) = b.get("ranking") {
            v.as_array()
                .ok_or(Error::BadInput)?
                .iter()
                .try_for_each(|s| s.as_str().map(|_| ()).ok_or(Error::BadInput))?;
        }
        if let Some(v) = b.get("value") {
            int(v).ok_or(Error::BadInput)?;
        }
    }
    if let Some(v) = obj.get("findings") {
        for f in v.as_array().ok_or(Error::BadInput)? {
            let f = f.as_object().ok_or(Error::BadInput)?;
            if f.len() != 4 || !has_only(f, &["id", "blocking", "evidence", "challenge"]) {
                return Err(Error::BadInput);
            }
            id(&f["id"]).ok_or(Error::BadInput)?;
            f["blocking"].as_bool().ok_or(Error::BadInput)?;
            f["evidence"].as_bool().ok_or(Error::BadInput)?;
            f["challenge"].as_str().ok_or(Error::BadInput)?;
        }
    }
    Ok(())
}

/// Stage 2: the rule, the veto, whether options belong, and the tie-break.
fn rule_of(obj: &Map<String, Value>) -> Result<(Rule, Option<[u8; 32]>), Error> {
    let r = obj["rule"].as_object().unwrap();
    let only_kind = r.len() == 1;
    let rule = match r["kind"].as_str().unwrap() {
        "majority" if only_kind => Rule::Majority,
        "unanimity" if only_kind => Rule::Unanimity,
        "schulze" if only_kind => Rule::Schulze,
        "borda" if only_kind => Rule::Borda,
        "median" if only_kind => Rule::Median,
        "supermajority" if r.len() == 3 => {
            let num = r.get("num").and_then(int).ok_or(Error::BadRule)?;
            let den = r.get("den").and_then(int).ok_or(Error::BadRule)?;
            if num == 0 || num > den {
                return Err(Error::BadRule);
            }
            Rule::Supermajority { num, den }
        }
        _ => return Err(Error::BadRule),
    };
    if obj.get("veto").and_then(Value::as_bool) == Some(true) && !rule.yes_no() {
        return Err(Error::BadRule);
    }
    if obj.contains_key("options") && !rule.ranked() {
        return Err(Error::BadRule);
    }
    let mut seed = None;
    if let Some(tb) = obj.get("tie_break").and_then(Value::as_object) {
        match tb.get("kind").and_then(Value::as_str) {
            Some("none") if tb.len() == 1 => {}
            Some("seeded") if tb.len() == 2 && rule.ranked() => {
                let hex = tb
                    .get("seed")
                    .and_then(Value::as_str)
                    .ok_or(Error::BadRule)?;
                seed = Some(parse_seed(hex).ok_or(Error::BadRule)?);
            }
            _ => return Err(Error::BadRule),
        }
    }
    Ok((rule, seed))
}

fn parse_seed(hex: &str) -> Option<[u8; 32]> {
    let b = hex.as_bytes();
    if b.len() != 64
        || !b
            .iter()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
    {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, pair) in b.chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
    }
    Some(out)
}

/// Counts the input. Returns the count as a JSON object, or the first error in the order README.md gives.
pub fn count(input: &Value) -> Result<Value, Error> {
    shape(input)?;
    let obj = input.as_object().unwrap();
    let (rule, seed) = rule_of(obj)?;

    let options: Vec<&str> = obj.get("options").and_then(ids).unwrap_or_default();
    if rule.ranked() && (options.len() < 2 || !unique(&options)) {
        return Err(Error::BadOptions);
    }
    let seats = ids(&obj["seats"]).unwrap();
    if seats.is_empty() || !unique(&seats) {
        return Err(Error::BadSeats);
    }
    let quorum = int(&obj["quorum"]).unwrap();
    if quorum < 1 || quorum > seats.len() as u64 {
        return Err(Error::BadQuorum);
    }

    let mut findings = Vec::new();
    for f in obj
        .get("findings")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let finding = Finding {
            id: f["id"].as_str().unwrap(),
            blocking: f["blocking"].as_bool().unwrap(),
            evidence: f["evidence"].as_bool().unwrap(),
            challenge: f["challenge"].as_str().unwrap(),
        };
        if findings.iter().any(|g: &Finding| g.id == finding.id)
            || !["none", "stands", "refuted"].contains(&finding.challenge)
        {
            return Err(Error::BadFinding);
        }
        findings.push(finding);
    }

    let mut ballots: Vec<Ballot> = Vec::new();
    for b in obj["ballots"].as_array().unwrap() {
        let seat = b["seat"].as_str().unwrap();
        if !seats.contains(&seat) {
            return Err(Error::UnknownSeat);
        }
        if ballots.iter().any(|x| x.seat == seat) {
            return Err(Error::DuplicateBallot);
        }
        let choice = if let Some(v) = b.get("vote") {
            Choice::Vote(v.as_str().unwrap())
        } else if let Some(v) = b.get("ranking") {
            Choice::Ranking(
                v.as_array()
                    .unwrap()
                    .iter()
                    .map(|s| s.as_str().unwrap())
                    .collect(),
            )
        } else {
            Choice::Value(int(&b["value"]).unwrap())
        };
        let fits = match &choice {
            Choice::Vote("abstain") => true,
            Choice::Vote(v) => rule.yes_no() && (*v == "approve" || *v == "reject"),
            Choice::Ranking(_) => rule.ranked(),
            Choice::Value(_) => rule == Rule::Median,
        };
        if !fits {
            return Err(Error::WrongBallot);
        }
        if let Choice::Ranking(r) = &choice {
            if r.len() != options.len() || !unique(r) || !r.iter().all(|o| options.contains(o)) {
                return Err(Error::BadRanking);
            }
        }
        ballots.push(Ballot { seat, choice });
    }

    let present = ballots.len() as u64;
    let abstain = ballots
        .iter()
        .filter(|b| matches!(b.choice, Choice::Vote("abstain")))
        .count() as u64;
    let no_quorum = present < quorum;
    let mut out = Map::new();
    out.insert("seats".into(), json!(seats.len()));
    out.insert("present".into(), json!(present));

    if rule.yes_no() {
        let approve = ballots
            .iter()
            .filter(|b| matches!(b.choice, Choice::Vote("approve")))
            .count() as u64;
        let reject = present - approve - abstain;
        let veto = obj.get("veto").and_then(Value::as_bool).unwrap_or(false);
        let blocked: Vec<&str> = if veto {
            findings
                .iter()
                .filter(|f| f.blocking && f.evidence && f.challenge != "refuted")
                .map(|f| f.id)
                .collect()
        } else {
            Vec::new()
        };
        let outcome = if no_quorum {
            "no_quorum"
        } else if !blocked.is_empty() {
            "reject"
        } else if approve + reject == 0 {
            "no_votes"
        } else {
            match rule {
                Rule::Majority if approve > reject => "approve",
                Rule::Majority if approve < reject => "reject",
                Rule::Majority => "tie",
                Rule::Supermajority { num, den } => {
                    if approve as u128 * den as u128 >= num as u128 * (approve + reject) as u128 {
                        "approve"
                    } else {
                        "reject"
                    }
                }
                _ if reject == 0 => "approve",
                _ => "reject",
            }
        };
        out.insert("outcome".into(), json!(outcome));
        out.insert(
            "tally".into(),
            json!({"approve": approve, "reject": reject, "abstain": abstain}),
        );
        out.insert("blocked_by".into(), json!(blocked));
    } else if rule.ranked() {
        let n = options.len();
        let rankings: Vec<Vec<usize>> = ballots
            .iter()
            .filter_map(|b| match &b.choice {
                Choice::Ranking(r) => Some(
                    r.iter()
                        .map(|o| options.iter().position(|x| x == o).unwrap())
                        .collect(),
                ),
                _ => None,
            })
            .collect();
        let winners: Vec<usize> = if rule == Rule::Borda {
            let mut scores = vec![0u64; n];
            for r in &rankings {
                for (pos, &o) in r.iter().enumerate() {
                    scores[o] += (n - 1 - pos) as u64;
                }
            }
            let best = *scores.iter().max().unwrap();
            out.insert("scores".into(), json!(scores));
            (0..n).filter(|&i| scores[i] == best).collect()
        } else {
            let (d, p) = schulze(n, &rankings);
            out.insert("pairwise".into(), json!(d));
            out.insert("strengths".into(), json!(p));
            (0..n)
                .filter(|&i| (0..n).all(|j| j == i || p[i][j] >= p[j][i]))
                .collect()
        };
        let outcome = if no_quorum {
            "no_quorum"
        } else if rankings.is_empty() {
            "no_votes"
        } else if winners.len() == 1 || seed.is_some() {
            "elected"
        } else {
            "tie"
        };
        let tie_broken = outcome == "elected" && winners.len() > 1;
        if outcome == "elected" {
            let winner = if tie_broken {
                *winners
                    .iter()
                    .min_by_key(|&&i| tie_key(seed.as_ref().unwrap(), options[i]))
                    .unwrap()
            } else {
                winners[0]
            };
            out.insert("winner".into(), json!(options[winner]));
        }
        out.insert("outcome".into(), json!(outcome));
        out.insert(
            "tally".into(),
            json!({"ranked": rankings.len(), "abstain": abstain}),
        );
        out.insert(
            "winners".into(),
            json!(winners.iter().map(|&i| options[i]).collect::<Vec<_>>()),
        );
        out.insert("tie_broken".into(), json!(tie_broken));
    } else {
        let mut values: Vec<u64> = ballots
            .iter()
            .filter_map(|b| {
                if let Choice::Value(v) = b.choice {
                    Some(v)
                } else {
                    None
                }
            })
            .collect();
        values.sort_unstable();
        let outcome = if no_quorum {
            "no_quorum"
        } else if values.is_empty() {
            "no_votes"
        } else {
            out.insert("value".into(), json!(values[(values.len() - 1) / 2]));
            "value"
        };
        out.insert("outcome".into(), json!(outcome));
        out.insert(
            "tally".into(),
            json!({"values": values.len(), "abstain": abstain}),
        );
    }
    Ok(Value::Object(out))
}

/// The pairwise preferences `d[i][j]` (ballots ranking i above j) and the Schulze strongest-path
/// strengths `p[i][j]`, both indexed in the options' order.
fn schulze(n: usize, rankings: &[Vec<usize>]) -> (Vec<Vec<u64>>, Vec<Vec<u64>>) {
    let mut d = vec![vec![0u64; n]; n];
    for r in rankings {
        for (a, &i) in r.iter().enumerate() {
            for &j in &r[a + 1..] {
                d[i][j] += 1;
            }
        }
    }
    let mut p = vec![vec![0u64; n]; n];
    for i in 0..n {
        for j in 0..n {
            if i != j && d[i][j] > d[j][i] {
                p[i][j] = d[i][j];
            }
        }
    }
    for i in 0..n {
        for j in 0..n {
            if i == j {
                continue;
            }
            for k in 0..n {
                if k != i && k != j {
                    p[j][k] = p[j][k].max(p[j][i].min(p[i][k]));
                }
            }
        }
    }
    (d, p)
}

/// The seeded tie-break's key for an option: SHA-256 over "tie-break\n", the seed's 32 bytes and the
/// option id's UTF-8 bytes. The tied option with the lowest key wins.
fn tie_key(seed: &[u8; 32], option: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"tie-break\n");
    h.update(seed);
    h.update(option.as_bytes());
    h.finalize().into()
}

/// Whether `verdict` is exactly the count of `input`: the same JSON value, member for member. An input
/// that can't be counted has no valid verdict.
pub fn verify(input: &Value, verdict: &Value) -> bool {
    matches!(count(input), Ok(c) if &c == verdict)
}
