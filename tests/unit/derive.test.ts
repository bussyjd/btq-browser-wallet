import { describe, it, expect } from 'vitest';
import vectors from '../vectors/golden.json' with { type: 'json' };
import { hexToBytes } from '../../src/core/util/hex.js';
import { addressFromHdSeed } from '../../src/core/wallet/derive.js';

describe('address derivation', () => {
  it('matches the golden testnet address at m/0\'/0\'/0\'', () => {
    const d = addressFromHdSeed(hexToBytes(vectors.hdSeedHex), 'external', 0, 'testnet');
    expect(d.address).toBe(vectors.entries[0]!.addresses.testnet);
    expect(d.path).toBe("m/0'/0'/0'");
    expect(d.account).toBe(0);
  });

  it('extra HD accounts sit at m/k\'/0\'/n\' and do not collide with account 0', () => {
    const seed = hexToBytes(vectors.hdSeedHex);
    const a0 = addressFromHdSeed(seed, 'external', 0, 'testnet', 0);
    const a1 = addressFromHdSeed(seed, 'external', 0, 'testnet', 1);
    expect(a1.path).toBe("m/1'/0'/0'");
    expect(a1.address).not.toBe(a0.address);
    expect(a1.address.startsWith('tbtq1z')).toBe(true);
    expect(addressFromHdSeed(seed, 'external', 0, 'testnet', 1).address).toBe(a1.address);
  });
});
