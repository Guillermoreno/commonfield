# Installation

## Local

Run the README commands from the repository root. `setup.sh` uses a network-isolated Node container to generate five cryptographically random secret files in `.commonfield/` without printing them. The host directory is mode 0700. Files are readable by the non-root container via Compose secret mounts; the surrounding host directory prevents other ordinary host users from traversing them. Docker administrators can access these secrets. Compose local secrets are file mounts, not an encrypted secret manager.

Database initialisation creates distinct `commonfield_migration`, `commonfield_app` and `commonfield_writer` login roles. Only the migration role owns schema objects; the app has required table DML and the writer can select/update fencing state, not users or credentials. No application role has superuser, database creation, role creation or bypass-RLS authority. The migration service sees only its credential; the application sees app/writer credentials and the invitation key, never the database administrator or migration password. The database administrator remains available only in the PostgreSQL container for recovery.

`postgres_data` and `mailpit_data` are project-scoped named volumes. Never run `docker compose down -v` on an installation you intend to keep. Setup is not a credential-rotation mechanism; existing database passwords are retained by PostgreSQL after first initialisation.

## Server with HTTPS

Use a DNS hostname under your control pointing at the host, with TCP 80/443 reachable for Caddy certificates and normal HTTPS access. Do not publish PostgreSQL, SMTP or the capture inbox. Do not expose an unclaimed bootstrap endpoint publicly: the first valid submitter becomes administrator.

1. Clone, run `./setup.sh`, and start the base stack with `docker compose up -d --build --wait`. Keep the default loopback bind and do **not** start Caddy yet. Keep the public firewall closed until step 4.
2. From your own computer, open an SSH tunnel: `ssh -L 8080:127.0.0.1:8080 your-server`. Open `http://localhost:8080/bootstrap` locally, create your owner account, and sign in. On the server, verify the one-time bootstrap claim without disclosing account information:

   ```sh
   docker compose exec -T postgres psql -U postgres -d commonfield -Atc 'SELECT count(*) FROM bootstrap_state'
   # Must return 1. Do not proceed with 0.
   ```

3. Before issuing any invitations, create `.env` with your actual hostname and ACME account email:

   ```dotenv
   COMMONFIELD_HOST=board.example.com
   ACME_EMAIL=admin@example.com
   PUBLIC_ORIGIN=https://board.example.com
   ```

4. Start HTTPS using the override, then permit inbound 80/443:

   ```sh
   docker compose -f compose.yaml -f compose.https.yaml up -d --build --wait
   ```

5. Open your exact `https://board.example.com` URL and sign in again. Caddy proxies both HTTP and WebSocket upgrades. The app uses its configured HTTPS origin for invitation URLs, CSRF and WebSocket origin checks, and sets HttpOnly, SameSite=Lax, **Secure** session cookies for HTTPS. No wildcard origins or trusted forwarded-host origin inference are used. Existing HTTP cookies are not migration credentials: sign in through HTTPS. If using SSH to view Mailpit, tunnel local 8025 to the server's 127.0.0.1:8025.

Use the same pair of Compose files on every subsequent server operation. `COMMONFIELD_HOST` must be a plain hostname, not a URL, path or wildcard; the override constructs the exact HTTPS origin. App startup rejects malformed/noncanonical origins. For a different reverse proxy, preserve WebSocket Upgrade handling and the exact `PUBLIC_ORIGIN`; keep its upstream on loopback/private Docker networking.

The app's loopback HTTP port remains available to local operators in HTTPS mode; mutation requests from that HTTP browser origin are refused after switching to HTTPS. Do not change the bind to 0.0.0.0. Do not start an unclaimed server behind an already-live public reverse proxy.

## Invitation capture

Mailpit is the only implemented SMTP target and cannot be changed to a real SMTP host through configuration. No SMTP port is published. Capture message state is persisted and the capture web UI is localhost-only; messages contain sensitive invitation links. UI delivery labels inherited from the app refer to SMTP acceptance, **not external inbox delivery**. The interface is not evidence of outbound email capability.
