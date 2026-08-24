import type { BtqNetwork } from '../script/address.js';
import type { SeedOrigin } from '../vault/payload.js';
import type { BroadcastVia } from './errors.js';

/** HD accounts this wallet will derive. Caps a storage-wedge of huge indices. */
export const MAX_ACCOUNTS = 20;
export const ACCOUNT_NAME_MAX = 32;
/**
 * Rows the activity log keeps. The writer has always trimmed to this; the
 * *reader* enforces it too, because the writer is not the only thing that can
 * put rows in extension storage, and a reader that walks every row it is handed
 * is a wedge anybody can widen (see `parseMeta` on why storage is hostile).
 */
export const MAX_ACTIVITY = 50;

/**
 * One HD account: path prefix m/k'/{0,1}'/n'. Index 0 is btq-core's legacy
 * account and the golden-vector path. Extra accounts are this wallet's, not
 * a Core RPC concept.
 */
export interface AccountRecord {
  index: number;
  name: string;
  externalNext: number;
  internalNext: number;
  usedExternal: number;
  usedInternal: number;
  lastBalanceSats: string;
  confirmedBalanceSats: string;
  scannedExternal: number;
  scannedInternal: number;
  /**
   * ms epoch at which `lastBalanceSats` was last computed from the chain, or
   * null for "never checked". Per account, because a routine refresh now scans
   * only the active one: without this the switcher would print a number from
   * some earlier session next to a name and let the user believe it is current.
   * The switcher renders the age beside the balance rather than hiding it.
   */
  balanceAt: number | null;
  /** Cached current receive address. Public; display only. */
  address: string | null;
}

export interface WalletMeta {
  network: BtqNetwork;
  origin: SeedOrigin;
  /**
   * Cursor/balance of the *active* account, mirrored so older readers and the
   * status contract keep working. The per-account records in `accounts` are
   * the source of truth.
   */
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
  accounts: AccountRecord[];
  activeAccount: number;
  /**
   * The phrase-confirmation challenge still outstanding: 0-based positions in
   * the recovery phrase the user has been asked to type back, or `null` once
   * they have passed it or explicitly left it.
   *
   * It lives here, in cleartext metadata, because the vault is sealed at
   * `create` time and the challenge is a *gate over a wallet that already
   * exists* — it has to survive the service worker being torn down while the
   * user is writing the words on paper, which is the one thing an in-memory
   * field cannot do. Positions are not secret: they say which three of the
   * twelve will be asked for, never what any of them is, and the words
   * themselves are only ever regenerated from the sealed entropy behind the
   * password. Anything an attacker writes here can at worst *clear* the
   * reminder (`parseConfirmChallenge` refuses everything else); it can never
   * unlock, grant, or seal anything.
   */
  confirmChallenge: number[] | null;
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
  /** HD account that produced this send. Missing on pre-account rows = 0. */
  accountIndex?: number;
  /**
   * The internal (change) index this send paid change to; absent when it had no
   * change output. It is what lets a full rescan tell "the chain has not
   * indexed our change yet" apart from "this cursor is simply wrong", and it is
   * only ever *believed* when `hex` pays the address the seed derives at that
   * index — see `Keyring.inFlightChangeNext`. A number on its own proves
   * nothing: whatever can write this row can write this number.
   */
  changeIndex?: number;
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

export function defaultAccountName(index: number): string {
  return `Account ${index + 1}`;
}

export function emptyAccount(index: number): AccountRecord {
  return {
    index,
    name: defaultAccountName(index),
    externalNext: 0,
    internalNext: 0,
    usedExternal: 0,
    usedInternal: 0,
    lastBalanceSats: '0',
    confirmedBalanceSats: '0',
    scannedExternal: -1,
    scannedInternal: -1,
    balanceAt: null,
    address: null,
  };
}

export function emptyMeta(
  network: BtqNetwork,
  origin: SeedOrigin,
  confirmChallenge: number[] | null = null,
): WalletMeta {
  const account = emptyAccount(0);
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
    accounts: [account],
    activeAccount: 0,
    confirmChallenge,
  };
}

/**
 * Guarantee a non-empty accounts list. An older meta written before extra
 * accounts existed becomes account 0, keeping its cursors.
 */
