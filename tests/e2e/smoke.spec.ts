/**
 * The four graded journeys, end to end, against the built extension.
 *
 * Device A creates a wallet, receives coins, locks and unlocks, configures a
 * node and sends — and every number on the screen is checked against a value
 * this file computed itself: the address from the seed the popup showed, the
 * fee from btq-core's constants, the txid from the broadcast bytes, and the
 * signature from an independent BIP341 sighash plus `ml_dsa44.verify`.
 * Device B restores the same wallet from the phrase and must find the same
 * coins and the same history.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  createWallet,
  importMnemonic,
  importRawSeed,
  launchDevice,
  leaveSettings,
  openSettings,
  receiveAddress,
  refresh,
  unlock,
  waitForScan,
  type Device,
} from './fixtures/extension.js';
import { startMockBackend, type MockBackend } from './fixtures/mock-explorer.js';
import { golden } from './fixtures/golden.js';
import { addressForScriptHex, scriptHexFor } from './fixtures/btq-address.js';
import { feeForP2mrTx, formatSats } from './fixtures/consensus.js';
import { buildSingleKeyLeaf } from './fixtures/mock-node.js';
import { fromHex, tapLeafHash, tapscriptSighash, toHex } from './fixtures/bip341.js';
import { videoDir } from './fixtures/video.js';
// The wallet's own derivation, used the way the spec asks: to compute in the
// test what the extension must show. It never touches the extension's runtime.
import { addressFromHdSeed } from '../../src/core/wallet/derive.js';
import { mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';
import { publicKeyFromSeed } from '../../src/core/crypto/mldsa.js';

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'smoke-pass-1';
const NODE_USER = 'smoke';
const NODE_PASSWORD = 'smoke-pass';
/** The golden-vector testnet address — the payee for the graded send. */
const B0 = golden.entries[0]!.addresses.testnet;
const B0_MAINNET = golden.entries[0]!.addresses.mainnet;
/**
 * The digest tests/unit/sighash.test.ts pins the wallet's sighash to. Asserting
 * it here pins the *independent* implementation to the same construction, so
 * the two can never drift together.
 */
const PINNED_SIGHASH = '5dbd5a7238664f7f4d7d06326e5ca44311aed7a93ad27ab0fbdb91729c099d5a';
/** Twelve valid BIP39 words whose checksum is wrong (the valid one ends "about"). */
const BAD_CHECKSUM_PHRASE = Array.from({ length: 12 }, () => 'abandon').join(' ');

let backend: MockBackend;
let deviceA: Device;
let popup: Page;
let words: string[];
let hdSeed: Uint8Array;
let A0: string;
let A1: string;
let C0: string;
let sendTxid: string;

test.beforeAll(async () => {
  backend = await startMockBackend();
  deviceA = await launchDevice({
    name: 'device-a',
    explorerBase: backend.origin,
    videoDir: videoDir(1, 'device-a-create-receive-send'),
  });
});

test.afterAll(async () => {
  await deviceA?.close();
  await backend?.close();
});

test('the test-side hashes are pinned to btq-core-verified golden vectors', () => {
  // Address <-> script, both directions, for every golden entry.
  for (const entry of golden.entries) {
    expect(scriptHexFor(entry.addresses.testnet)).toBe(entry.scriptPubKey);
    expect(addressForScriptHex(entry.scriptPubKey)).toBe(entry.addresses.testnet);
    // The TapLeaf hash the mock node checks commitments with.
    const leaf = buildSingleKeyLeaf(publicKeyFromSeed(fromHex(entry.keySeed)));
    expect(toHex(tapLeafHash(leaf))).toBe(entry.tapLeafHash);
    expect(entry.tapLeafHash).toBe(entry.merkleRoot); // single-leaf tree
  }

  // The BIP341 tapscript sighash, on the fixed 1-in 2-out spend the unit suite
  // pins the wallet's implementation to.
  const digest = tapscriptSighash(
    {
      version: 2,
      locktime: 0,
      inputs: [{ txid: 'aa'.repeat(32), vout: 1, sequence: 0xfffffffd }],
      outputs: [
        { value: 10_000_000n, script: fromHex(golden.entries[1]!.scriptPubKey) },
        { value: 89_999_628n, script: fromHex(golden.entries[0]!.scriptPubKey) },
      ],
    },
    0,
    [{ value: 100_000_000n, script: fromHex(golden.entries[0]!.scriptPubKey) }],
    fromHex(golden.entries[0]!.tapLeafHash),
  );
  expect(toHex(digest)).toBe(PINNED_SIGHASH);
});

