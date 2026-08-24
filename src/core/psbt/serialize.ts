/**
 * PSBT encoding, in btq-core's field order.
 *
 * btq-core reference:
 *   src/psbt.h:246-403   PSBTInput::Serialize — the order the groups come out in
 *   src/psbt.h:359-382   the three P2MR groups
 *   src/psbt.h:252       the whole unfinalized block is skipped once a witness exists
 *   src/psbt.h:837-895   PSBTOutput::Serialize (proprietary sits *before* the taproot fields)
 *   src/psbt.h:1088-1130 PartiallySignedTransaction::Serialize
 *
 * A PSBT is a set of maps, so "the same fields" is not "the same bytes": an
 * encoder only reproduces `combinepsbt` if it emits the groups in btq-core's
 * order and sorts within each group the way btq-core's `std::map` does. The
 * tables below are that order, transcribed; `order.ts` holds the comparators.
 */
import { base64 } from '@scure/base';
import { compactSize, concatBytes } from '../util/bytes.js';
import { u32le, u64le, withLength } from '../tx/serialize.js';
import { keyType, psbtError } from './parse.js';
import { lexicographic } from './order.js';
import {
  PSBT_GLOBAL_PROPRIETARY,
  PSBT_GLOBAL_UNSIGNED_TX,
  PSBT_GLOBAL_VERSION,
  PSBT_GLOBAL_XPUB,
  PSBT_IN_P2MR_DILITHIUM_SCRIPT_SIG,
  PSBT_IN_P2MR_LEAF_SCRIPT,
  PSBT_IN_P2MR_MERKLE_ROOT,
  PSBT_IN_PARTIAL_SIG,
  PSBT_IN_SCRIPTSIG,
  PSBT_IN_SCRIPTWITNESS,
  PSBT_IN_SIGHASH,
  PSBT_IN_TAP_LEAF_SCRIPT,
  PSBT_IN_WITNESS_UTXO,
  PSBT_MAGIC,
  PSBT_SEPARATOR,
  type Psbt,
  type PsbtInput,
  type PsbtKeyValue,
  type PsbtOutput,
} from './types.js';

/** Group order inside an input map, transcribed from PSBTInput::Serialize. */
const INPUT_ORDER = new Map<number, number>([
  [0x00, 0], [0x01, 1],
  // The unfinalized block.
  [0x02, 2], [0x03, 3], [0x04, 4], [0x05, 5], [0x06, 6],
  [0x0a, 7], [0x0b, 8], [0x0c, 9], [0x0d, 10],
  [0x13, 11], [0x14, 12], [0x15, 13], [0x16, 14], [0x17, 15], [0x18, 16],
  [0x19, 17], [0x1a, 18], [0x1b, 19],
  // Written whether or not the input is finalized.
  [0x07, 20], [0x08, 21], [0xfc, 22],
]);
const INPUT_UNKNOWN_ORDER = 23;

/**
 * The types btq-core stops writing once `final_script_sig` or
 * `final_script_witness` is set (src/psbt.h:252). Genuinely unknown types are
 * not in this set: they live in `unknown` and are always written.
 */
const SKIPPED_WHEN_FINALIZED = new Set<number>([
  0x02, 0x03, 0x04, 0x05, 0x06, 0x0a, 0x0b, 0x0c, 0x0d,
  0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b,
]);

const GLOBAL_ORDER = new Map<number, number>([
  [PSBT_GLOBAL_UNSIGNED_TX, 0], [PSBT_GLOBAL_XPUB, 1],
  [PSBT_GLOBAL_VERSION, 2], [PSBT_GLOBAL_PROPRIETARY, 3],
]);
const GLOBAL_UNKNOWN_ORDER = 4;

const OUTPUT_ORDER = new Map<number, number>([
  [0x00, 0], [0x01, 1], [0x02, 2],
  // Proprietary really does come before the taproot fields here.
  [0xfc, 3], [0x05, 4], [0x06, 5], [0x07, 6],
]);
const OUTPUT_UNKNOWN_ORDER = 7;

interface RankedEntry extends PsbtKeyValue {
  rank: number;
}

function encodeEntry(entry: PsbtKeyValue): Uint8Array {
  return concatBytes(withLength(entry.key), withLength(entry.value));
}

/** Sort by group, then by key bytes, then emit with the map's separator. */
function encodeMap(entries: RankedEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) =>
    a.rank !== b.rank ? a.rank - b.rank : lexicographic(a.key, b.key));
  return concatBytes(...sorted.map(encodeEntry), new Uint8Array([PSBT_SEPARATOR]));
}

function rankOf(orders: Map<number, number>, fallback: number, key: Uint8Array): number {
  return orders.get(keyType(key)) ?? fallback;
}

/**
 * Two field types whose serialization order btq-core derives from something
 * other than the wire key: `PSBT_IN_PARTIAL_SIG` is keyed by
 * `Hash160(pubkey)`, and `PSBT_IN_TAP_LEAF_SCRIPT` is grouped by leaf script
 * while its wire key holds the control block. We model neither — a Dilithium
 * P2MR input has no ECDSA partial signatures and no taproot leaves — so rather
 * than emit a plausible-looking order that btq-core would not have written, we
 * refuse. One entry of either type is unambiguous and passes.
 */
function checkUnorderableGroups(other: PsbtKeyValue[]): void {
  for (const type of [PSBT_IN_PARTIAL_SIG, PSBT_IN_TAP_LEAF_SCRIPT]) {
    if (other.filter((e) => keyType(e.key) === type).length > 1) {
      throw psbtError(
        `cannot re-serialise an input holding several 0x${type.toString(16).padStart(2, '0')} ` +
        'fields: btq-core orders them by something other than their wire key');
    }
  }
}

