# Installation verification

This initial Docker package was exercised on a Linux x86-64 host with Docker Engine 29.1.3 and Docker Compose 2.37.1. The clean installation was materialized from the exact staged publication files, without development dependencies, existing configuration or runtime credentials copied into it. Setup generated its own credentials; tests ran in disposable Compose projects, not an existing user installation.

## Executed checks

- Docker build: **99 tests passed across 15 files**, TypeScript checks passed, and backend/frontend production compilation passed.
- ESLint passed separately against the publication source.
- Clean Docker startup completed database initialization and all **eight** ordered migrations, and the app reached healthy readiness.
- HTTP installation smoke exercised user-owned one-time bootstrap, repeat-bootstrap rejection, login/session, a durable sticky write, exact-origin mutation/WebSocket checks, invitation creation and local mail capture.
- Two isolated Chromium browser contexts signed in to the same disposable account. A sticky created in one appeared in the other, and an edit from the second appeared in the first. Restarting the application and reloading restored the saved session and edited note.
- The browser run exposed a creator-side stale-intent defect. Regression tests failed before the fix and passed afterward; the corrected Docker image passed the same browser scenario. Newer unsaved drafts remain protected.
- Real local Caddy HTTPS/WSS smoke passed, including Secure session cookies and foreign-origin rejection. The disposable proxy used a self-signed test CA; certificate verification was relaxed only in the explicit test transport.
- Database privilege probes confirmed separated migration/app/writer permissions and no superuser, role-creation, database-creation or schema-creation authority for the runtime roles.
- Migration replay completed without reapplying the eight recorded migrations.
- An independent custom-format dump/restore into a separate fresh database retained all eight migration records and the bootstrap, owner, sticky and invitation records. The restored application became healthy and its database privilege checks passed.
- Setup preserves a complete valid secret set and refuses malformed or partially missing retained secrets. The missing-secret regression failed before the safeguard and passed afterward.
- Publication files were checked for superseded branding, private host paths and common credential patterns. Runtime configuration, secrets, database dumps, local dependencies and historical review artifacts are excluded from Git and the Docker build context.

## Limits

These are installation and targeted functional checks, not comprehensive product acceptance or production-security certification. The two-browser run used two sessions for one account; it is not a twenty-user or cross-team-capacity test. Windows/WSL2, macOS, ARM hardware, public DNS/ACME issuance, every accessibility state, full failure recovery and outbound SMTP were not certified by this run. Invitation email remains local capture only. Review the operational limitations before hosting real data.

For repeatable installation and proxy smoke commands, see [testing.md](testing.md). For private bootstrap, see [installation.md](installation.md); for coordinated backups and recovery, see [operations.md](operations.md).
