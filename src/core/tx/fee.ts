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

function varintSize(n: number): number {
  if (n < 0xfd) return 1;
  if (n <= 0xffff) return 3;
  return 5;
}

/** Weight of a signed single-key P2MR tx with `inputs` and `outputs`. */
export function estimateP2mrTxWeight(inputs: number, outputs: number): number {
  const stripped =
    4 + varintSize(inputs) + inputs * 41 + varintSize(outputs) + outputs * P2MR_OUTPUT_SIZE + 4;
  const total = stripped + 2 + inputs * P2MR_WITNESS_BYTES; // marker/flag + witnesses
  return transactionWeight(stripped, total);
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
