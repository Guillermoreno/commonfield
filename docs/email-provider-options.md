# Email provider options

## Recommendation for the current server

Use **Oracle Cloud Infrastructure (OCI) Email Delivery** if you want Commonfield's sending service alongside the existing hosting account with low usage-based costs. Use **Resend** instead if a simpler developer-oriented setup and a free small-volume starting allowance matter more than keeping one infrastructure provider.

The current development machine was verified as **Oracle Cloud, Linux ARM64/aarch64**. Certificate-validated STARTTLS connections on port **587** succeeded from this machine to representative SMTP endpoints for all five services below. These were connection/encryption probes only: no authentication, sender verification, provider-account enrollment or email submission took place. OCI and SES endpoints were example regions, not a selection or verification of the owner's sending region. Docker containers can have different egress rules from the host; test the installed application after configuration.

There is no need to host a full mail server, publish a local SMTP port or replace the application's Docker topology. The application makes an outbound encrypted connection to the selected managed relay. ARM64 does not require a special provider.

## 1. Oracle Cloud Infrastructure Email Delivery

**Setup:** Choose an OCI sending region, create a project-scoped email compartment/domain and approved sender, publish the required DKIM/SPF DNS records, review DMARC alignment, and create a dedicated SMTP identity with the necessary scoped permissions. Supply that region's SMTP endpoint and its generated SMTP credentials to Commonfield. Keep credential creation and IAM/DNS changes owner-approved.

**Pros**
- Fits the machine's existing cloud provider and avoids another vendor account.
- Low usage-based sending cost. Oracle's public FAQ lists **US$0.085 per 1,000 email units**, subject to allowances, message-size accounting and the applicable account price list.
- Managed sending reputation and suppression handling; no mail-server daemon to maintain here.

**Cons**
- OCI compartment/IAM/domain/approved-sender setup is more involved than a developer-first mail service.
- Approved senders and suppression resources are regional; endpoint/region mismatches cause failures.
- Trial/account limits and any required increases must be checked in the owner's tenancy. Hosting a VM in OCI does not itself prove Email Delivery is enabled.

**Best fit:** Low-cost app invitations while keeping infrastructure in OCI.

