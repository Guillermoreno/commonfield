# Operations

Run commands from the checkout. For HTTPS append `-f compose.yaml -f compose.https.yaml` immediately after `docker compose` in each command. Use the same project name across operations; changing directory or `COMPOSE_PROJECT_NAME` changes volume names.

## Backup

Treat database dumps, captured messages, `.env`, and `.commonfield/` as secrets. Encrypt off-host backups and restrict permissions. Stop the app while taking a coordinated backup; PostgreSQL can stay running:

```sh
umask 077
mkdir -p backups
docker compose stop app
docker compose exec -T postgres pg_dump -U postgres -d commonfield --format=custom > backups/commonfield.dump
if [ -f .env ]; then
  tar -czf backups/commonfield-config.tar.gz .commonfield .env
else
  tar -czf backups/commonfield-config.tar.gz .commonfield
fi
docker compose start app
```

Record the source Git revision/image ID, canonical origin and backup timestamp separately. Store both backup files together securely. The dump includes schema, migration checksums and application data, but not PostgreSQL login passwords. The retained configuration archive contains those role credentials and the invitation-encryption key. Database-only backups are insufficient for a complete recovery of invitation URLs. Mailpit captures are not in the app dump; if needed, stop Mailpit and back up its named volume with your normal volume-backup tooling. It can alternatively be recreated empty without losing team/board data.

## Restore to a separate clean installation

Never test restoration over your only copy. Copy this checkout at the recorded revision to another host or directory/project. Restore `.commonfield/` and `.env` securely **before** starting services (and retain the original canonical origin if you need existing invitation envelopes). Set directory permissions to 0700. Do not run setup over missing secrets when restoring an existing database; recover the matching keys instead.

```sh
# Extract only a trusted archive into this clean checkout.
tar -xzf /secure/path/commonfield-config.tar.gz
chmod 700 .commonfield
docker compose up -d postgres mailpit
# Wait until postgres is healthy (docker compose ps).
docker compose exec -T postgres pg_restore -U postgres -d commonfield --exit-on-error < /secure/path/commonfield.dump
docker compose up -d --build --wait
```

The fresh PostgreSQL init creates matching roles from restored credentials before `pg_restore` restores schema ownership. Do not start migrations before restoring the dump into the empty database. Confirm readiness, sign-in, saved board content and invitation URL availability using the intended origin. Backups are not proven until this rehearsal succeeds. For an already-populated database restore, use an isolated empty database/volume instead of `--clean` against a live installation.

## Upgrades

Back up first. Read release changes and pin a known source revision. Stop the app before applying an upgrade (migration fencing is not online-schema-change support):

```sh
docker compose stop app
git pull --ff-only
docker compose build
docker compose run --rm migrate
docker compose up -d --wait
```

Migrations are ordered, advisory-locked and transactional with SHA-256 checksums recorded in `schema_migrations`. Already-applied files must not be edited: checksum drift fails startup rather than silently accepting a changed migration. All eight initial migrations are included, including delivery normalization. Schema/table grants are refreshed after migrations. Rollback is restore of the coordinated backup plus its matching code image; no automatic down migrations are supplied. Never manually remove migration ledger rows to bypass a mismatch.

## Keys, origins and delivery recovery

- Keep `.commonfield/invitation_key` across rebuilds, restarts, upgrades and restores. It encrypts retained invitation secrets; a lost key cannot be reconstructed from token hashes. Do not print it in logs or support messages.
- Invitation encryption is bound to the exact canonical origin as well as the invitation recipient, team and role. **Changing hostname, scheme or port invalidates redisclosure/delivery of old envelopes**. Existing copied URLs may also point to the old host. Complete local bootstrap before switching to HTTPS and issue invitations only after the final origin is configured. Revoke/reissue outstanding invitations after an intentional domain change; there is no automatic domain/key migration tool.
- SMTP capture attempts committed as `sending`/`queued` can remain interrupted after process/database failure. Automatic stale-claim recovery is not included. Do not infer failure means no capture occurred and do not blindly replay delivery. Inspect the private capture inbox, then revoke and reissue an affected invitation through the administrator interface if needed. Explicit uncertain resend confirmation in the UI does not recover every stranded queued claim.
- Setup refuses a partial retained-secret set instead of generating replacement keys. Restore the complete matching `.commonfield/` backup before rerunning setup. If **all** secret files were lost, setup cannot distinguish that loss from a fresh install: never run it to regenerate credentials for an existing database.
- Initial database init scripts run only for an empty database volume. If initialisation fails partway through, preserve diagnostics and investigate; for a disposable, empty install only, remove its project-specific resources and rerun. Never use this to repair a populated production database.

## Health and support

`docker compose ps` and `/api/ready` report readiness (database plus single-writer authority). Logs intentionally omit passwords and invitation URLs. New deployment scripts produce a sanitized diagnostic with release, run ID, phase, exception class, bounded stack locations and mutation uncertainty, never arbitrary exception messages or SQL. Migration/startup diagnostic paths are under the container's `/tmp` (ephemeral); retrieve the specific file with `docker compose cp` before recreating that container. Setup diagnostics are under private `.commonfield/`. Do not upload database dumps, config archives, raw capture messages or credentials for support.

One app replica only; no horizontal scaling, capacity guarantee, external SMTP delivery, automatic backup scheduling, or comprehensive production hardening is claimed. Restrict host access and monitor disk use, certificate renewal, database readiness and backups. Docker tags are version-pinned but not digest-pinned; review upstream image/security updates deliberately.
