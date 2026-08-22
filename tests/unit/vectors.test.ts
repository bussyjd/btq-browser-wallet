/**
 * Golden-vector regression. These values were verified against btq-core (see
 * docs/REFERENCE.md §8, "Cross-check evidence"). A failure here means
 * derivation, script construction or address encoding changed — i.e. the
 * wallet would no longer find or spend its own coins. Never "fix" this test
 * by regenerating vectors without re-running the regtest cross-check.
 */
import { describe, it, expect } from 'vitest';
import vectors from '../vectors/golden.json' with { type: 'json' };
import { sha256 } from '@noble/hashes/sha256';
import { keyPairFromSeed, signTransactionHash } from '../../src/core/crypto/mldsa.js';
import { masterFromSeed, deriveKeySeed, encodeExtKey } from '../../src/core/crypto/hd.js';
import { singleKeyLeafScript, merkleRootForPublicKey, outputScript, tapLeafHash } from '../../src/core/script/p2mr.js';
import { addressForPublicKey } from '../../src/core/script/address.js';
import { bytesToHex, hexToBytes } from '../../src/core/util/hex.js';

const master = masterFromSeed(hexToBytes(vectors.hdSeedHex));

describe('golden vectors (verified against btq-core)', () => {
  it('reproduces the master key', () => {
    expect(bytesToHex(master.seed)).toBe(vectors.masterSeed);
    expect(bytesToHex(master.chaincode)).toBe(vectors.masterChaincode);
    expect(bytesToHex(encodeExtKey(master))).toBe(vectors.masterExtKey);
    expect(encodeExtKey(master).length).toBe(73); // btq-core DILITHIUM_EXTKEY_SIZE
  });

  for (const v of vectors.entries) {
    it(`reproduces ${v.path}`, () => {
      const keySeed = deriveKeySeed(master, v.chain as 'external' | 'internal', v.index);
      expect(bytesToHex(keySeed)).toBe(v.keySeed);

      const { publicKey } = keyPairFromSeed(keySeed);
      expect(bytesToHex(sha256(publicKey))).toBe(v.publicKeySha256);

      const leaf = singleKeyLeafScript(publicKey);
      expect(bytesToHex(sha256(leaf))).toBe(v.leafScriptSha256);
      expect(bytesToHex(tapLeafHash(leaf))).toBe(v.tapLeafHash);
      expect(bytesToHex(merkleRootForPublicKey(publicKey))).toBe(v.merkleRoot);
      expect(bytesToHex(outputScript(merkleRootForPublicKey(publicKey)))).toBe(v.scriptPubKey);

      expect(addressForPublicKey(publicKey, 'mainnet')).toBe(v.addresses.mainnet);
      expect(addressForPublicKey(publicKey, 'testnet')).toBe(v.addresses.testnet);
      expect(addressForPublicKey(publicKey, 'regtest')).toBe(v.addresses.regtest);
    });
  }

  it('reproduces the signature vector deterministically', () => {
    const seed = deriveKeySeed(master, 'external', 0);
    const sig = signTransactionHash(seed, hexToBytes(vectors.signature.digest));
    expect(sig.length).toBe(vectors.signature.length);
    expect(sig[sig.length - 1]).toBe(vectors.signature.sighashByte);
    expect(bytesToHex(sha256(sig))).toBe(vectors.signature.sha256);
  });

  it('testnet addresses use the tbtq1z prefix', () => {
    for (const v of vectors.entries) expect(v.addresses.testnet.startsWith('tbtq1z')).toBe(true);
  });
});
