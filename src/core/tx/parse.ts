/**
 * Decode a raw Bitcoin/BTQ transaction back into the `Tx` shape this wallet
 * builds. This is what makes an approval screen honest: instead of re-printing
 * the plan we typed in, we decode the exact bytes that are about to be
 * broadcast and show those.
 *
 * Format (BTQ inherits Bitcoin's, BIP144 included):
 *   version(4 LE) [ marker(0x00) flag(0x01) ] vin vout [ witness… ] locktime(4 LE)
 *
 * Everything here is pure and browser-safe: no Buffer, no I/O.
 */
import { bytesToHex, hexToBytes, reverseBytes } from '../util/hex.js';
import { readCompactSize, readUintLE } from '../util/bytes.js';
import { serializeStripped, serializeWithWitness, type Tx, type TxInput, type TxOutput } from './serialize.js';
import { transactionWeight, virtualSizeCeil } from './fee.js';
import { txid as txidOf } from './sighash.js';
import { decodeAddress, encodeAddress, type BtqNetwork } from '../script/address.js';
import { OP_2 } from '../script/p2mr.js';

export class TxParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TxParseError';
  }
}

/**
 * Hex → bytes with the parser's own error type. `hexToBytes` throws a plain
 * `Error` for an odd length or a non-hex character; letting that escape makes
 * `parseTx`'s contract ("every rejection is a TxParseError") untrue for exactly
 * the input class a caller is most likely to pass by accident.
 */
function toBytes(raw: Uint8Array | string): Uint8Array {
  if (typeof raw !== 'string') return raw;
  try {
    return hexToBytes(raw.trim());
  } catch (e) {
    throw new TxParseError(e instanceof Error ? e.message : 'not a hex string');
  }
}

class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}

  need(n: number): void {
    if (this.offset + n > this.bytes.length) throw new TxParseError('transaction ends early');
  }

  u8(): number {
    this.need(1);
    return this.bytes[this.offset++]!;
  }

  uint(size: number): bigint {
    this.need(size);
    const v = readUintLE(this.bytes, this.offset, size);
    this.offset += size;
    return v;
  }

  u32(): number {
    return Number(this.uint(4));
  }

  count(): number {
    try {
      const { value, offset } = readCompactSize(this.bytes, this.offset);
      this.offset = offset;
      return value;
    } catch (e) {
      throw new TxParseError(e instanceof Error ? e.message : 'bad compact size');
    }
  }

  slice(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return Uint8Array.from(out);
  }
}

/** Decode a raw transaction (hex or bytes) into the wallet's `Tx` shape. */
export function parseTx(raw: Uint8Array | string): Tx {
  const bytes = toBytes(raw);
  if (bytes.length < 10) throw new TxParseError('transaction is too short');
  const r = new Reader(bytes);

  const version = r.u32();
  let inputCount = r.count();
  let hasWitness = false;
  if (inputCount === 0) {
    // BIP144 marker 0x00 followed by a non-zero flag.
    const flag = r.u8();
    if (flag !== 0x01) throw new TxParseError('unsupported segwit flag');
    hasWitness = true;
    inputCount = r.count();
    if (inputCount === 0) throw new TxParseError('a transaction must spend at least one input');
  }

  const inputs: TxInput[] = [];
  for (let i = 0; i < inputCount; i++) {
    const prev = r.slice(32);
    const vout = r.u32();
    const scriptSigLen = r.count();
    const scriptSig = r.slice(scriptSigLen);
    // P2MR spends are witness-only; a non-empty scriptSig is not something this
    // wallet ever produces, and consensus rejects it for witness v2.
    if (scriptSig.length !== 0) throw new TxParseError('scriptSig must be empty for a P2MR spend');
    const sequence = r.u32();
    inputs.push({ txid: bytesToHex(reverseBytes(prev)), vout, sequence });
  }

  const outputCount = r.count();
  const outputs: TxOutput[] = [];
  for (let i = 0; i < outputCount; i++) {
    const value = r.uint(8);
    const scriptLen = r.count();
    outputs.push({ value, script: r.slice(scriptLen) });
  }

  if (hasWitness) {
    for (const input of inputs) {
      const items = r.count();
      const stack: Uint8Array[] = [];
      for (let i = 0; i < items; i++) stack.push(r.slice(r.count()));
      if (stack.length > 0) input.witness = stack;
    }
  }

  const locktime = r.u32();
  if (r.offset !== bytes.length) throw new TxParseError('trailing bytes after the transaction');
  return { version, locktime, inputs, outputs };
}

export interface DecodedOutput {
  index: number;
  value: string;
  script: string;
  /** The P2MR address the script pays, or null for any other script type. */
  address: string | null;
}

export interface DecodedTx {
  txid: string;
  version: number;
  locktime: number;
  weight: number;
  vsize: number;
  size: number;
  hasWitness: boolean;
  inputs: { txid: string; vout: number; sequence: number; witnessItems: number }[];
  outputs: DecodedOutput[];
}

/**
 * Decode broadcast bytes for a preview the UI can render. Every number here
 * comes out of the signed transaction, never from the plan that produced it —
 * that is the whole point: a bug in plan → bytes shows up on the screen.
 */
export function decodeTxPreview(raw: Uint8Array | string, network: BtqNetwork = 'testnet'): DecodedTx {
  const bytes = toBytes(raw);
  const tx = parseTx(bytes);
  const stripped = serializeStripped(tx);
  const weight = transactionWeight(stripped.length, bytes.length);
  return {
    txid: txidOf(tx),
    version: tx.version,
    locktime: tx.locktime,
    weight,
    vsize: virtualSizeCeil(weight),
    size: bytes.length,
    hasWitness: tx.inputs.some((i) => (i.witness?.length ?? 0) > 0),
    inputs: tx.inputs.map((i) => ({
      txid: i.txid,
      vout: i.vout,
      sequence: i.sequence,
      witnessItems: i.witness?.length ?? 0,
    })),
    outputs: tx.outputs.map((o, index) => ({
      index,
      value: o.value.toString(),
      script: bytesToHex(o.script),
      address: addressForOutputScript(o.script, network),
    })),
  };
}

/** `OP_2 <32-byte program>` → the tbtq1z… address that pays it; null otherwise. */
export function addressForOutputScript(script: Uint8Array, network: BtqNetwork = 'testnet'): string | null {
  if (script.length !== 34 || script[0] !== OP_2 || script[1] !== 0x20) return null;
  try {
    const address = encodeAddress(script.subarray(2), network);
    decodeAddress(address, network); // round-trip check, never trust a raw encode
    return address;
  } catch {
    return null;
  }
}

/** Round-trip guard used by the builder: bytes → Tx → bytes must be identical. */
export function reserializesIdentically(raw: Uint8Array): boolean {
  try {
    const tx = parseTx(raw);
    const again = serializeWithWitness(tx);
    if (again.length !== raw.length) return false;
    for (let i = 0; i < raw.length; i++) if (again[i] !== raw[i]) return false;
    return true;
  } catch {
    return false;
  }
}