Sources: [Oracle pricing FAQ](https://www.oracle.com/application-development/email-delivery/faq/), [service overview and limits](https://docs.oracle.com/en-us/iaas/Content/Email/Concepts/overview.htm), [approved senders](https://docs.oracle.com/en-us/iaas/Content/Email/Reference/gettingstarted_topic-Create_an_approved_sender.htm).

## 2. Amazon Simple Email Service (SES)

**Setup:** Verify the sending domain in a selected AWS region, configure DKIM/SPF and DMARC alignment, obtain region-specific SMTP credentials with minimal sending authority, and request production access if that region/account is in the SES sandbox.

**Pros**
- Low usage-based cost and a mature transactional-mail service.
- Works from this OCI machine; the app does not need to move to AWS.
- Good fit if you already maintain AWS/DNS infrastructure and prefer its operational tools.

**Cons**
- Adds AWS region, IAM, SMTP credentials and billing administration to an OCI-hosted app.
- New sandbox accounts can send only to verified recipients until production access is granted.
- Plan selection matters: the public price list shows **US$0.10 per 1,000 outbound emails for a-la-carte pricing**, while the Essentials tier starts at **US$0.16 per 1,000**. Additional features/data can cost extra; do not assume an old free-tier or default-plan allowance.

**Best fit:** Low-cost production sending when AWS administration is already familiar.

Sources: [SES pricing](https://aws.amazon.com/ses/pricing/), [sandbox and production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html), [SES SMTP overview](https://aws.amazon.com/ses/faqs/).

## 3. Resend

**Setup:** Verify a sending domain and its DNS records, create a restricted sending API key, and use it as the SMTP password with username `resend` and host `smtp.resend.com`. Use mandatory STARTTLS on 587 or implicit TLS on 465.

**Pros**
- Straightforward developer-oriented setup and activity logs.
- Public Free plan includes **3,000 emails per month**, limited to **100 per day**, useful for a small invitation-only app.
- Standard SMTP avoids provider-specific application code and makes later switching practical.

**Cons**
- The daily cap can stop invitation batches even if the monthly allowance remains.
- The public Pro tier begins at **US$20 per month**; that is a larger fixed cost than usage-priced OCI/SES for small volumes.
- Another provider account/key to maintain. A test sender is not a substitute for verifying your own domain for real recipients.

**Best fit:** Quickest developer-friendly small-volume start.

Sources: [Resend pricing](https://resend.com/pricing), [SMTP configuration and domain prerequisites](https://resend.com/docs/send-with-smtp).

## 4. Postmark

**Setup:** Create a transactional server/message stream, verify the sender/domain, add DNS authentication records and provision the stream's SMTP credentials. Keep invitation traffic separate from any marketing/broadcast stream.

**Pros**
- Focused on transactional mail such as invitations, account notifications and password resets.
- Useful delivery/bounce activity and troubleshooting tools.
- Standard authenticated SMTP with no local mail-server maintenance.

**Cons**
- Free Developer plan is only **100 emails per month**.
- Basic paid sending starts at **US$15 per month for 10,000 emails**, with no intermediate tier between the free allowance and that paid tier.
- Provider-side message retention can include sensitive invitation content; review retention/access settings and keep open/link tracking off for invitation links.

**Best fit:** A paid transactional-email service when operational clarity matters more than the lowest usage cost.

Source: [Postmark pricing and features](https://postmarkapp.com/pricing).

## 5. Brevo SMTP relay

**Setup:** Enable transactional sending, verify/authenticate the sender domain and create an SMTP key. Configure the relay host and SMTP login from the account's SMTP settings; the SMTP key is distinct from an ordinary mailbox password.

**Pros**
- Public free SMTP allowance of **300 emails per day**.
- Supports transactional email and offers broader marketing tools if those are wanted later.
- Managed SMTP relay, compatible with the same application transport.

**Cons**
- Unused daily sends do not roll over, so a one-day invitation burst can hit the cap.
- Its broader CRM/marketing interface is more than this app needs.
- Account activation/verification and plan-specific reporting/branding constraints must be reviewed; keep transactional invitations separate from marketing lists and campaigns.

**Best fit:** A generous daily free allowance, especially if Brevo is already used elsewhere.

Sources: [Brevo free SMTP](https://www.brevo.com/free-smtp-server/), [plans and limits](https://help.brevo.com/hc/en-us/articles/208589409-About-Brevo-s-pricing-plans).

## Local/self-hosted alternative: outbound-only Postfix

A managed provider is optional. A local outbound-only **Postfix** service can accept Commonfield mail, persist it in a disk-backed queue and retry temporary failures. This is real mail-server software, unlike Mailpit's development capture.

There are two distinct deployments:

- **Fully self-hosted delivery:** Commonfield → local Postfix → recipient domain's MX server. No managed sending provider is used. Requires reachable outbound TCP 25, a suitable static public IP, matching forward/reverse DNS (PTR), SPF/DKIM/DMARC, abuse/bounce management and ongoing sender-reputation monitoring. A newly used cloud IP may still be rejected or spam-foldered even with correct DNS.
- **Local queue plus a managed relay:** Commonfield → local Postfix → selected provider over encrypted submission → recipient. This gives local durable queue/retry operations, but is **not provider-free** and the relay still processes the email content. It adds another service to operate, so it is optional rather than required for direct application-to-provider SMTP.

Direct-delivery feasibility is currently unproven on this VM: outbound port-25 probes to Google and Yahoo mail exchangers did not establish connections. This is consistent with, but does not alone prove, OCI's documented default outbound-port-25 restriction for newer tenancies. By contrast, certificate-validated STARTTLS on port 587 succeeded to all five managed providers above. A local container cannot bypass the cloud restriction; OCI would need to grant an exemption, or direct delivery would need a suitable different host/network. No exemption, firewall/DNS changes or local Postfix installation has been performed.

For a provider-free choice, use a narrowly scoped outbound-only Postfix deployment, not a whole mailbox/groupware suite, and first establish the port-25/PTR feasibility. Restrict submission to the app with authentication/private networking; never expose an open relay. In both local-server variants, application submission success means **accepted into a queue**, not confirmed arrival in the recipient's inbox.

Sources: [Postfix direct versus relay configuration](https://www.postfix.org/BASIC_CONFIGURATION_README.html), [OCI outbound SMTP restriction](https://docs.oracle.com/en-us/iaas/Content/Network/Troubleshoot/vcn_troubleshooting.htm).

## Common setup and privacy rules

1. Select a provider and sending region where relevant, and approve any charges before provisioning.
2. Choose a dedicated sender, for example `Commonfield <invitations@your-owned-domain.example>`. This is a placeholder, not an existing or approved mailbox. Consider a dedicated transactional subdomain; do not change existing mailbox MX records just to enable sending.
3. Verify domain ownership, add the provider's DKIM/SPF records, and review DMARC alignment. Do not create a second competing SPF TXT record for an existing sender domain; merge required mechanisms deliberately. Keep DNS changes separately approved.
4. Set Commonfield's final public HTTPS origin before issuing invitations. Stored invitation envelopes bind their encryption key and origin.
5. Mount the SMTP credential as a private secret file, not in Git, chat, Docker image layers or a plaintext password in `.env`. The `.env` file should contain nonsecret connection settings only. See the SMTP installation guide shipped with the implementation for exact application option names and Compose commands.
6. Keep Mailpit as local capture for development. Selecting SMTP must not silently fall back to capture after a configuration error. No external provider has been activated by writing this guide.
7. With owner approval, send one invitation to a named controlled recipient. Check the provider's acceptance record **and** the recipient's mailbox, then follow the link and accept it. A relay's `250`/accepted response does not prove inbox arrival; spam filtering, suppression or later bouncing can still occur.
8. Review provider retention and tracking: invitation bodies contain recipient-bound capability links. Disable unnecessary open/link tracking and limit access to message logs. Self-hosting Commonfield does not keep email content away from the chosen mail provider.
9. No full mailbox hosting is needed for outbound invitations. Reply handling and a staffed reply-to mailbox are separate decisions. Running a full outbound mail server directly on this VM is not recommended for this scope because IP reputation, reverse DNS, abuse handling, retries and port-25 restrictions add ongoing operations without improving the product.

Prices/allowances above come from the linked public provider pages and can change; taxes, regional/account-specific terms, quota approvals and extras are not included. Host connectivity probes prove only TCP reachability plus certificate-validated STARTTLS, not authenticated sending or delivery. Provider enrollment, billing, DNS/IAM mutation, credential installation and a live recipient test remain separate owner decisions.
