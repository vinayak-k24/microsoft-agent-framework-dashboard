# Article workflow

This example adapts the supplied `agent-framework-workflows-responses` sample into one Foundry-hosted workflow: **topic_researcher → content_organizer → faq_writer**. It atomically claims the oldest Pending SQL article, researches its topic with citations, organizes Markdown with hashtags, adds FAQs, uploads a private Blob, and then marks the article Completed. An empty queue returns `NO_PENDING_ARTICLES`; the user message does not replace the SQL topic.

The dashboard only replays recorded traces. **Agents & Workflow and Solution Workspaces are disabled for now**; deploying this example does not enable them.

## Prepare the example locally

From the repository root, create the example's isolated Python environment before using the deployment instructions below:

```powershell
Set-Location .\examples\article-workflow
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

Establish organization-approved Azure CLI and azd authentication separately when cloud operations are authorized. No script here automatically signs in. Review the identity, networking and cost requirements below before provisioning.

## Deployment assets (manual, not deployed)

**No live Azure deployment, SQL bootstrap, invocation, or trace ingestion has been verified.** These are bounded deployment assets, not a claim of production readiness. Run all remaining commands from this example, never the repository root.

### Assets and architecture

- `azure.yaml`: official `microsoft.foundry` provider; `azure.ai.project` and one container-hosted `azure.ai.agent` containing the three-agent workflow. No standalone legacy manifest. The Python 3.12 Dockerfile accommodates `mssql-python`; remote ACR builds avoid requiring local Docker.
- `infra/data.json`: native ARM, dedicated Entra-only Azure SQL Basic database (`articles`), encryption, private `articles` Blob container, keyless Storage, container-scoped Blob Data Contributor for runtime and developer. Azure RBAC **does not grant SQL data access**.
- `scripts/deploy.ps1`: explicit provisioning/data endpoints → deploy **without invocation** → discover/verify the actual runtime identity → opt-in Blob/SQL bootstrap. Native command failure stops subsequent steps. Sample inserts require a separate opt-in.
- `scripts/bootstrap.ps1`: resume identity verification and scoped runtime grants/schema without redeploying or invoking.
- `scripts/load-local-env.ps1`: dot-source to populate only required local process variables; no `.env` is created and values are not printed.
- `scripts/validate.ps1`: local parsing/safety checks; `-Schemas` retrieves public official schemas without sending repository code to a service.

The Foundry provider creates its account/project/model, ACR and pull connection for container deployment, and (for a **new** project) a 30-day Log Analytics workspace, Application Insights, and a project connection with category **`AppInsights`**. It handles its hosting/project identities and ACR pull authorization. Existing projects are **not** automatically opted into monitoring: provide a reviewed existing workspace-backed component via `ai-project.monitoring.applicationInsightsResourceId` and confirm its connection before proceeding. Connection credentials are provider-resolved, never committed.

### Container security

The Dockerfile pins the official Python 3.12 slim Trixie multi-platform image by digest and retains the SQL driver's Debian native libraries and non-root runtime. At review time, Docker Hub reported **2 high** findings for its linux/amd64 base image, compared with **16 high** for the previous Bookworm image. This is a reduction, not a vulnerability-free image or a completed-image scan. Refresh the digest regularly and build and scan the complete image for the deployment architecture before deployment; installed OS and Python dependencies can add findings. Verify native SQL driver loading and `/readiness` in that container. The local Docker daemon was unavailable, so those container checks remain unverified.

### Fresh deployment and runtime identity

Current official azd implementation creates the hosted **instance identity only when an agent version is deployed**, not during `azd provision`. No supported `azure.yaml` hosted-service property was found for choosing a pre-created user-assigned instance identity. The project identity and ACR pull identity are **not** substitutes for the workflow's runtime identity.

Fresh deployments therefore use **provision → deploy (no invocation) → discover identity → grant Blob/SQL → invoke separately**. Provisioning creates the data endpoints and developer access with **no runtime role**. The application startup and `/readiness` do not access SQL/Blob; only later workflow tool calls do. Do not invoke through the CLI, portal or another client until explicit bootstrap and network review succeed. If startup is changed to access data, this ordering must be redesigned.

Bootstrap reads `AGENT_ARTICLE_WORKFLOW_NAME`, `_VERSION`, `_PROJECT_ENDPOINT`, `_INSTANCE_IDENTITY_PRINCIPAL_ID` and `_INSTANCE_IDENTITY_CLIENT_ID` from the selected environment. It calls `azd ai agent show article-workflow --output json`, which performs a **live agent-version GET**, and compares the returned `name`, `version`, `definition.kind`, status and `instance_identity.principal_id/client_id` against those deployment outputs. It also validates the project/endpoint binding and resolves the same object through `az ad sp show` in the checked Azure CLI tenant, comparing its object/client IDs and retrieving the display name. Missing fields, stale markers, mismatches and insufficient directory-read access **stop bootstrap before grants**. These response fields are verified against current [official show implementation](https://github.com/Azure/azure-dev/blob/main/cli/azd/extensions/azure.ai.agents/internal/cmd/show.go) and [identity model](https://github.com/Azure/azure-dev/blob/main/cli/azd/extensions/azure.ai.agents/internal/pkg/agents/agent_api/models.go); actual live responses remain untested here.

The SQL user alias combines the resolved display name with the full principal GUID (maximum 128 characters), preventing same-name alias reuse across different principals. No arbitrary identity is injected. Every new hosted version requires this discovery/bootstrap sequence; old-version SQL users/Blob roles are not automatically revoked. Review and remove obsolete access separately, without disrupting active versions.

### Prerequisites and review

1. PowerShell 7.2+, Python 3.12, the example's installed dependencies, and Azure CLI. Validation additionally uses `PyYAML` and `jsonschema` (`python -m pip install PyYAML jsonschema` in a local tooling environment).
2. Verified local CLI: azd **1.37.2**, agents **1.0.0-beta.23**, projects **1.0.0-beta.16**. Hosted agents, hosting SDKs and web-search tooling may be preview; check regional availability, subscription feature eligibility, model/version/SKU quota and organizational policies. The script validates the regional model catalog, not quota or capacity reservations.
3. Authentication must already be established independently for both azd and Azure CLI. Scripts never log in or change subscriptions. Their selected subscription and Azure CLI directory tenant must match the reviewed environment. The deployment operator needs resource creation, role-assignment and directory-read permissions for the runtime principal; the developer needs Foundry access, trace-reading access and SQL Entra admin access. Review these elevated **demo schema-admin** permissions: the specified developer is server Entra administrator on this example's dedicated server, not merely a SQL Azure RBAC Contributor.
4. Fill `infra/data.parameters.example.json` into a **locally ignored/untracked file** (for example `.azure/<environment>/data.parameters.json`). Never commit object IDs, display names, environment exports or connection strings. Use the same tenant/subscription/location/environment as azd; no personal identifiers are included in committed assets.
5. This bounded template does **not** implement VNet injection, private endpoints, DNS or NAT. Public networking requires explicit `allowPublicDemoNetworking=true`. SQL firewall ranges must include only your developer egress and verified hosted-runtime egress; each reviewed range is capped at 256 addresses, maximum 32 ranges. `0.0.0.0`/allow-all-Azure is prohibited. Hosted egress is not promised stable or discoverable before deploy. If scoped egress cannot be established, **stop** and design a private-network deployment; do not widen the firewall. Blob is private by authorization, **not private networking**: opt-in makes its HTTPS endpoint publicly reachable, while anonymous and Shared Key access remain disabled. The default disabled endpoints are fail-closed, not a working private-network architecture.
6. SQL uses `Authentication=ActiveDirectoryDefault;Encrypt=yes;TrustServerCertificate=no`. Local bootstrap must authenticate as the configured developer Entra administrator. `CREATE USER ... FROM EXTERNAL PROVIDER WITH OBJECT_ID` requires directory-resolution authorization; check SQL/Entra requirements before execution. Runtime receives only `SELECT, UPDATE` on `dbo.Articles`; seed `INSERT` runs as admin. Directory Readers is **not** silently assigned. If a version's native driver cannot authenticate its Foundry instance identity, stop; passwords/storage keys are not fallbacks.
7. Review source `.dockerignore` before any remote build: exclude `.azure`, `.env*` (except deliberately safe templates), `.venv`, credentials and caches. Hosted runtime must listen on port 8088 and implement Responses 2.0.0. The latest `agent-dev-cli` dependency conflicts with the current framework core; it is intentionally not a runtime prerequisite. Use native hosting and the separately documented debugpy workflow, not `--no-deps` installations.

### Manual preparation and fresh deployment

These instructions are **not authorization to execute cloud operations**. First review the identity/network prerequisites above. The existing manifest preserves the example source; do not run template initialization with `--force`. If scaffolding needs regeneration, documented `azd ai agent init --src <source-directory> --deploy-mode container --agent-name article-workflow` is the official route; run in a disposable working copy, review its diff, and retain the example source and data tier. Init can prompt for Azure selection: it was **not executed** here.

Create an environment in this example (or select a reviewed existing one with `azd env select`). Set subscription, tenant and approved hosted region separately. Provide the exact catalog model/version/SKU (no availability is assumed). `AI_PROJECT_DEPLOYMENTS` is the documented environment-local deployment override; the script supplies a complete typed JSON array rather than relying on ambiguous capacity substitutions.

```powershell
# Only set for this process; never azd env set or commit this telemetry marker.
$env:AZURE_DEV_USER_AGENT = 'microsoft_foundry_skill'
$environment = 'article-demo'
azd env new $environment --subscription '<subscription-guid>' --location '<approved-region>' --no-prompt
azd env set AZURE_TENANT_ID '<tenant-guid>' -e $environment
Copy-Item .\infra\data.parameters.example.json ".azure\$environment\data.parameters.json"
# EDIT that local file: tenant/developer/name/region/environment, public-demo
# networking opt-in and narrow developer + reviewed hosted egress ranges.
# Leave runtimeObjectId absent/empty: it is discovered AFTER deployment.

