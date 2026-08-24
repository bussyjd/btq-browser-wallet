/**
 * PSBT decoding, with btq-core's bounds and its fail-closed validation.
 *
 * btq-core reference:
 *   src/psbt.h:410-432   PSBTInput::Unserialize read loop, duplicate-key set
 *   src/psbt.h:719-778   the P2MR/Dilithium cases and every bound they enforce
 *   src/psbt.h:1140-1200 PartiallySignedTransaction::Unserialize, magic bytes
 *   src/psbt_dilithium.h:64-68        ValidateP2MRDilithiumPSBT
 *
 * Two things here are not what a typical PSBT library does, and both are
 * deliberate.
 *
 * First, `parsePsbt` verifies **every** Dilithium partial signature before it
 * returns, recomputing the BIP341 sighash from the transaction rather than
 * trusting anything the PSBT says about it. btq-core does this at decode time
 * and zeroes the PSBT on failure, which is why `decodepsbt` on a forged
 * signature is an error rather than a decode
 * (test/functional/wallet_dilithium_psbt_multisig.py:164-165). A decoder that
 * accepts a forged signature and only notices at finalize is strictly worse
 * than the node's, so we match it: the throw is the zeroing.
 *
 * Second, fields this module does not model are kept verbatim as
 * `{key, value}` pairs, so a parse/serialize round trip reproduces the input
 * byte-for-byte instead of silently dropping what it did not understand.
 */
import { base64 } from '@scure/base';
import { readCompactSize, readUintLE } from '../util/bytes.js';
import { bytesToHex } from '../util/hex.js';
import { WalletError } from '../wallet/errors.js';
import { parseTx } from '../tx/parse.js';
import { serializeStripped } from '../tx/serialize.js';
import { isFullyValidPublicKey } from '../script/multisig.js';
import { PUBLIC_KEY_BYTES } from '../crypto/mldsa.js';
import { validateP2MRDilithiumPsbt } from './validate.js';
import {
  DILITHIUM_PARTIAL_SIG_SIZE,
  MAX_DILITHIUM_PARTIAL_SIGS_PER_INPUT,
  MAX_P2MR_LEAF_SCRIPT_SIZE,
  P2MR_CONTROL_BASE_SIZE,
  P2MR_CONTROL_MAX_SIZE,
  P2MR_CONTROL_NODE_SIZE,
  PSBT_GLOBAL_UNSIGNED_TX,
  PSBT_IN_P2MR_DILITHIUM_SCRIPT_SIG,
  PSBT_IN_P2MR_LEAF_SCRIPT,
  PSBT_IN_P2MR_MERKLE_ROOT,
  PSBT_IN_SCRIPTSIG,
  PSBT_IN_SCRIPTWITNESS,
  PSBT_IN_SIGHASH,
  PSBT_IN_WITNESS_UTXO,
  PSBT_MAGIC,
  type DilithiumPartialSignature,
  type P2MRLeafScript,
  type Psbt,
  type PsbtInput,
  type PsbtKeyValue,
  type PsbtOutput,
} from './types.js';
import { compareControlBlocks, compareDilithiumSigs, compareLeaves } from './order.js';

/** Every rejection this module makes, so callers never have to guess. */
export function psbtError(message: string): WalletError {
  return new WalletError('BAD_PSBT', message);
}

class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  take(n: number): Uint8Array {
    if (n < 0 || this.offset + n > this.bytes.length) throw psbtError('PSBT ends early');
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return Uint8Array.from(out);
  }

  compactSize(): number {
    try {
      const { value, offset } = readCompactSize(this.bytes, this.offset);
      this.offset = offset;
      return value;
    } catch (e) {
      throw psbtError(e instanceof Error ? e.message : 'bad compact size');
    }
  }

  /** A compact-size length followed by that many bytes — a PSBT key or value. */
  lengthPrefixed(): Uint8Array {
    return this.take(this.compactSize());
  }
}

/**
 * Read one key/value map up to its separator. btq-core throws when a map runs
 * out without one (`"Separator is missing at the end of an input map"`), and so
 * do we — a truncated map is not an empty map.
 */
function readMap(r: Reader, what: string): PsbtKeyValue[] {
  const entries: PsbtKeyValue[] = [];
  const seen = new Set<string>();
  for (;;) {
    if (r.done) throw psbtError(`separator is missing at the end of the ${what} map`);
    const keyLength = r.compactSize();
    if (keyLength === 0) return entries; // the separator is a zero-length key
    const key = r.take(keyLength);
    const hex = bytesToHex(key);
    if (seen.has(hex)) throw psbtError(`duplicate key in the ${what} map: 0x${hex.slice(0, 16)}…`);
    seen.add(hex);
    entries.push({ key, value: r.lengthPrefixed() });
  }
}

/**
 * The compact-size type at the head of a PSBT key.
 *
 * `readCompactSize` throws a plain `Error` for a truncated or non-canonical
 * encoding, and a one-byte key of 0xfd is exactly that. Re-tagging it keeps
 * this module's promise that every rejection a caller can trigger is a
 * `WalletError('BAD_PSBT')`.
 */
