import { describe, it, expect } from 'vitest';
import { scanChain } from '../../src/core/wallet/gap.js';
import { WalletError } from '../../src/core/wallet/errors.js';

describe('gap-limit scan', () => {
  it('stops after 20 consecutive unused and sets nextIndex past the last used', async () => {
    const scan = await scanChain({
      chain: 'external',
      addressAt: (i) => `addr-${i}`,
      lookup: async (address) => {
        const i = Number(address.slice(5));
        return { used: i < 2, txCount: i < 2 ? 1 : 0, balanceSats: i < 2 ? 100n : 0n };
      },
    });
    expect(scan.used.map((u) => u.index)).toEqual([0, 1]);
    expect(scan.nextIndex).toBe(2);
  });

  it('does not treat an explorer failure as unused (would hide funds)', async () => {
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
});
