/**
 * The paths that must fail, and must fail visibly.
 *
 * A wallet is judged by what it refuses: a wrong password that neither opens the
 * vault nor signs, a destination on the wrong chain, an amount below the node's
 * dust floor, more than the balance — and, when a backend misbehaves, a signed
 * transaction whose bytes are never lost and an explorer outage that never reads
 * as "you have no coins".
 */
import { expect, test, type Page } from '@playwright/test';
import {
  importMnemonic,
  launchDevice,
  leaveSettings,
  openSettings,
  refresh,
  unlock,
  waitForScan,
  type Device,
} from './fixtures/extension.js';
import { startMockBackend, type MockBackend } from './fixtures/mock-explorer.js';
import { golden } from './fixtures/golden.js';
import { videoDir } from './fixtures/video.js';
import { toHex } from './fixtures/bip341.js';
import { addressFromHdSeed } from '../../src/core/wallet/derive.js';
import { mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';

test.describe.configure({ mode: 'serial' });

const MNEMONIC = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
const PASSWORD = 'negative-pass-1';
const NODE_USER = 'smoke';
const NODE_PASSWORD = 'smoke-pass';
/** A valid testnet payee: the golden vector's own address. */
const DEST = golden.entries[0]!.addresses.testnet;
const DEST_MAINNET = golden.entries[0]!.addresses.mainnet;

let backend: MockBackend;
let device: Device;
let popup: Page;
let A0: string;

/** Fill the send form and press Review. */
async function review(page: Page, destination: string, amount: string): Promise<void> {
  await page.getByTestId('send-to').fill(destination);
  await page.getByTestId('send-amount').fill(amount);
  await page.getByTestId('send-review').click();
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  backend = await startMockBackend();
  device = await launchDevice({
    name: 'device-negative',
    explorerBase: backend.origin,
    videoDir: videoDir(5, 'device-negative'),
  });
  A0 = addressFromHdSeed(mnemonicToHdSeed(MNEMONIC), 'external', 0, 'testnet').address;
  backend.ledger.fund(A0, 100_000_000n);
  backend.ledger.mine(1);

  popup = await device.popup();
  await importMnemonic(popup, MNEMONIC, PASSWORD);
  await waitForScan(popup);
  await expect(popup.getByTestId('balance')).toHaveText('1');

  // Without a node the Send screen says so up front.
  await popup.getByTestId('tab-send').click();
  await expect(popup.getByTestId('no-node-note')).toBeVisible();
  await popup.getByTestId('tab-receive').click();

  await openSettings(popup);
  await popup.getByTestId('node-url').fill(backend.rpcUrl);
  await popup.getByTestId('node-user').fill(NODE_USER);
  await popup.getByTestId('node-pw').fill(NODE_PASSWORD);
  await popup.getByTestId('backend-save').click();
  await expect(popup.getByTestId('network-pill')).toHaveText('Testnet · node');
  await leaveSettings(popup);
  await waitForScan(popup);
});

test.afterAll(async () => {
  await device?.close();
  await backend?.close();
});

test('N1 · a wrong password neither opens the vault nor signs a payment', async () => {
  await popup.getByTestId('header-lock').click();
  await expect(popup.getByTestId('unlock-pw')).toBeVisible();
  await unlock(popup, 'not-the-password');
  await expect(popup.getByTestId('error')).toHaveText('Incorrect password.');
  expect((await device.rpc<{ unlocked: boolean }>(popup, 'wallet.status')).unlocked).toBe(false);

  await unlock(popup, PASSWORD);
  await waitForScan(popup);

  // Re-authentication happens before anything is signed, so a wrong password
  // here must produce no signature, no broadcast and no activity row.
  const nodeCallsBefore = backend.node.calls.length;
  const activityBefore = ((await device.storage()).activity as unknown[] | undefined)?.length ?? 0;

  await popup.getByTestId('tab-send').click();
  await expect(popup.getByTestId('no-node-note')).toHaveCount(0);
  await review(popup, DEST, '0.1');
  await popup.getByTestId('send-pw').fill('not-the-password');
  await popup.getByTestId('send-confirm').click();
  await expect(popup.getByTestId('error')).toHaveText('Incorrect password.');
  await expect(popup.getByTestId('result-status')).toHaveCount(0);

  expect(backend.node.calls.length).toBe(nodeCallsBefore);
  const activityAfter = ((await device.storage()).activity as unknown[] | undefined)?.length ?? 0;
  expect(activityAfter).toBe(activityBefore);
  await popup.getByTestId('send-edit').click();
});

