/**
 * Rebuild a real BTQ testnet transaction from the recorded explorer record and
 * check our serialization, weight and txid against the numbers the chain
 * itself reports. This is the only place the wallet's byte layout is measured
 * against consensus without a node.
 *
 * Source: tests/fixtures/explorer/tx.json — txid 818891…b7a5 at height 300741,
 * 3 Dilithium P2MR inputs, one legacy P2PKH output and one P2MR output.
 */
import { describe, it, expect } from 'vitest';
import txFixture from '../fixtures/explorer/tx.json' with { type: 'json' };
import { hexToBytes } from '../../src/core/util/hex.js';
import { serializeStripped, serializeWithWitness, type Tx } from '../../src/core/tx/serialize.js';
import { txid as computeTxid } from '../../src/core/tx/sighash.js';
import { transactionWeight, virtualSizeCeil, P2MR_WITNESS_BYTES } from '../../src/core/tx/fee.js';
import { decodeTxPreview, parseTx } from '../../src/core/tx/parse.js';
import { LEAF_SCRIPT_BYTES, OP_CHECKSIGDILITHIUM, OP_PUSHDATA2 } from '../../src/core/script/p2mr.js';
import { TX_SIGNATURE_BYTES, SIGHASH_ALL } from '../../src/core/crypto/mldsa.js';

const body = txFixture.body;

const tx: Tx = {
  version: body.version,
  locktime: Number(body.locktime),
  inputs: body.inputs.map((i) => ({
    txid: i.prev_txid,
    vout: i.prev_vout,
    sequence: Number(i.sequence),
    witness: i.witness.map(hexToBytes),
  })),
  outputs: body.outputs.map((o) => ({ value: BigInt(o.value), script: hexToBytes(o.script_pub_key) })),
};

describe('on-chain transaction reproduced from the recorded explorer record', () => {
  it('serializes to the exact size, weight, vsize and txid the chain reports', () => {
    // A drift in scale-16 weight math or in the segwit layout means every fee
    // we quote is wrong and every txid we show the user is a different tx.
    const raw = serializeWithWitness(tx);
    const stripped = serializeStripped(tx);
    expect(raw.length).toBe(body.size);
    expect(stripped.length).toBe(210);
    expect(transactionWeight(stripped.length, raw.length)).toBe(body.weight);
    expect(virtualSizeCeil(body.weight)).toBe(body.vsize);
    expect(computeTxid(tx)).toBe(body.txid);
  });

  it('round-trips through the raw parser without changing a byte', () => {
    const raw = serializeWithWitness(tx);
    expect(parseTx(raw)).toEqual(tx);
    const preview = decodeTxPreview(raw);
    expect(preview.txid).toBe(body.txid);
    expect(preview.weight).toBe(body.weight);
    expect(preview.vsize).toBe(body.vsize);
    // The P2MR output decodes to the address the explorer names for it.
    expect(preview.outputs[1]!.address).toBe(body.outputs[1]!.addresses[0]!.address);
    // The legacy dilithium_pubkeyhash output is not a payable destination.
    expect(preview.outputs[0]!.address).toBeNull();
  });

  it('the on-chain witnesses have the exact shape this wallet builds', () => {
    // 2421-byte SIGHASH_ALL signature, 1316-byte single-key leaf, 0xc1 control.
    for (const input of tx.inputs) {
      const [signature, leaf, control] = input.witness as [Uint8Array, Uint8Array, Uint8Array];
      expect(signature.length).toBe(TX_SIGNATURE_BYTES);
      expect(signature[TX_SIGNATURE_BYTES - 1]).toBe(SIGHASH_ALL);
      expect(leaf.length).toBe(LEAF_SCRIPT_BYTES);
      expect(leaf[0]).toBe(OP_PUSHDATA2);
      expect(leaf[leaf.length - 1]).toBe(OP_CHECKSIGDILITHIUM);
      expect(control).toEqual(new Uint8Array([0xc1]));
    }
    // …and the witness byte count our fee estimate assumes is the real one.
    const witnessBytes = (raw: Uint8Array[]) =>
      1 + raw.reduce((n, item) => n + (item.length < 0xfd ? 1 : 3) + item.length, 0);
    expect(witnessBytes(tx.inputs[0]!.witness!)).toBe(P2MR_WITNESS_BYTES);
  });

  it('confirms the explorer fee equals inputs minus outputs for this tx', () => {
    const outputTotal = tx.outputs.reduce((n, o) => n + o.value, 0n);
    expect(outputTotal.toString()).toBe(body.output_value);
    expect(BigInt(body.fee)).toBe(600_000n);
  });
});
