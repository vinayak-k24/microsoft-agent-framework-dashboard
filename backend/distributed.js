const { TRACE } = require('./workspaces');
const LIMIT = 1000;
const literal = (value) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
function daysValue(value) {
  const days = Number(value ?? 7);
  if (![1, 7, 30, 90].includes(days)) throw Object.assign(new Error('Time window must be 1, 7, 30 or 90 days.'), { status: 400 });
  return days;
}
function queryText(workspace, source, days, traceId) {
  const roles = workspace.components.filter((c) => c.source === source.id).map((c) => literal(c.role));
  return `union dependencies, requests
    | where timestamp > ago(${days}d)
    | where ${traceId ? `operation_Id == '${traceId}'` : `cloud_RoleName in (${roles.join(',') || "''"})`}
    | project traceId=operation_Id, id, parent=operation_ParentId, timestamp, durationMs=duration, name,
      role=cloud_RoleName, itemType, success, sampleCount=itemCount,
      operation=tostring(customDimensions['gen_ai.operation.name']),
      tokensIn=tolong(customDimensions['gen_ai.usage.input_tokens']), tokensOut=tolong(customDimensions['gen_ai.usage.output_tokens']),
      model=tostring(customDimensions['gen_ai.request.model']), workflowRunId=tostring(customDimensions['workflow.run.id']),
      durableInstanceId=tostring(customDimensions['prop__instanceId']), version=tostring(customDimensions['service.version']),
      revision=tostring(customDimensions['containerapp.revision']), retryAttempt=tostring(customDimensions['retry.attempt'])
    | order by timestamp desc | take ${LIMIT + 1}`;
}
function spanId(value) {
  const v = String(value || '');
  return v.match(/(?:^|\.)([a-f0-9]{16})(?:\.|$)/i)?.[1].toLowerCase() || v;
}
function normalize(results, workspace) {
  const warnings = [];
  const spans = new Map();
  for (const result of results) {
    if (result.status !== 'ok') { warnings.push(`Source ${result.name}: ${result.error}`); continue; }
    if (result.truncated) warnings.push(`Source ${result.name}: query reached ${LIMIT} spans; narrow the window or open a trace directly.`);
    for (const row of result.rows.slice(0, LIMIT)) {
      const start = Date.parse(row.timestamp), durationMs = Number(row.durationMs);
      if (!TRACE.test(row.traceId || '') || !row.id || !Number.isFinite(start) || !Number.isFinite(durationMs) || durationMs < 0) {
        warnings.push(`Source ${result.name}: malformed span excluded.`); continue;
      }
      const traceId = row.traceId.toLowerCase(), id = spanId(row.id), key = `${traceId}:${id}`;
      const component = workspace.components.find((c) => c.source === result.id && c.role === row.role);
      const existing = spans.get(key);
      if (existing) {
        if (!existing.sources.includes(result.id)) existing.sources.push(result.id);
        existing.sampled ||= Number(row.sampleCount) > 1;
        if (existing.startMs !== start || existing.durationMs !== durationMs || existing.role !== row.role || existing.parent !== spanId(row.parent) || (row.success === false && existing.success !== false)) warnings.push(`Conflicting copies of span ${id}; first metadata retained, sampling and failures merged conservatively.`);
        if (row.success === false) existing.success = false;
        if (!existing.component && component) existing.component = component.id;
        continue;
      }
      const token = (v) => Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0;
      spans.set(key, { traceId, id, parent: spanId(row.parent), start: new Date(start).toISOString(), startMs: start, durationMs,
        name: String(row.name || ''), role: String(row.role || ''), component: component?.id || '', sources: [result.id],
        kind: row.operation || row.itemType || 'span', success: row.success === true ? true : row.success === false ? false : null,
        tokensIn: row.operation === 'chat' ? token(row.tokensIn) : 0, tokensOut: row.operation === 'chat' ? token(row.tokensOut) : 0,
        model: String(row.model || ''), workflowRunId: String(row.workflowRunId || ''), durableInstanceId: String(row.durableInstanceId || ''),
        version: String(row.version || ''), revision: String(row.revision || ''), retryAttempt: String(row.retryAttempt || ''),
        sampled: Number(row.sampleCount) > 1 });
    }
  }
  return { spans: [...spans.values()].sort((a, b) => a.startMs - b.startMs), warnings: [...new Set(warnings)] };
}
function reconstruct(spans, workspace, sourceWarnings = []) {
  const byId = new Map(spans.map((s) => [s.id, s]));
  const warnings = [...sourceWarnings];
  const observed = new Map();
  for (const span of spans) {
    const parent = byId.get(span.parent);
    if (span.parent && !parent) warnings.push(`Missing parent for span ${span.id}; context may be outside the configured sources or query window.`);
    if (!span.component) warnings.push(`Unregistered service role: ${span.role || '(empty)'}.`);
    if (span.sampled) warnings.push('Sampling detected; counts and completeness are not guaranteed.');
    const visited = new Set([span.id]);
    let cursor = parent;
    while (cursor) {
      if (visited.has(cursor.id)) { warnings.push('Cyclic span parent metadata detected.'); break; }
      visited.add(cursor.id); cursor = byId.get(cursor.parent);
    }
    if (parent && parent.component && span.component && parent.component !== span.component) {
      const key = `${parent.component}:${span.component}`;
      if (!observed.has(key)) observed.set(key, { from: parent.component, to: span.component, evidence: 'recorded parent-span relationship', calls: 0 });
      observed.get(key).calls++;
    }
  }
  const start = Math.min(...spans.map((s) => s.startMs));
  const end = Math.max(...spans.map((s) => s.startMs + s.durationMs));
  const tokensIn = spans.reduce((sum, s) => sum + s.tokensIn, 0), tokensOut = spans.reduce((sum, s) => sum + s.tokensOut, 0);
  const failureCount = spans.filter((s) => s.success === false).length;
  const completeWarnings = [...new Set(warnings)];
  return { traceId: spans[0]?.traceId || '', start: spans.length ? new Date(start).toISOString() : null,
    durationMs: spans.length ? end - start : 0, failureCount,
    status: failureCount ? 'failed' : completeWarnings.length || spans.some((s) => s.success === null) ? 'unknown' : 'no-failure-observed',
    tokensIn, tokensOut, estimatedCost: workspace.pricing.inputPerMillion || workspace.pricing.outputPerMillion
      ? (tokensIn * workspace.pricing.inputPerMillion + tokensOut * workspace.pricing.outputPerMillion) / 1000000 : null,
    costNote: 'Estimate from observed chat tokens and configured blended prices, not an Azure bill. Missing spans and non-token charges are excluded.',
    workflowRunIds: [...new Set(spans.map((s) => s.workflowRunId).filter(Boolean))],
    durableInstanceIds: [...new Set(spans.map((s) => s.durableInstanceId).filter(Boolean))],
    versions: [...new Set(spans.flatMap((s) => [s.version, s.revision]).filter(Boolean))],
    components: [...new Set(spans.map((s) => s.component).filter(Boolean))],
    spans: spans.map(({ startMs, ...s }) => ({ ...s, offsetMs: spans.length ? startMs - start : 0 })),
    declared: workspace.edges.map((e) => ({ ...e, evidence: 'declared definition', version: workspace.version })),
    observed: [...observed.values()], warnings: completeWarnings,
    completeness: 'Not guaranteed: ingestion lag, sampling, time-window boundaries and uninstrumented services can hide spans. Duration is observed coverage, not necessarily business-run latency.' };
}
function exportRun(run) {
  const ids = new Map(run.spans.map((s, i) => [s.id, `span-${i + 1}`]));
  const components = new Map(run.components.map((id, i) => [id, `component-${i + 1}`]));
  return { schemaVersion: 1, redaction: 'Allowlisted, pseudonymized metadata only. No names, timestamps, prompts, outputs, logs, annotations, resource IDs or raw attributes. Review before sharing.',
    durationMs: run.durationMs, failureCount: run.failureCount, tokensIn: run.tokensIn, tokensOut: run.tokensOut,
    completeness: run.completeness,
    spans: run.spans.map((s) => ({ id: ids.get(s.id), parent: ids.get(s.parent) || (s.parent ? 'outside-export' : ''),
      component: components.get(s.component) || 'unregistered', kind: ['chat', 'invoke_agent', 'execute_tool', 'request', 'dependency'].includes(s.kind) ? s.kind : 'span',
      offsetMs: s.offsetMs, durationMs: s.durationMs, success: s.success, tokensIn: s.tokensIn, tokensOut: s.tokensOut, sampled: s.sampled })),
    observed: run.observed.map((e) => ({ from: components.get(e.from), to: components.get(e.to), calls: e.calls, evidence: e.evidence })) };
}
function createDistributed(queryApp) {
  async function collect(workspace, days, traceId) {
    const results = await Promise.all(workspace.sources.map(async (source) => {
      try {
        const rows = await queryApp(source.appId, queryText(workspace, source, days, traceId));
        if (!Array.isArray(rows)) throw new Error('Telemetry source returned an invalid result.');
        return { id: source.id, name: source.name, status: 'ok', rows, truncated: rows.length > LIMIT };
      } catch (e) { return { id: source.id, name: source.name, status: 'error', error: e.message, rows: [] }; }
    }));
    const data = normalize(results, workspace);
    return { ...data, sources: results.map(({ rows, ...r }) => ({ ...r, spans: Math.min(rows.length, LIMIT),
      lastSeen: rows.reduce((latest, row) => Date.parse(row.timestamp) > Date.parse(latest || '1970-01-01') ? row.timestamp : latest, null) })) };
  }
  return {
    async runs(workspace, daysInput) {
      const days = daysValue(daysInput), data = await collect(workspace, days);
      const groups = new Map();
      for (const span of data.spans) { if (!groups.has(span.traceId)) groups.set(span.traceId, []); groups.get(span.traceId).push(span); }
      const runs = [...groups.values()].map((spans) => {
        const run = reconstruct(spans, workspace, data.warnings);
        delete run.spans; delete run.declared; delete run.observed;
        return run;
      }).sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
      const durations = runs.map((r) => r.durationMs).sort((a, b) => a - b), failures = runs.filter((r) => r.failureCount).length;
      const p95Ms = durations.length ? durations[Math.ceil(durations.length * 0.95) - 1] : 0;
      const errorRate = runs.length ? failures / runs.length : 0;
      return { days, sources: data.sources, warnings: data.warnings, runs,
        summary: { runs: runs.length, failures, errorRate, p95Ms, scope: 'Bounded observed traces, not complete population statistics.',
          tokensIn: runs.reduce((sum, r) => sum + r.tokensIn, 0), tokensOut: runs.reduce((sum, r) => sum + r.tokensOut, 0),
          signals: [p95Ms > workspace.thresholds.latencyMs ? 'Observed p95 exceeds the configured latency threshold.' : '',
            errorRate > workspace.thresholds.errorRate ? 'Observed failure rate exceeds the configured threshold.' : ''].filter(Boolean) } };
    },
    async run(workspace, traceId, daysInput) {
      if (!TRACE.test(traceId || '')) throw Object.assign(new Error('Trace ID must contain 32 hexadecimal characters.'), { status: 400 });
      const data = await collect(workspace, daysValue(daysInput), traceId.toLowerCase());
      if (!data.spans.length && !data.warnings.length) throw Object.assign(new Error('Trace not found in the configured sources and time window.'), { status: 404 });
      return { ...reconstruct(data.spans, workspace, data.warnings), traceId: traceId.toLowerCase(), sources: data.sources };
    },
  };
}
module.exports = { createDistributed, reconstruct, normalize, exportRun, queryText };