function encodeInput(input: PsbtInput): Uint8Array {
  checkUnorderableGroups(input.other);
  const finalized = (input.finalScriptSig?.length ?? 0) > 0 || (input.finalScriptWitness?.length ?? 0) > 0;
  const entries: RankedEntry[] = [];
  const add = (type: number, key: Uint8Array, value: Uint8Array) => {
    if (finalized && SKIPPED_WHEN_FINALIZED.has(type)) return;
    entries.push({ rank: INPUT_ORDER.get(type) ?? INPUT_UNKNOWN_ORDER, key, value });
  };

  if (input.witnessUtxo) {
    add(PSBT_IN_WITNESS_UTXO, new Uint8Array([PSBT_IN_WITNESS_UTXO]),
      concatBytes(u64le(input.witnessUtxo.value), withLength(input.witnessUtxo.script)));
  }
  if (input.sighashType !== undefined) {
    add(PSBT_IN_SIGHASH, new Uint8Array([PSBT_IN_SIGHASH]), u32le(input.sighashType));
  }
  for (const leaf of input.p2mrLeaves) {
    for (const control of leaf.controlBlocks) {
      add(PSBT_IN_P2MR_LEAF_SCRIPT,
        concatBytes(new Uint8Array([PSBT_IN_P2MR_LEAF_SCRIPT]), control),
        concatBytes(leaf.script, new Uint8Array([leaf.leafVersion])));
    }
  }
  if (input.p2mrMerkleRoot) {
    add(PSBT_IN_P2MR_MERKLE_ROOT, new Uint8Array([PSBT_IN_P2MR_MERKLE_ROOT]), input.p2mrMerkleRoot);
  }
  for (const sig of input.dilithiumSigs) {
    add(PSBT_IN_P2MR_DILITHIUM_SCRIPT_SIG,
      concatBytes(new Uint8Array([PSBT_IN_P2MR_DILITHIUM_SCRIPT_SIG]), sig.pubkey, sig.leafHash),
      sig.signature);
  }
  if (input.finalScriptSig && input.finalScriptSig.length > 0) {
    add(PSBT_IN_SCRIPTSIG, new Uint8Array([PSBT_IN_SCRIPTSIG]), input.finalScriptSig);
  }
  if (input.finalScriptWitness && input.finalScriptWitness.length > 0) {
    add(PSBT_IN_SCRIPTWITNESS, new Uint8Array([PSBT_IN_SCRIPTWITNESS]),
      concatBytes(compactSize(input.finalScriptWitness.length),
        ...input.finalScriptWitness.map(withLength)));
  }
  for (const entry of input.other) add(keyType(entry.key), entry.key, entry.value);

  return encodeMapPreservingGroups(entries, PRESERVED_INPUT_RANKS);
}

/**
 * The two input groups btq-core does *not* order by their wire key, and whose
 * order therefore has to be carried in from the parsed structure:
 *
 *   0x19  keyed by `(leaf_script, leaf_version)`, with the control blocks of one
 *         leaf shortest-first — but the wire key *starts* with the control block;
 *   0x1B  keyed by `(Hash160(pubkey), leaf_hash)` — but the wire key carries the
 *         1312-byte public key itself, and sorting by that gives a different
 *         order (order.ts explains why the two disagree).
 *
 * `input.p2mrLeaves` and `input.dilithiumSigs` are already in btq-core's order,
 * so the fix is to stop the generic key sort from undoing it.
 */
const PRESERVED_INPUT_RANKS = new Set<number>([
  INPUT_ORDER.get(PSBT_IN_P2MR_LEAF_SCRIPT)!,
  INPUT_ORDER.get(PSBT_IN_P2MR_DILITHIUM_SCRIPT_SIG)!,
]);

/** `encodeMap`, except that the named groups keep the order they were appended in. */
function encodeMapPreservingGroups(entries: RankedEntry[], preserved: ReadonlySet<number>): Uint8Array {
  const withIndex = entries.map((e, i) => ({ e, i }));
  withIndex.sort((a, b) => {
    if (a.e.rank !== b.e.rank) return a.e.rank - b.e.rank;
    if (preserved.has(a.e.rank)) return a.i - b.i;
    return lexicographic(a.e.key, b.e.key);
  });
  return concatBytes(...withIndex.map(({ e }) => encodeEntry(e)), new Uint8Array([PSBT_SEPARATOR]));
}

function encodeOutput(output: PsbtOutput): Uint8Array {
  return encodeMap(output.other.map((e) => ({
    ...e,
    rank: rankOf(OUTPUT_ORDER, OUTPUT_UNKNOWN_ORDER, e.key),
  })));
}

/** Encode a PSBT to its wire bytes. */
export function serializePsbt(psbt: Psbt): Uint8Array {
  const globals: RankedEntry[] = [
    { rank: 0, key: new Uint8Array([PSBT_GLOBAL_UNSIGNED_TX]), value: psbt.unsignedTxBytes },
    ...psbt.globals.map((e) => ({ ...e, rank: rankOf(GLOBAL_ORDER, GLOBAL_UNKNOWN_ORDER, e.key) })),
  ];
  return concatBytes(
    PSBT_MAGIC,
    encodeMap(globals),
    ...psbt.inputs.map(encodeInput),
    ...psbt.outputs.map(encodeOutput),
  );
}

/** Encode a PSBT to the base64 form btq-core's RPCs speak. */
export function serializePsbtBase64(psbt: Psbt): string {
  return base64.encode(serializePsbt(psbt));
}
