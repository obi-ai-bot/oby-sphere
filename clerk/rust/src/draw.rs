//! The Council draw (`spec/council/draw.md`): who is eligible, the anchor that fixes a pool in the chain,
//! the beacon round that follows it, and the seats drawn by lot from the pool and the round's randomness.
//!
//! [`pool`] builds a pool record from the directory, [`draw`] draws from a pool record, [`anchor_id`] gives
//! the envelope id that fixes a pool hash in the chain, and [`beacon_round`] gives the round that follows an
//! anchor. Everything is a function of its input: the known-answer vectors in `clerk/vectors/draw.json` pin
//! it down, and the TypeScript in `clerk/ts` gives the same answers.

use std::collections::{BTreeMap, HashSet};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::MAX_INT;

/// The protocol's allowed clock skew, in seconds: the round follows its anchor by more than this.
pub const CLOCK_SKEW_SECONDS: u64 = 300;

/// The version of the draw this code implements: the pool record's `draw` (draw.md section 2).
pub const DRAW_VERSION: u64 = 1;

/// Why a draw input can't be used. The code is what the vectors name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrawError {
    BadInput,
    BadVersion,
    BadMembers,
    BadPool,
    BadPanel,
    BadDeclined,
}

impl DrawError {
    pub fn code(self) -> &'static str {
        match self {
            DrawError::BadInput => "bad_input",
            DrawError::BadVersion => "bad_version",
            DrawError::BadMembers => "bad_members",
            DrawError::BadPool => "bad_pool",
            DrawError::BadPanel => "bad_panel",
            DrawError::BadDeclined => "bad_declined",
        }
    }
}

impl std::fmt::Display for DrawError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for DrawError {}

use DrawError::*;

const TERMS: [&str; 8] = [
    "sphere",
    "motion",
    "at",
    "request",
    "exclude",
    "seats",
    "verifiers",
    "diversity",
];

fn int(v: Option<&Value>) -> Option<u64> {
    v?.as_u64().filter(|n| *n <= MAX_INT)
}

fn id(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.is_empty())
}

fn ids(v: Option<&Value>) -> Option<Vec<&str>> {
    v?.as_array()?.iter().map(id).collect()
}

fn is_hex(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}

fn hex_bytes(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("checked hex"))
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
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

/// Strictly ascending as UTF-8 bytes, so also distinct.
fn ascending(items: &[&str]) -> bool {
    items.windows(2).all(|w| w[0].as_bytes() < w[1].as_bytes())
}

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// RFC 8785 canonical JSON (protocol.md section 9), for the values the draw hashes: `BadInput` for a number
/// that isn't an integer.
pub fn canonicalize(value: &Value) -> Result<String, DrawError> {
    let mut out = String::new();
    write_canonical(value, &mut out)?;
    Ok(out)
}

