import { WalletError } from '../wallet/errors.js';
import { dustThreshold, estimateP2mrTxWeight, feeForP2mrTx, MAX_P2MR_INPUTS, MIN_RELAY_SAT_PER_KVB } from './fee.js';
import type { Chain } from '../crypto/hd.js';

export interface OwnedUtxo {
  txid: string;
  vout: number;
  value: bigint;
  script: Uint8Array;
  address: string;
  chain: Chain;
  index: number;
}

export interface CoinSelection {
  inputs: OwnedUtxo[];
  fee: bigint;
  change: bigint;
  outputCount: number;
  weight: number;
}

/**
 * Largest-first selection. Fee is recomputed as inputs are added (scale-16).
 * Change below dust is added to the fee (no change output).
 */
export function selectCoins(
  utxos: OwnedUtxo[],
  amount: bigint,
  satPerKvB = MIN_RELAY_SAT_PER_KVB,
): CoinSelection {
  if (amount <= 0n) throw new WalletError('DUST', 'Send amount must be positive.');
  if (amount < dustThreshold()) {
    throw new WalletError('DUST', `Amount is below the dust threshold (${dustThreshold()} sats).`);
  }
  const sorted = [...utxos].filter((u) => u.value > 0n).sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
  if (sorted.length === 0) throw new WalletError('INSUFFICIENT', 'No coins to spend.');

  let selected: OwnedUtxo[] = [];
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
          fee: total - amount, // leftover folded into fee
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
