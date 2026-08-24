/**
 * BTQ fee and weight math. Witness scale factor is 16, not Bitcoin's 4.
 *
 * btq-core:
 *   src/consensus/consensus.h:21     WITNESS_SCALE_FACTOR = 16
 *   src/consensus/validation.h:148    weight = stripped*(scale-1) + total
 *   src/policy/policy.cpp:357-360     vsize = ceil(weight / 16)
 *   src/policy/policy.h:30            MAX_STANDARD_TX_WEIGHT = 400000
 *   src/policy/policy.h:63            min relay 1000 sat/kvB
 *   src/policy/policy.h:61            DUST_RELAY_TX_FEE = 3000 sat/kvB
 *   src/policy/policy.cpp:26-63       GetDustThreshold
 *   src/script/dilithium_leaf.cpp:13  GetScriptForDilithiumThreshold (k-of-n leaf)
 *
 * A single-key P2MR input is 41 non-witness bytes + 3746 witness bytes
 * = 41*16 + 3746 = 4402 WU = 275.125 vB.
 */
import { WalletError } from '../wallet/errors.js';

export const WITNESS_SCALE_FACTOR = 16;
export const MAX_STANDARD_TX_WEIGHT = 400_000;
export const P2MR_INPUT_WEIGHT = 4402;
export const P2MR_INPUT_VSIZE = P2MR_INPUT_WEIGHT / WITNESS_SCALE_FACTOR; // 275.125
export const P2MR_OUTPUT_SIZE = 8 + 1 + 34; // value + compact script + OP_2 <32>
export const P2MR_WITNESS_BYTES = 3746; // varint(3) + sig + leaf + control
export const MAX_P2MR_INPUTS = 90;
export const MIN_RELAY_SAT_PER_KVB = 1000;
/** Above this a fee is almost certainly a typo (100 sat/vB on a 60-second chain). */
export const MAX_SANE_SAT_PER_KVB = 100_000;
/** Bitcoin-style dust relay, 3× min relay — btq-core policy.h:61. */
export const DUST_RELAY_SAT_PER_KVB = 3_000;

/**
 * btq-core GetDustThreshold (policy.cpp:26-63) for a P2MR output: the 43-byte
 * output plus the witness-branch spend estimate
 *   32 (txid) + 4 (vout) + 1 (scriptSig len) + floor(107 / 16) + 4 (sequence) = 47 bytes
 * ⇒ 90 bytes × 3000 sat/kvB = 270 sats. That is the node's rule; refusing more
 * than this rejects legal amounts and folds legal change into the fee.
 */
export const P2MR_SPEND_ESTIMATE_BYTES = 32 + 4 + 1 + Math.floor(107 / WITNESS_SCALE_FACTOR) + 4; // 47
export const P2MR_DUST_SATS = BigInt(
  Math.ceil(((P2MR_OUTPUT_SIZE + P2MR_SPEND_ESTIMATE_BYTES) * DUST_RELAY_SAT_PER_KVB) / 1000),
); // 270

/**
 * Wallet policy, not consensus: an output worth less than the ~275 vB it costs
 * to spend later is uneconomical. Used for warnings only — never to refuse an
 * amount the user typed, and never to burn change into the fee.
 */
export const UNECONOMICAL_P2MR_OUTPUT_SATS = BigInt(
  Math.ceil(((P2MR_INPUT_VSIZE + P2MR_OUTPUT_SIZE) * DUST_RELAY_SAT_PER_KVB) / 1000),
); // 955

export function transactionWeight(strippedSize: number, totalSize: number): number {
  return strippedSize * (WITNESS_SCALE_FACTOR - 1) + totalSize;
}

export function virtualSizeCeil(weight: number): number {
  return Math.ceil(weight / WITNESS_SCALE_FACTOR);
}

/**
 * Bytes a compact-size prefix occupies. The value table is `compactSize()` in
 * `util/bytes.ts` (btq-core `serialize.h` `WriteCompactSize`) counted rather
 * than encoded, so nothing here allocates inside a coin-selection loop;
 * `fee.test.ts` pins the two against each other across every boundary.
 */
export function compactSizeBytes(n: number): number {
  if (n < 0xfd) return 1;
  if (n <= 0xffff) return 3;
  return 5;
}

/** Weight of a signed single-key P2MR tx with `inputs` and `outputs`. */
export function estimateP2mrTxWeight(inputs: number, outputs: number): number {
  const stripped = strippedTxSize(inputs, outputs);
  const total = stripped + 2 + inputs * P2MR_WITNESS_BYTES; // marker/flag + witnesses
  return transactionWeight(stripped, total);
}

/**
 * Serialized size of a transaction with its witness stripped: version, the
 * two compact-size counts, 41 bytes per P2MR input (32 txid + 4 vout + 1 empty
 * scriptSig + 4 sequence), 43 bytes per P2MR output, locktime.
 */
function strippedTxSize(inputs: number, outputs: number): number {
  return (
    4 +
    compactSizeBytes(inputs) +
    inputs * 41 +
    compactSizeBytes(outputs) +
    outputs * P2MR_OUTPUT_SIZE +
    4
  );
}

