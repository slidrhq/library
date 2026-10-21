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
    // Node's test runner awaits the promises its `describe` and `test` return.
    files: ['worker/**/*.test.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },

  {
    files: ['*.config.{js,ts}', 'scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },

  {
    // The Worker of slidr-media.pages.dev, deployed as it is.
    files: ['media-site/**/*.js'],
    languageOptions: { globals: globals.serviceworker },
  },
);
