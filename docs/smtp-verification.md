# SMTP extension verification

This scope is separate from the [initial capture-only installation baseline](verification.md). The extension was executed on Linux ARM64/aarch64, Docker Engine 29.1.3 and Compose 2.37.1. No external provider credentials, AUTH attempts to external providers, real recipient sends or inbox-receipt claims are part of this implementation verification.

## Executed results

- Original baseline: **99 tests / 15 files** passed before changes. Final post-review suite: **146 tests / 20 files** passed, retaining those baseline cases. TypeScript and ESLint passed.
- Executed RED/GREEN cycles covered missing SMTP transport/configuration, username secret-file support, expired-invitation dispatch, administrator revalidation at claim, concurrent attempt uniqueness, generation-bound completion after writer reacquisition, empty CA rejection, sanitized configuration diagnostics, mode metadata and status labels. The initial missing-module setup error was not counted as assertion RED; a minimal stub then produced 21 failing assertions before implementation.
- Docker production and fixture images built successfully. The production build runs the whole suite (including ephemeral local authenticated SMTP servers and test certificates), type checking and compilation without live SMTP credentials. Runtime has Nodemailer but no `smtp-server`, TypeScript or test OpenSSL installation.
- Real local SMTP-server tests exercised verified required STARTTLS and implicit TLS, username/password authentication, untrusted certificate rejection, STARTTLS downgrade rejection, explicit AUTH/RCPT/final DATA rejection, DATA disconnect and lost-ack timeout uncertainty, multipart plain text/HTML and per-attempt Message-ID. Nodemailer can report `command=CONN` even for a **post-DATA timeout**; generic CONN/ECONNECTION/ETIMEDOUT is therefore not considered proof of no send.
- Actual Docker app against the isolated authenticated, verified-STARTTLS fixture passed: administrator-origin protection, recipient override rejection, recipient-bound URL/message identity, persisted SMTP metadata, explicit rejection versus uncertain disconnect, confirmation-required resend, revocation/expiry guards and one winner across concurrent sends.
- The Docker run exposed an existing ambiguous `revoked_at` reference in the joined revoke UPDATE; the PostgreSQL query failed before qualification and the corrected real revoke/terminal scenario passed afterward.
- Real PostgreSQL stale-nonce recovery was refused without changing either stranded canary. After application restart, seeded `sending`/`queued` canaries became uncertain under the new writer fence; revoked lifecycle state was preserved and the SMTP fixture received no new mail. These were explicitly seeded stranded claims, not a claim of exhaustive crash-position testing.
- Switching the same disposable app to capture preserved SMTP historical metadata. A new `local_capture` attempt was read back from Mailpit with the expected recipient, plain text/HTML and bound URL; the SMTP fixture received nothing new.
- An isolated `--network none` production container with incomplete `EMAIL_MODE=smtp` settings exited **1** with `email_configuration_invalid` before database startup; its sanitized diagnostic was read back. No fallback capture or startup send occurred.
- Runtime inspection: app UID/GID `1000:1000`, read-only filesystem, restart count zero; app/capture UI bindings only `127.0.0.1:18876` and `127.0.0.1:18877`. PostgreSQL and fixture SMTP/control HTTP have no published ports. Database least-privilege probes passed. App/fixture logs contained none of the tested credentials or invitation links.
- SQL migrations **001–008 were byte-compared to baseline `6ac33c8` and remain unchanged**; 009 adds the transport constraint without relabeling history. The original five setup keys and setup implementation remain unchanged.

The test project was **`commonfield-smtp-qa`**, with fresh project-specific database/capture volumes and a fresh private temporary credential directory. No original preview, database, provider account or real recipient was changed.

## Independent-review repairs (host verification)

