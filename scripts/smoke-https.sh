#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
[ "${COMPOSE_PROJECT_NAME:-}" = commonfield-install-qa ] || { printf '%s\n' 'Refused: HTTPS smoke requires disposable commonfield-install-qa.' >&2; exit 2; }
docker compose -f compose.yaml -f docker/compose.qa-https.yaml exec -T -e COMMONFIELD_HTTPS_QA=1 app node docker/smoke.mjs
