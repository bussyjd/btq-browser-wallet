/**
 * Merging independently signed copies of one PSBT.
 *
 * btq-core reference:
 *   src/psbt.cpp:222-252   PSBTInput::Merge
 *   src/psbt.cpp:254-275   PSBTOutput::Merge
 *   src/psbt.cpp (PartiallySignedTransaction::Merge)  — the two must describe the same tx
 *
 * This is the operation parallel cosigning is built out of: two cosigners each
 * take the *same* unsigned PSBT, sign it in ignorance of the other, and their
 * results merge. Everything below follows from btq-core's container semantics,
 * which are worth stating because they are the behaviour, not an implementation
 * detail:
 *
 *   - signatures live in a `std::map` keyed by `(Hash160(pubkey), leaf_hash)`
 *     and are inserted with `insert`, which keeps the value already there. So
 *     re-signing with a key that has already signed adds nothing — the
 *     idempotence btq-core's own test asserts
 *     (wallet_dilithium_psbt_multisig.py:139-147);
 *   - a leaf's control blocks are a `std::set`, so merging two copies unions
 *     them rather than picking one;
 *   - single-valued fields (the merkle root, the witness UTXO, a final witness)
 *     fill in only when this side has none.
 */
import { bytesEqual } from '../util/bytes.js';
import { bytesToHex } from '../util/hex.js';
import { compareControlBlocks, compareDilithiumSigs, compareLeaves, hash160 } from './order.js';
import { psbtError } from './parse.js';
import { MAX_DILITHIUM_PARTIAL_SIGS_PER_INPUT, type DilithiumPartialSignature, type P2MRLeafScript, type Psbt, type PsbtInput, type PsbtKeyValue, type PsbtOutput } from './types.js';

/** The identity a Dilithium signature is keyed by on the wire and in the map. */
function sigId(sig: DilithiumPartialSignature): string {
  return `${bytesToHex(hash160(sig.pubkey))}:${bytesToHex(sig.leafHash)}`;
}

function leafId(leaf: P2MRLeafScript): string {
  return `${leaf.leafVersion}:${bytesToHex(leaf.script)}`;
}

/** `std::map::insert` semantics: the first value for a key is the one that stays. */
function unionByKey(into: PsbtKeyValue[], from: PsbtKeyValue[]): PsbtKeyValue[] {
  const seen = new Set(into.map((e) => bytesToHex(e.key)));
  const out = [...into];
  for (const entry of from) {
    const id = bytesToHex(entry.key);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(entry);
  }
  return out;
}

function mergeInput(a: PsbtInput, b: PsbtInput): PsbtInput {
  const leaves = new Map<string, P2MRLeafScript>();
  for (const leaf of a.p2mrLeaves) {
    leaves.set(leafId(leaf), { ...leaf, controlBlocks: [...leaf.controlBlocks] });
  }
  for (const leaf of b.p2mrLeaves) {
    const existing = leaves.get(leafId(leaf));
    if (!existing) {
      leaves.set(leafId(leaf), { ...leaf, controlBlocks: [...leaf.controlBlocks] });
      continue;
    }
    for (const control of leaf.controlBlocks) {
      if (!existing.controlBlocks.some((c) => bytesEqual(c, control))) existing.controlBlocks.push(control);
    }
  }
  for (const leaf of leaves.values()) leaf.controlBlocks.sort(compareControlBlocks);

  const sigs = new Map<string, DilithiumPartialSignature>();
  for (const sig of a.dilithiumSigs) sigs.set(sigId(sig), sig);
  for (const sig of b.dilithiumSigs) if (!sigs.has(sigId(sig))) sigs.set(sigId(sig), sig);
  // btq-core enforces the cap only while parsing, so its own `combinepsbt` can
  // hand back a PSBT its own `decodepsbt` refuses. Two copies of a single-leaf
  // spend cannot reach 21 — a leaf names at most 20 keys and a signature has to
  // come from one of them — so this only fires on a multi-leaf tree, where the
  // honest answer is to refuse rather than emit bytes nobody can decode.
  if (sigs.size > MAX_DILITHIUM_PARTIAL_SIGS_PER_INPUT) {
    throw psbtError(`combining would leave more than ${MAX_DILITHIUM_PARTIAL_SIGS_PER_INPUT} ` +
      'partial signatures on one input, which no decoder will accept');
  }

  return {
    witnessUtxo: a.witnessUtxo ?? b.witnessUtxo,
    sighashType: a.sighashType ?? b.sighashType,
    finalScriptSig: a.finalScriptSig ?? b.finalScriptSig,
    finalScriptWitness: a.finalScriptWitness ?? b.finalScriptWitness,
    p2mrLeaves: [...leaves.values()].sort(compareLeaves),
    p2mrMerkleRoot: a.p2mrMerkleRoot ?? b.p2mrMerkleRoot,
    dilithiumSigs: [...sigs.values()].sort(compareDilithiumSigs),
    other: unionByKey(a.other, b.other),
  };
}

function mergeOutput(a: PsbtOutput, b: PsbtOutput): PsbtOutput {
  return { other: unionByKey(a.other, b.other) };
}

/**
 * Merge PSBTs that describe the same unsigned transaction, left to right.
 *
 * The transactions must be identical, not merely compatible: btq-core compares
 * the two `CTransaction`s and refuses otherwise, and it has to — merging
 * signatures across two different transactions would mean holding a signature
 * that commits to bytes nobody is going to broadcast.
 */
export function combinePsbts(psbts: readonly Psbt[]): Psbt {
  if (psbts.length === 0) throw psbtError('nothing to combine');
  const first = psbts[0]!;
  let merged: Psbt = first;
  for (const next of psbts.slice(1)) {
    if (!bytesEqual(merged.unsignedTxBytes, next.unsignedTxBytes)) {
      throw psbtError('cannot combine PSBTs that describe different transactions');
    }
    merged = {
      tx: merged.tx,
      unsignedTxBytes: merged.unsignedTxBytes,
      globals: unionByKey(merged.globals, next.globals),
      inputs: merged.inputs.map((input, i) => mergeInput(input, next.inputs[i]!)),
      outputs: merged.outputs.map((output, i) => mergeOutput(output, next.outputs[i]!)),
    };
  }
  return merged;
}
