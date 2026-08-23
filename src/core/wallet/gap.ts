/**
 * Gap-limit restore. Bitcoin-style: stop GAP_LIMIT consecutive unused
 * addresses past the last used one. A lookup failure (network / schema) must
 * *not* count as unused — that would hide funds on a flaky explorer — so every
 * rejection propagates and aborts the scan instead of shortening it.
 *
 * The scan is incremental: the caller passes the cursor it stored last time
 * (`startIndex`) and the highest index already known to be used
 * (`lastUsedIndex`), so a wallet with 200 used addresses does not re-query all
 * of them on every refresh. Lookups run with bounded concurrency; a rejection
 * anywhere in a batch rejects the whole scan.
 */
import type { Chain } from '../crypto/hd.js';

export const GAP_LIMIT = 20;
export const GAP_MAX_INDEX = 500;
/**
 * There is deliberately no account-level gap limit here.
 *
 * A scan walks the chains of accounts the user has actually created and nothing
 * else. Probing accounts this device has never heard of would mean asking a
 * public explorer about ~20 addresses per speculative account — addresses with
 * no on-chain relationship to anything — to recover a piece of *metadata* (how
 * many accounts exist) that the wallet should be telling the user to write
 * down. See the note on `Keyring.scan`.
 */
/** Parallel address lookups: enough to hide latency, gentle on the public API. */
export const SCAN_CONCURRENCY = 5;

export interface AddressActivity {
  used: boolean;
  txCount: number;
  /**
   * The explorer's own `balance` field — display-only and NOT trustworthy: the
   * live indexer returns negative balances for busy addresses. Spendable
   * balance is always summed from /utxos and nothing in the send path reads it.
   */
  reportedBalanceSats: bigint;
}

export type AddressLookup = (address: string) => Promise<AddressActivity>;

export interface UsedAddress {
  index: number;
  address: string;
  chain: Chain;
  txCount: number;
  reportedBalanceSats: bigint;
}

export interface ChainScan {
  chain: Chain;
  /** One past the highest used index, old and new together. */
  nextIndex: number;
  /** Used addresses discovered in *this* pass (empty on a no-op refresh). */
  used: UsedAddress[];
  /** Highest index actually queried, to persist as the next cursor. */
  scannedTo: number;
}

export async function scanChain(opts: {
  chain: Chain;
  addressAt: (index: number) => string;
  lookup: AddressLookup;
  gapLimit?: number;
  maxIndex?: number;
  /** First index to query — the cursor stored by the previous scan. */
  startIndex?: number;
  /** Highest index already known to be used, below `startIndex` (-1 if none). */
  lastUsedIndex?: number;
  concurrency?: number;
}): Promise<ChainScan> {
  const gapLimit = opts.gapLimit ?? GAP_LIMIT;
  const maxIndex = opts.maxIndex ?? GAP_MAX_INDEX;
  const concurrency = Math.max(1, opts.concurrency ?? SCAN_CONCURRENCY);
  const start = Math.max(0, Math.min(opts.startIndex ?? 0, maxIndex));

  const used: UsedAddress[] = [];
  let lastUsed = Math.max(-1, opts.lastUsedIndex ?? -1);
  let scannedTo = start - 1;

  // Everything up to `lastUsed + gapLimit` still has to be checked, and a hit
  // inside a batch pushes that horizon out for the next batch.
  let index = start;
  for (;;) {
    const horizon = Math.min(lastUsed + gapLimit, maxIndex - 1);
    if (index > horizon) break;
    const batch: number[] = [];
    for (let i = index; i <= horizon && batch.length < concurrency; i++) batch.push(i);
    const results = await Promise.all(
      batch.map(async (i) => {
        const address = opts.addressAt(i);
        return { i, address, activity: await opts.lookup(address) };
      }),
    );
    for (const r of results) {
      scannedTo = Math.max(scannedTo, r.i);
      if (r.activity.used) {
        used.push({
          index: r.i,
          address: r.address,
          chain: opts.chain,
          txCount: r.activity.txCount,
          reportedBalanceSats: r.activity.reportedBalanceSats,
        });
        lastUsed = Math.max(lastUsed, r.i);
      }
    }
    index = batch[batch.length - 1]! + 1;
  }

  used.sort((a, b) => a.index - b.index);
  return { chain: opts.chain, nextIndex: lastUsed + 1, used, scannedTo };
}
