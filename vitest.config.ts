import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
  resolve: {
    // Source uses ESM-correct .js specifiers; map them onto the .ts sources.
    alias: [{ find: /^(\.{1,2}\/.*)\.js$/, replacement: '$1.ts' }],
  },
});
