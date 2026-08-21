import { describe, it, expect } from 'vitest';
import vectors from '../vectors/golden.json' with { type: 'json' };
import { hexToBytes } from '../../src/core/util/hex.js';
import { deriveKeySeed, masterFromSeed } from '../../src/core/crypto/hd.js';
import { TX_SIGNATURE_BYTES, SIGHASH_ALL } from '../../src/core/crypto/mldsa.js';
import { singleKeyLeafScript, singleLeafControlBlock } from '../../src/core/script/p2mr.js';
import { planSend, signPlan, assertCanSignLeaf } from '../../src/core/tx/builder.js';
import { selectCoins, type OwnedUtxo } from '../../src/core/tx/coinselect.js';
import { P2MR_INPUT_WEIGHT, estimateP2mrTxWeight, dustThreshold, MAX_P2MR_INPUTS } from '../../src/core/tx/fee.js';
import { serializeStripped, serializeWithWitness } from '../../src/core/tx/serialize.js';
import { transactionWeight } from '../../src/core/tx/fee.js';
import { WalletError } from '../../src/core/wallet/errors.js';

const master = masterFromSeed(hexToBytes(vectors.hdSeedHex));
const e0 = vectors.entries[0]!;
const e1 = vectors.entries[1]!;

function utxo(value: bigint, index = 0): OwnedUtxo {
  const entry = index === 0 ? e0 : e1;
  return {
    txid: '11'.repeat(32),
    vout: index,
    value,
    script: hexToBytes(entry.scriptPubKey),
    address: entry.addresses.testnet,
    chain: 'external',
    index: entry.index,
  };
}

describe('send builder (shipped planSend/signPlan)', () => {
  it('signs a 1-in send to 2421 bytes ending 0x01 and matches scale-16 weight', () => {
    const dest = e1.addresses.testnet;
    const plan = planSend({
      utxos: [utxo(100_000_000n)],
      destination: dest,
      amount: 50_000_000n,
      changeAddress: e0.addresses.testnet,
    });
    const signed = signPlan(plan, (u) => deriveKeySeed(master, u.chain, u.index));
    const sig = signed.tx.inputs[0]!.witness![0]!;
    expect(sig.length).toBe(TX_SIGNATURE_BYTES);
    expect(sig[TX_SIGNATURE_BYTES - 1]).toBe(SIGHASH_ALL);
    expect(signed.tx.inputs[0]!.witness).toHaveLength(3);
    expect(signed.tx.inputs[0]!.witness![2]!.length).toBe(1);

    const stripped = serializeStripped(signed.tx);
    const total = serializeWithWitness(signed.tx);
    const weight = transactionWeight(stripped.length, total.length);
    expect(weight).toBe(signed.weight);
    expect(signed.weight).toBe(estimateP2mrTxWeight(1, 2));
    // Input share of weight is the 4402 WU constant.
    expect(P2MR_INPUT_WEIGHT).toBe(4402);
    expect(signed.hex.length).toBeGreaterThan(100);
    expect(signed.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.destination).toBe(dest);
  });

  it('rejects a mainnet destination on the testnet wallet', () => {
    expect(() =>
      planSend({
        utxos: [utxo(100_000_000n)],
        destination: e0.addresses.mainnet,
        amount: 50_000_000n,
        changeAddress: e0.addresses.testnet,
      }),
    ).toThrow(WalletError);
    try {
      planSend({
        utxos: [utxo(100_000_000n)],
        destination: e0.addresses.mainnet,
        amount: 50_000_000n,
        changeAddress: e0.addresses.testnet,
      });
    } catch (e) {
      expect((e as WalletError).code).toBe('WRONG_NETWORK');
    }
  });

  it('rejects a legacy Dilithium tdbt address', () => {
    expect(() =>
      planSend({
        utxos: [utxo(100_000_000n)],
        destination: 'tdbt1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
        amount: 50_000_000n,
        changeAddress: e0.addresses.testnet,
      }),
    ).toThrow(/tdbt/);
  });

  it('rejects a dust amount before signing', () => {
    expect(() =>
      planSend({
        utxos: [utxo(100_000_000n)],
        destination: e1.addresses.testnet,
        amount: 1n,
        changeAddress: e0.addresses.testnet,
      }),
    ).toThrow(/dust/i);
    expect(dustThreshold()).toBeGreaterThan(1n);
  });

  it('rejects an amount greater than the wallet balance before signing', () => {
    expect(() =>
      planSend({
        utxos: [utxo(10_000n)],
        destination: e1.addresses.testnet,
        amount: 50_000_000n,
        changeAddress: e0.addresses.testnet,
      }),
    ).toThrow(/enough balance/i);
  });

  it('rejects a send that would need more than ~90 P2MR inputs', () => {
    const many: OwnedUtxo[] = Array.from({ length: MAX_P2MR_INPUTS + 1 }, (_, i) => ({
      ...utxo(1_000_000n, 0),
      txid: i.toString(16).padStart(64, '0'),
      vout: i,
    }));
    expect(() => selectCoins(many, 90_000_000n, 1000)).toThrow(/90-input/);
  });

  it('refuses a leaf that does not commit to the witness program', () => {
    const leaf = singleKeyLeafScript(new Uint8Array(1312).fill(7));
    const control = singleLeafControlBlock();
    const program = hexToBytes(e0.merkleRoot);
    expect(() => assertCanSignLeaf(leaf, control, program)).toThrow(/commit/);
  });

  it('signPlan will not sign an injected leaf that fails commitsToProgram', () => {
    const plan = planSend({
      utxos: [utxo(100_000_000n)],
      destination: e1.addresses.testnet,
      amount: 50_000_000n,
      changeAddress: e0.addresses.testnet,
    });
    const leaf = singleKeyLeafScript(new Uint8Array(1312).fill(9));
    expect(() =>
      signPlan(plan, (u) => deriveKeySeed(master, u.chain, u.index), {
        leaf,
        control: singleLeafControlBlock(),
      }),
    ).toThrow(/commit/);
  });
});
