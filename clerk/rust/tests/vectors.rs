//! Runs every known-answer vector in clerk/vectors/count.json.

use obi_clerk::{count, verify};
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors/count.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("read vectors"))
        .expect("parse vectors")
}

#[test]
fn count_vectors() {
    let v = vectors();
    let cases = v["count"].as_array().unwrap();
    let mut failures = Vec::new();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let got = count(&case["input"]);
        match (&got, case.get("output"), case.get("error")) {
            (Ok(out), Some(want), None) if out == want => {}
            (Err(e), None, Some(want)) if e.code() == want.as_str().unwrap() => {}
            _ => failures.push(format!("{name}: got {:?}", got.map_err(|e| e.code()))),
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} count vectors failed:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

#[test]
fn verify_vectors() {
    let v = vectors();
    for case in v["verify"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        assert_eq!(
            verify(&case["input"], &case["verdict"]),
            case["valid"].as_bool().unwrap(),
            "{name}"
        );
    }
}

#[test]
fn every_counted_output_verifies() {
    for case in vectors()["count"].as_array().unwrap() {
        if let Some(out) = case.get("output") {
            assert!(verify(&case["input"], out), "{}", case["name"]);
        }
    }
}
