import { WalletError } from '../wallet/errors.js';
import {
  assertFeeRate,
  dustThreshold,
  estimateP2mrTxWeight,
  feeForP2mrTx,
  MAX_P2MR_INPUTS,
  MIN_RELAY_SAT_PER_KVB,
} from './fee.js';
import type { Chain } from '../crypto/hd.js';

export interface OwnedUtxo {
  txid: string;
  vout: number;
  value: bigint;
  script: Uint8Array;
  address: string;
  chain: Chain;
  index: number;
  /** null while the coin is only in the mempool. Confirmed coins are spent first. */
  blockHeight?: number | null;
}

export interface CoinSelection {
  inputs: OwnedUtxo[];
  fee: bigint;
  change: bigint;
  outputCount: number;
  weight: number;
}

export function outpointKey(u: { txid: string; vout: number }): string {
  return `${u.txid}:${u.vout}`;
}

/**
 * Confirmed coins first (an unconfirmed parent can still be replaced), then
 * largest-first so a send needs as few 275 vB inputs as possible.
 */
function spendOrder(utxos: readonly OwnedUtxo[]): OwnedUtxo[] {
  return [...utxos]
    .filter((u) => u.value > 0n)
    .sort((a, b) => {
      const ac = a.blockHeight != null ? 0 : 1;
      const bc = b.blockHeight != null ? 0 : 1;
      if (ac !== bc) return ac - bc;
      return a.value < b.value ? 1 : a.value > b.value ? -1 : 0;
    });
}

/**
 * Largest-first selection. Fee is recomputed as inputs are added (scale-16).
 * Change below the node's 270-sat dust threshold is folded into the fee,
 * because the node would refuse that output outright.
 */
export function selectCoins(
  utxos: readonly OwnedUtxo[],
  amount: bigint,
  satPerKvB = MIN_RELAY_SAT_PER_KVB,
): CoinSelection {
  assertFeeRate(satPerKvB);
  if (amount <= 0n) throw new WalletError('DUST', 'Send amount must be positive.');
  if (amount < dustThreshold()) {
    throw new WalletError('DUST', `Amount is below the dust threshold (${dustThreshold()} sats).`);
  }
  const sorted = spendOrder(utxos);
  if (sorted.length === 0) throw new WalletError('INSUFFICIENT', 'No coins to spend.');

  const selected: OwnedUtxo[] = [];
  let total = 0n;
  for (const u of sorted) {
    if (selected.length >= MAX_P2MR_INPUTS) {
      throw new WalletError('TOO_MANY_INPUTS', 'This send would exceed the ~90-input standardness ceiling.');
    }
    selected.push(u);
    total += u.value;

    const withChangeFee = feeForP2mrTx(selected.length, 2, satPerKvB);
    if (total >= amount + withChangeFee) {
      const change = total - amount - withChangeFee;
      if (change >= dustThreshold()) {
        return {
          inputs: selected,
          fee: withChangeFee,
          change,
          outputCount: 2,
          weight: estimateP2mrTxWeight(selected.length, 2),
        };
      }
      const noChangeFee = feeForP2mrTx(selected.length, 1, satPerKvB);
      if (total >= amount + noChangeFee) {
        return {
          inputs: selected,
          fee: total - amount, // leftover below dust folded into the fee
          change: 0n,
          outputCount: 1,
          weight: estimateP2mrTxWeight(selected.length, 1),
        };
      }
    }
  }

  if (selected.length >= MAX_P2MR_INPUTS && total < amount + feeForP2mrTx(MAX_P2MR_INPUTS, 1, satPerKvB)) {
    throw new WalletError('TOO_MANY_INPUTS', 'This send would exceed the ~90-input standardness ceiling.');
  }
  throw new WalletError('INSUFFICIENT', 'Not enough balance to cover the amount and fee.');
}

/**
 * Largest amount that can leave the wallet in one no-change output at this fee
 * rate, using at most MAX_P2MR_INPUTS coins. Returns amount 0n when nothing is
 * spendable, which the popup renders as a disabled "Max".
 */
export function maxSpendable(
  utxos: readonly OwnedUtxo[],
  satPerKvB = MIN_RELAY_SAT_PER_KVB,
): { amount: bigint; fee: bigint; inputs: OwnedUtxo[] } {
  assertFeeRate(satPerKvB);
  const sorted = spendOrder(utxos).slice(0, MAX_P2MR_INPUTS);
  let best = { amount: 0n, fee: 0n, inputs: [] as OwnedUtxo[] };
  let total = 0n;
  for (let n = 1; n <= sorted.length; n++) {
    total += sorted[n - 1]!.value;
    const fee = feeForP2mrTx(n, 1, satPerKvB);
    const amount = total - fee;
    // Adding a 275 vB input loses money when the coin is small — keep the best.
    if (amount > best.amount && amount >= dustThreshold()) {
      best = { amount, fee, inputs: sorted.slice(0, n) };
    }
  }
  return best;
}
