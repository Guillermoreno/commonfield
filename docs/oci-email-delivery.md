# Commonfield: OCI Email Delivery setup

## Status and scope

This guide accompanies the SMTP-capable Commonfield implementation and describes owner-operated setup. It is not evidence that OCI resources, DNS records, credentials or outbound delivery have been configured. Use the verified published SMTP release and run the prerequisite file checks below before activation; an older capture-only checkout cannot send real email. Do not apply portable-release commands to the separate protected preview runtime.

The intended path is Commonfield → OCI's authenticated SMTP submission endpoint → recipient's mail server. A local Postfix server is not needed. No inbound SMTP ports, port-25 exemption, new mailbox hosting or public database port is required.

## 1. Record the decisions before creating resources

Use an OCI administrator account, your DNS administrator access, and private SSH access to the Docker host. Choose the following nonsecret values:

- Sending region: a region available to your OCI tenancy. Prefer a nearby region supported by Email Delivery, but copy its endpoint from the Console instead of guessing it. The sender and endpoint must use the same region.
- Dedicated compartment: proposed name `commonfield-email`.
- Sending domain: proposed example `notify.bubblefishux.design`.
- Sender address: proposed example `invitations@notify.bubblefishux.design`.
- SMTP user: proposed name `commonfield-smtp`.
- SMTP group: proposed name `commonfield-email-senders`.
- App origin: your final working HTTPS URL. The currently authorized preview hostname is not permission to replace or restart that separate deployment using this guide.
- Test recipient: one mailbox you control and can inspect.

These names are proposals, not already-created resources. Check for existing matching domains/resources before creating duplicates. A dedicated sending subdomain reduces the risk of accidentally changing your main domain's existing mail configuration. Creating an outbound sender does not create an inbox for replies.

**Success check:** you have chosen one region/domain/sender and know who controls their DNS and billing.

## 2. Check cost and account limits

In the OCI Console, check your account's Email Delivery limits/quotas and applicable price list. Oracle's public FAQ lists US$0.085 per 1,000 email units, with allowances/account terms and message-size accounting to review. Logging can have separate charges. Do not assume an existing VM means unlimited or free email sending.

If the tenancy's quota is insufficient or a capability is unavailable, request the specific service limit change through OCI support. This is not an Amazon SES sandbox process and does not require opening outbound port 25.

**Success check:** the account permits the intended low-volume test, and any charges are acceptable.

## 3. Create the isolated compartment

1. Sign in to the intended OCI tenancy as administrator.
2. Open **Identity & Security → Compartments** (console layouts may nest this under Identity).
3. Create `commonfield-email` under the intended parent compartment, or reuse a deliberately dedicated existing one.
4. Description: `Commonfield transactional invitation email`.
5. Record the compartment name/OCID privately for administration.

Do not put approved senders in the root compartment. This lets the sending policy stay scoped to Commonfield email resources instead of the whole tenancy.

**Success check:** the dedicated compartment is selectable in Email Delivery.

## 4. Create the sending identity and minimum sending policy

1. Open **Identity & Security → Domains** and select your actual identity domain (often `Default`, but verify it).
2. Under **Groups**, create `commonfield-email-senders`.
3. Under **Users**, create a dedicated user `commonfield-smtp` and add it to that group. Do not grant administrator membership. Do not give it ordinary interactive Console access/password or API signing keys solely for this task; an administrator can generate its SMTP credentials.
4. Open **Identity & Security → Policies** and create a new policy named `commonfield-email-send` at a policy location that can authorize access to the selected compartment, for example the tenancy root.
5. Use the manual editor and add the following **new policy statement**, replacing `Default` if the real identity domain differs:

```text
Allow group 'Default'/'commonfield-email-senders' to use approved-senders in compartment commonfield-email
```

