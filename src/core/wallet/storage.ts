import type { BtqNetwork } from '../script/address.js';
import type { SeedOrigin } from '../vault/payload.js';

export interface WalletMeta {
  network: BtqNetwork;
  origin: SeedOrigin;
  externalNext: number;
  internalNext: number;
  usedExternal: number;
  usedInternal: number;
  lastBalanceSats: string;
}

export interface ActivityItem {
  txid: string;
  status: 'pending' | 'confirmed' | 'signed';
  destination: string;
  amountSats: string;
  feeSats: string;
  hex?: string;
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

export function emptyMeta(network: BtqNetwork, origin: SeedOrigin): WalletMeta {
  return {
    network,
    origin,
    externalNext: 0,
    internalNext: 0,
    usedExternal: 0,
    usedInternal: 0,
    lastBalanceSats: '0',
  };
}