export function keyType(key: Uint8Array): number {
  try {
    return readCompactSize(key, 0).value;
  } catch (e) {
    throw psbtError(`PSBT key has no valid type prefix: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Values that are themselves length-prefixed inside the value field. */
function fixedLengthValue(value: Uint8Array, expected: number, what: string): Uint8Array {
  if (value.length !== expected) {
    throw psbtError(`${what} must be ${expected} bytes, got ${value.length}`);
  }
  return value;
}

function parseWitnessUtxo(value: Uint8Array): { value: bigint; script: Uint8Array } {
  if (value.length < 9) throw psbtError('witness UTXO is truncated');
  const amount = readUintLE(value, 0, 8);
  let scriptLength: number;
  let offset: number;
  try {
    ({ value: scriptLength, offset } = readCompactSize(value, 8));
  } catch (e) {
    throw psbtError(`witness UTXO script length is malformed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (offset + scriptLength !== value.length) {
    throw psbtError('witness UTXO length does not match its stated size');
  }
  return { value: amount, script: value.slice(offset, offset + scriptLength) };
}

function parseWitnessStack(value: Uint8Array): Uint8Array[] {
  const r = new Reader(value);
  const count = r.compactSize();
  const stack: Uint8Array[] = [];
  for (let i = 0; i < count; i++) stack.push(r.lengthPrefixed());
  if (!r.done) throw psbtError('final scriptWitness length does not match its stated size');
  return stack;
}

/**
 * The `0x19` leaf-script bounds, straight out of src/psbt.h:719-732. The
 * control block lives in the *key*, so its size checks are key-size checks:
 * at least one byte of leaf version, at most 1 + 32*128, and a whole number of
 * 32-byte merkle nodes in between.
 */
function parseLeafScriptEntry(key: Uint8Array, value: Uint8Array): { control: Uint8Array; script: Uint8Array; leafVersion: number } {
  if (key.length < 1 + P2MR_CONTROL_BASE_SIZE) {
    throw psbtError('P2MR leaf script key is too short to hold a control block');
  }
  if (key.length > 1 + P2MR_CONTROL_MAX_SIZE) {
    throw psbtError("P2MR leaf script key's control block is too large");
  }
  if ((key.length - 1 - P2MR_CONTROL_BASE_SIZE) % P2MR_CONTROL_NODE_SIZE !== 0) {
    throw psbtError("P2MR leaf script key's control block size is not valid");
  }
  if (value.length === 0) throw psbtError('P2MR leaf script must be at least 1 byte');
  if (value.length - 1 > MAX_P2MR_LEAF_SCRIPT_SIZE) throw psbtError('P2MR leaf script is too large');
  return {
    control: key.slice(1),
    script: value.slice(0, value.length - 1),
    leafVersion: value[value.length - 1]!,
  };
}

function parseDilithiumSigEntry(key: Uint8Array, value: Uint8Array): DilithiumPartialSignature {
  if (key.length !== 1 + PUBLIC_KEY_BYTES + 32) {
    throw psbtError('P2MR Dilithium script signature key is not the expected size');
  }
  const pubkey = key.slice(1, 1 + PUBLIC_KEY_BYTES);
  if (!isFullyValidPublicKey(pubkey)) throw psbtError('invalid Dilithium pubkey');
  if (value.length !== DILITHIUM_PARTIAL_SIG_SIZE) {
    throw psbtError('P2MR Dilithium partial signature has an invalid length');
  }
  return { pubkey, leafHash: key.slice(1 + PUBLIC_KEY_BYTES), signature: value };
}

function parseInput(entries: PsbtKeyValue[]): PsbtInput {
  const input: PsbtInput = { p2mrLeaves: [], dilithiumSigs: [], other: [] };
  const leaves = new Map<string, P2MRLeafScript>();

  for (const { key, value } of entries) {
    switch (keyType(key)) {
      case PSBT_IN_WITNESS_UTXO:
        if (key.length !== 1) throw psbtError('witness utxo key is more than one byte type');
        input.witnessUtxo = parseWitnessUtxo(value);
        break;
      case PSBT_IN_SIGHASH:
        if (key.length !== 1) throw psbtError('sighash type key is more than one byte type');
        input.sighashType = Number(readUintLE(fixedLengthValue(value, 4, 'sighash type'), 0, 4));
        break;
      case PSBT_IN_SCRIPTSIG:
        if (key.length !== 1) throw psbtError('final scriptSig key is more than one byte type');
        input.finalScriptSig = value;
        break;
      case PSBT_IN_SCRIPTWITNESS:
        if (key.length !== 1) throw psbtError('final scriptWitness key is more than one byte type');
        input.finalScriptWitness = parseWitnessStack(value);
        break;
      case PSBT_IN_P2MR_LEAF_SCRIPT: {
        const { control, script, leafVersion } = parseLeafScriptEntry(key, value);
        // btq-core stores these in a map keyed by (script, leaf_version) whose
        // value is a *set* of control blocks, so two entries that differ only
        // in their control block collapse into one leaf with two blocks.
        const id = `${leafVersion}:${bytesToHex(script)}`;
        const existing = leaves.get(id);
        if (existing) existing.controlBlocks.push(control);
        else leaves.set(id, { script, leafVersion, controlBlocks: [control] });
        break;
      }
      case PSBT_IN_P2MR_MERKLE_ROOT:
        if (key.length !== 1) throw psbtError('P2MR merkle root key is more than one byte type');
        input.p2mrMerkleRoot = fixedLengthValue(value, 32, 'P2MR merkle root');
        break;
      case PSBT_IN_P2MR_DILITHIUM_SCRIPT_SIG:
        if (input.dilithiumSigs.length >= MAX_DILITHIUM_PARTIAL_SIGS_PER_INPUT) {
          throw psbtError('too many P2MR Dilithium partial signatures for one input');
        }
        input.dilithiumSigs.push(parseDilithiumSigEntry(key, value));
        break;
      default:
        input.other.push({ key, value });
    }
  }

  for (const leaf of leaves.values()) {
    leaf.controlBlocks.sort(compareControlBlocks);
    input.p2mrLeaves.push(leaf);
  }
  input.p2mrLeaves.sort(compareLeaves);
  input.dilithiumSigs.sort(compareDilithiumSigs);
  return input;
}

/**
 * Output maps are carried opaquely. btq-core validates some of their contents —
 * it rebuilds and re-checks a `PSBT_OUT_TAP_TREE`, for instance — so our
 * decoder is the more permissive of the two here. That is deliberate and it is
 * not the outputs going unchecked: the transaction's actual outputs live in the
 * global unsigned transaction, which is fully decoded and re-serialised above.
 * What an output map holds is signing metadata for whoever owns that output,
 * which this wallet never acts on and only has to hand back unaltered.
 */
function parseOutput(entries: PsbtKeyValue[]): PsbtOutput {
  return { other: entries };
}

/** Decode a PSBT from raw bytes or base64. Throws `WalletError('BAD_PSBT')`. */
export function parsePsbt(raw: Uint8Array | string): Psbt {
  const bytes = typeof raw === 'string' ? decodeBase64(raw) : raw;
  const r = new Reader(bytes);
  const magic = r.take(PSBT_MAGIC.length);
  for (let i = 0; i < PSBT_MAGIC.length; i++) {
    if (magic[i] !== PSBT_MAGIC[i]) throw psbtError('invalid PSBT magic bytes');
  }

  const globalEntries = readMap(r, 'global');
  let unsignedTxBytes: Uint8Array | undefined;
  const globals: PsbtKeyValue[] = [];
  for (const entry of globalEntries) {
    if (keyType(entry.key) === PSBT_GLOBAL_UNSIGNED_TX) {
      if (entry.key.length !== 1) throw psbtError('global unsigned tx key is more than one byte type');
      unsignedTxBytes = entry.value;
    } else {
      globals.push(entry);
    }
  }
  // Also how PSBTv2 is refused: it moves the transaction into per-field globals
  // and carries no 0x00 at all, so it lands here rather than being half-read.
  if (!unsignedTxBytes) throw psbtError('PSBT is missing its unsigned transaction');

  let tx;
  try {
    tx = parseTx(unsignedTxBytes);
  } catch (e) {
    throw psbtError(`unsigned transaction does not decode: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const input of tx.inputs) {
    if (input.witness && input.witness.length > 0) {
      throw psbtError('unsigned tx does not have empty scriptSigs and scriptWitnesses');
    }
  }
  // `tx` and `unsignedTxBytes` must stay two views of one thing, never two
  // sources of truth: a transaction we cannot re-serialise identically is one
  // whose sighash we would compute over bytes nobody else saw.
  const reserialized = serializeStripped(tx);
  if (bytesToHex(reserialized) !== bytesToHex(unsignedTxBytes)) {
    throw psbtError('unsigned transaction does not re-serialise to the bytes it was given in');
  }

  const inputs: PsbtInput[] = [];
  for (let i = 0; i < tx.inputs.length; i++) inputs.push(parseInput(readMap(r, `input ${i}`)));
  const outputs: PsbtOutput[] = [];
  for (let i = 0; i < tx.outputs.length; i++) outputs.push(parseOutput(readMap(r, `output ${i}`)));
  if (!r.done) throw psbtError('trailing bytes after the PSBT');

  const psbt: Psbt = { tx, unsignedTxBytes, globals, inputs, outputs };
  validateP2MRDilithiumPsbt(psbt);
  return psbt;
}

/**
 * Base64 without Node's Buffer — `src/core/` has to run in an MV3 service
 * worker. @scure/base is already a dependency and is strict about padding and
 * alphabet, which is what we want: a PSBT that is not exactly the base64
 * btq-core emitted should not decode into something that looks fine.
 */
export function decodeBase64(text: string): Uint8Array {
  try {
    return base64.decode(text.trim());
  } catch {
    throw psbtError('PSBT is not valid base64');
  }
}