This is an additive, separate application-sending policy, not a replacement for any existing tenancy policies. Oracle's service permission reference maps `use approved-senders` to `APPROVED_SENDER_USE` / `SmtpSend`. It does not grant creation/deletion of senders, domain administration, suppression deletion, credentials administration, logging administration or tenancy administration. Your existing human administrator performs those setup tasks separately. Do not copy broad `manage email-family in tenancy` examples onto the app identity merely to resolve a permission error.

**Success check:** the dedicated user belongs only to the intended sending group, and the policy names the correct identity domain and compartment. An actual controlled SMTP send later proves effective authorization; policy creation alone does not.

## 5. Create the Email Domain and DKIM record

1. Select the intended sending **region** in the top-right region selector.
2. Open **Developer Services → Application Integration → Email Delivery → Email Domains**. Some console layouts present Email Delivery directly under Developer Services.
3. Select the `commonfield-email` compartment.
4. Create an Email Domain for the chosen sending domain, for example `notify.bubblefishux.design`.
5. Open its details and select **DKIM → Add DKIM → Add new DKIM**.
6. Choose a new selector prefix, for example `commonfield1`, and select **Generate DKIM Record**.
7. Copy the **exact generated DNS name/type/value**. In commercial regions this is normally a CNAME. Do not reconstruct its target manually.
8. At the domain's authoritative DNS provider, create that exact record. If DNS is in Route 53, use the public hosted zone that actually serves `bubblefishux.design`; a subdomain does not need a separate hosted zone unless intentionally delegated.
9. Return to OCI, finish adding DKIM, and use its verification/status control until the record is recognized and signing is active.

Do not replace unrelated DKIM records or change the website's A/CNAME records. Ensure a DNS interface does not append the domain twice to a fully-qualified record name.

**Success check:** OCI shows DKIM configured/active for the exact sending domain in the selected region.

## 6. Add SPF and review DMARC without breaking existing mail

For an **Americas commercial region**, Oracle currently documents this SPF example for a sending domain that has no existing SPF record:

```text
v=spf1 include:rp.oracleemaildelivery.com ~all
```

Create it as a **TXT record at the chosen sending domain** (for example `notify.bubblefishux.design`), not as a DKIM record or a second root-domain SPF record. For Europe, Asia/Pacific or another realm, use Oracle's region-specific SPF guidance instead; do not blindly copy the Americas example.

If an SPF record already exists at that exact name, merge the necessary mechanism into the existing single policy after reviewing its current senders and DNS lookup limit. **Do not publish two separate `v=spf1` records.** Do not remove Google/Microsoft/other legitimate sending mechanisms from an existing policy.

Check `_dmarc.<sending-domain>` and the parent domain's inherited policy. Ensure the DKIM signing domain aligns with the visible From domain. If there is no existing policy and the DNS owner agrees, a monitoring-only starting example is:

```text
v=DMARC1; p=none
```

This is not a recommendation to weaken an existing `quarantine`/`reject` policy. Add reporting only to a mailbox/service you actually control, and tighten policy deliberately after observing valid mail. Do not change existing MX records merely to enable outbound sending.

**Success check:** OCI's SPF/DKIM verification is satisfied where supported, and the controlled recipient test later shows aligned DKIM/DMARC results.

## 7. Create the exact approved sender

1. Keep the same region selected.
2. Open **Email Delivery → Approved Senders**.
3. Select the same `commonfield-email` compartment.
4. Select **Create Approved Sender** and enter the exact address, for example `invitations@notify.bubblefishux.design`.
5. Create it and wait until it is available.

Use one explicit address instead of broad domain-wide approved-sender authorization for this app. The app's SMTP envelope sender and visible From must match the configured approved address. Do not use `@gmail.com`, `@yahoo.com`, `@oracle.com` or another domain you do not control.

**Success check:** the exact From address appears under Approved Senders in the same region as the SMTP endpoint you will use.

## 8. Enable private delivery diagnostics

