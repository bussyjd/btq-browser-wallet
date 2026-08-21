import { describe, it, expect } from 'vitest';
import { encryptVault, decryptVault, DEFAULT_PBKDF2_ITERATIONS } from '../../src/core/vault/encrypt.js';
import { encodePayload } from '../../src/core/vault/payload.js';
import { mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';
import { bytesToHex, hexToBytes } from '../../src/core/util/hex.js';
import { WalletError } from '../../src/core/wallet/errors.js';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'correct horse battery';

describe('vault ciphertext does not leak secrets', () => {
  it('encrypted blob does not contain the HD seed bytes or mnemonic words in order', async () => {
    // Attacker gain: reading chrome.storage.local would recover the seed.
    const hdSeed = mnemonicToHdSeed(MNEMONIC);
    const plain = encodePayload({
      v: 1,
      network: 'testnet',
      origin: 'bip39',
      hdSeedHex: bytesToHex(hdSeed),
    });
    const blob = await encryptVault(plain, PASSWORD, { iterations: 1_000 });
    const asLatin = new TextDecoder('latin1').decode(blob);
    expect(asLatin.includes(bytesToHex(hdSeed))).toBe(false);
    expect(asLatin.includes(MNEMONIC)).toBe(false);
    expect(asLatin.includes('abandon abandon abandon')).toBe(false);
    expect(DEFAULT_PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(210_000);
  });

  it('wrong password fails with a single non-oracle message', async () => {
    const blob = await encryptVault(new TextEncoder().encode('hello-vault'), PASSWORD, { iterations: 1_000 });
    const attempt = () => decryptVault(blob, 'wrong-password-xx');
    await expect(attempt()).rejects.toBeInstanceOf(WalletError);
    await expect(attempt()).rejects.toThrow('Incorrect password.');
    try {
      await decryptVault(blob, 'another-wrong-password');
    } catch (e) {
      expect((e as WalletError).message).toBe('Incorrect password.');
      expect((e as WalletError).code).toBe('WRONG_PASSWORD');
    }
  });

  it('round-trips and never returns a mutated original plaintext buffer', async () => {
    const plain = new TextEncoder().encode('{"v":1}');
    const copy = new Uint8Array(plain);
    const blob = await encryptVault(plain, PASSWORD, { iterations: 1_000 });
    const out = await decryptVault(blob, PASSWORD);
    expect(out).toEqual(copy);
  });

  it('rejects a blob that is not a vault instead of calling it a wrong password', async () => {
    await expect(decryptVault(hexToBytes('00'.repeat(64)), PASSWORD)).rejects.toThrow(/Not a BTQ vault/);
  });
});
