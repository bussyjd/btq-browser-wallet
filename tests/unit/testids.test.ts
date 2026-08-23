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
const UI = join(dirname(fileURLToPath(import.meta.url)), '../../src/ui');

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
  'import-mnemonic',
  'import-raw',
  'import-text',
  'import-submit',
  'unlock-pw',
  'unlock-submit',
  'balance',
  'receive-address',
  'receive-path',
  'receive-qr',
  'copy-address',
  'refresh',
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
  'wipe-input',
  'wipe-confirm',
  'connect-origin',
  'connect-approve',
  'connect-deny',
  'toast',
  'error',
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
    else ids.add(tpl);
  }
  // InlineError renders `error` unless a caller overrides testId.
  if (/testId = 'error'/.test(blob)) ids.add('error');
  return ids;
}

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
