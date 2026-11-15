# SMTP invitation delivery

Default `EMAIL_MODE=capture` uses only the private Mailpit service. Captured mail is **not emailed**. Opting into `smtp` selects Nodemailer with authenticated, verified TLS. Invalid/incomplete SMTP configuration fails startup; it never falls back to capture. Startup does not connect to a provider or send mail. Sending requires an administrator's explicit invitation action.

Provider selection guidance is available in [five provider options](email-provider-options.md); for the selected OCI route, use the [OCI Email Delivery setup guide](oci-email-delivery.md). Live credentials, approved sender configuration and activation remain pending; the integration is provider-neutral.

## Private setup (Docker only)

First complete the installation and private owner bootstrap. Set the **final** `PUBLIC_ORIGIN` (HTTPS on a server) before creating invitations; changing it invalidates retained invitation envelopes. Select a provider, verify your sending address/domain, and obtain SMTP credentials privately. No provider is configured by this repository.

Run from the checkout after `./setup.sh`. Both credential files live under the already-private `.commonfield/` directory. The following reads them from your terminal without putting their values in shell arguments/history or `.env`; the container writes the secret mounts, so host Node/Python is unnecessary:

```sh
# Enter SMTP username, then Ctrl-D (do not paste a password here).
docker compose run --rm --no-deps -T setup node smtp-secret.mjs smtp_username
# Password entry: hide terminal echo; restore it even if interrupted.
( trap 'stty echo' EXIT HUP INT TERM; stty -echo
  docker compose run --rm --no-deps -T setup node smtp-secret.mjs smtp_password
)
```

Enter the password and Ctrl-D (possibly twice after a non-newline final character). Only a confirmation is printed, never its value. Commands require an interactive POSIX terminal; use a private secret-manager file provision instead for unattended installs. Files are readable by the non-root app inside Docker but protected from ordinary host users by the parent directory's 0700 permissions. Docker administrators can read them. Never paste credentials into issues or logs. Existing files are refused (`wx`); rotate by stopping the app and privately replacing these two files, then recreating the app. Do not modify the five original setup keys; setup still validates/preserves exactly those five keys and tolerates these additional files.

Put **nonsecret** provider settings in `.env` (placeholders below, not working credentials):

```dotenv
SMTP_HOST=smtp.provider.example
SMTP_PORT=587
SMTP_TLS=starttls
SMTP_FROM=invitations@your-domain.example
```

Port 587 uses **required STARTTLS**, not opportunistic encryption. For a provider's implicit TLS endpoint use `SMTP_PORT=465`, `SMTP_TLS=implicit`. Other ports are permitted, but plaintext SMTP is never permitted in `smtp` mode. Minimum TLS 1.2 and certificate/hostname verification are always enabled. There is no insecure certificate bypass. SMTP username/password both come from Compose secret files. Direct non-Compose execution additionally supports `SMTP_USERNAME` instead of `SMTP_USERNAME_FILE`, never both; the password always requires a file.

```sh
# Local installation with SMTP:
docker compose -f compose.yaml -f compose.smtp.yaml up -d --build --wait
# Server with existing HTTPS setup:
docker compose -f compose.yaml -f compose.https.yaml -f compose.smtp.yaml up -d --build --wait
```

Use the same file set for **every** later operation (logs, restart, backup, upgrade). Keep PostgreSQL, capture UI and internal SMTP unpublished/private. SMTP mode only makes an outbound connection; no SMTP port needs opening inbound. Mailpit remains private and available for historical captures but receives no new SMTP-mode attempts. To return to capture, recreate using the base file set without `compose.smtp.yaml`; existing attempts keep their original transport metadata.

### Optional private CA

Public providers normally need no custom CA. For a private TLS provider, supply a PEM CA file as an additional read-only Compose secret, then set `SMTP_CA_FILE=/run/secrets/smtp_ca`. Example **additional** override:

```yaml
services:
  app:
    environment:
      SMTP_CA_FILE: /run/secrets/smtp_ca
    secrets: [smtp_ca]
secrets:
  smtp_ca:
    file: ./.commonfield/smtp_ca.pem
```

Include this override after `compose.smtp.yaml`. The file must exist, parse as a certificate, and be trusted for the provider's chain. Hostname and certificate validity checks remain mandatory. Do not mount private certificate keys into the app.

## Acceptance, retries and deliverability

- The persisted legacy `sent` status means **accepted by the selected transport**, not inbox delivery. UI distinguishes `Captured locally (not emailed)` and `SMTP accepted (not inbox confirmed)` using that attempt's persisted transport, not today's mode. Old invitations with no retained attempt show historical transport unknown.
- Deterministic authentication, recipient or explicit DATA rejection is `failed` and may be retried manually. No SMTP error text/provider response is returned or logged. Unknown network failure or a lost acknowledgment after DATA is `uncertain`: check your provider's private event log or contact the recipient before explicitly confirming resend. A duplicate is possible. There are no automatic retries/general mail queues.
- Restart recovery runs only after writer ownership acquisition, under generation/nonce fencing, before readiness. Stranded `queued`/`sending` attempts become `uncertain`, never `failed` and never automatically resent. Terminal accepted/revoked invitations are not reopened. A prior request can still finish at a remote provider after a crash; fencing protects database state, not recall of remote mail.
- Each attempt has a UUID-based Message-ID under the configured sender domain, with the same identity for that attempt's text/HTML alternatives. Explicit resend creates a new attempt/identity. No tracking pixel, remote attachment fetching or delivery receipt is requested.
- Configure **SPF**, provider-managed **DKIM** signing and **DMARC** alignment/policy for your sender domain according to your provider. Verify `SMTP_FROM` with the provider. SMTP acceptance is not proof of sender reputation, spam-folder placement, recipient receipt or DNS correctness. The application does not sign DKIM itself or process bounce webhooks.
- Use one app replica, bounded SMTP timeouts and your provider's permitted submission endpoint. Test with a controlled mailbox only after private provider setup/approval. This release was tested using a local authenticated TLS fixture, not a real provider or recipient inbox.
