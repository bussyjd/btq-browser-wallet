/**
 * The service worker is not a place to keep anything, and onboarding is where
 * that used to bite.
 *
 * Between "write these words down" and "type three of them back" the worker
 * receives no events at all — the popup is only rendering — and Chrome ends an
 * idle MV3 worker after about thirty seconds. Anything held in memory across
 * that gap is gone while the words are still on the user's screen, which is what
 * made a careful user the one who could not finish setting up.
 *
 * The unit suite models the restart by discarding a `Keyring` and building a new
 * one over the same storage. That is deterministic and fast, and it proves the
 * wallet half. It cannot prove the *popup* half: that the twelve words on screen
 * are still usable, that the confirm screen still submits, and that a popup
 * reopened long afterwards finds its way back to the gate. So this file kills
 * the real worker in a real Chromium, twice, in the two places it hurts.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  launchDevice,
  restartServiceWorker,
  unlock,
  waitForScan,
  receiveAddress,
} from './fixtures/extension.js';
import { startMockBackend, type MockBackend } from './fixtures/mock-explorer.js';
import { SEED_WORDS, expectRedacted } from './fixtures/redact.js';
import { addressFromHdSeed } from '../../src/core/wallet/derive.js';
import { mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'lifetime-pass-1';

let backend: MockBackend;

test.beforeAll(async () => {
  backend = await startMockBackend();
});

test.afterAll(async () => {
  await backend?.close();
});

/** Welcome → password → the twelve words, read off the screen. */
async function revealPhrase(page: Page): Promise<string[]> {
  await page.getByTestId('welcome-create').click();
  await page.getByTestId('pw').fill(PASSWORD);
  await page.getByTestId('pw2').fill(PASSWORD);
  await page.getByTestId('pw-continue').click();
  await expect(page.getByTestId('seed-word-1')).toBeVisible({ timeout: 30_000 });
  await expectRedacted(page, SEED_WORDS, 12);
  const words: string[] = [];
  for (let i = 1; i <= 12; i++) {
    words.push(((await page.getByTestId(`seed-word-${i}`).textContent()) ?? '').trim());
  }
  return words;
}

/** Fill whichever three word fields the confirm screen is asking for. */
async function fillChallenge(page: Page, words: string[]): Promise<void> {
  const fields = page.locator('input[data-word]');
  const count = await fields.count();
  expect(count, 'the confirm screen asks for three words').toBe(3);
  for (let i = 0; i < count; i++) {
    const field = fields.nth(i);
    const position = Number(await field.getAttribute('data-word'));
    await field.fill(words[position - 1] ?? '');
  }
}

test('the worker dying while the phrase is on screen does not cost the user their wallet', async () => {
  test.setTimeout(180_000);
  const device = await launchDevice({ name: 'device-lifetime-a', explorerBase: backend.origin });
  try {
    const popup = await device.popup();
    const words = await revealPhrase(popup);

    // The user picks up a pen. Nothing reaches the worker for as long as that
    // takes, and Chrome collects it — modelled here as an outright kill so the
    // test neither sleeps nor depends on Chrome's idle heuristic.
    await restartServiceWorker(device, popup);

    // Proof the kill landed where it matters, and a statement of the new
    // contract in one line: the wallet already exists (it was sealed with the
    // password, before the words were painted), it is locked (the decrypted seed
    // lived in the worker that just died), and the confirmation is still owed.
    expect(await device.rpc(popup, 'wallet.status')).toMatchObject({
      hasVault: true,
      unlocked: false,
      awaitingConfirm: true,
    });

    // The popup never noticed: it holds the words in its own React state and is
    // still painting all twelve. This click and the three that follow are the
    // exact sequence that used to end in "No seed is waiting to be confirmed"
    // with the phrase still legible above the error.
    await popup.getByTestId('seed-continue').click();
    await expect(popup.getByTestId('confirm-seal')).toBeVisible();
    await fillChallenge(popup, words);
    await popup.getByTestId('confirm-seal').click();

    await expect(popup.getByTestId('balance')).toBeVisible({ timeout: 30_000 });
    await waitForScan(popup);
    // And it is the wallet whose phrase was on screen, not a second one sealed
    // from something else: the address the popup shows is the one those twelve
    // words derive, computed here from the words the test read.
    expect(await receiveAddress(popup)).toBe(
      addressFromHdSeed(mnemonicToHdSeed(words.join(' ')), 'external', 0, 'testnet').address,
    );
  } finally {
    await device.close();
  }
});

test('a setup abandoned mid-phrase comes back to the gate, not to a lost wallet', async () => {
  test.setTimeout(180_000);
  const device = await launchDevice({ name: 'device-lifetime-b', explorerBase: backend.origin });
  try {
    const first = await device.popup();
    const words = await revealPhrase(first);

    // Now lose both halves: the popup (Chrome closes it on any outside click,
    // which is what happens the moment a text editor is opened to write the
    // phrase down) and the worker behind it.
    await first.close();
    const spare = await device.popup();
    await restartServiceWorker(device, spare);
    await spare.close();

    // Reopening finds a wallet — sealed at create, and locked because the seed
    // died with the worker. Not an onboarding screen offering to generate a
    // second phrase over the top of the first.
    const popup = await device.popup();
    await expect(popup.getByTestId('unlock-pw')).toBeVisible({ timeout: 30_000 });
    await unlock(popup, PASSWORD);

    // Straight to the gate, which now says the wallet already exists and points
    // at the one place the phrase can still be read.
    const note = popup.getByTestId('confirm-resumed');
    await expect(note).toBeVisible({ timeout: 30_000 });
    await expect(note).toContainText('already created');
    await expect(note).toContainText('Settings → Security');
    // …and offers a way off the screen, because the wallet is already theirs.
    await expect(popup.getByTestId('confirm-leave')).toBeVisible();

    // The words alone are not enough here: they are checked by regenerating them
    // from the sealed vault, so the password has to open it. A wrong one fails
    // as a wrong password and leaves the gate standing.
    await fillChallenge(popup, words);
    await popup.getByTestId('confirm-pw').fill('not-the-password');
    await popup.getByTestId('confirm-seal').click();
    await expect(popup.getByTestId('error')).toContainText(/password/i);
    await expect(popup.getByTestId('confirm-seal')).toBeVisible();

    await popup.getByTestId('confirm-pw').fill(PASSWORD);
    await popup.getByTestId('confirm-seal').click();
    await expect(popup.getByTestId('balance')).toBeVisible({ timeout: 30_000 });
    await waitForScan(popup);
    expect(await receiveAddress(popup)).toBe(
      addressFromHdSeed(mnemonicToHdSeed(words.join(' ')), 'external', 0, 'testnet').address,
    );

    // Asked once. A confirmed wallet reopens on the wallet, not on the gate.
    await popup.close();
    const again = await device.popup();
    await expect(again.getByTestId('balance')).toBeVisible({ timeout: 30_000 });
    await expect(again.getByTestId('confirm-resumed')).toHaveCount(0);
  } finally {
    await device.close();
  }
});
