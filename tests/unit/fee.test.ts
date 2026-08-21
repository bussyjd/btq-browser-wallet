import { describe, it, expect } from 'vitest';
import {
  P2MR_INPUT_WEIGHT,
  P2MR_INPUT_VSIZE,
  WITNESS_SCALE_FACTOR,
  MAX_STANDARD_TX_WEIGHT,
  MAX_P2MR_INPUTS,
  estimateP2mrTxWeight,
  feeForP2mrTx,
  dustThreshold,
} from '../../src/core/tx/fee.js';

describe('scale-16 P2MR fee math (shipped fee.ts)', () => {
  it('a single-key P2MR input is 4402 WU = 275.125 vB at scale 16', () => {
    expect(WITNESS_SCALE_FACTOR).toBe(16);
    expect(P2MR_INPUT_WEIGHT).toBe(4402);
    expect(P2MR_INPUT_VSIZE).toBe(275.125);
    expect(P2MR_INPUT_WEIGHT / WITNESS_SCALE_FACTOR).toBe(275.125);
  });

  it('standardness ceiling is 400000 WU / ~90 P2MR inputs', () => {
    expect(MAX_STANDARD_TX_WEIGHT).toBe(400_000);
    expect(MAX_P2MR_INPUTS).toBe(90);
    expect(MAX_P2MR_INPUTS * P2MR_INPUT_WEIGHT).toBeLessThanOrEqual(MAX_STANDARD_TX_WEIGHT);
    expect((MAX_P2MR_INPUTS + 1) * P2MR_INPUT_WEIGHT).toBeGreaterThan(MAX_STANDARD_TX_WEIGHT);
  });

  it('fee at the 1000 sat/kvB relay floor is computed from ceil(weight/16)', () => {
    const fee = feeForP2mrTx(1, 2, 1000);
    const vsize = Math.ceil(estimateP2mrTxWeight(1, 2) / 16);
    expect(fee).toBe(BigInt(vsize));
  });

  it('dust threshold is positive and below a typical 1e8 sat coin', () => {
    expect(dustThreshold()).toBeGreaterThan(0n);
    expect(dustThreshold()).toBeLessThan(100_000n);
  });
});
