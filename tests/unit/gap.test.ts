import { describe, it, expect } from 'vitest';
import { GAP_LIMIT, scanChain, type AddressActivity } from '../../src/core/wallet/gap.js';
import { WalletError } from '../../src/core/wallet/errors.js';

const unused: AddressActivity = { used: false, txCount: 0, reportedBalanceSats: 0n };
const used: AddressActivity = { used: true, txCount: 1, reportedBalanceSats: 100n };

describe('gap-limit scan', () => {
  it('stops after 20 consecutive unused and sets nextIndex past the last used', async () => {
    const scan = await scanChain({
      chain: 'external',
      addressAt: (i) => `addr-${i}`,
      lookup: async (address) => (Number(address.slice(5)) < 2 ? used : unused),
    });
    expect(scan.used.map((u) => u.index)).toEqual([0, 1]);
    expect(scan.nextIndex).toBe(2);
    // Batching may overshoot the exact stop index; it must never stop short.
    expect(scan.scannedTo).toBeGreaterThanOrEqual(1 + GAP_LIMIT - 1);
  });

  it('does not treat an explorer failure as unused (would hide funds)', async () => {
    // User loss: 20 "unused" answers from a flaky explorer end the scan at
    // index 0, the wallet shows a zero balance and the coins look gone.
    await expect(
      scanChain({
        chain: 'external',
        addressAt: (i) => `addr-${i}`,
        lookup: async () => {
          throw new WalletError('EXPLORER_UNAVAILABLE', 'Explorer returned HTTP 500.');
        },
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('a failure on any address in a concurrent batch fails the whole scan', async () => {
    // User loss: with parallel lookups, swallowing one rejection leaves a hole
    // in the scanned range and silently drops that address's coins.
    await expect(
      scanChain({
        chain: 'external',
        addressAt: (i) => `addr-${i}`,
        lookup: async (address) => {
          if (address === 'addr-3') throw new WalletError('EXPLORER_UNAVAILABLE', 'boom');
          return unused;
        },
        concurrency: 5,
      }),
    ).rejects.toThrow(/boom/);
  });

  it('keeps looking while addresses keep being used (the horizon moves)', async () => {
    const scan = await scanChain({
      chain: 'external',
      addressAt: (i) => `addr-${i}`,
      lookup: async (address) => (Number(address.slice(5)) % 7 === 0 ? used : unused),
      maxIndex: 100,
    });
    expect(scan.nextIndex).toBe(99); // 98 is the last multiple of 7 below 100
  });

  it('resumes from the stored cursor instead of re-querying known addresses', async () => {
    const queried: number[] = [];
    const scan = await scanChain({
      chain: 'external',
      addressAt: (i) => `addr-${i}`,
      lookup: async (address) => {
        queried.push(Number(address.slice(5)));
        return unused;
      },
      startIndex: 30,
      lastUsedIndex: 29,
    });
    expect(Math.min(...queried)).toBe(30);
    expect(scan.nextIndex).toBe(30); // the known lastUsed 29 is preserved
    expect(Math.max(...queried)).toBe(29 + GAP_LIMIT);
  });

  it('a resumed scan that finds a new used address extends nextIndex', async () => {
    const scan = await scanChain({
      chain: 'external',
      addressAt: (i) => `addr-${i}`,
      lookup: async (address) => (address === 'addr-31' ? used : unused),
      startIndex: 30,
      lastUsedIndex: 29,
    });
    expect(scan.nextIndex).toBe(32);
    expect(scan.used.map((u) => u.index)).toEqual([31]);
  });

  it('never walks past maxIndex', async () => {
    const scan = await scanChain({
      chain: 'internal',
      addressAt: (i) => `addr-${i}`,
      lookup: async () => used,
      maxIndex: 12,
    });
    expect(scan.scannedTo).toBe(11);
    expect(scan.nextIndex).toBe(12);
  });
});
