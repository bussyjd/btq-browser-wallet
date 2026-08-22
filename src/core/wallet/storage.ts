import type { BtqNetwork } from '../script/address.js';
import type { SeedOrigin } from '../vault/payload.js';
import type { BroadcastVia } from './errors.js';

export interface WalletMeta {
  network: BtqNetwork;
  origin: SeedOrigin;
  externalNext: number;
  internalNext: number;
  usedExternal: number;
  usedInternal: number;
  /** Sum of every unspent output the wallet can see, mempool included. */
  lastBalanceSats: string;
  /** Sum of unspent outputs that have a block height — what is safe to rely on. */
  confirmedBalanceSats: string;
  /** Highest index queried per chain: the cursor an incremental scan resumes from. */
  scannedExternal: number;
  scannedInternal: number;
  /** Explorer tip height at the last successful scan (null if never seen). */
  tipHeight: number | null;
  /** ms epoch of the last successful scan. */
  lastScanAt: number | null;
}

export interface ActivityItem {
  txid: string;
  /** 'signed' = this wallet built it but no backend ever accepted it. */
  status: 'pending' | 'confirmed' | 'signed';
  destination: string;
  amountSats: string;
  feeSats: string;
  /** Always kept: a failed broadcast must never lose the only copy of the bytes. */
  hex?: string;
  /** Why the broadcast failed, verbatim from the node or explorer. */
  broadcastError?: string | null;
  broadcastVia?: BroadcastVia;
  /** Outpoints this transaction spends, so a later send cannot re-select them. */
  spends?: string[];
  at: number;
}

export interface WalletStorage {
  loadVault(): Promise<Uint8Array | null>;
  saveVault(blob: Uint8Array): Promise<void>;
  loadMeta(): Promise<WalletMeta | null>;
  saveMeta(meta: WalletMeta): Promise<void>;
  loadOrigins(): Promise<string[]>;
  saveOrigins(origins: string[]): Promise<void>;
  loadPendingConnect(): Promise<{ origin: string } | null>;
  savePendingConnect(pending: { origin: string } | null): Promise<void>;
  loadActivity(): Promise<ActivityItem[]>;
  saveActivity(items: ActivityItem[]): Promise<void>;
  clear(): Promise<void>;
}

const NETWORKS: ReadonlySet<string> = new Set(['mainnet', 'testnet', 'signet', 'regtest']);
const ACTIVITY_STATUS: ReadonlySet<string> = new Set(['pending', 'confirmed', 'signed']);

export function emptyMeta(network: BtqNetwork, origin: SeedOrigin): WalletMeta {
  return {
    network,
    origin,
    externalNext: 0,
    internalNext: 0,
    usedExternal: 0,
    usedInternal: 0,
    lastBalanceSats: '0',
    confirmedBalanceSats: '0',
    scannedExternal: -1,
    scannedInternal: -1,
    tipHeight: null,
    lastScanAt: null,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function counter(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? v : fallback;
}

function satsString(v: unknown): string {
  return typeof v === 'string' && /^-?\d{1,20}$/.test(v) ? v : '0';
}

/**
 * Validate persisted wallet metadata. Storage is attacker-adjacent: anything
 * that can write extension storage could set a huge `externalNext` and make
 * the wallet derive thousands of ML-DSA keys on unlock, or a non-string balance
 * that breaks the popup. Anything unexpected falls back to a fresh record.
 */
export function parseMeta(v: unknown): WalletMeta | null {
  if (!isRecord(v)) return null;
  if (typeof v.network !== 'string' || !NETWORKS.has(v.network)) return null;
  if (v.origin !== 'bip39' && v.origin !== 'raw32') return null;
  return {
    network: v.network as BtqNetwork,
    origin: v.origin,
    externalNext: counter(v.externalNext),
    internalNext: counter(v.internalNext),
    usedExternal: counter(v.usedExternal),
    usedInternal: counter(v.usedInternal),
    lastBalanceSats: satsString(v.lastBalanceSats),
    confirmedBalanceSats: satsString(v.confirmedBalanceSats),
    scannedExternal: counter(v.scannedExternal, -1),
    scannedInternal: counter(v.scannedInternal, -1),
    tipHeight:
      typeof v.tipHeight === 'number' && Number.isInteger(v.tipHeight) && v.tipHeight >= 0 ? v.tipHeight : null,
    lastScanAt: typeof v.lastScanAt === 'number' && Number.isFinite(v.lastScanAt) ? v.lastScanAt : null,
  };
}

/** Validate persisted activity, dropping rows that are not well-formed. */
export function parseActivity(v: unknown): ActivityItem[] {
  if (!Array.isArray(v)) return [];
  const out: ActivityItem[] = [];
  for (const raw of v) {
    if (!isRecord(raw)) continue;
    if (typeof raw.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(raw.txid)) continue;
    if (typeof raw.status !== 'string' || !ACTIVITY_STATUS.has(raw.status)) continue;
    if (typeof raw.destination !== 'string') continue;
    const item: ActivityItem = {
      txid: raw.txid.toLowerCase(),
      status: raw.status as ActivityItem['status'],
      destination: raw.destination,
      amountSats: satsString(raw.amountSats),
      feeSats: satsString(raw.feeSats),
      at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0,
    };
    if (typeof raw.hex === 'string' && /^[0-9a-f]*$/i.test(raw.hex)) item.hex = raw.hex;
    if (typeof raw.broadcastError === 'string') item.broadcastError = raw.broadcastError;
    if (raw.broadcastVia === 'node' || raw.broadcastVia === 'explorer') item.broadcastVia = raw.broadcastVia;
    if (Array.isArray(raw.spends)) {
      item.spends = raw.spends.filter((s): s is string => typeof s === 'string' && /^[0-9a-f]{64}:\d+$/i.test(s));
    }
    out.push(item);
  }
  return out;
}
