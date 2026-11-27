#!/bin/sh
# Install the obysphere command for this user: no sudo, nothing outside your home folder.
#
#   curl -fsSL https://raw.githubusercontent.com/obi-ai-bot/oby-sphere/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/obi-ai-bot/oby-sphere/main/install.sh | sh -s -- --channel main
#
# stable (the default): the latest GitHub release, checked against its SHA256SUMS.
# main: the code on main as it is now (before the first release). It isn't checksummed.
#
# It puts the app in ~/.local/share/obysphere/<version>/ (OBYSPHERE_APP_HOME), points
# `current` at it, and adds ~/.local/bin/obysphere (OBYSPHERE_BIN_DIR). It never creates
# ~/.obysphere: your profiles appear when you join. Needs Node 22 or later.
#
# Everything happens in main, run on the script's last line: a download cut short runs nothing.
set -eu

say() { printf '%s\n' "$*"; }
fail() { printf 'obysphere install: %s\n' "$*" >&2; exit 1; }

main() {
REPO="obi-ai-bot/oby-sphere"
APP_HOME="${OBYSPHERE_APP_HOME:-$HOME/.local/share/obysphere}"
BIN_DIR="${OBYSPHERE_BIN_DIR:-$HOME/.local/bin}"
RELEASES_API="https://api.github.com/repos/$REPO"
DOWNLOAD_BASE="https://github.com/$REPO"
MAIN_TARBALL="https://codeload.github.com/$REPO/tar.gz/refs/heads/main"

# The code comes from GitHub over https. For tests only, with OBYSPHERE_TEST=1,
# OBYSPHERE_RELEASES_API and OBYSPHERE_DOWNLOAD_BASE send it to a server on this machine (plain
# http), both of them, and nowhere else; without it they're refused, wherever they were set.
if [ -n "${OBYSPHERE_RELEASES_API:-}${OBYSPHERE_DOWNLOAD_BASE:-}" ]; then
  case "${OBYSPHERE_TEST:-}" in
    1|true|yes|on) ;;
    *) fail "OBYSPHERE_RELEASES_API and OBYSPHERE_DOWNLOAD_BASE are for tests only (with OBYSPHERE_TEST=1, and a server on this machine), so nothing was installed. Unset them, and the app comes from GitHub." ;;
  esac
  RELEASES_API="${OBYSPHERE_RELEASES_API:-$RELEASES_API}"
  if [ -n "${OBYSPHERE_DOWNLOAD_BASE:-}" ]; then
    DOWNLOAD_BASE="$OBYSPHERE_DOWNLOAD_BASE"
    MAIN_TARBALL="$DOWNLOAD_BASE/archive/refs/heads/main.tar.gz"
  fi
  # http://127.0.0.1:<port> or http://localhost:<port>, then a plain path: nothing curl would read as
  # a user name before another host (http://localhost:x@elsewhere), nor a query or a fragment
  for u in "$RELEASES_API" "$DOWNLOAD_BASE"; do
    case "$u" in
      http://127.0.0.1:*) rest="${u#http://127.0.0.1:}" ;;
      http://localhost:*) rest="${u#http://localhost:}" ;;
      *) rest="" ;;
    esac
    case "${rest%%/*}" in ''|*[!0-9]*) fail "refusing to download from $u: the app comes from GitHub only" ;; esac
    case "$rest" in *[!0-9A-Za-z./_~-]*) fail "refusing to download from $u: the app comes from GitHub only" ;; esac
  done
  testing=1
else
  testing=0
fi

channel=stable
while [ $# -gt 0 ]; do
  case "$1" in
    --channel) [ $# -ge 2 ] || fail "--channel needs stable or main"; channel="$2"; shift 2 ;;
    --channel=*) channel="${1#--channel=}"; shift ;;
    -h|--help)
      say "install.sh [--channel stable|main]: installs the obysphere command for this user."
      say "  stable (the default): the latest release, checked against its SHA256SUMS."
      say "  main: the code on main as it is now (not checksummed)."
      say "  OBYSPHERE_APP_HOME (default ~/.local/share/obysphere) and OBYSPHERE_BIN_DIR (default ~/.local/bin) move them."
      exit 0 ;;
    *) fail "unknown option: $1 (try --channel main)" ;;
  esac
