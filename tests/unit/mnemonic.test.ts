import { describe, it, expect } from 'vitest';
import {
  entropyToMnemonic,
  generateMnemonic,
  mnemonicToEntropy,
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

describe('BIP39 entropy — the preimage the vault stores', () => {
  it('round-trips a 12-word phrase through its 16-byte entropy', () => {
    const entropy = mnemonicToEntropy(KNOWN);
    expect(entropy).toHaveLength(16);
    expect(bytesToHex(entropy)).toBe('00'.repeat(16));
    expect(entropyToMnemonic(entropy)).toBe(KNOWN);
  });

  it('round-trips a 24-word phrase through its 32-byte entropy', () => {
    const long = generateMnemonic(256);
    const entropy = mnemonicToEntropy(long);
    expect(entropy).toHaveLength(32);
    expect(entropyToMnemonic(entropy)).toBe(long);
  });

  it('round-trips whatever generateMnemonic produces, every time', () => {
    for (let i = 0; i < 8; i++) {
      const m = generateMnemonic(128);
      expect(entropyToMnemonic(mnemonicToEntropy(m))).toBe(m);
    }
  });

  it('normalises before converting, so case and spacing do not change the entropy', () => {
    expect(bytesToHex(mnemonicToEntropy(`  ${KNOWN.toUpperCase()}  `))).toBe(
      bytesToHex(mnemonicToEntropy(KNOWN)),
    );
  });

  it('refuses a phrase this wallet would refuse to import', () => {
    // A phrase that never validates must never become stored entropy: the
    // reveal would then hand back words the import screen rejects.
    expect(() => mnemonicToEntropy('abandon '.repeat(11) + 'abandon')).toThrow(/checksum/i);
    expect(() => mnemonicToEntropy('abandon abandon')).toThrow(/12 or 24/);
    expect(() => mnemonicToEntropy(KNOWN.replace('about', 'xyzzy'))).toThrow(/xyzzy/);
  });

  it('refuses an entropy length that is not 12 or 24 words', () => {
    // BIP39 also defines 20/24/28-byte entropies. Rendering one would produce a
    // 15/18/21-word backup the import screen then refuses — a fake backup.
    for (const n of [0, 15, 17, 20, 24, 28, 31, 33, 64]) {
      const attempt = () => entropyToMnemonic(new Uint8Array(n));
      expect(attempt, String(n)).toThrow(/16 or 32 bytes/);
      try {
        attempt();
      } catch (e) {
        expect((e as WalletError).code, String(n)).toBe('BAD_MNEMONIC');
      }
    }
  });

  it('the phrase an entropy renders derives the same HD seed as the original', () => {
    // The property the reveal self-check relies on.
    const m = generateMnemonic(128);
    expect(bytesToHex(mnemonicToHdSeed(entropyToMnemonic(mnemonicToEntropy(m))))).toBe(
      bytesToHex(mnemonicToHdSeed(m)),
    );
  });
});
