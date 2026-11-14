# Distributed solution workspaces

A solution is a **logical grouping**, not a deployment boundary. Its orchestrator, agents and tools can live in different subscriptions, resource groups and repositories. This dashboard queries their Application Insights sources; it does not deploy, execute or modify those services.

## Connect a solution

1. Sign in to Azure in Settings. The backend identity needs read access to every selected telemetry source; ARM discovery and telemetry query permissions are separate.
2. Open **Solution Workspaces**, create a definition, and add each Application Insights **App ID**, not a connection string, instrumentation key or Log Analytics workspace ID.
3. Add each component with its source and exact `cloud_RoleName`. Multiple roles can share one source. Resource discovery suggests metadata, but resource names are not guaranteed to equal telemetry roles.
4. Add declared connections and optional owner, HTTPS repository and version information.
5. Save and refresh. Source diagnostics distinguish errors, empty results and truncated queries. Open a listed trace or paste its 32-character hexadecimal trace ID.

The [example definition](../examples/distributed-workspace.json) contains **placeholder App IDs and roles**. Replace these before saving. Import it through **Create workspace → Import a versioned definition**. Imports populate the editor; only Save persists them.

Definitions can be maintained alongside a Functions workflow or in a separate integration repository. Keep source/component IDs stable and version definitions in source control. Import the matching definition on each developer's dashboard. Repository links and ownership identify where fixes belong; importing never fetches private code.

## Telemetry contract

Each service must emit request/dependency spans to Application Insights. Across HTTP boundaries, use SDK-supported W3C trace-context propagation (`traceparent`, and `tracestate` when applicable). A receiving service must continue the trace rather than create an unrelated operation. Do not invent parent IDs or overwrite valid incoming context.

| Application Insights field | Meaning |
|---|---|
| `operation_Id` | Shared trace ID across services |
| `id` | Span ID |
| `operation_ParentId` | Recorded direct parent span |
| `cloud_RoleName` | Stable service role, matched to a component |
| `timestamp`, `duration`, `success` | Observed interval and failure information |
| `customDimensions['workflow.run.id']` | Optional business-run identifier |
| `customDimensions['prop__instanceId']` | Optional Durable Functions instance identifier |
| `customDimensions['service.version']` | Optional recorded deployed version |
| `customDimensions['containerapp.revision']` | Optional recorded Container Apps revision |
| `customDimensions['retry.attempt']` | Optional recorded retry attempt |
| `customDimensions['gen_ai.operation.name']` | `chat` for token-counted model spans |
| `customDimensions['gen_ai.usage.input_tokens']`, `['gen_ai.usage.output_tokens']` | Optional chat token counts |

These optional dimensions must actually be emitted by your instrumentation. The dashboard does not configure SDKs or assume they exist. Set stable roles and version metadata in the service's instrumentation configuration. Durable replay, asynchronous tasks and queue propagation need framework-specific instrumentation; merely declaring a queue edge does not implement it.

Sources use the Application Insights query API with classic `requests` and `dependencies` tables. Log Analytics workspace IDs and custom-only table schemas are not supported by this adapter.

Official guidance: [distributed tracing](https://learn.microsoft.com/azure/azure-monitor/app/distributed-trace-data), [cross-resource querying](https://learn.microsoft.com/azure/azure-monitor/logs/cross-workspace-query), [Durable Functions diagnostics](https://learn.microsoft.com/azure/azure-functions/durable/durable-functions-diagnostics).

## Designed versus observed

- Dashed connections come from the saved definition. They do **not** prove a call occurred.
- Solid connections come only from direct recorded parent-span relationships between registered components.
- Parallel spans retain their overlapping intervals; no sequential handoff is inferred from timing.
- Missing parents, unknown roles, conflicting duplicates, sampling, source failures and query truncation produce visible warnings.
- Business-run IDs, Durable instance IDs, deployment versions and revisions remain separate metadata. Unrelated traces are not joined solely because their business IDs match.
- Timeline playback only highlights observed intervals. It never executes a workflow or agent.

## Operational signals and comparison

Queries run on demand over 1, 7, 30 or 90 days. Each source returns at most 1,000 spans; an extra row detects truncation. Open an exact trace to narrow a truncated run list. Even a complete-looking response cannot establish that all telemetry was emitted or ingested.

Duration means **earliest observed span start to latest observed span end**, not necessarily business-run latency. The run-list p95 and failure fraction describe bounded observed traces, not your complete workload. A run with no failed span is labeled **no-failure-observed**, not guaranteed successful. Unknown/incomplete results must not be interpreted as healthy.

Local thresholds show indicators in this UI; they do not create Azure Monitor alerts. Optional blended token prices use one consistent user-selected currency. Estimates exclude unobserved tokens, non-token charges and pricing differences across models; they are not Azure billing.

Open two traces to compare coverage, failures, tokens, recorded versions and estimates. Self-entered reviewer notes and 0–5 scores persist locally. They are investigation aids, not authenticated collaboration or automated evaluations.

## Sharing and limits

Use **Download redacted trace** for an allowlisted, pseudonymized export. It excludes names, raw trace/span IDs, absolute timestamps, prompts, outputs, logs, business IDs, versions, repositories and notes. Relative timings, token counts and failures remain; review before sharing. Existing single-agent views may display raw recorded inputs/outputs and are **not** covered by this export's redaction.

Local deep links require the recipient's matching definition and Azure permissions. They are not hosted share links. Never forward your Azure credential cache or persisted private configuration.

Definitions are capped at 8 workspaces, 8 sources per workspace, 40 components, 80 connections and 100 annotations. Save requests are limited to 64,000 bytes. Deleting a workspace deletes only its local definition and notes, not Azure resources or telemetry.

This release deliberately remains local-first: no Entra dashboard authorization, hosted multi-user tenancy, remote annotation synchronization, workflow execution or automatic provisioning. Azure CLI login is shared by all tabs that reach the backend. Keep it on loopback.
