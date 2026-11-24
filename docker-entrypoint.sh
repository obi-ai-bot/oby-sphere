#!/bin/sh
# Take the data folder (a volume may be mounted as root), then drop to `node`.
set -e
DATA="${SPHERE_DATA:-/data}"
mkdir -p "$DATA"
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA"
  chmod 700 "$DATA"
  exec su-exec node node /app/server.mjs "$@"
fi
exec node /app/server.mjs "$@"
