/**
 * Multiple accounts, end to end, in the built extension.
 *
 * The unit suite proves the keyring keeps two accounts apart. What only a real
 * browser can prove is the part the user touches: that the switcher renders and
 * moves the address on screen, that a lock closes it instead of re-opening a
 * modal full of addresses over the unlock screen, and that a site approved on
 * one account is told it sees nothing when the user moves to another.
 *
 * Every address this file asserts is derived here, from the phrase, before the
 * extension is asked anything.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  importMnemonic,
  launchDevice,
  openSettings,
  receiveAddress,
  unlock,
  waitForScan,
  type Device,
} from './fixtures/extension.js';
import { startMockBackend, type MockBackend } from './fixtures/mock-explorer.js';
import { videoDir } from './fixtures/video.js';
import { addressFromHdSeed } from '../../src/core/wallet/derive.js';
import { mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';

test.describe.configure({ mode: 'serial' });

const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PASSWORD = 'accounts-pass-1';

let backend: MockBackend;
let device: Device;
let popup: Page;
let site: Page;
let origin: string;
/** m/0'/0'/0' and m/1'/0'/0' — Core's account, and this wallet's second one. */
let A0: string;
let A1: string;

/** `window.btq.request(...)`, resolved or rejected, as plain data. */
async function providerRequest(page: Page, method: string): Promise<Record<string, unknown>> {
  return page.evaluate(
    async (m) =>
      (window as any).btq.request({ method: m }).then(
        (result: unknown) => ({ result }),
        (e: { message?: string; code?: number }) => ({ error: e.message, code: e.code }),
      ) as Promise<Record<string, unknown>>,
    method,
  );
}

/** The approval window the worker opens for one origin. */
async function approvalWindowFor(want: string): Promise<Page> {
  const marker = `connect=1&origin=${encodeURIComponent(want)}`;
  let found: Page | undefined;
  await expect
    .poll(
      () => {
        found = device.context.pages().find((p) => p.url().includes(marker));
        return Boolean(found);
      },
      { timeout: 30_000, message: `no approval window for ${want}` },
    )
    .toBe(true);
  const page = found as Page;
  await page.waitForSelector('[data-testid="connect-origin"]');
  return page;
}

/**
 * Wait until the wallet is really showing `want`, then until its scan settles.
 *
 * A switch is a click, an RPC, and a re-scan: for the first moments after the
 * click the popup is still showing the previous account's finished screen, so
 * `waitForScan` alone can return on a state that has not moved yet. Polling the
 * address is the barrier, and it fails loudly if the switch never lands.
 */
async function expectAddress(page: Page, want: string): Promise<void> {
  await expect
    .poll(() => receiveAddress(page), {
      timeout: 30_000,
      message: `the popup never showed ${want}`,
    })
    .toBe(want);
  await waitForScan(page);
}

async function openSwitcher(page: Page): Promise<void> {
  // Idempotent: the overlay's dismiss backdrop covers the header, so clicking
  // the header button while the panel is already open only closes it again.
  if ((await page.getByTestId('account-list').count()) === 0) {
    await page.getByTestId('account-switcher').click();
  }
  await expect(page.getByTestId('account-list')).toBeVisible();
  // Opening the panel is what refreshes the accounts that are not active — a
  // routine refresh scans only the account on screen. Wait for that pass to
  // land: any RPC that comes back LOCKED closes the panel and moves the popup
  // to the unlock screen, so a click issued while it is still in flight is a
  // click racing an answer, not a test of anything.
  await expect(page.locator('[data-testid^="account-age-"]').filter({ hasText: 'Checking' })).toHaveCount(
    0,
    { timeout: 60_000 },
  );
}

async function closeSwitcher(page: Page): Promise<void> {
  if ((await page.getByTestId('account-list').count()) === 0) return;
  // Top-left corner: the backdrop is `inset: 0` and the panel sits inside the
  // overlay's 48px top padding, so this is backdrop and not panel.
  await page.getByLabel('Close accounts').click({ position: { x: 4, y: 4 } });
  await expect(page.getByTestId('account-list')).toHaveCount(0);
}

test.beforeAll(async () => {
  backend = await startMockBackend();
  origin = backend.origin;
  device = await launchDevice({
    name: 'device-accounts',
    explorerBase: backend.origin,
    videoDir: videoDir(6, 'device-accounts'),
  });
  const hd = mnemonicToHdSeed(MNEMONIC);
  A0 = addressFromHdSeed(hd, 'external', 0, 'testnet', 0).address;
  A1 = addressFromHdSeed(hd, 'external', 0, 'testnet', 1).address;
  expect(A1).not.toBe(A0);

  popup = await device.popup();
  await importMnemonic(popup, MNEMONIC, PASSWORD);
  await waitForScan(popup);
  expect(await receiveAddress(popup)).toBe(A0);
});

test.afterAll(async () => {
  await device?.close();
  await backend?.close();
});

