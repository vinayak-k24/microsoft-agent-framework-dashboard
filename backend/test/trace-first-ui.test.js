const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(search = '', clipboard) {
  const elements = new Map(['modal', 'tip', 'main', 'side', 'days', 'refresh', 'azurecode', 'azurecopyfeedback'].map((id) => [id, {
    innerHTML: '', textContent: '', focus() { this.focused = true; }, select() { this.selected = true; },
  }]));
  const row = { dataset: { run: 'a'.repeat(32) } };
  const location = { href: `http://localhost/${search}`, search };
  const ui = vm.createContext({ URL, URLSearchParams, location, navigator: { clipboard },
    setTimeout() { return 1; }, clearTimeout() {}, clearInterval() {},
    fetch: async () => ({ ok: true, json: async () => ({ project: { id: 'demo' } }) }),
    history: { replaceState(_state, _title, url) { location.href = String(url); location.search = url.search; } },
    document: { querySelector: (selector) => elements.get(selector.slice(1)) || null,
      querySelectorAll: (selector) => selector === 'tr[data-run]' ? [row] : [], getElementById() { return null; } },
    W: { request: 0 }, PB: {}, workspaceTimer: null,
    pbStop() {}, pbMount() {}, bindWorkspaces() {}, hideTip() {}, vPlayback() { return ''; }, vWorkspaces() { return ''; },
  });
  const source = fs.readFileSync(path.join(__dirname, '../../frontend/app.js'), 'utf8')
    .replace(/boot\(\)\.catch\(.*\);\s*$/, '');
  vm.runInContext(source + '\nglobalThis.state = S;', ui);
  return { ui, elements, row };
}

test('startup redirects disabled and unknown deep links to replay, keeping setup in Settings', async () => {
  for (const search of ['', '?view=flow', '?view=distributed', '?view=unknown']) {
    const { ui } = harness(search);
    vm.runInContext('render = () => {}; loadProjects = async () => {}; reload = async () => {};', ui);
    await ui.boot();
    assert.equal(ui.state.view, 'playback');
    assert.equal(new URL(ui.location.href).searchParams.get('view'), 'playback');
  }
  const { ui } = harness('?view=flow');
  ui.fetch = async () => ({ ok: true, json: async () => ({}) });
  vm.runInContext('render = () => {}; loadProjects = async () => {}; reload = async () => {};', ui);
  await ui.boot();
  assert.equal(ui.state.view, 'settings');
});

test('disabled pages render real disabled navigation and run rows open replay', () => {
  const { ui, elements, row } = harness('?view=runs');
  ui.state.cfg = { project: { id: 'demo' } };
  ui.state.view = 'flow';
  ui.render();
  for (const view of ['flow', 'distributed']) {
    assert.match(elements.get('side').innerHTML, new RegExp(`data-v="${view}" disabled aria-disabled="true"[^>]*>.*?disabled for now`));
  }
  ui.state.view = 'runs';
  vm.runInContext('loadRun = () => {};', ui);
  row.onclick();
  assert.equal(ui.state.view, 'playback');
  assert.equal(ui.state.runId, row.dataset.run);
  assert.equal(new URL(ui.location.href).searchParams.get('view'), 'playback');
});

test('identical pending login polls do not rerender the selected device code', async () => {
  const { ui } = harness();
  const login = { status: 'pending', userCode: 'ABCD-EFGH' };
  ui.state.azureLogin = { ...login };
  ui.fetch = async () => ({ ok: true, json: async () => ({ ...login }) });
  vm.runInContext('globalThis.renders = 0; render = () => { renders++; };', ui);
  await ui.pollAzureLogin();
  assert.equal(ui.renders, 0);
  login.userCode = 'NEW-CODE';
  await ui.pollAzureLogin();
  assert.equal(ui.renders, 1);
});

test('device login copy writes the exact code, with a visible manual-selection fallback', async () => {
  let copied;
  const success = harness('', { async writeText(code) { copied = code; } });
  success.ui.state.azureLogin = { status: 'pending', userCode: 'ABCD-EFGH' };
  await success.ui.copyAzureCode();
  assert.equal(copied, 'ABCD-EFGH');
  assert.equal(success.elements.get('azurecopyfeedback').textContent, 'Code copied.');
  for (const clipboard of [undefined, { async writeText() { throw new Error('Permission denied'); } }]) {
    const { ui, elements } = harness('', clipboard);
    ui.state.azureLogin = { status: 'pending', userCode: 'ABCD-EFGH' };
    await ui.copyAzureCode();
    assert.match(elements.get('azurecopyfeedback').textContent, /Could not copy: .*copy it manually/);
    assert.equal(elements.get('azurecode').focused, true);
    assert.equal(elements.get('azurecode').selected, true);
    ui.state.cfg = {};
    assert.match(ui.vSettings(), /id="azurecode"[^>]*readonly value="ABCD-EFGH"/);
  }
});