- **Mandatory SMTP authentication:** Before the fix, `pnpm exec vitest run tests/smtp.test.ts -t 'without AUTH'` failed both trusted-TLS cases (required STARTTLS and implicit TLS): Nodemailer returned `sent` and the real AUTH-disabled, authentication-optional SMTP server received one DATA message in each case. With `forceAuth: smtp`, both now return `failed` with zero received DATA messages. Capture stays unauthenticated; mandatory TLS, certificate validation and existing outcome classifications are unchanged. `pnpm exec vitest run tests/smtp.test.ts` passed all **26** tests.
- **Loss during recovery:** The new `tests/authority-recovery.test.ts` imports the actual startup entrypoint with inert dependency adapters, captures its live app readiness/permit callbacks and injects writer loss while its recovery promise is pending. The first regression run failed because acquisition remained at two calls rather than retrying a third time after nested loss. The expanded pre-fix run also exposed readiness on a changed generation/nonce and an incorrect close of a replacement epoch (**4 failing / 2 passing** cases). Recovery now captures generation and nonce, rechecks exact current ownership after recovery, binds readiness and exposed permit values to that recovered ownership, and retries loss/replacement with 250 ms backoff. Query failure closes only its own still-current epoch; startup uses the same recovery loop.
- `pnpm exec vitest run tests/authority-recovery.test.ts tests/smtp-wiring.test.ts` passed **11** tests. The six live-entrypoint cases cover genuine initial success, nested loss leaving null ownership followed by reacquisition, changed generation, changed nonce, query failure/backoff, replacement-owner preservation on query failure, and shutdown during recovery (success is asserted within the loss/replacement cases). These are deterministic injected startup-boundary tests, not new real-PostgreSQL crash tests.
- Post-repair `pnpm test`, `pnpm typecheck` and `pnpm lint` passed: **146 tests / 20 files**, no TypeScript or ESLint errors. The Docker evidence above predates these two repairs; rebuilding/rerunning the disposable Docker QA and independent reviewer closure remain separate follow-up checks. No live preview/provider changes or new Docker claims are attributed to these host regressions.

## Repeatable Docker-only fixture run

Run from the checkout. Require unused loopback ports 18876/18877 and no existing project named `commonfield-smtp-qa`. Inspect first; do not remove someone else's project. Docker, Compose and a POSIX shell are sufficient; host Node/Python/package managers are not needed.

```sh
docker ps -a --filter label=com.docker.compose.project=commonfield-smtp-qa
# Continue only if that project is absent and these ports are unused.
export COMMONFIELD_QA_DIR="$(mktemp -d /tmp/commonfield-smtp-qa.XXXXXX)"
export APP_PORT=18876 MAILPIT_PORT=18877 PUBLIC_ORIGIN=http://localhost:18876
export SMTP_HOST=smtp-fixture SMTP_PORT=1025 SMTP_TLS=starttls SMTP_FROM=invites@example.test
qac() {
  docker compose -p commonfield-smtp-qa \
    -f compose.yaml -f compose.smtp.yaml -f compose.smtp-qa.yaml "$@"
}
docker build -t commonfield:smtp-qa .
docker build --target smtp-fixture -t commonfield:smtp-fixture-qa .
qac run --rm --no-deps setup
docker run --rm -v "$COMMONFIELD_QA_DIR:/fixture" \
  --entrypoint node commonfield:smtp-fixture-qa docker/smtp-qa-init.mjs
qac up -d --no-build --wait
qac exec -T app node docker/smtp-qa.mjs
qac exec -T app node docker/smtp-qa-recovery.mjs before-restart
qac restart app
qac up -d --no-build --wait
qac exec -T app node docker/smtp-qa-recovery.mjs after-restart
qac -f compose.smtp-qa-capture.yaml up -d --no-build --wait
qac -f compose.smtp-qa-capture.yaml exec -T app node docker/smtp-qa-recovery.mjs capture
qac exec -T app node docker/verify-database.mjs
# Cleanup ONLY this disposable project and its test volumes:
qac down -v
```

Expected script outputs begin `PASS SMTP Docker`, `PASS live PostgreSQL stale-nonce`, `PASS real restart` and `PASS capture mode`. No captured message bodies, recipients, generated passwords, cookies or invitation URLs are printed. The fixture is a private **non-relaying** service; never publish its HTTP control/readback endpoint. The QA scripts require the explicit QA marker and `smtp-fixture` target. A second full run needs a fresh disposable database and fixture process; never reset real data to satisfy a smoke test. Remove the freshly generated private QA credential directory separately when no longer needed.

Startup-closure probe (the following intentionally exits 1):

```sh
docker run --rm --network none -e EMAIL_MODE=smtp commonfield:smtp-qa
```

Expected diagnostic reason: `email_configuration_invalid`. The temporary report in this `--rm` container disappears on exit; omit `--rm` and use `docker cp` on that **specific disposable container** if you need to inspect it.

## Limits

This proves provider-neutral SMTP submission against local fixtures and transport acceptance, **not real-provider activation or recipient receipt**. Live regional provider/sender setup, sender verification, SPF/DKIM/DMARC, production mailbox checks and any paid provider configuration remain pending separate authorization. The suite does not certify bounce handling, spam placement, provider-specific quotas, all process-death positions, full accessibility, twenty-user capacity, x86-64/macOS/Windows compatibility, or public ACME issuance. No new full browser E2E run is attributed to this SMTP extension; status labels were exercised in React tests and transport history via the real app API.
