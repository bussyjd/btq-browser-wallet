/**
 * Balance, scan and history behaviour of the keyring — the numbers the user
 * reads before deciding to send.
 */
import { describe, it, expect } from 'vitest';
import { Keyring } from '../../src/core/wallet/keyring.js';
import { dispatch } from '../../src/core/rpc/dispatch.js';
import { WalletError } from '../../src/core/wallet/errors.js';
import { scriptForAddress } from '../../src/core/script/address.js';
import { MemoryWalletStorage, TEST_ENCRYPT } from '../helpers/memory-store.js';
import { GAP_LIMIT, type AddressActivity } from '../../src/core/wallet/gap.js';
import type { ExplorerUtxo } from '../../src/core/explorer/utxo.js';
import type { HistoryItem } from '../../src/core/explorer/history.js';
import addressUsed from '../fixtures/explorer/address-used.json' with { type: 'json' };

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'testnet-ok';

function ring(store = new MemoryWalletStorage(), now?: { t: number }) {
  return new Keyring(store, {
    encrypt: TEST_ENCRYPT,
    network: 'testnet',
    now: now ? () => now.t : undefined,
  });
}

function utxo(address: string, value: bigint, vout: number, blockHeight: number | null): ExplorerUtxo {
  return {
    txid: vout.toString(16).padStart(64, '0'),
    vout,
    value,
    script: scriptForAddress(address, 'testnet'),
    blockHeight,
  };
}

describe('wallet balance comes from /utxos, never from the address record', () => {
  it('sums unspent outputs even when the explorer reports a negative balance', async () => {
    // User loss: the live indexer returns balance "-266828024798707" for a busy
    // address that has 91 real unspents. Trusting that field renders a funded
    // wallet as 0 tBTQ while the send path can still spend the coins.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const first = await k.receiveAddress();
    expect(addressUsed.body.balance.startsWith('-')).toBe(true);

    const lookup = async (address: string): Promise<AddressActivity> => ({
      used: address === first.address,
      txCount: address === first.address ? 1397 : 0,
      // Exactly the untrustworthy number from the live record.
      reportedBalanceSats: 0n,
    });
    const fetchUtxos = async (address: string) =>
      address === first.address
        ? [utxo(address, 178_864_075_180n, 1, 300741), utxo(address, 500_600_000n, 2, null)]
        : [];

    const scan = await k.scan(lookup, fetchUtxos, { height: 300_741, hash: 'aa'.repeat(32) });
    expect(scan.totalBalanceSats).toBe(179_364_675_180n);
    expect(scan.confirmedBalanceSats).toBe(178_864_075_180n);

    const status = await k.status();
    expect(status.lastBalanceSats).toBe('179364675180');
    expect(status.confirmedBalanceSats).toBe('178864075180');
    expect(status.tipHeight).toBe(300_741);
    expect(status.lastScanAt).not.toBeNull();
  });

  it('a UTXO fetch failure fails the scan instead of reporting zero', async () => {
    // User loss: a silent "0" makes the user think the coins are gone and
    // re-import a seed looking for them.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    await expect(
      k.scan(
        async () => ({ used: false, txCount: 0, reportedBalanceSats: 0n }),
        async () => {
          throw new WalletError('EXPLORER_UNAVAILABLE', 'Explorer returned HTTP 502.');
        },
      ),
    ).rejects.toThrow(/HTTP 502/);
  });

  it('a rescan re-queries only the gap window, not the settled addresses below it', async () => {
    // The point of the cursor: a wallet with many used addresses must not
    // re-query all of them on every refresh, but the gap window has to be
    // re-checked or a payment to the address on screen is never noticed.
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);

    const usedThrough = 4; // pretend indices 0..4 have been used
    const first: string[] = [];
    const addresses = Array.from({ length: 40 }, (_, i) => k.addressAt('external', i).address);
    await k.scan(async (address) => {
      first.push(address);
      const index = addresses.indexOf(address);
      return { used: index >= 0 && index <= usedThrough, txCount: 1, reportedBalanceSats: 0n };
    });
    expect(store.meta?.externalNext).toBe(usedThrough + 1);
    expect(first.length).toBeGreaterThan(GAP_LIMIT);

    const second: string[] = [];
    await k.scan(async (address) => {
      second.push(address);
      return { used: false, txCount: 0, reportedBalanceSats: 0n };
    });
    // Only the window above the last used index, on each of the two chains.
    const external = second.filter((a) => addresses.includes(a));
    expect(external).toHaveLength(GAP_LIMIT);
    expect(external[0]).toBe(addresses[usedThrough + 1]);
    expect(store.meta?.scannedExternal).toBeGreaterThanOrEqual(usedThrough + GAP_LIMIT);
  });

  it('a payment to the address on screen advances the receive index on the next scan', async () => {
    // User loss: a frozen receive address means the user hands out an address
    // that has already been paid, losing the privacy the gap scan exists for.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const unusedLookup = async (): Promise<AddressActivity> => ({ used: false, txCount: 0, reportedBalanceSats: 0n });
    await k.scan(unusedLookup, async () => []);
    const shown = await k.receiveAddress();
    expect(shown.index).toBe(0);

    await k.scan(
      async (address) => ({
        used: address === shown.address,
        txCount: address === shown.address ? 1 : 0,
        reportedBalanceSats: 0n,
      }),
      async (address) => (address === shown.address ? [utxo(address, 1_000n, 0, 300_500)] : []),
    );
    const next = await k.receiveAddress();
    expect(next.index).toBe(1);
    expect((await k.status()).lastBalanceSats).toBe('1000');
  });

  it('a full rescan re-queries from index 0', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const lookup = async (): Promise<AddressActivity> => ({ used: false, txCount: 0, reportedBalanceSats: 0n });
    await k.scan(lookup);
    const seen: string[] = [];
    await k.scan(
      async (address) => {
        seen.push(address);
        return { used: false, txCount: 0, reportedBalanceSats: 0n };
      },
      undefined,
      null,
      { full: true },
    );
    expect(seen.length).toBeGreaterThan(20);
  });

  it('history is merged per txid across chains and carries confirmations', async () => {
    // User loss: a send that pays change back to us appears on two addresses;
    // counting it twice would double the amount shown in the ledger.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const external = (await k.receiveAddress()).address;
    const internal = k.addressAt('internal', 0).address;
    const shared = 'cd'.repeat(32);
    const fetchHistory = async (address: string): Promise<HistoryItem[]> => {
      if (address === external) {
        return [{ txid: shared, blockHeight: 300_700, valueChange: -50_000_000n, status: 'confirmed' }];
      }
      if (address === internal) {
        return [{ txid: shared, blockHeight: 300_700, valueChange: 49_999_628n, status: 'confirmed' }];
      }
      return [];
    };
    const rows = await k.listHistory(fetchHistory, { height: 300_741, hash: 'aa'.repeat(32) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.valueChange).toBe(-372n);
    expect(rows[0]!.confirmations).toBe(42);
  });

  it('confirmations are null when the tip is unknown, never a guess', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const external = (await k.receiveAddress()).address;
    const rows = await k.listHistory(async (address) =>
      address === external
        ? [{ txid: 'ab'.repeat(32), blockHeight: 300_700, valueChange: 1n, status: 'confirmed' as const }]
        : [],
    );
    expect(rows[0]!.confirmations).toBeNull();
  });

  it('maxSpendable never proposes more than the coins can pay for', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const address = (await k.receiveAddress()).address;
    const fetchUtxos = async (a: string) => (a === address ? [utxo(a, 1_000_000n, 0, 300_000)] : []);
    const max = await k.maxSpendable({ fetchUtxos });
    expect(BigInt(max.amountSats) + BigInt(max.fee)).toBe(1_000_000n);
    expect(max.inputs).toBe(1);

    const empty = await k.maxSpendable({ fetchUtxos: async () => [] });
    expect(empty.amountSats).toBe('0');
  });

  it('an empty wallet reports 0 rather than throwing', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const scan = await k.scan(
      async () => ({ used: false, txCount: 0, reportedBalanceSats: 0n }),
      async () => [],
    );
    expect(scan.totalBalanceSats).toBe(0n);
    expect(scan.confirmedBalanceSats).toBe(0n);
  });
});