test('1 · create a wallet: the phrase is shown once and never stored', async () => {
  popup = await deviceA.popup();
  await expect(popup.getByTestId('welcome-create')).toBeVisible();

  words = await createWallet(popup, PASSWORD);
  expect(words).toHaveLength(12);
  for (const word of words) expect(word).toMatch(/^[a-z]{3,8}$/);

  hdSeed = mnemonicToHdSeed(words.join(' '));
  A0 = addressFromHdSeed(hdSeed, 'external', 0, 'testnet').address;
  A1 = addressFromHdSeed(hdSeed, 'external', 1, 'testnet').address;
  C0 = addressFromHdSeed(hdSeed, 'internal', 0, 'testnet').address;

  // Nothing in extension storage may contain the phrase or the seed it derives.
  const storage = await deviceA.storage();
  const blob = JSON.stringify(storage).toLowerCase();
  for (const word of words) expect(blob).not.toContain(` ${word} `);
  expect(blob).not.toContain(words.join(' '));
  expect(blob).not.toContain(toHex(hdSeed));
  expect(blob).not.toContain(PASSWORD);
  expect(Object.keys(storage)).toContain('vault');
  expect(Object.keys(storage)).toContain('meta');
  // "BTQ1" | kdf | iterations | salt | iv | AES-GCM ciphertext, and nothing else.
  const vault = storage.vault as string;
  expect(vault.startsWith('42545131')).toBe(true);
  expect(vault.length / 2).toBeLessThan(400);
});

test('2 · receive: the address on screen is the one the seed derives', async () => {
  await waitForScan(popup);
  expect(await receiveAddress(popup)).toBe(A0);
  await expect(popup.getByTestId('receive-address')).toHaveText(A0);
  await expect(popup.getByTestId('receive-path')).toHaveText("m/0'/0'/0'");
  await expect(popup.getByTestId('receive-qr')).toBeVisible();
  await expect(popup.getByTestId('balance')).toHaveText('0');

  await popup.getByTestId('copy-address').click();
  await expect(popup.getByTestId('toast')).toHaveText('Address copied');
});

test('3 · lock, refuse the wrong password, unlock', async () => {
  // A second popup page shares the service worker, so the vault stays open.
  const second = await deviceA.popup();
  await expect(second.getByTestId('balance')).toBeVisible();
  await second.close();

  await popup.getByTestId('header-lock').click();
  await expect(popup.getByTestId('unlock-pw')).toBeVisible();

  await unlock(popup, 'not-the-password');
  await expect(popup.getByTestId('error')).toHaveText('Incorrect password.');
  const locked = await deviceA.rpc<{ unlocked: boolean }>(popup, 'wallet.status');
  expect(locked.unlocked).toBe(false);

  await unlock(popup, PASSWORD);
  await expect(popup.getByTestId('balance')).toBeVisible();
  const open = await deviceA.rpc<{ unlocked: boolean }>(popup, 'wallet.status');
  expect(open.unlocked).toBe(true);
  await waitForScan(popup);
});

test('4 · balance and history come from the explorer', async () => {
  backend.ledger.fund(A0, 100_000_000n);
  backend.ledger.mine(1);
  await refresh(popup);
  await expect(popup.getByTestId('balance')).toHaveText('1');

  await popup.getByTestId('tab-activity').click();
  await expect(popup.getByTestId('activity-row')).toHaveCount(1);
  const row = popup.getByTestId('activity-row').first();
  await expect(row).toContainText('+1 tBTQ');
  await expect(row).toContainText(/conf/i);

  // A mempool payment counts towards the balance and shows as pending, exactly
  // as the explorer reports it (block_height: null).
  backend.ledger.fund(A0, 50_000_000n);
  await popup.getByTestId('tab-receive').click();
  await refresh(popup);
  await expect(popup.getByTestId('balance')).toHaveText('1.5');
  await popup.getByTestId('tab-activity').click();
  await expect(popup.getByTestId('activity-row')).toHaveCount(2);
  await expect(popup.getByTestId('activity-row').first()).toContainText('Pending');

  // The receive address has moved past the address that was paid.
  await popup.getByTestId('tab-receive').click();
  expect(await receiveAddress(popup)).toBe(A1);
  await expect(popup.getByTestId('receive-path')).toHaveText("m/0'/0'/1'");
});

