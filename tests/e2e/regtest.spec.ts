/**
 * Tier 2 — the strongest evidence available: btq-core's own script interpreter
 * runs OP_CHECKSIGDILITHIUM on a transaction this extension signed.
 *
 * The extension is driven exactly as in smoke.spec.ts. The difference is behind
 * the mock node: the coins are real regtest coins paid to the wallet's own
 * witness program, and `testmempoolaccept`/`sendrawtransaction` are forwarded to
 * a live btqd. If no node is configured or reachable the whole file skips.
 *
 *   BTQ_REGTEST=1 npm run test:e2e -- tests/e2e/regtest.spec.ts
 */
import { expect, test } from '@playwright/test';
import {
  importMnemonic,
  launchDevice,
  leaveSettings,
  openSettings,
  receiveAddress,
  waitForScan,
} from './fixtures/extension.js';
import { startMockBackend } from './fixtures/mock-explorer.js';
import { golden } from './fixtures/golden.js';
import { feeForP2mrTx, formatSats } from './fixtures/consensus.js';
import {
  confirmOnRegtest,
  fundOnRegtest,
  regtestFromEnv,
  regtestProxy,
  regtestReachable,
  regtestRpc,
} from './fixtures/regtest.js';
import { addressFromHdSeed } from '../../src/core/wallet/derive.js';
import { mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';

const MNEMONIC = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const PASSWORD = 'regtest-pass-1';
const cfg = regtestFromEnv();

test('tier 2 · btq-core accepts what the extension signed', async () => {
  test.setTimeout(300_000);
  const reachable = await regtestReachable(cfg);
  test.skip(!reachable, 'set BTQ_REGTEST=1 and run a regtest btqd to exercise tier 2');
  if (!cfg) return;

  const backend = await startMockBackend();
  backend.node.proxy = regtestProxy(cfg);
  const device = await launchDevice({ name: 'device-regtest', explorerBase: backend.origin });
  try {
    const seed = mnemonicToHdSeed(MNEMONIC);
    const A0 = addressFromHdSeed(seed, 'external', 0, 'testnet').address;
    await fundOnRegtest(cfg, backend.ledger, A0, 100_000_000n);

    const popup = await device.popup();
    await importMnemonic(popup, MNEMONIC, PASSWORD);
    await waitForScan(popup);
    expect(await receiveAddress(popup)).toBe(A0);
    await expect(popup.getByTestId('balance')).toHaveText('1');

    await openSettings(popup);
    await popup.getByTestId('node-url').fill(backend.rpcUrl);
    await popup.getByTestId('node-user').fill('smoke');
    await popup.getByTestId('node-pw').fill('smoke-pass');
    await popup.getByTestId('backend-save').click();
    await leaveSettings(popup);
    await waitForScan(popup);

    await popup.getByTestId('tab-send').click();
    await popup.getByTestId('send-to').fill(golden.entries[0]!.addresses.testnet);
    await popup.getByTestId('send-amount').fill('0.25');
    await popup.getByTestId('fee-normal').click();
    await popup.getByTestId('send-review').click();
    await expect(popup.getByTestId('review-fee')).toHaveText(
      `${formatSats(feeForP2mrTx(1, 2, 2000))} tBTQ`,
    );
    await popup.getByTestId('send-pw').fill(PASSWORD);
    await popup.getByTestId('send-confirm').click();

    await expect(popup.getByTestId('result-status')).toContainText('Broadcast', { timeout: 120_000 });
    const txid = (await popup.getByTestId('result-txid').getAttribute('data-txid')) ?? '';
    expect(txid).toMatch(/^[0-9a-f]{64}$/);

    // btq-core has it, which means OP_CHECKSIGDILITHIUM verified the signature.
    await confirmOnRegtest(cfg, backend.ledger, 1);
    const onChain = await regtestRpc<{ confirmations?: number }>(cfg, 'getrawtransaction', [txid, true], false);
    expect(onChain.confirmations ?? 0).toBeGreaterThanOrEqual(1);
  } finally {
    await device.close();
    await backend.close();
  }
});
