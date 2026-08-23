import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    environment: 'node',
    testTimeout: 120_000,
    // Same budget for hooks. A `beforeEach` here can run a full ML-DSA-44
    // import; vitest's 10 s default made the suite fail on a loaded machine
    // while every assertion in it was passing.
    hookTimeout: 120_000,
  },
  resolve: {
    // Source uses ESM-correct .js specifiers; map them onto the .ts sources.
    alias: [{ find: /^(\.{1,2}\/.*)\.js$/, replacement: '$1.ts' }],
  },
});
