#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# This deliberately refuses the default or any live project.
[ "${COMPOSE_PROJECT_NAME:-}" = commonfield-install-qa ] || { printf '%s\n' 'Refused: set COMPOSE_PROJECT_NAME=commonfield-install-qa for a disposable fresh installation.' >&2; exit 2; }
docker compose exec -T app node docker/smoke.mjs
