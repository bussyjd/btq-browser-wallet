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
  importRawSeed,
  launchDevice,
  receiveAddress,
  leaveSettings,
  openSettings,
  refresh,
  unlock,
  waitForScan,
  waitForSendResult,
  type Device,
} from './fixtures/extension.js';
import { startMockBackend, type MockBackend } from './fixtures/mock-explorer.js';
import { golden } from './fixtures/golden.js';
import { videoDir } from './fixtures/video.js';
import { toHex } from './fixtures/bip341.js';
import { decodeRaw } from './fixtures/tx-decode.js';
import { verifyTransaction } from './fixtures/mock-node.js';
import { scriptHexFor } from './fixtures/btq-address.js';
import { SEED_HEX, expectRedacted } from './fixtures/redact.js';
import { sealV1 } from '../helpers/v1-vault.js';
import { addressFromHdSeed } from '../../src/core/wallet/derive.js';
import { mnemonicToEntropy, mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';
import { hexToBytes } from '../../src/core/util/hex.js';

test.describe.configure({ mode: 'serial' });

const MNEMONIC = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
const PASSWORD = 'negative-pass-1';
const NODE_USER = 'smoke';
const NODE_PASSWORD = 'smoke-pass';
/** The wallets with no phrase to show: one raw-32 import, one pre-reveal vault. */
const RAW_SEED_HEX = 'a1'.repeat(32);
const RAW_SEED_PASSWORD = 'raw-seed-pass';
const V1_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const V1_PASSWORD = 'v1-vault-pass';
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

  // Change must come back to this wallet's own internal chain — checked here as
  // well as in the send journey in smoke.spec.ts, so a change address derived
  // from the wrong chain fails in two files rather than one.
  backend.node.expectChangeScript = scriptHexFor(
    addressFromHdSeed(mnemonicToHdSeed(MNEMONIC), 'internal', 0, 'testnet').address,
  );
});

test.afterAll(async () => {
  await device?.close();
  await backend?.close();
});

