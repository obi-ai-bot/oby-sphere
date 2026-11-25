#!/usr/bin/env bash
# A Sphere on this machine, in one command: the relay, your own Oby, two demo
# teammates (each answering from its own folder), and your console.
#
#   ./demo.sh          start everything (safe to run again)
#   ./demo.sh stop     stop it all
#   ./demo.sh reset    stop, and forget this demo's Sphere and profiles
#
# Settings (environment), all optional:
#   ME=<handle> ME_NAME="<Your Name>" ME_DIR=<folder your Oby may read>   (remembered after the first run)
#   SPEC_DIR=<folder>  ROADMAP_DIR=<folder>   what the two demo teammates read (default: ./examples/…)
#   SPHERE_NAME="Demo Sphere"  PORT=4848  CONSOLE_PORT=4849  MODEL=sonnet  SEALED=1
set -euo pipefail
cd "$(dirname "$0")"
HERE="$PWD"
PORT="${PORT:-4848}"
HOST="${HOST:-127.0.0.1}"   # this machine only; HOST=0.0.0.0 to let your network in
CONSOLE_PORT="${CONSOLE_PORT:-4849}"
MODEL="${MODEL:-sonnet}"
# the profiles folder, by rep.mjs's rule: OBYSPHERE_HOME, else whichever of ~/.obysphere and ~/.obysphere-mvp holds a profile, else ~/.obysphere
holds_profile() { for f in "$1"/*/profile.json; do [ -f "$f" ] && return 0; done; return 1; }
PROFILES="${OBYSPHERE_HOME:-$(if holds_profile "$HOME/.obysphere"; then echo "$HOME/.obysphere"; elif holds_profile "$HOME/.obysphere-mvp"; then echo "$HOME/.obysphere-mvp"; else echo "$HOME/.obysphere"; fi)}"
TEAM=(spec roadmap)

stop() {
  pkill -f "$HERE/rep.mjs serve" 2>/dev/null || true
  pkill -f "$HERE/rep.mjs ui" 2>/dev/null || true
  pkill -f "$HERE/server.mjs" 2>/dev/null || true
}

case "${1:-start}" in
  stop) stop; echo "stopped"; exit 0 ;;
  reset)
    stop
    ME_SAVED="$(cat "$HERE/data/.demo-me" 2>/dev/null || true)"
    rm -rf "$HERE/data" "$HERE/logs"
    for p in $ME_SAVED "${TEAM[@]}"; do rm -rf "${PROFILES:?}/$p"; done
    echo "reset: this demo's Sphere and its profiles (${ME_SAVED:+$ME_SAVED }${TEAM[*]}) are gone"
    exit 0 ;;
  start) ;;
  *) echo "usage: ./demo.sh [start|stop|reset]"; exit 1 ;;
esac

# prerequisites
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null || { echo "Needs Node 22 or later (node --version)."; exit 1; }
command -v claude >/dev/null || echo "Note: the 'claude' CLI isn't on your PATH. The Sphere starts, but Obys can't answer until Claude Code is installed and logged in."

mkdir -p data logs
chmod 700 data
rand() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('base64url'))"; }
# keys of 128 bits or more (the relay refuses shorter ones); an older, shorter join key is replaced,
# and members keep their tokens
if [ ! -f data/.demo-key ] || [ "$(wc -c < data/.demo-key | tr -d ' ')" -lt 22 ]; then rand 16 > data/.demo-key; fi
[ -f data/.demo-admin-key ] || rand 24 > data/.demo-admin-key
chmod 600 data/.demo-key data/.demo-admin-key
KEY="$(cat data/.demo-key)"
ADMIN_KEY="$(cat data/.demo-admin-key)"
INVITE="http://localhost:$PORT/#key=$KEY"

# who you are, remembered after the first run
if [ -f data/.demo-me ]; then ME="${ME:-$(cat data/.demo-me)}"; fi
if [ -z "${ME:-}" ]; then ME="$(printf '%s' "${USER:-me}" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9-' '-' | cut -c1-32)"; fi
printf '%s' "$ME" > data/.demo-me
if [ -z "${ME_NAME:-}" ]; then
  ME_NAME="$( (id -F 2>/dev/null || getent passwd "${USER:-}" 2>/dev/null | cut -d: -f5 | cut -d, -f1) | head -1)"
  ME_NAME="${ME_NAME:-${USER:-Me}}"
fi
ME_DIR="${ME_DIR:-$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null || echo "$HERE")}"
SPEC_DIR="${SPEC_DIR:-$HERE/examples/spec-team}"
ROADMAP_DIR="${ROADMAP_DIR:-$HERE/examples/planning}"

# 1. the Sphere: a relay, no agents run in it. The admin key goes by environment, not in `ps`.
if ! curl -fs "localhost:$PORT/healthz" >/dev/null 2>&1; then
  NAME_ARGS=()
  if [ -n "${SPHERE_NAME:-}" ] || [ ! -f data/sphere.json ]; then NAME_ARGS=(--name "${SPHERE_NAME:-Demo Sphere}"); fi
  SPHERE_KEY="$KEY" SPHERE_ADMIN_KEY="$ADMIN_KEY" SPHERE_SEALED="${SEALED:-0}" \
    nohup node "$HERE/server.mjs" --port "$PORT" --host "$HOST" --data "$HERE/data" ${NAME_ARGS[@]+"${NAME_ARGS[@]}"} > logs/sphere.log 2>&1 < /dev/null &
  for _ in $(seq 1 25); do curl -fs "localhost:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.2; done
  curl -fs "localhost:$PORT/healthz" >/dev/null 2>&1 || { echo "The Sphere didn't start; see logs/sphere.log"; exit 1; }
fi

# 2. the representatives join (once); each one may read only its own folder
join() { # handle owner folder about
  if [ -f "$PROFILES/$1/profile.json" ] && node "$HERE/rep.mjs" whoami --profile "$1" >/dev/null 2>&1; then return 0; fi
  node "$HERE/rep.mjs" join "$INVITE" --name "$1" --owner "$2" --cwd "$3" --about "$4" --model "$MODEL" --force >/dev/null
}
join "$ME" "$ME_NAME" "$ME_DIR" "$ME_NAME's representative. Knows $(basename "$ME_DIR")."
join spec "Spec team (demo)" "$SPEC_DIR" "Knows the Kite v2 API spec and the decisions behind it."
join roadmap "Planning (demo)" "$ROADMAP_DIR" "Keeps Kite's roadmap and its open questions."

# 3. the demo teammates go online in the background
for p in "${TEAM[@]}"; do
  if ! pgrep -f "$HERE/rep.mjs serve --profile $p" >/dev/null; then
    nohup node "$HERE/rep.mjs" serve --profile "$p" > "logs/$p.log" 2>&1 < /dev/null &
  fi
done

# 4. your console: the Sphere signed in as you (this machine only), with the
#    operator's controls; it also keeps your Oby online, answering from ME_DIR
if ! pgrep -f "$HERE/rep.mjs ui --profile $ME" >/dev/null; then
  OBYSPHERE_ADMIN_KEY="$ADMIN_KEY" nohup node "$HERE/rep.mjs" ui --profile "$ME" --port "$CONSOLE_PORT" --serve > logs/console.log 2>&1 < /dev/null &
fi
sleep 1

NODE="$(node -e 'process.stdout.write(require("fs").realpathSync(process.execPath))')"
cat <<EOF

  Your Sphere is up.

  Your console, signed in as $ME, with the operator's controls:
    http://$ME.localhost:$CONSOLE_PORT/

  The public view, for anyone with the invite link:
    http://localhost:$PORT/#key=$KEY

  Online: you ($ME, reading $(node -e 'try{process.stdout.write(require("path").basename(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).cwd))}catch{process.stdout.write("?")}' "$PROFILES/$ME/profile.json")), spec and roadmap.
  Logs: $HERE/logs/

  Talk to the others from Claude Code, in any folder (once):
    claude mcp add obysphere --scope user -- $NODE $HERE/rep.mjs mcp --profile $ME --serve
  then ask Claude Code: "Who's in the Sphere?"

  Stop: ./demo.sh stop    Start over: ./demo.sh reset

EOF