test('N2 · destinations and amounts the wallet refuses before it touches a node', async () => {
  const nodeCallsBefore = backend.node.calls.length;

  // The mainnet twin of the same key: right wallet, wrong chain.
  await review(popup, DEST_MAINNET, '0.1');
  await expect(popup.getByTestId('error')).toContainText('testnet');

  // A Bitcoin address is a different mistake with its own sentence.
  await review(popup, 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', '0.1');
  await expect(popup.getByTestId('error')).toContainText('Bitcoin address');

  // btq-core's dust floor for a P2MR output is 270 sats: 200 is dust, 300 is not.
  await review(popup, DEST, '0.000002');
  await expect(popup.getByTestId('error')).toContainText('dust threshold (270 sats)');
  await review(popup, DEST, '0.000003');
  await expect(popup.getByTestId('review-amount')).toHaveText('0.000003 tBTQ');
  await popup.getByTestId('send-edit').click();

  // More than the wallet holds.
  await review(popup, DEST, '9999');
  await expect(popup.getByTestId('error')).toContainText('Not enough balance');

  // None of that reached the node.
  expect(backend.node.calls.length).toBe(nodeCallsBefore);
});

test('N3 · a backend that misbehaves never costs the wallet the signed bytes', async () => {
  // 1. The node accepts the transaction but answers with a different txid.
  backend.ledger.setFault('wrong-txid');
  await review(popup, DEST, '0.1');
  await popup.getByTestId('send-pw').fill(PASSWORD);
  await popup.getByTestId('send-confirm').click();
  await expect(popup.getByTestId('result-status')).toHaveText('Signed, not broadcast', {
    timeout: 60_000,
  });
  await expect(popup.getByTestId('result-error')).toContainText('different transaction id');
  await expect(popup.getByTestId('copy-hex')).toBeVisible();
  // The node did run its checks and did accept the bytes — the wallet refused
  // to call it a broadcast because the id came back wrong.
  expect(backend.node.log.at(-1)?.allowed).toBe(true);
  backend.ledger.setFault('wrong-txid', false);

  // 2. With no node at all, the explorer has no push route to offer.
  await openSettings(popup);
  await popup.getByTestId('node-url').fill('');
  await popup.getByTestId('backend-save').click();
  await expect(popup.getByTestId('network-pill')).toHaveText('Testnet');
  await leaveSettings(popup);
  await popup.getByTestId('tab-receive').click();
  await waitForScan(popup);

  await popup.getByTestId('tab-send').click();
  await expect(popup.getByTestId('no-node-note')).toBeVisible();
  await review(popup, DEST, '0.11');
  await popup.getByTestId('send-pw').fill(PASSWORD);
  await popup.getByTestId('send-confirm').click();
  await expect(popup.getByTestId('result-status')).toHaveText('Signed, not broadcast', {
    timeout: 60_000,
  });
  await expect(popup.getByTestId('result-error')).toContainText('no broadcast route');
  await expect(popup.getByTestId('copy-hex')).toBeVisible();

  // Both attempts are in the ledger of this wallet, marked as never broadcast.
  await popup.getByTestId('tab-activity').click();
  await expect(popup.getByTestId('activity-row').filter({ hasText: 'Not broadcast' })).toHaveCount(2);
});

test('N4 · a broken explorer fails loudly instead of reporting an empty wallet', async () => {
  await popup.getByTestId('tab-receive').click();

  // A hostile row: the right address, somebody else's scriptPubKey.
  backend.ledger.setFault('swap-address');
  await refresh(popup);
  await expect(popup.getByTestId('sync-error')).toContainText('scriptPubKey');
  backend.ledger.setFault('swap-address', false);

  // A dead explorer is an outage, never "no coins".
  backend.ledger.setFault('http-500');
  await refresh(popup);
  await expect(popup.getByTestId('sync-error')).toContainText('HTTP 500');
  backend.ledger.setFault('http-500', false);

  // A slow explorer keeps the refresh control busy rather than silently idle.
  backend.ledger.slowMs = 150;
  backend.ledger.setFault('slow');
  await popup.getByTestId('refresh').click();
  await expect(popup.getByTestId('refresh')).toBeDisabled();
  backend.ledger.setFault('slow', false);
  await waitForScan(popup);

  // …and once the explorer is healthy the balance is the real one again.
  await refresh(popup);
  await expect(popup.getByTestId('sync-error')).toHaveCount(0);
  await expect(popup.getByTestId('balance')).toHaveText('1');
});

test('N5 · storage holds the sealed vault and the unbroadcast bytes, nothing else', async () => {
  const storage = await device.storage();
  for (const key of ['vault', 'meta', 'backend', 'activity']) {
    expect(Object.keys(storage)).toContain(key);
  }

  const vault = storage.vault as string;
  expect(vault.startsWith('42545131')).toBe(true); // "BTQ1"
  expect(vault.length / 2).toBeLessThan(400);

  // A transaction no backend accepted keeps its hex, or the payment is lost.
  const activity = storage.activity as { status: string; hex?: string }[];
  const stranded = activity.filter((a) => a.status === 'signed');
  expect(stranded.length).toBe(2);
  for (const item of stranded) expect((item.hex ?? '').length).toBeGreaterThan(2000);

  const blob = JSON.stringify(storage).toLowerCase();
  expect(blob).not.toContain(toHex(mnemonicToHdSeed(MNEMONIC)));
  expect(blob).not.toContain(MNEMONIC);
  expect(blob).not.toContain(PASSWORD);
  expect(blob).not.toContain(NODE_PASSWORD);
  expect(blob).not.toContain('secretkey');
  expect(blob).not.toContain('privatekey');
});
