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
  compactSizeBytes,
  witnessFieldBytes,
  thresholdLeafScriptBytes,
  thresholdWitnessBytes,
  estimateMultisigTxWeight,
  feeForMultisigTx,
  DILITHIUM_PUBKEY_BYTES,
  DILITHIUM_SIG_BYTES,
  MAX_THRESHOLD_KEYS,
  MAX_MERKLE_PATH_DEPTH,
  MAX_STANDARD_TAPSCRIPT_STACK_ITEM_SIZE,
  VALIDATION_WEIGHT_PER_DILITHIUM_SIG,
  VALIDATION_WEIGHT_OFFSET,
  validationWeightSlack,
  maxStandardThresholdInputs,
  maxInputsForWitness,
  THRESHOLD_LEAF_KEY_BYTES,
  P2MR_WITNESS_BYTES,
  type ThresholdInput,
} from '../../src/core/tx/fee.js';
import { compactSize, singleKeyLeafScript, singleLeafControlBlock } from '../../src/core/script/p2mr.js';
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

  it('an exact sweep is selected, not reported as INSUFFICIENT', () => {
    // User loss: this is the "Max" button. maxSpendable hands back
    // total - feeForP2mrTx(n, 1), so total === amount + noChangeFee exactly —
    // which is strictly less than amount + withChangeFee. While the no-change
    // candidate lived nested inside the with-change guard, that guard never
    // opened and the sweep threw INSUFFICIENT, i.e. the user could not empty
    // the wallet at all unless it happened to hold a spare coin.
    const coins = [coin(5_000_000n, 0), coin(3_000_000n, 1)];
    const total = 8_000_000n;
    for (const rate of [1000, 2000, 5000]) {
      const max = maxSpendable(coins, rate);
      expect(max.inputs, `rate ${rate}`).toHaveLength(2);
      const sel = selectCoins(coins, max.amount, rate);
      expect(sel.inputs, `rate ${rate}`).toHaveLength(2);
      expect(sel.outputCount, `rate ${rate}`).toBe(1);
      expect(sel.change, `rate ${rate}`).toBe(0n);
      expect(sel.fee, `rate ${rate}`).toBe(max.fee);
      expect(sel.fee, `rate ${rate}`).toBe(feeForP2mrTx(2, 1, rate));
      expect(max.amount + sel.fee, `rate ${rate}`).toBe(total);
    }
  });

  it('does not pull in a second coin just to open a change output', () => {
    // The same nesting bug, one step earlier: when a single coin covers the
    // amount plus the one-output fee but not the two-output fee, adding a
    // 275 vB input costs far more than the few sats of change it would create.
    const rate = 1000;
    const amount = 9_000_000n;
    const noChange = feeForP2mrTx(1, 1, rate); // 329
    const withChange = feeForP2mrTx(1, 2, rate); // 372
    expect(noChange).toBeLessThan(withChange);
    const sel = selectCoins([coin(amount + noChange + 10n, 0), coin(500_000n, 1)], amount, rate);
    expect(sel.inputs).toHaveLength(1);
    expect(sel.outputCount).toBe(1);
    expect(sel.change).toBe(0n);
    expect(sel.fee).toBe(noChange + 10n);
  });

  it('the 1000 sat/kvB relay floor is pinned, and every fee entry point enforces it', () => {
    // The floor is the only thing standing between the user and a transaction
    // no node will forward: a wallet that quotes 0 sat/kvB looks like it sent
    // the payment and never did. Pin the constant itself — a floor of 0 must
    // fail here and not only in some downstream assertion.
    expect(MIN_RELAY_SAT_PER_KVB).toBe(1000);
    const utxos = [coin(100_000_000n)];
    for (const rate of [0, 1, 999]) {
      for (const call of [
        () => feeForWeight(5940, rate),
        () => feeForP2mrTx(1, 2, rate),
        () => selectCoins(utxos, 10_000n, rate),
        () => maxSpendable(utxos, rate),
      ]) {
        expect(call, `rate ${rate}`).toThrow(WalletError);
        expect(call, `rate ${rate}`).toThrow(/relay floor/);
        let code = 'NO_THROW';
        try {
          call();
        } catch (e) {
          code = e instanceof WalletError ? e.code : 'NOT_A_WALLET_ERROR';
        }
        expect(code, `rate ${rate}`).toBe('BAD_FEE_RATE');
      }
    }
    // …and the floor itself is still a usable rate.
    expect(feeForWeight(5940, MIN_RELAY_SAT_PER_KVB)).toBe(372n);
    expect(selectCoins(utxos, 10_000n, MIN_RELAY_SAT_PER_KVB).fee).toBe(372n);
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

describe('k-of-n threshold sizing', () => {
  const pubkey = new Uint8Array(DILITHIUM_PUBKEY_BYTES).fill(0xab);

  it('reproduces P2MR_WITNESS_BYTES = 3746 from the general witness formula', () => {
    // The tie-in. `witnessFieldBytes` is the one byte-counting path in fee.ts;
    // if it is right for the single-key spend — whose 3746 is pinned by the
    // shipped constant, by golden.json and by a real on-chain transaction —
    // then the threshold numbers below rest on already-verified arithmetic
    // rather than on a second, unchecked formula.
    //
    // The dimensions are taken from the wallet's own script builders, not
    // retyped: one 2421-byte signature slot, the real single-key leaf, the
    // real single-leaf control block.
    const leaf = singleKeyLeafScript(pubkey);
    const control = singleLeafControlBlock();
    expect(leaf.length).toBe(1316);
    expect(control.length).toBe(1);
    expect(witnessFieldBytes([DILITHIUM_SIG_BYTES, leaf.length, control.length])).toBe(
      P2MR_WITNESS_BYTES,
    );
    expect(P2MR_WITNESS_BYTES).toBe(3746);
    // …and the input weight the whole fee module is built on falls out of it.
    expect(41 * WITNESS_SCALE_FACTOR + P2MR_WITNESS_BYTES).toBe(P2MR_INPUT_WEIGHT);
  });

  it('the degenerate 1-of-1 threshold leaf is NOT the single-key leaf', () => {
    // Easy and wrong to assume they collapse. The accumulator wraps the key in
    // OP_0 / OP_TOALTSTACK … OP_FROMALTSTACK OP_ADD / <1> OP_GREATERTHANOREQUAL,
    // so it is 6 bytes longer and hashes to a different TapLeaf — a different
    // address. A wallet that treated them as interchangeable would derive an
    // address its cosigner cannot reproduce.
    expect(singleKeyLeafScript(pubkey).length).toBe(1316);
    expect(thresholdLeafScriptBytes(1, 1)).toBe(1322);
    expect(thresholdLeafScriptBytes(1, 1)).not.toBe(singleKeyLeafScript(pubkey).length);
  });

  it('compactSizeBytes agrees with compactSize() at every threshold and both refusals', () => {
    // fee.ts counts the prefix instead of building it, so the two must not be
    // allowed to drift: an off-by-one here is an off-by-one in every fee.
    // Both sides of each of the three thresholds, plus the largest length the
    // encoder accepts at all.
    for (const n of [0, 1, 0xfc, 0xfd, 0xfe, 0xff, 0xffff, 0x10000, 0xffffff, 0xffffffff]) {
      expect(compactSizeBytes(n), `n=${n}`).toBe(compactSize(n).length);
    }
    // The refusals must match too, or the counter hands back a number for a
    // length the encoder would never produce. These are the two boundaries the
    // old test stopped short of.
    for (const n of [0x1_0000_0000, -1, 1.5, NaN]) {
      expect(() => compactSize(n), `n=${n}`).toThrow();
      expect(() => compactSizeBytes(n), `n=${n}`).toThrow(WalletError);
    }
  });

  it('a threshold leaf is 1319 bytes per key, plus OP_0, <m> and the comparison', () => {
    // btq-core GetScriptForDilithiumThreshold, src/script/dilithium_leaf.cpp:13.
    expect(THRESHOLD_LEAF_KEY_BYTES).toBe(1319);
    expect(thresholdLeafScriptBytes(2, 2)).toBe(2641);
    expect(thresholdLeafScriptBytes(2, 3)).toBe(3960);
    expect(thresholdLeafScriptBytes(3, 5)).toBe(6598);
    // m > 16 is not an OP_N opcode: CScript::push_int64 (src/script/script.h:431)
    // falls back to a length-prefixed CScriptNum, so the leaf gains a byte.
    // 20-of-20 is 1319*20 + 4 = 26384, not 26383.
    expect(thresholdLeafScriptBytes(16, 20)).toBe(1319 * 20 + 3);
    expect(thresholdLeafScriptBytes(17, 20)).toBe(1319 * 20 + 4);
    expect(thresholdLeafScriptBytes(20, 20)).toBe(26384);
  });

  it('pins leaf, witness, weight and vsize for the shapes a multisig wallet spends', () => {
    // Cross-checked against btq-core's own serializer
    // (test/functional/test_framework/messages.py CTransaction.get_weight),
    // not only against this arithmetic. One input, two P2MR outputs.
    const table: Array<[number, number, number, number, number, number]> = [
      // m,  n,   leaf,  witness, weight, vsize
      [1, 1, 1322, 3752, 5946, 372],
      [2, 2, 2641, 7495, 9689, 606],
      [2, 3, 3960, 8815, 11009, 689],
      [3, 5, 6598, 13878, 16072, 1005],
      [20, 20, 26384, 74870, 77064, 4817],
    ];
    for (const [m, n, leaf, witness, weight, vsize] of table) {
      const label = `${m}-of-${n}`;
      expect(thresholdLeafScriptBytes(m, n), label).toBe(leaf);
      expect(thresholdWitnessBytes(m, n), label).toBe(witness);
      const actual = estimateMultisigTxWeight([{ m, n }], 2);
      expect(actual, label).toBe(weight);
      expect(virtualSizeCeil(actual), label).toBe(vsize);
    }
  });

  it('the 16x witness discount is what keeps post-quantum multisig affordable', () => {
    // Everything here is computed from the estimator, so the comparison fails
    // if the witness arithmetic is wrong rather than merely restating literals.
    // One input, two P2MR outputs — a vsize means nothing without its shape.
    const multisig = virtualSizeCeil(estimateMultisigTxWeight([{ m: 2, n: 3 }], 2));
    const singleKey = virtualSizeCeil(estimateP2mrTxWeight(1, 2));
    expect(multisig).toBe(689);
    expect(singleKey).toBe(372);
    // A 2-of-3 post-quantum spend is under twice a single-key one.
    expect(multisig).toBeLessThan(2 * singleKey);
    // At Bitcoin's witness scale factor of 4 the same bytes would cost ~2342 vB.
    const stripped = 4 + 1 + 41 + 1 + 2 * P2MR_OUTPUT_SIZE + 4;
    const total = stripped + 2 + thresholdWitnessBytes(2, 3);
    const atScale4 = Math.ceil((stripped * 3 + total) / 4);
    expect(atScale4).toBe(2342);
    expect(atScale4).toBeGreaterThan(3 * multisig);
  });

  it('every shape up to 20-of-20 is standard and relayable', () => {
    for (const [m, n] of [
      [1, 1],
      [2, 2],
      [2, 3],
      [3, 5],
      [20, 20],
    ] as const) {
      expect(estimateMultisigTxWeight([{ m, n }], 2), `${m}-of-${n}`).toBeLessThanOrEqual(
        MAX_STANDARD_TX_WEIGHT,
      );
    }
    // The leaf script itself is not measured against the 15000-byte stack-item
    // limit — IsWitnessStandard (src/policy/policy.cpp:302-308) pops the leaf
    // and the control block off before checking. Only the signature slots are,
    // and a 2421-byte signature has room to spare. Worth pinning because the
    // 20-of-20 leaf is 26384 bytes: if that limit did apply, the whole top of
    // the table would be unrelayable.
    expect(DILITHIUM_SIG_BYTES).toBeLessThan(MAX_STANDARD_TAPSCRIPT_STACK_ITEM_SIZE);
    expect(thresholdLeafScriptBytes(20, 20)).toBeGreaterThan(
      MAX_STANDARD_TAPSCRIPT_STACK_ITEM_SIZE,
    );
  });

  it('the tapscript validation-weight budget never binds, even at 20-of-20', () => {
    // The other limit that sounds like it should bind. An input is granted
    // witness_bytes + 50 and each passing Dilithium signature spends 500
    // (src/script/script.h:64,71). Blowing it aborts the script with
    // SCRIPT_ERR_TAPSCRIPT_VALIDATION_WEIGHT no matter how good the fee was —
    // so the module checks it rather than assuming it.
    expect(VALIDATION_WEIGHT_PER_DILITHIUM_SIG).toBe(500);
    expect(VALIDATION_WEIGHT_OFFSET).toBe(50);
    for (const [m, n] of [
      [1, 1],
      [2, 3],
      [3, 5],
      [20, 20],
    ] as const) {
      expect(validationWeightSlack({ m, n }), `${m}-of-${n}`).toBeGreaterThan(0);
    }
    // Each signature brings 2424 bytes of budget to pay 500 of cost, so the
    // margin is ~4.8x on the signatures alone and grows with the leaf.
    expect(validationWeightSlack({ m: 20, n: 20 })).toBe(74_870 + 50 - 20 * 500);
    // An empty slot costs nothing: EvalChecksigDilithium only charges a
    // non-empty signature (src/script/interpreter.cpp:126). So widening 2-of-2
    // to 2-of-20 spends no more budget — it gains some.
    expect(validationWeightSlack({ m: 2, n: 20 })).toBeGreaterThan(
      validationWeightSlack({ m: 2, n: 2 }),
    );
  });

  it('42 2-of-3 inputs fit in one standard transaction, 43 do not', () => {
    // The multisig analogue of MAX_P2MR_INPUTS, at two P2MR outputs. It is not
    // 400000/11009 = 36: the fixed overhead of a transaction is paid once, not
    // once per input, so the marginal cost of an input is 41*16 + 8815 = 9471
    // WU — a weight, which unlike a vsize does not depend on the shape.
    const inputs = (k: number): ThresholdInput[] =>
      Array.from({ length: k }, () => ({ m: 2, n: 3 }));
    const limit = maxStandardThresholdInputs({ m: 2, n: 3 }, 2);
    expect(limit).toBe(42);
    // The formula validates itself: fed the single-key witness it has to
    // reproduce MAX_P2MR_INPUTS, a constant this module shipped and relied on
    // long before any threshold work. That is a far better check on the
    // arithmetic than asserting 42 as a magic number — if this line fails, 42
    // is not to be trusted either.
    expect(maxInputsForWitness(P2MR_WITNESS_BYTES, 2)).toBe(MAX_P2MR_INPUTS);
    expect(maxInputsForWitness(P2MR_WITNESS_BYTES, 1)).toBe(MAX_P2MR_INPUTS);
    expect(MAX_P2MR_INPUTS).toBe(90);
    expect(estimateMultisigTxWeight(inputs(limit), 2)).toBe(399_320);
    expect(estimateMultisigTxWeight(inputs(limit), 2)).toBeLessThanOrEqual(MAX_STANDARD_TX_WEIGHT);
    expect(estimateMultisigTxWeight(inputs(limit + 1), 2)).toBeGreaterThan(MAX_STANDARD_TX_WEIGHT);
    // The ceiling really does depend on the shape, which is why it is a
    // function and not a constant.
    expect(maxStandardThresholdInputs({ m: 2, n: 2 }, 2)).toBe(48);
    expect(maxStandardThresholdInputs({ m: 3, n: 5 }, 2)).toBe(27);
    expect(maxStandardThresholdInputs({ m: 20, n: 20 }, 2)).toBe(5);
    // The 1-of-1 threshold leaf is 6 bytes bigger than the single-key one, and
    // 90 has enough slack to absorb that — so this row agreeing with
    // MAX_P2MR_INPUTS is a coincidence, not the self-check above.
    expect(maxStandardThresholdInputs({ m: 1, n: 1 }, 2)).toBe(90);
    // And it holds at the boundary for every shape in the table.
    for (const [m, n] of [
      [1, 1],
      [2, 2],
      [2, 3],
      [3, 5],
      [20, 20],
    ] as const) {
      const k = maxStandardThresholdInputs({ m, n }, 2);
      expect(estimateMultisigTxWeight(inputs(k).map(() => ({ m, n })), 2), `${m}-of-${n}`)
        .toBeLessThanOrEqual(MAX_STANDARD_TX_WEIGHT);
      expect(
        estimateMultisigTxWeight(
          Array.from({ length: k + 1 }, () => ({ m, n })),
          2,
        ),
        `${m}-of-${n}`,
      ).toBeGreaterThan(MAX_STANDARD_TX_WEIGHT);
    }
  });

  it('an unused key slot costs one byte, so sparse m-of-n is nearly free', () => {
    // The accumulator's whole point: a non-signer contributes an empty slot.
    // Widening 2-of-2 to 2-of-3 adds a key to the leaf and one empty byte —
    // it does not add a second signature.
    const twoOfTwo = thresholdWitnessBytes(2, 2);
    const twoOfThree = thresholdWitnessBytes(2, 3);
    expect(twoOfThree - twoOfTwo).toBe(THRESHOLD_LEAF_KEY_BYTES + 1);
    // Whereas requiring one more signature costs a whole 2421-byte signature.
    expect(thresholdWitnessBytes(3, 3) - thresholdWitnessBytes(2, 3)).toBe(
      DILITHIUM_SIG_BYTES + 3 - 1,
    );
  });

  it('a deeper merkle path costs 32 bytes per level in the control block', () => {
    // A tree with a recovery leaf alongside the hot leaf: spending the hot leaf
    // needs the sibling hash, so the control block grows to 1 + 32*depth
    // (src/script/interpreter.h:252-255).
    const flat = thresholdWitnessBytes(2, 3, 0);
    expect(thresholdWitnessBytes(2, 3, 1) - flat).toBe(32);
    expect(thresholdWitnessBytes(2, 3, 2) - flat).toBe(64);
    // Cheap in vsize terms: a second leaf costs 2 vB to spend (32 witness bytes,
    // so 2 vB whatever the outputs are) and nothing at all if never used,
    // because the address is 32 bytes of merkle root either way.
    expect(
      virtualSizeCeil(estimateMultisigTxWeight([{ m: 2, n: 3, depth: 1 }], 2)) - 689,
    ).toBe(2);
    // The one step that is not a flat 32: at depth 8 the control block reaches
    // 257 bytes and its own compact-size prefix grows from 1 byte to 3.
    expect(thresholdWitnessBytes(2, 3, 8) - thresholdWitnessBytes(2, 3, 7)).toBe(34);
    expect(thresholdWitnessBytes(2, 3, 7) - thresholdWitnessBytes(2, 3, 6)).toBe(32);
    expect(thresholdWitnessBytes(2, 3, 9) - thresholdWitnessBytes(2, 3, 8)).toBe(32);
    // Omitting depth is the cheap direction, which is the dangerous one: a
    // multi-leaf coin quoted at depth 0 under-pays by 2 vB per input and the
    // transaction may not relay. The default is documented, not silent.
    expect(
      virtualSizeCeil(estimateMultisigTxWeight([{ m: 2, n: 3 }], 2)),
    ).toBeLessThan(virtualSizeCeil(estimateMultisigTxWeight([{ m: 2, n: 3, depth: 1 }], 2)));
    // btq-core caps a control block at 128 merkle nodes
    // (P2MR_CONTROL_MAX_NODE_COUNT, src/script/interpreter.h:254). Past that
    // the spend is invalid, not merely expensive, so quoting a fee for it
    // would hide the mistake until the node refused the transaction.
    expect(MAX_MERKLE_PATH_DEPTH).toBe(128);
    expect(() => thresholdWitnessBytes(2, 3, MAX_MERKLE_PATH_DEPTH)).not.toThrow();
    expect(() => thresholdWitnessBytes(2, 3, MAX_MERKLE_PATH_DEPTH + 1)).toThrow(WalletError);
    expect(() => thresholdWitnessBytes(2, 3, MAX_MERKLE_PATH_DEPTH + 1)).toThrow(/128 merkle/);
  });

  it('prices the slots the finalizer will really fill, not always exactly m', () => {
    // All vB figures here are for one input paying two P2MR outputs.
    //
    // m is a floor, not a bound. btq-core's finalizer emits every signature the
    // PSBT holds rather than selecting m of them: BuildDilithiumLeafWitness
    // (src/script/dilithium_leaf.cpp:163-173) checks signed_count >= policy.m
    // and then pushes all n slots — unlike the OP_CHECKMULTISIGDILITHIUM branch
    // at :152-156, which does break at m. So a surplus signature is not a
    // wallet bug to be swept up at finalize time; it is the reference
    // behaviour, and a finalizer that dropped it would derive a different txid
    // from the same PSBT than btq-core does. The defence is therefore either to
    // quote for the real signature count (this parameter) or to refuse the
    // surplus at *signing* time — never to silently discard it while
    // finalizing.
    expect(thresholdWitnessBytes(2, 3, 0, 3)).toBe(thresholdWitnessBytes(3, 3));
    const quoted = virtualSizeCeil(estimateMultisigTxWeight([{ m: 2, n: 3 }], 2));
    const actual = virtualSizeCeil(
      estimateMultisigTxWeight([{ m: 2, n: 3, signatures: 3 }], 2),
    );
    expect(quoted).toBe(689);
    expect(actual).toBe(840);
    // And here is why it is a correctness bug rather than a sizing footnote:
    // a fee computed for 689 vB at the relay floor pays 820 sat/kvB once the
    // transaction is really 840 vB. Below the floor nothing forwards it, so the
    // failure surfaces as a payment that silently never arrives — not as an
    // error at signing time, where it could still be fixed.
    const fee = feeForMultisigTx([{ m: 2, n: 3 }], 2, MIN_RELAY_SAT_PER_KVB);
    expect(fee).toBe(689n);
    const effectiveRate = Number((fee * 1000n) / BigInt(actual));
    expect(effectiveRate).toBe(820);
    expect(effectiveRate).toBeLessThan(MIN_RELAY_SAT_PER_KVB);
    // Quoting the real slot count pays the floor, which is the whole point.
    expect(
      Number((feeForMultisigTx([{ m: 2, n: 3, signatures: 3 }], 2, MIN_RELAY_SAT_PER_KVB) * 1000n) /
        BigInt(actual)),
    ).toBeGreaterThanOrEqual(MIN_RELAY_SAT_PER_KVB);
    // Each extra signature replaces a 1-byte empty slot with 3 + 2421 bytes.
    expect(thresholdWitnessBytes(2, 3, 0, 3) - thresholdWitnessBytes(2, 3, 0, 2)).toBe(2423);
    // Fewer than m is not a spend at all, and more than n is not a witness.
    expect(() => thresholdWitnessBytes(2, 3, 0, 1)).toThrow(/fills between 2 and 3/);
    expect(() => thresholdWitnessBytes(2, 3, 0, 4)).toThrow(WalletError);
    expect(() => estimateMultisigTxWeight([{ m: 2, n: 3, signatures: 4 }], 2)).toThrow(WalletError);
  });

  it('a heterogeneous input set is the sum of its inputs, not a multiple of one', () => {
    // This is the reason estimateMultisigTxWeight takes the inputs rather than
    // a count: a wallet holding a 2-of-3 and a 3-of-5 coin would be badly
    // under- or over-charged by any single per-input figure. Two inputs, two
    // P2MR outputs throughout.
    const mixed = estimateMultisigTxWeight([{ m: 2, n: 3 }, { m: 3, n: 5 }], 2);
    const perInput = (m: number, n: number) =>
      41 * WITNESS_SCALE_FACTOR + thresholdWitnessBytes(m, n);
    const base = estimateMultisigTxWeight([], 2);
    // 25543, cross-checked against btq-core's serializer for the same two-input
    // transaction.
    expect(mixed).toBe(25_543);
    expect(mixed).toBe(base + perInput(2, 3) + perInput(3, 5));
    // Charging either shape's rate for both is wrong by a real amount: pricing
    // the pair as two 2-of-3s under-collects 5063 WU, i.e. 317 vB of fee.
    const asTwoCheap = estimateMultisigTxWeight([{ m: 2, n: 3 }, { m: 2, n: 3 }], 2);
    const asTwoDear = estimateMultisigTxWeight([{ m: 3, n: 5 }, { m: 3, n: 5 }], 2);
    expect(mixed - asTwoCheap).toBe(5063);
    expect(asTwoDear - mixed).toBe(5063);
    expect(virtualSizeCeil(mixed) - virtualSizeCeil(asTwoCheap)).toBe(317);
  });

  it('feeForMultisigTx charges ceil(weight/16) and enforces the same relay floor', () => {
    // 689 vB is one 2-of-3 input paying two P2MR outputs; the same input paying
    // two P2WPKH outputs is 665 vB, and a fee quoted for one shape does not
    // transfer to the other.
    const weight = estimateMultisigTxWeight([{ m: 2, n: 3 }], 2);
    expect(feeForMultisigTx([{ m: 2, n: 3 }], 2, 1000)).toBe(689n);
    expect(feeForMultisigTx([{ m: 2, n: 3 }], 2)).toBe(689n);
    expect(feeForMultisigTx([{ m: 2, n: 3 }], 2, 5000)).toBe(3445n);
    expect(feeForMultisigTx([{ m: 2, n: 3 }], 2, 1000)).toBe(feeForWeight(weight, 1000));
    // Same guard rails as the single-key path — a multisig send must not be a
    // way around the floor or the typo ceiling.
    for (const rate of [0, 999, MAX_SANE_SAT_PER_KVB + 1]) {
      const call = () => feeForMultisigTx([{ m: 2, n: 3 }], 2, rate);
      expect(call, `rate ${rate}`).toThrow(WalletError);
      let code = 'NO_THROW';
      try {
        call();
      } catch (e) {
        code = e instanceof WalletError ? e.code : 'NOT_A_WALLET_ERROR';
      }
      expect(code, `rate ${rate}`).toBe('BAD_FEE_RATE');
    }
  });

  it('refuses thresholds btq-core would refuse, instead of quoting a fee for them', () => {
    // ParseP2MRDilithiumLeaf (dilithium_leaf.cpp) rejects m < 1, m > n and
    // n > MAX_PUBKEYS_PER_MULTISIG. Quoting a fee for an unspendable shape
    // hides the mistake until the transaction is refused on chain.
    expect(MAX_THRESHOLD_KEYS).toBe(20);
    for (const [m, n] of [
      [0, 3],
      [4, 3],
      [-1, 3],
      [1, 0],
      [1, 21],
      [1.5, 3],
      [1, 3.5],
    ] as const) {
      const call = () => thresholdWitnessBytes(m, n);
      expect(call, `${m}-of-${n}`).toThrow(WalletError);
      let code = 'NO_THROW';
      try {
        call();
      } catch (e) {
        code = e instanceof WalletError ? e.code : 'NOT_A_WALLET_ERROR';
      }
      expect(code, `${m}-of-${n}`).toBe('BAD_PARAMS');
    }
    expect(() => thresholdWitnessBytes(2, 3, -1)).toThrow(/depth/);
    // The low-level counter guards too — it is exported, and a negative or
    // fractional size would otherwise return a silently wrong number.
    expect(() => witnessFieldBytes([2421, -1, 1])).toThrow(WalletError);
    expect(() => witnessFieldBytes([2421, 1.5, 1])).toThrow(WalletError);
    expect(witnessFieldBytes([])).toBe(1);
    expect(() => estimateMultisigTxWeight([{ m: 2, n: 3 }], -1)).toThrow(WalletError);
    expect(() => estimateMultisigTxWeight([{ m: 2, n: 3 }], 1.5)).toThrow(WalletError);
  });

  it('a vsize belongs to a transaction shape, not to an input', () => {
    // The same 2-of-3 input costs 689 vB paying two P2MR outputs and 665 vB
    // paying two P2WPKH ones, because a 31-byte output is 12 bytes smaller than
    // P2MR's 43 and the difference is charged at full weight. Both are right;
    // an unlabelled figure is what turns one into the other's bug. This module
    // models P2MR outputs, so it is the 689 that its callers should see.
    const p2wpkhOutputSize = 8 + 1 + 22; // value + compact script + OP_0 <20>
    expect(P2MR_OUTPUT_SIZE - p2wpkhOutputSize).toBe(12);
    const witness = thresholdWitnessBytes(2, 3);
    const vsizeWith = (outputSize: number, slots = 2): number => {
      const stripped = 4 + 1 + 41 + 1 + 2 * outputSize + 4;
      const w = thresholdWitnessBytes(2, 3, 0, slots);
      return virtualSizeCeil(transactionWeight(stripped, stripped + 2 + w));
    };
    expect(vsizeWith(P2MR_OUTPUT_SIZE)).toBe(689);
    expect(vsizeWith(p2wpkhOutputSize)).toBe(665);
    // The over-signed delta is the same 151 vB under either shape, because it
    // is a witness-only difference.
    expect(vsizeWith(P2MR_OUTPUT_SIZE, 3) - vsizeWith(P2MR_OUTPUT_SIZE)).toBe(151);
    expect(vsizeWith(p2wpkhOutputSize, 3) - vsizeWith(p2wpkhOutputSize)).toBe(151);
    // And the estimator agrees with the P2MR row, which is the shape it models.
    expect(virtualSizeCeil(estimateMultisigTxWeight([{ m: 2, n: 3 }], 2))).toBe(689);
    expect(witness).toBe(8815);
  });

  it('leaves the single-key estimator exactly as it was', () => {
    // fee.ts has callers in coinselect.ts, builder.ts and parse.ts; the
    // threshold work must not have moved a single byte of the shipped path.
    expect(estimateP2mrTxWeight(1, 2)).toBe(5940);
    expect(estimateP2mrTxWeight(1, 1)).toBe(5252);
    expect(estimateP2mrTxWeight(3, 2)).toBe(14744);
    expect(estimateP2mrTxWeight(MAX_P2MR_INPUTS, 1)).toBe(397_030);
    // The compact-size boundary a 253-input sweep would cross is still handled.
    expect(estimateP2mrTxWeight(253, 1) - estimateP2mrTxWeight(252, 1)).toBe(
      41 * WITNESS_SCALE_FACTOR + P2MR_WITNESS_BYTES + 2 * WITNESS_SCALE_FACTOR,
    );
  });
});