export function ensureAccounts(meta: WalletMeta): WalletMeta {
  if (!Array.isArray(meta.accounts) || meta.accounts.length === 0) {
    const rec = emptyAccount(0);
    rec.externalNext = meta.externalNext;
    rec.internalNext = meta.internalNext;
    rec.usedExternal = meta.usedExternal;
    rec.usedInternal = meta.usedInternal;
    rec.lastBalanceSats = meta.lastBalanceSats;
    rec.confirmedBalanceSats = meta.confirmedBalanceSats;
    rec.scannedExternal = meta.scannedExternal;
    rec.scannedInternal = meta.scannedInternal;
    rec.balanceAt = meta.lastScanAt;
    meta.accounts = [rec];
    meta.activeAccount = 0;
  }
  if (!meta.accounts.some((a) => a.index === meta.activeAccount)) {
    meta.activeAccount = meta.accounts[0]!.index;
  }
  return meta;
}

export function activeRecord(meta: WalletMeta): AccountRecord {
  const found = meta.accounts.find((a) => a.index === meta.activeAccount);
  if (found) return found;
  const first = meta.accounts[0];
  if (first) {
    meta.activeAccount = first.index;
    return first;
  }
  const created = emptyAccount(0);
  meta.accounts = [created];
  meta.activeAccount = 0;
  return created;
}

