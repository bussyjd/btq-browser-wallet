import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wordlist } from '@scure/bip39/wordlists/english';
import { REVEAL_TESTID, revealScreenExists } from '../e2e/fixtures/live.js';

/**
 * The live demo touches three things nothing else in this repo touches: real
 * money, a real credential, and the one Chromium flag that keeps the mocked
 * suite off the internet. None of those failures is visible in a green test
 * run — a leaked phrase still passes, a hermetic flag dropped by accident still
 * passes, a recording that quietly went live still passes. So they are asserted
 * here, in milliseconds, in `npm test`.
 *
 * Nothing in this file ever prints a secret it finds. A guard whose failure
 * message pastes the recovery phrase into a terminal and an HTML report is a
 * worse leak than the one it was guarding against, so every assertion below
 * names the file and the kind of thing, never the value.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const E2E = join(ROOT, 'tests/e2e');

/** Everything that knows about the live run, and is therefore near the secrets. */
const LIVE_FILES = [
  'tests/e2e/live.spec.ts',
  'tests/e2e/fixtures/live.ts',
  'tests/e2e/fixtures/scene.ts',
  'tests/e2e/fixtures/static-dapp.ts',
  'scripts/demo-preflight.ts',
  'scripts/demo-live.sh',
];

/** The variables that carry a secret. No tracked file may assign any of them. */
const SECRET_VARS = ['BTQ_DEMO_RPC_PASSWORD', 'BTQ_DEMO_ALICE_MNEMONIC', 'BTQ_DEMO_BOB_MNEMONIC'];

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function specFiles(): string[] {
  return readdirSync(E2E)
    .filter((n) => n.endsWith('.spec.ts'))
    .map((n) => join('tests/e2e', n))
    .sort();
}

const BIP39 = new Set<string>(wordlist);

/**
 * A run of twelve space-separated BIP39 words — a recovery phrase, written out.
 *
 * Only all-lowercase runs count, so ordinary prose (which capitalises and
 * punctuates) does not trip it, and only the *shape* is ever reported.
 */
function mnemonicRunIn(text: string): boolean {
  for (const m of text.matchAll(/[a-z]+(?:[ \n\t]+[a-z]+){11,}/g)) {
    const words = m[0].split(/\s+/);
    for (let i = 0; i + 12 <= words.length; i++) {
      if (words.slice(i, i + 12).every((w) => BIP39.has(w))) return true;
    }
  }
  return false;
}

