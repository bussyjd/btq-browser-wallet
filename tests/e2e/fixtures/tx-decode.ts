/**
 * Raw-transaction decoding for the mock node.
 *
 * The decoder itself is `src/core/tx/parse.ts` (round-trip tested against
 * `serializeWithWitness` in tests/unit/tx-parse.test.ts, as the smoke-test spec
 * allows), but everything measured from the bytes here — the stripped and
 * witness serializations, the txid, the weight and the vsize — is re-derived in
 * the test tree from the wire format so a bug in the wallet's serializer cannot
 * agree with itself. `roundTripsExactly` proves the decode is lossless before a
 * single number is trusted.
 */
import { parseTx } from '../../../src/core/tx/parse.js';
import type { Tx } from '../../../src/core/tx/serialize.js';
import {
  compactSize,
  concat,
  fromHex,
  reverse,
  sha256d,
  toHex,
  u32le,
  u64le,
  withCompactLength,
} from './bip341.js';
import { vsizeOf, weightOf } from './consensus.js';

export type { Tx };

/** version | vin (empty scriptSigs) | vout | locktime — the txid preimage. */
export function serializeStripped(tx: Tx): Uint8Array {
  const parts: Uint8Array[] = [u32le(tx.version), compactSize(tx.inputs.length)];
  for (const i of tx.inputs) {
    parts.push(reverse(fromHex(i.txid)), u32le(i.vout), compactSize(0), u32le(i.sequence));
  }
  parts.push(compactSize(tx.outputs.length));
  for (const o of tx.outputs) parts.push(u64le(o.value), withCompactLength(o.script));
  parts.push(u32le(tx.locktime));
  return concat(...parts);
}

/** BIP144: version | 0x00 0x01 | vin | vout | witnesses | locktime. */
export function serializeWithWitness(tx: Tx): Uint8Array {
  const hasWitness = tx.inputs.some((i) => (i.witness?.length ?? 0) > 0);
  if (!hasWitness) return serializeStripped(tx);
  const parts: Uint8Array[] = [u32le(tx.version), new Uint8Array([0x00, 0x01]), compactSize(tx.inputs.length)];
  for (const i of tx.inputs) {
    parts.push(reverse(fromHex(i.txid)), u32le(i.vout), compactSize(0), u32le(i.sequence));
  }
  parts.push(compactSize(tx.outputs.length));
  for (const o of tx.outputs) parts.push(u64le(o.value), withCompactLength(o.script));
  for (const i of tx.inputs) {
    const stack = i.witness ?? [];
    parts.push(compactSize(stack.length));
    for (const item of stack) parts.push(withCompactLength(item));
  }
  parts.push(u32le(tx.locktime));
  return concat(...parts);
}

export interface DecodedRaw {
  tx: Tx;
  raw: Uint8Array;
  stripped: Uint8Array;
  /** sha256d of the stripped serialization, reversed into display order. */
  txid: string;
  size: number;
  weight: number;
  vsize: number;
}

export function decodeRaw(hex: string): DecodedRaw {
  const raw = fromHex(hex.trim());
  const tx = parseTx(raw);
  const stripped = serializeStripped(tx);
  const again = serializeWithWitness(tx);
  if (toHex(again) !== toHex(raw)) {
    throw new Error('decoded transaction does not re-serialize to the same bytes');
  }
  const weight = weightOf(stripped.length, raw.length);
  return {
    tx,
    raw,
    stripped,
    txid: toHex(reverse(sha256d(stripped))),
    size: raw.length,
    weight,
    vsize: vsizeOf(weight),
  };
}
