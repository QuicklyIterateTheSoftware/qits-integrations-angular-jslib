// @ts-check
const { defineConfig } = require('eslint/config');
const rootConfig = require('../../eslint.config.js');
// The library's own lint rules, ESM (no top-level await), so `require()` loads them.
const qits = require('./eslint/index.mjs').default;

module.exports = defineConfig([
  ...rootConfig,
  {
    files: ['**/*.ts'],
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        {
          type: 'attribute',
          prefix: 'qits',
          style: 'camelCase',
        },
      ],
      '@angular-eslint/component-selector': [
        'error',
        {
          type: 'element',
          prefix: 'qits',
          style: 'kebab-case',
        },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The library navigates through declared outcomes too (ticket qits-2044); only the outcome API
    // itself, whose `QitsExit` and `go()` navigate by design, is left out.
    files: ['**/*.ts'],
    plugins: { qits },
    rules: {
      'qits/navigation-through-outcomes': [
        'error',
        { include: ['src/lib/**'], exclude: ['src/lib/outcomes/**'] },
      ],
    },
  },
  {
    // The update prompt sits in an app's shell, so it keeps to the app's semantic theme tokens
    // (ticket qits-2152). The library has no theme of its own: any fixed colour is reported.
    files: ['pwa/src/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    plugins: { qits },
    rules: {
      'qits/theme-colors': 'error',
    },
  },
  {
    files: ['**/*.html'],
    rules: {},
  },
]);
