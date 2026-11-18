//! Counts each JSON input on its own line of stdin and prints one JSON line per input: the count, or
//! `{"error": code}`. `cargo run --example count < inputs.jsonl`
use std::io::BufRead;

fn main() {
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("read stdin");
        let input: serde_json::Value = serde_json::from_str(&line).expect("one JSON value per line");
        let out = obi_clerk::count(&input).unwrap_or_else(|e| serde_json::json!({ "error": e.code() }));
        println!("{out}");
    }
}
