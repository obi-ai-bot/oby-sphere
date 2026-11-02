//! Runs every known-answer vector in clerk/vectors/review.json, and counts each tally with the clerk.

use obi_clerk::{count, review::tally};
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors/review.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("read vectors"))
        .expect("parse vectors")
}

#[test]
fn tally_vectors() {
    let mut failures = Vec::new();
    for case in vectors()["tally"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let got = tally(&case["input"]);
        match (&got, case.get("output"), case.get("error")) {
            (Ok(out), Some(want), None) if out == want => {}
            (Err(e), None, Some(want)) if e.code() == want.as_str().unwrap() => {}
            _ => failures.push(format!("{name}: got {:?}", got.map_err(|e| e.code()))),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn every_tally_is_a_count_input_the_clerk_counts() {
    for case in vectors()["tally"].as_array().unwrap() {
        if let Some(out) = case.get("output") {
            assert!(count(out).is_ok(), "{}", case["name"]);
        }
    }
}
