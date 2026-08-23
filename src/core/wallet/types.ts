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
  /** Sum of unspent outputs across derived addresses, mempool included. */
  lastBalanceSats: string;
  /** Sum of unspent outputs with a block height. */
  confirmedBalanceSats: string;
  /** Explorer tip height seen at the last scan, null when never scanned. */
  tipHeight: number | null;
  /** ms epoch of the last successful scan. */
  lastScanAt: number | null;
  /**
   * True only when this vault is unlocked *and* carries BIP39 entropy. False
   * whenever locked, so a locked popup learns nothing about the vault.
   */
  canRevealPhrase: boolean;
}