/**
 * Reject a fee rate the node would not relay, or one so high it burns the
 * balance. BAD_FEE_RATE so the popup can name the bound that was broken.
 */
export function assertFeeRate(satPerKvB: number): number {
  if (!Number.isFinite(satPerKvB) || !Number.isInteger(satPerKvB)) {
    throw new WalletError('BAD_FEE_RATE', 'Fee rate must be a whole number of sat/kvB.');
  }
  if (satPerKvB < MIN_RELAY_SAT_PER_KVB) {
    throw new WalletError(
      'BAD_FEE_RATE',
      `Fee rate is below the ${MIN_RELAY_SAT_PER_KVB} sat/kvB relay floor — the network would not forward this transaction.`,
    );
  }
  if (satPerKvB > MAX_SANE_SAT_PER_KVB) {
    throw new WalletError(
      'BAD_FEE_RATE',
      `Fee rate above ${MAX_SANE_SAT_PER_KVB} sat/kvB looks like a typo. Use ${MIN_RELAY_SAT_PER_KVB}–${MAX_SANE_SAT_PER_KVB}.`,
    );
  }
  return satPerKvB;
}

export function feeForWeight(weight: number, satPerKvB: number): bigint {
  assertFeeRate(satPerKvB);
  const vsize = virtualSizeCeil(weight);
  return BigInt(Math.ceil((vsize * satPerKvB) / 1000));
}

export function feeForP2mrTx(inputs: number, outputs: number, satPerKvB = MIN_RELAY_SAT_PER_KVB): bigint {
  return feeForWeight(estimateP2mrTxWeight(inputs, outputs), satPerKvB);
}

/**
 * The node's dust threshold for a P2MR output: 270 sats. At or above this a
 * relay accepts the output, so this is where the wallet refuses an amount and
 * where change stops being worth a separate output.
 */
export function dustThreshold(): bigint {
  return P2MR_DUST_SATS;
}

/* -------------------------------------------------------------------------
 * k-of-n threshold spends
 *
 * btq-core builds an m-of-n Dilithium leaf as an accumulator
 * (`src/script/dilithium_leaf.cpp:13` `GetScriptForDilithiumThreshold`):
 *
 *   OP_0
 *   (OP_TOALTSTACK <pubkey> OP_CHECKSIGDILITHIUM OP_FROMALTSTACK OP_ADD) x n
 *   <m> OP_GREATERTHANOREQUAL
 *
 * A key that did not sign contributes an empty witness slot, which
 * OP_CHECKSIGDILITHIUM scores as 0 without failing, so any m-sized subset
 * produces a valid witness. That is what lets independent wallets sign in
 * parallel — and, for sizing, it means an unused slot costs exactly 1 byte.
 *
 * The sizes below are witness bytes, and witness bytes are 16x cheaper than
 * non-witness bytes on BTQ (`src/consensus/consensus.h:21`
 * WITNESS_SCALE_FACTOR = 16, against Bitcoin's 4). That single constant is why
 * post-quantum multisig is affordable here at all: a 2-of-3 spend costs 689 vB.
 *
 * Standardness holds for every shape up to 20-of-20. `IsWitnessStandard`
 * (`src/policy/policy.cpp:294-311`) pops the control block and the leaf script
 * off the stack *before* applying MAX_STANDARD_TAPSCRIPT_STACK_ITEM_SIZE
 * (15000, `src/policy/policy.h:48`), so the 26384-byte 20-of-20 leaf is not
 * measured against it; only the 2421-byte signature slots are, and they are
 * well under. The binding limit is MAX_STANDARD_TX_WEIGHT = 400000
 * (`src/policy/policy.h:30`), which fits 42 2-of-3 inputs.
 *
 * This module deliberately duplicates no script construction — it counts bytes
 * only, so that it stays independent of the leaf builder.
 * ------------------------------------------------------------------------- */

/** ML-DSA-44 public key, `src/crypto/dilithium_key.h`. */
export const DILITHIUM_PUBKEY_BYTES = 1312;
/** Signature plus the mandatory sighash byte — `src/psbt.h:82`. */
export const DILITHIUM_SIG_BYTES = 2421;
/** MAX_PUBKEYS_PER_MULTISIG, `src/script/script.h:35`. Also the PSBT cap on
 *  partial sigs per input (`src/psbt.h:83`). */
export const MAX_THRESHOLD_KEYS = 20;
/** Largest witness stack item policy will relay, `src/policy/policy.h:48`. */
export const MAX_STANDARD_TAPSCRIPT_STACK_ITEM_SIZE = 15_000;

/**
 * Bytes one key contributes to a threshold leaf: OP_TOALTSTACK (1) +
 * OP_PUSHDATA2 with an LE16 length (3) + the pubkey (1312) +
 * OP_CHECKSIGDILITHIUM (1) + OP_FROMALTSTACK (1) + OP_ADD (1).
 */
export const THRESHOLD_LEAF_KEY_BYTES = 1 + 3 + DILITHIUM_PUBKEY_BYTES + 1 + 1 + 1; // 1319

