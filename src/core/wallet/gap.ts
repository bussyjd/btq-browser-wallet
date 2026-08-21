/**
 * Gap-limit restore. Bitcoin-style: stop after GAP_LIMIT consecutive unused
 * addresses. A lookup failure (network / schema) must *not* count as unused —
 * that would hide funds on a flaky explorer.
 */
import type { Chain } from '../crypto/hd.js';

export const GAP_LIMIT = 20;
export const GAP_MAX_INDEX = 500;

export interface AddressActivity {
  used: boolean;
  txCount: number;
  balanceSats: bigint;
}

export type AddressLookup = (address: string) => Promise<AddressActivity>;

export interface UsedAddress {
  index: number;
  address: string;
  chain: Chain;
  txCount: number;
  balanceSats: bigint;
}

export interface ChainScan {
  chain: Chain;
  nextIndex: number;
  used: UsedAddress[];
}

export async function scanChain(opts: {
  chain: Chain;
  addressAt: (index: number) => string;
  lookup: AddressLookup;
  gapLimit?: number;
  maxIndex?: number;
}): Promise<ChainScan> {
  const gapLimit = opts.gapLimit ?? GAP_LIMIT;
  const maxIndex = opts.maxIndex ?? GAP_MAX_INDEX;
  const used: UsedAddress[] = [];
  let consecutiveUnused = 0;
  let lastUsed = -1;

  for (let index = 0; index < maxIndex && consecutiveUnused < gapLimit; index++) {
    const address = opts.addressAt(index);
    const activity = await opts.lookup(address);
    if (activity.used) {
      used.push({
        index,
        address,
        chain: opts.chain,
        txCount: activity.txCount,
        balanceSats: activity.balanceSats,
      });
      lastUsed = index;
      consecutiveUnused = 0;
    } else {
      consecutiveUnused += 1;
    }
  }

  return { chain: opts.chain, nextIndex: lastUsed + 1, used };
}

export function totalBalanceSats(scans: ChainScan[]): bigint {
  let sum = 0n;
  for (const s of scans) {
    for (const u of s.used) sum += u.balanceSats;
  }
  return sum;
}
