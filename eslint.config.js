const globals = require('globals');

// Correctness checks only: retain the existing formatting and shared browser scripts.
const rules = {
  'constructor-super': 'error',
  'for-direction': 'error',
  'getter-return': 'error',
  'no-async-promise-executor': 'error',
  'no-const-assign': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-dupe-else-if': 'error',
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-invalid-regexp': 'error',
  'no-promise-executor-return': 'error',
  'no-setter-return': 'error',
  'no-this-before-super': 'error',
  'no-unexpected-multiline': 'error',
  'no-unreachable': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'valid-typeof': 'error',
};

module.exports = [
  { ignores: ['node_modules/**', 'data/**', 'coverage/**'] },
  {
    files: ['backend/**/*.js', 'tools/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: globals.node },
    rules: { ...rules, 'no-undef': 'error' },
  },
  {
    files: ['frontend/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: globals.browser },
    rules,
  },
];
