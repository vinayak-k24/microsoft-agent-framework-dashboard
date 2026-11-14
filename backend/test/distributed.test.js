const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigStore } = require('../config');
const { createServer } = require('../server');
const { validateWorkspace } = require('../workspaces');
const { createDistributed, reconstruct, normalize, exportRun, queryText } = require('../distributed');

const traceId = 'a'.repeat(32);
const definition = { id: 'support', name: 'Customer support', version: 'v1',
  sources: [{ id: 'functions', name: 'Functions telemetry', appId: '11111111-1111-1111-1111-111111111111' },
    { id: 'agents', name: 'Agents telemetry', appId: '22222222-2222-2222-2222-222222222222' }],
  components: [{ id: 'orchestrator', name: 'Workflow', kind: 'functions', source: 'functions', role: 'workflow-api', owner: 'Team A' },
    { id: 'agent-a', name: 'Agent A', kind: 'container-app', source: 'agents', role: 'agent-a' },
    { id: 'agent-b', name: 'Agent B', kind: 'foundry', source: 'agents', role: 'agent-b' }],
  edges: [{ from: 'orchestrator', to: 'agent-a', transport: 'http' }, { from: 'orchestrator', to: 'agent-b', transport: 'http' }],
  pricing: { inputPerMillion: 2, outputPerMillion: 6 }, thresholds: { latencyMs: 500, errorRate: 0.1 } };
const workspace = validateWorkspace(definition);
function span(id, parent, role, ms, durationMs, extra = {}) {
  return { traceId, id, parent, role, timestamp: new Date(Date.UTC(2026, 10, 14) + ms).toISOString(), durationMs,
    name: `operation ${role}`, itemType: 'request', success: true, ...extra };
}
const rows = [span('1'.repeat(16), '', 'workflow-api', 0, 1000),
  span('2'.repeat(16), '1'.repeat(16), 'agent-a', 100, 600),
  span('3'.repeat(16), '1'.repeat(16), 'agent-b', 100, 800),
  span('4'.repeat(16), '2'.repeat(16), 'agent-a', 200, 100, { operation: 'chat', tokensIn: 100, tokensOut: 50, version: 'v2' })];
function results() { return [{ id: 'functions', name: 'Functions', status: 'ok', rows: [rows[0]] }, { id: 'agents', name: 'Agents', status: 'ok', rows: rows.slice(1) }]; }

test('cross-source fan-out uses recorded parent relationships and preserves concurrency without invented handoffs', () => {
  const normalized = normalize(results(), workspace);
  const run = reconstruct(normalized.spans, workspace, normalized.warnings);
  assert.equal(run.durationMs, 1000);
  assert.equal(run.spans[1].offsetMs, run.spans[2].offsetMs);
  assert.deepEqual(run.observed.map(({ from, to }) => ({ from, to })), [{ from: 'orchestrator', to: 'agent-a' }, { from: 'orchestrator', to: 'agent-b' }]);
  assert.ok(!run.observed.some((e) => e.from === 'agent-a' && e.to === 'agent-b'));
  assert.equal(run.tokensIn, 100); assert.equal(run.tokensOut, 50);
  assert.equal(run.estimatedCost, 0.0005);
  assert.deepEqual(run.versions, ['v2']);
});

test('duplicates are merged; sampling, orphan parents, cycles and failed sources remain explicit', () => {
  const r = results();
  r[1].rows.push({ ...rows[3], sampleCount: 2, success: false });
  r.push({ id: 'unavailable', name: 'Unavailable', status: 'error', error: 'Forbidden' });
  const n = normalize(r, workspace);
  assert.equal(n.spans.length, 4);
  assert.equal(n.spans.reduce((sum, s) => sum + s.tokensIn, 0), 100);
  const merged = reconstruct(n.spans, workspace, n.warnings);
  assert.equal(merged.failureCount, 1);
  assert.match(merged.warnings.join(' '), /Sampling/);
  assert.match(merged.warnings.join(' '), /Conflicting copies/);
  const orphan = normalize([{ ...r[1], rows: [span('5'.repeat(16), '6'.repeat(16), 'agent-a', 0, 1, { sampleCount: 3 })] }], workspace);
  const run = reconstruct(orphan.spans, workspace, n.warnings);
  assert.equal(run.status, 'unknown');
  assert.match(run.warnings.join(' '), /Forbidden/);
  assert.match(run.warnings.join(' '), /Missing parent/);
  assert.match(run.warnings.join(' '), /Sampling/);
  const cycle = normalize([{ ...r[1], rows: [span('5'.repeat(16), '6'.repeat(16), 'agent-a', 0, 1), span('6'.repeat(16), '5'.repeat(16), 'agent-a', 0, 1)] }], workspace);
  assert.match(reconstruct(cycle.spans, workspace).warnings.join(' '), /Cyclic/);
});

