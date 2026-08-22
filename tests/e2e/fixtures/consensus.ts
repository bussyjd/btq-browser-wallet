/**
 * BTQ policy arithmetic, re-derived here from btq-core's constants so the mock
 * node measures the extension's transactions with numbers the extension did not
 * supply. Nothing here imports `src/core/tx/fee.ts`.
 *
 * btq-core:
 *   src/consensus/consensus.h:21   WITNESS_SCALE_FACTOR = 16
 *   src/consensus/validation.h:148 weight = stripped * (scale - 1) + total
 *   src/policy/policy.cpp:357-360  vsize = (weight + 15) / 16
 *   src/policy/policy.h:30         MAX_STANDARD_TX_WEIGHT = 400000
 *   src/policy/policy.h:61,63      DUST_RELAY_TX_FEE 3000, min relay 1000 sat/kvB
 *   src/policy/policy.cpp:26-63    GetDustThreshold
 */
export const WITNESS_SCALE_FACTOR = 16;
export const MAX_STANDARD_TX_WEIGHT = 400_000;
export const MIN_RELAY_SAT_PER_KVB = 1000;
export const DUST_RELAY_SAT_PER_KVB = 3_000;

/** value(8) + compact script length(1) + OP_2 <32 bytes>(34). */
export const P2MR_OUTPUT_SIZE = 8 + 1 + 34;
/** txid(32) + vout(4) + scriptSig length(1) + floor(107/16) + sequence(4). */
export const P2MR_SPEND_ESTIMATE_BYTES = 32 + 4 + 1 + Math.floor(107 / WITNESS_SCALE_FACTOR) + 4;
/** 90 bytes x 3000 sat/kvB = 270 sats — the node's dust floor for a P2MR output. */
export const P2MR_DUST_SATS = BigInt(
  Math.ceil(((P2MR_OUTPUT_SIZE + P2MR_SPEND_ESTIMATE_BYTES) * DUST_RELAY_SAT_PER_KVB) / 1000),
);
/** Non-witness bytes of one input: txid + vout + empty scriptSig + sequence. */
export const P2MR_INPUT_BYTES = 32 + 4 + 1 + 4;
/** stack count(1) + sig(3 + 2421) + leaf(3 + 1316) + control(1 + 1). */
export const P2MR_WITNESS_BYTES = 1 + (3 + 2421) + (3 + 1316) + (1 + 1);

export function weightOf(strippedSize: number, totalSize: number): number {
  return strippedSize * (WITNESS_SCALE_FACTOR - 1) + totalSize;
}

export function vsizeOf(weight: number): number {
  return Math.ceil(weight / WITNESS_SCALE_FACTOR);
}

export function feeForVsize(vsize: number, satPerKvB: number): bigint {
  return BigInt(Math.ceil((vsize * satPerKvB) / 1000));
}

function compactSizeBytes(n: number): number {
  if (n < 0xfd) return 1;
  if (n <= 0xffff) return 3;
  return 5;
}

/** Weight of a signed single-key P2MR transaction of this shape. */
export function estimateP2mrWeight(inputs: number, outputs: number): number {
  const stripped =
    4 +
    compactSizeBytes(inputs) +
    inputs * P2MR_INPUT_BYTES +
    compactSizeBytes(outputs) +
    outputs * P2MR_OUTPUT_SIZE +
    4;
  const total = stripped + 2 + inputs * P2MR_WITNESS_BYTES; // marker/flag + witnesses
  return weightOf(stripped, total);
}

/** The fee the wallet must quote for this shape at this rate. */
export function feeForP2mrTx(inputs: number, outputs: number, satPerKvB: number): bigint {
  return feeForVsize(vsizeOf(estimateP2mrWeight(inputs, outputs)), satPerKvB);
}

/** Satoshis as the popup prints them (8 decimals, trailing zeros trimmed). */
export function formatSats(sats: bigint): string {
  const neg = sats < 0n;
  const n = neg ? -sats : sats;
  const whole = n / 100_000_000n;
  const frac = (n % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  const body = frac.length === 0 ? whole.toString() : `${whole.toString()}.${frac}`;
  return neg ? `-${body}` : body;
}