# Review all operations, costs, source build context and firewall ranges first.
.\scripts\deploy.ps1 -EnvironmentName $environment `
  -DataParametersPath ".azure\$environment\data.parameters.json" `
  -ModelName '<catalog-name>' -ModelVersion '<catalog-version>' `
  -ModelDeploymentName '<deployment-name>' -ModelSku '<approved-sku>' `
  -ModelCapacity 10 -Apply -BootstrapSchema
# Add -SeedSamples only when sample INSERTs are explicitly approved.
```

The Python bootstrap interface is:

```powershell
python setup_data_store.py --managed-identity-name <name> --managed-identity-object-id <guid>
# Optional explicit data insertion:
python setup_data_store.py --seed-samples --managed-identity-name <name> --managed-identity-object-id <guid>
```

Bootstrap creates `dbo.Articles` and its Entra runtime user, with `WITH OBJECT_ID` to disambiguate identities. It is not a provisioning hook and is never run by validation. The deployment script calls it **after** `azd deploy article-workflow`, discovery and scoped Blob/Foundry grants. Do not use `azd up`, which omits explicit schema/data authorization. RBAC/directory propagation may delay access: stop on failures and investigate. No automatic destructive retries are performed. To resume an already deployed version without another build/version:

```powershell
.\scripts\bootstrap.ps1 -EnvironmentName $environment `
  -DataParametersPath ".azure\$environment\data.parameters.json" -Apply
# Add -SeedSamples only if seed INSERTs are separately approved.
```