test('exports allowlist and pseudonymize metadata, excluding sensitive operation names, IDs and attributes', () => {
  const r = results(); r[1].rows[0] = { ...r[1].rows[0], name: 'sensitive customer prompt', workflowRunId: 'secret-business-id', cd: { secret: 'credential' } };
  const n = normalize(r, workspace), exported = exportRun(reconstruct(n.spans, workspace));
  const serialized = JSON.stringify(exported);
  for (const secret of ['sensitive customer prompt', 'secret-business-id', 'credential', traceId, 'workflow-api', 'agent-a', rows[0].id, rows[0].timestamp]) assert.ok(!serialized.includes(secret));
  assert.equal(exported.spans[1].parent, 'span-1');
  assert.equal(exported.observed[0].from, 'component-1');
  assert.equal(exported.durationMs, 1000);
});

test('query validation, source failures and result limits do not masquerade as complete traces', async () => {
  const service = createDistributed(async (appId) => {
    if (appId === workspace.sources[0].appId) throw new Error('Permission denied');
    return [rows[1], rows[2], rows[3]];
  });
  const result = await service.runs(workspace, 7);
  assert.equal(result.sources[0].status, 'error');
  assert.equal(result.runs[0].status, 'unknown');
  assert.match(result.warnings.join(' '), /Permission denied/);
  assert.ok(result.summary.signals.length);
  await assert.rejects(service.run(workspace, "a' or true", 7), /Trace ID/);
  await assert.rejects(service.runs(workspace, 365), /Time window/);
  const limited = await createDistributed(async () => Array(1001).fill(rows[0])).runs(workspace, 7);
  assert.ok(limited.sources.every((s) => s.truncated));
  assert.match(limited.warnings.join(' '), /reached 1000/);
  const q = queryText({ ...workspace, components: [{ ...workspace.components[0], role: "role'\\name" }] }, workspace.sources[0], 7);
  assert.ok(q.includes("role\\'\\\\name"));
  assert.ok(!q.includes('tostring(customDimensions)'));
});

test('workspace definitions and annotations persist independently of legacy Foundry configuration; invalid changes are atomic', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-store-'));
  try {
    const store = new ConfigStore(directory), settings = store.read().settings;
    store.saveWorkspace(definition);
    store.addNote('support', { traceId, author: 'Reviewer', text: 'Check repository issue 42', score: 4.5 });
    assert.deepEqual(store.read().settings, settings);
    assert.equal(new ConfigStore(directory).workspaces()[0].notes[0].score, 4.5);
    assert.throws(() => store.saveWorkspace({ ...definition, sources: [{ ...definition.sources[0], appId: 'connection-string' }] }), /App ID/);
    assert.throws(() => store.saveWorkspace({ ...definition, edges: [{ from: 'orchestrator', to: 'missing', transport: 'http' }] }), /endpoints/);
    assert.throws(() => store.saveWorkspace({ ...definition, components: definition.components.map((c) => ({ ...c, repository: 'https://user:password@example.com' })) }), /credentials/);
    assert.throws(() => store.addNote('support', { traceId, author: 'Reviewer', text: 'Bad score', score: 6 }), /score/);
    assert.equal(store.workspaces()[0].notes.length, 1);
    store.saveWorkspace({ ...definition, version: 'v2' });
    assert.equal(store.workspaces()[0].notes.length, 1);
    store.deleteWorkspace('support');
    assert.deepEqual(new ConfigStore(directory).workspaces(), []);
    assert.deepEqual(new ConfigStore(directory).read().settings, settings);
  } finally {
    for (const file of ['config.json', 'config.json.tmp']) { const name = path.join(directory, file); if (fs.existsSync(name)) fs.unlinkSync(name); }
    fs.rmdirSync(directory);
  }
});

test('workspace HTTP routes work without a selected Foundry project or local login and enforce mutation guards', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-http-'));
  const server = createServer({ dataDir: directory, azure: {}, foundry: {
    forConfig() { return {}; }, listResources: async () => [{ name: 'functions', type: 'microsoft.web/sites' }],
    queryApp: async (appId) => appId === workspace.sources[0].appId ? [rows[0]] : rows.slice(1),
  } });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    for (const file of ['config.json', 'config.json.tmp']) { const name = path.join(directory, file); if (fs.existsSync(name)) fs.unlinkSync(name); }
    fs.rmdirSync(directory);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const mutate = (route, body, method = 'POST') => fetch(base + route, { method, headers: { 'X-Dashboard-Request': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await mutate('/api/workspaces', definition)).status, 200);
  assert.equal((await fetch(base + '/api/workspaces/support/runs?days=7')).status, 200);
  const run = await (await fetch(base + `/api/workspaces/support/run?id=${traceId}&days=7`)).json();
  assert.equal(run.observed.length, 2);
  const exported = await (await fetch(base + `/api/workspaces/support/export?id=${traceId}`)).json();
  assert.equal(exported.schemaVersion, 1);
  assert.equal((await mutate('/api/workspaces/support/notes', { traceId, author: 'A', text: 'Review', score: null })).status, 200);
  assert.equal((await fetch(base + '/api/workspaces/support', { method: 'DELETE' })).status, 403);
  assert.equal((await fetch(base + '/workspaces.js')).status, 200);
  assert.equal((await mutate('/api/workspaces/support', undefined, 'DELETE')).status, 200);
  assert.equal((await fetch(base + '/api/workspaces/support/runs')).status, 404);
});
