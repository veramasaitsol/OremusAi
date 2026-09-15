'use strict';
// ESLint v9 flat config (ENHANCEMENTS Task B).
// Scoped to the CommonJS Node backend. Rules are intentionally light — they
// surface real problems (unused vars, undefined refs) without forcing a mass
// reformat of existing code. Run: `npm run lint` (or `npm run lint:fix`).

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'db/**',
      '**/*.json',
      '**/*.sql',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.jest },
    },
    rules: {
      'no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
];
