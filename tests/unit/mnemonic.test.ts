import { describe, it, expect } from 'vitest';
import {
  generateMnemonic,
  parseMnemonic,
  mnemonicToHdSeed,
  parseRawSeedHex,
  pickChallengeIndices,
} from '../../src/core/crypto/mnemonic.js';
import { masterFromSeed } from '../../src/core/crypto/hd.js';
import { WalletError } from '../../src/core/wallet/errors.js';
import { bytesToHex } from '../../src/core/util/hex.js';

const KNOWN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('BIP39 mnemonic', () => {
  it('generates a 12-word English mnemonic', () => {
    const m = generateMnemonic();
    expect(parseMnemonic(m).split(' ')).toHaveLength(12);
  });

  it('names a word that is not on the BIP39 list', () => {
    try {
      parseMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon xyzzy');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(WalletError);
      expect((e as WalletError).code).toBe('BAD_WORD');
      expect((e as WalletError).message).toContain('xyzzy');
    }
  });

  it('rejects a checksum failure', () => {
    expect(() =>
      parseMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'),
    ).toThrow(/checksum/i);
  });

  it('rejects the wrong word count', () => {
    expect(() => parseMnemonic('abandon abandon')).toThrow(/12 or 24/);
  });

  it('accepts a known 12-word vector after whitespace/case folding', () => {
    expect(parseMnemonic(`  ${KNOWN.toUpperCase()}  `)).toBe(KNOWN);
  });

  it('mnemonic vs raw seed of related entropy produce different masters', () => {
    const fromMnemonic = masterFromSeed(mnemonicToHdSeed(KNOWN));
    const fromRaw = masterFromSeed(parseRawSeedHex('00'.repeat(32)));
    expect(bytesToHex(fromMnemonic.seed)).not.toBe(bytesToHex(fromRaw.seed));
  });
});

describe('raw 32-byte seed', () => {
  it('rejects a hex seed that is not 32 bytes', () => {
    expect(() => parseRawSeedHex('0011')).toThrow(/32 bytes/);
    expect(() => parseRawSeedHex('zz')).toThrow(/hexadecimal/);
  });

  it('rejects a 64-byte hex so a BIP39 seed is not imported as raw', () => {
    expect(() => parseRawSeedHex('ab'.repeat(64))).toThrow(/Import seed phrase/);
  });

  it('accepts 64 hex characters with an 0x prefix', () => {
    expect(parseRawSeedHex('0x' + 'ab'.repeat(32))).toHaveLength(32);
  });
});

describe('confirmation challenge', () => {
  it('picks three distinct sorted indices', () => {
    const idx = pickChallengeIndices(12, 3, () => new Uint8Array([0, 0, 0, 7]));
    expect(idx).toHaveLength(3);
    expect(new Set(idx).size).toBe(3);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
});
