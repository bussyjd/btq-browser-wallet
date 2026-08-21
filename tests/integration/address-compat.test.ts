/**
 * MILESTONE 0 — address construction must be byte-identical to btq-core.
 *
 * We hand the node the leaf script our wallet builds and compare every field it
 * echoes back (address, scriptPubKey, merkle_root). If any byte differs, funds
 * sent to our address would be invisible or unspendable.
 *
 * Run with a regtest node:  BTQ_REGTEST=1 npx vitest run tests/integration
 */
import { describe, it, expect } from 'vitest';
import { rpc, rpcConfigFromEnv, hex } from './rpc.js';
import { keyPairFromSeed } from '../../src/core/crypto/mldsa.js';
import { masterFromSeed, deriveKeySeed } from '../../src/core/crypto/hd.js';
import { singleKeyLeafScript, merkleRootForPublicKey, outputScript, LEAF_VERSION, commitsToProgram, singleLeafControlBlock } from '../../src/core/script/p2mr.js';
import { addressForPublicKey } from '../../src/core/script/address.js';

const cfg = rpcConfigFromEnv();
const maybe = cfg ? describe : describe.skip;

maybe('btq-core P2MR compatibility', () => {
  it('node echoes our address, scriptPubKey and merkle root byte-for-byte', async () => {
    const master = masterFromSeed(Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'));
    const keySeed = deriveKeySeed(master, 'external', 0);
    const { publicKey } = keyPairFromSeed(keySeed);

    const leaf = singleKeyLeafScript(publicKey);
    const ours = {
      address: addressForPublicKey(publicKey, 'regtest'),
      scriptPubKey: hex(outputScript(merkleRootForPublicKey(publicKey))),
      merkleRoot: hex(merkleRootForPublicKey(publicKey)),
    };

    const tree = [{ depth: 0, leaf_version: LEAF_VERSION, script: hex(leaf) }];
    const node = await rpc<{ address: string; scriptPubKey: string; merkle_root: string }>(
      cfg!, 'getnewp2mraddress', [tree, 'm0-compat', false],
    );

    expect(node.address).toBe(ours.address);
    expect(node.scriptPubKey.toLowerCase()).toBe(ours.scriptPubKey);
    expect(node.merkle_root.toLowerCase()).toBe(ours.merkleRoot);
  });

  it('node classifies our address as watch-only P2MR Dilithium', async () => {
    const master = masterFromSeed(Buffer.from('0f0e0d0c0b0a09080706050403020100', 'hex'));
    const { publicKey } = keyPairFromSeed(deriveKeySeed(master, 'external', 1));
    const tree = [{ depth: 0, leaf_version: LEAF_VERSION, script: hex(singleKeyLeafScript(publicKey)) }];
    const created = await rpc<{ address: string }>(cfg!, 'getnewp2mraddress', [tree, 'm0-info', false]);
    const info = await rpc<any>(cfg!, 'getaddressinfo', [created.address]);
    expect(info.isdilithium).toBe(true);
    expect(info.witness_version).toBe(2);
    expect(info.scriptPubKey.toLowerCase()).toBe(hex(outputScript(merkleRootForPublicKey(publicKey))));
  });

  it('our commitment check agrees with consensus for the single-leaf case', () => {
    const { publicKey } = keyPairFromSeed(new Uint8Array(32).fill(3));
    const leaf = singleKeyLeafScript(publicKey);
    const program = merkleRootForPublicKey(publicKey);
    expect(commitsToProgram(leaf, singleLeafControlBlock(), program)).toBe(true);
    const otherLeaf = singleKeyLeafScript(keyPairFromSeed(new Uint8Array(32).fill(4)).publicKey);
    expect(commitsToProgram(otherLeaf, singleLeafControlBlock(), program)).toBe(false);
  });
});
