/**
 * The popup ⇄ service-worker contract (v2). The popup codes against exactly
 * these shapes, so a silent change here is a broken UI at best and a
 * mis-rendered amount at worst.
 */
import { describe, it, expect } from 'vitest';
import { Keyring } from '../../src/core/wallet/keyring.js';
import { dispatch } from '../../src/core/rpc/dispatch.js';
import { WALLET_METHODS } from '../../src/core/rpc/protocol.js';
import { scriptForAddress } from '../../src/core/script/address.js';
import { MemoryWalletStorage, TEST_ENCRYPT } from '../helpers/memory-store.js';
import type { ExplorerUtxo } from '../../src/core/explorer/utxo.js';
import vectors from '../vectors/golden.json' with { type: 'json' };

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'testnet-ok';
const DEST = vectors.entries[1]!.addresses.testnet;
const TIP = { height: 300_741, hash: 'aa'.repeat(32) };

function ring() {
  return new Keyring(new MemoryWalletStorage(), { encrypt: TEST_ENCRYPT, network: 'testnet' });
}

function coinsAt(address: string): (a: string) => Promise<ExplorerUtxo[]> {
  return async (a) =>
    a === address
      ? [{ txid: 'ab'.repeat(32), vout: 0, value: 100_000_000n, script: scriptForAddress(a, 'testnet'), blockHeight: 300_000 }]
      : [];
}

