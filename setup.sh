#!/bin/sh
set -eu
cd "$(dirname "$0")"
command -v docker >/dev/null || { printf '%s\n' 'Docker is required.' >&2; exit 1; }
docker compose version >/dev/null
umask 077
mkdir -p .commonfield
chmod 700 .commonfield
docker compose --profile tools run --rm --no-deps --user "$(id -u):$(id -g)" setup
printf '%s\n' 'Setup complete. Start with: docker compose up -d --build --wait'