done
case "$channel" in stable|main) ;; *) fail "--channel is stable or main" ;; esac

# ---- Node 22 or later
if ! command -v node >/dev/null 2>&1; then
  fail "the Obysphere needs Node 22 or later, and there's no node on this computer.
  Install it from https://nodejs.org (or: brew install node, or nvm install 22), then run this again."
fi
node_version="$(node --version 2>/dev/null || true)"
node_major="${node_version#v}"
node_major="${node_major%%.*}"
case "$node_major" in ''|*[!0-9]*) node_major=0 ;; esac
if [ "$node_major" -lt 22 ]; then
  fail "the Obysphere needs Node 22 or later; this computer has ${node_version:-an unknown version}.
  Install a newer one from https://nodejs.org (or: brew upgrade node, or nvm install 22), then run this again."
fi

# ---- tools: curl (https only, redirects too), a SHA-256, tar. Not wget: its --https-only is for
# recursive downloads, and doesn't keep a single download's redirects on https.
command -v curl >/dev/null 2>&1 || fail "this needs curl to download the Obysphere: it keeps every redirect on HTTPS, which wget can't promise. Install curl (on Debian or Ubuntu: sudo apt install curl), then run this again."
if [ "$testing" = 1 ]; then protos='=https,http'; else protos='=https'; fi
fetch() { curl -fsSL --proto "$protos" --proto-redir '=https' -o "$2" "$1"; }
if command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
elif command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
else
  fail "this needs shasum or sha256sum to check the download."
fi
command -v tar >/dev/null 2>&1 || fail "this needs tar to unpack the download."

tmp="$(mktemp -d 2>/dev/null || mktemp -d -t obysphere)"
stage=""
trap 'rm -rf "$tmp" ${stage:+"$stage"}' EXIT
trap 'exit 1' INT TERM

# ---- download (and check)
if [ "$channel" = stable ]; then
  fetch "$RELEASES_API/releases/latest" "$tmp/release.json" 2>/dev/null || fail "there's no release yet (or GitHub didn't answer).
  For the newest code on main:  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sh -s -- --channel main"
  tag="$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp/release.json" | head -n 1)"
  version="${tag#v}"
  case "$version" in
    ''|*[!0-9A-Za-z.+-]*) fail "the latest release's tag isn't a version: '$tag'" ;;
  esac
  file="obysphere-$version.tar.gz"
  say "Downloading the Obysphere $version…"
  fetch "$DOWNLOAD_BASE/releases/download/$tag/$file" "$tmp/$file" || fail "couldn't download $file"
  fetch "$DOWNLOAD_BASE/releases/download/$tag/SHA256SUMS" "$tmp/SHA256SUMS" || fail "couldn't download the release's SHA256SUMS"
  want="$(awk -v f="$file" '$2 == f || $2 == "*" f { print $1; exit }' "$tmp/SHA256SUMS")"
  [ -n "$want" ] || fail "the release's SHA256SUMS has no line for $file, so it can't be checked. Nothing was installed."
  got="$(sha256 "$tmp/$file")"
  [ "$got" = "$want" ] || fail "$file doesn't match the release's SHA256SUMS (expected $want, got $got). Nothing was installed."
  say "✓ it matches the release's SHA256SUMS"
  tarball="$tmp/$file"
else
  say "Downloading the code on main…"
  say "  (main isn't checksummed: you get the code on main as it is now, from GitHub)"
  fetch "$MAIN_TARBALL" "$tmp/main.tar.gz" || fail "couldn't download the code on main"
  tarball="$tmp/main.tar.gz"
fi

