const { azToken } = require('./azure');
const { GUID } = require('./workspaces');

async function queryApp(appId, kql) {
  if (!GUID.test(appId || '')) throw Object.assign(new Error('Invalid Application Insights App ID.'), { status: 400 });
  const res = await fetchJson(`https://api.applicationinsights.io/v1/apps/${appId}/query`, {
    signal: AbortSignal.timeout(45000), method: 'POST',
    headers: { Authorization: `Bearer ${await azToken('https://api.applicationinsights.io')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: kql }),
  });
  if (res.error || !res.tables?.[0]?.rows || !res.tables[0].columns) throw new Error('Application Insights returned an incomplete query response. Retry or narrow the query window.');
  const t = res.tables[0];
  return t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c.name, r[i]])));
}

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), ...opts });
  if (!r.ok) throw Object.assign(new Error(`Azure request failed (${r.status}). Check Azure login, permissions and network access.`), { status: r.status === 401 ? 424 : r.status });
  return r.json();
}

// Each request captures its settings so a project switch cannot mix telemetry sources.
function forConfig(config) {
const WINDOW = config.windowDays;
async function aiQuery(kql) {
  const app = config.appInsights?.status === 'ok' ? config.appInsights.appId : '';
  if (!app) throw Object.assign(new Error('No Application Insights is connected to the selected Foundry project.'), { status: 424 });
  return queryApp(app, kql);
}

async function enrich(agents) {
  if (config.appInsights?.status !== 'ok') return;
  const roles = agents.filter((a) => a.kind === 'hosted').map((a) => `'${a.name.replace(/'/g, '')}'`).join(',');
  if (!roles) return;
  const base = `dependencies | where timestamp > ago(${WINDOW}d) | where cloud_RoleName in~ (${roles})`;
  const [metrics, execs, agentSpans, tools] = await Promise.all([
    aiQuery(`${base}
      | extend op=tostring(customDimensions['gen_ai.operation.name']),
               tok=tolong(customDimensions['gen_ai.usage.input_tokens'])+tolong(customDimensions['gen_ai.usage.output_tokens'])
      | summarize wfRuns=countif(name=='workflow.run'), agRuns=countif(op=='invoke_agent'),
          wfErr=countif(name=='workflow.run' and success==false), agErr=countif(op=='invoke_agent' and success==false),
          wfP95=percentile(iff(name=='workflow.run',duration,real(null)),95), agP95=percentile(iff(op=='invoke_agent',duration,real(null)),95),
          tokens=sum(tok), lastSeen=max(timestamp) by role=cloud_RoleName`),
    aiQuery(`let runs = dependencies | where timestamp > ago(${WINDOW}d) and name=='workflow.run' | project operation_Id, runStart=timestamp;
      ${base} | where name startswith 'executor.process ' | join kind=inner runs on operation_Id
      | summarize off=avg(datetime_diff('millisecond', timestamp, runStart)), n=count(), avgMs=avg(duration) by role=cloud_RoleName, executor=substring(name,17)`),
    aiQuery(`${base} | where tostring(customDimensions['gen_ai.operation.name'])=='invoke_agent' and name startswith 'invoke_agent '
      | summarize n=count(), avgMs=avg(duration), model=any(tostring(customDimensions['gen_ai.request.model'])) by role=cloud_RoleName, agent=substring(name,13)`),
    aiQuery(`${base} | where tostring(customDimensions['gen_ai.operation.name'])=='execute_tool'
      | summarize n=count(), avgMs=avg(duration), errors=countif(success==false) by role=cloud_RoleName, tool=tostring(customDimensions['gen_ai.tool.name'])`),
  ]);
  for (const a of agents) {
    const m = metrics.find((x) => x.role === a.name);
    if (!m) continue;
    const wf = m.wfRuns > 0;
    const runs = wf ? m.wfRuns : m.agRuns;
    a.metrics = {
      runs24h: runs, window: `${WINDOW}d`, errorRate: runs ? (wf ? m.wfErr : m.agErr) / runs : 0,
      p95Ms: Math.round(wf ? m.wfP95 : m.agP95) || 0, tokens24h: m.tokens || 0, lastSeen: m.lastSeen,
    };
    const ex = execs.filter((x) => x.role === a.name).sort((p, q) => p.off - q.off);
    const sub = agentSpans.filter((x) => x.role === a.name);
    const toolUse = tools.filter((x) => x.role === a.name).sort((p, q) => q.n - p.n);
    if (ex.length || toolUse.length) {
      const ids = ex.map((e) => e.executor);
      a.manifest = {
        inferred: true,
        agents: ex.map((e) => ({ name: e.executor, model: sub.find((s) => s.agent === e.executor)?.model || '', tools: [], avgMs: Math.round(e.avgMs), runs: e.n })),
        toolUsage: toolUse.map((t) => ({ tool: t.tool, calls: t.n, avgMs: Math.round(t.avgMs), errors: t.errors })),
        workflow: {
          nodes: [{ id: 'start', type: 'input' }, ...ids.map((id) => ({ id, type: 'agent' })), { id: 'end', type: 'output' }],
          edges: ['start', ...ids, 'end'].slice(0, -1).map((id, i, arr) => ({ from: id, to: ['start', ...ids, 'end'][i + 1] })),
        },
      };
    }
  }
}

async function foundryAgents() {
  if (!config.project) throw Object.assign(new Error('Select a Foundry project in Settings.'), { status: 424 });
  const base = config.project.endpoint.replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${await azToken()}` };
  const [agentsRes, asstRes] = await Promise.all([
    fetchJson(`${base}/agents?api-version=v1`, { headers }),
    fetchJson(`${base}/assistants?api-version=2025-05-01`, { headers }).catch((e) => {
      if (e.status === 404) return { data: [] };
      throw e;
    }),
  ]);
  const out = agentsRes.data.map((a) => {
    const v = a.versions.latest, d = v.definition;
    return {
      name: a.name, kind: d.kind, status: v.status === 'active' && a.state === 'enabled' ? 'healthy' : 'degraded',
      version: v.version, createdAt: v.created_at * 1000, description: v.description || '',
      model: d.model || d.environment_variables?.AZURE_AI_MODEL_DEPLOYMENT_NAME || '',
      tools: (d.tools || []).map((t) => t.type === 'mcp' ? `mcp:${t.server_label}` : t.type),
      instructions: d.instructions || '',
      hosted: d.kind === 'hosted' ? {
        cpu: d.cpu, memory: d.memory, runtime: d.code_configuration?.runtime,
        protocols: (d.protocol_versions || []).map((p) => `${p.protocol}@${p.version}`),
        envNames: Object.keys(d.environment_variables || {}), // names only: values may be secrets
      } : null,
    };
  });
  for (const s of asstRes.data) {
    out.push({
      name: s.name || s.id, kind: 'assistant (classic)', status: 'healthy', version: '',
      createdAt: s.created_at * 1000, description: '', model: s.model,
      tools: (s.tools || []).map((t) => t.function?.name || t.type), instructions: s.instructions || '', hosted: null,
    });
  }
  await enrich(out);
  return out;
}

return { foundryAgents, traces: require('./traces')(aiQuery) };
}

// ---- Project selection + Application Insights auto-discovery (Azure Resource Manager)
const ARM = 'https://management.azure.com';
const armHeaders = async () => ({ Authorization: `Bearer ${await azToken(ARM)}`, 'Content-Type': 'application/json' });
const armGet = async (p) => fetchJson(`${ARM}${p}`, { headers: await armHeaders(), signal: AbortSignal.timeout(30000) });
async function graph(query) {
  const data = [];
  let skipToken;
  do {
    const r = await fetchJson(`${ARM}/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01`, {
      method: 'POST', headers: await armHeaders(),
      body: JSON.stringify({ query, options: { resultFormat: 'objectArray', $top: 1000, ...(skipToken ? { $skipToken: skipToken } : {}) } }),
      signal: AbortSignal.timeout(30000),
    });
    data.push(...r.data);
    skipToken = r.$skipToken;
  } while (skipToken);
  return data;
}

async function subscriptions() {
  const data = [];
  let next = `${ARM}/subscriptions?api-version=2022-12-01`;
  while (next) {
    if (new URL(next).origin !== ARM) throw new Error('Invalid Azure subscriptions continuation URL.');
    const r = await fetchJson(next, { headers: await armHeaders(), signal: AbortSignal.timeout(30000) });
    data.push(...r.value);
    next = r.nextLink;
  }
  return data;
}

let projectCache = null;
async function listProjects(force) {
  if (!force && projectCache && Date.now() < projectCache.exp) return projectCache.value;
  const [subs, projects, accounts] = await Promise.all([
    subscriptions(),
    graph(`resources | where type =~ 'microsoft.cognitiveservices/accounts/projects' | project id, name, subscriptionId, resourceGroup, location`),
    graph(`resources | where type =~ 'microsoft.cognitiveservices/accounts' | project id=tolower(id), domain=tostring(properties.customSubDomainName)`),
  ]);
  const subName = new Map(subs.map((s) => [s.subscriptionId, s.displayName]));
  const dom = new Map(accounts.map((a) => [a.id, a.domain]));
  const value = projects.map((p) => {
    const [account, project] = p.name.split('/');
    const domain = dom.get(p.id.split('/projects/')[0].toLowerCase()) || account;
    return { id: p.id, project, account, resourceGroup: p.resourceGroup, location: p.location, subscriptionId: p.subscriptionId,
      subscription: subName.get(p.subscriptionId) || p.subscriptionId, endpoint: `https://${domain}.services.ai.azure.com/api/projects/${project}` };
  }).sort((a, b) => (a.subscription + a.account + a.project).localeCompare(b.subscription + b.account + b.project));
  projectCache = { value, exp: Date.now() + 5 * 60 * 1000 };
  return value;
}

