import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The end-to-end suite drives the built extension through `data-testid`
 * selectors only. If a screen is refactored and a hook disappears, the e2e run
 * fails somewhere deep in a browser with a timeout; this test fails in
 * milliseconds and names the missing selector.
 *
 * The list is the selector contract the end-to-end suite drives, in full.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const UI = join(ROOT, 'src/ui');

const REQUIRED = [
  'welcome-create',
  'welcome-import',
  'pw',
  'pw2',
  'pw-continue',
  ...Array.from({ length: 12 }, (_, i) => `seed-word-${i + 1}`),
  'seed-continue',
  'confirm-word-1',
  'confirm-seal',
  // The gate as a popup that was closed and reopened renders it: the sentence
  // saying the wallet already exists and where the phrase can still be read, the
  // password box the check needs when the create screen's copy is long gone, and
  // the way off the screen. tests/e2e/lifetime.spec.ts drives all three.
  'confirm-resumed',
  'confirm-pw',
  'confirm-leave',
  'import-mnemonic',
  'import-raw',
  'import-text',
  'import-submit',
  // The third import door — the backup file, the only one that restores the
  // account list — and the two sentences on that screen that say why the other
  // two cannot: a phrase carries keys, and btq-core derives account 0' only.
  'import-backup',
  'import-backup-file',
  'import-backup-pw',
  'import-backup-submit',
  'import-backup-error',
  'import-phrase-note',
  'import-accounts-note',
  'unlock-pw',
  'unlock-submit',
  // The vault this build cannot read: a screen of its own, not an error under
  // the password field, because the password was right.
  'unlock-too-old',
  'balance',
  'receive-address',
  'receive-path',
  'receive-qr',
  // The QR is opened on demand, so the control that opens it is part of the
  // contract too — a rename would otherwise silently skip the QR in every test.
  'toggle-qr',
  'copy-address',
  'refresh',
  // waitForLiveScan's whole value rests on this one: a failed live scan still
  // sets scanned=true, so the recording would show a confident wrong balance.
  'sync-error',
  'tab-receive',
  'tab-send',
  'tab-activity',
  'send-to',
  'send-amount',
  'send-max',
  'fee-economy',
  'fee-normal',
  'fee-priority',
  'send-review',
  'review-fee',
  'review-to',
  'review-amount',
  'review-change',
  'review-inputs',
  'send-pw',
  'send-confirm',
  'send-edit',
  'result-status',
  'result-txid',
  'result-error',
  'copy-hex',
  'activity-row',
  'activity-empty',
  'gear',
  'settings-back',
  'explorer-url',
  'node-url',
  'node-user',
  'node-pw',
  'backend-test',
  'backend-save',
  'backend-note',
  'site-row',
  'site-revoke',
  'lock-now',
  'reveal-phrase',
  'reveal-pw',
  'reveal-submit',
  'reveal-error',
  'reveal-hide',
  // The other backup control: a wallet with no phrase to show offers the HD
  // seed *instead*, never a disabled "Show recovery phrase".
  'reveal-seed',
  'reveal-seed-pw',
  'reveal-seed-submit',
  'reveal-seed-error',
  'reveal-seed-hide',
  'seed-hex',
  // Settings → Wallet backup file: the control, its password box, and the
  // sentence beside it that says what holding the file means. The warning is on
  // this list on purpose — it is the artefact's only disclosure to the user,
  // and a refactor that dropped it would otherwise pass every test.
  'export-backup',
  'export-backup-pw',
  'export-backup-submit',
  'export-backup-error',
  'export-backup-warning',
  'export-backup-saved',
  'wipe-input',
  'wipe-confirm',
  'connect-origin',
  'connect-approve',
  'connect-deny',
  'toast',
  'error',
  'account-switcher',
  'account-list',
  'account-add',
  'account-row-0',
  'account-rename',
  'account-name',
  // The one sentence that says extra accounts do not come back from the phrase,
  // rendered where the account is created — plus the disclosure that carries the
  // reasoning and the paragraph behind it. All three are on this list because the
  // note is deliberately short now: a refactor that dropped the disclosure would
  // leave the short sentence passing every test with its explanation gone.
  // tests/e2e/accounts.spec.ts drives all three.
  'account-note',
  'toggle-account-why',
  'account-why',
  // How old a non-active account's balance is. A routine refresh scans only the
  // account on screen, so every other row has to date the number it shows.
  'account-age-0',
  // Which account a site's grant is for — a connection is per (origin,
  // account), and the Settings row has to say which one it is revoking.
  'site-account',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(tsx?|html)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Every id the popup can render. Literal `data-testid="x"` and `testId="x"`
 * props, plus template ids expanded against the list they iterate — the tab
 * bar, the fee chips, the seed grid and the confirm-word inputs all build their
 * id from a loop variable.
 */
function renderedTestIds(): Set<string> {
  const blob = walk(UI)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  const ids = new Set<string>();
  for (const m of blob.matchAll(/(?:data-testid=|testId=)(?:"([^"]+)"|\{'([^']+)'\}|\{"([^"]+)"\})/g)) {
    const id = m[1] ?? m[2] ?? m[3];
    if (id !== undefined) ids.add(id);
  }
  for (const m of blob.matchAll(/(?:data-testid|testId)=\{`([^`]+)`\}/g)) {
    const tpl = m[1];
    if (tpl === undefined) continue;
    if (tpl.startsWith('seed-word-')) for (let i = 1; i <= 24; i++) ids.add(`seed-word-${i}`);
    else if (tpl.startsWith('confirm-word-')) for (let i = 1; i <= 24; i++) ids.add(`confirm-word-${i}`);
    else if (tpl.startsWith('tab-')) for (const t of ['receive', 'send', 'activity']) ids.add(`tab-${t}`);
    else if (tpl.startsWith('fee-')) for (const f of ['economy', 'normal', 'priority']) ids.add(`fee-${f}`);
    else if (tpl.startsWith('account-row-')) for (let i = 0; i < 20; i++) ids.add(`account-row-${i}`);
    else if (tpl.startsWith('account-age-')) for (let i = 0; i < 20; i++) ids.add(`account-age-${i}`);
    else ids.add(tpl);
  }
  // InlineError renders `error` unless a caller overrides testId.
  if (/testId = 'error'/.test(blob)) ids.add('error');
  return ids;
}

/**
 * The recording redaction is a *selector* contract too, and a stricter one: a
 * phrase surface the stylesheet does not name paints its characters into a
 * video shipped in this repository, and every test still passes, because the
 * tests read the DOM and the DOM is untouched. Checking it here costs
 * milliseconds; the alternative is noticing in a released video.
 */
describe('recording redaction covers every surface it declares', () => {
  const redact = readFileSync(join(ROOT, 'tests/e2e/fixtures/redact.ts'), 'utf8');
  const selectors = [...redact.matchAll(/^export const [A-Z_]+ = '([^']+)';$/gm)].map((m) => m[1]!);

  it('names four surfaces and no fewer', () => {
    // A vacuous pass is the failure mode: an empty list would satisfy every
    // loop below while covering nothing.
    expect(selectors).toEqual([
      '[data-testid^="seed-word-"]',
      '[data-word]',
      '[data-testid="import-text"]',
      '[data-testid="seed-hex"]',
    ]);
  });

  it('every declared surface appears in the stylesheet that hides it', () => {
    const css = redact.slice(redact.indexOf('const css = `'), redact.indexOf('const attach'));
    for (const selector of selectors) {
      expect(css, `${selector} is declared but never styled`).toContain(selector);
    }
  });

  it('every declared surface is an element the popup actually renders', () => {
    // A selector that matches nothing redacts nothing, and `expectRedacted`
    // only notices when a journey happens to ask about that surface.
    const rendered = renderedTestIds();
    for (const selector of selectors) {
      const exact = /^\[data-testid="([^"]+)"\]$/.exec(selector);
      const prefix = /^\[data-testid\^="([^"]+)"\]$/.exec(selector);
      if (exact) expect(rendered.has(exact[1]!), selector).toBe(true);
      else if (prefix) expect([...rendered].some((id) => id.startsWith(prefix[1]!)), selector).toBe(true);
      else expect(selector).toBe('[data-word]'); // the one attribute-only surface
    }
  });

  it('expectRedacted refuses a surface that is not on the list', () => {
    // Without this the guard is opt-in: a caller could ask about a selector
    // nothing covers and get a green tick for it.
    const guard = redact.slice(redact.indexOf('export async function expectRedacted'));
    expect(guard).toContain('[SEED_WORDS, SEED_CHALLENGE, SEED_INPUT, SEED_HEX]');
    expect(guard).toContain('add it to redact.ts');
  });
});

describe('data-testid selector contract', () => {
  const rendered = renderedTestIds();

  it('every selector the smoke test drives exists in the popup', () => {
    const missing = REQUIRED.filter((id) => !rendered.has(id));
    expect(missing, `missing data-testid: ${missing.join(', ')}`).toEqual([]);
  });

  it('the tab ids and fee ids match the lists the popup iterates', () => {
    // If TabBar's tabs or the fee presets are renamed, the expansion above goes
    // stale and the e2e selectors silently stop existing.
    const tabbar = readFileSync(join(UI, 'components/TabBar.tsx'), 'utf8');
    for (const t of ['receive', 'send', 'activity']) expect(tabbar).toContain(`id: '${t}'`);
    const types = readFileSync(join(UI, 'types.ts'), 'utf8');
    for (const f of ['economy', 'normal', 'priority']) expect(types).toContain(`id: '${f}'`);
  });
});
