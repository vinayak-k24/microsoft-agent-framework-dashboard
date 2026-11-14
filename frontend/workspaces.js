const W = { entries: [], id: '', data: null, run: null, compare: null, resources: null, draft: null, error: '', busy: false, search: '', status: 'all', cursor: 0, request: 0, updatedAt: null };
let workspaceTimer;
function workspaceCurrent() { return W.entries.find((w) => w.id === W.id); }
function workspaceNextId(items, prefix) {
  let n = 1;
  while (items.some((item) => item.id === `${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}
function workspaceUrl(traceId = '') {
  const url = new URL(location.href);
  url.searchParams.set('view', 'distributed'); url.searchParams.set('workspace', W.id);
  if (traceId) url.searchParams.set('trace', traceId); else url.searchParams.delete('trace');
  history.replaceState(null, '', url);
}
async function workspaceReload() {
  const request = ++W.request;
  clearInterval(workspaceTimer); W.error = ''; W.busy = true; W.data = null; render();
  try {
    const entries = await api('/api/workspaces');
    if (request !== W.request) return;
    W.entries = entries;
    if (W.id && !workspaceCurrent()) throw new Error('Workspace not found locally. Import its definition or select another workspace.');
    if (!W.id) W.id = W.entries[0]?.id || '';
    const data = W.id ? await api(`/api/workspaces/${W.id}/runs?days=${S.days}`) : null;
    if (request !== W.request) return;
    W.data = data; W.updatedAt = new Date().toISOString();
    if (W.run && W.run.workspaceId !== W.id) { W.run = null; W.compare = null; }
    const trace = new URLSearchParams(location.search).get('trace');
    if (trace && W.id) {
      const run = await api(`/api/workspaces/${W.id}/run?id=${encodeURIComponent(trace)}&days=${S.days}`);
      if (request !== W.request) return;
      W.run = { ...run, workspaceId: W.id };
    }
    else W.run = null;
  } catch (e) { if (request === W.request) W.error = e.message; }
  finally { if (request === W.request) { W.busy = false; render(); } }
}
async function workspaceOpen(traceId, compare = false) {
  const request = ++W.request, id = W.id;
  clearInterval(workspaceTimer); W.error = ''; W.busy = true; render();
  try {
    const run = { ...await api(`/api/workspaces/${id}/run?id=${encodeURIComponent(traceId)}&days=${S.days}`), workspaceId: id };
    if (request !== W.request) return;
    if (compare) W.compare = run;
    else { W.run = run; if (W.compare?.traceId === traceId) W.compare = null; W.cursor = 0; workspaceUrl(traceId); }
  } catch (e) { if (request === W.request) W.error = e.message; }
  finally { if (request === W.request) { W.busy = false; render(); } }
}
function workspaceDraft() {
  const appId = S.cfg.appInsights?.appId || '';
  W.draft = { id: '', name: '', version: '', sources: [{ id: 'source-1', name: 'Application Insights', appId }],
    components: [{ id: 'service-1', name: 'Orchestrator', source: 'source-1', kind: 'functions', role: '', owner: '', repository: '', version: '', resourceId: '' }],
    edges: [], thresholds: { latencyMs: 30000, errorRate: 0.05 }, pricing: { inputPerMillion: 0, outputPerMillion: 0 } };
}
const workspaceOptions = (items, selected) => items.map((item) => `<option value="${esc(item.id)}" ${item.id === selected ? 'selected' : ''}>${esc(item.name || item.id)}</option>`).join('');
function workspaceEditor() {
  const d = W.draft;
  const input = (value, field, max = 200, type = 'text') => `<input data-field="${field}" type="${type}" maxlength="${max}" value="${esc(value)}" ${type === 'number' ? 'min="0" step="any"' : ''}>`;
  return `<section class="card ws-section"><h2>${d.id && workspaceCurrent()?.id === d.id ? 'Edit' : 'Create'} solution workspace</h2>
    <p class="sub">This is an explicit grouping, not an Azure deployment. Keep source IDs stable. Service role must exactly match telemetry cloud_RoleName; resource names are only suggestions.</p>
    <form id="ws-form"><div class="selbar"><label>Workspace ID${input(d.id, 'id', 64)}</label><label>Name${input(d.name, 'name')}</label><label>Definition version${input(d.version, 'version', 100)}</label></div>
    <h3>Telemetry sources</h3><div class="ws-scroll"><table><thead><tr><th>Source ID</th><th>Name</th><th>Application Insights App ID</th><th></th></tr></thead><tbody>${d.sources.map((s, i) => `<tr data-source="${i}"><td>${input(s.id, 'id', 64)}</td><td>${input(s.name, 'name')}</td><td>${input(s.appId, 'appId', 36)}</td><td><button type="button" class="btn ghost" data-remove-source="${i}">Remove</button></td></tr>`).join('')}</tbody></table></div>
    <button type="button" class="btn ghost" id="ws-add-source">Add source</button>
    <h3>Components and ownership</h3><div class="ws-component-grid">${d.components.map((c, i) => `<fieldset data-component="${i}"><legend>Component ${i + 1}</legend>
      <label>ID${input(c.id, 'id', 64)}</label><label>Name${input(c.name, 'name')}</label><label>Hosting<select data-field="kind">${['functions', 'durable-functions', 'container-app', 'foundry', 'tool', 'other'].map((kind) => `<option ${kind === c.kind ? 'selected' : ''}>${kind}</option>`).join('')}</select></label>
      <label>Source<select data-field="source">${workspaceOptions(d.sources, c.source)}</select></label><label>Exact service role${input(c.role, 'role')}</label><label>Owner${input(c.owner || '', 'owner')}</label><label>Repository (HTTPS)${input(c.repository || '', 'repository', 500)}</label><label>Declared deployment version${input(c.version || '', 'version', 100)}</label><label>Resource ID (optional)${input(c.resourceId || '', 'resourceId', 1000)}</label><button type="button" class="btn ghost" data-remove-component="${i}">Remove component</button></fieldset>`).join('')}</div>
    <button type="button" class="btn ghost" id="ws-add-component">Add component</button>
    <h3>Declared connections</h3><p class="sub">Definitions do not prove that an edge executed. Recorded parent-span relationships appear separately.</p>
    ${d.edges.map((e, i) => `<div class="selbar" data-edge="${i}"><label>From<select data-field="from">${workspaceOptions(d.components, e.from)}</select></label><label>To<select data-field="to">${workspaceOptions(d.components, e.to)}</select></label><label>Transport<select data-field="transport">${['http', 'queue', 'other'].map((t) => `<option ${t === e.transport ? 'selected' : ''}>${t}</option>`).join('')}</select></label><button type="button" class="btn ghost" data-remove-edge="${i}">Remove</button></div>`).join('')}
    <button type="button" class="btn ghost" id="ws-add-edge">Add connection</button>
    <h3>Local signals and optional cost estimates</h3><div class="selbar"><label>Observed p95 threshold (ms)${input(d.thresholds.latencyMs, 'latencyMs', 20, 'number')}</label><label>Failure-rate threshold (0-1)${input(d.thresholds.errorRate, 'errorRate', 20, 'number')}</label><label>Input price / million tokens${input(d.pricing.inputPerMillion, 'inputPerMillion', 20, 'number')}</label><label>Output price / million tokens${input(d.pricing.outputPerMillion, 'outputPerMillion', 20, 'number')}</label></div>
    <p class="sub">Use one consistent currency and blended model rates. Zero disables estimates. These are local indicators, not Azure alerts or billing data.</p>
    <button type="submit" class="btn">Save workspace</button> <button type="button" class="btn ghost" id="ws-cancel">Cancel</button></form>
    <details><summary>Import a versioned definition from another repository</summary><p class="sub">Paste a workspace JSON definition. It replaces the editor draft; saving is explicit. Never paste credentials or prompts.</p><textarea id="ws-import-json" aria-label="Workspace JSON definition" rows="8"></textarea><button class="btn ghost" id="ws-import">Load into editor</button></details></section>`;
}
function workspaceTopology(workspace, run) {
  const points = new Map(workspace.components.map((c, i) => [c.id, { x: 25 + i % 3 * 250, y: 30 + Math.floor(i / 3) * 110 }]));
  const height = Math.max(150, Math.ceil(workspace.components.length / 3) * 110 + 30);
  const edge = (e, observed) => {
    const a = points.get(e.from), b = points.get(e.to);
    if (!a || !b) return '';
    return `<line x1="${a.x + 110}" y1="${a.y + 28}" x2="${b.x + 110}" y2="${b.y + 28}" class="${observed ? 'ws-observed' : 'ws-declared'}" marker-end="url(#ws-arrow)"><title>${esc(e.from)} to ${esc(e.to)}: ${observed ? e.evidence : 'declared ' + e.transport}</title></line>`;
  };
  return `<div class="ws-scroll"><svg class="ws-map" viewBox="0 0 780 ${height}" role="img" aria-label="Declared service topology with recorded parent-span connections overlaid"><defs><marker id="ws-arrow" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="#1a6cf0"/></marker></defs>
    ${workspace.edges.map((e) => edge(e, false)).join('')}${(run?.observed || []).map((e) => edge(e, true)).join('')}
    ${workspace.components.map((c) => { const p = points.get(c.id); return `<g data-map-component="${esc(c.id)}"><rect x="${p.x}" y="${p.y}" width="220" height="65" rx="9"/><text x="${p.x + 10}" y="${p.y + 22}">${esc(c.name.slice(0, 27))}</text><text x="${p.x + 10}" y="${p.y + 44}" class="ws-map-sub">${esc(c.kind)}</text><title>${esc(c.role)} | ${esc(c.owner || 'No owner')} | ${esc(c.version || 'No declared version')}</title></g>`; }).join('')}</svg></div>
    <p class="sub">Dashed gray: declared connections. Solid blue: recorded parent-span relationships; no time-based guesses. Hover for ownership. ${esc(workspace.version ? 'Definition ' + workspace.version : 'Definition unversioned')}.</p>
    <div class="ws-scroll"><table><thead><tr><th>Component</th><th>Owner</th><th>Source / exact role</th><th>Declared version</th><th>Repository</th></tr></thead><tbody>${workspace.components.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.owner || 'Not set')}</td><td>${esc(c.source)} / ${esc(c.role)}</td><td>${esc(c.version || 'Not set')}</td><td>${c.repository ? `<a href="${esc(c.repository)}" target="_blank" rel="noopener noreferrer">Source repository</a>` : 'Not set'}</td></tr>`).join('')}</tbody></table></div>`;
}
function workspaceRunView(workspace) {
  const run = W.run; if (!run) return '';
  const total = Math.max(run.durationMs, 1);
  const note = workspace.notes.filter((n) => n.traceId === run.traceId);
  const compare = W.compare;
  return `<section class="card ws-section"><h2>End-to-end trace ${esc(run.traceId)}</h2><p class="sub">${esc(run.completeness)}</p>
    <p>Observed coverage ${fmtS(run.durationMs)} · ${run.failureCount} failed spans · ${run.tokensIn} input / ${run.tokensOut} output tokens · Estimated cost: ${run.estimatedCost === null ? 'Disabled' : run.estimatedCost.toFixed(6) + ' (configured currency)'}</p><p class="sub">${esc(run.costNote)}</p>
    ${run.warnings.length ? `<ul role="status" class="error">${run.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <div class="selbar"><button class="btn ghost" id="ws-export">Download redacted trace</button><button class="btn ghost" id="ws-link">Copy local deep link</button><label>Compare trace<select id="ws-compare"><option value="">Choose another trace</option>${(W.data?.runs || []).filter((r) => r.traceId !== run.traceId).map((r) => `<option value="${r.traceId}" ${compare?.traceId === r.traceId ? 'selected' : ''}>${r.traceId.slice(0, 12)} / ${esc(r.versions.join(', ') || 'version unknown')}</option>`).join('')}</select></label></div>
    <p class="sub">Export excludes prompts, output, logs, annotations, names and raw attributes; identifiers are pseudonymized. Review before sharing. Deep links work only with the recipient's matching local workspace and Azure permissions.</p>
    ${compare ? `<table><thead><tr><th>Observed metric</th><th>Selected</th><th>Comparison</th></tr></thead><tbody>${[['Coverage duration', fmtS(run.durationMs), fmtS(compare.durationMs)], ['Failed spans', run.failureCount, compare.failureCount], ['Input / output tokens', `${run.tokensIn} / ${run.tokensOut}`, `${compare.tokensIn} / ${compare.tokensOut}`], ['Recorded versions', run.versions.join(', ') || 'Unknown', compare.versions.join(', ') || 'Unknown'], ['Estimated cost (configured currency)', run.estimatedCost === null ? 'Disabled' : run.estimatedCost.toFixed(6), compare.estimatedCost === null ? 'Disabled' : compare.estimatedCost.toFixed(6)]].map(([key, a, b]) => `<tr><td>${key}</td><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</tbody></table><p class="sub">${esc(run.costNote)} Comparison completeness is also not guaranteed. ${esc(compare.warnings.join(' '))}</p>` : ''}
    <p>Business run IDs: ${esc(run.workflowRunIds.join(', ') || 'Not recorded')} · Durable instance IDs: ${esc(run.durableInstanceIds.join(', ') || 'Not recorded')} · Observed deployment versions: ${esc(run.versions.join(', ') || 'Not recorded')}</p>
    <div class="selbar"><button class="btn ghost" id="ws-play">Play observed timeline</button><label>Recorded time <output id="ws-clock">${fmtS(W.cursor)}</output><input id="ws-cursor" type="range" min="0" max="${total}" value="${Math.min(W.cursor, total)}" step="1" aria-label="Observed trace time"></label></div>
    <p class="sub">Concurrent spans remain concurrent. Playback only highlights recorded intervals; it never invokes a service. Each row is a span in its service lane; retries appear only when recorded.</p>
    <div class="ws-scroll"><table class="ws-waterfall"><thead><tr><th>Service lane / span</th><th>Recorded interval</th><th>Status / retry / tokens</th></tr></thead><tbody>${run.spans.map((s) => `<tr data-ws-span="${esc(s.id)}" data-start="${s.offsetMs}" data-end="${s.offsetMs + s.durationMs}" data-component="${esc(s.component)}"><td><b>${esc(s.role || 'Unregistered')}</b><br>${esc(s.name)}<details><summary>Span IDs and provenance</summary><span class="mono">${esc(s.id)}<br>Parent ${esc(s.parent || '(root)')}<br>Sources ${esc(s.sources.join(', '))}</span></details></td><td><div class="ws-bar-track"><div class="ws-bar ${s.success === false ? 'failed' : ''}" style="margin-left:${s.offsetMs / total * 100}%;width:${Math.max(s.durationMs / total * 100, 0.3)}%"></div></div>${fmtS(s.offsetMs)} + ${fmtS(s.durationMs)}</td><td>${s.success === null ? 'Unknown' : s.success ? 'No failure observed' : 'Failed'}${s.retryAttempt ? '<br>Retry attempt ' + esc(s.retryAttempt) : ''}<br>${s.tokensIn} in / ${s.tokensOut} out</td></tr>`).join('')}</tbody></table></div>
    <h3>Local investigation and evaluation</h3><p class="sub">Annotations persist locally and are not included in exports. Reviewer names are self-entered, not authenticated. Do not enter sensitive prompts or credentials.</p>
    ${note.map((n) => `<div class="ws-note"><b>${esc(n.author)}</b> · ${esc(fmtDT(n.createdAt))} · ${n.score === null ? 'No score' : esc(n.score) + '/5'}<p>${esc(n.text)}</p></div>`).join('') || '<p class="sub">No annotations for this trace.</p>'}
    <form id="ws-note" class="selbar"><label>Reviewer<input id="ws-author" required maxlength="100"></label><label>Quality score (optional, 0-5)<input id="ws-score" type="number" min="0" max="5" step="0.1"></label><label>Investigation / issue reference<input id="ws-note-text" required maxlength="2000"></label><button class="btn" type="submit">Save annotation</button></form></section>`;
}
function vWorkspaces() {
  const workspace = workspaceCurrent();
  const runs = (W.data?.runs || []).filter((r) => (W.status === 'all' || r.status === W.status) && [r.traceId, ...r.versions, ...r.workflowRunIds, ...r.components].join(' ').toLowerCase().includes(W.search.toLowerCase()));
  return `<section class="card"><h2>Distributed solution workspaces</h2><p class="sub">Read-only Functions, Container Apps, Foundry and tool telemetry across Application Insights sources. Your existing single-hosted-agent views and selected Foundry project are unchanged.</p>
    <div class="selbar"><label>Workspace<select id="ws-select"><option value="">Choose workspace</option>${workspaceOptions(W.entries, W.id)}</select></label><button class="btn" id="ws-new">Create workspace</button>${workspace ? '<button class="btn ghost" id="ws-edit">Edit definition</button><button class="btn ghost" id="ws-delete">Delete workspace</button>' : ''}<button class="btn ghost" id="ws-discover">Discover Azure resources</button></div>
    ${W.busy ? '<p role="status">Loading configured telemetry sources...</p>' : ''}${W.error ? `<p role="alert" class="error">${esc(W.error)}</p>` : ''}
    ${W.resources ? `<details open><summary>Discoverable Azure resources (${W.resources.length})</summary><p class="sub">Discovery does not establish membership or telemetry correlation. Use a resource to populate the editor, then check its source and exact role.</p><div class="ws-scroll"><table><thead><tr><th>Name</th><th>Type / region</th><th>Resource group</th><th></th></tr></thead><tbody>${W.resources.map((r, i) => `<tr><td>${esc(r.name)}</td><td>${esc(r.type)} / ${esc(r.location)}</td><td>${esc(r.resourceGroup)}</td><td><button class="btn ghost" data-use-resource="${i}">Add to editor</button></td></tr>`).join('')}</tbody></table></div></details>` : ''}</section>
    ${W.draft ? workspaceEditor() : ''}
    ${workspace ? `<section class="card ws-section"><h2>Designed and observed topology</h2>${workspaceTopology(workspace, W.run)}</section>` : '<section class="card ws-section"><h2>Get connected</h2><ol><li>Sign in to Azure in Settings.</li><li>Create a workspace and add each Application Insights App ID.</li><li>Add services with their exact cloud_RoleName.</li><li>Declare connections; propagate W3C trace context between your services.</li><li>Refresh and open a trace. Missing telemetry is reported, not fabricated.</li></ol></section>'}
    ${W.data ? `<section class="card ws-section"><h2>Connectivity and observed operational signals</h2><p class="sub">Queried on demand; not real-time. Last refresh ${esc(fmtDT(W.updatedAt))}. Empty results can mean no activity, a role mismatch, missing instrumentation or ingestion delay; they do not establish health.</p><div class="ws-scroll"><table><thead><tr><th>Source</th><th>Query result</th><th>Spans</th><th>Most recent returned telemetry</th></tr></thead><tbody>${W.data.sources.map((s) => `<tr><td>${esc(s.name)}</td><td>${s.status === 'error' ? `<span class="error">${esc(s.error)} Check login, resource permissions and network.</span>` : s.truncated ? 'Query truncated' : s.spans ? 'Query succeeded' : 'No matching telemetry'}</td><td>${s.spans}</td><td>${s.lastSeen ? esc(fmtDT(s.lastSeen)) : 'Not available'}</td></tr>`).join('')}</tbody></table></div>
    <p>${W.data.summary.runs} observed traces · ${W.data.summary.failures} with failed spans · p95 coverage ${fmtS(W.data.summary.p95Ms)} · ${(W.data.summary.errorRate * 100).toFixed(1)}% observed failures · ${W.data.summary.tokensIn} input / ${W.data.summary.tokensOut} output chat tokens</p><p class="sub">${esc(W.data.summary.scope)}</p>${W.data.summary.signals.map((s) => `<p role="status" class="error">${esc(s)}</p>`).join('')}${W.data.warnings.map((s) => `<p role="status" class="error">${esc(s)}</p>`).join('')}</section>
    <section class="card ws-section"><h2>Runs and version history</h2><div class="selbar"><label>Search trace / version / business run / component<input id="ws-search" value="${esc(W.search)}"></label><label>Status<select id="ws-status">${['all', 'failed', 'unknown', 'no-failure-observed'].map((s) => `<option ${s === W.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label><form id="ws-trace-form" class="selbar"><label>Open trace by ID<input id="ws-trace-id" required pattern="[a-fA-F0-9]{32}" maxlength="32"></label><button class="btn ghost" type="submit">Open trace</button></form></div>
    <div class="ws-scroll"><table><thead><tr><th>Trace / start</th><th>Coverage duration</th><th>Status</th><th>Chat tokens</th><th>Observed versions</th><th>Quality scores</th></tr></thead><tbody>${runs.map((r) => `<tr><td><button class="btn ghost mono" data-ws-run="${r.traceId}">${r.traceId.slice(0, 14)}...</button><br>${esc(fmtDT(r.start))}</td><td>${fmtS(r.durationMs)}</td><td>${esc(r.status)}</td><td>${r.tokensIn} / ${r.tokensOut}</td><td>${esc(r.versions.join(', ') || 'Unknown')}</td><td>${esc(workspace.notes.filter((n) => n.traceId === r.traceId && n.score !== null).map((n) => n.score + '/5').join(', ') || 'Not evaluated')}</td></tr>`).join('') || '<tr><td colspan="6">No matching observed traces. Check source diagnostics and service roles.</td></tr>'}</tbody></table></div></section>` : ''}
    ${workspace ? workspaceRunView(workspace) : ''}`;
}
function workspaceReadDraft() {
  const d = W.draft, form = $('#ws-form'); if (!d || !form) return;
  for (const key of ['id', 'name', 'version']) d[key] = $(`:scope > .selbar [data-field="${key}"]`, form).value.trim();
  for (const [selector, entries] of [['[data-source]', d.sources], ['[data-component]', d.components], ['[data-edge]', d.edges]]) {
    form.querySelectorAll(selector).forEach((row, i) => row.querySelectorAll('[data-field]').forEach((input) => { entries[i][input.dataset.field] = input.value.trim(); }));
  }
  for (const key of ['latencyMs', 'errorRate']) d.thresholds[key] = Number($(`[data-field="${key}"]`, form).value);
  for (const key of ['inputPerMillion', 'outputPerMillion']) d.pricing[key] = Number($(`[data-field="${key}"]`, form).value);
}
function workspaceCursor(time) {
  W.cursor = time;
  const slider = $('#ws-cursor'); if (slider) slider.value = time;
  const clock = $('#ws-clock'); if (clock) clock.textContent = fmtS(time);
  const active = new Set();
  document.querySelectorAll('[data-ws-span]').forEach((row) => { const on = time >= Number(row.dataset.start) && time <= Number(row.dataset.end); row.classList.toggle('ws-active', on); if (on) active.add(row.dataset.component); });
  document.querySelectorAll('[data-map-component]').forEach((node) => node.classList.toggle('ws-active', active.has(node.dataset.mapComponent)));
}
function bindWorkspaces() {
  if (S.view !== 'distributed') { clearInterval(workspaceTimer); return; }
  const on = (id, fn, event = 'onclick') => { const el = $('#' + id); if (el) el[event] = fn; };
  const edit = (fn) => { workspaceReadDraft(); fn(); render(); };
  on('ws-select', (e) => { W.id = e.target.value; W.run = null; W.compare = null; W.draft = null; workspaceUrl(); workspaceReload(); }, 'onchange');
  on('ws-new', () => { workspaceDraft(); W.error = ''; render(); });
  on('ws-edit', () => { W.draft = structuredClone(workspaceCurrent()); render(); });
  on('ws-cancel', () => { W.draft = null; render(); });
  on('ws-delete', async () => {
    if (!confirm('Delete this local workspace and its annotations? Azure resources will not be changed.')) return;
    try { await api(`/api/workspaces/${W.id}`, { method: 'DELETE' }); W.id = ''; W.run = null; W.compare = null; workspaceUrl(); await workspaceReload(); }
    catch (e) { W.error = e.message; render(); }
  });
  on('ws-discover', async () => { try { W.resources = await api('/api/resources'); W.error = ''; } catch (e) { W.error = e.message; } render(); });
  document.querySelectorAll('[data-use-resource]').forEach((el) => el.onclick = () => {
    workspaceReadDraft(); if (!W.draft) workspaceDraft();
    const r = W.resources[Number(el.dataset.useResource)], d = W.draft;
    if (r.type.toLowerCase() === 'microsoft.insights/components') d.sources.push({ id: workspaceNextId(d.sources, 'source'), name: r.name, appId: r.appId || '' });
    else d.components.push({ id: workspaceNextId(d.components, 'service'), name: r.name, role: r.name, source: d.sources[0]?.id || '',
      kind: r.type.toLowerCase() === 'microsoft.app/containerapps' ? 'container-app' : r.type.toLowerCase() === 'microsoft.web/sites' ? 'functions' : 'foundry', resourceId: r.id });
    render();
  });
  on('ws-add-source', () => edit(() => W.draft.sources.push({ id: workspaceNextId(W.draft.sources, 'source'), name: '', appId: '' })));
  on('ws-add-component', () => edit(() => W.draft.components.push({ id: workspaceNextId(W.draft.components, 'service'), name: '', kind: 'container-app', source: W.draft.sources[0]?.id || '', role: '' })));
  on('ws-add-edge', () => edit(() => W.draft.edges.push({ from: W.draft.components[0]?.id || '', to: W.draft.components[1]?.id || '', transport: 'http' })));
  for (const [selector, field, attribute] of [['[data-remove-source]', 'sources', 'removeSource'], ['[data-remove-component]', 'components', 'removeComponent'], ['[data-remove-edge]', 'edges', 'removeEdge']]) {
    document.querySelectorAll(selector).forEach((el) => el.onclick = () => edit(() => W.draft[field].splice(Number(el.dataset[attribute]), 1)));
  }
  on('ws-form', async (e) => {
    e.preventDefault(); workspaceReadDraft();
    try { const saved = await api('/api/workspaces', { method: 'POST', body: JSON.stringify(W.draft) }); W.id = saved.id; W.draft = null; W.run = null; W.compare = null; workspaceUrl(); await workspaceReload(); }
    catch (error) { W.error = error.message; render(); }
  }, 'onsubmit');
  on('ws-import', () => {
    try {
      const d = JSON.parse($('#ws-import-json').value);
      if (!d || typeof d.id !== 'string' || typeof d.name !== 'string' || !Array.isArray(d.sources) || !Array.isArray(d.components) || !Array.isArray(d.edges || []) || d.sources.some((s) => !s || typeof s !== 'object') || d.components.some((c) => !c || typeof c !== 'object') || (d.edges || []).some((edge) => !edge || typeof edge !== 'object')) throw new Error('Invalid workspace definition shape.');
      W.draft = { ...d, edges: d.edges || [], thresholds: { latencyMs: 30000, errorRate: 0.05, ...d.thresholds }, pricing: { inputPerMillion: 0, outputPerMillion: 0, ...d.pricing } }; W.error = '';
    } catch (e) { W.error = e.message; }
    render();
  });
  on('ws-search', (e) => { W.search = e.target.value; render(); }, 'onchange');
  on('ws-status', (e) => { W.status = e.target.value; render(); }, 'onchange');
  on('ws-trace-form', (e) => { e.preventDefault(); workspaceOpen($('#ws-trace-id').value); }, 'onsubmit');
  document.querySelectorAll('[data-ws-run]').forEach((el) => el.onclick = () => workspaceOpen(el.dataset.wsRun));
  on('ws-compare', (e) => { if (e.target.value) workspaceOpen(e.target.value, true); else { W.compare = null; render(); } }, 'onchange');
  on('ws-cursor', (e) => { clearInterval(workspaceTimer); workspaceCursor(Number(e.target.value)); }, 'oninput');
  on('ws-play', () => {
    clearInterval(workspaceTimer); if (!W.run) return;
    if (W.cursor >= W.run.durationMs) workspaceCursor(0);
    workspaceTimer = setInterval(() => { if (S.view !== 'distributed' || !$('#ws-cursor')) { clearInterval(workspaceTimer); return; } workspaceCursor(Math.min(W.run.durationMs, W.cursor + Math.max(W.run.durationMs / 100, 1))); if (W.cursor >= W.run.durationMs) clearInterval(workspaceTimer); }, 100);
  });
  on('ws-export', async () => {
    try {
      const data = await api(`/api/workspaces/${W.id}/export?id=${W.run.traceId}&days=${S.days}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'redacted-trace.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { W.error = e.message; render(); }
  });
  on('ws-link', async () => { try { await navigator.clipboard.writeText(location.href); W.error = ''; } catch (e) { W.error = `Could not copy link: ${e.message}. Copy the browser address instead.`; } render(); });
  on('ws-note', async (e) => {
    e.preventDefault(); const score = $('#ws-score').value;
    try { await api(`/api/workspaces/${W.id}/notes`, { method: 'POST', body: JSON.stringify({ traceId: W.run.traceId, author: $('#ws-author').value, text: $('#ws-note-text').value, score: score === '' ? null : Number(score) }) }); W.entries = await api('/api/workspaces'); W.error = ''; }
    catch (error) { W.error = error.message; }
    render();
  }, 'onsubmit');
  if (W.run) workspaceCursor(Math.min(W.cursor, W.run.durationMs));
}
