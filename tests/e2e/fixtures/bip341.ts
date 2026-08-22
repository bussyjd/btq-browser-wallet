/**
 * BIP341/342 hashes, written here in the test tree straight from the BIP text.
 *
 * This file is the independent half of the smoke test: the mock node verifies
 * the extension's signatures with code the extension does not share. It must
 * therefore NEVER import `src/core/tx/sighash.ts` or `src/core/script/p2mr.ts`
 * — only `@noble/hashes`. `tests/e2e/smoke.spec.ts` pins the tagged hashes
 * below to `tests/vectors/golden.json` (verified against btq-core), so an
 * independent implementation that quietly drifted would fail there first.
 *
 * BIP341 §Common Signature Message:
 *   hash_TapSighash(epoch || SigMsg)
 *   SigMsg = hash_type || nVersion || nLockTime
 *            || sha_prevouts || sha_amounts || sha_scriptpubkeys || sha_sequences
 *            || sha_outputs
 *            || spend_type || input_index
 *   ext (BIP342 tapscript) = tapleaf_hash || key_version || codesep_pos
 *
 * BTQ reuses this for witness v2 / P2MR with ext_flag = 1, key_version = 0 and
 * SIGHASH_DEFAULT rejected, so hash_type is always SIGHASH_ALL (0x01).
 */
import { sha256 } from '@noble/hashes/sha256';

/** Leaf version of a BTQ single-key Dilithium leaf. */
export const TAPLEAF_VERSION = 0xc0;
/** Single-leaf control block: leaf version | parity bit, no path. */
export const CONTROL_BYTE = 0xc1;
export const SIGHASH_ALL = 0x01;
/** ext_flag = 1 (tapscript), no annex. */
export const SPEND_TYPE = (1 << 1) + 0;
export const KEY_VERSION = 0x00;
export const NO_CODESEPARATOR = 0xffffffff;

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function byte(n: number): Uint8Array {
  return new Uint8Array([n & 0xff]);
}

export function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}

export function u64le(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

/** Bitcoin compact size. */
export function compactSize(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) throw new Error('compact size must be a non-negative integer');
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff]);
  if (n <= 0xffffffff) return new Uint8Array([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
  throw new Error('compact size too large');
}

export function withCompactLength(b: Uint8Array): Uint8Array {
  return concat(compactSize(b.length), b);
}

/** BIP340 tagged hash: sha256(sha256(tag) || sha256(tag) || msg). */
export function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
  const t = sha256(new TextEncoder().encode(tag));
  return sha256(concat(t, t, msg));
}

/** BIP341 TapLeaf: tagged_hash("TapLeaf", version || compact_size(len) || script). */
export function tapLeafHash(script: Uint8Array, version = TAPLEAF_VERSION): Uint8Array {
  return taggedHash('TapLeaf', concat(byte(version), withCompactLength(script)));
}

export function tapBranchHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [lo, hi] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  return taggedHash('TapBranch', concat(lo, hi));
}

export function sha256d(bytes: Uint8Array): Uint8Array {
  return sha256(sha256(bytes));
}

export function reverse(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes).reverse();
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new Error('invalid hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return 0;
}

export interface SigInput {
  /** Display-order (big-endian) txid, as RPC prints it. */
  txid: string;
  vout: number;
  sequence: number;
}

export interface SigOutput {
  value: bigint;
  script: Uint8Array;
}

export interface SigTx {
  version: number;
  locktime: number;
  inputs: SigInput[];
  outputs: SigOutput[];
}

/** The previous outputs being spent, in input order. */
export interface Prevout {
  value: bigint;
  script: Uint8Array;
}

function outpoint(input: SigInput): Uint8Array {
  return concat(reverse(fromHex(input.txid)), u32le(input.vout));
}

function serializedOutput(o: SigOutput): Uint8Array {
  return concat(u64le(o.value), withCompactLength(o.script));
}

/**
 * BIP341 tapscript signature hash for input `index`, committing to `leafHash`.
 * Amounts and scripts come from `prevouts` (the ledger), never from the tx.
 */
export function tapscriptSighash(
  tx: SigTx,
  index: number,
  prevouts: Prevout[],
  leafHash: Uint8Array,
  hashType = SIGHASH_ALL,
): Uint8Array {
  if (prevouts.length !== tx.inputs.length) throw new Error('one prevout per input is required');
  if (index < 0 || index >= tx.inputs.length) throw new Error('input index out of range');
  if (leafHash.length !== 32) throw new Error('tapleaf hash must be 32 bytes');

  const shaPrevouts = sha256(concat(...tx.inputs.map(outpoint)));
  const shaAmounts = sha256(concat(...prevouts.map((p) => u64le(p.value))));
  const shaScriptPubKeys = sha256(concat(...prevouts.map((p) => withCompactLength(p.script))));
  const shaSequences = sha256(concat(...tx.inputs.map((i) => u32le(i.sequence))));
  const shaOutputs = sha256(concat(...tx.outputs.map(serializedOutput)));

  const sigMsg = concat(
    byte(hashType),
    u32le(tx.version),
    u32le(tx.locktime),
    shaPrevouts,
    shaAmounts,
    shaScriptPubKeys,
    shaSequences,
    shaOutputs,
    byte(SPEND_TYPE),
    u32le(index),
    leafHash,
    byte(KEY_VERSION),
    u32le(NO_CODESEPARATOR),
  );
  // epoch 0x00 is prepended before the tagged hash (BIP341, "Common Signature Message").
  return taggedHash('TapSighash', concat(byte(0x00), sigMsg));
}

/**
 * Does `control` prove `leaf` is the tree whose root is `program`?
 * Independent re-implementation of the check the wallet runs before signing.
 */
export function leafCommitsToProgram(leaf: Uint8Array, control: Uint8Array, program: Uint8Array): boolean {
  if (control.length < 1) return false;
  const head = control[0] as number;
  if ((head & 1) !== 1) return false;
  if ((control.length - 1) % 32 !== 0) return false;
  let node = tapLeafHash(leaf, head & 0xfe);
  for (let i = 1; i + 32 <= control.length; i += 32) {
    node = tapBranchHash(node, control.subarray(i, i + 32));
  }
  return bytesEqual(node, program);
}
