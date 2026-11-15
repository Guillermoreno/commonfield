# Source scope

This repository publishes only the application modules (access control, board content, collaboration, shared utilities, web client and writer authority), nine SQL migrations, pinned package/build configuration, selected portable tests, and the new deployment scripts/documentation.

Machine-specific review infrastructure, registry/attestation enrollment tooling, privileged integration fixtures, planning/design/review archives, historical evidence snapshots, agent configuration, generated build directories, dependency installations and runtime credentials are not part of this release. Those excluded original workflows were not edited or weakened. This package has a distinct portable startup and schema-migration entrypoint using fresh install-owned credentials.

Application cookie and WebSocket protocol names use the Commonfield identity consistently. Existing unrelated installations are not migration targets; this is a fresh self-hosting release, not an in-place import of another environment's operator credentials or sessions.