fn write_canonical(value: &Value, out: &mut String) -> Result<(), DrawError> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => match (n.as_u64(), n.as_i64(), n.as_f64()) {
            (Some(u), _, _) => out.push_str(&u.to_string()),
            (_, Some(i), _) => out.push_str(&i.to_string()),
            (_, _, Some(f)) if f.fract() == 0.0 && f.abs() <= MAX_INT as f64 => {
                out.push_str(&(f as i64).to_string())
            }
            _ => return Err(BadInput),
        },
        Value::String(s) => write_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            // Member names sort by their UTF-16 code units (RFC 8785 section 3.2.3).
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(k, out);
                out.push(':');
                write_canonical(&map[k.as_str()], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// The members a pool request and a pool record share (draw.md section 2).
fn check_terms(o: &Map<String, Value>) -> Result<(), DrawError> {
    let ok = o.get("sphere").and_then(id).is_some()
        && is_hex(o.get("motion"))
        && o.get("request").and_then(id).is_some()
        && exact(o.get("at"), &["seq", "hash"], &[])
            .is_some_and(|at| int(at.get("seq")).is_some() && is_hex(at.get("hash")))
        && ids(o.get("exclude")).is_some()
        && int(o.get("seats")).is_some()
        && int(o.get("verifiers")).is_some()
        && exact(o.get("diversity"), &["owners", "vendors"], &[])
            .is_some_and(|d| int(d.get("owners")).is_some() && int(d.get("vendors")).is_some());
    ok.then_some(()).ok_or(BadInput)
}

/// The pool record for a directory: every eligible member, one per owner (draw.md section 2).
pub fn pool(input: &Value) -> Result<Value, DrawError> {
    let mut keys = TERMS.to_vec();
    keys.push("members");
    let o = exact(Some(input), &keys, &[]).ok_or(BadInput)?;
    check_terms(o)?;
    let members = o["members"].as_array().ok_or(BadInput)?;
    for m in members {
        let m = exact(Some(m), &["obi_id", "owner", "accepts"], &["vendors"]).ok_or(BadInput)?;
        let ok = id(&m["obi_id"]).is_some()
            && id(&m["owner"]).is_some()
            && ids(m.get("accepts")).is_some()
            && (!m.contains_key("vendors") || ids(m.get("vendors")).is_some());
        if !ok {
            return Err(BadInput);
        }
    }
    let mut seen = HashSet::new();
    if !members.iter().all(|m| seen.insert(m["obi_id"].as_str())) {
        return Err(BadMembers);
    }
    let request = o["request"].as_str().unwrap();
    let exclude = ids(o.get("exclude")).unwrap();
    // One per owner: the lowest obi_id, compared as bytes.
    let mut best: BTreeMap<&str, &Value> = BTreeMap::new();
    for m in members {
        let owner = m["owner"].as_str().unwrap();
        if !ids(m.get("accepts")).unwrap().contains(&request) || exclude.contains(&owner) {
            continue;
        }
        let obi = m["obi_id"].as_str().unwrap();
        match best.get(owner) {
            Some(cur) if cur["obi_id"].as_str().unwrap() <= obi => {}
            _ => {
                best.insert(owner, m);
            }
        }
    }
    let mut entries: Vec<Value> = best
        .values()
        .map(|m| {
            let mut vendors = ids(m.get("vendors")).unwrap_or_default();
            vendors.sort_unstable();
            vendors.dedup();
            json!({"id": m["obi_id"], "owner": m["owner"], "vendors": vendors})
        })
        .collect();
    entries.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    let mut out = Map::new();
    out.insert("draw".into(), json!(DRAW_VERSION));
    for k in TERMS {
        out.insert(k.into(), o[k].clone());
    }
    let mut ex = exclude;
    ex.sort_unstable();
    ex.dedup();
    out.insert("exclude".into(), json!(ex));
    out.insert("entries".into(), Value::Array(entries));
    Ok(Value::Object(out))
}

/// The pool hash: SHA-256 over "council pool\n" and the record's canonical JSON, as lower-case hex.
pub fn pool_hash(record: &Value) -> Result<String, DrawError> {
    Ok(hex(&sha256(&[
        b"council pool\n",
        canonicalize(record)?.as_bytes(),
    ])))
}

/// The id of an anchor envelope to `to` for a pool hash: a version 8 UUID from SHA-256 (draw.md section 3).
pub fn anchor_id(pool_hash_hex: &str, to: &str) -> Result<String, DrawError> {
    if !is_hex(Some(&json!(pool_hash_hex))) || to.is_empty() {
        return Err(BadInput);
    }
    let digest = sha256(&[
        b"council anchor\n",
        &hex_bytes(pool_hash_hex),
        to.as_bytes(),
    ]);
    let mut d = [0u8; 16];
    d.copy_from_slice(&digest[..16]);
    d[6] = (d[6] & 0x0f) | 0x80;
    d[8] = (d[8] & 0x3f) | 0x80;
    let h = hex(&d);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    ))
}

/// Seconds since 1970 for a protocol timestamp (protocol.md section 2: `2026-10-14T12:00:00Z`).
pub fn unix_seconds(timestamp: &str) -> Result<u64, DrawError> {
    let b = timestamp.as_bytes();
    let shape = b.len() == 20
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b'T',
            13 | 16 => *c == b':',
            19 => *c == b'Z',
            _ => c.is_ascii_digit(),
        });
    if !shape {
        return Err(BadInput);
    }
    let num = |r: std::ops::Range<usize>| timestamp[r].parse::<i64>().unwrap();
    let (y, mo, d, h, mi, s) = (
        num(0..4),
        num(5..7),
        num(8..10),
        num(11..13),
        num(14..16),
        num(17..19),
    );
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days_in_month = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1..=12).contains(&mo)
        || d < 1
        || d > days_in_month[(mo - 1) as usize]
        || h > 23
        || mi > 59
        || s > 59
    {
        return Err(BadInput);
    }
    // Days from 1970-01-01 to the date (Howard Hinnant's days_from_civil).
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let t = days * 86_400 + h * 3_600 + mi * 60 + s;
    u64::try_from(t).map_err(|_| BadInput)
}

