import type { BtqNetwork } from '../script/address.js';
import type { SeedOrigin } from '../vault/payload.js';

export interface AccountSummary {
  index: number;
  name: string;
  lastBalanceSats: string;
  address: string | null;
}

/**
 * The one backup this wallet can put on screen — and therefore the one control
 * Settings renders. A wallet sealed from a phrase can show the phrase; a raw-32
 * import and a v1 vault have no phrase to show but do have the HD seed, which
 * restores them just as completely. There is no third state and no "neither":
 * an unlocked vault always has exactly one of these to offer.
 *
 * The names are not the two obvious ones. `phrase` and `seed` are both words in
 * the BIP39 list, and `tests/security/rpc.test.ts` checks every non-reveal
 * result for tokens that match the phrase a wallet just generated — a status
 * whose *value* is a BIP39 word makes that test fail on roughly one run in a
 * hundred against a perfectly correct wallet. The same reason the assertion
 * stopped tokenising key names; these two stay out of the collision set.
 */
export type BackupKind = 'recoveryPhrase' | 'hdSeed';

export interface KeyringStatus {
  hasVault: boolean;
  unlocked: boolean;
  pendingReveal: boolean;
  network: BtqNetwork;
  /**
   * How the seed got here. Taken from the *decrypted payload* while unlocked
   * and only from metadata when locked: `walletMeta()` falls back to
   * `emptyMeta(…, 'bip39')`, which re-stamps a raw32 wallet as bip39, and a
   * later save can persist that lie. Payload origin is the copy nothing but
   * `seal()` has ever written.
   */
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
   * Which backup control to render, or null for "render none" — locked, or no
   * vault at all. The single source of truth about what this wallet can show.
   */
  backup: BackupKind | null;
  /**
   * True only when this vault is unlocked *and* carries BIP39 entropy. False
   * whenever locked, so a locked popup learns nothing about the vault.
   *
   * Derived from `backup`, never computed separately: two independently
   * computed flags are two flags that can disagree, and the one saying "yes"
   * would be the one rendering a control that can only fail.
   */
  canRevealPhrase: boolean;
  /** HD account currently driving receive/send/scan. 0 is the golden path. */
  activeAccount: number;
  accounts: AccountSummary[];
}
