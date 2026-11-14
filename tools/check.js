const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
function sources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && !['node_modules', 'data', 'coverage'].includes(entry.name)) return sources(file);
    return entry.isFile() && entry.name.endsWith('.js') ? [file] : [];
  });
}

const files = ['backend', 'frontend', 'tools'].flatMap((directory) => sources(path.join(root, directory)));
files.push(path.join(root, 'eslint.config.js'));
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  if (result.error || result.status !== 0) failed = true;
}
console.log(`Syntax checked ${files.length} JavaScript files.`);
process.exitCode = failed ? 1 : 0;
