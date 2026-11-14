const { validateDefaults } = require('./config');
const { createDistributed, exportRun } = require('./distributed');

async function readBody(req, limit = 10000) {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw Object.assign(new Error('Content-Type must be application/json.'), { status: 415 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error(`Request body exceeds ${limit} bytes.`), { status: 413 });
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON request body.'), { status: 400 }); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Object.assign(new Error('Request body must be a JSON object.'), { status: 400 });
  return data;
}

function createApi({ store, foundry, azure }) {
  const distributed = createDistributed((appId, query) => foundry.queryApp(appId, query));
  return async function api(req, res, url) {
    const route = url.pathname;
    const method = req.method;
    if (route === '/api/azure/status' && method === 'GET') return azure.status();
    if (route === '/api/azure/login' && method === 'POST') return azure.startLogin();
    if (route === '/api/azure/login' && method === 'GET') return azure.loginStatus();
    if (route === '/api/resources' && method === 'GET') return foundry.listResources();
    if (route === '/api/workspaces' && method === 'GET') return store.workspaces();
    if (route === '/api/workspaces' && method === 'POST') return store.saveWorkspace(await readBody(req, 64000));
    const workspaceRoute = route.match(/^\/api\/workspaces\/([a-z0-9-]+)(?:\/(runs|run|export|notes))?$/);
    if (workspaceRoute) {
      const workspace = store.workspaces().find((w) => w.id === workspaceRoute[1]);
      if (!workspace) throw Object.assign(new Error('Workspace not found.'), { status: 404 });
      const action = workspaceRoute[2], q = url.searchParams;
      if (!action && method === 'DELETE') { store.deleteWorkspace(workspace.id); return { ok: true }; }
      if (action === 'notes' && method === 'POST') return store.addNote(workspace.id, await readBody(req));
      if (action === 'runs' && method === 'GET') return distributed.runs(workspace, q.get('days') || store.read().settings.windowDays);
      if (['run', 'export'].includes(action) && method === 'GET') {
        const run = await distributed.run(workspace, q.get('id'), q.get('days') || store.read().settings.windowDays);
        return action === 'export' ? exportRun(run) : run;
      }
      throw Object.assign(new Error('Workspace API route or method not found.'), { status: 404 });
    }
    if (route === '/api/config' && method === 'GET') {
      const settings = store.read().settings;
      return { ...settings, projectEndpoint: settings.project?.endpoint || '', appInsightsAppId: settings.appInsights?.appId || '' };
    }
    if (route === '/api/config' && method === 'POST') {
      return store.saveSettings(validateDefaults(await readBody(req)));
    }
    if (route === '/api/projects' && method === 'GET') return foundry.listProjects(url.searchParams.get('refresh') === '1');
    if (route === '/api/select' && method === 'POST') {
      const body = await readBody(req);
      const selection = await foundry.selectProject(body.projectId, body.appInsightsAppId);
      store.saveSettings(selection);
      return { ok: true };
    }
    const service = foundry.forConfig(store.read().settings);
    if (route === '/api/agents' && method === 'GET') return service.foundryAgents();
    if (route.startsWith('/api/wf/') && method === 'GET') {
      const q = url.searchParams;
      const single = q.get('kind') === 'agent';
      const days = q.get('days') || String(store.read().settings.windowDays);
      switch (route.slice('/api/wf/'.length)) {
        case 'agents': return service.traces.wfAgents(days);
        case 'summary': return service.traces.summary(q.get('agent'), days, single);
        case 'runs': return service.traces.runs(q.get('agent'), days, single);
        case 'run': return service.traces.run(q.get('id'));
      }
    }
    throw Object.assign(new Error('API route or method not found.'), { status: 404 });
  };
}

module.exports = { createApi };
