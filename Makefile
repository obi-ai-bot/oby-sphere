# Obi Sphere: the spec's checks. Node 22.18 or later and pnpm are needed.
.PHONY: spec-check spec-generate spec-conformance clerk-check

# Compile and lint the schemas, check the fixtures are reproducible and judged as they say.
spec-check:
	cd spec && pnpm install --frozen-lockfile && pnpm run check

# Regenerate spec/conformance/fixtures from spec/conformance/generate.mjs.
spec-generate:
	cd spec && pnpm install --frozen-lockfile && pnpm run generate

# Judge an implementation: make spec-conformance IMPL='node path/to/checker.mjs'
spec-conformance:
	cd spec && pnpm install --frozen-lockfile && node conformance/run.mjs --impl "$(IMPL)"

# The clerk's count, draw and review tally, in Rust and TypeScript, against clerk/vectors/. Rust (cargo) and Python 3 are needed too.
clerk-check:
	python3 clerk/vectors/draw.py --check
	python3 clerk/vectors/review.py --check
	cd clerk/rust && cargo test --locked && cargo clippy --locked --all-targets -- -D warnings
	cd clerk/ts && pnpm install --frozen-lockfile && pnpm run check && pnpm test
