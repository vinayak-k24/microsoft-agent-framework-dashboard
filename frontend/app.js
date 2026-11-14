const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let pending = 0, loadTimer = null;
function setLoading(on) {
  pending += on ? 1 : -1;
  let el = document.getElementById('loading');
  if (pending > 0 && !loadTimer && !(el && el.classList.contains('on'))) {
    loadTimer = setTimeout(() => {
      loadTimer = null;
      if (pending <= 0) return;
      if (!el) { el = document.createElement('div'); el.id = 'loading'; el.innerHTML = '<div class="ldbox"><div class="spin"></div><b>Loading from Azure…</b><span>Querying Foundry and Application Insights. This can take a few seconds.</span></div>'; document.body.appendChild(el); }
      el.classList.add('on');
    }, 250);
  } else if (pending <= 0) {
    pending = 0; clearTimeout(loadTimer); loadTimer = null;
    if (el) el.classList.remove('on');
  }
}
const api = async (p, options = {}) => {
  setLoading(true);
  try {
    const r = await fetch(p, { ...options, headers: { 'X-Dashboard-Request': '1', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    if (!r.ok) {
      throw new Error(await r.text());
    }
    return await r.json();
  } finally { setLoading(false); }
};
const fmtT = (iso) => new Date(iso).toLocaleTimeString([], { hour12: false });
const fmtDT = (iso) => new Date(iso).toLocaleString([], { hour12: false });
const fmtS = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms');

const NAV = [['overview', '🏠', 'Overview'], ['flow', '🔀', 'Agents & Workflow'], ['playback', '▶️', 'Trace Playback'], ['runs', '📈', 'Runs & History'],
  ['traces', '📋', 'Traces & Logs'], ['tools', '🧩', 'Tools & Connectors'], ['distributed', '🌐', 'Solution Workspaces'], ['settings', '⚙️', 'Settings']];
const COLORS = ['#8b3cf0', '#16a5a5', '#8b3cf0', '#16a5a5', '#8b3cf0'];

const S = { view: 'flow', cfg: null, agent: null, days: 30, summary: null, runs: [], runId: null, run: null, io: 0, raw: false, sel: 0, agents: [], wfAgents: [], runFilter: 'all', error: '' };
let azureTimer;

async function azureStatus() {
  S.azureError = '';
  try { S.azure = await api('/api/azure/status'); } catch (e) { S.azure = null; S.azureError = e.message; }
  render();
}

async function pollAzureLogin() {
  try {
    S.azureLogin = await api('/api/azure/login');
    render();
    if (S.azureLogin.status === 'pending') azureTimer = setTimeout(pollAzureLogin, 2000);
    else if (S.azureLogin.status === 'ok') { await azureStatus(); await loadProjects(true); }
  } catch (e) { S.azureError = e.message; render(); }
}

async function startAzureLogin() {
  S.azureError = '';
  try {
    S.azureLogin = await api('/api/azure/login', { method: 'POST' });
    render(); clearTimeout(azureTimer); azureTimer = setTimeout(pollAzureLogin, 1000);
  } catch (e) { S.azureError = e.message; render(); }
}

async function boot() {
  $('#side').hidden = false;
  S.cfg = await api('/api/config');
  S.agent = new URLSearchParams(location.search).get('agent') || S.cfg.defaultAgent;
  const q = new URLSearchParams(location.search);
  if (NAV.some(([v]) => v === q.get('view'))) S.view = q.get('view');
  if (!S.cfg.project && S.view !== 'distributed') S.view = 'settings';
  W.id = q.get('workspace') || '';
  if (/^[a-f0-9]{32}$/i.test(q.get('run') || '')) S.runId = q.get('run').toLowerCase();
  S.pbT = +q.get('t') || 0;
  S.pbPlay = q.get('play') === '1'; if (+q.get('speed')) PB.speed = +q.get('speed');
  S.days = S.cfg.windowDays || 30;
  render();
  if (S.view !== 'distributed') await loadProjects();
  await reload();
}

async function loadProjects(refresh) {
  S.projErr = '';
  try { S.projects = await api(`/api/projects${refresh ? '?refresh=1' : ''}`); } catch (e) { S.projErr = e.message; }
  render();
}

async function pickProject(projectId, appInsightsAppId) {
  S.error = ''; S.agent = null; S.runId = null; S.run = null; S.runs = []; S.summary = null; S.wfAgents = []; S.agents = []; S.projBusy = true; render();
  try {
    await api('/api/select', { method: 'POST', body: JSON.stringify({ projectId, appInsightsAppId }) });
    S.cfg = await api('/api/config');
    const u = new URL(location.href); u.searchParams.delete('agent'); u.searchParams.delete('run'); history.replaceState(null, '', u);
  } catch (e) { S.error = e.message; S.projBusy = false; render(); return; }
  S.projBusy = false;
  await reload();
}

const aiOk = () => !!S.cfg?.project && S.cfg.appInsights?.status === 'ok';

async function reload() {
  if (S.view === 'distributed') return workspaceReload();
  S.error = '';
  try {
    S.cfg = await api('/api/config');
    if (!S.cfg.project) { S.wfAgents = []; S.runs = []; S.run = null; render(); return; }
    S.agents = await api('/api/agents');
    if (!aiOk()) { S.wfAgents = []; S.runs = []; S.run = null; S.summary = null; render(); return; }
    S.wfAgents = await api(`/api/wf/agents?days=${S.days}`);
    if (!S.wfAgents.some((a) => a.role === S.agent)) {
      const d = S.wfAgents.find((a) => a.role === S.cfg.defaultAgent) || S.wfAgents.find((a) => a.kind === 'workflow') || S.wfAgents[0];
      if (d) S.agent = d.role; else if (S.agent) S.wfAgents = [{ role: S.agent, kind: 'workflow', pattern: 'Graph workflow', executors: [] }];
    }
    if (!S.agent) { render(); return; }
    const q = `agent=${encodeURIComponent(S.agent)}&days=${S.days}&kind=${agentInfo().kind}`;
    const [summary, runs] = await Promise.all([api(`/api/wf/summary?${q}`), api(`/api/wf/runs?${q}`)]);
    S.summary = summary; S.runs = runs;
    const vis = visibleRuns();
    if (!S.runId || (S.runFilter !== 'all' && !vis.some((r) => r.runId === S.runId))) S.runId = ([...vis].find((r) => r.tokens > 8000) || vis[0])?.runId || null;
    await loadRun();
  } catch (e) { S.error = e.message; render(); }
}

const visibleRuns = () => S.runs.filter((r) => S.runFilter === 'all' || (S.runFilter === 'failed' ? r.fails : !r.fails));
const agentInfo = () => S.wfAgents.find((a) => a.role === S.agent) || {};
function pickAgent(role) {
  S.agent = role; S.runId = null; S.run = null; S.summary = null; S.runs = []; S.sel = 0; S.error = '';
  const u = new URL(location.href); u.searchParams.set('agent', role); u.searchParams.delete('run'); history.replaceState(null, '', u);
  reload();
}
function pickRun(id) {
  S.runId = id;
  const u = new URL(location.href); u.searchParams.set('run', id); history.replaceState(null, '', u);
  loadRun();
}

function workflowBanner() {
  const a = agentInfo(), r = S.run;
  if (a.kind === 'agent') return `<div class="card wfban"><span class="pill unk">Single agent</span><b>${esc(S.agent)}</b><span class="sub">No <code>workflow.run</code> span recorded (${esc(a.evidence || '')}), so this is a standalone agent: one agent, its model calls and tools. ${a.agentNames?.length > 1 ? '' : ''}</span></div>`;
  const name = (r && r.workflowName) || a.workflowName || '';
  const execs = (r ? r.executors.map((e) => e.name) : a.executors) || [];
  return `<div class="card wfban"><span class="pill ok">Graph workflow</span><b title="${esc(name)}">${esc(name ? name.replace(/^(WorkflowBuilder-[0-9a-f]{8}).*$/, '$1…') : 'Unnamed workflow')}</b>
    <span class="pill derived">${esc(a.pattern || 'Graph workflow')}</span>
    <span class="sub">${execs.length} executors${execs.length ? ': ' + esc(execs.join(' → ')) : ''}${a.edgeTypes?.length ? ' · edges: ' + esc(a.edgeTypes.join(', ')) : ''}</span>
    ${name ? '' : '<span class="sub">(no workflow.name attribute recorded)</span>'}</div>`;
}

async function loadRun() {
  S.run = null; S.io = 0; S.sel = 0; render();
  if (!S.runId) return;
  try { S.run = await api(`/api/wf/run?id=${S.runId}`); } catch (e) { S.error = e.message; }
  render();
}

function render() {
  if (!S.cfg) {
    $('#main').innerHTML = `<div class="card error" role="alert">${esc(S.error || 'Loading dashboard...')} <a href="/">Reload dashboard</a></div>`;
    return;
  }
  pbStop();
  $('#side').innerHTML = `<div class="logo"><i></i><div>Microsoft Foundry<small>Hosted Agents</small></div></div>` +
    NAV.map(([k, ic, l]) => `<button type="button" class="nav ${S.view === k ? 'on' : ''}" data-v="${k}" ${S.view === k ? 'aria-current="page"' : ''}><span>${ic}</span>${l}</button>`).join('');
  document.querySelectorAll('.nav').forEach((el) => el.onclick = () => { W.request++; W.busy = false; clearInterval(workspaceTimer); S.view = el.dataset.v; hideTip(); render(); if (S.view === 'distributed') { workspaceUrl(W.run?.traceId); workspaceReload(); } else { const url = new URL(location.href); url.searchParams.set('view', S.view); url.searchParams.delete('workspace'); url.searchParams.delete('trace'); history.replaceState(null, '', url); if (!S.projects) loadProjects(); } });
  const titles = {
    overview: ['Overview', 'All agents in your Foundry project'], flow: ['Agents Dashboard', 'Visualize how your hosted agents work together and how information flows across the workflow.'],
    playback: ['Trace Playback', 'Replay a recorded agent run to see how information flows across agents, tools, and models, driven only by Application Insights telemetry.'],
    runs: ['Runs & History', `Workflow runs of ${S.agent}`], traces: ['Traces & Logs', 'Span waterfall and container logs for the selected run'],
    tools: ['Tools & Connectors', 'Tools invoked by the agents in this workflow'], distributed: ['Solution Workspaces', 'Distributed observability across Functions, Container Apps, Foundry and tools. Local-first, read-only.'], settings: ['Settings', 'Connection details'],
  }[S.view];
  const blocked = !aiOk() && ['flow', 'playback', 'runs', 'traces', 'tools'].includes(S.view);
  const noAgent = aiOk() && !S.agent && ['flow', 'playback', 'runs', 'traces', 'tools'].includes(S.view);
  const single = false;
  const body = blocked || noAgent ? '' : { overview: vOverview, flow: vFlow, playback: vPlayback, runs: vRuns, traces: vTraces, tools: vTools, distributed: vWorkspaces, settings: vSettings }[S.view]();
  const vr = visibleRuns(), ri = vr.findIndex((r) => r.runId === S.runId);
  const agentOpts = S.wfAgents.map((a) => `<option value="${esc(a.role)}" ${a.role === S.agent ? 'selected' : ''}>${a.kind === 'workflow' ? '🔀' : '🤖'} ${esc(a.role)} · ${a.kind === 'workflow' ? 'workflow' : 'single agent'}</option>`).join('');
  const runOpts = (S.runId && ri < 0 ? `<option value="${esc(S.runId)}" selected>${esc(S.runId.slice(0, 12))}… (by ID)</option>` : '') +
    vr.map((r) => `<option value="${r.runId}" ${r.runId === S.runId ? 'selected' : ''}>${r.runId.slice(0, 10)}… · ${fmtDT(r.start)} · ${fmtS(r.durationMs)} · ${(r.tokens || 0).toLocaleString()} tok${r.fails ? ' · failed' : ''}</option>`).join('');
  const showAgentSel = aiOk() && S.agent && !['settings', 'overview'].includes(S.view);
  const ctl = ['settings', 'distributed'].includes(S.view) ? '' : `<div class="selbar">
    <label>Foundry project${projectSelect('hdrproj')}</label>
    ${showAgentSel ? `<label>Agent<select id="hdragent">${agentOpts}</select></label>
    <label>Trace<span class="stp"><button class="btn ghost sq" id="runprev" title="Newer trace" ${ri <= 0 ? 'disabled' : ''}>‹</button>
      <select id="hdrrun">${runOpts || '<option>No traces</option>'}</select><button class="btn ghost sq" id="runnext" title="Older trace" ${ri < 0 || ri >= vr.length - 1 ? 'disabled' : ''}>›</button></span></label>
    <label>Status<select id="runfilter">${[['all', 'All'], ['ok', 'Succeeded'], ['failed', 'Failed']].map(([v, l]) => `<option value="${v}" ${S.runFilter === v ? 'selected' : ''}>${l} (${S.runs.filter((r) => v === 'all' || (v === 'failed' ? r.fails : !r.fails)).length})</option>`).join('')}</select></label>` : ''}
    </div>`;
  $('#main').innerHTML = `<header><div><h1>${titles[0]}</h1><p>${titles[1]}</p></div>
    <div style="display:flex;gap:10px;align-items:center">
    <select id="days">${[1, 7, 30, 90].map((d) => `<option value="${d}" ${d === S.days ? 'selected' : ''}>Last ${d === 1 ? '24 hours' : d + ' days'}</option>`).join('')}</select>
    <button class="btn" id="refresh">⟳ Refresh</button></div></header>${ctl}
    ${S.error ? `<div class="card" style="color:var(--red);margin-bottom:12px">${esc(S.error)}</div>` : ''}${!['settings', 'distributed'].includes(S.view) ? connectionAlert() : ''}${!blocked && !noAgent && ['flow', 'playback', 'runs', 'traces', 'tools'].includes(S.view) && S.wfAgents.length ? workflowBanner() : ''}${noAgent ? '<div class="card"><p class="sub">No agent with telemetry in this window. Try a longer time range.</p></div>' : ''}${body}`;
  $('#days').onchange = (e) => { S.days = +e.target.value; reload(); };
  $('#refresh').onclick = reload;
  const hp = $('#hdrproj'); if (hp) hp.onchange = (e) => pickProject(e.target.value);
  const ha = $('#hdragent'); if (ha) ha.onchange = (e) => pickAgent(e.target.value);
  const hr = $('#hdrrun'); if (hr) hr.onchange = (e) => pickRun(e.target.value);
  const rf = $('#runfilter'); if (rf) rf.onchange = (e) => { S.runFilter = e.target.value; const v = visibleRuns(); if (!v.some((r) => r.runId === S.runId) && v[0]) pickRun(v[0].runId); else render(); };
  const rp = $('#runprev'), rn = $('#runnext');
  if (rp) rp.onclick = () => pickRun(vr[ri - 1].runId);
  if (rn) rn.onclick = () => pickRun(vr[ri + 1].runId);
  bind();
  bindWorkspaces();
  if (S.view === 'playback' && !single) pbMount();
}

// ---------- shared pieces
function kpis() {
  const t = S.summary?.totals || {};
  const ser = S.summary?.series || [];
  const max = Math.max(1, ...ser.map((x) => x.n));
  const pts = ser.map((x, i) => `${ser.length > 1 ? (i / (ser.length - 1)) * 160 : 80},${36 - (x.n / max) * 32}`).join(' ');
  const k = (c, ic, v, l) => `<div class="card kpi"><div class="ic" style="background:${c}">${ic}</div><div><b>${v ?? 0}</b><span>${l}</span></div></div>`;
  return `<div class="kpis">${k('#1a6cf0', '▶', t.total, 'Total Runs')}${k('#1f9d55', '✓', t.ok, 'Successful')}${k('#e5484d', '✕', t.failed, 'Failed')}
    ${k('#f59e0b', '⏱', t.avgMs ? fmtS(t.avgMs) : '—', 'Avg duration (p95 ' + (t.p95Ms ? fmtS(t.p95Ms) : '—') + ')')}
    <div class="card spark"><span style="color:var(--muted)">Runs over time</span><svg width="170" height="42"><polyline fill="none" stroke="#1a6cf0" stroke-width="2" points="${pts}"/></svg></div></div>`;
}

function runDetailsPanel(r) {
  if (!r) return `<div class="card"><h2>Run Details</h2><p class="sub">${S.runId ? 'Loading…' : 'No runs in this window.'}</p></div>`;
  return `<div class="card"><div style="display:flex;justify-content:space-between"><h2>Run Details</h2><span class="pill ${r.success ? 'completed' : 'failed'}">${r.success ? 'Completed' : 'Failed'}</span></div>
    <div class="kv" style="margin-top:12px"><span>Run ID</span><div class="mono">${esc(r.runId.slice(0, 16))}…</div><span>Started At</span><div>${fmtDT(r.start)}</div>
    <span>Total Duration</span><div>${fmtS(r.durationMs)}</div><span>Tokens</span><div>${r.tokensIn + r.tokensOut} (${r.tokensIn} in / ${r.tokensOut} out)</div>
    <span>Triggered By</span><div>${esc(r.channel || 'Responses API')} · v${esc(r.agentVersion)}</div><span>Start type</span><div>${esc(r.latency.start_type || '—')}</div>
    <span>Session</span><div class="mono">${esc((r.sessionId || '').slice(0, 14))}…</div></div>
    ${latencyBar(r)}
    <b style="display:block;margin-top:14px">User Query</b><div class="resp" style="max-height:60px"><i>${esc(r.userQuery || '—')}</i></div>
    <b style="display:block;margin-top:10px">Final Response</b><div class="resp">${esc(r.finalResponse.slice(0, 600) || '—')}</div>
    <a class="lnk" id="fullresp">View Full Response →</a></div>`;
}

function latencyBar(r) {
  const l = r.latency; const keys = [['platform_preprocessing_ms', 'Platform', '#9ec0ff'], ['infra_setup_ms', 'Infra', '#c4b5fd'], ['container_readiness_ms', 'Container ready', '#fcd34d'], ['container_response_ms', 'Response', '#86efac']];
  const vals = keys.map(([k, n, c]) => ({ n, c, v: +l[k] || 0 })); const tot = vals.reduce((a, x) => a + x.v, 0);
  if (!tot) return '';
  return `<b style="display:block;margin-top:14px">Hosted platform latency</b><div class="stack">${vals.map((x) => `<i title="${x.n}: ${x.v}ms" style="width:${(x.v / tot) * 100}%;background:${x.c}"></i>`).join('')}</div>
    <div style="color:var(--muted);font-size:11px">${vals.map((x) => `${x.n} ${fmtS(x.v)}`).join(' · ')}</div>`;
}

function runSelect() {
  return `<select id="runsel">${S.runs.map((r) => `<option value="${r.runId}" ${r.runId === S.runId ? 'selected' : ''}>${fmtDT(r.start)} · ${fmtS(r.durationMs)}${r.fails ? ' · failed' : ''}</option>`).join('')}</select>`;
}

// ---------- Flow view
function execDesc(e) {
  const m = (e.system || '').replace(/\s+/g, ' ').match(/^(.{20,120}?[.!])\s/);
  return m ? m[1] : (e.system || '').slice(0, 100) || 'Hosted workflow agent';
}
const toolsOf = (e) => [...new Set([...e.toolCalls.map((t) => t.name), ...e.hostedTools])];

function vFlow() {
  const r = S.run;
  const nodes = !r ? '<p class="sub" style="padding:60px">Loading workflow…</p>' : (() => {
    const n = r.executors.length;
    let h = `<div class="node io"><div class="ico">👤</div><div><h4>User Query</h4><p>${esc((r.userQuery || 'Request').slice(0, 60))}</p></div></div><div class="arrow"><small>${r.userQuery ? 'prompt' : ''}</small></div>`;
    r.executors.forEach((e, i) => {
      const c = COLORS[i % COLORS.length];
      h += `<div class="node agent ${S.sel === i ? 'sel' : ''}" data-i="${i}" style="border-color:${c}"><div class="badge" style="background:${c}">🤖</div><div class="num" style="border-color:${c};color:${c}">${i + 1}</div>
        <h4>${esc(e.name)}</h4><p>${esc(execDesc(e))}</p>
        <div class="meta"><span class="pill ${e.status}">${e.status === 'failed' ? '✕ Failed' : '✓ Completed'}</span><span>⏱ ${fmtS(e.durationMs)}</span></div>
        <div class="tools">${toolsOf(e).map((t) => `<span class="tool">🧩 ${esc(t)}</span>`).join('')}</div></div>`;
      h += `<div class="arrow"></div>`;
    });
    h += `<div class="node io"><div class="ico" style="background:#3b82f6">📄</div><div><h4>Final Response</h4><p>${esc((r.finalResponse || '—').replace(/\s+/g, ' ').slice(0, 60))}</p></div></div>`;
    return h;
  })();
  return `${kpis()}<div class="card" id="wfcard"><div class="flowhead"><div><h2>Agent Workflow</h2><p class="sub">${esc(agentInfo().pattern || 'Sequential flow')} of ${r ? r.executors.length : '…'} hosted agents · hover an agent for details</p></div>
    <div class="legend"><span><i style="background:#1a6cf0"></i>Input / Output</span><span><i style="background:#8b3cf0"></i>Agent</span><span><i style="background:#1f9d55"></i>Data / Tools</span><span>→ Sequential Flow</span>
    <button class="btn ghost" id="fs">⛶</button></div></div><div class="flow">${nodes}</div></div>
    <div class="cols"><div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><div><h2>Run Execution Timeline</h2><p class="sub">Step-by-step execution details</p></div>${runSelect()}</div><div class="tl">${timeline(r)}</div></div>
    <div class="card">${ioPanel(r)}</div>${runDetailsPanel(r)}</div>`;
}

function timeline(r) {
  if (!r) return '';
  const col = { request: '#1f9d55', workflow: '#1f9d55', agent: '#8b3cf0', llm: '#1a6cf0', tool: '#16a5a5', final: '#1f9d55' };
  const ic = { request: '✓', workflow: '▶', agent: '●', llm: '💬', tool: '🧩', final: '✓' };
  return r.timeline.map((e) => `<div class="ev"><div class="t">${fmtT(e.t)}</div><div class="d" style="background:${e.status === 'failed' ? '#e5484d' : col[e.kind]}">${ic[e.kind]}</div>
    <div><b>${esc(e.title)}</b><span>${esc(e.detail)}</span></div></div>`).join('');
}

function code(title, text) {
  const lines = (text || '(empty)').split('\n').slice(0, 400);
  return `<div class="code"><h5>${esc(title)}</h5><pre>${lines.map((l, i) => `<div><b>${i + 1}</b><span>${esc(l)}</span></div>`).join('')}</pre></div>`;
}
function ioPanel(r) {
  if (!r) return '<h2>Agent Input / Output</h2>';
  const ex = r.executors, n = ex.length;
  const tabs = [`Query → 1`, ...ex.slice(0, -1).map((_, i) => `${i + 1} → ${i + 2}`), 'Final Output'];
  const i = Math.min(S.io, tabs.length - 1);
  const pick = (e, k) => (S.raw ? e[k + 'Raw'] || e[k] : e[k]);
  let left, right;
  if (i === 0) { left = code('User Query', r.userQuery); right = code(`Input to ${ex[0].name}`, pick(ex[0], 'input')); }
  else if (i < n) { left = code(`Output from ${ex[i - 1].name}`, pick(ex[i - 1], 'output')); right = code(`Input to ${ex[i].name}`, pick(ex[i], 'input')); }
  else { left = code(`Output from ${ex[n - 1].name}`, pick(ex[n - 1], 'output')); right = code('Run summary', JSON.stringify({ runId: r.runId, success: r.success, durationMs: r.durationMs, tokensIn: r.tokensIn, tokensOut: r.tokensOut, finalResponse: r.finalResponse.slice(0, 200) }, null, 2)); }
  return `<div style="display:flex;justify-content:space-between"><div><h2>Agent Input / Output</h2><p class="sub">Data passed between agents</p></div><select id="rawsel"><option value="0">Text</option><option value="1" ${S.raw ? 'selected' : ''}>Raw JSON</option></select></div>
    <div class="tabs">${tabs.map((t, k) => `<div class="${k === i ? 'on' : ''}" data-io="${k}">${esc(t)}</div>`).join('')}</div><div class="io">${left}${right}</div>`;
}

// ---------- Hover card
let tipTimer, tipTab = 'Overview', tipIdx = 0;
function showTip(i, el) {
  clearTimeout(tipTimer); tipIdx = i; tipTab = 'Overview';
  const t = $('#tip'); t.style.display = 'block';
  const b = el.getBoundingClientRect();
  t.style.left = Math.min(Math.max(8, b.left + b.width / 2 - 195), innerWidth - 410) + 'px';
  t.style.top = Math.max(8, b.top - 20 - Math.min(t.offsetHeight, 380)) + 'px';
  renderTip(b);
}
function renderTip(b) {
  const e = S.run.executors[tipIdx], t = $('#tip');
  const tools = e.toolCalls.reduce((m, c) => { (m[c.name] ||= { ...c, n: 0, ms: 0 }); m[c.name].n++; m[c.name].ms += c.durationMs; return m; }, {});
  e.hostedTools.forEach((n) => (tools[n] ||= { name: n, description: 'Platform-hosted tool', n: 1, ms: 0 }));
  const tl = Object.values(tools);
  const hosted = (S.agents.find((a) => a.name === S.agent) || {}).hosted;
  const body = {
    Overview: `<b>Description</b><p>${esc(execDesc(e))}</p><b>Tools</b>${tl.map((x) => `<div class="trow"><i>🧩</i><div><b>${esc(x.name)}</b><br><span style="color:var(--muted)">${esc((x.description || '').split('\n')[0].slice(0, 90))}</span></div></div>`).join('') || '<p style="color:var(--muted)">No tools</p>'}`,
    [`Tools (${tl.length})`]: tl.map((x) => `<div class="trow"><i>🧩</i><div><b>${esc(x.name)}</b> · ${x.n} call${x.n > 1 ? 's' : ''} · avg ${fmtS(x.ms / x.n)}<br><span style="color:var(--muted)">${esc(x.description || '')}</span></div></div>`).join('') || 'No tools',
    Prompt: `<div class="resp" style="max-height:220px">${esc(e.system || 'No system prompt captured')}</div>`,
    Configuration: `<div class="kv"><span>Model</span><div>${esc(e.model)}</div><span>Tokens</span><div>${e.tokensIn} in / ${e.tokensOut} out</div><span>LLM calls</span><div>${e.llmCalls.length}</div>
      <span>Finish</span><div>${esc(e.llmCalls.map((c) => c.finish).join(', ') || '—')}</div><span>Duration</span><div>${fmtS(e.durationMs)}</div>
      ${hosted ? `<span>Runtime</span><div>${esc(hosted.runtime)} · ${esc(hosted.cpu)} CPU · ${esc(hosted.memory)}</div><span>Protocols</span><div>${esc(hosted.protocols.join(', '))}</div>` : ''}</div>`,
  };
  const names = Object.keys(body);
  t.innerHTML = `<div class="hd"><div class="badge" style="position:static;transform:none;background:${COLORS[tipIdx % 5]};width:40px;height:40px">🤖</div><div style="flex:1"><h3>${esc(e.name)}</h3><span style="color:var(--muted)">${esc(execDesc(e).slice(0, 70))}</span></div><span class="pill ${e.status}">${e.status === 'failed' ? 'Failed' : 'Healthy'}</span></div>
    <div class="tabs">${names.map((n) => `<div class="${n === (names.includes(tipTab) ? tipTab : 'Overview') ? 'on' : ''}" data-tt="${esc(n)}">${esc(n)}</div>`).join('')}</div><div class="tipbody">${body[names.includes(tipTab) ? tipTab : 'Overview']}</div>`;
  t.querySelectorAll('[data-tt]').forEach((x) => x.onclick = () => { tipTab = x.dataset.tt; renderTip(); });
  const bb = b; if (bb) t.style.top = Math.max(8, bb.top - t.offsetHeight - 10) + 'px';
}
function hideTip() { tipTimer = setTimeout(() => { $('#tip').style.display = 'none'; }, 250); }
$('#tip').onmouseenter = () => clearTimeout(tipTimer);
$('#tip').onmouseleave = hideTip;

// ---------- Other views
function vOverview() {
  return `${kpis()}<div class="card"><h2>Agents in project</h2><p class="sub">${S.agents.length} agents</p><table><tr><th>Name</th><th>Kind</th><th>Model</th><th>Tools</th><th>Runs</th><th>p95</th><th>Status</th></tr>
    ${S.agents.map((a) => `<tr><td><b>${esc(a.name)}</b></td><td>${esc(a.kind)}</td><td>${esc(a.model)}</td><td>${esc((a.tools || []).join(', ') || '—')}</td><td>${a.metrics?.runs24h ?? '—'}</td><td>${a.metrics?.p95Ms ? fmtS(a.metrics.p95Ms) : '—'}</td><td><span class="pill ${a.status === 'healthy' ? 'ok' : 'failed'}">${esc(a.status)}</span></td></tr>`).join('')}</table></div>`;
}
function vRuns() {
  return `<div class="card"><h2>Workflow runs</h2><p class="sub">Click a run to open it in the workflow view</p><table><tr><th>Started</th><th>Run ID</th><th>Duration</th><th>Agents</th><th>Tool calls</th><th>Tokens</th><th>Status</th></tr>
    ${S.runs.map((r) => `<tr class="click" data-run="${r.runId}"><td>${fmtDT(r.start)}</td><td class="mono">${r.runId.slice(0, 16)}…</td><td>${fmtS(r.durationMs)}</td><td>${r.agents}</td><td>${r.toolCalls}</td><td>${r.tokens}</td><td><span class="pill ${r.fails ? 'failed' : 'ok'}">${r.fails ? 'Failed' : 'Completed'}</span></td></tr>`).join('')}</table></div>`;
}
function vTraces() {
  const r = S.run; if (!r) return '<div class="card">Loading…</div>';
  const tot = Math.max(...r.spans.map((s) => s.offsetMs + s.durationMs), 1);
  return `<div class="card"><div style="display:flex;justify-content:space-between"><div><h2>Span waterfall</h2><p class="sub">${r.spans.length} spans · ${fmtS(r.durationMs)} workflow</p></div>${runSelect()}</div>
    ${r.spans.map((s) => `<div class="wf"><div class="nm" style="padding-left:${s.depth * 14}px" title="${esc(s.name)}">${esc(s.name)}</div><div class="bar"><i class="${!s.success ? 'bad' : s.kind === 'chat' ? 'llm' : s.kind === 'execute_tool' ? 'tool' : ''}" style="left:${(s.offsetMs / tot) * 100}%;width:${(s.durationMs / tot) * 100}%"></i></div><div style="width:60px;text-align:right">${fmtS(s.durationMs)}</div></div>`).join('')}</div>
    <div class="card" style="margin-top:14px"><h2>Container logs</h2><p class="sub">${r.logs.length} entries</p><div class="mono" style="max-height:340px;overflow:auto">${r.logs.map((l) => `<div style="padding:3px 0;border-bottom:1px solid var(--line)"><span style="color:var(--muted)">${fmtT(l.t)}</span> ${esc(l.message)}</div>`).join('')}</div></div>`;
}
function vTools() {
  const r = S.run; const usage = (S.agents.find((a) => a.name === S.agent)?.manifest?.toolUsage) || [];
  const calls = r ? r.executors.flatMap((e) => e.toolCalls.map((c) => ({ ...c, agent: e.name }))) : [];
  return `<div class="card"><h2>Tool usage (${S.days}d)</h2><p class="sub">Aggregated from traces</p><table><tr><th>Tool</th><th>Calls</th><th>Avg</th><th>Errors</th></tr>${usage.map((u) => `<tr><td><b>${esc(u.tool)}</b></td><td>${u.calls}</td><td>${fmtS(u.avgMs)}</td><td>${u.errors}</td></tr>`).join('')}</table></div>
   <div class="card" style="margin-top:14px"><div style="display:flex;justify-content:space-between"><div><h2>Tool calls in selected run</h2></div>${runSelect()}</div><table><tr><th>Agent</th><th>Tool</th><th>Arguments</th><th>Result</th><th>Duration</th></tr>
    ${calls.map((c) => `<tr><td>${esc(c.agent)}</td><td><b>${esc(c.name)}</b><br><span style="color:var(--muted)">${esc((c.description || '').split('\n')[0])}</span></td><td class="mono">${esc(c.args.slice(0, 300))}</td><td class="mono">${esc(c.result.slice(0, 300))}</td><td>${fmtS(c.durationMs)}</td></tr>`).join('') || '<tr><td colspan="5">No tool calls in this run</td></tr>'}</table></div>`;
}
function projectSelect(id) {
  const cur = S.cfg?.project?.id;
  if (S.projErr) return `<select id="${id}" disabled><option>Could not list projects</option></select>`;
  if (!S.projects) return `<select id="${id}" disabled><option>Loading projects…</option></select>`;
  const groups = {};
  S.projects.forEach((p) => (groups[p.subscription] ||= []).push(p));
  return `<select id="${id}" ${S.projBusy ? 'disabled' : ''}>${cur ? '' : '<option value="" selected>Select a project…</option>'}${Object.entries(groups).map(([s, ps]) =>
    `<optgroup label="${esc(s)}">${ps.map((p) => `<option value="${esc(p.id)}" ${p.id === cur ? 'selected' : ''}>${esc(p.account)} / ${esc(p.project)}</option>`).join('')}</optgroup>`).join('')}</select>`;
}

function connectionAlert() {
  const c = S.cfg; if (!c) return '';
  const link = '<a class="lnk" onclick="S.view=\'settings\';render()">Open Settings</a>';
  if (!c.project) return `<div class="card alert">⚠ <b>No Foundry project selected.</b> Pick one from the Foundry project dropdown. ${link}</div>`;
  const a = c.appInsights || {};
  if (a.status === 'ok') return '';
  return `<div class="card alert">⚠ <b>Application Insights is not available for ${esc(c.project.account)} / ${esc(c.project.project)}.</b> ${esc(a.error || '')}
    Connect Application Insights in the Foundry portal (project → <i>Tracing</i>) or enter an App ID manually. ${link}</div>`;
}

function vSettings() {
  const c = S.cfg, p = c.project, a = c.appInsights || {};
  const st = a.status === 'ok' ? '<span class="pill ok">✓ Connected</span>' : `<span class="pill failed">${a.status === 'missing' ? 'Not connected' : 'Error'}</span>`;
  const login = S.azureLogin;
  return `<div class="card"><h2>Azure connection</h2><p class="sub">Sign in with Azure to access your Foundry projects. No local account is required. All browser tabs share the backend Azure CLI identity.</p>
    ${S.azure ? `<p>Signed in as <b>${esc(S.azure.username)}</b> · ${esc(S.azure.subscription)}</p>` : '<p class="sub">Sign in to Azure to discover your accessible Foundry projects.</p>'}
    <button class="btn" id="azurelogin" ${login?.status === 'pending' ? 'disabled' : ''}>Sign in to Azure</button> <button class="btn ghost" id="azurecheck">Check connection</button>
    ${login?.status === 'pending' ? `<p role="status">${login.userCode ? `Open <a href="https://microsoft.com/devicelogin" target="_blank" rel="noopener noreferrer">Microsoft device login</a> and enter <b class="mono">${esc(login.userCode)}</b>.` : 'Starting device login...'} Complete sign-in within 3 minutes.</p>` : ''}
    ${S.azureError || login?.error ? `<p class="error" role="alert">${esc(S.azureError || login.error)}</p>` : ''}
    <p class="sub">Azure CLI must be installed where the backend runs. You can also run <code>az login</code> there.</p></div>
  <div class="card" style="margin-top:14px"><h2>Foundry project</h2><p class="sub">Choose any project your Azure CLI login can see. Application Insights is looked up from the project's own connection.</p>
    <div class="selbar" style="margin-top:10px"><label>Project${projectSelect('setproj')}</label><button class="btn ghost" id="projrefresh">⟳ Reload list</button></div>
    ${S.projErr ? `<div style="color:var(--red)">${esc(S.projErr)}</div>` : ''}
    ${p ? `<div class="kv" style="margin-top:12px"><span>Subscription</span><div>${esc(p.subscription)}</div><span>Resource group</span><div>${esc(p.resourceGroup)}</div>
      <span>Region</span><div>${esc(p.location)}</div><span>Project endpoint</span><div class="mono">${esc(p.endpoint)}</div></div>` : '<p class="sub">No project selected.</p>'}</div>
  <div class="card" style="margin-top:14px"><div style="display:flex;justify-content:space-between"><h2>Application Insights</h2>${p ? st : ''}</div>
    ${a.status === 'ok' ? `<div class="kv" style="margin-top:12px"><span>Resource</span><div>${esc(a.name || '')}</div><span>App ID</span><div class="mono">${esc(a.appId)}</div>
      ${a.resourceId ? `<span>Resource ID</span><div class="mono" style="word-break:break-all">${esc(a.resourceId)}</div>` : ''}<span>Source</span><div>${c.manualAppId ? 'Entered manually' : 'Auto-discovered from the project connection'}</div></div>`
      : `<p style="color:var(--red)">${esc(a.error || 'No project selected.')}</p>`}
    ${p ? `<div class="selbar" style="margin-top:12px"><label>Override App ID (optional)<input id="manualapp" placeholder="00000000-0000-0000-0000-000000000000" style="min-width:340px" spellcheck="false"></label><button class="btn ghost" id="manualgo">Use this App ID</button>
      ${c.manualAppId ? '<button class="btn ghost" id="manualclr">Back to auto-discovery</button>' : ''}</div>` : ''}</div>
  <div class="card" style="margin-top:14px"><h2>Dashboard defaults</h2><p class="sub">Saved on the backend and retained after a restart. Project selection and App ID overrides are saved too.</p>
    <form id="defaultsform" class="selbar"><label>Default agent<input id="defaultagent" maxlength="100" value="${esc(c.defaultAgent)}" placeholder="Optional agent role"></label>
    <label>Default time window<select id="defaultdays">${[1, 7, 30, 90].map((d) => `<option value="${d}" ${d === c.windowDays ? 'selected' : ''}>${d} days</option>`).join('')}</select></label>
    <button class="btn" type="submit">Save defaults</button></form><p id="saveddefaults" class="sub" role="status">${esc(S.settingsMessage || '')}</p></div>`;
}

// ---------- wiring
function bind() {
  const al = $('#azurelogin'); if (al) al.onclick = startAzureLogin;
  const ac = $('#azurecheck'); if (ac) ac.onclick = azureStatus;
  const df = $('#defaultsform'); if (df) df.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ defaultAgent: $('#defaultagent').value.trim(), windowDays: +$('#defaultdays').value }) });
      S.cfg = await api('/api/config'); S.days = S.cfg.windowDays; S.settingsMessage = 'Defaults saved.'; render();
    } catch (err) { S.error = err.message; render(); }
  };
  const sp = $('#setproj'); if (sp) sp.onchange = (e) => e.target.value && pickProject(e.target.value);
  const pr = $('#projrefresh'); if (pr) pr.onclick = () => loadProjects(true);
  const mg = $('#manualgo'); if (mg) mg.onclick = () => { const v = $('#manualapp').value.trim(); if (v) pickProject(S.cfg.project.id, v); };
  const mc = $('#manualclr'); if (mc) mc.onclick = () => pickProject(S.cfg.project.id);
  document.querySelectorAll('.node.agent').forEach((el) => {
    el.onmouseenter = () => showTip(+el.dataset.i, el);
    el.onmouseleave = hideTip;
    el.onclick = () => { S.sel = +el.dataset.i; S.io = Math.min(S.sel + 1, S.run.executors.length); render(); };
  });
  document.querySelectorAll('[data-io]').forEach((el) => el.onclick = () => { S.io = +el.dataset.io; render(); });
  document.querySelectorAll('#runsel').forEach((el) => el.onchange = (e) => { S.runId = e.target.value; loadRun(); });
  document.querySelectorAll('tr[data-run]').forEach((el) => el.onclick = () => { S.runId = el.dataset.run; S.view = 'flow'; loadRun(); });
  const rs = $('#rawsel'); if (rs) rs.onchange = (e) => { S.raw = e.target.value === '1'; render(); };
  const fr = $('#fullresp'); if (fr) fr.onclick = () => { $('#modalbox').textContent = S.run.finalResponse; $('#modal').style.display = 'grid'; };
  const fs = $('#fs'); if (fs) fs.onclick = () => $('#wfcard').requestFullscreen?.();
}
$('#modal').onclick = (e) => { if (e.target.id === 'modal') $('#modal').style.display = 'none'; };

boot().catch((e) => { S.error = e.message; render(); });