Bootstrap checks the live identity again after SQL setup to detect a concurrent deployment. A failure may leave partial resources/grants/schema; it is not a rollback. Keep the version uninvoked, review the state, then rerun bootstrap. Incremental ARM does not delete obsolete firewall rules: narrowing/removing previously provisioned ranges requires explicit review and removal of the old server rules.

### Outputs, local configuration and remote invocation

Foundry azd outputs include `AZURE_AI_PROJECT_ID`, `FOUNDRY_PROJECT_ENDPOINT`, ACR endpoint/resource ID/connection, `AZURE_APPLICATION_INSIGHTS_RESOURCE_ID`, `AZURE_APPLICATION_INSIGHTS_APP_ID`, `AZURE_LOG_ANALYTICS_WORKSPACE_RESOURCE_ID` and `AZURE_AI_PROJECT_APPINSIGHTS_CONNECTION_NAME`. ARM outputs include `AZURE_SQL_SERVER_HOSTNAME`, `AZURE_SQL_DATABASE_NAME`, keyless `AZURE_SQL_CONNECTION_STRING`, `AZURE_STORAGE_ACCOUNT_URL`, `AZURE_STORAGE_CONTAINER=articles`, and `ARTICLE_RUNTIME_PRINCIPAL_ID`. Treat environment dumps as private; outputs describe configuration, not ingestion readiness.