describe('wallet RPC contract v2', () => {
  it('exposes every method the popup calls', () => {
    for (const m of [
      'wallet.status',
      'wallet.scan',
      'wallet.tip',
      'wallet.maxSpendable',
      'wallet.prepareSend',
      'wallet.confirmSend',
      'wallet.history',
      'wallet.revealPhrase',
      'wallet.revealSeedHex',
      'wallet.exportBackup',
      'wallet.importBackup',
    ]) {
      expect(WALLET_METHODS.includes(m as never), m).toBe(true);
    }
  });

  it('wallet.exportBackup answers with a file name and sealed bytes, and nothing else', async () => {
    // The popup builds a download out of exactly these two fields. A third one
    // would be a third thing crossing the channel from an open vault, and a
    // renamed one is a Settings button that silently stops working.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    await k.createAccount();
    const result = (await dispatch(
      k,
      { method: 'wallet.exportBackup', params: { password: PASSWORD } },
      { fromTab: false },
    )) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(['backupHex', 'fileName']);
    expect(result.fileName).toMatch(/^btq-wallet-backup-\d{4}-\d{2}-\d{2}\.btqbackup$/);
    expect(result.backupHex).toMatch(/^[0-9a-f]+$/);
    // Hex, not bytes: `chrome.runtime.sendMessage` serialises as JSON, and a
    // Uint8Array crosses it as {"0":1,…} — which the popup would then have to
    // guess the shape of.
    expect(typeof result.backupHex).toBe('string');
  });

  it('wallet.importBackup answers with ok and the account indices it restored', async () => {
    const source = ring();
    await source.importMnemonic(MNEMONIC, PASSWORD);
    await source.createAccount();
    const { backupHex } = (await dispatch(
      source,
      { method: 'wallet.exportBackup', params: { password: PASSWORD } },
      { fromTab: false },
    )) as { backupHex: string };

    const fresh = ring();
    const restored = (await dispatch(
      fresh,
      { method: 'wallet.importBackup', params: { backupHex, password: PASSWORD } },
      { fromTab: false },
    )) as Record<string, unknown>;
    expect(restored).toEqual({ ok: true, accounts: [0, 1] });
    expect((await fresh.status()).accounts.map((a) => a.index)).toEqual([0, 1]);
  });

  it('wallet.status carries the balance, tip and scan-time fields', async () => {
    const k = ring();
    const status = (await dispatch(k, { method: 'wallet.status' }, { fromTab: false })) as Record<string, unknown>;
    for (const key of [
      'hasVault',
      'unlocked',
      // The confirmation gate, and the positions it asks for. Both are on the
      // contract because the popup routes on them: a wallet sealed at create
      // but never confirmed has to come back to the confirm screen after the
      // popup, or the worker, or the browser has been closed.
      'awaitingConfirm',
      'confirmChallenge',
      'network',
      'origin',
      'externalNext',
      'internalNext',
      'usedExternal',
      'usedInternal',
      'lastBalanceSats',
      'confirmedBalanceSats',
      'tipHeight',
      'lastScanAt',
      'backup',
      'canRevealPhrase',
      'activeAccount',
      'accounts',
    ]) {
      expect(Object.hasOwn(status, key), key).toBe(true);
    }
    expect(status.lastBalanceSats).toBe('0');
    expect(status.confirmedBalanceSats).toBe('0');
    // No vault, so nothing to confirm — never a gate in front of nothing.
    expect(status.awaitingConfirm).toBe(false);
    expect(status.confirmChallenge).toBeNull();
    // A locked keyring — here, one with no vault at all — must answer "no".
    // The popup gates the reveal button on `=== true`, so an omitted or
    // truthy-by-accident value would offer a button that can only fail.
    expect(status.canRevealPhrase).toBe(false);
    // …and `backup` must answer "render no control", not "render the seed one":
    // null is the locked answer, and the popup draws nothing for it.
    expect(status.backup).toBeNull();
  });

  it('wallet.prepareSend returns vsize and weight alongside the fee', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const address = (await k.receiveAddress()).address;
    const plan = (await dispatch(
      k,
      { method: 'wallet.prepareSend', params: { destination: DEST, amountSats: '10000000', feeRateSatPerKvB: 2000 } },
      { fromTab: false, fetchUtxos: coinsAt(address) },
    )) as Record<string, unknown>;
    expect(plan).toMatchObject({
      destination: DEST,
      amount: '10000000',
      inputs: 1,
      feeRateSatPerKvB: 2000,
      weight: 5940,
      vsize: 372,
    });
    expect(plan.fee).toBe('744'); // 372 vB at 2 sat/vB
  });

  it('wallet.prepareSend rejects a fee rate outside the bounds with BAD_FEE_RATE', async () => {
    // User loss: a sub-floor rate produces a transaction nothing will relay,
    // so the payment quietly never happens.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const address = (await k.receiveAddress()).address;
    for (const rate of [999, 100_001]) {
      const attempt = dispatch(
        k,
        { method: 'wallet.prepareSend', params: { destination: DEST, amountSats: '10000000', feeRateSatPerKvB: rate } },
        { fromTab: false, fetchUtxos: coinsAt(address) },
      );
      await expect(attempt, String(rate)).rejects.toMatchObject({ code: 'BAD_FEE_RATE' });
    }
  });

  it('the UI fee presets 1000 / 2000 / 5000 all produce a plan', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const address = (await k.receiveAddress()).address;
    for (const rate of [1000, 2000, 5000]) {
      const plan = (await dispatch(
        k,
        { method: 'wallet.prepareSend', params: { destination: DEST, amountSats: '10000000', feeRateSatPerKvB: rate } },
        { fromTab: false, fetchUtxos: coinsAt(address) },
      )) as Record<string, unknown>;
      expect(plan.feeRateSatPerKvB, String(rate)).toBe(rate);
      expect(BigInt(plan.fee as string)).toBe(BigInt((372 * rate) / 1000));
    }
  });

  it('wallet.maxSpendable answers with the contract shape', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const address = (await k.receiveAddress()).address;
    const max = (await dispatch(
      k,
      { method: 'wallet.maxSpendable', params: { feeRateSatPerKvB: 1000 } },
      { fromTab: false, fetchUtxos: coinsAt(address) },
    )) as Record<string, unknown>;
    expect(max).toEqual({ amountSats: (100_000_000n - 329n).toString(), fee: '329', inputs: 1 });
  });

  it('wallet.confirmSend returns the whole contract, including a never-lost hex', async () => {
    // User loss: if the hex is not in the result, a failed broadcast leaves the
    // user with a signed payment they cannot push from anywhere.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const address = (await k.receiveAddress()).address;
    const result = (await dispatch(
      k,
      { method: 'wallet.confirmSend', params: { destination: DEST, amountSats: '10000000', password: PASSWORD } },
      {
        fromTab: false,
        fetchUtxos: coinsAt(address),
        broadcast: async () => {
          throw new Error('no route');
        },
      },
    )) as Record<string, unknown>;
    for (const key of [
      'txid',
      'hex',
      'fee',
      'weight',
      'vsize',
      'destination',
      'amount',
      'change',
      'inputs',
      'outputs',
      'broadcastStatus',
      'broadcastError',
      'broadcastVia',
    ]) {
      expect(Object.hasOwn(result, key), key).toBe(true);
    }
    expect(result.broadcastStatus).toBe('signed');
    expect(result.broadcastError).toBe('no route');
    expect(String(result.hex).length).toBeGreaterThan(1000);
    // The bulky decoded view stays inside the worker.
    expect(Object.hasOwn(result, 'decoded')).toBe(false);
  });

  it('wallet.history rows carry confirmations and the local timestamp', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const address = (await k.receiveAddress()).address;
    await k.confirmSend({
      destination: DEST,
      amountSats: 10_000_000n,
      password: PASSWORD,
      fetchUtxos: coinsAt(address),
      broadcast: async () => {
        throw new Error('no route');
      },
      now: 1_700_000_000_000,
    });
    const rows = (await dispatch(
      k,
      { method: 'wallet.history' },
      {
        fromTab: false,
        fetchHistory: async (a) =>
          a === address
            ? [{ txid: 'cd'.repeat(32), blockHeight: 300_700, valueChange: 5_000n, status: 'confirmed' as const }]
            : [],
        fetchTip: async () => TIP,
      },
    )) as Record<string, unknown>[];

    const confirmed = rows.find((r) => r.txid === 'cd'.repeat(32))!;
    expect(confirmed.confirmations).toBe(42);
    expect(confirmed.valueChange).toBe('5000');
    expect(confirmed.status).toBe('confirmed');

    const local = rows.find((r) => r.status === 'signed')!;
    expect(local.confirmations).toBeNull();
    expect(local.at).toBe(1_700_000_000_000);
  });

  it('every explorer-backed method fails loudly when no explorer is wired up', async () => {
    // User loss: a method that returns an empty result instead of an error
    // renders as "you have no coins and no history".
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    for (const method of ['wallet.scan', 'wallet.history', 'wallet.tip', 'wallet.maxSpendable'] as const) {
      await expect(dispatch(k, { method }, { fromTab: false }), method).rejects.toMatchObject({
        code: 'EXPLORER_UNAVAILABLE',
      });
    }
  });
});
