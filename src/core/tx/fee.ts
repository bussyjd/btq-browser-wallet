/**
 * BTQ fee and weight math. Witness scale factor is 16, not Bitcoin's 4.
 *
 * btq-core:
 *   src/consensus/consensus.h:21     WITNESS_SCALE_FACTOR = 16
 *   src/consensus/validation.h:148    weight = stripped*(scale-1) + total
 *   src/policy/policy.cpp:357-360     vsize = ceil(weight / 16)
 *   src/policy/policy.h:30            MAX_STANDARD_TX_WEIGHT = 400000
 *   src/policy/policy.h:63            min relay 1000 sat/kvB
 *
 * A single-key P2MR input is 41 non-witness bytes + 3746 witness bytes
 * = 41*16 + 3746 = 4402 WU = 275.125 vB.
 */
export const WITNESS_SCALE_FACTOR = 16;
export const MAX_STANDARD_TX_WEIGHT = 400_000;
export const P2MR_INPUT_WEIGHT = 4402;
export const P2MR_INPUT_VSIZE = P2MR_INPUT_WEIGHT / WITNESS_SCALE_FACTOR; // 275.125
export const P2MR_OUTPUT_SIZE = 8 + 1 + 34; // value + compact script + OP_2 <32>
export const P2MR_WITNESS_BYTES = 3746; // varint(3) + sig + leaf + control
export const MAX_P2MR_INPUTS = 90;
export const MIN_RELAY_SAT_PER_KVB = 1000;
/** Bitcoin-style dust relay (3× min relay). */
export const DUST_RELAY_SAT_PER_KVB = 3_000;

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

export function feeForWeight(weight: number, satPerKvB: number): bigint {
  if (satPerKvB < MIN_RELAY_SAT_PER_KVB) {
    throw new Error(`fee rate ${satPerKvB} sat/kvB is below the 1000 sat/kvB relay floor`);
  }
  const vsize = virtualSizeCeil(weight);
  return BigInt(Math.ceil((vsize * satPerKvB) / 1000));
}

export function feeForP2mrTx(inputs: number, outputs: number, satPerKvB = MIN_RELAY_SAT_PER_KVB): bigint {
  return feeForWeight(estimateP2mrTxWeight(inputs, outputs), satPerKvB);
}

/**
 * An output is dust if spending it later costs more than it is worth at the
 * dust-relay fee. P2MR spend cost is 4402 WU.
 */
export function dustThreshold(): bigint {
  const spendV = P2MR_INPUT_VSIZE + P2MR_OUTPUT_SIZE;
  return BigInt(Math.ceil((spendV * DUST_RELAY_SAT_PER_KVB) / 1000));
}
