/**
 * The popup's view of the service-worker RPC contract (v2).
 *
 * Declared once here so no screen re-derives a result shape inline. Fields the
 * service worker only gained in v2 are optional: an older worker simply omits
 * them and the UI renders that as "unknown" rather than breaking.
 *
 * This file deliberately mirrors the contract with plain structural types — the
 * popup never imports keyring, vault or HD helpers (enforced by
 * tests/security/source-boundary.test.ts).
 */

export interface WalletStatus {
  hasVault: boolean;
  unlocked: boolean;
  pendingReveal: boolean;
  network: string;
  origin: string | null;
  externalNext: number;
  internalNext: number;
  usedExternal: number;
  usedInternal: number;
  /** Sum of unspent outputs across derived addresses, mempool included. */
  lastBalanceSats: string;
  /** Sum of outputs already in a block. */
  confirmedBalanceSats?: string | null;
  /** Explorer tip height seen at the last scan. */
  tipHeight?: number | null;
  /** ms epoch of the last successful scan. */
  lastScanAt?: number | null;
  /**
   * True only when the vault is unlocked and holds a phrase this build can read
   * back. Optional: an older worker omits it, which the UI must read as "no",
   * so gate on `=== true` and never on `!== false`.
   */
  canRevealPhrase?: boolean;
}

export interface ScanResult {
  externalNext: number;
  internalNext: number;
  usedExternal: number;
  usedInternal: number;
  lastBalanceSats: string;
  confirmedBalanceSats?: string | null;
  tipHeight?: number | null;
  lastScanAt?: number | null;
}

export interface ReceiveInfo {
  address: string;
  path: string;
  index: number;
  chain?: string;
  network?: string;
}

export interface CreateReveal {
  mnemonic: string;
  /** 0-based positions in the phrase the user has to type back. */
  challenge: number[];
}

/**
 * The result of `wallet.revealPhrase` — the recovery phrase, already split, for
 * a wallet that is unlocked and whose password was just re-typed. It is the one
 * result besides the onboarding reveal that carries secret material, so it is
 * rendered and dropped: never stored in `useWallet` state, never persisted.
 */
export interface PhraseReveal {
  words: string[];
}

export interface SendPreview {
  destination: string;
  /** satoshis, decimal string */
  amount: string;
  fee: string;
  change: string;
  inputs: number;
  feeRateSatPerKvB?: number;
  vsize?: number;
  weight?: number;
}

export interface MaxSpendable {
  amountSats: string;
  fee: string;
  inputs: number;
}

export type BroadcastStatus = 'pending' | 'signed';

export interface SendResult {
  txid: string;
  hex: string;
  fee: string;
  amount: string;
  destination: string;
  change?: string;
  weight?: number;
  vsize?: number;
  inputs?: { txid: string; vout: number; value: string; address: string }[];
  outputs?: { address: string; value: string }[];
  broadcastStatus: BroadcastStatus;
  /** Why the broadcast failed, when broadcastStatus is 'signed'. */
  broadcastError?: string | null;
  broadcastVia?: 'node' | 'explorer' | null;
}

export type HistoryStatus = 'pending' | 'confirmed' | 'signed';

export interface HistoryEntry {
  txid: string;
  blockHeight: number | null;
  /** signed satoshi delta for this wallet, decimal string */
  valueChange: string;
  status: HistoryStatus;
  confirmations?: number | null;
  /** local ms epoch, only for wallet-originated transactions */
  at?: number;
}

export interface TipInfo {
  height: number;
  hash: string;
}

export interface BackendInfo {
  explorerBase: string;
  nodeUrl: string | null;
  nodeUser: string | null;
  hasNodePassword: boolean;
}

export interface BackendProbe {
  explorer: string;
  explorerTip?: number;
  node?: { chain: string; blocks: number; bestblockhash?: string };
  warning?: string;
}

export interface PendingConnect {
  origin: string;
}

export interface ConnectedSites {
  origins: string[];
}

/** Fee presets the popup offers, in sat/kvB (the contract's unit). */
export const FEE_PRESETS = [
  { id: 'economy', label: 'Economy', satPerKvB: 1000 },
  { id: 'normal', label: 'Normal', satPerKvB: 2000 },
  { id: 'priority', label: 'Priority', satPerKvB: 5000 },
] as const;

export type FeePresetId = (typeof FEE_PRESETS)[number]['id'];
