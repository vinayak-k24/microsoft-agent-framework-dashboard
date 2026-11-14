# Getting started and local release preparation

## Architecture and prerequisites
The CommonJS backend serves the vanilla frontend on one HTTP origin and uses Azure CLI for Foundry/Application Insights access. Runtime requires Node.js 22+; development checks require Node.js 22.13+ (or Node 24+) for the current ESLint toolchain. Azure CLI is needed for cloud access, but fixture tests do not need a login. The application currently has no production npm dependencies; ESLint dependencies are development-only.

```powershell
npm ci
npm run check
npm run lint
npm test
npm start
```

Open `http://localhost:3000`. There is no local dashboard account, administrator setup, or hosted/OIDC authentication. Sign in to Azure in Settings or run `az login` where the backend runs. For the original single-agent views, select a Foundry project and configure its Application Insights connection. Use an organization-approved CLI login method if device login is blocked. All browser tabs share the backend identity and settings. Live access requires actual project/telemetry permissions and is not established by tests.

For multi-source solutions, follow the [distributed workspace guide](distributed-workspaces.md) and its [example definition](../examples/distributed-workspace.json). Workspaces are independent of the selected Foundry project and can group services across subscriptions, resource groups, and repositories. They require access to their configured telemetry sources, not a selected Foundry project or a hosted shared dashboard.

**Privacy:** original single-agent views expose recorded raw inputs/outputs and logs when available. Redaction applies only to the distributed workspace **Download redacted trace** export, not other views, screenshots, or copied data. See [privacy](privacy.md).

Use `npm start -- --port 3100 --data-dir D:\dashboard-data` for local overrides. Keep host access on loopback. `/healthz` checks HTTP availability only.

## Existing Compose development path
With Docker Desktop running Linux containers:

```powershell
docker compose up --build -d
docker compose exec dashboard az login --use-device-code
docker compose down
```

The existing Compose file publishes only to host loopback and persists settings and container Azure CLI credentials in separate volumes. The container does not reuse host credentials. `down` preserves volumes; `down -v` deletes settings and credentials. Keep them private.

## Versioned container, local only
Review `package.json` version before preparing an archive; bump it deliberately for changed release candidates. No registry destination is selected. Do not use `docker push`, provision resources, or treat the package version as a published release. Licensing is deferred at the owner's request; no `LICENSE` is added and no redistribution permission is implied.

```powershell
npm ci
npm run check
npm run lint
npm test
$version = node -p "require('./package.json').version"
docker build --tag "foundry-agent-dashboard:$version" .
if ($LASTEXITCODE -ne 0) { throw 'Container build failed' }
docker run --detach --name dashboard-release-check --init --publish 127.0.0.1:3100:3000 --mount type=volume,source=dashboard-release-data,target=/app/data --mount type=volume,source=dashboard-release-azure,target=/home/node/.azure "foundry-agent-dashboard:$version"
```

After startup, inspect `docker logs dashboard-release-check` and run `curl.exe --fail http://localhost:3100/healthz`. Check the UI locally; cloud verification, if authorized, is a separate step. Stop and remove only this check container with `docker stop dashboard-release-check` and `docker rm dashboard-release-check`; its named volumes are preserved. Do not expose the published port beyond loopback.

For a local archive:

```powershell
New-Item -ItemType Directory -Force .\release | Out-Null
docker save --output ".\release\foundry-agent-dashboard-$version.tar" "foundry-agent-dashboard:$version"
if ($LASTEXITCODE -ne 0) { throw 'Container export failed' }
Get-FileHash ".\release\foundry-agent-dashboard-$version.tar" -Algorithm SHA256
docker load --input ".\release\foundry-agent-dashboard-$version.tar"
```

Save the checksum alongside the archive and verify it before loading elsewhere. Never include a running container's volumes or credential caches in release archives. The image includes Azure CLI and upstream OS packages. Local builds depend on upstream packages and are not guaranteed byte-for-byte reproducible.

## Optional GitHub workflows
Workflow files are inert until the owner chooses to host the repository; no Git initialization or remote publishing is performed by this baseline. CI runs on pushes/PRs/manual dispatch. **Prepare container archive (no publishing)** runs only by manual dispatch, validates Node checks/tests, builds the package-version image, and uploads a Linux amd64 image tar plus SHA-256 checksum as a seven-day Actions artifact. It does not push images or create public releases and needs no Azure/registry secrets. Artifacts inherit repository access; configuring this workflow does not authorize public distribution. Downloaded archives use `docker load`; extract the artifact ZIP first.

See [privacy](privacy.md) before sharing workspace files, logs, or exports.