1. Open **Email Delivery → Email Domains → your domain → Logs**.
2. Enable **Outbound Accepted** and **Outbound Relayed** logs into an appropriately restricted log group.
3. Review retention and any logging charges. Keep access limited to operators; logs can contain recipient addresses and message metadata.
4. Leave unnecessary open/click tracking disabled. Invitation links are sensitive capabilities.

Outbound Accepted records submission to OCI. Outbound Relayed records the onward handoff/bounce outcome. Neither proves a person saw the email or that it avoided the spam folder.

**Success check:** both log categories are enabled before the live test. The SMTP user does not need log-administration permissions.

## 9. Generate SMTP credentials privately

1. As administrator, open **Identity & Security → Domains → your domain → Users → commonfield-smtp**.
2. Select **SMTP credentials → Generate credentials**.
3. Give it a recognizable description such as `Commonfield invitation SMTP`.
4. Save the generated **SMTP username** and **SMTP password** directly into your password manager. The generated SMTP username is not the friendly OCI user name, your Console email address or your normal Console password.
5. Do not paste either credential into Discord, a GitHub issue, `.env`, a command argument or an image build.

OCI permits up to two SMTP credentials per user. Use that allowance for controlled rotation, not for broadly sharing a single administrator credential. If a credential has been exposed, replace it and delete the old one.

**Success check:** both Oracle-generated SMTP values are retained privately under the dedicated app user.

## 10. Copy the regional endpoint and check encryption

Open **Email Delivery → Configuration** in the same region. Copy the public SMTP endpoint from the Console. For example only, Phoenix uses:

```text
smtp.email.us-phoenix-1.oci.oraclecloud.com
```

Do not choose Phoenix solely because this example or an earlier connectivity probe used it. Use the region where you created the sender. Choose **587 + required STARTTLS** for this guide. OCI also supports **465 + implicit TLS**.

From the server, an optional read-only test with OpenSSL is:

```sh
openssl s_client -starttls smtp \
  -connect YOUR_OCI_SMTP_HOST:587 \
  -servername YOUR_OCI_SMTP_HOST \
  -verify_hostname YOUR_OCI_SMTP_HOST \
  -verify_return_error < /dev/null
```

Replace both/each `YOUR_OCI_SMTP_HOST` token with the exact same real endpoint. Expect successful certificate verification; do not disable verification to make a failed test pass. This test does not authenticate or send email. The current VM previously reached a representative OCI endpoint on 587 with verified TLS, but the app container's actual route must also work.

No inbound 25/465/587 rule is needed. If outbound access is restricted, permit only the necessary submission traffic and DNS through the approved network change process. Do not expose the database or Mailpit UI publicly.

**Success check:** the chosen endpoint is region-matched and reachable with verified TLS.

## 11. Install only a verified SMTP-capable Commonfield release

Use a verified published SMTP-capable release, not the initial capture-only package. In the portable Commonfield checkout (not the protected preview workspace), update through the normal reviewed release process and check:

```sh
test -f compose.smtp.yaml
test -f docker/smtp-secret.mjs
test -f docs/smtp.md
```

If any command fails, stop: that checkout does not contain this setup contract. Do not substitute an unreviewed development branch into the live preview. Back up the database, existing `.env`, and the complete `.commonfield/` directory before changing an existing installation. Use the operations guide for the coordinated backup; never run `down -v` against retained user data.

Complete `./setup.sh` and private owner bootstrap only for a **new** installation. On an existing installation, preserve all original database credentials and invitation encryption keys; do not recreate the database or repeat bootstrap.

**Success check:** the tested release contains the expected files, and the installation/data/keys are safely retained.

## 12. Save credentials using the Docker-only secret helper

Run from the portable checkout using a private interactive POSIX terminal. The setup helper writes under `.commonfield/`, whose parent directory must remain mode 0700. Files must be readable by the non-root app through Compose secret mounts; the supplied helper establishes the intended file permissions. Docker administrators can still read mounted secrets.

First, enter the generated SMTP **username**, then press Enter and Ctrl-D:

