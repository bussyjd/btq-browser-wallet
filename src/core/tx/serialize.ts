/** Bitcoin-format transaction serialization (BTQ inherits it unchanged). */
import { hexToBytes, reverseBytes } from '../util/hex.js';
export interface TxInput {
  txid: string;          // big-endian display order, as in RPC output
  vout: number;
  sequence: number;
  witness?: Uint8Array[];
}
export interface TxOutput {
  value: bigint;         // satoshis
  script: Uint8Array;
}
export interface Tx {
  version: number;
  locktime: number;
  inputs: TxInput[];
  outputs: TxOutput[];
}

export const DEFAULT_SEQUENCE = 0xfffffffd; // opt in to RBF

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function u32le(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new Error('value does not fit in uint32');
  }
  const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b;
}
export function u64le(n: bigint): Uint8Array {
  if (n < 0n || n > 0xffff_ffff_ffff_ffffn) {
    throw new Error('value does not fit in uint64');
  }
  const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b;
}
export function varint(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return concatBytes(new Uint8Array([0xfd]), new Uint8Array([n & 0xff, (n >> 8) & 0xff]));
  if (n <= 0xffffffff) return concatBytes(new Uint8Array([0xfe]), u32le(n));
  throw new Error('varint too large');
}
export function withLength(b: Uint8Array): Uint8Array {
  return concatBytes(varint(b.length), b);
}
/** RPC txids are big-endian display order; the wire format is little-endian. */
export function txidToBytes(txid: string): Uint8Array {
  const b = hexToBytes(txid);
  if (b.length !== 32) throw new Error('txid must be 32 bytes');
  return reverseBytes(b);
}
export function outpoint(input: TxInput): Uint8Array {
  return concatBytes(txidToBytes(input.txid), u32le(input.vout));
}

/** Serialize without witness data (the "stripped" form used for txid and weight). */
export function serializeStripped(tx: Tx): Uint8Array {
  const parts: Uint8Array[] = [u32le(tx.version), varint(tx.inputs.length)];
  for (const i of tx.inputs) parts.push(outpoint(i), varint(0), u32le(i.sequence));
  parts.push(varint(tx.outputs.length));
  for (const o of tx.outputs) parts.push(u64le(o.value), withLength(o.script));
  parts.push(u32le(tx.locktime));
  return concatBytes(...parts);
}

/** Serialize with the segwit marker/flag and witness stacks. */
export function serializeWithWitness(tx: Tx): Uint8Array {
  const hasWitness = tx.inputs.some((i) => i.witness && i.witness.length > 0);
  if (!hasWitness) return serializeStripped(tx);
  const parts: Uint8Array[] = [u32le(tx.version), new Uint8Array([0x00, 0x01]), varint(tx.inputs.length)];
  for (const i of tx.inputs) parts.push(outpoint(i), varint(0), u32le(i.sequence));
  parts.push(varint(tx.outputs.length));
  for (const o of tx.outputs) parts.push(u64le(o.value), withLength(o.script));
  for (const i of tx.inputs) {
    const stack = i.witness ?? [];
    parts.push(varint(stack.length));
    for (const item of stack) parts.push(withLength(item));
  }
  parts.push(u32le(tx.locktime));
  return concatBytes(...parts);
}
