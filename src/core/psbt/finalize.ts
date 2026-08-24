/**
 * Turning collected signatures into a witness.
 *
 * btq-core reference:
 *   src/script/dilithium_leaf.cpp:164-176  BuildDilithiumLeafWitness (the slot order)
 *   src/script/sign.cpp:518-547            SignP2MR — stack, then leaf script, then control block
 *   src/psbt.cpp:161-177                   FromSignatureData clears the P2MR fields once complete
 *   src/psbt.cpp:322-325                   PSBTInputSigned
 *   test/functional/feature_p2mr_dilithium_multisig.py:134-143  spend_threshold
 *
 * The witness of a threshold leaf is
 *
 *     slot[n-1] … slot[1] slot[0]   leaf_script   control_block
 *
 * one slot per key with the non-signers' slots *empty*, and — the part that is
 * easy to get backwards — pushed in reverse key order, because the leaf checks
 * key 0 first and a script's first operand is the top of the stack. A reversed
 * witness serialises fine, has the right length, and fails only at validation.
 */
import { bytesToHex } from '../util/hex.js';
import { serializeWithWitness, type Tx } from '../tx/serialize.js';
import { buildLeafWitnessStack, findPolicyKeyIndex } from './leaf.js';
import { psbtError } from './parse.js';
import { inspectP2MRInput, isFinalized } from './validate.js';
import type { Psbt, PsbtInput } from './types.js';

export interface FinalizeResult {
  psbt: Psbt;
  /** True when every input carries a final witness. */
  complete: boolean;
  /** The broadcastable transaction, present only when `complete`. */
  hex?: string;
}

/**
 * Assemble the witness for one input, or return it unchanged when it is not
 * finalizable. Below the threshold this is a no-op, deliberately: a witness
 * built from too few signatures is a transaction that will be rejected, and
 * handing one back would turn a coordination problem into a broadcast failure.
 */
function finalizeInput(psbt: Psbt, index: number): PsbtInput {
  const input = psbt.inputs[index]!;
  if (isFinalized(input)) return input;

  const info = inspectP2MRInput(psbt, index);
  if (info.status !== 'finalizable' || !info.policy || !info.leaf || !info.leafHash) return input;

  const slots: (Uint8Array | null)[] = info.policy.pubkeys.map(() => null);
  for (const sig of input.dilithiumSigs) {
    if (bytesToHex(sig.leafHash) !== bytesToHex(info.leafHash)) continue;
    const at = findPolicyKeyIndex(info.policy, sig.pubkey);
    // The first signature for a slot is the one that counts, matching the
    // std::map insert semantics a combine already applied.
    if (at >= 0 && slots[at] === null) slots[at] = sig.signature;
  }

  const stack = buildLeafWitnessStack(info.policy, slots);
  if (!stack) return input;

  return {
    witnessUtxo: input.witnessUtxo,
    sighashType: input.sighashType,
    finalScriptSig: input.finalScriptSig,
    finalScriptWitness: [...stack, info.leaf.script, info.leaf.controlBlocks[0]!],
    // The finalized witness supersedes the spend path and its partial
    // signatures, which together dwarf the rest of the input (psbt.cpp:167-172).
    p2mrLeaves: [],
    p2mrMerkleRoot: undefined,
    dilithiumSigs: [],
    other: input.other,
  };
}

/** Finalize every input that has reached its threshold. */
export function finalizePsbt(psbt: Psbt): FinalizeResult {
  const inputs = psbt.inputs.map((_, i) => finalizeInput(psbt, i));
  const finalized: Psbt = { ...psbt, inputs };
  const complete = inputs.every(isFinalized);
  if (!complete) return { psbt: finalized, complete };
  return { psbt: finalized, complete, hex: bytesToHex(serializeWithWitness(extractTransaction(finalized))) };
}

/**
 * The broadcastable transaction. Refuses unless every input is finalized —
 * btq-core's `finalizepsbt` returns no `hex` at all in that case, and half a
 * witness set is not a transaction.
 */
export function extractTransaction(psbt: Psbt): Tx {
  const inputs = psbt.inputs.map((input, i) => {
    if (!isFinalized(input)) throw psbtError(`input ${i} has no final witness`);
    if (input.finalScriptSig && input.finalScriptSig.length > 0) {
      throw psbtError(`input ${i} carries a scriptSig, which a P2MR spend never has`);
    }
    return { ...psbt.tx.inputs[i]!, witness: input.finalScriptWitness ?? [] };
  });
  return { ...psbt.tx, inputs };
}