/**
 * Bytes `<m>` occupies when `CScript::operator<<(int64_t)` pushes it
 * (`src/script/script.h:431` `push_int64`): 1..16 are the single-byte OP_N
 * opcodes, anything larger is a minimally-serialized CScriptNum behind a
 * length byte. m never exceeds 20, so the data is always one byte.
 *
 * This is why a threshold leaf's size depends on m and not only on n: a
 * 20-of-20 leaf is 26384 bytes, one more than 1319*20 + 3 would suggest.
 */
function scriptNumPushBytes(v: number): number {
  return v >= 1 && v <= 16 ? 1 : 2;
}

function assertThreshold(m: number, n: number): void {
  if (!Number.isInteger(m) || !Number.isInteger(n)) {
    throw new WalletError('BAD_PARAMS', 'Threshold m and n must be whole numbers.');
  }
  if (n < 1 || n > MAX_THRESHOLD_KEYS) {
    throw new WalletError(
      'BAD_PARAMS',
      `A Dilithium threshold leaf holds 1 to ${MAX_THRESHOLD_KEYS} keys, not ${n}.`,
    );
  }
  if (m < 1 || m > n) {
    throw new WalletError('BAD_PARAMS', `Threshold ${m} is not between 1 and ${n}.`);
  }
}

function assertDepth(depth: number): void {
  if (!Number.isInteger(depth) || depth < 0) {
    throw new WalletError('BAD_PARAMS', 'Merkle path depth must be a non-negative whole number.');
  }
}

/**
 * Serialized size of an m-of-n accumulator leaf script:
 * OP_0 (1) + n keys + `<m>` + OP_GREATERTHANOREQUAL (1).
 *
 * Takes m as well as n — see `scriptNumPushBytes`.
 */
export function thresholdLeafScriptBytes(m: number, n: number): number {
  assertThreshold(m, n);
  return 1 + n * THRESHOLD_LEAF_KEY_BYTES + scriptNumPushBytes(m) + 1;
}

/**
 * Serialized size of one input's witness field: a compact-size item count
 * followed by every item behind its own compact-size length.
 *
 * Every witness size in this module goes through here — the single-key case
 * and the threshold case alike — which is what makes the single-key check in
 * `fee.test.ts` (this formula, fed the single-key leaf's own dimensions,
 * reproducing P2MR_WITNESS_BYTES = 3746) an actual check on the arithmetic
 * rather than a restatement of the constant.
 */
export function witnessFieldBytes(itemSizes: readonly number[]): number {
  let bytes = compactSizeBytes(itemSizes.length);
  for (const size of itemSizes) bytes += compactSizeBytes(size) + size;
  return bytes;
}

/** One input of an m-of-n threshold spend, at `depth` levels of merkle path. */
export interface ThresholdInput {
  m: number;
  n: number;
  /**
   * Merkle path length to this leaf. 0 is a single-leaf tree, whose control
   * block is the lone 1-byte leaf-version-and-parity byte
   * (`src/script/interpreter.h:252-255`, control block = 1 + 32*depth).
   */
  depth?: number;
}

/**
 * Witness bytes for one m-of-n input: n signature slots (m filled, n - m
 * empty), then the leaf script, then the control block.
 *
 * Slot order is the finalizer's problem, not the sizer's — an empty slot is
 * 1 byte wherever it sits.
 */
export function thresholdWitnessBytes(m: number, n: number, depth = 0): number {
  assertThreshold(m, n);
  assertDepth(depth);
  const slots: number[] = [];
  for (let i = 0; i < n; i++) slots.push(i < m ? DILITHIUM_SIG_BYTES : 0);
  slots.push(thresholdLeafScriptBytes(m, n));
  slots.push(1 + 32 * depth);
  return witnessFieldBytes(slots);
}

/**
 * Weight of a signed transaction spending a heterogeneous set of threshold
 * inputs. Unlike `estimateP2mrTxWeight`, which takes a count because every
 * single-key input is the same size, this takes the inputs themselves: a real
 * multisig wallet may hold 2-of-3 and 3-of-5 coins at once, and the two do not
 * cost the same.
 */
export function estimateMultisigTxWeight(
  inputs: readonly ThresholdInput[],
  outputs: number,
): number {
  if (!Number.isInteger(outputs) || outputs < 0) {
    throw new WalletError('BAD_PARAMS', 'Output count must be a non-negative whole number.');
  }
  const stripped = strippedTxSize(inputs.length, outputs);
  let witness = 0;
  for (const input of inputs) witness += thresholdWitnessBytes(input.m, input.n, input.depth ?? 0);
  const total = stripped + (inputs.length > 0 ? 2 : 0) + witness; // marker/flag + witnesses
  return transactionWeight(stripped, total);
}

/** `feeForP2mrTx` for a threshold input set. */
export function feeForMultisigTx(
  inputs: readonly ThresholdInput[],
  outputs: number,
  satPerKvB = MIN_RELAY_SAT_PER_KVB,
): bigint {
  return feeForWeight(estimateMultisigTxWeight(inputs, outputs), satPerKvB);
}
