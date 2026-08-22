import { describe, it, expect } from 'vitest';
import {
  P2MR_INPUT_WEIGHT,
  P2MR_INPUT_VSIZE,
  P2MR_OUTPUT_SIZE,
  P2MR_DUST_SATS,
  UNECONOMICAL_P2MR_OUTPUT_SATS,
  WITNESS_SCALE_FACTOR,
  MAX_STANDARD_TX_WEIGHT,
  MAX_P2MR_INPUTS,
  MAX_SANE_SAT_PER_KVB,
  MIN_RELAY_SAT_PER_KVB,
  assertFeeRate,
  estimateP2mrTxWeight,
  feeForP2mrTx,
  feeForWeight,
  dustThreshold,
  transactionWeight,
  virtualSizeCeil,
} from '../../src/core/tx/fee.js';
import { selectCoins, maxSpendable, type OwnedUtxo } from '../../src/core/tx/coinselect.js';
import { WalletError } from '../../src/core/wallet/errors.js';
import { hexToBytes } from '../../src/core/util/hex.js';
import vectors from '../vectors/golden.json' with { type: 'json' };
import txFixture from '../fixtures/explorer/tx.json' with { type: 'json' };

const e0 = vectors.entries[0]!;

function coin(value: bigint, vout = 0): OwnedUtxo {
  return {
    txid: '11'.repeat(32),
    vout,
    value,
    script: hexToBytes(e0.scriptPubKey),
    address: e0.addresses.testnet,
    chain: 'external',
    index: 0,
    blockHeight: 300741,
  };
}

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
    // A full 90-input sweep still fits inside MAX_STANDARD_TX_WEIGHT.
    expect(estimateP2mrTxWeight(MAX_P2MR_INPUTS, 1)).toBeLessThanOrEqual(MAX_STANDARD_TX_WEIGHT);
  });

  it('pins the estimated weight and vsize of the shapes we actually build', () => {
    // A wrong estimate here is a wrong fee: too low and the tx never relays,
    // too high and the user overpays out of the change output.
    expect(estimateP2mrTxWeight(1, 2)).toBe(5940); // stripped 137, total 3885
    expect(virtualSizeCeil(5940)).toBe(372);
    expect(estimateP2mrTxWeight(1, 1)).toBe(5252);
    expect(virtualSizeCeil(5252)).toBe(329);
    expect(estimateP2mrTxWeight(3, 2)).toBe(14744);
    expect(4 + 1 + 41 + 1 + 2 * P2MR_OUTPUT_SIZE + 4).toBe(137);
  });

  it('matches the weight and vsize the live explorer reports for a real tx', () => {
    // Recorded from the chain: 3 P2MR inputs, one legacy 25-byte output, one
    // P2MR output. If our scale-16 arithmetic drifted from the node's, this is
    // where it shows up.
    const body = txFixture.body;
    const stripped = 4 + 1 + 3 * 41 + 1 + (8 + 1 + 25) + (8 + 1 + 34) + 4;
    expect(stripped).toBe(210);
    expect(transactionWeight(stripped, body.size)).toBe(body.weight);
    expect(virtualSizeCeil(body.weight)).toBe(body.vsize);
  });

  it('fee at the 1000 sat/kvB relay floor is computed from ceil(weight/16)', () => {
    expect(feeForP2mrTx(1, 2, 1000)).toBe(372n);
    expect(feeForP2mrTx(1, 1, 1000)).toBe(329n);
    expect(feeForP2mrTx(1, 2, 5000)).toBe(1860n);
    expect(feeForWeight(5940, MIN_RELAY_SAT_PER_KVB)).toBe(372n);
  });

  it('rejects fee rates outside the relay floor and the sanity ceiling', () => {
    // User loss: below 1000 sat/kvB nothing relays and the payment silently
    // never happens; a fat-fingered rate above the ceiling burns the balance.
    expect(() => assertFeeRate(999)).toThrow(WalletError);
    expect(() => assertFeeRate(999)).toThrow(/relay floor/);
    expect(() => assertFeeRate(MAX_SANE_SAT_PER_KVB + 1)).toThrow(/typo/);
    expect(() => assertFeeRate(1000.5)).toThrow(/whole number/);
    expect(assertFeeRate(1000)).toBe(1000);
    expect(assertFeeRate(MAX_SANE_SAT_PER_KVB)).toBe(MAX_SANE_SAT_PER_KVB);
    try {
      assertFeeRate(10);
    } catch (e) {
      expect((e as WalletError).code).toBe('BAD_FEE_RATE');
    }
  });

  it('dust is btq-core policy: 270 sats for a P2MR output', () => {
    // Refusing more than the node does rejects legal payments and folds legal
    // change into the fee — money the user simply loses.
    // btq-core policy.cpp:26-63 with DUST_RELAY_TX_FEE 3000 (policy.h:61):
    // (43-byte output + 47-byte spend estimate) * 3000 / 1000 = 270.
    expect(dustThreshold()).toBe(270n);
    expect(P2MR_DUST_SATS).toBe(270n);
    // The old, stricter wallet number survives only as a warning threshold.
    expect(UNECONOMICAL_P2MR_OUTPUT_SATS).toBe(955n);
  });

  it('the dust boundary is exact: 269 refused, 270 accepted', () => {
    const utxos = [coin(100_000_000n)];
    expect(() => selectCoins(utxos, 269n, 1000)).toThrow(/dust/i);
    expect(() => selectCoins(utxos, 0n, 1000)).toThrow(/positive/);
    expect(selectCoins(utxos, 270n, 1000).inputs).toHaveLength(1);
  });

  it('change below dust is folded into the fee instead of becoming an invalid output', () => {
    // A sub-dust change output makes the whole transaction non-standard, so
    // the node would refuse it and the payment would never go out.
    const value = 10_000n;
    const feeWithChange = feeForP2mrTx(1, 2, 1000); // 372
    const amount = value - feeWithChange - 100n; // leaves 100 sats of change
    const sel = selectCoins([coin(value)], amount, 1000);
    expect(sel.change).toBe(0n);
    expect(sel.outputCount).toBe(1);
    expect(sel.fee).toBe(value - amount);
  });

  it('change at or above dust becomes a real output', () => {
    const value = 10_000n;
    const amount = value - feeForP2mrTx(1, 2, 1000) - 300n;
    const sel = selectCoins([coin(value)], amount, 1000);
    expect(sel.change).toBe(300n);
    expect(sel.outputCount).toBe(2);
  });

  it('maxSpendable leaves exactly the fee behind and never goes negative', () => {
    // User loss: an over-optimistic "Max" builds a transaction that cannot pay
    // its own fee, so the send fails at the last step every time.
    const empty = maxSpendable([], 1000);
    expect(empty.amount).toBe(0n);
    const one = maxSpendable([coin(1_000_000n)], 1000);
    expect(one.amount).toBe(1_000_000n - feeForP2mrTx(1, 1, 1000));
    expect(one.inputs).toHaveLength(1);
    const two = maxSpendable([coin(1_000_000n, 0), coin(2_000_000n, 1)], 1000);
    expect(two.amount).toBe(3_000_000n - feeForP2mrTx(2, 1, 1000));
    // A coin worth less than the input costs must not drag the total down.
    const withDust = maxSpendable([coin(1_000_000n, 0), coin(10n, 1)], 1000);
    expect(withDust.amount).toBe(one.amount);
  });

  it('spends confirmed coins before mempool coins', () => {
    // User loss: building on an unconfirmed parent means the child dies with
    // it if the parent is replaced or evicted.
    const unconfirmed = { ...coin(9_000_000n, 5), blockHeight: null };
    const confirmed = coin(1_000_000n, 6);
    const sel = selectCoins([unconfirmed, confirmed], 500_000n, 1000);
    expect(sel.inputs).toHaveLength(1);
    expect(sel.inputs[0]!.vout).toBe(6);
  });
});
