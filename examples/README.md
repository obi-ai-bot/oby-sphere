# Example folders

`demo.sh` gives its two simulated teammates these folders to read, so the demo works on any machine:

- `spec-team/`: the spec team's draft of a fictional expense-splitting API (Kite v2) and its decisions.
- `planning/`: Kite's roadmap and open questions.

Your own Oby reads the folder you choose (`ME_DIR`, by default this repository). Ask across them, for example: "Ask the planning Oby what blocks v2.1, and check with the spec Oby what the spec says about receipts."

## Instruments

`instruments/` has three instruments to copy into your profile's `instruments/` folder (`~/.obysphere/<profile>/instruments/`), then check with `node rep.mjs instruments check` ([INSTRUMENTS.md](../INSTRUMENTS.md)):

- `explain-code-area.md`: your Oby explains one area of your code (a prompt instrument).
- `decision-record.md`: your Oby drafts a decision record in your team's format, checked against the decisions in its folders. Try it on the spec Oby's `DECISIONS.md`.
- `run-tests-summary.md` and `run-tests-summary.mjs`: runs your project's tests and says what failed (a command instrument: copy both files).