test('Add account moves the wallet to m/1’/0’/0’, and switching back returns', async () => {
  await openSwitcher(popup);
  await expect(popup.getByTestId('account-row-0')).toContainText('Account 1');

  // The honest sentence, at the point the account is created — btq-core cannot
  // derive this account from the seed, and the wallet will not go asking a
  // public explorer how many accounts there were: the user writes that down and
  // presses Add account again.
  const note = popup.getByTestId('account-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('btq-core');
  await expect(note).toContainText('Add account');
  await expect(note).toContainText('Write down how many you made');

  await popup.getByTestId('account-add').click();
  await expectAddress(popup, A1);
  await expect(popup.getByTestId('account-switcher')).toContainText('Account 2');
  await expect(popup.getByTestId('receive-path')).toContainText("m/1'/0'/0'");

  await openSwitcher(popup);
  await expect(popup.getByTestId('account-row-1')).toBeVisible();
  // A routine refresh scans the active account only, so Account 1's balance is
  // whatever the last pass that included it found — and the row says so rather
  // than letting an old number read as current.
  await expect(popup.getByTestId('account-age-0')).toBeVisible();
  await popup.getByTestId('account-row-0').click();
  await expectAddress(popup, A0);
  await expect(popup.getByTestId('account-switcher')).toContainText('Account 1');
});

test('a rename is what the header shows, and it survives a reopen', async () => {
  await openSwitcher(popup);
  await popup.getByTestId('account-rename').click();
  await popup.getByTestId('account-name').fill('Payroll');
  await popup.getByRole('button', { name: 'Save' }).click();
  await expect(popup.getByTestId('account-switcher')).toContainText('Payroll');

  const reopened = await device.popup();
  await expect(reopened.getByTestId('account-switcher')).toContainText('Payroll');
  await reopened.close();
  await closeSwitcher(popup);
});

test('a lock closes the switcher instead of re-opening it over the unlocked wallet', async () => {
  // The bug this pins: `accountsOpen` was cleared by the Lock button but not by
  // the auto-lock handler, and the overlay is only *hidden* while the screen is
  // 'unlock'. Unlocking puts the screen back to 'home', so the first thing on
  // screen after re-typing the password was a modal listing every account and
  // its address — the state the user had just locked the wallet to leave.
  await openSwitcher(popup);

  // Lock the worker from outside this popup, the way the inactivity alarm does:
  // this popup learns about it from its next RPC, through the same LOCKED path.
  const other = await device.popup();
  await device.rpc(other, 'wallet.lock');
  await other.close();

  // The user, who does not know the wallet locked itself, clicks another
  // account. (It has to be a click inside the panel: the switcher's own
  // backdrop covers the header, so nothing up there is reachable while it is
  // open — which is exactly why the modal must not survive the lock.)
  await popup.getByTestId('account-row-1').click();
  await expect(popup.getByTestId('unlock-submit')).toBeVisible({ timeout: 30_000 });
  await expect(popup.getByTestId('account-list')).toHaveCount(0);

  await unlock(popup, PASSWORD);
  await waitForScan(popup);
  // The assertion the fix is about: back on the wallet, and not behind a modal
  // listing every account and address.
  await expect(popup.getByTestId('account-list')).toHaveCount(0);
  await expect(popup.getByTestId('balance')).toBeVisible();
  await expect(popup.getByTestId('account-switcher')).toBeVisible();
});

test('a site approved on one account is told it sees nothing on another', async () => {
  // The leak this pins: grants were stored per origin alone and the worker
  // pushed the new address to every connected site on a switch. A user who made
  // a second account precisely to keep it away from this site had it handed
  // over the moment they switched, with no prompt.
  site = await device.context.newPage();
  await site.goto(`${origin}/dapp.html`);
  await expect(site.getByTestId('dapp-out')).toHaveText('provider: window.btq detected');
  expect(await providerRequest(site, 'btq_accounts')).toEqual({ result: [] });

  const pending = site.evaluate(
    async () =>
      (window as any).btq.request({ method: 'btq_requestAccounts' }).then(
        (result: unknown) => ({ result }),
        (e: { message?: string; code?: number }) => ({ error: e.message, code: e.code }),
      ) as Promise<Record<string, unknown>>,
  );
  const approval = await approvalWindowFor(origin);
  await approval.getByTestId('connect-approve').click();
  expect(await pending).toEqual({ result: [A0] });
  expect(await providerRequest(site, 'btq_accounts')).toEqual({ result: [A0] });

  // Settings names the account the grant is for, not just the site.
  await openSettings(popup);
  await expect(popup.getByTestId('site-row')).toHaveCount(1);
  await expect(popup.getByTestId('site-account')).toContainText('Payroll');
  await popup.getByTestId('settings-back').click();
  await expect(popup.getByTestId('balance')).toBeVisible();

  // Switch to the second account: the site is told it sees nothing, and asking
  // again gets it nothing.
  await openSwitcher(popup);
  await popup.getByTestId('account-row-1').click();
  await expectAddress(popup, A1);
  await expect
    .poll(async () => (await providerRequest(site, 'btq_accounts')).result, {
      timeout: 15_000,
      message: 'the site kept an address across the account switch',
    })
    .toEqual([]);
  // The page's own `accountsChanged` listener is what a dapp really reacts to,
  // and it must have been told the empty set — not handed a new address.
  await expect(site.getByTestId('dapp-out')).toHaveText('accountsChanged: []', { timeout: 15_000 });
  // Not merely absent from the answer: the address never reached the page.
  expect(await site.content()).not.toContain(A1);

  // Back on the approved account, the site sees its address again.
  await openSwitcher(popup);
  await popup.getByTestId('account-row-0').click();
  await expectAddress(popup, A0);
  await expect
    .poll(async () => (await providerRequest(site, 'btq_accounts')).result, { timeout: 15_000 })
    .toEqual([A0]);
});
