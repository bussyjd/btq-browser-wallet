import { describe, it, expect } from 'vitest';
import {
  keyPairFromSeed, signTransactionHash, verifyTransactionHash,
  PUBLIC_KEY_BYTES, SECRET_KEY_BYTES, TX_SIGNATURE_BYTES, SIGHASH_ALL,
} from '../../src/core/crypto/mldsa.js';

const seed = (b: number) => new Uint8Array(32).fill(b);

describe('ML-DSA-44 primitives', () => {
  it('produces btq-core key sizes from a 32-byte seed', () => {
    const kp = keyPairFromSeed(seed(7));
    expect(kp.publicKey.length).toBe(PUBLIC_KEY_BYTES); // 1312
    expect(kp.secretKey.length).toBe(SECRET_KEY_BYTES); // 2560
  });

  it('derives deterministically: same seed, same key', () => {
    expect(keyPairFromSeed(seed(7)).publicKey).toEqual(keyPairFromSeed(seed(7)).publicKey);
    expect(keyPairFromSeed(seed(8)).publicKey).not.toEqual(keyPairFromSeed(seed(7)).publicKey);
  });

  it('rejects a seed that is not 32 bytes', () => {
    expect(() => keyPairFromSeed(new Uint8Array(31))).toThrow(/32 bytes/);
  });

  it('signs to exactly 2421 bytes ending in SIGHASH_ALL', () => {
    const sig = signTransactionHash(seed(7), new Uint8Array(32).fill(9));
    expect(sig.length).toBe(TX_SIGNATURE_BYTES); // 2421
    expect(sig[TX_SIGNATURE_BYTES - 1]).toBe(SIGHASH_ALL);
  });

  it('signs deterministically, matching btq-core non-hedged signing', () => {
    const h = new Uint8Array(32).fill(9);
    expect(signTransactionHash(seed(7), h)).toEqual(signTransactionHash(seed(7), h));
  });

  it('verifies its own signature and rejects a tampered digest', () => {
    const kp = keyPairFromSeed(seed(7));
    const h = new Uint8Array(32).fill(9);
    const sig = signTransactionHash(seed(7), h);
    expect(verifyTransactionHash(kp.publicKey, h, sig)).toBe(true);
    const other = new Uint8Array(32).fill(10);
    expect(verifyTransactionHash(kp.publicKey, other, sig)).toBe(false);
  });

  it('refuses SIGHASH_DEFAULT, which BTQ P2MR consensus rejects', () => {
    expect(() => signTransactionHash(seed(7), new Uint8Array(32), 0x00)).toThrow(/SIGHASH_DEFAULT/);
  });

  it('rejects a sighash that is not 32 bytes', () => {
    expect(() => signTransactionHash(seed(7), new Uint8Array(31))).toThrow(/32 bytes/);
  });
});