Foundry automatically injects `FOUNDRY_PROJECT_ENDPOINT` and `APPLICATIONINSIGHTS_CONNECTION_STRING` into hosted containers. They are intentionally **absent from the service env map**. Model, SQL, Blob and OTEL settings are forwarded explicitly. Local setup reads the component's connection string in memory:

```powershell
. .\scripts\load-local-env.ps1 -EnvironmentName $environment
# Separately authorized remote read and invocation only AFTER identity/network checks:
azd ai agent show article-workflow -e $environment --output json
azd ai agent invoke article-workflow "Process one pending article" -e $environment --protocol responses --new-session
```

Invocation command/protocol/session flags were checked against installed help. An invocation can update SQL, write a Blob, use web search/model tokens, and incur charges. It is **not** automatically run by the script. Do not create evaluation suites as part of this example's deployment.

## Replay the generated trace

1. Bootstrap with `-SeedSamples` only after approving the synthetic topics. Without Pending rows, an invocation exits without processing an article. Seeds are idempotent and never reset Completed or Failed rows.
2. For **synthetic data only**, optionally change the hosted service's `ENABLE_SENSITIVE_DATA` literal in `azure.yaml` to `'true'` **before deployment**. The default records spans but omits sensitive model/tool content; replay cannot reconstruct that content afterward. Restore `'false'` before using real data. A changed hosted version needs identity bootstrap again.
3. After successful grants and network review, invoke once using the command above. Confirm SQL is Completed and the private Blob exists. The returned Blob URL is not anonymous access; open it with an authorized identity.
4. Start the dashboard from the repository root with `npm start`, open `http://localhost:3000`, and sign in under **Settings**. **Copy code** copies the Azure device code; if unavailable, select and copy its readonly field manually.
5. Select the deployed Foundry project. Its `AppInsights` connection is discovered automatically; otherwise use **Override App ID** with `AZURE_APPLICATION_INSIGHTS_APP_ID` from the reviewed environment. This is not the instrumentation key or connection string.
6. Select telemetry role **article-workflow**, a time window covering the invocation, and its trace in **Trace Playback**, then press **Play**. Inspect agent handoffs, model/tool spans and final output. Agent roles shown here come from telemetry, not the disabled workflow-management view.

Allow several minutes for telemetry ingestion, then refresh. If nothing arrives, verify exporter configuration, the selected Insights component, read permissions, time range and sampling rather than generating repeated billable runs. Recorded payloads remain sensitive: review the dashboard [privacy guidance](../../docs/privacy.md) before sharing them.

Failed/cancelled runs may leave an article Processing. SQL and Blob are not one transaction: an upload can succeed before the SQL update fails. Inspect the row and Blob, confirm no active worker, and explicitly reconcile status/output before retrying; do not blindly reset Processing rows or overwrite results.

### Optional local Inspector

Install the Python/debugpy and Foundry Toolkit extensions. From this example, copy `.env.example` to the ignored `.env` and replace all placeholders with reviewed local configuration; never commit it. Local SQL access uses the signed-in developer identity, not the deployed instance identity. From the repository workspace, select **Article workflow: Agent Inspector** and press **F5**. The task starts debugpy/native hosting on ports 5679/8088 and requests the Inspector webview; interactive integration remains unverified. Sending a message still invokes real Azure models and SQL/Blob tools and needs separate authorization. Dashboard replay needs neither F5 nor a running local agent.

