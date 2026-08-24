/**
 * Dilithium m-of-n multisig: the threshold-accumulator P2MR leaf.
 *
 * btq-core reference:
 *   src/script/dilithium_leaf.cpp:13-25   GetScriptForDilithiumThreshold
 *   src/script/dilithium_leaf.cpp:41-77   ParseThresholdAccumulator
 *   src/script/dilithium_leaf.h:47-56     why the accumulator, not OP_CHECKMULTISIGDILITHIUM
 *   src/script/script.h:35                MAX_PUBKEYS_PER_MULTISIG = 20
 *   src/crypto/dilithium_pubkey.cpp:36-61 CDilithiumPubKey::IsFullyValid
 *   src/wallet/rpc/dilithium.cpp:500-519  createdilithiummultisig — caller key order, unsorted
 *   src/wallet/rpc/dilithium.cpp:511-515  ...but it does reject duplicate keys
 *
 * The leaf is
 *
 *   OP_0
 *   (OP_TOALTSTACK <pubkey> OP_CHECKSIGDILITHIUM OP_FROMALTSTACK OP_ADD) x n
 *   <m> OP_GREATERTHANOREQUAL
 *
 * and the reason it is this shape rather than OP_CHECKMULTISIGDILITHIUM is
 * cross-wallet partial signing: a key that did not sign contributes an empty
 * witness slot, which OP_CHECKSIGDILITHIUM scores as 0 without aborting, so
 * *any* m-sized subset of the n cosigners produces a valid witness and the
 * signers never have to agree on an order or meet at the same time.
 *
 * Address derivation reuses p2mr.ts wholesale: a multisig output is an ordinary
 * single-leaf P2MR tree whose leaf happens to name n keys, so the merkle root
 * is the TapLeaf hash and the control block is the same single 0xc1 byte.
 *
 * Error convention, matching the surrounding code: byte-level shape problems
 * (a key that is not 1312 bytes) throw a plain Error the way
 * singleKeyLeafScript does, because only a caller bug produces them; policy
 * problems a user can cause by enrolling cosigners (threshold out of range,
 * more than 20 keys, a duplicate or degenerate key) throw WalletError so the
 * UI has something to say.
 */
import { PUBLIC_KEY_BYTES } from '../crypto/mldsa.js';
import { WalletError } from '../wallet/errors.js';
import { compareBytes } from '../util/bytes.js';
import type { BtqNetwork } from './address.js';
import { encodeAddress } from './address.js';
import {
  OP_CHECKSIGDILITHIUM,
  OP_PUSHDATA2,
  outputScript,
  singleLeafControlBlock,
  tapLeafHash,
} from './p2mr.js';

export const OP_0 = 0x00;
export const OP_PUSHDATA1 = 0x4c;
export const OP_PUSHDATA4 = 0x4e;
export const OP_1 = 0x51;
export const OP_16 = 0x60;
export const OP_TOALTSTACK = 0x6b;
export const OP_FROMALTSTACK = 0x6c;
export const OP_ADD = 0x93;
export const OP_GREATERTHANOREQUAL = 0xa2;

/** btq-core MAX_PUBKEYS_PER_MULTISIG (src/script/script.h:35). */
export const MAX_COSIGNERS = 20;

/**
 * Bytes each cosigner adds to the leaf: OP_TOALTSTACK, the OP_PUSHDATA2 push of
 * the 1312-byte key, OP_CHECKSIGDILITHIUM, OP_FROMALTSTACK, OP_ADD.
 */
export const LEAF_BYTES_PER_COSIGNER = 1 + (1 + 2 + PUBLIC_KEY_BYTES) + 1 + 1 + 1;

/**
 * Exact serialized length of an m-of-n threshold leaf.
 *
 * The n term is what dominates; the threshold push is one byte for the OP_1..
 * OP_16 forms and two for 17..20, which is why m is a parameter at all. For
 * every m <= 16 this is the 1319n + 3 the design note quotes.
 */
