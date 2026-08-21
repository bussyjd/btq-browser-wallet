/**
 * BTQ P2MR signature hash.
 *
 * BTQ reuses the BIP341/342 tapscript sighash unchanged for witness v2:
 * SigVersion::P2MR_TAPSCRIPT enters the same SignatureHashSchnorr with
 * ext_flag = 1 and key_version = 0. SIGHASH_DEFAULT is rejected, so hash_type
 * is always SIGHASH_ALL (0x01).
 *
 * btq-core reference:
 *   src/script/interpreter.cpp:1696  SignatureHashSchnorr
 *   src/script/interpreter.cpp:1705  case SigVersion::P2MR_TAPSCRIPT (ext_flag 1, key_version 0)
 *   src/script/interpreter.cpp:1724  EPOCH = 0
 *   src/script/interpreter.cpp:1749  spend_type = (ext_flag << 1) + have_annex
 *   src/script/interpreter.cpp:1965  SIGHASH_DEFAULT rejected for P2MR
 */
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, outpoint, u32le, u64le, withLength, serializeStripped, type Tx, type TxOutput } from './serialize.js';
import { SIGHASH_ALL } from '../crypto/mldsa.js';
import { bytesToHex, reverseBytes } from '../util/hex.js';

const KEY_VERSION = 0x00;
const EPOCH = 0x00;
const NO_CODESEPARATOR = 0xffffffff;

function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
  const t = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(t, t, msg));
}

/** The previous outputs being spent, in input order. */
export interface SpentOutput { value: bigint; script: Uint8Array }

/**
 * Tapscript sighash for input `index`, committing to `tapLeafHash`.
 * SIGHASH_ALL only — which is all BTQ P2MR consensus permits.
 */
export function p2mrSighash(tx: Tx, index: number, spent: SpentOutput[], tapLeafHash: Uint8Array): Uint8Array {
  if (spent.length !== tx.inputs.length) throw new Error('a spent output is required for every input');
  if (index < 0 || index >= tx.inputs.length) throw new Error('input index out of range');
  if (tapLeafHash.length !== 32) throw new Error('tapleaf hash must be 32 bytes');

  const shaPrevouts = sha256(concatBytes(...tx.inputs.map(outpoint)));
  const shaAmounts = sha256(concatBytes(...spent.map((s) => u64le(s.value))));
  const shaScriptPubKeys = sha256(concatBytes(...spent.map((s) => withLength(s.script))));
  const shaSequences = sha256(concatBytes(...tx.inputs.map((i) => u32le(i.sequence))));
  const shaOutputs = sha256(concatBytes(...tx.outputs.map(serializeOutput)));

  const spendType = (1 << 1) + 0; // ext_flag = 1 (tapscript), no annex

  const msg = concatBytes(
    new Uint8Array([EPOCH]),
    new Uint8Array([SIGHASH_ALL]),
    u32le(tx.version),
    u32le(tx.locktime),
    shaPrevouts, shaAmounts, shaScriptPubKeys, shaSequences,
    shaOutputs,
    new Uint8Array([spendType]),
    u32le(index),
    tapLeafHash,
    new Uint8Array([KEY_VERSION]),
    u32le(NO_CODESEPARATOR),
  );
  return taggedHash('TapSighash', msg);
}

function serializeOutput(o: TxOutput): Uint8Array {
  return concatBytes(u64le(o.value), withLength(o.script));
}

/** Display-order txid (double SHA-256 of the stripped serialization, reversed). */
export function txid(tx: Tx): string {
  const h = sha256(sha256(serializeStripped(tx)));
  return bytesToHex(reverseBytes(h));
}