### Traces, privacy and preview limitations

Trace replay needs the Insights **App ID**, not its instrumentation key, and read access to that component (Log Analytics Reader is assigned to the developer). Verify a completed remote invocation and eventual trace arrival before relying on replay. A project connection or successful provisioning alone does not prove trace ingestion. Hosted/platform traces and application spans may differ by SDK version; the workflow explicitly configures additive framework App Insights export/privacy settings and disables host observability reconfiguration (`configure_observability=None`). Deployment adds no duplicate provider.

The native Responses host uses a zero-argument **per-request workflow factory**, never a shared singleton. The hosting SDK currently deprecates its `WorkflowAgent` adapter; the request factory is the isolation workaround, not a promise of long-term adapter compatibility. Native `/readiness` returned HTTP 200 in offline testing without Azure calls; `/responses` is the protocol route. Stored in-flight responses are **not crash durable**, even though article status and completed Blobs are persistent. debugpy F5/native hosting is available separately; `/entities` is absent, and Inspector graph/debugging support is unverified. No graph-debugging guarantee is made.

`OTEL_SERVICE_NAME=article-workflow` and `ENABLE_SENSITIVE_DATA=false` are configured consistently. Disabling sensitive-data instrumentation is not a blanket privacy guarantee: application logs, exception text, spans, article metadata and platform telemetry still require review. Replay cannot recover prompt/article content deliberately not captured. SQL/Blob durability is separate from trace retention. Web-search availability, tools/grounding support and outbound internet policy depend on the model/service/preview region; do not assume arbitrary public browsing. Public internet web search and private SQL access need a deliberate combined egress policy.

### Validation and cleanup

```powershell
.\scripts\validate.ps1
.\scripts\validate.ps1 -Schemas
pwsh -NoProfile -File .\scripts\test-assets.ps1
# Activate the example's installed Python 3.12 virtual environment first.
python -m unittest discover -s tests -v
```

These checks are local (schema mode only downloads public definitions); the Python suite covers offline workflow regressions. They do **not** run `az deployment validate`, what-if, login, init, provision, deploy, SQL or invoke. ARM resource schema validation cannot verify expression evaluation, role propagation, live identity/Graph response compatibility, native driver instance-identity authentication, Entra resolution, regional quota or networking. The validator explicitly selects the official expression branch for bracketed ARM expressions where an official `oneOf` also accepts an unconstrained literal string; literal-value validation remains strict. Docker was unavailable: no image build or live Azure operation was performed.

Resources are billable: hosted runtime, model/search usage, ACR storage/builds, SQL, Blob and telemetry ingestion/retention. Basic SQL and LRS are **demo** choices, not production availability or backup guarantees. SQL has platform short-term backups; Blob/container soft delete is seven days. Review retention, compliance, disaster recovery and cost budgets before production use.

After manual resource review and exporting any required data, delete only this dedicated example group via `az group delete --subscription <subscription-guid> --name <reviewed-example-group>` or inspect the official `azd down` plan/help first. Both can delete SQL/Blobs/traces and unrelated resources in that group. Existing/shared projects or BYO monitoring must not be deleted blindly; never clean up the repository's other deployments. No automatic cleanup script is provided.

References: [hosted quickstart](https://learn.microsoft.com/azure/foundry/agents/quickstarts/quickstart-hosted-agent?pivots=azd), [project provider/monitoring](https://github.com/Azure/azure-dev/blob/main/cli/azd/extensions/azure.ai.projects/README.md#application-insights), [runtime env](https://learn.microsoft.com/azure/foundry/agents/how-to/configure-hosted-agent-env-variables), [SQL schema](https://learn.microsoft.com/azure/templates/microsoft.sql/2025-01-01/servers), [Storage schema](https://learn.microsoft.com/azure/templates/microsoft.storage/2025-06-01/storageaccounts), [Azure naming rules](https://learn.microsoft.com/azure/azure-resource-manager/management/resource-name-rules).
