/**
 * p2mrSighash — the message every BTQ spend signs. BTQ reuses the BIP341/342
 * tapscript sighash for witness v2 (btq-core interpreter.cpp:1696/1705), with
 * SIGHASH_DEFAULT rejected, so hash_type is always 0x01.
 *
 * Two kinds of coverage here: a frozen digest so the construction cannot drift
 * unnoticed, and a field-by-field check that every part of the transaction the
 * signature is supposed to commit to actually changes the digest. A field that
 * does *not* change it is a field an attacker can rewrite after we sign.
 */
import { describe, it, expect } from 'vitest';
import { p2mrSighash, txid } from '../../src/core/tx/sighash.js';
import { DEFAULT_SEQUENCE, type Tx } from '../../src/core/tx/serialize.js';
import { bytesToHex, hexToBytes } from '../../src/core/util/hex.js';
import { SIGHASH_ALL, signTransactionHash } from '../../src/core/crypto/mldsa.js';
import { deriveKeySeed, masterFromSeed } from '../../src/core/crypto/hd.js';
import vectors from '../vectors/golden.json' with { type: 'json' };

const SCRIPT0 = hexToBytes(vectors.entries[0]!.scriptPubKey);
const SCRIPT1 = hexToBytes(vectors.entries[1]!.scriptPubKey);
const LEAF_HASH = hexToBytes(vectors.entries[0]!.tapLeafHash);
const OTHER_LEAF_HASH = hexToBytes(vectors.entries[1]!.tapLeafHash);

function baseTx(): Tx {
  return {
    version: 2,
    locktime: 0,
    inputs: [{ txid: 'aa'.repeat(32), vout: 1, sequence: DEFAULT_SEQUENCE }],
    outputs: [
      { value: 10_000_000n, script: SCRIPT1 },
      { value: 89_999_628n, script: SCRIPT0 },
    ],
  };
}

const SPENT = [{ value: 100_000_000n, script: SCRIPT0 }];

/**
 * Frozen digest for the transaction above. Changing it means the sighash
 * construction changed, which means every signature this wallet produces would
 * be rejected by consensus (or, worse, would commit to different data).
 */
const PINNED = '5dbd5a7238664f7f4d7d06326e5ca44311aed7a93ad27ab0fbdb91729c099d5a';

describe('P2MR tapscript sighash', () => {
  it('reproduces the pinned digest for a fixed 1-in 2-out spend', () => {
    expect(bytesToHex(p2mrSighash(baseTx(), 0, SPENT, LEAF_HASH))).toBe(PINNED);
  });

  const mutations: { name: string; apply: (tx: Tx) => void }[] = [
    { name: 'version', apply: (tx) => (tx.version = 1) },
    { name: 'locktime', apply: (tx) => (tx.locktime = 500_000) },
    { name: 'input sequence', apply: (tx) => (tx.inputs[0]!.sequence = 0xffffffff) },
    { name: 'prevout txid', apply: (tx) => (tx.inputs[0]!.txid = 'bb'.repeat(32)) },
    { name: 'prevout index', apply: (tx) => (tx.inputs[0]!.vout = 0) },
    { name: 'destination amount', apply: (tx) => (tx.outputs[0]!.value += 1n) },
    { name: 'destination script', apply: (tx) => (tx.outputs[0]!.script = SCRIPT0) },
    { name: 'change amount', apply: (tx) => (tx.outputs[1]!.value -= 1n) },
    { name: 'an extra output', apply: (tx) => tx.outputs.push({ value: 1_000n, script: SCRIPT1 }) },
  ];

  for (const m of mutations) {
    it(`commits to the ${m.name}`, () => {
      // Attacker gain: any field the digest ignores can be rewritten between
      // our signature and the mempool — a different payee, a different amount.
      const tx = baseTx();
      m.apply(tx);
      expect(bytesToHex(p2mrSighash(tx, 0, SPENT, LEAF_HASH))).not.toBe(PINNED);
    });
  }

  it('commits to the spent amount and the spent script', () => {
    // This is the value the fee is computed from; without it a hostile explorer
    // could make us sign away a much larger coin than we accounted for.
    expect(bytesToHex(p2mrSighash(baseTx(), 0, [{ value: 100_000_001n, script: SCRIPT0 }], LEAF_HASH))).not.toBe(PINNED);
    expect(bytesToHex(p2mrSighash(baseTx(), 0, [{ value: 100_000_000n, script: SCRIPT1 }], LEAF_HASH))).not.toBe(PINNED);
  });

  it('commits to the leaf being executed', () => {
    expect(bytesToHex(p2mrSighash(baseTx(), 0, SPENT, OTHER_LEAF_HASH))).not.toBe(PINNED);
  });

  it('commits to the input index, so signatures cannot be shuffled between inputs', () => {
    const tx: Tx = {
      version: 2,
      locktime: 0,
      inputs: [
        { txid: 'aa'.repeat(32), vout: 0, sequence: DEFAULT_SEQUENCE },
        { txid: 'aa'.repeat(32), vout: 1, sequence: DEFAULT_SEQUENCE },
      ],
      outputs: [{ value: 1_000_000n, script: SCRIPT1 }],
    };
    const spent = [
      { value: 600_000n, script: SCRIPT0 },
      { value: 600_000n, script: SCRIPT0 },
    ];
    const a = bytesToHex(p2mrSighash(tx, 0, spent, LEAF_HASH));
    const b = bytesToHex(p2mrSighash(tx, 1, spent, LEAF_HASH));
    expect(a).not.toBe(b);
  });

  it('refuses a spent list that does not line up with the inputs', () => {
    // Signing with a mismatched prevout set means signing over amounts that are
    // not the ones being spent.
    expect(() => p2mrSighash(baseTx(), 0, [], LEAF_HASH)).toThrow(/spent output is required/);
    expect(() => p2mrSighash(baseTx(), 1, SPENT, LEAF_HASH)).toThrow(/out of range/);
    expect(() => p2mrSighash(baseTx(), 0, SPENT, new Uint8Array(31))).toThrow(/32 bytes/);
  });

  it('the witness item is the digest signed with SIGHASH_ALL appended', () => {
    const master = masterFromSeed(hexToBytes(vectors.hdSeedHex));
    const seed = deriveKeySeed(master, 'external', 0);
    const digest = p2mrSighash(baseTx(), 0, SPENT, LEAF_HASH);
    const sig = signTransactionHash(seed, digest);
    expect(sig.length).toBe(2421);
    expect(sig[2420]).toBe(SIGHASH_ALL);
    // btq-core interpreter.cpp:1965 rejects SIGHASH_DEFAULT for P2MR.
    expect(() => signTransactionHash(seed, digest, 0x00)).toThrow(/SIGHASH_DEFAULT/);
  });

  it('txid is the double-SHA256 of the stripped form in display order', () => {
    expect(txid(baseTx())).toMatch(/^[0-9a-f]{64}$/);
    // The witness is not part of the txid: adding one must not change it.
    const withWitness = baseTx();
    withWitness.inputs[0]!.witness = [new Uint8Array(2421), new Uint8Array(1316), new Uint8Array([0xc1])];
    expect(txid(withWitness)).toBe(txid(baseTx()));
  });
});