export function LEAF_SCRIPT_BYTES_FOR(n: number, m = 1): number {
  return 1 + n * LEAF_BYTES_PER_COSIGNER + thresholdPush(m).length + 1;
}

/**
 * Port of CDilithiumPubKey::IsFullyValid: structural only, not a membership
 * proof. ML-DSA has no curve to be on — t1 is 10-bit packed so every 1312-byte
 * string unpacks in bounds — so all this can reject is the degenerate
 * encodings keygen never produces (all-zero, all-zero rho, all-zero t1).
 */
export function isFullyValidPublicKey(pubkey: Uint8Array): boolean {
  if (pubkey.length !== PUBLIC_KEY_BYTES) return false;
  let rhoNonzero = false;
  for (let i = 0; i < 32; i++) {
    if (pubkey[i] !== 0) { rhoNonzero = true; break; }
  }
  if (!rhoNonzero) return false;
  for (let i = 32; i < PUBLIC_KEY_BYTES; i++) if (pubkey[i] !== 0) return true;
  return false;
}

/**
 * The `<m>` push, following btq-core's CScript::push_int64 (src/script/script.h):
 * OP_0 for 0, OP_1..OP_16 for 1..16, otherwise a minimal CScriptNum data push.
 * Callers only ever reach it with 1 <= m <= 20, so the fall-through is always
 * the single-byte form with the sign bit clear — but the 0 case is spelled out
 * anyway so LEAF_SCRIPT_BYTES_FOR cannot quietly disagree with btq-core about a
 * threshold the builder would have rejected.
 */
function thresholdPush(m: number): Uint8Array {
  if (m === 0) return new Uint8Array([OP_0]);
  if (m >= 1 && m <= 16) return new Uint8Array([OP_1 - 1 + m]);
  return new Uint8Array([0x01, m]);
}

/**
 * Faithful port of GetScriptForDilithiumThreshold. Key order is taken exactly
 * as given — this is the byte-for-byte btq-core leaf, including the ordering
 * footgun. Wallet code should reach for canonicalThresholdLeafScript instead;
 * this exists so we can reproduce and parse a leaf built anywhere else.
 */
export function thresholdLeafScript(m: number, pubkeys: readonly Uint8Array[]): Uint8Array {
  const n = pubkeys.length;
  if (n < 1 || n > MAX_COSIGNERS) {
    throw new WalletError('BAD_PARAMS', `a threshold leaf needs 1 to ${MAX_COSIGNERS} cosigners, got ${n}`);
  }
  if (!Number.isInteger(m) || m < 1 || m > n) {
    throw new WalletError('BAD_PARAMS', `threshold must be between 1 and ${n}, got ${m}`);
  }
  for (const pubkey of pubkeys) {
    if (pubkey.length !== PUBLIC_KEY_BYTES) {
      throw new Error(`ML-DSA public key must be ${PUBLIC_KEY_BYTES} bytes`);
    }
  }

  const push = thresholdPush(m);
  const out = new Uint8Array(LEAF_SCRIPT_BYTES_FOR(n, m));
  let o = 0;
  out[o++] = OP_0;
  for (const pubkey of pubkeys) {
    out[o++] = OP_TOALTSTACK;
    out[o++] = OP_PUSHDATA2;
    out[o++] = PUBLIC_KEY_BYTES & 0xff;          // little-endian 16-bit length
    out[o++] = (PUBLIC_KEY_BYTES >> 8) & 0xff;
    out.set(pubkey, o);
    o += PUBLIC_KEY_BYTES;
    out[o++] = OP_CHECKSIGDILITHIUM;
    out[o++] = OP_FROMALTSTACK;
    out[o++] = OP_ADD;
  }
  out.set(push, o);
  out[o + push.length] = OP_GREATERTHANOREQUAL;
  return out;
}

interface ScriptOp {
  opcode: number;
  /** Pushed bytes, or null for a non-push opcode — CScript::GetOp clears the vector there. */
  data: Uint8Array | null;
  next: number;
}

