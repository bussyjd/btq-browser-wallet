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

export interface SignPsbtOptions {
  /**
   * Sign an input that already holds enough signatures to finalize. Off by
   * default, and the default is the interesting half.
   *
   * The accumulator succeeds on `sum >= m`, not `sum == m`, so a surplus
   * signature is perfectly valid — and btq-core's finalizer emits every
   * signature it holds rather than selecting m (`BuildDilithiumLeafWitness`,
   * src/script/dilithium_leaf.cpp:163-173; measured through `finalizepsbt` in
   * tests/vectors/psbt.json under `overSigned`). So a third signature on a
   * 2-of-3 is not discarded later: it rides onto the chain, costing 2424 bytes
   * of witness and moving a measured spend from 665 vsize to 816.
   *
   * Two things follow. The fee was quoted before that signature existed, so a
   * quote made at the relay floor for the smaller size no longer clears it —
   * and the surplus permanently publishes the ML-DSA signature of a cosigner
   * who was not needed, which on a chain where every spend already reveals
   * 1312-byte keys is gratuitous linkage.
   *
   * The finalizer is the wrong place to fix this: dropping a signature there
   * would make our transaction differ from the one btq-core builds out of the
   * same PSBT, so the two would disagree on the txid. The right place is here,
   * where the signature has not been created yet and a cosigner can see from
   * the PSBT that it is not needed. Set this when you deliberately want the
   * redundancy — a cosigner who suspects another's signature will be dropped.
   */
  signWhenAlreadyFinalizable?: boolean;
}

/**
 * Sign every input this wallet holds a key for.
 *
 * `seeds` are 32-byte ML-DSA seeds, the same shape `publicKeyFromSeed` takes.
 * Inputs already carrying a final witness are left alone; anything else that
 * this wallet cannot recognise as a Dilithium P2MR spend with a leaf that
 * commits to its own witness program is refused outright.
 */
export function signPsbt(
  psbt: Psbt,
  seeds: readonly Uint8Array[],
  options: SignPsbtOptions = {},
): SignPsbtResult {
  for (const seed of seeds) {
    if (seed.length !== SEED_BYTES) throw psbtError(`an ML-DSA seed must be ${SEED_BYTES} bytes`);
  }
  const spent = spentOutputs(psbt);
  if (!spent) throw psbtError('cannot sign without the amount and script of every input');
  // Run the full decode-time validation again rather than a lighter re-check of
  // our own. `parsePsbt` already did this for a PSBT that arrived over the wire,
  // but a caller can hand us a `Psbt` assembled some other way — out of
  // `combinePsbts`, or built field by field — and the rule that no key is
  // applied to a leaf which has not proved it commits to its own witness
  // program has to hold at the moment the key is used, not only at the moment
  // the bytes were read. It also re-verifies the signatures already present, so
  // we never add ours to a set we have not checked.
  validateP2MRDilithiumPsbt(psbt);

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
    // Adding to an input that can already be finalized only makes the spend
    // bigger and reveals a key nobody needed — see SignPsbtOptions.
    if (info.status === 'finalizable' && !options.signWhenAlreadyFinalizable) return input;
    let towardThreshold = info.signaturesPresent;

    const sighash = p2mrSighash(psbt.tx, index, spent, info.leafHash);
    const present = new Set(input.dilithiumSigs.map(
      (s) => `${bytesToHex(hash160(s.pubkey))}:${bytesToHex(s.leafHash)}`));
    const sigs: DilithiumPartialSignature[] = [...input.dilithiumSigs];

    for (const seed of seeds) {
      const pubkey = publicKeyFromSeed(seed);
      if (pubkey.length !== PUBLIC_KEY_BYTES) throw psbtError('unexpected ML-DSA public key size');
      if (findPolicyKeyIndex(info.policy, pubkey) < 0) continue;
      // The same rule one level down: a wallet holding more than m of the keys
      // signs m of them and stops, rather than spending 2424 witness bytes per
      // surplus signature on a threshold that is already met.
      if (towardThreshold >= info.policy.m && !options.signWhenAlreadyFinalizable) break;
      const id = `${bytesToHex(hash160(pubkey))}:${bytesToHex(info.leafHash)}`;
      if (present.has(id)) continue;
      if (sigs.length >= MAX_DILITHIUM_PARTIAL_SIGS_PER_INPUT) {
        throw psbtError(`input ${index} already carries ${MAX_DILITHIUM_PARTIAL_SIGS_PER_INPUT} partial signatures`);
      }
      present.add(id);
      sigs.push({ pubkey, leafHash: info.leafHash, signature: signTransactionHash(seed, sighash) });
      towardThreshold++;
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
