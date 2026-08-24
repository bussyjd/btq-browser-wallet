/**
 * Adding this wallet's Dilithium partial signatures to a PSBT.
 *
 * btq-core reference:
 *   src/script/sign.cpp:414-426   SignDilithiumAccumulatorLeaf — one attempt per key slot
 *   src/psbt_dilithium.cpp:126-222  the checks a signer owes itself
 *   src/psbt.h:83                 at most 20 partial signatures per input
 *
 * A PSBT arrives from somebody else, so every number in it is a claim. What
 * makes signing one safe is that nothing here trusts a claim it can re-derive:
 *
 *   - the leaf has to prove it commits to the witness program (`commitsToProgram`)
 *     before a key touches it, so a coordinator cannot get a cosigner to sign an
 *     unrelated script;
 *   - the sighash is recomputed from the transaction, never read out of the PSBT;
 *   - an input this wallet cannot make sense of is a refusal, not a skip — a
 *     foreign input is how a coordinator inflates the fee out of someone else's
 *     money;
 *   - a key that has already signed adds nothing, matching the idempotence of
 *     btq-core's own signature map.
 *
 * Callers hold the whole PSBT in memory, so this returns a new one rather than
 * mutating: a refused signing attempt must not leave a half-signed object
 * behind.
 */
import { PUBLIC_KEY_BYTES, SEED_BYTES, publicKeyFromSeed, signTransactionHash } from '../crypto/mldsa.js';
import { bytesToHex } from '../util/hex.js';
import { commitsToProgram } from '../script/p2mr.js';
import { p2mrSighash } from '../tx/sighash.js';
import { findPolicyKeyIndex } from './leaf.js';
import { compareDilithiumSigs, hash160 } from './order.js';
import { psbtError } from './parse.js';
import { inspectP2MRInput, isFinalized, p2mrProgram, spentOutputs, validateP2MRDilithiumPsbt } from './validate.js';
import { MAX_DILITHIUM_PARTIAL_SIGS_PER_INPUT, type DilithiumPartialSignature, type Psbt } from './types.js';

export interface SignPsbtResult {
  psbt: Psbt;
  /** How many signatures this call added. Zero is a legitimate answer. */
  added: number;
}

/**
 * Sign every input this wallet holds a key for.
 *
 * `seeds` are 32-byte ML-DSA seeds, the same shape `publicKeyFromSeed` takes.
 * Inputs already carrying a final witness are left alone; anything else that
 * this wallet cannot recognise as a Dilithium P2MR spend with a leaf that
 * commits to its own witness program is refused outright.
 */
export function signPsbt(psbt: Psbt, seeds: readonly Uint8Array[]): SignPsbtResult {
  for (const seed of seeds) {
    if (seed.length !== SEED_BYTES) throw psbtError(`an ML-DSA seed must be ${SEED_BYTES} bytes`);
  }
  const spent = spentOutputs(psbt);
  if (!spent) throw psbtError('cannot sign without the amount and script of every input');

  let added = 0;
  const inputs = psbt.inputs.map((input, index) => {
    if (isFinalized(input)) return input;

    const utxo = input.witnessUtxo!;
    const program = p2mrProgram(utxo.script);
    if (!program) throw psbtError(`input ${index} is not a P2MR spend this wallet can reason about`);

    const info = inspectP2MRInput(psbt, index);
    if (!info.policy || !info.leaf || !info.leafHash) {
      throw psbtError(`input ${index} does not name exactly one leaf script this wallet recognises`);
    }
    // Re-checked here rather than leaned on from parse time: this is the one
    // rule that stands between a cosigner and a signature over someone else's
    // script, so it is checked at the moment the key is about to be used.
    if (!info.leaf.controlBlocks.some((c) => commitsToProgram(info.leaf!.script, c, program))) {
      throw psbtError(`input ${index}: the leaf script does not commit to the witness program`);
    }

    const sighash = p2mrSighash(psbt.tx, index, spent, info.leafHash);
    const present = new Set(input.dilithiumSigs.map(
      (s) => `${bytesToHex(hash160(s.pubkey))}:${bytesToHex(s.leafHash)}`));
    const sigs: DilithiumPartialSignature[] = [...input.dilithiumSigs];

    for (const seed of seeds) {
      const pubkey = publicKeyFromSeed(seed);
      if (pubkey.length !== PUBLIC_KEY_BYTES) throw psbtError('unexpected ML-DSA public key size');
      if (findPolicyKeyIndex(info.policy, pubkey) < 0) continue;
      const id = `${bytesToHex(hash160(pubkey))}:${bytesToHex(info.leafHash)}`;
      if (present.has(id)) continue;
      if (sigs.length >= MAX_DILITHIUM_PARTIAL_SIGS_PER_INPUT) {
        throw psbtError(`input ${index} already carries ${MAX_DILITHIUM_PARTIAL_SIGS_PER_INPUT} partial signatures`);
      }
      present.add(id);
      sigs.push({ pubkey, leafHash: info.leafHash, signature: signTransactionHash(seed, sighash) });
      added++;
    }

    if (sigs.length === input.dilithiumSigs.length) return input;
    return { ...input, dilithiumSigs: sigs.sort(compareDilithiumSigs) };
  });

  const signed: Psbt = { ...psbt, inputs };
  // Verify what we just produced the same way we verify what arrives. A
  // signature that does not check out here is a bug in this wallet, and the
  // place to find that out is before it reaches a cosigner.
  validateP2MRDilithiumPsbt(signed);
  return { psbt: signed, added };
}
