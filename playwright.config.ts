import { defineConfig } from '@playwright/test';

/**
 * End-to-end suite: the built extension, a real Chromium, a deterministic
 * backend on 127.0.0.1. See tests/e2e/README.md.
 *
 * Extensions need a persistent context, which the tests create themselves (see
 * tests/e2e/fixtures/extension.ts) — hence one worker and no parallelism: each
 * journey is a device with its own chain state and must run start to finish.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    video: process.env.RECORD_VIDEO ? 'on' : 'retain-on-failure',
    trace: 'retain-on-failure',
  },
});
