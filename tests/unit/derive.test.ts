import { describe, it, expect } from 'vitest';
import vectors from '../vectors/golden.json' with { type: 'json' };
import { hexToBytes } from '../../src/core/util/hex.js';
import { addressFromHdSeed } from '../../src/core/wallet/derive.js';

describe('address derivation', () => {
  it('matches the golden testnet address at m/0\'/0\'/0\'', () => {
    const d = addressFromHdSeed(hexToBytes(vectors.hdSeedHex), 'external', 0, 'testnet');
    expect(d.address).toBe(vectors.entries[0]!.addresses.testnet);
    expect(d.path).toBe("m/0'/0'/0'");
  });
});