```sh
docker compose run --rm --no-deps -T setup node smtp-secret.mjs smtp_username
```

Next, enter the generated SMTP **password** with terminal echo disabled, then press Enter and Ctrl-D:

```sh
(
  trap 'stty echo' EXIT HUP INT TERM
  stty -echo
  docker compose run --rm --no-deps -T setup node smtp-secret.mjs smtp_password
)
```

The helper reads the value from standard input and prints only a confirmation, not its value. Values are not included in the shell command/history. If the terminal loses echo unexpectedly, run `stty echo`. Do not use these commands from a recorded/shared terminal session. For unattended deployment, provision the same files via a private secret-manager path instead.

The helper refuses to overwrite existing files. For rotation, stop/recreate the app as documented, replace only the two SMTP files privately, and preserve the five original install keys. Do not print secret files to verify them.

**Success check:** both helper calls report secret creation, and neither credential appears in terminal output, Git or chat.

## 13. Add nonsecret configuration and activate deliberately

Edit the existing `.env` rather than overwriting its app/HTTPS settings. Using the chosen sender and real regional endpoint:

```dotenv
SMTP_HOST=YOUR_OCI_SMTP_HOST
SMTP_PORT=587
SMTP_TLS=starttls
SMTP_FROM=invitations@notify.bubblefishux.design
```

The sender above is a proposal: use the exact approved address from step 7. No username/password belongs in `.env`. OCI public endpoints use ordinary public CA trust; leave custom `SMTP_CA_FILE` unset. Do not turn off TLS verification.

Keep the **final public HTTPS origin** consistent with the installed app/proxy. Changing an origin invalidates redisclosure/delivery of older retained invitation envelopes; finalize the origin before issuing new invitations.

For an installation using the supplied Caddy HTTPS override:

```sh
docker compose \
  -f compose.yaml \
  -f compose.https.yaml \
  -f compose.smtp.yaml \
  up -d --build --wait
```

For an app already served through a separately managed HTTPS reverse proxy, retain that existing private-upstream topology and use its approved base configuration plus the SMTP override, rather than starting a competing Caddy listener. The portable base-plus-SMTP example is:

```sh
docker compose -f compose.yaml -f compose.smtp.yaml up -d --build --wait
```

Only use that second form when the external proxy/final HTTPS origin is already configured appropriately (or for an explicitly local development install). Do not expose an unclaimed bootstrap publicly. Use the **same Compose file set** for subsequent logs/restarts/upgrades/backups so SMTP settings are not accidentally dropped.

For the Caddy form, inspect state and sanitized logs with:

```sh
docker compose -f compose.yaml -f compose.https.yaml -f compose.smtp.yaml ps
docker compose -f compose.yaml -f compose.https.yaml -f compose.smtp.yaml logs --tail=50 app migrate
```

Expected: migration completes successfully and the app is healthy. Incomplete SMTP configuration must fail closed, never silently use Mailpit. Startup/health alone does not prove the SMTP credential works; the connection is made when an administrator explicitly sends an invitation.

## 14. Send one controlled invitation and prove receipt

1. Sign in to Commonfield as an administrator.
2. Open **Invite**, add the chosen controlled test recipient, and select the intended member role.
3. Select **Send invitation** deliberately. Do not test with a list of real users.
4. Confirm the app labels the outcome as SMTP acceptance, not local capture. An accepted submission is not confirmed inbox delivery.
5. In OCI's domain logs, locate the matching Outbound Accepted event and onward Outbound Relayed/bounce outcome by recipient/time/Message-ID. Do not publish raw logs or the message body.
6. Check the controlled recipient's inbox and spam folder. Inspect the original headers for DKIM/DMARC pass/alignment; investigate SPF/return-path results with Oracle's configuration guidance.
7. Open the invitation's link, confirm it uses the final HTTPS app hostname, and complete acceptance in a separate browser profile for that recipient.
8. Verify the correct membership/role and board access. Reusing the consumed invitation should not create a second membership.

