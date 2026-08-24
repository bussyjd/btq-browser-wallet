/**
 * Fail-closed validation of a PSBT's Dilithium/P2MR fields.
 *
 * Port of btq-core's psbt_dilithium.cpp:
 *   ValidateP2MRDilithiumInput  src/psbt_dilithium.cpp:126-222
 *   ValidateP2MRDilithiumPSBT   src/psbt_dilithium.cpp:224-245
 *   InspectP2MRInput            src/psbt_dilithium.cpp:66-124
 *
 * `parsePsbt` runs this before it returns, so a forged signature is a decode
 * failure rather than a finalize failure — the behaviour btq-core's own
 * `decodepsbt` has and most PSBT libraries do not
 * (test/functional/wallet_dilithium_psbt_multisig.py:164-165). The rule the
 * whole module follows: never trust a value the PSBT supplies when we can
 * recompute it. The sighash is recomputed from the transaction, every leaf has
 * to prove it commits to the witness program, and every signature is verified
 * against the key that the leaf — not the PSBT — authorises.
 *
 * One deliberate narrowing from btq-core: an input must carry its
 * `PSBT_IN_WITNESS_UTXO` (0x01). btq-core would also accept the full previous
 * transaction under `PSBT_IN_NON_WITNESS_UTXO` (0x00) and pull the output out
 * of it. P2MR is a witness output type and every producer we have seen — btq-core's
 * own `walletcreatefundedpsbt` included — supplies 0x01, so rather than carry a
 * second transaction decoder we refuse. That is a compatibility limit, not a
 * hole: the failure is a refusal to decode, never a signature we skipped.
 */
import { SIGHASH_ALL, verifyTransactionHash } from '../crypto/mldsa.js';
import { bytesEqual } from '../util/bytes.js';
import { bytesToHex } from '../util/hex.js';
import { commitsToProgram, tapLeafHash, OP_2 } from '../script/p2mr.js';
import { p2mrSighash, type SpentOutput } from '../tx/sighash.js';
import { WalletError } from '../wallet/errors.js';
import { findPolicyKeyIndex, parseLeafPolicy, type LeafPolicy } from './leaf.js';
import {
  DILITHIUM_PARTIAL_SIG_SIZE,
  P2MR_CONTROL_BASE_SIZE,
  P2MR_CONTROL_MAX_SIZE,
  P2MR_CONTROL_NODE_SIZE,
  TAPROOT_LEAF_MASK,
  WITNESS_V2_P2MR_SIZE,
  type P2MRLeafScript,
  type Psbt,
  type PsbtInput,
} from './types.js';

export type P2MRInputStatus =
  | 'not_p2mr'
  | 'finalized'
  | 'unknown_leaf'
  | 'unsigned'
  | 'partially_signed'
  | 'finalizable';

export interface P2MRInputInfo {
  status: P2MRInputStatus;
  leaf: P2MRLeafScript | null;
  leafHash: Uint8Array | null;
  policy: LeafPolicy | null;
  /** Signatures present from keys the leaf authorises. */
  signaturesPresent: number;
  /** Signatures the leaf requires. */
  signaturesRequired: number;
}

/** `OP_2 <32-byte program>` → the program, or null for any other script. */
export function p2mrProgram(script: Uint8Array): Uint8Array | null {
  if (script.length !== 2 + WITNESS_V2_P2MR_SIZE) return null;
  if (script[0] !== OP_2 || script[1] !== WITNESS_V2_P2MR_SIZE) return null;
  return script.subarray(2);
}

export function hasP2MRFields(input: PsbtInput): boolean {
  return input.p2mrLeaves.length > 0 || input.dilithiumSigs.length > 0 || input.p2mrMerkleRoot !== undefined;
}

export function isFinalized(input: PsbtInput): boolean {
  return (input.finalScriptSig?.length ?? 0) > 0 || (input.finalScriptWitness?.length ?? 0) > 0;
}

/**
 * Every spent output, in input order, or null if any is missing. BIP341 commits
 * to all of them, so one unknown amount makes every sighash in the transaction
 * uncomputable — btq-core expresses the same thing as a null `txdata`.
 */
export function spentOutputs(psbt: Psbt): SpentOutput[] | null {
  const spent: SpentOutput[] = [];
  for (const input of psbt.inputs) {
    if (!input.witnessUtxo) return null;
    spent.push({ value: input.witnessUtxo.value, script: input.witnessUtxo.script });
  }
  return spent;
}

/**
 * Which leaf is this input spending, and how far along is it? A structural
 * read: it picks the leaf and counts signatures but verifies none of them —
 * `validateP2MRDilithiumInput` is what verifies.
 */
