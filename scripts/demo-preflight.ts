/**
 * Will the live demo record? Answer in about three seconds, without a browser.
 *
 *   npm run demo:preflight                       # reads .env.demo through the shell
 *   npm run demo:preflight -- --check-dist       # also refuse a stale dist/
 *
 * `scripts/demo-live.sh` runs this *before* the build, so a node that is down,
 * a wallet that is empty or a phrase that does not parse costs three seconds
 * rather than ninety. `live.spec.ts` runs the same function again in `beforeAll`
 * with `checkDist: true`, so a bare `npx playwright test` refuses too.
 *
 * Exit codes: 0 ready, 1 refused (the report says why), 2 not configured.
 */
import { formatPreflight, liveFromEnv, preflight } from '../tests/e2e/fixtures/live.js';

async function main(): Promise<number> {
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
