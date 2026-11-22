// @ts-check
import js from '@eslint/js';
import security from 'eslint-plugin-security';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/release/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  security.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // Indexing typed records/arrays is everywhere and noUncheckedIndexedAccess already covers it.
      'security/detect-object-injection': 'off',
      'no-console': 'error',
    },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { parserOptions: { projectService: false, project: null } },
  },
  {
    // Playwright `page.evaluate` callbacks run in the browser.
    files: ['**/e2e/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'security/detect-non-literal-fs-filename': 'off' },
  },
  {
    // DB integration tests use an untyped client on purpose (they probe raw API behaviour) and
    // assert on every shape they read.
    files: ['supabase/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  {
    // Settings/secure-store paths derive from app.getPath('userData'), never from user input.
    files: ['apps/desktop/src/main/**/*.ts'],
    rules: { 'security/detect-non-literal-fs-filename': 'off' },
  },
);