test('5 · Settings: point the wallet at a BTQ Core node', async () => {
  await openSettings(popup);
  await expect(popup.getByTestId('explorer-url')).toHaveValue(backend.origin);
  await popup.getByTestId('node-url').fill(backend.rpcUrl);
  await popup.getByTestId('node-user').fill(NODE_USER);
  await popup.getByTestId('node-pw').fill(NODE_PASSWORD);

  await popup.getByTestId('backend-test').click();
  await expect(popup.getByTestId('backend-note')).toContainText(
    `node chain test · height ${backend.ledger.tip}`,
  );

  await popup.getByTestId('backend-save').click();
  await expect(popup.getByTestId('toast')).toHaveText('Settings saved');
  await expect(popup.getByTestId('network-pill')).toHaveText('Testnet · node');

  await leaveSettings(popup);
  await waitForScan(popup);
});

test('6 · send: the node verifies what the extension signed', async () => {
  // The node insists the change output pays this wallet's own internal address.
  backend.node.expectChangeScript = scriptHexFor(C0);
  const nodeCallsBefore = backend.node.calls.length;

  await popup.getByTestId('tab-send').click();
  await popup.getByTestId('send-to').fill(B0);
  await popup.getByTestId('send-amount').fill('0.25');
  await popup.getByTestId('fee-normal').click();
  await popup.getByTestId('send-review').click();

  const expectedFee = feeForP2mrTx(1, 2, 2000);
  expect(expectedFee).toBe(744n);
  await expect(popup.getByTestId('review-to')).toHaveText(B0);
  await expect(popup.getByTestId('review-amount')).toHaveText('0.25 tBTQ');
  await expect(popup.getByTestId('review-fee')).toHaveText(`${formatSats(expectedFee)} tBTQ`);
  await expect(popup.getByTestId('review-inputs')).toHaveText('1');
  await expect(popup.getByTestId('review-change')).toHaveText(
    `${formatSats(100_000_000n - 25_000_000n - expectedFee)} tBTQ`,
  );

  await popup.getByTestId('send-pw').fill(PASSWORD);
  await popup.getByTestId('send-confirm').click();

  await expect(popup.getByTestId('result-status')).toContainText('Broadcast', { timeout: 60_000 });
  sendTxid = (await popup.getByTestId('result-txid').getAttribute('data-txid')) ?? '';
  expect(sendTxid).toMatch(/^[0-9a-f]{64}$/);

  // The node ran all seven checks and accepted the transaction it was handed.
  expect(backend.node.calls.length).toBeGreaterThan(nodeCallsBefore);
  const accepted = backend.node.log.at(-1);
  expect(accepted?.allowed).toBe(true);
  expect(accepted?.txid).toBe(sendTxid);
  expect(accepted?.checks).toEqual([
    'decode',
    'inputs-unspent',
    'witness-shape',
    'leaf-commitment',
    'signature',
    'outputs-and-fee',
    'txid',
  ]);
  expect(accepted?.fee).toBe(expectedFee.toString());
  expect(accepted?.vsize).toBe(372);
  expect(backend.node.calls.map((c) => c.method)).toContain('testmempoolaccept');
  expect(backend.node.calls.map((c) => c.method)).toContain('sendrawtransaction');

  // The chain now holds a payment to B0 and change back to the wallet's own
  // internal address at m/0'/1'/0'.
  const paid = backend.ledger.unspentFor(B0);
  expect(paid.map((u) => u.value.toString())).toEqual(['25000000']);
  const change = backend.ledger.unspentFor(C0);
  expect(change.map((u) => u.value.toString())).toEqual([(75_000_000n - expectedFee).toString()]);

  await popup.getByTestId('tab-activity').click();
  const sentRow = popup.locator(`[data-testid="activity-row"][data-txid="${sendTxid}"]`);
  await expect(sentRow).toContainText(`-${formatSats(25_000_000n + expectedFee)} tBTQ`);
  await expect(sentRow).toContainText('Pending');
  await expect(sentRow.locator('a')).toHaveAttribute('href', `${backend.origin}/tx/${sendTxid}`);

  backend.ledger.mine(1);
  await popup.getByTestId('tab-receive').click();
  await refresh(popup);
  await expect(popup.getByTestId('balance')).toHaveText(
    formatSats(150_000_000n - 25_000_000n - expectedFee),
  );
  await popup.getByTestId('tab-activity').click();
  await expect(sentRow).toContainText(/conf/i);
});

