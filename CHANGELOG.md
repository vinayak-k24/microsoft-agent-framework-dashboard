# Changelog

## Unreleased

### Repository/release baseline
- Added Node 22/24 CI for syntax checks, minimal correctness lint, and backend fixture tests, plus a Docker build-only job.
- Added recursive JavaScript syntax discovery and development-only ESLint tooling.
- Added a manually dispatched, version-tagged container archive workflow. No registry publishing, GitHub Release creation, or Azure provisioning is configured.
- Added contribution, support, security, getting-started, and privacy guidance. Licensing is deferred at the owner's request; no `LICENSE` is added or redistribution permission implied.

### Application additions awaiting release validation
- Added local multi-source workspace definitions and topology, metadata-only trace timelines/comparison/signals, pseudonymized trace exports, local notes/evaluation, and resource discovery in the surrounding application work.
- Linked the [distributed workspace guide](docs/distributed-workspaces.md) and [example definition](examples/distributed-workspace.json). Workspaces are independent of the selected Foundry project and can span subscriptions, resource groups, and repositories.
- Clarified that original single-agent views expose recorded raw inputs/outputs and logs when available. Redaction applies only to distributed **Download redacted trace** exports.
- These changes remain unreleased. Repository checks do not certify live Azure interoperability, telemetry completeness, or privacy/compliance controls; live Azure validation has not been performed by this baseline.
- Local-first access remains the approved model: no local administrator account, hosted/OIDC authentication, or remote publishing. Azure CLI sign-in remains a separate cloud-access step.

The package currently declares version `1.0.0`; that alone is not evidence of a published or validated release. Tests use deterministic Azure fixtures. No live Azure validation or release history is claimed here.
