const fs = require('node:fs');
const path = require('node:path');
const { validateRegistry, validateWorkspace, validateNote } = require('./workspaces');

const defaults = {
  project: null,
  appInsights: { status: 'missing', error: 'No project selected.' },
  manualAppId: false,
  defaultAgent: 'agent-framework-workflows-responses',
  windowDays: 30,
};

class ConfigStore {
  constructor(directory = path.join(__dirname, '..', 'data')) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'config.json');
    this.state = { settings: structuredClone(defaults) };
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!saved || !saved.settings) throw new Error('Invalid saved dashboard configuration.');
      this.state = { settings: saved.settings, ...(saved.workspaces ? { workspaces: validateRegistry(saved.workspaces) } : {}) };
      validateDefaults(this.state.settings);
      if (Object.hasOwn(saved, 'account')) this.update({});
    }
  }

  read() { return structuredClone(this.state); }

  update(patch) {
    const state = { ...this.state, ...patch };
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.state = state;
    return this.read();
  }

  saveSettings(patch) {
    return this.update({ settings: { ...this.state.settings, ...patch } }).settings;
  }

  workspaces() { return structuredClone(this.state.workspaces || []); }

  saveWorkspace(input) {
    const workspace = validateWorkspace(input);
    const entries = this.workspaces();
    const index = entries.findIndex((w) => w.id === workspace.id);
    if (index >= 0) entries[index] = { ...workspace, notes: entries[index].notes || [] };
    else entries.push({ ...workspace, notes: [] });
    const workspaces = validateRegistry(entries);
    this.update({ workspaces });
    return workspaces.find((w) => w.id === workspace.id);
  }

  deleteWorkspace(id) {
    const entries = this.workspaces();
    if (!entries.some((w) => w.id === id)) throw Object.assign(new Error('Workspace not found.'), { status: 404 });
    this.update({ workspaces: entries.filter((w) => w.id !== id) });
  }

  addNote(id, input) {
    const note = validateNote(input);
    const entries = this.workspaces();
    const workspace = entries.find((w) => w.id === id);
    if (!workspace) throw Object.assign(new Error('Workspace not found.'), { status: 404 });
    if (workspace.notes.length >= 100) throw Object.assign(new Error('Workspace annotation limit reached (100).'), { status: 409 });
    workspace.notes.push(note);
    this.update({ workspaces: entries });
    return note;
  }
}

function validateDefaults(input) {
  if (typeof input.defaultAgent !== 'string' || (input.defaultAgent && !/^[\w.-]{1,100}$/.test(input.defaultAgent))) {
    throw Object.assign(new Error('Default agent must be empty or contain up to 100 letters, numbers, underscores, dots or hyphens.'), { status: 400 });
  }
  if (![1, 7, 30, 90].includes(input.windowDays)) {
    throw Object.assign(new Error('Time window must be 1, 7, 30 or 90 days.'), { status: 400 });
  }
  return { defaultAgent: input.defaultAgent, windowDays: input.windowDays };
}

module.exports = { ConfigStore, validateDefaults };