export function inspectP2MRInput(psbt: Psbt, index: number): P2MRInputInfo {
  const input = psbt.inputs[index]!;
  const info: P2MRInputInfo = {
    status: 'not_p2mr', leaf: null, leafHash: null, policy: null,
    signaturesPresent: 0, signaturesRequired: 0,
  };
  const utxo = input.witnessUtxo;
  const program = utxo ? p2mrProgram(utxo.script) : null;
  if (!program && !hasP2MRFields(input)) return info;

  if (isFinalized(input)) {
    info.status = 'finalized';
    return info;
  }

  // Partial signatures pin which leaf is being spent; with none, a single
  // advertised leaf is unambiguous and anything else is not.
  const sigLeafHashes = new Set(input.dilithiumSigs.map((s) => bytesToHex(s.leafHash)));
  info.status = 'unknown_leaf';
  if (sigLeafHashes.size > 1) return info;

  const candidates: { leaf: P2MRLeafScript; leafHash: Uint8Array }[] = [];
  for (const leaf of input.p2mrLeaves) {
    if (leaf.controlBlocks.length === 0) continue;
    const leafHash = tapLeafHash(leaf.script, leaf.leafVersion);
    if (sigLeafHashes.size > 0 && !sigLeafHashes.has(bytesToHex(leafHash))) continue;
    candidates.push({ leaf, leafHash });
  }
  if (candidates.length !== 1) return info;

  const { leaf, leafHash } = candidates[0]!;
  const policy = parseLeafPolicy(leaf.script);
  if (!policy) return info;

  info.leaf = leaf;
  info.leafHash = leafHash;
  info.policy = policy;
  info.signaturesRequired = policy.m;
  for (const sig of input.dilithiumSigs) {
    if (!bytesEqual(sig.leafHash, leafHash)) continue;
    if (findPolicyKeyIndex(policy, sig.pubkey) < 0) continue;
    info.signaturesPresent++;
  }
  info.status = info.signaturesPresent === 0
    ? 'unsigned'
    : info.signaturesPresent >= info.signaturesRequired ? 'finalizable' : 'partially_signed';
  return info;
}

function fail(index: number, reason: string): never {
  throw new WalletError('BAD_PSBT', `input ${index}: ${reason}`);
}

/** Validate one input's Dilithium/P2MR fields. Throws on the first problem. */
export function validateP2MRDilithiumInput(psbt: Psbt, index: number, spent: SpentOutput[] | null): void {
  const input = psbt.inputs[index]!;
  if (!hasP2MRFields(input)) return;

  const utxo = input.witnessUtxo;
  if (!utxo) fail(index, 'has Dilithium P2MR fields but no witness UTXO to check them against');
  const program = p2mrProgram(utxo.script);
  if (!program) fail(index, 'has Dilithium P2MR fields but does not spend a P2MR output');
  if (input.p2mrMerkleRoot && !bytesEqual(input.p2mrMerkleRoot, program)) {
    fail(index, 'P2MR merkle root does not match the witness program');
  }
  // Consensus rejects SIGHASH_DEFAULT for P2MR tapscript, so SIGHASH_ALL is the
  // only type a Dilithium leaf signature can usefully commit to.
  if (input.sighashType !== undefined && input.sighashType !== SIGHASH_ALL) {
    fail(index, 'Dilithium P2MR inputs only support SIGHASH_ALL');
  }

  // Every advertised leaf must genuinely commit to the witness program,
  // otherwise a signer can be tricked into signing an unrelated script.
  const leaves = new Map<string, Uint8Array>();
  for (const leaf of input.p2mrLeaves) {
    // A leaf with no control block proves nothing, because the commitment check
    // runs per control block and would not run at all.
    if (leaf.controlBlocks.length === 0) fail(index, 'P2MR leaf script has no control block');
    const leafHash = tapLeafHash(leaf.script, leaf.leafVersion);
    for (const control of leaf.controlBlocks) {
      if (control.length < P2MR_CONTROL_BASE_SIZE || control.length > P2MR_CONTROL_MAX_SIZE ||
          (control.length - P2MR_CONTROL_BASE_SIZE) % P2MR_CONTROL_NODE_SIZE !== 0) {
        fail(index, 'P2MR control block has an invalid size');
      }
      if ((control[0]! & 1) !== 1) fail(index, 'P2MR control block does not have the parity bit set');
      if ((control[0]! & TAPROOT_LEAF_MASK) !== leaf.leafVersion) {
        fail(index, 'P2MR control block leaf version does not match the leaf script');
      }
      if (!commitsToProgram(leaf.script, control, program)) {
        fail(index, 'P2MR leaf script does not commit to the witness program');
      }
    }
    const id = bytesToHex(leafHash);
    if (leaves.has(id)) fail(index, 'two P2MR leaf scripts collide on the same leaf hash');
    leaves.set(id, leaf.script);
  }

  const sigLeafHashes = new Set<string>();
  for (const sig of input.dilithiumSigs) {
    const id = bytesToHex(sig.leafHash);
    const leafScript = leaves.get(id);
    if (!leafScript) fail(index, 'Dilithium partial signature refers to a leaf the PSBT does not contain');
    sigLeafHashes.add(id);
    if (sigLeafHashes.size > 1) fail(index, 'Dilithium partial signatures refer to more than one leaf');

    const policy = parseLeafPolicy(leafScript);
    if (!policy) fail(index, 'Dilithium partial signature is attached to an unrecognised leaf script');
    if (findPolicyKeyIndex(policy, sig.pubkey) < 0) {
      fail(index, 'Dilithium partial signature is from a key the leaf does not authorise');
    }
    if (sig.signature[DILITHIUM_PARTIAL_SIG_SIZE - 1] !== SIGHASH_ALL) {
      fail(index, 'Dilithium partial signature uses an unsupported sighash type');
    }
    if (!spent) fail(index, 'cannot verify Dilithium partial signatures without every input amount');

    const sighash = p2mrSighash(psbt.tx, index, spent, sig.leafHash);
    if (!verifyTransactionHash(sig.pubkey, sighash, sig.signature)) {
      fail(index, 'Dilithium partial signature does not verify');
    }
  }
}

/**
 * Validate every input. Throws `WalletError('BAD_PSBT')` on the first failure —
 * btq-core zeroes the PSBT instead, which comes to the same thing: no caller
 * ever holds a decoded PSBT carrying a signature that did not verify.
 */
export function validateP2MRDilithiumPsbt(psbt: Psbt): void {
  if (!psbt.inputs.some(hasP2MRFields)) return;
  const spent = spentOutputs(psbt);
  for (let i = 0; i < psbt.inputs.length; i++) validateP2MRDilithiumInput(psbt, i, spent);
}
