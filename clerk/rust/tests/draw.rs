//! Runs every known-answer vector in clerk/vectors/draw.json, and the spec's RFC 8785 vectors.

use obi_clerk::draw::{
    anchor_id, beacon_randomness, beacon_round, canonicalize, draw, pool, quicknet, verify_beacon,
    DrawError,
};
use serde_json::Value;

fn load(path: &str) -> Value {
    let path = format!("{}/{path}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).expect("read vectors"))
        .expect("parse vectors")
}

fn vectors() -> Value {
    load("../vectors/draw.json")
}

fn run(cases: &Value, f: fn(&Value) -> Result<Value, DrawError>) -> Vec<String> {
    let mut failures = Vec::new();
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let got = f(&case["input"]);
        match (&got, case.get("output"), case.get("error")) {
            (Ok(out), Some(want), None) if out == want => {}
            (Err(e), None, Some(want)) if e.code() == want.as_str().unwrap() => {}
            _ => failures.push(format!("{name}: got {:?}", got.map_err(|e| e.code()))),
        }
    }
    failures
}

#[test]
fn pool_vectors() {
    let failures = run(&vectors()["pool"], pool);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn draw_vectors() {
    let failures = run(&vectors()["draw"], draw);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn anchor_vectors() {
    for case in vectors()["anchor"].as_array().unwrap() {
        let got = anchor_id(
            case["pool_hash"].as_str().unwrap(),
            case["to"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(got, case["id"].as_str().unwrap(), "{}", case["name"]);
    }
}

#[test]
fn round_vectors() {
    for case in vectors()["round"].as_array().unwrap() {
        let got = beacon_round(
            case["anchored_at"].as_str().unwrap(),
            case["genesis_time"].as_u64().unwrap(),
            case["period"].as_u64().unwrap(),
        )
        .unwrap();
        assert_eq!(got, case["round"].as_u64().unwrap(), "{}", case["name"]);
    }
}

#[test]
fn beacon_randomness_is_the_hash_of_its_signature() {
    let b = &vectors()["beacon"];
    assert_eq!(
        beacon_randomness(b["signature"].as_str().unwrap()).unwrap(),
        b["randomness"].as_str().unwrap()
    );
}

#[test]
fn beacon_checks() {
    let v = vectors();
    let b = &v["beacon"];
    assert_eq!(b["chain"], quicknet::CHAIN);
    assert_eq!(b["public_key"], quicknet::PUBLIC_KEY);
    assert_eq!(b["genesis_time"], quicknet::GENESIS_TIME);
    assert_eq!(b["period"], quicknet::PERIOD);
    for c in v["beacon_checks"].as_array().unwrap() {
        let got = verify_beacon(
            c["round"].as_u64().unwrap(),
            c["signature"].as_str().unwrap(),
        );
        assert_eq!(got, c["valid"].as_bool().unwrap(), "{}", c["name"]);
    }
}

#[test]
fn canonical_json_matches_the_spec_vectors() {
    for v in load("../../spec/conformance/jcs-vectors.json")["vectors"]
        .as_array()
        .unwrap()
    {
        assert_eq!(
            canonicalize(&v["input"]).unwrap(),
            v["canonical"].as_str().unwrap(),
            "{}",
            v["name"]
        );
    }
}

#[test]
fn a_pool_the_clerk_builds_is_one_the_draw_takes() {
    for case in vectors()["pool"].as_array().unwrap() {
        if let Some(out) = case.get("output") {
            let input = serde_json::json!({"pool": out, "randomness": "ab".repeat(32)});
            assert!(draw(&input).is_ok(), "{}", case["name"]);
        }
    }
}

#[test]
fn canonical_json_refuses_numbers_that_are_not_integers() {
    assert_eq!(
        canonicalize(&serde_json::json!({"n": 1.5})),
        Err(DrawError::BadInput)
    );
}

#[test]
fn bad_timestamps_are_refused() {
    for t in [
        "2026-02-30T00:00:00Z",
        "2026-10-27T24:00:00Z",
        "2026-10-27 12:00:00Z",
        "2026-10-27T12:00:00+00:00",
    ] {
        assert!(beacon_round(t, 0, 3).is_err(), "{t}");
    }
}
