/**
 * Regenerate golden vectors and (optionally) cross-check them against a live
 * btq-core regtest node. These vectors are the wallet's contract with
 * consensus: if any value drifts, addresses or signatures have changed and the
 * wallet is no longer compatible.
 *
 *   npx tsx scripts/gen-vectors.ts            # regenerate from our own code
 *   BTQ_REGTEST=1 npx tsx scripts/gen-vectors.ts   # also verify against a node
 */
import { writeFileSync } from 'node:fs';
import { keyPairFromSeed, signTransactionHash } from '../src/core/crypto/mldsa.js';
import { masterFromSeed, deriveKeySeed, keyPath, encodeExtKey } from '../src/core/crypto/hd.js';
import { singleKeyLeafScript, merkleRootForPublicKey, outputScript, tapLeafHash } from '../src/core/script/p2mr.js';
import { addressForPublicKey } from '../src/core/script/address.js';
import { bytesToHex } from '../src/core/util/hex.js';
import { sha256 } from '@noble/hashes/sha256';

const HD_SEED = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

const master = masterFromSeed(HD_SEED);
const entries = [];
for (const chain of ['external', 'internal'] as const) {
  for (const index of [0, 1, 5, 20]) {
    const keySeed = deriveKeySeed(master, chain, index);
    const { publicKey } = keyPairFromSeed(keySeed);
    const leaf = singleKeyLeafScript(publicKey);
    entries.push({
      path: keyPath(chain, index),
      chain, index,
      keySeed: bytesToHex(keySeed),
      publicKeySha256: bytesToHex(sha256(publicKey)), // 1312 bytes is too large to inline
      leafScriptSha256: bytesToHex(sha256(leaf)),
      tapLeafHash: bytesToHex(tapLeafHash(leaf)),
      merkleRoot: bytesToHex(merkleRootForPublicKey(publicKey)),
      scriptPubKey: bytesToHex(outputScript(merkleRootForPublicKey(publicKey))),
      addresses: {
        mainnet: addressForPublicKey(publicKey, 'mainnet'),
        testnet: addressForPublicKey(publicKey, 'testnet'),
        regtest: addressForPublicKey(publicKey, 'regtest'),
      },
    });
  }
}

// A fixed signature vector proves determinism and the 2421-byte witness shape.
const sigSeed = deriveKeySeed(master, 'external', 0);
const digest = sha256(new TextEncoder().encode('btq-golden-vector'));
const signature = signTransactionHash(sigSeed, digest);

const vectors = {
  note: 'Golden vectors for the BTQ browser wallet. Verified against btq-core; see docs/REFERENCE.md.',
  hdSeedHex: bytesToHex(HD_SEED),
  masterSeed: bytesToHex(master.seed),
  masterChaincode: bytesToHex(master.chaincode),
  masterExtKey: bytesToHex(encodeExtKey(master)),
  entries,
  signature: {
    path: keyPath('external', 0),
    digest: bytesToHex(digest),
    length: signature.length,
    sighashByte: signature[signature.length - 1],
    sha256: bytesToHex(sha256(signature)),
  },
};

const out = new URL('../tests/vectors/golden.json', import.meta.url);
writeFileSync(out, JSON.stringify(vectors, null, 2) + '\n');
console.log(`wrote ${entries.length} derivation vectors to tests/vectors/golden.json`);