/// The first beacon round whose time is more than the clock skew after `anchored_at` (draw.md section 4).
pub fn beacon_round(anchored_at: &str, genesis_time: u64, period: u64) -> Result<u64, DrawError> {
    if period < 1 || genesis_time > MAX_INT || period > MAX_INT {
        return Err(BadInput);
    }
    let t = unix_seconds(anchored_at)? + CLOCK_SKEW_SECONDS;
    if t < genesis_time {
        return Ok(1);
    }
    Ok((t - genesis_time) / period + 2)
}

/// drand's quicknet, the beacon draw.md names (section 4, "The beacon").
pub mod quicknet {
    pub const CHAIN: &str = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
    pub const PUBLIC_KEY: &str = "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
    pub const GENESIS_TIME: u64 = 1692803367;
    pub const PERIOD: u64 = 3;
}

/// A signature is a G1 point in its 48-byte compressed form, and nothing else: another encoding of the same
/// point would verify too and hash to another randomness (draw.md section 4).
fn is_signature(s: &str) -> bool {
    s.len() == 96
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// Whether `signature_hex` is quicknet's signature of `round`: a G1 signature of the SHA-256 of the round as 8
/// big-endian bytes, hashed to the curve as RFC 9380 says, under quicknet's G2 key. The key is quicknet's own,
/// never one from a record: a check that took the key from its input would take a key anyone could sign with.
pub fn verify_beacon(round: u64, signature_hex: &str) -> bool {
    use drand_verify::{G2PubkeyRfc, Pubkey};
    if !(1..=MAX_INT).contains(&round) || !is_signature(signature_hex) {
        return false;
    }
    let Ok(key) = G2PubkeyRfc::from_variable(&hex_bytes(quicknet::PUBLIC_KEY)) else {
        return false;
    };
    key.verify(round, b"", &hex_bytes(signature_hex))
        .unwrap_or(false)
}

/// A beacon round's randomness: SHA-256 of its signature (drand). [`verify_beacon`] checks the signature.
pub fn beacon_randomness(signature_hex: &str) -> Result<String, DrawError> {
    if !is_signature(signature_hex) {
        return Err(BadInput);
    }
    Ok(hex(&sha256(&[&hex_bytes(signature_hex)])))
}

struct Entry<'a> {
    id: &'a str,
    /// The one vendor the seat counts for: its only declared vendor, else none (draw.md section 2).
    counted: Option<&'a str>,
}

/// Whether `slots` more seats from `rest` can bring the counted vendors to `need` (draw.md section 5).
fn can_meet(taken: &HashSet<&str>, slots: usize, rest: &[&Entry], need: usize) -> bool {
    let fresh: HashSet<&str> = rest
        .iter()
        .filter_map(|e| e.counted)
        .filter(|v| !taken.contains(v))
        .collect();
    rest.len() >= slots && taken.len() + slots.min(fresh.len()) >= need
}

