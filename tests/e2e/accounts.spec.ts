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
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { GAP_LIMIT } from '../../src/core/wallet/gap.js';
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
/** The second device, the one that has only ever seen the backup file. */
let restoreDevice: Device | undefined;
let restoreBackend: MockBackend | undefined;
/** Where the exported file is kept between the two tests below. */
let backupPath: string | undefined;

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
  await restoreDevice?.close();
  await restoreBackend?.close();
  await device?.close();
  await backend?.close();
});

/** Every address the mock backend was asked about, from its own request log. */
function addressesAskedAbout(requests: { url: string }[]): Set<string> {
  const out = new Set<string>();
  for (const r of requests) {
    const m = /\/api\/v1\/address\/([^/?]+)/.exec(r.url);
    if (m?.[1]) out.add(decodeURIComponent(m[1]));
  }
  return out;
}

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

test('Settings writes an encrypted backup file, and the file gives nothing away', async () => {
  // The account list is metadata: a phrase cannot carry it, and this wallet
  // will not ask a public explorer to guess it. So it has to be possible to
  // *keep* it, and this is the artefact that makes that possible.
  await openSettings(popup);

  // The disclosure is on screen before the password box is, because a file is
  // a new object in the world and the moment to say so is before it exists.
  const warning = popup.getByTestId('export-backup-warning');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('and your password');
  await expect(warning).toContainText('a BTQ wallet exists');

  await popup.getByTestId('export-backup').click();
  await popup.getByTestId('export-backup-pw').fill(PASSWORD);
  const saving = popup.waitForEvent('download');
  await popup.getByTestId('export-backup-submit').click();
  const download = await saving;

  // The name lands in a downloads folder other software indexes: it may say
  // what the file is and when it was written, and nothing about whose it is.
  expect(download.suggestedFilename()).toMatch(/^btq-wallet-backup-\d{4}-\d{2}-\d{2}\.btqbackup$/);
  for (const secret of ['Payroll', A0, A1, 'tbtq1']) {
    expect(download.suggestedFilename(), secret).not.toContain(secret);
  }

  backupPath = join(mkdtempSync(join(tmpdir(), 'btq-backup-')), download.suggestedFilename());
  await download.saveAs(backupPath);
  const bytes = readFileSync(backupPath);

  // It is the vault's own envelope, and it is sealed: no address, no account
  // name, nothing readable. Anyone holding it learns that a BTQ wallet exists,
  // which is what the warning above says and all that it says.
  expect(bytes.subarray(0, 4).toString('latin1')).toBe('BTQ1');
  const asText = bytes.toString('latin1');
  for (const secret of ['Payroll', 'Account 2', A0, A1, 'tbtq1', PASSWORD, 'hdSeedHex']) {
    expect(asText, secret).not.toContain(secret);
  }

  await expect(popup.getByTestId('export-backup-saved')).toBeVisible();
  await popup.getByTestId('settings-back').click();
  await expect(popup.getByTestId('balance')).toBeVisible();
});

test('a fresh device restores the account list from that file, asking the explorer nothing', async () => {
  // The property the whole feature exists for, in a real browser: a device that
  // has never seen this wallet ends up with both accounts and the name the user
  // chose — and it does not buy that by handing a public explorer a batch of
  // addresses belonging to an account it is only guessing at. Deleting
  // speculative discovery leaves the user better off only if this test passes.
  expect(backupPath, 'the export test must run first').toBeTruthy();

  // Its own backend, so the request log below is this device's and nothing else's.
  restoreBackend = await startMockBackend();
  restoreDevice = await launchDevice({
    name: 'device-restore',
    explorerBase: restoreBackend.origin,
    videoDir: videoDir(7, 'device-restore'),
  });
  const restored = await restoreDevice.popup();

  await restored.getByTestId('welcome-import').click();
  // The import screen says what a phrase can and cannot carry, at the moment
  // somebody is choosing between the two.
  await expect(restored.getByTestId('import-phrase-note')).toContainText('Account 1');
  await expect(restored.getByTestId('import-accounts-note')).toContainText('scriptpubkeyman.cpp:1252');

  await restored.getByTestId('import-backup').click();
  await restored.getByTestId('import-backup-file').setInputFiles(backupPath!);
  await restored.getByTestId('import-backup-pw').fill(PASSWORD);
  await restored.getByTestId('import-backup-submit').click();

  await expect(restored.getByTestId('balance')).toBeVisible({ timeout: 30_000 });
  await waitForScan(restored);
  expect(await receiveAddress(restored)).toBe(A0);

  // Snapshot before the switcher is opened: opening it is a deliberate,
  // user-initiated pass over every account, and it is allowed to ask.
  const duringRestore = addressesAskedAbout([...restoreBackend.requests]);
  expect(duringRestore.has(A1), 'the restore probed the second account').toBe(false);
  // Stronger than "not A1": every address it asked about belongs to the account
  // on screen, so nothing about the second account's chain reached the explorer.
  const allowed = new Set<string>();
  for (const chain of ['external', 'internal'] as const) {
    for (let i = 0; i <= GAP_LIMIT; i++) {
      allowed.add(addressFromHdSeed(mnemonicToHdSeed(MNEMONIC), chain, i, 'testnet', 0).address);
    }
  }
  for (const address of duringRestore) {
    expect(allowed.has(address), `${address} is not an address of the account on screen`).toBe(true);
  }

  // And the list really did come back — both accounts, with the name the user
  // gave account 1 on the other device.
  await restored.getByTestId('account-switcher').click();
  await expect(restored.getByTestId('account-list')).toBeVisible();
  await expect(restored.getByTestId('account-row-0')).toContainText('Payroll');
  await expect(restored.getByTestId('account-row-1')).toContainText('Account 2');
});