describe('the live demo cannot leak, and cannot change the mocked suite', () => {
  it('git ignores the operator credentials file', () => {
    let ignored: boolean;
    try {
      execFileSync('git', ['check-ignore', '-q', '.env.demo'], { cwd: ROOT, stdio: 'ignore' });
      ignored = true;
    } catch (e) {
      // `git check-ignore` exits 1 for "not ignored" and 128 when it cannot run
      // at all (no git, no repository); only the first is a failure of ours.
      const status = (e as { status?: number }).status;
      if (status === 128 || status === undefined) {
        const patterns = read('.gitignore')
          .split('\n')
          .map((l) => l.trim());
        ignored = patterns.includes('.env.demo') || patterns.includes('.env.*') || patterns.includes('.env*');
        expect(ignored, '.gitignore has no pattern that covers .env.demo').toBe(true);
        return;
      }
      ignored = false;
    }
    expect(ignored, 'git would commit .env.demo — add it to .gitignore').toBe(true);
  });

  it('no live file spells out a recovery phrase', () => {
    const leaking = LIVE_FILES.filter((f) => mnemonicRunIn(read(f)));
    expect(leaking, 'these files contain twelve consecutive BIP39 words').toEqual([]);
  });

  it('no live file hard-codes a testnet address', () => {
    // Addresses are derived from the phrase at run time, so a literal one is
    // either a paste of something that should not be here or a fact that will
    // rot. Both are worth failing over.
    const leaking = LIVE_FILES.filter((f) => /tbtq1z[0-9a-z]{40,}/.test(read(f)));
    expect(leaking, 'these files contain a literal tbtq1z… address').toEqual([]);
  });

  it('no tracked file assigns a value to a BTQ_DEMO secret', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((p) => p && /\.(ts|tsx|js|json|sh|md|yml|yaml)$/.test(p));
    const offenders: string[] = [];
    for (const path of tracked) {
      const body = readFileSync(join(ROOT, path), 'utf8');
      for (const name of SECRET_VARS) {
        // `NAME=` followed by anything but end-of-line is an assignment; the
        // documentation writes `NAME=…` with an ellipsis, which is not [^\s].
        if (new RegExp(`${name}\\s*=\\s*["'\`$\\w]`).test(body)) offenders.push(`${path} (${name})`);
      }
    }
    expect(offenders, 'a secret is being assigned in a tracked file').toEqual([]);
  });

  it('one file reads the RPC password, and it is the live config', () => {
    const readers = specFiles()
      .concat(LIVE_FILES)
      .filter((f, i, a) => a.indexOf(f) === i)
      .filter((f) => read(f).includes("required('BTQ_DEMO_RPC_PASSWORD')"));
    expect(readers).toEqual(['tests/e2e/fixtures/live.ts']);
  });

  it('exactly one spec goes live, and exactly one spec is captioned', () => {
    const live = specFiles().filter((f) => read(f).includes("reach: 'live'"));
    const captioned = specFiles().filter((f) => /captions:\s*true/.test(read(f)));
    expect(live).toEqual(['tests/e2e/live.spec.ts']);
    expect(captioned).toEqual(['tests/e2e/live.spec.ts']);
  });

  it('the pacing helpers are imported by the live spec and nothing else', () => {
    const importers = specFiles().filter((f) => read(f).includes("from './fixtures/scene.js'"));
    expect(importers).toEqual(['tests/e2e/live.spec.ts']);
    // …and the same for the fixtures, so a mocked journey cannot pick up a
    // dwell through a helper file either.
    const fixtures = readdirSync(join(E2E, 'fixtures'))
      .filter((n) => n.endsWith('.ts'))
      .map((n) => join('tests/e2e/fixtures', n))
      .filter((f) => /\b(dwell|typeInto)\b/.test(read(f)));
    expect(fixtures).toEqual(['tests/e2e/fixtures/scene.ts']);
  });

  it('no end-to-end file sleeps against a page', () => {
    const stack = [E2E];
    const sleepers: string[] = [];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, name.name);
        if (name.isDirectory()) stack.push(p);
        // The call, not the word: this very repo documents its absence in prose.
        else if (/\.ts$/.test(name.name) && /\.waitForTimeout\s*\(/.test(readFileSync(p, 'utf8'))) {
          sleepers.push(relative(ROOT, p));
        }
      }
    }
    expect(sleepers, 'waitForTimeout makes a suite slow and flaky; use a real condition').toEqual([]);
  });

  it('a device with no new option is still the hermetic device it always was', () => {
    const ext = read('tests/e2e/fixtures/extension.ts');
    // The flag itself, character for character.
    expect(
      ext.includes("'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'"),
      'the hermetic host-resolver flag is gone — the mocked suite can now reach the internet',
    ).toBe(true);
    // Every default that reproduces today's behaviour.
    for (const guard of [
      "const reach = opts.reach ?? 'hermetic';",
      "const backendMode = opts.backend ?? 'preset';",
      'const viewport = opts.viewport ?? POPUP_VIEWPORT;',
      'const videoSize = opts.videoSize ?? viewport;',
      "reach === 'hermetic'",
      'opts.slowMo !== undefined ? { slowMo: opts.slowMo } : {}',
    ]) {
      expect(ext.includes(guard), `launchDevice no longer defaults via: ${guard}`).toBe(true);
    }
    // No mocked journey may opt out of any of it.
    const liveOnly = [
      /reach:\s*'/,
      /captions:\s*(?:true|false)/,
      /slowMo:\s*/,
      /videoSize:\s*/,
      /viewport:\s*\{/,
      /backend:\s*'(?:preset|none)'/,
    ];
    const optedOut = specFiles()
      .filter((f) => f !== 'tests/e2e/live.spec.ts')
      .filter((f) => liveOnly.some((re) => re.test(read(f))));
    expect(optedOut, 'a mocked spec is passing one of the live-only device options').toEqual([]);
  });

  it('the stitcher still writes the same file when it is given no argument', () => {
    expect(read('scripts/stitch-demo.sh')).toContain('OUT=${1:-demo/btq-wallet-demo.mp4}');
  });

  it('the reveal check can say no, which is the answer that matters', () => {
    // Scene 9 records a screen another change is landing. The preflight has to
    // be able to tell the operator plainly that it is not in the build yet —
    // and a check that has only ever been seen answering "yes" proves nothing.
    const ui = mkdtempSync(join(tmpdir(), 'btq-reveal-'));
    mkdirSync(join(ui, 'screens'), { recursive: true });
    writeFileSync(join(ui, 'screens', 'Settings.tsx'), 'data-testid="lock-now"');
    expect(revealScreenExists(ui)).toBe(false);
    writeFileSync(join(ui, 'screens', 'Settings.tsx'), `data-testid="${REVEAL_TESTID}"`);
    expect(revealScreenExists(ui)).toBe(true);
  });

  it('the recording the README grades and the suite recording are two files', () => {
    expect(existsSync(join(ROOT, 'demo/btq-wallet-suite.mp4'))).toBe(true);
    expect(read('package.json')).toContain('sh scripts/stitch-demo.sh demo/btq-wallet-suite.mp4');
    expect(read('scripts/demo-live.sh')).toContain('sh scripts/stitch-demo.sh demo/btq-wallet-demo.mp4');
  });
});