/// Draws seats from a pool record and a beacon round's randomness (draw.md sections 4 to 7).
pub fn draw(input: &Value) -> Result<Value, DrawError> {
    let o = exact(Some(input), &["pool", "randomness"], &["declined"]).ok_or(BadInput)?;
    let mut keys = vec!["draw"];
    keys.extend(TERMS);
    keys.push("entries");
    let rec = exact(o.get("pool"), &keys, &[]).ok_or(BadInput)?;
    check_terms(rec)?;
    let version = int(rec.get("draw")).ok_or(BadInput)?;
    if !is_hex(o.get("randomness")) {
        return Err(BadInput);
    }
    let declined = match o.get("declined") {
        Some(v) => ids(Some(v)).ok_or(BadInput)?,
        None => Vec::new(),
    };
    let raw = rec["entries"].as_array().ok_or(BadInput)?;
    let mut entries = Vec::new();
    let mut owners = HashSet::new();
    let mut vendors_sorted = true;
    for e in raw {
        let e = exact(Some(e), &["id", "owner", "vendors"], &[]).ok_or(BadInput)?;
        let (eid, owner, vendors) = (
            id(&e["id"]).ok_or(BadInput)?,
            id(&e["owner"]).ok_or(BadInput)?,
            ids(e.get("vendors")).ok_or(BadInput)?,
        );
        vendors_sorted &= ascending(&vendors);
        owners.insert(owner);
        entries.push((eid, owner, vendors));
    }
    let exclude = ids(rec.get("exclude")).unwrap();
    if version != DRAW_VERSION {
        return Err(BadVersion);
    }
    let entry_ids: Vec<&str> = entries.iter().map(|e| e.0).collect();
    if !ascending(&entry_ids)
        || owners.len() != entries.len()
        || !vendors_sorted
        || !ascending(&exclude)
        || entries.iter().any(|e| exclude.contains(&e.1))
    {
        return Err(BadPool);
    }

    let seats = int(rec.get("seats")).unwrap();
    let verifiers = int(rec.get("verifiers")).unwrap();
    let diversity = &rec["diversity"];
    let (min_owners, need) = (
        int(diversity.get("owners")).unwrap(),
        int(diversity.get("vendors")).unwrap(),
    );
    if seats < 1 || min_owners > seats || need > seats {
        return Err(BadPanel);
    }

    let mut seen = HashSet::new();
    if !declined
        .iter()
        .all(|d| seen.insert(*d) && entry_ids.contains(d))
    {
        return Err(BadDeclined);
    }

    let hash = pool_hash(&Value::Object(rec.clone()))?;
    let randomness = hex_bytes(o["randomness"].as_str().unwrap());
    let seed = sha256(&[b"council seed\n", &hex_bytes(&hash), &randomness]);
    let mut keyed: Vec<([u8; 32], Entry)> = entries
        .iter()
        .map(|(eid, _, vendors)| {
            let key = sha256(&[b"council order\n", &seed, eid.as_bytes()]);
            let counted = (vendors.len() == 1).then(|| vendors[0]);
            (key, Entry { id: eid, counted })
        })
        .collect();
    keyed.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.id.cmp(b.1.id)));
    let order: Vec<&str> = keyed.iter().map(|(_, e)| e.id).collect();
    let mut out = Map::new();
    out.insert("pool_hash".into(), json!(hash));
    out.insert("seed".into(), json!(hex(&seed)));
    out.insert("order".into(), json!(order));

    let available: Vec<&Entry> = keyed
        .iter()
        .map(|(_, e)| e)
        .filter(|e| !declined.contains(&e.id))
        .collect();
    let (seats, verifiers, need) = (seats as usize, verifiers as usize, need as usize);
    if available.len() < seats + verifiers || !can_meet(&HashSet::new(), seats, &available, need) {
        out.insert("outcome".into(), json!("unmet"));
        out.insert("seats".into(), json!([]));
        out.insert("verifiers".into(), json!([]));
        out.insert("vendors".into(), json!(0));
        out.insert("skipped".into(), json!([]));
        return Ok(Value::Object(out));
    }

    let mut taken: Vec<&str> = Vec::new();
    let mut skipped: Vec<&str> = Vec::new();
    let mut vendors: HashSet<&str> = HashSet::new();
    for (i, e) in available.iter().enumerate() {
        if taken.len() == seats {
            break;
        }
        let mut after = vendors.clone();
        if let Some(v) = e.counted {
            after.insert(v);
        }
        if can_meet(&after, seats - taken.len() - 1, &available[i + 1..], need) {
            taken.push(e.id);
            vendors = after;
        } else {
            skipped.push(e.id);
        }
    }
    let chosen: Vec<&str> = available
        .iter()
        .map(|e| e.id)
        .filter(|eid| !taken.contains(eid))
        .take(verifiers)
        .collect();
    out.insert("outcome".into(), json!("drawn"));
    out.insert("seats".into(), json!(taken));
    out.insert("verifiers".into(), json!(chosen));
    out.insert("vendors".into(), json!(vendors.len()));
    out.insert("skipped".into(), json!(skipped));
    Ok(Value::Object(out))
}