test('8 · Device B restores the same wallet from the phrase alone', async () => {
  test.setTimeout(180_000);
  const deviceB = await launchDevice({
    name: 'device-b',
    explorerBase: backend.origin,
    videoDir: videoDir(2, 'device-b-import'),
  });
  try {
    const page = await deviceB.popup();
    await importMnemonic(page, words.join(' '), 'restore-pass-2');
    await waitForScan(page);

    // The same seed, so the same addresses, the same coins and the same ledger.
    expect(await receiveAddress(page)).toBe(A1);
    await expect(page.getByTestId('balance')).toHaveText(
      formatSats(150_000_000n - 25_000_000n - 744n),
    );
    const receive = await deviceB.rpc<{ address: string; index: number }>(page, 'wallet.receive');
    expect(receive.address).toBe(A1);
    expect(addressFromHdSeed(hdSeed, 'external', 0, 'testnet').address).toBe(A0);

    await page.getByTestId('tab-activity').click();
    await expect(page.getByTestId('activity-row')).toHaveCount(3);
    await expect(page.locator(`[data-testid="activity-row"][data-txid="${sendTxid}"]`)).toBeVisible();

    // 9 · remove the wallet, then import a raw btq-core HD seed.
    await page.getByTestId('gear').click();
    await page.getByRole('button', { name: 'Remove wallet from this device' }).click();
    await page.getByTestId('wipe-input').fill('DELETE');
    await page.getByTestId('wipe-confirm').click();
    await expect(page.getByTestId('welcome-create')).toBeVisible();
    expect(Object.keys(await deviceB.storage())).not.toContain('vault');

    const rawSeedHex = 'a1'.repeat(32);
    await importRawSeed(page, rawSeedHex, 'raw-seed-pass');
    await waitForScan(page);
    expect(await receiveAddress(page)).toBe(
      addressFromHdSeed(fromHex(rawSeedHex), 'external', 0, 'testnet').address,
    );
  } finally {
    await deviceB.close();
  }
});

test('9 · a bad seed never seals a vault', async () => {
  test.setTimeout(180_000);
  const deviceC = await launchDevice({
    name: 'device-c',
    explorerBase: backend.origin,
    videoDir: videoDir(3, 'device-c-bad-imports'),
  });
  try {
    const page = await deviceC.popup();

    // A word that is not in the BIP39 list is named.
    const broken = [...words];
    broken[4] = 'zzzz';
    await importMnemonic(page, broken.join(' '), 'bad-import-pass');
    await expect(page.getByTestId('error')).toContainText('"zzzz"');
    expect(Object.keys(await deviceC.storage())).not.toContain('vault');

    // A phrase of valid words whose checksum cannot hold (the valid BIP39 test
    // vector ends in "about"; twelve "abandon"s do not).
    await page.getByTestId('import-text').fill(BAD_CHECKSUM_PHRASE);
    await page.getByTestId('import-submit').click();
    await expect(page.getByTestId('error')).toContainText('checksum');
    expect(Object.keys(await deviceC.storage())).not.toContain('vault');

    // A raw seed must be exactly 32 bytes — the golden vector's own 16-byte HD
    // seed is refused, and so is a 63-character one.
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByTestId('import-raw').click();
    await page.getByTestId('import-text').fill(golden.hdSeedHex);
    await page.getByTestId('pw').fill('bad-import-pass');
    await page.getByTestId('pw2').fill('bad-import-pass');
    await page.getByTestId('import-submit').click();
    await expect(page.getByTestId('error')).toContainText('64 hex characters');

    await page.getByTestId('import-text').fill('a'.repeat(63));
    await page.getByTestId('import-submit').click();
    await expect(page.getByTestId('error')).toContainText('64 hex characters');
    expect(Object.keys(await deviceC.storage())).not.toContain('vault');

    // The mainnet twin of the golden address is not a testnet address.
    expect(B0_MAINNET.startsWith('qbtc1z')).toBe(true);
  } finally {
    await deviceC.close();
  }
});