If I perform the live test rather than you doing it manually, confirm the exact recipient and authorize that one send first. Do not send credentials in chat.

## 15. Diagnose failures safely

- **Startup configuration error:** confirm the SMTP override, nonsecret fields, secret filenames/mounts and actual release. Do not dump secrets or disable certificate checks.
- **Authentication error:** use Oracle-generated SMTP credentials, not the friendly IAM username/Console password. Check group membership and the scoped sending policy.
- **Unauthorized sender:** check the exact envelope/From address, approved-sender compartment and endpoint region. A newly created sender can take time to become usable; use a bounded operator retry rather than a loop of repeated sends.
- **Accepted but missing:** inspect Outbound Relayed logs, suppressions, spam folder and domain authentication. The app does not currently process provider bounce webhooks into inbox-delivery statuses.
- **Quota/rate error:** check the tenancy's actual sending limits; request a scoped increase if justified.
- **Uncertain outcome:** inspect provider logs and the recipient mailbox before confirming resend. A lost SMTP acknowledgment can leave mail delivered even when the app did not record success. Resend can duplicate it.
- **Old invitation link problem:** verify origin/key continuity. Revoke/reissue affected pending invitations deliberately after a domain change; do not regenerate the encryption key to fix it.
- **Need to disable sending:** stop the app or deliberately recreate it in capture mode using the documented base/HTTPS file set without `compose.smtp.yaml`. Keep the data and keys. Capture mode is not real sending. Do not use destructive volume cleanup as rollback.

## Completion form — no secrets

- OCI region:
- Dedicated compartment:
- Sending domain:
- Exact approved From address:
- SMTP endpoint/port/TLS mode:
- SMTP group/policy installed: NOT RUN / PASS / BLOCKED
- DKIM verified: NOT RUN / PASS / BLOCKED
- SPF/DMARC reviewed: NOT RUN / PASS / BLOCKED
- Accepted/Relayed logs enabled: NOT RUN / PASS / BLOCKED
- Credentials saved privately: NOT RUN / PASS / BLOCKED
- Verified Commonfield release revision:
- App healthy: NOT RUN / PASS / BLOCKED
- One test recipient and send authorization (if agent-run):
- OCI accepted/relayed evidence: NOT RUN / PASS / FAIL
- Recipient inbox receipt and authentication headers: NOT RUN / PASS / FAIL
- Invitation acceptance and membership: NOT RUN / PASS / FAIL

Do not mark delivery complete based only on resource creation, app readiness or SMTP acceptance.

## Official references

- [OCI Email Delivery getting started](https://docs.oracle.com/en-us/iaas/Content/Email/Reference/gettingstarted.htm)
- [Sending permission reference: approved-senders / SmtpSend](https://docs.oracle.com/en-us/iaas/Content/Identity/policyreference/emailpolicyreference.htm)
- [SMTP credentials](https://docs.oracle.com/en-us/iaas/Content/Email/Reference/gettingstarted_topic-create-smtp-credentials.htm)
- [DKIM configuration](https://docs.oracle.com/en-us/iaas/Content/Email/Tasks/configure-dkim-using-the-console.htm)
- [SPF by region](https://docs.oracle.com/en-us/iaas/Content/Email/Tasks/configurespf.htm)
- [Approved senders](https://docs.oracle.com/en-us/iaas/Content/Email/Reference/gettingstarted_topic-Create_an_approved_sender.htm)
- [SMTP connection settings](https://docs.oracle.com/en-us/iaas/Content/Email/Reference/gettingstarted_topic-Configure_the_SMTP_connection.htm)
- [Enable Accepted/Relayed logging](https://docs.oracle.com/en-us/iaas/Content/Email/Tasks/enablelogs_using-the-console.htm)
- [Pricing/limits FAQ](https://www.oracle.com/application-development/email-delivery/faq/)
