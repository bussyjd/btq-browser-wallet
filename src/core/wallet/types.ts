import type { BtqNetwork } from '../script/address.js';
import type { SeedOrigin } from '../vault/payload.js';

export interface KeyringStatus {
  hasVault: boolean;
  unlocked: boolean;
  pendingReveal: boolean;
  network: BtqNetwork;
  origin: SeedOrigin | null;
  externalNext: number;
  internalNext: number;
  usedExternal: number;
  usedInternal: number;
  lastBalanceSats: string;
}
