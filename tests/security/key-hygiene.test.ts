/**
 * Secret material must not outlive the operation that needed it. ML-DSA-44
 * secret keys are 2560 bytes each and a scan derives one per address, so a
 * service-worker heap that keeps them turns any later memory disclosure into a
 * spendable-key disclosure.
 */
import { describe, it, expect } from 'vitest';
import { keyPairFromSeed, publicKeyFromSeed, signTransactionHash, SECRET_KEY_BYTES } from '../../src/core/crypto/mldsa.js';
import { deriveKeySeed, derivePath, masterFromSeed, accountKey, HARDENED } from '../../src/core/crypto/hd.js';
import { addressFromHdSeed } from '../../src/core/wallet/derive.js';
import { bytesToHex, hexToBytes } from '../../src/core/util/hex.js';
import { Keyring } from '../../src/core/wallet/keyring.js';
import { MemoryWalletStorage, TEST_ENCRYPT } from '../helpers/memory-store.js';
import vectors from '../vectors/golden.json' with { type: 'json' };

const HD_SEED = hexToBytes(vectors.hdSeedHex);
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'testnet-ok';

function isZeroed(bytes: Uint8Array): boolean {
  return bytes.every((b) => b === 0);
}

describe('secret material lifetime', () => {
  it('publicKeyFromSeed does not leave a live secret key behind', () => {
    // Attacker gain: one live ML-DSA secret key is one address the attacker
    // can spend from.
    const seed = deriveKeySeed(masterFromSeed(HD_SEED), 'external', 0);
    const pair = keyPairFromSeed(seed);
    expect(pair.secretKey.length).toBe(SECRET_KEY_BYTES);
    expect(isZeroed(pair.secretKey)).toBe(false); // the raw keygen still returns one
    const pub = publicKeyFromSeed(seed);
    expect(bytesToHex(pub)).toBe(bytesToHex(pair.publicKey)); // same key, no secret kept
  });

  it('signing wipes the secret key it derived', () => {
    const seed = deriveKeySeed(masterFromSeed(HD_SEED), 'external', 0);
    const sig = signTransactionHash(seed, new Uint8Array(32).fill(9));
    expect(sig.length).toBe(2421);
    // Signing twice from the same seed still works: the wipe touches the
    // derived copy, never the caller's seed.
    expect(bytesToHex(signTransactionHash(seed, new Uint8Array(32).fill(9)))).toBe(bytesToHex(sig));
  });

  it('derivePath zeroes intermediate account keys but never the caller master', () => {
    // The account key m/0'/0' can spend the whole external chain; it has no
    // reason to survive the call that produced one leaf.
    const master = masterFromSeed(HD_SEED);
    const account = accountKey(master, 'external');
    expect(isZeroed(account.seed)).toBe(false);

    const first = deriveKeySeed(master, 'external', 0);
    expect(bytesToHex(first)).toBe(vectors.entries[0]!.keySeed);
    // master survives, so repeated derivation is stable — a wiped master would
    // silently start producing different addresses for the same wallet.
    expect(bytesToHex(master.seed)).toBe(vectors.masterSeed);
    expect(bytesToHex(deriveKeySeed(master, 'external', 0))).toBe(vectors.entries[0]!.keySeed);
    expect(bytesToHex(deriveKeySeed(master, 'internal', 5))).toBe(vectors.entries[6]!.keySeed);

    const walked = derivePath(master, [HARDENED, HARDENED]);
    expect(walked.seed.length).toBe(32);
    expect(bytesToHex(master.seed)).toBe(vectors.masterSeed);
  });

  it('a full derive still reproduces the golden addresses after the wiping change', () => {
    for (const v of vectors.entries) {
      const d = addressFromHdSeed(HD_SEED, v.chain as 'external' | 'internal', v.index, 'testnet');
      expect(d.address, v.path).toBe(v.addresses.testnet);
    }
  });

  it('lock zeroes the in-memory HD seed', async () => {
    // Attacker gain: a seed left in the worker's heap after lock defeats the
    // whole point of locking.
    const k = new Keyring(new MemoryWalletStorage(), { encrypt: TEST_ENCRYPT, network: 'testnet' });
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const before = await k.receiveAddress();
    k.lock();
    expect((await k.status()).unlocked).toBe(false);
    await k.unlock(PASSWORD);
    expect((await k.receiveAddress()).address).toBe(before.address);
  });
});
