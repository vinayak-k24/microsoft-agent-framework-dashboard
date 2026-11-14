const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TRACE = /^[a-f0-9]{32}$/i;
const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
function text(value, label, max = 200, optional = false) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) fail(`Invalid ${label}.`);
  return value.trim();
}
function identifier(value, label) { if (!ID.test(value || '')) fail(`Invalid ${label}: use lowercase letters, numbers and hyphens.`); return value; }
function list(value, label, max) { if (!Array.isArray(value) || value.length > max) fail(`${label} must be an array with at most ${max} entries.`); return value; }
function unique(items, field, label) { if (new Set(items.map((x) => x[field])).size !== items.length) fail(`Duplicate ${label}.`); }
function link(value) {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { fail('Repository URL must be an HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('Repository URL must be HTTPS without credentials, query or fragment.');
  return text(value, 'repository URL', 500);
}
function validateWorkspace(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid workspace.');
  const sources = list(value.sources, 'Sources', 8).map((s) => {
    if (!s || !GUID.test(s.appId || '')) fail('Each source needs an Application Insights App ID (GUID), not a connection string.');
    return { id: identifier(s.id, 'source ID'), name: text(s.name, 'source name'), appId: s.appId.toLowerCase() };
  });
  if (!sources.length) fail('Add at least one telemetry source.');
  unique(sources, 'id', 'source ID'); unique(sources, 'appId', 'Application Insights App ID');
  const components = list(value.components, 'Components', 40).map((c) => {
    if (!c || !['functions', 'durable-functions', 'container-app', 'foundry', 'tool', 'other'].includes(c.kind)) fail('Invalid component kind.');
    if (!sources.some((s) => s.id === c.source)) fail('Component source must reference a configured source.');
    const resourceId = text(c.resourceId, 'resource ID', 1000, true);
    if (resourceId && !/^\/subscriptions\/[a-f0-9-]+\/resourceGroups\/[^/]+\/providers\/[\w.]+\/.+/i.test(resourceId)) fail('Invalid Azure resource ID.');
    return { id: identifier(c.id, 'component ID'), name: text(c.name, 'component name'), kind: c.kind,
      source: c.source, role: text(c.role, 'telemetry service role'), resourceId,
      owner: text(c.owner, 'owner', 200, true), repository: link(c.repository), version: text(c.version, 'version', 100, true) };
  });
  if (!components.length) fail('Add at least one component and its exact cloud_RoleName.');
  unique(components, 'id', 'component ID');
  if (new Set(components.map((c) => `${c.source}:${c.role}`)).size !== components.length) fail('A source/service role can belong to only one component.');
  const edges = list(value.edges || [], 'Edges', 80).map((e) => {
    if (!e || !components.some((c) => c.id === e.from) || !components.some((c) => c.id === e.to) || e.from === e.to) fail('Edge endpoints must reference different components.');
    if (!['http', 'queue', 'other'].includes(e.transport)) fail('Invalid edge transport.');
    return { from: e.from, to: e.to, transport: e.transport };
  });
  const thresholds = value.thresholds || {};
  const number = (n, label, max) => { if (!Number.isFinite(n) || n < 0 || n > max) fail(`Invalid ${label}.`); return n; };
  return { id: identifier(value.id, 'workspace ID'), name: text(value.name, 'workspace name'),
    version: text(value.version, 'definition version', 100, true), sources, components, edges,
    thresholds: { latencyMs: number(thresholds.latencyMs ?? 30000, 'latency threshold', 86400000),
      errorRate: number(thresholds.errorRate ?? 0.05, 'error rate threshold', 1) },
    pricing: { inputPerMillion: number(value.pricing?.inputPerMillion ?? 0, 'input token price', 100000),
      outputPerMillion: number(value.pricing?.outputPerMillion ?? 0, 'output token price', 100000) } };
}
function validateNote(value) {
  if (!value || !TRACE.test(value.traceId || '')) fail('Invalid note trace ID.');
  if (value.score !== null && (!Number.isFinite(value.score) || value.score < 0 || value.score > 5)) fail('Evaluation score must be null or between 0 and 5.');
  return { traceId: value.traceId.toLowerCase(), author: text(value.author, 'reviewer', 100),
    text: text(value.text, 'annotation', 2000), score: value.score, createdAt: new Date().toISOString() };
}
function validateRegistry(value) {
  const result = list(value, 'Workspaces', 8).map((w) => ({ ...validateWorkspace(w),
    notes: list(w.notes || [], 'Annotations', 100).map((n) => ({ ...validateNote(n), createdAt: text(n.createdAt, 'annotation timestamp', 50) })) }));
  unique(result, 'id', 'workspace ID');
  return result;
}
module.exports = { validateWorkspace, validateRegistry, validateNote, TRACE, GUID };
