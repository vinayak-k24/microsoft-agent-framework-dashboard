# Contributing

This dashboard is a trusted local tool: a CommonJS Node backend serves vanilla browser scripts on the same origin. Azure CLI provides the backend cloud identity; local dashboard accounts and hosted authentication are intentionally absent. All tabs share the backend identity and persisted settings. Keep host access on loopback.

Start with [getting started](docs/getting-started.md). For development, install Node.js 22.13+ (or Node 24+) for the current ESLint toolchain and run:

```powershell
npm ci
npm run check
npm run lint
npm test
```

`check` discovers JavaScript recursively in `backend`, `frontend`, and `tools`, including backend tests and new modules, plus the ESLint configuration. `lint` uses a small correctness-only ruleset, not formatting rules. Backend/tool scripts use CommonJS and Node globals. Browser files are classic scripts sharing globals, so browser undefined/unused-global enforcement is intentionally not enabled.

Use existing Node tests with deterministic adapters for backend behavior. Never require contributor credentials for unit tests. Add focused regression cases, keep changes scoped, and document API/persistence changes. Describe fixture results separately from live Azure observations. CI checks Node 22/24 and builds the existing Linux container; it neither deploys Azure resources nor publishes images.

Before requesting review, run the checks and, when Docker is available, `docker build --tag foundry-agent-dashboard:review .`. Do not submit `data`, Azure CLI caches, raw telemetry, screenshots with private data, or secrets. See [privacy](docs/privacy.md) and [security reporting](SECURITY.md).

No legal license has been selected. The owner must choose and add licensing terms before public distribution; contribution or access to the files does not itself grant redistribution rights. No contributor agreement or public distribution permission is implied by this guide.