/**
 * One step of CScript::GetOp. Deliberately does not require minimal pushes:
 * btq-core's parser does not either, and a parser stricter than the consensus
 * one would fail to recognise leaves the chain accepts.
 */
function getOp(script: Uint8Array, pos: number): ScriptOp | null {
  if (pos >= script.length) return null;
  const opcode = script[pos++]!;
  if (opcode > OP_PUSHDATA4) return { opcode, data: null, next: pos };

  let size = opcode;
  if (opcode === OP_PUSHDATA1) {
    if (pos + 1 > script.length) return null;
    size = script[pos]!;
    pos += 1;
  } else if (opcode === OP_PUSHDATA2) {
    if (pos + 2 > script.length) return null;
    size = script[pos]! | (script[pos + 1]! << 8);
    pos += 2;
  } else if (opcode === OP_PUSHDATA4) {
    if (pos + 4 > script.length) return null;
    size = (script[pos]! | (script[pos + 1]! << 8) | (script[pos + 2]! << 16)) + script[pos + 3]! * 0x1000000;
    pos += 4;
  }
  if (size > script.length - pos) return null;
  return { opcode, data: script.subarray(pos, pos + size), next: pos + size };
}

/** CScriptNum decode, little-endian with a sign bit in the top byte. */
function decodeScriptNum(data: Uint8Array): number {
  if (data.length === 0) return 0;
  let result = 0;
  for (let i = 0; i < data.length; i++) result += data[i]! * 2 ** (8 * i);
  if ((data[data.length - 1]! & 0x80) !== 0) {
    result -= 2 ** (8 * data.length - 1);
    return -result;
  }
  return result;
}

/** Port of DecodePushedNumber: any valid encoding, minimal or not, up to 4 bytes. */
function decodePushedNumber(op: ScriptOp): number | null {
  if (op.opcode === OP_0) return 0;
  if (op.opcode >= OP_1 && op.opcode <= OP_16) return op.opcode - (OP_1 - 1);
  const data = op.data;
  if (data === null || data.length === 0 || data.length > 4) return null;
  return decodeScriptNum(data);
}

export interface ThresholdLeaf {
  m: number;
  /** Public keys in script order; index 0 is evaluated first. */
  pubkeys: Uint8Array[];
}

/**
 * Inverse of thresholdLeafScript, porting ParseThresholdAccumulator. Returns
 * null for anything that is not exactly this template — including trailing
 * bytes after OP_GREATERTHANOREQUAL, more than 20 keys, and a threshold outside
 * 1..n. Null rather than a throw because callers classify untrusted scripts
 * with it: a leaf arriving in a PSBT is a question, not an error.
 */
export function parseThresholdLeaf(script: Uint8Array): ThresholdLeaf | null {
  let pos = 0;
  const start = getOp(script, pos);
  if (!start || start.opcode !== OP_0) return null;
  pos = start.next;

  const pubkeys: Uint8Array[] = [];
  let op: ScriptOp;
  for (;;) {
    const next = getOp(script, pos);
    if (!next) return null;
    pos = next.next;
    // Anything other than another OP_TOALTSTACK ends the key loop; this opcode
    // is then the threshold push.
    if (next.opcode !== OP_TOALTSTACK) { op = next; break; }

    const push = getOp(script, pos);
    if (!push || push.data === null || push.data.length !== PUBLIC_KEY_BYTES) return null;
    if (!isFullyValidPublicKey(push.data)) return null;
    pubkeys.push(Uint8Array.from(push.data));
    if (pubkeys.length > MAX_COSIGNERS) return null;
    pos = push.next;

    for (const expected of [OP_CHECKSIGDILITHIUM, OP_FROMALTSTACK, OP_ADD]) {
      const o = getOp(script, pos);
      if (!o || o.opcode !== expected) return null;
      pos = o.next;
    }
  }

  const m = decodePushedNumber(op);
  if (m === null) return null;
  const ge = getOp(script, pos);
  if (!ge || ge.opcode !== OP_GREATERTHANOREQUAL) return null;
  pos = ge.next;
  if (pos !== script.length) return null;
  if (pubkeys.length === 0 || m < 1 || m > pubkeys.length) return null;
  return { m, pubkeys };
}

