const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(api) {
  const location = { href: 'http://localhost/?view=distributed', search: '?view=distributed' };
  const context = vm.createContext({ api, URL, URLSearchParams, location, clearInterval,
    S: { days: 7 }, render() {}, history: { replaceState(_state, _title, url) { location.href = String(url); location.search = url.search; } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../frontend/workspaces.js'), 'utf8') + '\nglobalThis.state = W;', context);
  return context;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('switching workspaces discards an earlier registry response and its follow-up requests', async () => {
  const old = deferred(), calls = [], entries = [{ id: 'alpha' }, { id: 'beta' }];
  let registries = 0;
  const ui = harness(async (route) => {
    calls.push(route);
    if (route === '/api/workspaces') return ++registries === 1 ? old.promise : entries;
    return { label: 'beta' };
  });
  ui.state.id = 'alpha';
  const first = ui.workspaceReload();
  ui.state.id = 'beta';
  await ui.workspaceReload();
  old.resolve([{ id: 'alpha' }]);
  await first;
  assert.equal(ui.state.id, 'beta');
  assert.equal(ui.state.data.label, 'beta');
  assert.ok(!calls.some((route) => route.includes('/alpha/runs')));
  assert.equal(ui.state.busy, false);
});

test('out-of-order run responses and stale comparison errors cannot replace current selection', async () => {
  const old = deferred(), comparison = deferred();
  const ui = harness((route) => route.includes('id=old') ? old.promise : route.includes('id=compare') ? comparison.promise : Promise.resolve({ traceId: 'new' }));
  ui.state.id = 'alpha';
  const first = ui.workspaceOpen('old');
  await ui.workspaceOpen('new');
  old.resolve({ traceId: 'old' });
  await first;
  assert.equal(ui.state.run.traceId, 'new');
  const pending = ui.workspaceOpen('compare', true);
  await ui.workspaceOpen('new');
  comparison.reject(new Error('Old source failed'));
  await pending;
  assert.equal(ui.state.error, '');
  assert.equal(ui.state.compare, null);
  assert.ok(ui.location.search.includes('trace=new'));
});

test('unknown workspace deep links report missing definition instead of querying an unrelated workspace', async () => {
  const calls = [];
  const ui = harness(async (route) => { calls.push(route); return [{ id: 'alpha' }]; });
  ui.state.id = 'missing';
  await ui.workspaceReload();
  assert.match(ui.state.error, /Workspace not found locally/);
  assert.deepEqual(calls, ['/api/workspaces']);
  assert.equal(ui.state.data, null);
});

test('adding editor rows after removal does not reuse an existing source or service ID', () => {
  const ui = harness(async () => []);
  assert.equal(ui.workspaceNextId([{ id: 'source-1' }, { id: 'source-3' }], 'source'), 'source-2');
  assert.equal(ui.workspaceNextId([{ id: 'service-2' }], 'service'), 'service-1');
});
