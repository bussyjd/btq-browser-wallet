// Flat ESLint config. Two projects, because the extension and the tooling have
// different globals: `src/` is browser-only (see tsconfig.json, `types: []`),
// everything else runs in Node.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'playwright-report/**', 'test-results/**'] },

  js.configs.recommended,

  // Type-aware linting for the shipped extension.
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/manifest.config.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // A wallet must never print an RPC payload, a plan or an error object to
      // a console a page could scrape from a shared devtools session.
      'no-console': ['error', { allow: ['error', 'warn'] }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // The RPC boundary hands us `unknown`; narrowing helpers do the checking.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      // A dropped promise in a wallet is a send that silently never happened.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },

  // The MAIN-world provider is plain JS on purpose (no bundler, no imports).
  {
    files: ['src/inpage/*.js'],
    languageOptions: {
      globals: { window: 'readonly', document: 'readonly', console: 'readonly' },
    },
    rules: {
      'no-console': 'off',
      // `catch (e) { /* ignore */ }` is deliberate here: a page listener that
      // throws must not break the provider, and the file stays import-free.
      'no-unused-vars': ['error', { caughtErrors: 'none' }],
    },
  },

  // Tests, scripts and build config: Node, and not type-aware (cheap + fast).
  {
    files: ['tests/**/*.ts', 'scripts/**/*.ts', '*.config.ts', '*.config.js', 'src/manifest.config.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', globalThis: 'readonly' },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
