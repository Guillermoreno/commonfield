# Tests and release boundary

The Docker build installs the unchanged pinned dependency lockfile, verifies the pnpm distribution checksum, runs `pnpm test`, `pnpm run typecheck`, and compiles both backend and frontend. No host JavaScript tooling is needed. `docker build --target build .` reruns the build stage checks when inputs change.

Included tests cover core policies, invitation lifecycle and composition, sticky mutation ledger, generation delivery, session deadlines, bootstrap ownership, React board/access UI and portable deployment contracts. Tests needing private review registries, privileged test-database enrollment, machine-specific attestation, immutable historical evidence, external design snapshots and the old operational harness are deliberately excluded; they are not portable tests and their old results are not attributed to this release. The separate portable entrypoint reuses the actual application and PostgreSQL writer authority, rather than weakening that original protected harness.

## Disposable fresh-install smoke

Never run the smoke against real user data: it claims a new administrator and writes board/invitation data. It refuses any project other than `commonfield-install-qa`. Choose currently unused loopback ports; the following are examples, not reserved ports:

```sh
export COMPOSE_PROJECT_NAME=commonfield-install-qa
export APP_PORT=18846 MAILPIT_PORT=18847 PUBLIC_ORIGIN=http://127.0.0.1:18846
./setup.sh
docker compose build
docker compose up -d --wait
./scripts/smoke.sh
docker compose run --rm migrate  # verify no-op migration replay
# Cleanup ONLY this disposable project when verification is complete:
docker compose down -v
```

The test runs inside the non-root app container and checks readiness, compiled frontend/SPA/error routing, first user-owned bootstrap and replay rejection, login/cookie/session, persisted board write, cross-origin mutation rejection, WebSocket subscription and cross-origin rejection, retained invitation URLs and delivery to the private capture service only. It never prints generated passwords, cookies or invitation URLs. It requires a fresh unclaimed database and intentionally fails on a used database. To repeat, create a disposable empty QA volume, not a reset of real data. `.commonfield/` may be retained for a fresh disposable QA cluster but must not be copied into source control.

## Local HTTPS proxy smoke

`docker/compose.qa-https.yaml` and `docker/Caddyfile.qa` are **test-only**: they use a private self-signed Caddy CA and an unused loopback port 18848, never public ACME or production trust settings. On a fresh disposable `commonfield-install-qa` database:

```sh
export COMPOSE_PROJECT_NAME=commonfield-install-qa
export APP_PORT=18846 MAILPIT_PORT=18847
./setup.sh
docker compose -f compose.yaml -f docker/compose.qa-https.yaml up -d --build --wait
./scripts/smoke-https.sh
docker compose exec -T app node docker/verify-database.mjs
```

The same functional smoke is sent through real HTTPS Caddy reverse proxying and WSS; it verifies Secure cookies, successful subscriptions and rejection of a foreign origin. Only this explicitly selected QA transport accepts its self-signed certificate. Do not use the QA override for hosting. The HTTP and HTTPS smoke each need their own fresh disposable database (clean up only QA resources between them).

For a server deployment, inspect HTTPS certificates and Secure cookie flags in the browser and verify live WebSockets over your chosen proxy before relying on it. Public DNS/ACME provisioning is environment-specific and is not certified by the local smoke. Full end-user acceptance, accessibility across every workflow, all failure modes, and twenty-user capacity are not asserted by these checks.