/**
 * Sort the cosigner set lexicographically and reject duplicates. Both halves
 * close a footgun btq-core leaves open.
 *
 * Sorting: createdilithiummultisig takes the caller's key order and does not
 * sort it (src/wallet/rpc/dilithium.cpp:500-517), and there is no sortedmulti
 * equivalent for Dilithium. Key order changes the leaf bytes, so it changes the
 * TapLeaf hash, so it changes the address. Two cosigners who enrol the same
 * three keys in different orders therefore derive *different* addresses,
 * silently, and never see each other's funds. Ordering by the key bytes makes
 * enrolment order irrelevant.
 *
 * Duplicates: the accumulator counts one point per satisfied slot, so the same
 * private key filling two slots scores two — a 2-of-3 whose set contains one
 * key twice is really a 1-of-2. btq-core rejects them for that reason, in those
 * words, at src/wallet/rpc/dilithium.cpp:511-515 — but that is inside
 * createdilithiummultisig, a *wallet* RPC an extension can never call, and
 * neither GetScriptForDilithiumThreshold nor ParseThresholdAccumulator repeats
 * the check. So the rule has to be re-stated here, at the layer that actually
 * builds our addresses.
 */
export function canonicalCosigners(pubkeys: readonly Uint8Array[]): Uint8Array[] {
  const n = pubkeys.length;
  if (n < 1 || n > MAX_COSIGNERS) {
    throw new WalletError('BAD_PARAMS', `a multisig needs 1 to ${MAX_COSIGNERS} cosigners, got ${n}`);
  }
  for (const pubkey of pubkeys) {
    if (pubkey.length !== PUBLIC_KEY_BYTES) {
      throw new Error(`ML-DSA public key must be ${PUBLIC_KEY_BYTES} bytes`);
    }
    if (!isFullyValidPublicKey(pubkey)) {
      throw new WalletError('BAD_PARAMS', 'cosigner public key is degenerate: no ML-DSA keygen produces it');
    }
  }
  const sorted = pubkeys.map((k) => Uint8Array.from(k)).sort(compareBytes);
  for (let i = 1; i < sorted.length; i++) {
    if (compareBytes(sorted[i - 1]!, sorted[i]!) === 0) {
      throw new WalletError('BAD_PARAMS', 'duplicate cosigner public key: it would fill more than one signature slot');
    }
  }
  return sorted;
}

/** The leaf this wallet actually builds: canonical key order, duplicates refused. */
export function canonicalThresholdLeafScript(m: number, pubkeys: readonly Uint8Array[]): Uint8Array {
  return thresholdLeafScript(m, canonicalCosigners(pubkeys));
}

/** Single-leaf tree, so the merkle root is the TapLeaf hash itself. */
export function multisigMerkleRoot(m: number, pubkeys: readonly Uint8Array[]): Uint8Array {
  return tapLeafHash(canonicalThresholdLeafScript(m, pubkeys));
}

/** scriptPubKey = OP_2 <32-byte merkle root>, exactly as for a single-sig P2MR output. */
export function multisigOutputScript(m: number, pubkeys: readonly Uint8Array[]): Uint8Array {
  return outputScript(multisigMerkleRoot(m, pubkeys));
}

/**
 * The m-of-n address. Independent of the order the cosigner keys arrive in,
 * which is the whole point — see canonicalCosigners.
 */
export function multisigAddress(m: number, pubkeys: readonly Uint8Array[], network: BtqNetwork): string {
  return encodeAddress(multisigMerkleRoot(m, pubkeys), network);
}

/**
 * Control block for the single-leaf multisig tree: the leaf version with the
 * parity bit set and no merkle path, the same 0xc1 a single-sig spend uses.
 */
export function multisigControlBlock(): Uint8Array {
  return singleLeafControlBlock();
}