describe('wallet.scan / wallet.tip over RPC', () => {
  it('scan returns the contract fields and the tip it saw', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const address = (await k.receiveAddress()).address;
    const result = (await dispatch(
      k,
      { method: 'wallet.scan' },
      {
        fromTab: false,
        lookup: async (a) => ({ used: a === address, txCount: a === address ? 1 : 0, reportedBalanceSats: 0n }),
        fetchUtxos: async (a) => (a === address ? [utxo(a, 42_000n, 0, 300_500)] : []),
        fetchTip: async () => ({ height: 300_741, hash: 'aa'.repeat(32) }),
      },
    )) as Record<string, unknown>;
    expect(result).toMatchObject({
      lastBalanceSats: '42000',
      confirmedBalanceSats: '42000',
      tipHeight: 300_741,
      externalNext: 1,
    });
    expect(typeof result.lastScanAt).toBe('number');
  });

  it('wallet.tip returns the explorer tip', async () => {
    const k = ring();
    expect(
      await dispatch(k, { method: 'wallet.tip' }, { fromTab: false, fetchTip: async () => ({ height: 7, hash: 'a' }) }),
    ).toEqual({ height: 7, hash: 'a' });
  });

  it('a scan whose tip lookup fails still scans, with a null tip', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const result = (await dispatch(
      k,
      { method: 'wallet.scan' },
      {
        fromTab: false,
        lookup: async () => ({ used: false, txCount: 0, reportedBalanceSats: 0n }),
        fetchUtxos: async () => [],
        fetchTip: async () => {
          throw new WalletError('EXPLORER_UNAVAILABLE', 'down');
        },
      },
    )) as Record<string, unknown>;
    expect(result.tipHeight).toBeNull();
  });
});
