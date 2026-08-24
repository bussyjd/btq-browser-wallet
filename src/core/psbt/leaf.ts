/**
 * Classifying a Dilithium P2MR leaf, and turning signatures into its witness.
 *
 * btq-core reference:
 *   src/script/dilithium_leaf.h:24-31     P2MRLeafTemplate
 *   src/script/dilithium_leaf.cpp:113     ParseP2MRDilithiumLeaf
 *   src/script/dilithium_leaf.cpp:129-134 FindPolicyKeyIndex
 *   src/script/dilithium_leaf.cpp:136-193 BuildDilithiumLeafWitness
 *   src/script/sign.cpp:414-426           SignDilithiumAccumulatorLeaf
 *
 * The threshold-accumulator half is Unit 1's `parseThresholdLeaf`; this module
 * imports it and never re-implements it. What it adds is the single-key leaf
 * (`<pubkey> OP_CHECKSIGDILITHIUM`), so one policy type covers both shapes a
 * PSBT can carry, and the witness assembly the two share.
 */
import { PUBLIC_KEY_BYTES } from '../crypto/mldsa.js';
import { bytesEqual } from '../util/bytes.js';
import {
  LEAF_SCRIPT_BYTES,
  OP_CHECKSIGDILITHIUM,
  OP_PUSHDATA2,
  singleKeyLeafScript,
} from '../script/p2mr.js';
import { isFullyValidPublicKey, parseThresholdLeaf } from '../script/multisig.js';

export type LeafTemplate = 'dilithium_single' | 'dilithium_threshold';

/** The spending policy a leaf expresses. Mirrors P2MRDilithiumLeafPolicy. */
export interface LeafPolicy {
  type: LeafTemplate;
  /** Signatures required. 1 for a single-key leaf. */
  m: number;
  /** Public keys in script order; index 0 is evaluated first. */
  pubkeys: Uint8Array[];
}

/**
 * The single-key leaf, recognised by rebuilding it. Comparing against
 * `singleKeyLeafScript()` rather than re-parsing means the recogniser and the
 * builder cannot disagree about the push encoding, and it rejects the
 * non-minimal pushes of the same key that a hand-rolled reader would wave
 * through.
 */
function parseSingleKeyLeaf(script: Uint8Array): LeafPolicy | null {
  if (script.length !== LEAF_SCRIPT_BYTES) return null;
  if (script[0] !== OP_PUSHDATA2) return null;
  if (script[script.length - 1] !== OP_CHECKSIGDILITHIUM) return null;
  const pubkey = script.slice(3, 3 + PUBLIC_KEY_BYTES);
  if (!bytesEqual(singleKeyLeafScript(pubkey), script)) return null;
  if (!isFullyValidPublicKey(pubkey)) return null;
  return { type: 'dilithium_single', m: 1, pubkeys: [pubkey] };
}

/**
 * Classify a leaf script, or null when nothing matches.
 *
 * btq-core also recognises `<m> <pubkeys…> <n> OP_CHECKMULTISIGDILITHIUM`.
 * This wallet deliberately does not: that form constrains signature ordering
 * and so cannot be signed by independent wallets in any order
 * (src/script/dilithium_leaf.h:47-52), it is not a shape this wallet ever
 * builds, and treating it as unrecognised means we refuse to finalize it rather
 * than assemble a witness for a policy we never tested. Refusing an exotic leaf
 * costs a user nothing; mis-assembling one costs them the input.
 */
export function parseLeafPolicy(script: Uint8Array): LeafPolicy | null {
  const single = parseSingleKeyLeaf(script);
  if (single) return single;
  const threshold = parseThresholdLeaf(script);
  if (threshold) {
    return { type: 'dilithium_threshold', m: threshold.m, pubkeys: threshold.pubkeys };
  }
  return null;
}

/** Index of `pubkey` in the policy's key list, or -1. Port of FindPolicyKeyIndex. */
export function findPolicyKeyIndex(policy: LeafPolicy, pubkey: Uint8Array): number {
  return policy.pubkeys.findIndex((k) => bytesEqual(k, pubkey));
}

/**
 * The execution half of the witness stack: one slot per key, non-signers
 * contributing an empty item, pushed in *reverse* key order.
 *
 * Port of BuildDilithiumLeafWitness's THRESHOLD_ACCUMULATOR branch
 * (src/script/dilithium_leaf.cpp:167-171). The direction is the whole subtlety:
 * the leaf runs its per-key checks starting at key 0, and a script's first
 * operand is the *top* of the stack, so slot 0 must be pushed last. Get it
 * backwards and every witness still serialises, still has the right length, and
 * fails only at validation — which is why tests/unit/psbt.test.ts asserts the
 * slot order directly as well as through btq-core's frozen witness bytes.
 *
 * An empty slot is safe because OP_CHECKSIGDILITHIUM scores it 0 without
 * aborting: NULLFAIL is raised only for a non-empty signature that failed
 * (src/script/interpreter.cpp:1297). So any m-sized subset produces a valid
 * witness and the signers never have to meet.
 *
 * Returns null below the threshold rather than a short stack — refusing to
 * finalize is the correct answer there, not a witness that will be rejected.
 */
export function buildLeafWitnessStack(
  policy: LeafPolicy,
  sigsByKeyIndex: (Uint8Array | null)[],
): Uint8Array[] | null {
  if (sigsByKeyIndex.length !== policy.pubkeys.length) return null;
  const signed = sigsByKeyIndex.filter((s) => s !== null && s.length > 0).length;
  if (signed < policy.m) return null;

  if (policy.type === 'dilithium_single') {
    const sig = sigsByKeyIndex[0];
    if (!sig || sig.length === 0) return null;
    return [sig];
  }

  const stack: Uint8Array[] = [];
  for (let k = sigsByKeyIndex.length; k-- > 0; ) {
    stack.push(sigsByKeyIndex[k] ?? new Uint8Array(0));
  }
  return stack;
}
