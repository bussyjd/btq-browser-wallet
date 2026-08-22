/**
 * The in-memory chain the mock explorer and the mock node both read.
 *
 * It is deliberately dumb: outpoints, values, scripts and heights. Everything
 * that decides whether a transaction is *acceptable* lives in mock-node.ts, so
 * this file can never accidentally bless a transaction it also produced.
 *
 * Txids are derived from a counter, so two runs of the suite produce the same
 * chain and the same assertions.
 */
import { sha256 } from '@noble/hashes/sha256';
import { scriptHexFor } from './btq-address.js';
import { toHex } from './bip341.js';

export type FaultKind = 'wrong-txid' | 'swap-address' | 'http-500' | 'slow';

export interface LedgerOutput {
  /** The P2MR address this output pays, when the ledger knows one. */
  address: string | null;
  script: string;
  value: bigint;
}

export interface LedgerInput {
  txid: string;
  vout: number;
}

export interface LedgerTx {
  txid: string;
  /** null for the synthetic coinbase-like funding transactions. */
  hex: string | null;
  height: number | null;
  inputs: LedgerInput[];
  outputs: LedgerOutput[];
  coinbase: boolean;
  fee: bigint;
  vsize: number;
  weight: number;
  at: number;
}

export interface LedgerUtxo {
  txid: string;
  vout: number;
  address: string | null;
  script: string;
  value: bigint;
  height: number | null;
  spentBy: string | null;
  spentVin: number | null;
}

export function outpointKey(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

/** The genesis height of the mock chain — near the live testnet tip, for realism. */
export const START_TIP = 300_700;

export class Ledger {
  tip = START_TIP;
  readonly utxos = new Map<string, LedgerUtxo>();
  readonly txs: LedgerTx[] = [];
  private readonly faults = new Set<FaultKind>();
  /** Per-request delay applied while the `slow` fault is on. */
  slowMs = 60;
  /** When on, `/api/v1/address/:a` reports a negative balance like the live indexer. */
  bogusBalance = false;
  private counter = 0;

  hashAt(height: number): string {
    return toHex(sha256(new TextEncoder().encode(`btq-smoke-block:${height}`)));
  }

  private nextTxid(tag: string): string {
    this.counter += 1;
    return toHex(sha256(new TextEncoder().encode(`btq-smoke-${tag}:${this.counter}`)));
  }

  setFault(kind: FaultKind, on = true): void {
    if (on) this.faults.add(kind);
    else this.faults.delete(kind);
  }

  clearFaults(): void {
    this.faults.clear();
  }

  hasFault(kind: FaultKind): boolean {
    return this.faults.has(kind);
  }

  /** A coinbase-like payment into `address`, landing in the mempool. */
  fund(address: string, sats: bigint | number): string {
    const value = BigInt(sats);
    const script = scriptHexFor(address);
    const txid = this.nextTxid('fund');
    const tx: LedgerTx = {
      txid,
      hex: null,
      height: null,
      inputs: [],
      outputs: [{ address, script, value }],
      coinbase: true,
      fee: 0n,
      vsize: 200,
      weight: 3200,
      at: Date.now(),
    };
    this.txs.push(tx);
    this.utxos.set(outpointKey(txid, 0), {
      txid,
      vout: 0,
      address,
      script,
      value,
      height: null,
      spentBy: null,
      spentVin: null,
    });
    return txid;
  }

  /**
   * Record an outpoint that already exists on a real chain (tier 2, where the
   * coins are funded by a live regtest btqd rather than invented here).
   */
  adopt(utxo: { txid: string; vout: number; address: string; script: string; value: bigint; height: number | null }): void {
    this.txs.push({
      txid: utxo.txid,
      hex: null,
      height: utxo.height,
      inputs: [],
      outputs: [{ address: utxo.address, script: utxo.script, value: utxo.value }],
      coinbase: true,
      fee: 0n,
      vsize: 200,
      weight: 3200,
      at: Date.now(),
    });
    this.utxos.set(outpointKey(utxo.txid, utxo.vout), { ...utxo, spentBy: null, spentVin: null });
  }

  /** Advance the tip; the first new block confirms everything in the mempool. */
  mine(blocks = 1): number {
    for (let n = 0; n < blocks; n++) {
      this.tip += 1;
      for (const tx of this.txs) {
        if (tx.height !== null) continue;
        tx.height = this.tip;
        for (let vout = 0; vout < tx.outputs.length; vout++) {
          const utxo = this.utxos.get(outpointKey(tx.txid, vout));
          if (utxo) utxo.height = this.tip;
        }
      }
    }
    return this.tip;
  }

  getTx(txid: string): LedgerTx | undefined {
    return this.txs.find((t) => t.txid === txid);
  }

  unspent(txid: string, vout: number): LedgerUtxo | undefined {
    const u = this.utxos.get(outpointKey(txid, vout));
    return u && u.spentBy === null ? u : undefined;
  }

  /** Apply an accepted transaction: spend its inputs, create its outputs. */
  apply(tx: {
    txid: string;
    hex: string;
    inputs: LedgerInput[];
    outputs: LedgerOutput[];
    fee: bigint;
    vsize: number;
    weight: number;
  }): void {
    tx.inputs.forEach((input, vin) => {
      const utxo = this.utxos.get(outpointKey(input.txid, input.vout));
      if (utxo) {
        utxo.spentBy = tx.txid;
        utxo.spentVin = vin;
      }
    });
    this.txs.push({
      txid: tx.txid,
      hex: tx.hex,
      height: null,
      inputs: tx.inputs,
      outputs: tx.outputs,
      coinbase: false,
      fee: tx.fee,
      vsize: tx.vsize,
      weight: tx.weight,
      at: Date.now(),
    });
    tx.outputs.forEach((o, vout) => {
      this.utxos.set(outpointKey(tx.txid, vout), {
        txid: tx.txid,
        vout,
        address: o.address,
        script: o.script,
        value: o.value,
        height: null,
        spentBy: null,
        spentVin: null,
      });
    });
  }

  /** Every unspent output paying `address`, oldest first. */
  unspentFor(address: string): LedgerUtxo[] {
    return [...this.utxos.values()].filter((u) => u.address === address && u.spentBy === null);
  }

  /** Every output paying `address`, spent or not — used for tx_count/history. */
  private touching(address: string): LedgerTx[] {
    return this.txs.filter((tx) => {
      if (tx.outputs.some((o) => o.address === address)) return true;
      return tx.inputs.some((i) => this.utxos.get(outpointKey(i.txid, i.vout))?.address === address);
    });
  }

  activityFor(address: string): { txCount: number; balance: bigint; unspentCount: number } {
    const balance = this.unspentFor(address).reduce((n, u) => n + u.value, 0n);
    const unspent = this.unspentFor(address);
    return { txCount: this.touching(address).length, balance, unspentCount: unspent.length };
  }

  /** `/txs` rows: signed value change for this address, newest first. */
  historyFor(address: string): { txid: string; blockHeight: number | null; valueChange: bigint; txIndex: number }[] {
    return this.touching(address)
      .map((tx, txIndex) => {
        let change = 0n;
        for (const o of tx.outputs) if (o.address === address) change += o.value;
        for (const i of tx.inputs) {
          const prev = this.utxos.get(outpointKey(i.txid, i.vout));
          if (prev?.address === address) change -= prev.value;
        }
        return { txid: tx.txid, blockHeight: tx.height, valueChange: change, txIndex };
      })
      .reverse();
  }
}
