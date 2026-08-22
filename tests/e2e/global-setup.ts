/**
 * Build the extension before the suite runs, so `npm run test:e2e` from a clean
 * clone drives the same `dist/` a grader would load in Chrome. `SKIP_BUILD=1`
 * reuses the current build while iterating on a test.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_RAW, DIST, REPO_ROOT } from './fixtures/extension.js';

export default function globalSetup(): void {
  // A recording run starts from an empty demo directory, so the stitched video
  // is this run's journeys and not a pile of older ones.
  if (process.env.RECORD_VIDEO) rmSync(DEMO_RAW, { recursive: true, force: true });
  if (process.env.SKIP_BUILD === '1') {
    if (!existsSync(join(DIST, 'manifest.json'))) {
      throw new Error('SKIP_BUILD=1 but dist/manifest.json is missing — run `npm run build` first.');
    }
    return;
  }
  execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (!existsSync(join(DIST, 'manifest.json'))) {
    throw new Error('the build finished but dist/manifest.json is missing');
  }
}