/** Copy the active account's cursors and balance onto the top-level fields. */
export function mirrorActive(meta: WalletMeta): WalletMeta {
  const rec = activeRecord(meta);
  meta.activeAccount = rec.index;
  meta.externalNext = rec.externalNext;
  meta.internalNext = rec.internalNext;
  meta.usedExternal = rec.usedExternal;
  meta.usedInternal = rec.usedInternal;
  meta.lastBalanceSats = rec.lastBalanceSats;
  meta.confirmedBalanceSats = rec.confirmedBalanceSats;
  meta.scannedExternal = rec.scannedExternal;
  meta.scannedInternal = rec.scannedInternal;
  return meta;
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
 * Everything invisible that can reorder or hide what the chrome renders.
 *
 * `Cc` is the C0/C1 range and DEL. `Cf` is the format class, which is where the
 * bidi overrides live: U+202E turns "Payroll<RLO>gpj.exe" into something that
 * reads backwards next to a real address, and U+200B/U+FEFF pad a name with
 * width the user cannot see. `Zl`/`Zp` are the line and paragraph separators —
 * U+2028 ends a line inside what is supposed to be one row. An account name is
 * the only attacker-writable string this UI renders, so none of them survive.
 */
const NAME_CONTROLS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function parseAccountName(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const name = v.replace(NAME_CONTROLS, '').trim();
  if (name.length === 0) return fallback;
  // Sliced by code point, not by UTF-16 unit: `slice` on a string of astral
  // characters can cut an emoji in half and store a lone surrogate, which is
  // not a string the UI (or JSON) can round-trip.
  return [...name].slice(0, ACCOUNT_NAME_MAX).join('');
}

/** ms epoch, or null for "never". Anything else is not a time this UI can print. */
function msEpoch(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function parseCachedAddress(v: unknown): string | null {
  return typeof v === 'string' && v.length >= 20 && v.length <= 128 ? v : null;
}

function parseAccountRecord(v: unknown): AccountRecord | null {
  if (!isRecord(v)) return null;
  const index = counter(v.index, -1);
  if (index < 0 || index >= MAX_ACCOUNTS) return null;
  return {
    index,
    name: parseAccountName(v.name, defaultAccountName(index)),
    externalNext: counter(v.externalNext),
    internalNext: counter(v.internalNext),
    usedExternal: counter(v.usedExternal),
    usedInternal: counter(v.usedInternal),
    lastBalanceSats: satsString(v.lastBalanceSats),
    confirmedBalanceSats: satsString(v.confirmedBalanceSats),
    scannedExternal: counter(v.scannedExternal, -1),
    scannedInternal: counter(v.scannedInternal, -1),
    balanceAt: msEpoch(v.balanceAt),
    address: parseCachedAddress(v.address),
  };
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

  // Which account the top-level cursors belong to. They are a mirror of the
  // *active* account, so a meta that names one is telling us whose they are.
  const activeWanted =
    typeof v.activeAccount === 'number' &&
    Number.isInteger(v.activeAccount) &&
    v.activeAccount >= 0 &&
    v.activeAccount < MAX_ACCOUNTS
      ? v.activeAccount
      : 0;

  const mirrored = emptyAccount(activeWanted);
  mirrored.externalNext = counter(v.externalNext);
  mirrored.internalNext = counter(v.internalNext);
  mirrored.usedExternal = counter(v.usedExternal);
  mirrored.usedInternal = counter(v.usedInternal);
  mirrored.lastBalanceSats = satsString(v.lastBalanceSats);
  mirrored.confirmedBalanceSats = satsString(v.confirmedBalanceSats);
  mirrored.scannedExternal = counter(v.scannedExternal, -1);
  mirrored.scannedInternal = counter(v.scannedInternal, -1);
  // The mirror is the active account's balance and `lastScanAt` is when the
  // scan that produced it ran, so that is honestly its age. A meta written
  // before this field existed still gets a truthful timestamp this way.
  mirrored.balanceAt = msEpoch(v.lastScanAt);
  mirrored.address = parseCachedAddress(v.address);

  const accounts: AccountRecord[] = [];
  const seen = new Set<number>();
  if (Array.isArray(v.accounts)) {
    for (const raw of v.accounts) {
      if (accounts.length >= MAX_ACCOUNTS) break;
      const rec = parseAccountRecord(raw);
      if (!rec || seen.has(rec.index)) continue;
      seen.add(rec.index);
      accounts.push(rec);
    }
  }
  if (accounts.length === 0) {
    // No list at all: a meta written before extra accounts existed, or one a
    // rollback build round-tripped and stripped. The cursors it does carry
    // belong to whichever account was active — handing them to account 0 when
    // the mirror is account 2's shows account 0 a balance that is not its own
    // and re-derives the wrong receive address. So the mirror stays with its
    // owner and account 0, if that is not it, comes back empty and rescans.
    accounts.push(mirrored);
    if (mirrored.index !== 0) accounts.push(emptyAccount(0));
    seen.add(mirrored.index);
    seen.add(0);
  } else if (!seen.has(0)) {
    // A poisoned list that omits account 0 would hide the golden-path coins
    // and, with nextIndex already at MAX_ACCOUNTS, block adding it back.
    accounts.push(emptyAccount(0));
  }
  accounts.sort((a, b) => a.index - b.index);

  const activeAccount = accounts.some((a) => a.index === activeWanted) ? activeWanted : accounts[0]!.index;

  return mirrorActive({
    network: v.network as BtqNetwork,
    origin: v.origin,
    externalNext: mirrored.externalNext,
    internalNext: mirrored.internalNext,
    usedExternal: mirrored.usedExternal,
    usedInternal: mirrored.usedInternal,
    lastBalanceSats: mirrored.lastBalanceSats,
    confirmedBalanceSats: mirrored.confirmedBalanceSats,
    scannedExternal: mirrored.scannedExternal,
    scannedInternal: mirrored.scannedInternal,
    tipHeight:
      typeof v.tipHeight === 'number' && Number.isInteger(v.tipHeight) && v.tipHeight >= 0 ? v.tipHeight : null,
    lastScanAt: msEpoch(v.lastScanAt),
    accounts,
    activeAccount,
    confirmChallenge: parseConfirmChallenge(v.confirmChallenge),
  });
}

/** Positions past this are not in any phrase this build seals. */
const MAX_PHRASE_WORDS = 24;
/** And a challenge longer than this is not one this build ever wrote. */
const MAX_CHALLENGE_WORDS = 8;

/**
 * Validate a stored confirmation challenge.
 *
 * Every rejection collapses to `null`, "nothing outstanding", and that is the
 * safe direction on purpose: the worst a hand-written record can do is drop the
 * reminder to confirm a phrase whose wallet is already sealed and whose words
 * Settings can still show. The opposite fail-open — trusting a list of
 * positions — would let stored bytes decide which words `confirm` checks.
 */
export function parseConfirmChallenge(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_CHALLENGE_WORDS) return null;
  const out: number[] = [];
  for (const raw of v) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw >= MAX_PHRASE_WORDS) return null;
    if (out.includes(raw)) return null;
    out.push(raw);
  }
  return out.sort((a, b) => a - b);
}

/** Validate persisted activity, dropping rows that are not well-formed. */
export function parseActivity(v: unknown): ActivityItem[] {
  if (!Array.isArray(v)) return [];
  const out: ActivityItem[] = [];
  for (const raw of v) {
    if (out.length >= MAX_ACTIVITY) break;
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
    if (
      typeof raw.accountIndex === 'number' &&
      Number.isInteger(raw.accountIndex) &&
      raw.accountIndex >= 0 &&
      raw.accountIndex < MAX_ACCOUNTS
    ) {
      item.accountIndex = raw.accountIndex;
    } else {
      item.accountIndex = 0;
    }
    // Bounded like every other counter here — but the bound is not what makes
    // it safe to act on. `inFlightChangeNext` checks the claim against the
    // row's own signed bytes before it lets the index hold a cursor up.
    const changeIndex = counter(raw.changeIndex, -1);
    if (changeIndex >= 0) item.changeIndex = changeIndex;
    out.push(item);
  }
  return out;
}
