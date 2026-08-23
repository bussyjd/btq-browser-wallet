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
   * Which backup control Settings renders: the recovery phrase for a vault
   * sealed from one, the HD seed for the wallet that has none — a raw-32
   * import — and `null` for "render no control at all", which is locked or no
   * vault.
   *
   * Optional, and absent means *unknown*, not "seed": an older worker omits
   * this field and has no `wallet.revealSeedHex` to call, so the UI falls back
   * to `canRevealPhrase` and otherwise offers nothing. Never render a control
   * whose only possible outcome is an error.
   */
  backup?: BackupKind | null;
  /**
   * True only when the vault is unlocked and holds a phrase this build can read
   * back. Optional: an older worker omits it, which the UI must read as "no",
   * so gate on `=== true` and never on `!== false`.
   *
   * The worker derives this from `backup`; the two cannot disagree.
   */
  canRevealPhrase?: boolean;
  /** HD account currently driving receive/send/scan. Optional for older workers. */
  activeAccount?: number;
  accounts?: AccountInfo[];
}

/**
 * The one backup an unlocked wallet can put on screen. Mirrors the worker's,
 * including the deliberately unobvious spelling — `phrase` and `seed` are both
 * BIP39 words, and a status value that is one makes a security assertion in
 * `tests/security/rpc.test.ts` collide with a freshly generated mnemonic.
 */
export type BackupKind = 'recoveryPhrase' | 'hdSeed';

export interface AccountInfo {
  index: number;
  name: string;
  lastBalanceSats: string;
  /**
   * ms epoch the balance was last read from the chain; null for never, absent
   * from a worker older than this popup. Only the active account is refreshed
   * by a routine scan, so the switcher renders this age next to every other
   * row rather than presenting an old number as a current one.
   */
  balanceAt?: number | null;
  address: string | null;
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
  account?: number;
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

/**
 * The result of `wallet.revealSeedHex` — the 64-character HD seed of a wallet
 * that has no phrase to show, after the password is re-typed on an unlocked
 * vault. Key material, handled exactly like `PhraseReveal`: rendered by one
 * screen, never put in `useWallet` state, never persisted, never copied to the
 * clipboard.
 */
export interface SeedReveal {
  seedHex: string;
}

/**
 * The result of `wallet.exportBackup` — the wallet backup file, as the sealed
 * `BTQ1` envelope in hex plus the name to offer the download under.
 *
 * Not secret material, and that distinction is the whole design: the phrase and
 * the seed are *revealed* on one screen and never written anywhere, while this
 * is ciphertext under the password the user just re-typed, which is why it may
 * become a file at all. It is still the whole wallet, so the popup turns it
 * straight into a download and keeps no copy — nothing puts it in hook state.
 */
export interface BackupFile {
  /** Carries no address, no account name and no balance. See `backupFileName`. */
  fileName: string;
  /** The sealed blob, hex-encoded: `chrome.runtime.sendMessage` is JSON. */
  backupHex: string;
}

/** The result of `wallet.importBackup` — the account indices it put back. */
export interface BackupRestore {
  ok: true;
  accounts: number[];
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

/**
 * One approval, as the worker stores it: this site may see *this* account's
 * address and no other. Switching to an account a site was not approved for
 * gets the site `accountsChanged([])`, not a new address.
 */
export interface SiteGrant {
  origin: string;
  account: number;
}

export interface ConnectedSites {
  /** Flat list of sites holding any grant. Kept for a popup older than the worker. */
  origins: string[];
  /**
   * One row per (origin, account). Optional: a worker older than this popup
   * omits it, and the UI then reads every grant as account 0 — which is what
   * such a worker's grants actually were.
   */
  sites?: SiteGrant[];
}

/** Fee presets the popup offers, in sat/kvB (the contract's unit). */
export const FEE_PRESETS = [
  { id: 'economy', label: 'Economy', satPerKvB: 1000 },
  { id: 'normal', label: 'Normal', satPerKvB: 2000 },
  { id: 'priority', label: 'Priority', satPerKvB: 5000 },
] as const;

export type FeePresetId = (typeof FEE_PRESETS)[number]['id'];