# ---- unpack into the app home, next to the versions already there
mkdir -p "$APP_HOME"
stage="$APP_HOME/.unpack-$$"
rm -rf "$stage"
mkdir "$stage"
tar -xzf "$tarball" -C "$stage" || fail "couldn't unpack the download"
top=""
for d in "$stage"/*/; do
  [ -d "$d" ] || continue
  [ -z "$top" ] || fail "the download isn't one app folder"
  top="${d%/}"
done
[ -n "$top" ] || fail "the download is empty"
for f in obysphere.mjs rep.mjs server.mjs package.json public/index.html; do
  [ -f "$top/$f" ] || fail "the download has no $f"
done
pkg_version="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$top/package.json" | head -n 1)"
if [ "$channel" = stable ]; then
  [ "$pkg_version" = "$version" ] || fail "the release is $version, but its package.json says '$pkg_version'"
else
  version="$pkg_version+main.$(sha256 "$tarball" | cut -c 1-8)"
fi
# a folder name: digits first, then letters, digits, . + and - only (never a / or ..)
case "$version" in
  *[!0-9A-Za-z.+-]*|*..*) fail "its package.json has no usable version: '$pkg_version'" ;;
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "its package.json has no usable version: '$pkg_version'" ;;
esac

if [ -f "$APP_HOME/$version/rep.mjs" ]; then
  say "$version is here already."
else
  rm -rf "${APP_HOME:?}/$version"
  mv "$top" "$APP_HOME/$version"
fi
chmod 755 "$APP_HOME/$version/obysphere.mjs" 2>/dev/null || true

# current -> this version; what it pointed at before stays as previous (obysphere update --rollback)
before="$(readlink "$APP_HOME/current" 2>/dev/null || true)"
before="${before##*/}"
if [ "$before" != "$version" ]; then
  ln -sfn "$version" "$APP_HOME/current"
  if [ -n "$before" ] && [ -d "$APP_HOME/$before" ]; then ln -sfn "$before" "$APP_HOME/previous"; fi
fi
umask 077
printf '{\n  "channel": "%s",\n  "version": "%s"\n}\n' "$channel" "$version" > "$APP_HOME/install.json"
umask 022

# ---- the obysphere command: ours is a plain file with the mark on its second line (never a
# link, which could be someone's own); a new one is renamed over it
mkdir -p "$BIN_DIR"
shim="$BIN_DIR/obysphere"
ours=1
if [ -L "$shim" ]; then
  ours=0
elif [ -e "$shim" ]; then
  case "$(sed -n 2p "$shim" 2>/dev/null)" in
    '# obysphere shim'*) ;;
    *) ours=0 ;;
  esac
fi
if [ "$ours" = 0 ]; then
  say "! $shim is there already and isn't ours, so it's left as it is."
  say "  Run the Obysphere with: node --preserve-symlinks-main '$APP_HOME/current/obysphere.mjs'"
else
  q_app="$(printf '%s' "$APP_HOME/current/obysphere.mjs" | sed "s/'/'\\\\''/g")"
  {
    printf '#!/bin/sh\n'
    printf '# obysphere shim: runs the installed version (obysphere update switches it)\n'
    printf "exec node --preserve-symlinks-main '%s' \"\$@\"\n" "$q_app"
  } > "$shim.tmp.$$"
  chmod 755 "$shim.tmp.$$"
  mv -f "$shim.tmp.$$" "$shim"
fi

say ""
say "✓ The Obysphere $version is installed in $APP_HOME/$version"
say "  The command: $shim"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    say ""
    say "$BIN_DIR isn't on your PATH yet. Add it, then open a new terminal:"
    case "${SHELL:-}" in
      */zsh) rc="$HOME/.zshrc" ;;
      */bash) rc="$HOME/.bashrc" ;;
      *) rc="$HOME/.profile" ;;
    esac
    say "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> $rc"
    ;;
esac
say ""
say "Next: join with the invite link someone sent you, then go online."
say "  obysphere join \"<invite link>\" --name <handle> --owner \"<Your Name>\" --cwd <the folder your Oby may read>"
say "  obysphere start"
}

main "$@"