test('a wrong password neither opens the vault nor signs a payment', async () => {
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

test('destinations and amounts the wallet refuses before it touches a node', async () => {
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

test('a backend that misbehaves never costs the wallet the signed bytes', async () => {
  // 1. The node accepts the transaction but answers with a different txid.
  backend.ledger.setFault('wrong-txid');
  await review(popup, DEST, '0.1');
  await popup.getByTestId('send-pw').fill(PASSWORD);
  await popup.getByTestId('send-confirm').click();
  await waitForSendResult(popup);
  await expect(popup.getByTestId('result-status')).toHaveText('Signed, not broadcast');
  await expect(popup.getByTestId('result-error')).toContainText('different transaction id');
  await expect(popup.getByTestId('copy-hex')).toBeVisible();
  // The send journey in smoke.spec.ts asserts the success pill reads exactly
  // "Broadcast via node".
  // This is its failure twin, so it must not read that in any casing: two
  // outcomes that differ only by a capital letter would let the success
  // assertion pass on a send that never left the extension.
  await expect(popup.getByTestId('result-status')).not.toHaveText(/broadcast via/i);
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
  await waitForSendResult(popup);
  await expect(popup.getByTestId('result-status')).toHaveText('Signed, not broadcast');
  await expect(popup.getByTestId('result-error')).toContainText('no broadcast route');
  await expect(popup.getByTestId('copy-hex')).toBeVisible();

  // Both attempts are in the ledger of this wallet, marked as never broadcast.
  await popup.getByTestId('tab-activity').click();
  await expect(popup.getByTestId('activity-row').filter({ hasText: 'Not broadcast' })).toHaveCount(2);
});

test('a broken explorer fails loudly instead of reporting an empty wallet', async () => {
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

  // The live indexer reports a negative `balance` (and a negative
  // `unspent_count`) for busy addresses. The wallet must sum /utxos and ignore
  // the field entirely — not show it, and not treat it as an outage either.
  backend.ledger.bogusBalance = true;
  await refresh(popup);
  await expect(popup.getByTestId('sync-error')).toHaveCount(0);
  await expect(popup.getByTestId('balance')).toHaveText('1');
  backend.ledger.bogusBalance = false;

  // …and once the explorer is healthy the balance is the real one again.
  await refresh(popup);
  await expect(popup.getByTestId('sync-error')).toHaveCount(0);
  await expect(popup.getByTestId('balance')).toHaveText('1');
});

test('storage holds the sealed vault and the unbroadcast bytes, nothing else', async () => {
  const storage = await device.storage();
  for (const key of ['vault', 'meta', 'backend', 'activity']) {
    expect(Object.keys(storage)).toContain(key);
  }

  const vault = storage.vault as string;
  expect(vault.startsWith('42545131')).toBe(true); // "BTQ1"
  expect(vault.length / 2).toBeLessThan(400);

  // A transaction no backend accepted keeps its hex, or the payment is lost.
  // "Keeps its hex" is worth nothing unless the hex is still the transaction
  // the user approved, so every stranded item is decoded and put back through
  // the node's own checks: a wallet could still push these bytes by hand.
  const activity = storage.activity as {
    txid: string;
    status: string;
    destination: string;
    amountSats: string;
    hex?: string;
  }[];
  const stranded = activity.filter((a) => a.status === 'signed');
  expect(stranded.length).toBe(2);
  const strandedAmounts: string[] = [];
  for (const item of stranded) {
    const hex = item.hex ?? '';
    expect(hex.length).toBeGreaterThan(2000);
    const decoded = decodeRaw(hex);
    expect(decoded.txid).toBe(item.txid);
    // Still valid, and still valid against the *live* ledger: nothing it spends
    // was consumed by the attempts that failed.
    const accepted = verifyTransaction(hex, backend.ledger);
    expect(accepted.checks).toEqual([
      'decode',
      'inputs-unspent',
      'witness-shape',
      'leaf-commitment',
      'signature',
      'outputs-and-fee',
      'txid',
    ]);
    expect(item.destination).toBe(DEST);
    const payee = accepted.outputs.find((o) => o.script === scriptHexFor(DEST));
    expect(payee?.value.toString()).toBe(item.amountSats);
    strandedAmounts.push(item.amountSats);
  }
  // The two amounts that were signed and never broadcast, in the order sent.
  expect([...strandedAmounts].sort()).toEqual(['10000000', '11000000']);

  const blob = JSON.stringify(storage).toLowerCase();
  expect(blob).not.toContain(toHex(mnemonicToHdSeed(MNEMONIC)));
  expect(blob).not.toContain(MNEMONIC);
  expect(blob).not.toContain(PASSWORD);
  expect(blob).not.toContain('secretkey');
  expect(blob).not.toContain('privatekey');
  // The BIP39 entropy a v2 vault seals is the phrase's preimage — sixteen bytes
  // that regenerate all twelve words. It is inside the ciphertext or it is a
  // leak; there is no third place for it to be.
  expect(toHex(mnemonicToEntropy(MNEMONIC))).toHaveLength(32);
  expect(blob).not.toContain(toHex(mnemonicToEntropy(MNEMONIC)));
  expect(blob).not.toContain('entropyhex');

  // The node's RPC credential is a different kind of secret, and the wallet
  // treats it differently: `saveBackend` writes the whole backend config to
  // chrome.storage.local, password included, in the clear. That is the real
  // behaviour — asserted here with a node actually configured, so that changing
  // it is a decision somebody makes rather than an assertion quietly going
  // vacuous. (The misbehaving-backend test above removed the node, which is
  // why the blob above holds no
  // credential at all.)
  expect((storage.backend as { node: unknown }).node).toBeNull();
  await openSettings(popup);
  await popup.getByTestId('node-url').fill(backend.rpcUrl);
  await popup.getByTestId('node-user').fill(NODE_USER);
  await popup.getByTestId('node-pw').fill(NODE_PASSWORD);
  await popup.getByTestId('backend-save').click();
  await expect(popup.getByTestId('network-pill')).toHaveText('Testnet · node');
  await leaveSettings(popup);

  const withNode = await device.storage();
  const node = (withNode.backend as { node: { url: string; user: string; password: string } | null }).node;
  expect(node?.url).toBe(backend.rpcUrl);
  expect(node?.user).toBe(NODE_USER);
  expect(node?.password).toBe(NODE_PASSWORD); // plaintext, and not the vault's key
  expect(NODE_PASSWORD).not.toBe(PASSWORD);
  // The wallet's own secrets are still absent, node or no node.
  const withNodeBlob = JSON.stringify(withNode).toLowerCase();
  expect(withNodeBlob).not.toContain(toHex(mnemonicToHdSeed(MNEMONIC)));
  expect(withNodeBlob).not.toContain(MNEMONIC);
  expect(withNodeBlob).not.toContain(PASSWORD);
  expect(withNodeBlob).not.toContain(toHex(mnemonicToEntropy(MNEMONIC)));
  expect(withNodeBlob).not.toContain('entropyhex');
});

test('a raw-seed wallet is offered its seed, not a dead phrase button', async () => {
  // A raw 32-byte HD seed has no BIP39 phrase behind it. Rendering one anyway
  // would produce a valid-looking 24-word backup whose BIP39 seed is a
  // *different* wallet — words the user writes down and cannot restore from.
  // So the phrase control is not rendered at all: greying it out tells the user
  // their wallet is broken and gives them nowhere to go. What is rendered is the
  // backup this wallet does have, and it goes straight back in through Import.
  test.setTimeout(180_000);
  // Deliberately no `videoDir`: this device is a refusal check, and the demo
  // video is stitched from every recorded clip in order.
  const raw = await launchDevice({
    name: 'device-raw-seed',
    explorerBase: backend.origin,
  });
  try {
    const page = await raw.popup();
    await importRawSeed(page, RAW_SEED_HEX, RAW_SEED_PASSWORD);
    await waitForScan(page);
    const address = await receiveAddress(page);

    await openSettings(page);
    // Not disabled — absent. There is no control on this screen whose only
    // possible outcome is an error.
    await expect(page.getByTestId('reveal-phrase')).toHaveCount(0);
    await expect(page.getByTestId('reveal-seed')).toBeEnabled();
    await expect(page.getByTestId('reveal-seed').locator('xpath=..')).toContainText(
      'It has no recovery phrase — the seed hex you imported is its backup.',
    );

    // Behind the password, exactly as the phrase is. A wrong one shows nothing
    // at all — not an empty field, not a redacted one.
    await page.getByTestId('reveal-seed').click();
    await page.getByTestId('reveal-seed-pw').fill('not-the-password');
    await page.getByTestId('reveal-seed-submit').click();
    await expect(page.getByTestId('reveal-seed-error')).toHaveText('Incorrect password.');
    await expect(page.getByTestId('seed-hex')).toHaveCount(0);

    await page.getByTestId('reveal-seed-pw').fill(RAW_SEED_PASSWORD);
    await page.getByTestId('reveal-seed-submit').click();
    await expect(page.getByTestId('seed-hex')).toBeVisible();
    await expectRedacted(page, SEED_HEX, 1);
    expect(((await page.getByTestId('seed-hex').textContent()) ?? '').trim()).toBe(RAW_SEED_HEX);
    // No clipboard button on this screen either, by design and by assertion.
    await expect(page.getByTestId('copy-address')).toHaveCount(0);

    // Reading it back wrote nothing anywhere: it still exists only in the
    // sealed vault, exactly as it did before.
    const storage = JSON.stringify(await raw.storage()).toLowerCase();
    expect(storage).not.toContain(RAW_SEED_HEX);
    expect(storage).not.toContain(RAW_SEED_PASSWORD);

    // And it is the seed this wallet actually uses: the address it derives is
    // the address on the Receive tab.
    const derived = addressFromHdSeed(hexToBytes(RAW_SEED_HEX), 'external', 0, 'testnet');
    expect(derived.address).toBe(address);

    // Hiding takes it off the screen, and so does locking — the hex lives in
    // one component's state and nowhere else.
    await page.getByTestId('reveal-seed-hide').click();
    await expect(page.getByTestId('seed-hex')).toHaveCount(0);
    await page.getByTestId('reveal-seed').click();
    await page.getByTestId('reveal-seed-pw').fill(RAW_SEED_PASSWORD);
    await page.getByTestId('reveal-seed-submit').click();
    await expect(page.getByTestId('seed-hex')).toBeVisible();
    await page.getByTestId('lock-now').click();
    await expect(page.getByTestId('unlock-pw')).toBeVisible();
    await expect(page.getByTestId('seed-hex')).toHaveCount(0);

    // The screen is a courtesy; the worker is the one that must refuse. It does
    // so only *after* the password checks out, so NO_PHRASE is not a probe a
    // passer-by at an open popup can run.
    await unlock(page, RAW_SEED_PASSWORD);
    await expect(page.getByTestId('balance')).toBeVisible();
    const refused: { threw: boolean; message: string } = await raw
      .rpc(page, 'wallet.revealPhrase', { password: RAW_SEED_PASSWORD })
      .then(
        () => ({ threw: false, message: 'wallet.revealPhrase returned a phrase for a raw seed' }),
        (e: Error) => ({ threw: true, message: e.message }),
      );
    expect(refused.threw, refused.message).toBe(true);
    expect(refused.message).toContain('NO_PHRASE');
    expect(refused.message).toContain('raw 32-byte seed');
    await expect(page.getByTestId('seed-word-1')).toHaveCount(0);
  } finally {
    await raw.close();
  }
});

test('a vault sealed before the reveal existed is offered its seed too', async () => {
  // The wallet in the bug report: a v1 vault, sealed by a build that stored no
  // BIP39 entropy. `mnemonicToHdSeed` is one-way, so those words cannot be
  // recovered by any amount of unlocking — and there is no in-place upgrade,
  // because the only thing that could seal one is the phrase, and asking the
  // user to paste their phrase "so we can upgrade the vault" is the phishing
  // script. What the vault *can* still show is the seed itself.
  test.setTimeout(180_000);
  const v1 = await launchDevice({ name: 'device-v1-vault', explorerBase: backend.origin });
  try {
    // Built by the same helper the unit tests use, so the bytes under test are
    // the bytes a pre-reveal build actually wrote — and sealed at the shipped
    // iteration count, so the real extension opens it the way a user's does.
    const written: { vault?: string; meta?: unknown } = {};
    await sealV1(
      {
        async saveVault(blob: Uint8Array) {
          written.vault = toHex(blob);
        },
        async saveMeta(meta: unknown) {
          written.meta = meta;
        },
      } as unknown as Parameters<typeof sealV1>[0],
      V1_MNEMONIC,
      V1_PASSWORD,
      {},
    );
    const worker = await v1.worker();
    await worker.evaluate(
      async (record: { vault: string; meta: unknown }) => {
        await chrome.storage.local.set(record);
      },
      { vault: written.vault!, meta: written.meta },
    );

    const page = await v1.popup();
    await unlock(page, V1_PASSWORD);
    await expect(page.getByTestId('balance')).toBeVisible({ timeout: 30_000 });
    await waitForScan(page);

    await openSettings(page);
    await expect(page.getByTestId('reveal-phrase')).toHaveCount(0);
    await expect(page.getByTestId('reveal-seed')).toBeEnabled();
    const security = page.getByTestId('reveal-seed').locator('xpath=..');
    await expect(security).toContainText('The phrase you wrote down still restores it');
    // The honest path is named, and the phishing one is named as phishing. What
    // is never offered is a field to type the phrase back into.
    await expect(security).toContainText('trying to steal it');
    await expect(page.getByTestId('import-text')).toHaveCount(0);

    await page.getByTestId('reveal-seed').click();
    await page.getByTestId('reveal-seed-pw').fill(V1_PASSWORD);
    await page.getByTestId('reveal-seed-submit').click();
    await expect(page.getByTestId('seed-hex')).toBeVisible();
    await expectRedacted(page, SEED_HEX, 1);
    const shown = ((await page.getByTestId('seed-hex').textContent()) ?? '').trim();
    // The seed the user's own written-down phrase produces — 64 bytes of it.
    expect(shown).toBe(toHex(mnemonicToHdSeed(V1_MNEMONIC)));
    expect(shown).toHaveLength(128);
    await expect(page.getByTestId('seed-word-1')).toHaveCount(0);

    const storage = JSON.stringify(await v1.storage()).toLowerCase();
    expect(storage).not.toContain(shown);
    expect(storage).not.toContain(V1_MNEMONIC);
    expect(storage).not.toContain(V1_PASSWORD);

    // And the worker still refuses the phrase, in the same words the screen used.
    const refused: { threw: boolean; message: string } = await v1
      .rpc(page, 'wallet.revealPhrase', { password: V1_PASSWORD })
      .then(
        () => ({ threw: false, message: 'wallet.revealPhrase invented a phrase for a v1 vault' }),
        (e: Error) => ({ threw: true, message: e.message }),
      );
    expect(refused.threw, refused.message).toBe(true);
    expect(refused.message).toContain('NO_PHRASE');
    expect(refused.message).toContain('sealed before');
  } finally {
    await v1.close();
  }
});
