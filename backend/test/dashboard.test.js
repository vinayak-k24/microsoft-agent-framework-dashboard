const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server');
const { ConfigStore } = require('../config');

const project = { id: '/subscriptions/test/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/account/projects/project',
  endpoint: 'https://account.services.ai.azure.com/api/projects/project', project: 'project', account: 'account', subscription: 'Test subscription' };

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-test-'));
  const calls = [];
  const foundry = {
    async listProjects() { return [project]; },
    async selectProject(id, appId) {
      if (id !== project.id || (appId && !/^[0-9a-f-]{36}$/i.test(appId))) throw Object.assign(new Error('Invalid project selection.'), { status: 400 });
      return { project, appInsights: { status: 'ok', appId: appId || '11111111-2222-3333-4444-555555555555' }, manualAppId: !!appId };
    },
    forConfig(settings) {
      const record = (name, ...args) => { calls.push({ name, args, settings }); return { name, args, project: settings.project?.id }; };
      return {
        async foundryAgents() { return record('agents'); },
        traces: {
          async wfAgents(days) { return record('wfAgents', days); },
          async summary(agent, days, single) { return record('summary', agent, days, single); },
          async runs(agent, days, single) { return record('runs', agent, days, single); },
          async run(id) { return record('run', id); },
        },
      };
    },
  };
  const azure = {
    async status() { return { connected: true, username: 'test-user' }; },
    startLogin() { return { status: 'pending', userCode: 'TEST1234' }; },
    loginStatus() { return { status: 'ok' }; },
  };
  let server, base;
  async function start() {
    server = createServer({ dataDir: directory, foundry, azure });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
  await start();
  t.after(async () => {
    await stop();
    for (const name of ['config.json', 'config.json.tmp']) {
      const file = path.join(directory, name);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(directory);
  });
  async function request(route, body, options = {}) {
    const { headers, ...overrides } = options;
    return fetch(`${base}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: headers || { 'X-Dashboard-Request': '1', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...overrides,
    });
  }
  return { directory, calls, request, async restart() { await stop(); await start(); } };
}

test('first run opens directly without a local account or session; Azure sign-in remains available', async (t) => {
  const f = await fixture(t);
  const response = await f.request('/api/config');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  const config = await response.json();
  assert.equal(config.project, null);
  assert.ok(!Object.hasOwn(config, 'account'));
  assert.deepEqual(await (await f.request('/api/azure/login', {})).json(), { status: 'pending', userCode: 'TEST1234' });
  assert.deepEqual(await (await f.request('/api/azure/login')).json(), { status: 'ok' });
  for (const route of ['/api/auth/status', '/api/auth/setup', '/api/auth/login', '/api/auth/logout']) {
    assert.equal((await f.request(route, route.endsWith('/status') ? undefined : {})).status, 404);
  }
  await f.restart();
  assert.equal((await f.request('/api/config')).status, 200);
});

test('UI settings and project overrides survive restart; invalid requests leave configuration unchanged', async (t) => {
  const f = await fixture(t);
  const appId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  assert.equal((await f.request('/api/select', { projectId: project.id, appInsightsAppId: appId })).status, 200);
  assert.equal((await f.request('/api/config', { defaultAgent: 'support-agent', windowDays: 90 })).status, 200);
  const before = await (await f.request('/api/config')).json();
  assert.equal(before.projectEndpoint, project.endpoint);
  assert.equal(before.appInsightsAppId, appId);
  assert.equal(before.manualAppId, true);
  assert.equal((await f.request('/api/config', { defaultAgent: 'valid', windowDays: 365 })).status, 400);
  assert.equal((await f.request('/api/config', { defaultAgent: "bad'agent", windowDays: 30 })).status, 400);
  assert.equal((await f.request('/api/select', { projectId: 'unknown' })).status, 400);
  assert.deepEqual(await (await f.request('/api/config')).json(), before);
  await f.restart();
  assert.deepEqual(await (await f.request('/api/config')).json(), before);
  assert.equal((await f.request('/api/select', { projectId: project.id })).status, 200);
  assert.equal((await (await f.request('/api/config')).json()).manualAppId, false);
});

test('existing configuration drops legacy local credentials without losing project or defaults', async (t) => {
  const f = await fixture(t);
  await f.request('/api/select', { projectId: project.id });
  await f.request('/api/config', { defaultAgent: 'existing-agent', windowDays: 7 });
  const file = path.join(f.directory, 'config.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const before = await (await f.request('/api/config')).json();
  fs.writeFileSync(file, JSON.stringify({ ...saved, account: { username: 'old-user', salt: 'legacy-salt', hash: 'legacy-hash' } }));
  await f.restart();
  assert.deepEqual(await (await f.request('/api/config')).json(), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { settings: saved.settings });
  await f.restart();
  assert.deepEqual(await (await f.request('/api/config')).json(), before);
});

test('request origin, JSON body and static allowlist guards reject unsafe inputs', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/config', {}, { headers: { Origin: 'https://other.example', 'X-Dashboard-Request': '1', 'Content-Type': 'application/json' } })).status, 403);
  assert.equal((await f.request('/api/config', {}, { headers: { 'Content-Type': 'application/json' } })).status, 403);
  assert.equal((await f.request('/api/config', {}, { headers: { 'X-Dashboard-Request': '1', 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.request('/api/config', {}, { body: '{' })).status, 400);
  assert.equal((await f.request('/api/config', ['invalid'])).status, 400);
  assert.equal((await f.request('/api/config', { defaultAgent: 'a'.repeat(11000), windowDays: 30 })).status, 413);
  for (const route of ['/data/config.json', '/backend/server.js', '/..%2fdata%2fconfig.json', '/unknown', '/api/unknown']) assert.equal((await f.request(route)).status, 404);
  for (const route of ['/', '/app.js', '/style.css', '/playback.js', '/healthz']) assert.equal((await f.request(route)).status, 200);
});

test('existing trace API wiring retains query arguments and persisted default window', async (t) => {
  const f = await fixture(t);
  await f.request('/api/select', { projectId: project.id });
  await f.request('/api/config', { defaultAgent: 'test-agent', windowDays: 7 });
  assert.deepEqual(await (await f.request('/api/projects')).json(), [project]);
  assert.equal((await f.request('/api/azure/status')).status, 200);
  const summary = await (await f.request('/api/wf/summary?agent=test-agent&kind=agent')).json();
  assert.deepEqual(summary.args, ['test-agent', '7', true]);
  assert.equal(summary.project, project.id);
  const runs = await (await f.request('/api/wf/runs?agent=test-agent&days=30&kind=workflow')).json();
  assert.deepEqual(runs.args, ['test-agent', '30', false]);
  assert.equal((await f.request('/api/wf/unknown')).status, 404);
});

test('corrupt persisted configuration fails explicitly instead of silently resetting settings', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-config-test-'));
  const file = path.join(directory, 'config.json');
  try {
    fs.writeFileSync(file, '{invalid');
    assert.throws(() => new ConfigStore(directory), SyntaxError);
    fs.writeFileSync(file, JSON.stringify({ settings: { defaultAgent: '', windowDays: 365 } }));
    assert.throws(() => new ConfigStore(directory), /Time window/);
  } finally { fs.unlinkSync(file); fs.rmdirSync(directory); }
});