async function discoverAppInsights(projectId) {
  try {
    const conns = (await armGet(`${projectId}/connections?api-version=2025-06-01`)).value || [];
    const c = conns.find((x) => x.properties?.category === 'AppInsights');
    if (!c) return { status: 'missing', error: 'This Foundry project has no Application Insights connection.' };
    const resourceId = c.properties.metadata?.ResourceId || c.properties.target;
    const comp = await armGet(`${resourceId}?api-version=2020-02-02`);
    return { status: 'ok', appId: comp.properties.AppId, name: comp.name, resourceId };
  } catch (e) {
    return { status: 'error', error: `Could not resolve Application Insights: ${e.message}` };
  }
}

async function selectProject(id, manualAppId) {
  if (typeof id !== 'string' || (manualAppId !== undefined && typeof manualAppId !== 'string')) {
    throw Object.assign(new Error('Project ID and Application Insights App ID must be strings.'), { status: 400 });
  }
  if (manualAppId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(manualAppId)) {
    throw Object.assign(new Error('Invalid Application Insights App ID'), { status: 400 });
  }
  const p = (await listProjects()).find((x) => x.id.toLowerCase() === String(id).toLowerCase());
  if (!p) throw Object.assign(new Error('Unknown project'), { status: 400 });
  const appInsights = manualAppId
    ? { status: 'ok', appId: manualAppId, name: 'Manually entered App ID' }
    : await discoverAppInsights(p.id);
  return { project: p, appInsights, manualAppId: !!manualAppId };
}

async function listResources() {
  return graph(`resources | where type in~ ('microsoft.web/sites', 'microsoft.app/containerapps', 'microsoft.insights/components', 'microsoft.cognitiveservices/accounts/projects')
    | project id, name, type, kind, resourceGroup, subscriptionId, location, appId=tostring(properties.AppId)`);
}

module.exports = { forConfig, listProjects, selectProject, queryApp, listResources };
