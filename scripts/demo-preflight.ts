/**
 * Will the live demo record? Answer in about three seconds, without a browser.
 *
 *   npm run demo:preflight                       # reads ./.env.demo, or the environment
 *   npm run demo:preflight -- --check-dist       # also refuse a stale dist/
 *
 * `scripts/demo-live.sh` runs this *before* the build, so a node that is down,
 * a wallet that is empty or a phrase that does not parse costs three seconds
 * rather than ninety. `live.spec.ts` runs the same function again in `beforeAll`
 * with `checkDist: true`, so a bare `npx playwright test` refuses too.
 *
 * Exit codes: 0 ready, 1 refused (the report says why), 2 not configured.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatPreflight, liveFromEnv, preflight } from '../tests/e2e/fixtures/live.js';

/**
 * Read `.env.demo` the same way `scripts/demo-live.sh` does, so this command
 * stands alone: the README offers it as "would a take work right now?", and it
 * would be a poor answer to that question if it refused for a reason that only
 * applies when it is invoked from the other script.
 *
 * Parsed, never evaluated. A recovery phrase is twelve space-separated words,
 * so sourcing it as shell would need every value quoted — and a file of
 * credentials should be data, not code, however it arrived on the machine.
 * Real environment variables win, so `BTQ_DEMO_AMOUNT=0.05 npm run …` still works.
 */
function loadEnvFile(): void {
  const file = join(dirname(dirname(fileURLToPath(import.meta.url))), '.env.demo');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const eq = text.indexOf('=');
    if (eq < 1) continue;
    const key = text.slice(0, eq).trim();
    let value = text.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function main(): Promise<number> {
  loadEnvFile();
  let cfg;
  try {
    cfg = liveFromEnv();
  } catch (e) {
    // A missing variable is the commonest failure and the easiest to fix, so it
    // gets the whole message rather than a stack trace.
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  if (!cfg) {
    console.error(
      'demo:preflight — BTQ_LIVE is not set, so there is nothing to check. Run it through `npm run demo:preflight`, or export BTQ_LIVE=1 yourself.',
    );
    return 2;
  }
  const report = await preflight(cfg, { checkDist: process.argv.includes('--check-dist') });
  console.log(formatPreflight(cfg, report));
  return report.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`demo:preflight — ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  },
);
