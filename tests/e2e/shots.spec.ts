/**
 * Re-capture the four screenshots the README embeds, from the built extension.
 *
 * Opt-in (`SHOTS=1`), because it writes files rather than asserting anything —
 * the point is that the pictures in the README are produced by the same harness
 * that tests the wallet, so they cannot drift from the shipped UI without
 * someone deliberately not re-running this.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  launchDevice, importMnemonic, waitForScan, type Device,
} from './fixtures/extension.js';
import { startMockBackend, type MockBackend } from './fixtures/mock-explorer.js';
import { addressFromHdSeed } from '../../src/core/wallet/derive.js';
import { mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';

const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PASSWORD = 'shots-pass-1';
const OUT = 'docs/screenshots';

test.skip(!process.env.SHOTS, 'set SHOTS=1 to re-capture the README screenshots');

let backend: MockBackend;
test.beforeAll(async () => { backend = await startMockBackend(); });
test.afterAll(async () => { await backend?.close(); });

/** The phrase is real, so it is blanked the same way the recording redaction blanks it. */
async function blankSeedWords(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `[data-testid^="seed-word-"] span:last-child, [data-testid^="seed-word-"] {
      color: transparent !important;
      text-shadow: none !important;
      background-image: linear-gradient(90deg, #9aa3ad 0 100%) !important;
      background-repeat: no-repeat !important;
      background-size: 72% 0.9em !important;
      background-position: right 12% center !important;
    }`,
  });
}

test('create-seed', async () => {
  const device = await launchDevice({ name: 'shots-create', explorerBase: backend.origin });
  const popup = await device.popup();
  await popup.getByTestId('welcome-create').click();
  await popup.getByTestId('pw').fill(PASSWORD);
  await popup.getByTestId('pw2').fill(PASSWORD);
  await popup.getByTestId('pw-continue').click();
  await expect(popup.getByTestId('seed-word-12')).toBeVisible({ timeout: 30_000 });
  await blankSeedWords(popup);
  await popup.screenshot({ path: `${OUT}/create-seed.png` });
  await device.close();
});

test('receive · send-review · connect', async () => {
  const device: Device = await launchDevice({ name: 'shots-main', explorerBase: backend.origin });
  const popup = await device.popup();
  const A0 = addressFromHdSeed(mnemonicToHdSeed(MNEMONIC), 'external', 0, 'testnet').address;
  backend.ledger.fund(A0, 100_000_000n);
  await importMnemonic(popup, MNEMONIC, PASSWORD);
  await waitForScan(popup);

  await popup.getByTestId('tab-receive').click();
  await expect(popup.getByTestId('receive-address')).toBeVisible();
  await popup.screenshot({ path: `${OUT}/receive.png` });

  await popup.getByTestId('tab-send').click();
  await popup.getByTestId('send-to').fill(
    addressFromHdSeed(mnemonicToHdSeed(MNEMONIC), 'external', 3, 'testnet').address,
  );
  await popup.getByTestId('send-amount').fill('0.25');
  await popup.getByTestId('send-review').click();
  await expect(popup.getByTestId('review-fee')).toBeVisible({ timeout: 30_000 });
  await popup.screenshot({ path: `${OUT}/send-review.png` });

  const site = await device.context.newPage();
  await site.goto(`${backend.origin}/dapp.html`);
  await site.evaluate(() => {
    (window as any).__p = (window as any).btq.request({ method: 'btq_requestAccounts' }).catch(() => undefined);
  });
  const marker = `connect=1&origin=${encodeURIComponent(backend.origin)}`;
  let approval: Page | undefined;
  await expect
    .poll(() => {
      approval = device.context.pages().find((p) => p.url().includes(marker));
      return Boolean(approval);
    }, { timeout: 30_000, message: 'no approval window' })
    .toBe(true);
  const win = approval as Page;
  await win.waitForSelector('[data-testid="connect-origin"]');
  await win.screenshot({ path: `${OUT}/connect.png` });

  await device.close();
});
