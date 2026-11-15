# Operator recipe — review before installation

This is a recipe, not an installer. Keep all private configuration, SSH aliases, credential-store keys and actual installation paths outside Git. Do not execute the worker from a PR checkout. Do not install recurring execution until the reviewed real-PR canary is verified.

1. Run `python3 -m unittest discover -s tools/pr_gate -v` from the reviewed checkout.
2. Build the scanner from **only** the reviewed `tools/pr_gate` directory:
   `docker build -t commonfield-pr-scanner:review tools/pr_gate`.
   Inspect `docker inspect commonfield-pr-scanner:review --format '{{.Id}} {{.Architecture}} {{.Config.User}}'`.
   Use the exact local `sha256:...` image ID in configuration, never the mutable tag. The runtime scanner uses the nonroot operator UID/GID so its output remains removable by the worker; running the worker as root or with primary GID zero is rejected. Base Node is digest-pinned; npm package is fixed at 5.1.0. Debian packages and transitive npm resolutions are build-time inputs, so review/freeze each resulting image ID rather than claiming reproducible transitive resolution. Supported ARM JRE/engine provisioning is performed by the trusted scanner against the existing server.
3. Copy reviewed `gate.py` into a private operator-owned versioned directory outside all candidate/deployment trees. Copy the reviewed `.github/workflows/pr-quality.yml` alongside it as `pr-quality.yml`. Do not automatically update either from PR source. Record SHA-256 of both files with `sha256sum`. The JSON configuration must explicitly contain:

   ```json
   {
     "worker_sha256": "REPLACE_WITH_REVIEWED_GATE_PY_SHA256",
     "workflow_sha256": "REPLACE_WITH_REVIEWED_WORKFLOW_SHA256",
     "scanner_image": "sha256:REPLACE_WITH_BUILT_IMAGE_ID",
     "sonar_url": "http://127.0.0.1:19000",
     "sonar_token_key": "REPLACE_WITH_PRIVATE_CREDENTIAL_STORE_KEY"
   }
   ```

   Keep config and state directory mode 0700/0600 under the operator's account, not an untrusted shared directory. Protect the approved hashes/config using operator access controls. A hash stored next to writable code is not protection against a hostile same-UID operator. The account needs authenticated `gh`, the existing `gopass show KEY` integration, Docker access and trusted SSH access. No other gopass subcommands/flags are needed.
4. Establish an outbound SSH tunnel using a private, already trusted destination, e.g. `ssh -NT -o BatchMode=yes -o ExitOnForwardFailure=yes -L 127.0.0.1:19000:127.0.0.1:9000 PRIVATE_SSH_DESTINATION`. No inbound/public listener is required. Check the configured loopback `/api/server/version` before the worker. Keep SSH credentials on the host, never in the scanner.
5. The host API credential needs project creation/administration, browse, scoped analysis-token generation/revocation and token-search permission. The scanner receives only a one-day project-analysis token; there is **no fallback** to the broad API credential if scoping fails. Token creation and revocation are read back. Each unique project is recorded in the receipt; interrupted project creation can leave an empty project. Inspect diagnostics before cleanup. Do not mutate global gates/profiles or the original application project.
6. Execute the reviewed entrypoint once:
   `python3 TRUSTED_INSTALL/gate.py --config PRIVATE_CONFIG.json --state-dir PRIVATE_STATE`.
   It posts statuses, so first execution is an explicit publication step. Test against the real open PR and read back the exact SHA status, artifact ID/digest, new Sonar project, compute task, analysis revision, whole metrics and policy decision. Baseline findings are not infrastructure failures and must not be waived. The hosted baseline can now upload authentic LCOV and receive its own exact-head Sonar analysis **when** the authenticated job proves a coverage-only threshold failure and all other phases pass. The hosted check stays red, and the worker must publish policy failure for the unchanged failing baseline; the separate local static canary alone does not authorize any hosted status.
7. Only after review/canary, install equivalent native **user** units (templates below). Fill real paths/SSH destination privately; neither templates nor this recipe register anything. No model cron/Hermes changes are needed. The tunnel must be ready before the worker; a startup race fails closed and the next timer retries. Add operator monitoring of service failures/diagnostic creation; a silent GitHub status is not a worker-health check.

`commonfield-sonar-tunnel.service`:

```ini
[Unit]
Description=Commonfield private Sonar tunnel

[Service]
Type=simple
EnvironmentFile=%h/.config/commonfield-gate/tunnel.env
ExecStart=/usr/bin/ssh -NT -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:19000:127.0.0.1:9000 ${SONAR_SSH_DESTINATION}
Restart=on-failure
RestartSec=30
```

`commonfield-pr-gate.service` (replace `TRUSTED_VERSION` with the immutable reviewed version directory):

```ini
[Unit]
Description=Commonfield exact-head whole-candidate quality gate
Requires=commonfield-sonar-tunnel.service
After=commonfield-sonar-tunnel.service

[Service]
Type=oneshot
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
UMask=0077
ExecStart=/usr/bin/python3 %h/.local/lib/commonfield-gate/TRUSTED_VERSION/gate.py --config %h/.config/commonfield-gate/config.json --state-dir %h/.local/state/commonfield-gate
TimeoutStartSec=30min
TimeoutStopSec=45
MemoryMax=6G
TasksMax=512
```

`commonfield-pr-gate.timer`:

```ini
[Unit]
Description=Poll Commonfield PR quality without model runs

[Timer]
OnBootSec=1min
OnUnitInactiveSec=2min
AccuracySec=5s
Unit=commonfield-pr-gate.service

[Install]
WantedBy=timers.target
```

After authorized installation: daemon-reload, enable/start the timer, inspect `systemctl --user list-timers` and `journalctl --user -u commonfield-pr-gate.service`. Verify a repeated unchanged candidate posts no additional status and does not repeat a completed analysis. Keep the timer disabled while replacing trusted code/hash pairs. Changing worker bytes invalidates old receipt keys. Workflow changes must be approved and copied explicitly. Artifacts expire after one day; rerun hosted tests rather than reviving an expired receipt.

For rollback, stop/disable only these task-specific units, preserve private receipts/diagnostics and rotate task-scoped tokens if necessary. Do not disable required branch rules to merge a failing candidate. Project retention is manual and limited to exact receipt handles; no automatic deletion of shared projects is implemented.
