import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// The rules of the app's repository (github.com/slidrhq/app), for these pages.
export default tseslint.config(
  // vendor/ is the app's code, copied as it is (vendor/README.md).
  { ignores: ['**/node_modules/**', '**/dist/**', 'vendor/**'] },

  js.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: reactHooks.configs.recommended.rules,
  },

  {
    // The library's server runs on Cloudflare as on a machine: its core has the web's APIs only,
    // and what is Node's is the Node host's (server/host/node).
    files: ['server/core/**/*.ts'],
    ignores: ['server/core/**/*.test.ts', 'server/core/**/testing.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*'], message: 'The core runs on Cloudflare too.' }] },
      ],
    },
  },

  {
    // Node's test runner awaits the promises its `describe` and `test` return.
    files: ['server/**/*.test.ts', 'docker/test/**/*.test.ts', 'install/test/**/*.test.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },

  {
    files: ['*.config.{js,ts}', 'scripts/**/*.mjs', 'docker/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
);
