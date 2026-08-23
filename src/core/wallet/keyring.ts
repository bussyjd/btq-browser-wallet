/**
 * In-memory keyring. The HD seed lives here only while unlocked.
 *
 * Persistence is the AES-GCM vault blob. The phrase itself is never stored —
 * what a v2 vault holds is its 16- or 32-byte BIP39 *entropy*, sealed in the
 * same ciphertext as the HD seed it derives, so `revealPhrase` can regenerate
 * the words behind the password and prove they re-derive this wallet. Nothing
 * is held in the clear, and no mnemonic string is ever kept on this object: a
 * JS string cannot be zeroed, so caching one would be strictly worse than
 * regenerating it and letting go.
 */
import type { BtqNetwork } from '../script/address.js';
import type { Chain } from '../crypto/hd.js';
import {
  assertPassword,
  entropyToMnemonic,
  generateMnemonic,
  mnemonicToEntropy,
  mnemonicToHdSeed,
  parseMnemonic,
  parseRawSeedHex,
  pickChallengeIndices,
} from '../crypto/mnemonic.js';
import { encryptVault, decryptVault, wipePlaintext, type EncryptOptions } from '../vault/encrypt.js';
import { decodePayload, encodePayload, type SeedOrigin, type VaultPayload } from '../vault/payload.js';
import { bytesToHex, hexToBytes, wipeBytes } from '../util/hex.js';
import { BroadcastError, WalletError, type BroadcastVia } from './errors.js';
import { deriveKeySeed, masterFromSeed } from '../crypto/hd.js';
import { scriptForAddress } from '../script/address.js';
import { addressFromHdSeed, type DerivedAddress } from './derive.js';
import { ACCOUNT_GAP_LIMIT, scanChain, type AddressLookup, type ChainScan } from './gap.js';
import {
  MAX_ACCOUNTS,
  ACCOUNT_NAME_MAX,
  activeRecord,
  emptyAccount,
  emptyMeta,
  ensureAccounts,
  mirrorActive,
  parseAccountName,
  type AccountRecord,
  type ActivityItem,
  type WalletMeta,
  type WalletStorage,
} from './storage.js';
import type { BackupKind, KeyringStatus } from './types.js';
import type { ExplorerUtxo } from '../explorer/utxo.js';
import type { HistoryItem } from '../explorer/history.js';
import { planSend, previewFromSigned, signPlan, type SendPlan, type SendPreview } from '../tx/builder.js';
import { maxSpendable, outpointKey, type OwnedUtxo } from '../tx/coinselect.js';
import { assertFeeRate, MIN_RELAY_SAT_PER_KVB } from '../tx/fee.js';
import { parseTx } from '../tx/parse.js';
import {
  canonicalOrigin,
  grantSite,
  isGranted,
  parseGrants,
  revokeGrant,
  type SiteGrant,
} from '../connect/permissions.js';

export const DEFAULT_LOCK_MS = 5 * 60 * 1000;
/** Failed unlocks before the keyring starts making a guesser wait. */
export const UNLOCK_ATTEMPTS_BEFORE_BACKOFF = 5;
export const UNLOCK_BACKOFF_BASE_MS = 1_000;
export const UNLOCK_BACKOFF_MAX_MS = 5 * 60 * 1000;
/**
 * How long a broadcast-but-unconfirmed send keeps its inputs reserved. Long
 * enough that a normal 60-second-block confirmation never races it, short
 * enough that a transaction the network dropped does not lock the coins out of
 * the wallet for good.
 */
export const PENDING_RESERVE_MS = 24 * 60 * 60 * 1000;

export interface KeyringOptions {
  network?: BtqNetwork;
  lockAfterMs?: number;
  now?: () => number;
  randomBytes?: (n: number) => Uint8Array;
  encrypt?: EncryptOptions;
}

export type { BackupKind, KeyringStatus } from './types.js';

export interface Reveal {
  mnemonic: string;
  challenge: number[];
}

export interface ChainTip {
  height: number;
  hash: string;
}

export interface WalletBalances {
  totalSats: bigint;
  confirmedSats: bigint;
}

export type FetchUtxos = (address: string) => Promise<ExplorerUtxo[]>;
export type FetchHistory = (address: string) => Promise<HistoryItem[]>;
export type Broadcast = (hex: string) => Promise<{ txid: string; via?: BroadcastVia }>;

export interface ConfirmSendResult extends SendPreview {
  broadcastStatus: 'pending' | 'signed';
  /** The failure text when broadcastStatus is 'signed'; null when it went out. */
  broadcastError: string | null;
  broadcastVia: BroadcastVia;
}

/**
 * Why this wallet cannot show a phrase — and there is exactly one reason, which
 * is why this is a sentence and not a lookup. A wallet imported from a raw
 * 32-byte seed never had a phrase; every other wallet this build can open was
 * sealed from one and can show it. The two import buttons, and nothing else.
 */
export const NO_PHRASE_MESSAGE =
  'This wallet was imported from a raw 32-byte seed. It has no recovery phrase — the seed hex you imported is its backup.';

export class Keyring {
  private hdSeed: Uint8Array | null = null;
  /**
   * Whether the vault currently open carries BIP39 entropy. In-memory only, and
   * a UI affordance: `revealPhrase` re-checks the payload it actually decrypts.
   * Deliberately not a cleartext `WalletMeta` flag — `origin` is already
   * duplicated between payload and meta and that duplication is what produced
   * the re-stamp bug this reads around.
   */
  private phraseAvailable = false;
  /**
   * `origin` as the *decrypted payload* states it, for as long as the vault is
   * open. Metadata carries a second copy, and that copy can be wrong: a lost
   * `meta` sends `walletMeta()` through `emptyMeta(…, 'bip39')`, which re-stamps
   * a raw-seed wallet as bip39, and the next `saveMeta` writes the lie down. The
   * difference decides which sentence Settings shows a user about their own
   * backup, so it is read from the one record only `seal()` ever wrote.
   */
  private payloadOrigin: SeedOrigin | null = null;
  private pending: { mnemonic: string; challenge: number[] } | null = null;
  private lastActivity = 0;
  private failedUnlocks = 0;
  private unlockBlockedUntil = 0;
  /**
   * Last-known active HD account. Updated synchronously on switch/create so
   * `confirmSend` can pin it *before* the password KDF yields — a concurrent
   * switch must not retarget a send the user already reviewed.
   */
  private activeIndex = 0;
  private readonly network: BtqNetwork;
  private readonly lockAfterMs: number;
  private readonly now: () => number;

  constructor(
    private readonly storage: WalletStorage,
    private readonly opts: KeyringOptions = {},
  ) {
    this.network = opts.network ?? 'testnet';
    this.lockAfterMs = opts.lockAfterMs ?? DEFAULT_LOCK_MS;
    this.now = opts.now ?? Date.now;
  }

  async status(): Promise<KeyringStatus> {
    this.maybeAutoLock();
    const vault = await this.storage.loadVault();
    const loaded = await this.storage.loadMeta();
    const meta = loaded ? mirrorActive(ensureAccounts(loaded)) : null;
    // Which backup this wallet can show, decided in one place. An open vault
    // always has one, and which one follows from how it was imported: the
    // phrase when the entropy is sealed beside the seed, the HD seed itself for
    // a raw-32 import, which never had a phrase. `null` means "offer no
    // control", which is the locked case, and never "offer a control that does
    // nothing".
    const backup: BackupKind | null =
      this.hdSeed === null ? null : this.phraseAvailable ? 'recoveryPhrase' : 'hdSeed';
    return {
      hasVault: vault !== null,
      unlocked: this.hdSeed !== null,
      pendingReveal: this.pending !== null,
      network: meta?.network ?? this.network,
      // Payload first, metadata only as the locked-wallet fallback — see the
      // note on `payloadOrigin`.
      origin: this.payloadOrigin ?? meta?.origin ?? null,
      externalNext: meta?.externalNext ?? 0,
      internalNext: meta?.internalNext ?? 0,
      usedExternal: meta?.usedExternal ?? 0,
      usedInternal: meta?.usedInternal ?? 0,
      lastBalanceSats: meta?.lastBalanceSats ?? '0',
      confirmedBalanceSats: meta?.confirmedBalanceSats ?? '0',
      tipHeight: meta?.tipHeight ?? null,
      lastScanAt: meta?.lastScanAt ?? null,
      backup,
      // Derived, never recomputed: a second independent boolean is a second
      // thing that can disagree with the first, and the disagreement that
      // matters is the one that offers a phrase this vault cannot produce.
      // False whenever locked, so a locked popup learns nothing about it.
      canRevealPhrase: backup === 'recoveryPhrase',
      activeAccount: meta?.activeAccount ?? 0,
      // Empty whenever locked, for the reason `canRevealPhrase` is false there:
      // every entry carries a receive address and a name the user chose, and
      // before accounts existed no address left this worker while locked
      // (`wallet.receive` requires unlocked, `peekReceiveAddress` throws
      // LOCKED, `getAccounts` answers `[]`). Anyone who opens a locked popup —
      // a borrowed laptop, a shoulder, a recording of the unlock screen —
      // would otherwise read the whole address set, labelled "Payroll" and
      // "Exchange", and pull every account's history off the public explorer.
      // The aggregate balance above was already visible; these are not.
      accounts:
        this.hdSeed === null
          ? []
          : (meta?.accounts ?? []).map((a) => ({
              index: a.index,
              name: a.name,
              lastBalanceSats: a.lastBalanceSats,
              address: a.address,
            })),
    };
  }

  async create(password: string): Promise<Reveal> {
    this.maybeAutoLock();
    assertPassword(password);
    if (await this.storage.loadVault()) {
      throw new WalletError('ALREADY_EXISTS', 'A wallet already exists on this device. Remove it first.');
    }
    this.lock();
    const mnemonic = generateMnemonic(128);
    const challenge = pickChallengeIndices(12, 3, this.opts.randomBytes);
    this.pending = { mnemonic, challenge };
    this.touch();
    return { mnemonic, challenge };
  }

  async confirm(answers: { index: number; word: string }[], password: string): Promise<void> {
    this.maybeAutoLock();
    assertPassword(password);
    if (!this.pending) {
      throw new WalletError('NO_PENDING', 'No seed is waiting to be confirmed. Start create again.');
    }
    const words = this.pending.mnemonic.split(' ');
    const expected = new Map(this.pending.challenge.map((i) => [i, words[i]]));
    if (answers.length !== expected.size) {
      throw new WalletError('CONFIRM_MISMATCH', 'Those words do not match the seed.');
    }
    const seen = new Set<number>();
    for (const a of answers) {
      // Duplicating one correct index must not satisfy a 3-word challenge.
      if (seen.has(a.index)) {
        throw new WalletError('CONFIRM_MISMATCH', 'Those words do not match the seed.');
      }
      seen.add(a.index);
      const want = expected.get(a.index);
      if (want === undefined || want !== a.word.trim().toLowerCase()) {
        throw new WalletError('CONFIRM_MISMATCH', 'Those words do not match the seed.');
      }
    }
    const { mnemonic } = this.pending;
    // Entropy into a local first: inlining it as the 4th argument would
    // evaluate the seed first, and a throw would then strand an un-wiped
    // 64-byte HD seed that never reaches seal()'s finally.
    const entropy = mnemonicToEntropy(mnemonic);
    await this.seal(mnemonicToHdSeed(mnemonic), password, 'bip39', entropy);
  }

  async importMnemonic(mnemonic: string, password: string): Promise<void> {
    this.maybeAutoLock();
    assertPassword(password);
    if (await this.storage.loadVault()) {
      throw new WalletError('ALREADY_EXISTS', 'A wallet already exists on this device. Remove it first.');
    }
    const parsed = parseMnemonic(mnemonic);
    const entropy = mnemonicToEntropy(parsed);
    await this.seal(mnemonicToHdSeed(parsed), password, 'bip39', entropy);
  }

  async importSeed(seedHex: string, password: string): Promise<void> {
    this.maybeAutoLock();
    assertPassword(password);
    if (await this.storage.loadVault()) {
      throw new WalletError('ALREADY_EXISTS', 'A wallet already exists on this device. Remove it first.');
    }
    const seed = parseRawSeedHex(seedHex);
    await this.seal(seed, password, 'raw32');
  }

  async unlock(password: string): Promise<void> {
    this.lock();
    this.assertUnlockAllowed();
    const blob = await this.storage.loadVault();
    if (!blob) throw new WalletError('NO_VAULT', 'No wallet on this device.');
    let plain: Uint8Array;
    try {
      plain = await decryptVault(blob, password);
    } catch (e) {
      this.noteFailedUnlock();
      throw e;
    }
    try {
      const payload = decodePayload(plain);
      this.hdSeed = hexToBytes(payload.hdSeedHex);
      this.phraseAvailable = payload.entropyHex !== undefined;
      this.payloadOrigin = payload.origin;
      this.failedUnlocks = 0;
      this.unlockBlockedUntil = 0;
      // A restarted worker defaults activeIndex to 0; restore the persisted
      // account before any confirmSend can pin the wrong one.
      await this.walletMeta();
      this.touch();
    } finally {
      wipePlaintext(plain);
    }
  }

  lock(): void {
    this.clearPending();
    if (this.hdSeed) {
      wipeBytes(this.hdSeed);
      this.hdSeed = null;
    }
    this.phraseAvailable = false;
    this.payloadOrigin = null;
    this.lastActivity = 0;
  }

  async wipe(confirmation: string): Promise<void> {
    if (confirmation !== 'DELETE') {
      throw new WalletError('CONFIRM_MISMATCH', 'Type DELETE to remove the wallet from this device.');
    }
    this.lock();
    await this.storage.clear();
  }

  async receiveAddress(): Promise<DerivedAddress> {
    this.requireUnlocked();
    const meta = await this.walletMeta();
    const rec = activeRecord(meta);
    const derived = this.receiveAt(rec.externalNext, rec.index);
    if (rec.address !== derived.address) {
      rec.address = derived.address;
      mirrorActive(meta);
      await this.storage.saveMeta(meta);
    }
    return derived;
  }

  /**
   * Address at a chain index. `account` defaults to 0 (golden path) so existing
   * callers and tests keep their meaning; the send/scan path always passes the
   * active account explicitly.
   */
  addressAt(chain: Chain, index: number, account = 0): DerivedAddress {
    const seed = this.requireUnlocked();
    return addressFromHdSeed(seed, chain, index, this.network, account);
  }

  async createAccount(): Promise<{ index: number; name: string; address: string }> {
    this.requireUnlocked();
    const meta = await this.walletMeta();
    if (meta.accounts.length >= MAX_ACCOUNTS) {
      throw new WalletError('BAD_PARAMS', `This wallet holds at most ${MAX_ACCOUNTS} accounts.`);
    }
    const nextIndex = Math.max(...meta.accounts.map((a) => a.index)) + 1;
    if (nextIndex >= MAX_ACCOUNTS) {
      throw new WalletError('BAD_PARAMS', `This wallet holds at most ${MAX_ACCOUNTS} accounts.`);
    }
    const rec = emptyAccount(nextIndex);
    rec.address = this.addressAt('external', 0, rec.index).address;
    meta.accounts.push(rec);
    meta.accounts.sort((a, b) => a.index - b.index);
    meta.activeAccount = rec.index;
    this.activeIndex = rec.index;
    mirrorActive(meta);
    await this.storage.saveMeta(meta);
    this.touch();
    return { index: rec.index, name: rec.name, address: rec.address };
  }

  async switchAccount(index: number): Promise<{ index: number; name: string; address: string }> {
    this.requireUnlocked();
    if (!Number.isInteger(index) || index < 0 || index >= MAX_ACCOUNTS) {
      throw new WalletError('BAD_PARAMS', 'Unknown account.');
    }
    const meta = await this.walletMeta();
    const rec = meta.accounts.find((a) => a.index === index);
    if (!rec) throw new WalletError('BAD_PARAMS', 'Unknown account.');
    meta.activeAccount = rec.index;
    this.activeIndex = rec.index;
    if (!rec.address) rec.address = this.addressAt('external', rec.externalNext, rec.index).address;
    mirrorActive(meta);
    await this.storage.saveMeta(meta);
    this.touch();
    return { index: rec.index, name: rec.name, address: rec.address };
  }

  async renameAccount(index: number, name: string): Promise<{ index: number; name: string }> {
    this.requireUnlocked();
    if (!Number.isInteger(index) || index < 0 || index >= MAX_ACCOUNTS) {
      throw new WalletError('BAD_PARAMS', 'Unknown account.');
    }
    const trimmed = parseAccountName(name, '');
    if (trimmed.length === 0) {
      throw new WalletError('BAD_PARAMS', `Name must be 1–${ACCOUNT_NAME_MAX} characters.`);
    }
    const meta = await this.walletMeta();
    const rec = meta.accounts.find((a) => a.index === index);
    if (!rec) throw new WalletError('BAD_PARAMS', 'Unknown account.');
    rec.name = trimmed;
    await this.storage.saveMeta(meta);
    this.touch();
    return { index: rec.index, name: rec.name };
  }

  /**
   * Prove the password against the sealed vault, sharing the unlock throttle.
   *
   * Returns the decrypted plaintext; the caller owns it and MUST wipe it. This
   * never installs a seed: a correct password here does not unlock a locked
   * wallet, and a wrong one counts against the same back-off as unlock.
   */
  private async reauthPlaintext(password: string): Promise<Uint8Array> {
    this.requireUnlocked();
    this.assertUnlockAllowed();
    const blob = await this.storage.loadVault();
    if (!blob) throw new WalletError('NO_VAULT', 'No wallet on this device.');
    let plain: Uint8Array;
    try {
      plain = await decryptVault(blob, password);
    } catch (e) {
      this.noteFailedUnlock();
      throw e;
    }
    this.failedUnlocks = 0;
    this.unlockBlockedUntil = 0;
    this.touch();
    return plain;
  }

  async reauth(password: string): Promise<void> {
    wipePlaintext(await this.reauthPlaintext(password));
  }

  /**
   * Show the recovery phrase again, behind the password, on an already-unlocked
   * wallet.
   *
   * Deliberately **not** one-shot, and it does not pretend to be: anybody who
   * can call this has the password, and the password already carries full spend
   * authority over the same vault. What it does guarantee is that the words
   * never leave the worker without the password being re-typed, that a wrong
   * password costs the same back-off as a wrong unlock, and that the words it
   * returns re-derive *this* wallet.
   *
   * The words are regenerated from the vault's entropy on every call and let go
   * — never cached on this object, because a JS string cannot be zeroed.
   */
  async revealPhrase(password: string): Promise<{ words: string[] }> {
    const plain = await this.reauthPlaintext(password);
    let entropy: Uint8Array | undefined;
    let derived: Uint8Array | undefined;
    let stored: Uint8Array | undefined;
    try {
      const payload = decodePayload(plain);
      if (payload.entropyHex === undefined) {
        // The decoder holds `origin === 'bip39'` and "carries entropy" together,
        // so an absent entropy here means a raw-32 import and nothing else.
        throw new WalletError('NO_PHRASE', NO_PHRASE_MESSAGE);
      }
      entropy = hexToBytes(payload.entropyHex);
      const mnemonic = entropyToMnemonic(entropy);
      // Self-check before anything reaches the screen: a phrase that restores a
      // *different* wallet is worse than no phrase at all. It costs ~1 ms next
      // to the 600 000-round password check above, so it is free.
      //
      // A plain length-then-loop compare. Constant time is deliberately not
      // required here: both sides are our own material, decrypted from one
      // authenticated ciphertext, with no attacker input and no oracle — the
      // caller already proved the password to get this far.
      derived = mnemonicToHdSeed(mnemonic);
      stored = hexToBytes(payload.hdSeedHex);
      let same = derived.length === stored.length;
      if (same) {
        for (let i = 0; i < derived.length; i++) {
          if (derived[i] !== stored[i]) same = false;
        }
      }
      if (!same) throw new WalletError('NO_PHRASE', 'The stored phrase does not match this wallet.');
      return { words: mnemonic.split(' ') };
    } finally {
      if (entropy) wipeBytes(entropy);
      if (derived) wipeBytes(derived);
      if (stored) wipeBytes(stored);
      wipePlaintext(plain);
    }
  }

  /**
   * Show the HD seed as hex, behind the password, on an already-unlocked wallet.
   *
   * The backup for the wallet that has no phrase to show: a raw-32 import,
   * which never had one. What comes back is the master secret every key in this
   * wallet is derived from, and it is offered *instead of* the phrase control,
   * never as well — see `status().backup`.
   *
   * That wallet's 32-byte seed goes straight back in through `Import → raw
   * seed`. A seed that came from a phrase is 64 bytes and `parseRawSeedHex`
   * deliberately refuses those (`tests/unit/mnemonic.test.ts`, "so a BIP39 seed
   * is not imported as raw"), which is why a phrase wallet is offered its
   * phrase — the thing that actually restores it — rather than this.
   *
   * Same guarantees as `revealPhrase`, deliberately and by reusing the same
   * code: locked refuses, the password is re-proved against the sealed vault,
   * a wrong one costs the same shared back-off, and pages cannot reach it.
   * Like the phrase, the hex is a JS string that cannot be zeroed — so it is
   * read out of the payload, handed to the one screen that shows it, and never
   * cached on this object.
   */
  async revealSeedHex(password: string): Promise<{ seedHex: string }> {
    const plain = await this.reauthPlaintext(password);
    let stored: Uint8Array | undefined;
    try {
      const payload = decodePayload(plain);
      // Re-checked against the seed this wallet is actually deriving from, for
      // the same reason the phrase is re-derived before it is shown: hex that
      // restores a *different* wallet is a backup the user trusts and loses
      // their coins to. Plain loop compare — both sides are our own material
      // out of one authenticated ciphertext, there is no attacker input and no
      // oracle, and the caller already proved the password to get here.
      const live = this.hdSeed;
      if (!live) throw new WalletError('LOCKED', 'Wallet is locked.');
      stored = hexToBytes(payload.hdSeedHex);
      let same = stored.length === live.length;
      if (same) {
        for (let i = 0; i < stored.length; i++) {
          if (stored[i] !== live[i]) same = false;
        }
      }
      if (!same) {
        throw new WalletError('NOT_A_VAULT', 'The sealed seed is not the seed this wallet is using.');
      }
      return { seedHex: payload.hdSeedHex };
    } finally {
      if (stored) wipeBytes(stored);
      wipePlaintext(plain);
    }
  }

  /**
   * Walk every derived address on both chains, inclusive of the next unused
   * index (so a payment to the address currently on screen is picked up). The
   * one place this loop is written down.
   */
  private async eachAddress<T>(
    fn: (chain: Chain, index: number, address: string) => Promise<T[]>,
    account?: number,
  ): Promise<T[]> {
    this.requireUnlocked();
    const meta = await this.walletMeta();
    const rec =
      account === undefined ? activeRecord(meta) : meta.accounts.find((a) => a.index === account);
    // A missing account must not silently walk the active one: that pairs
    // another account's UTXOs with this caller's keys (or the reverse).
    if (!rec) throw new WalletError('BAD_PARAMS', 'Unknown account.');
    const out: T[] = [];
    for (const chain of ['external', 'internal'] as const) {
      const last = Math.max(chain === 'external' ? rec.externalNext : rec.internalNext, 0);
      for (let i = 0; i <= last; i++) {
        out.push(...(await fn(chain, i, this.addressAt(chain, i, rec.index).address)));
      }
    }
    return out;
  }

  /**
   * Every spendable coin the wallet owns. Outpoints already committed by a
   * transaction this wallet signed and pushed are excluded: re-selecting them
   * builds a conflicting replacement of a payment already in flight, so a payee
   * can end up with nothing while the balance still looks spent.
   */
  async gatherUtxos(fetchUtxos: FetchUtxos, account?: number): Promise<OwnedUtxo[]> {
    const reserved = await this.reservedOutpoints(account);
    const owned = await this.eachAddress<OwnedUtxo>(async (chain, index, address) => {
      const script = scriptForAddress(address, this.network);
      const rows = await fetchUtxos(address);
      return rows.map((u) => ({
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        script,
        address,
        chain,
        index,
        blockHeight: u.blockHeight,
      }));
    }, account);
    return owned.filter((u) => !reserved.has(outpointKey(u)));
  }

  /**
   * Outpoints locked by an in-flight send of ours (activity status 'pending').
   * A transaction that was never broadcast ('signed') reserves nothing — the
   * user must be able to retry it at a higher fee — and a reservation expires
   * after PENDING_RESERVE_MS so a dropped transaction cannot strand the coins.
   */
  private async reservedOutpoints(account?: number): Promise<Set<string>> {
    const reserved = new Set<string>();
    const now = this.now();
    const active = account ?? (await this.walletMeta()).activeAccount;
    for (const item of await this.storage.loadActivity()) {
      if ((item.accountIndex ?? 0) !== active) continue;
      if (item.status !== 'pending') continue;
      if (item.at > 0 && now - item.at > PENDING_RESERVE_MS) continue;
      const keys = item.spends ?? (item.hex ? outpointsOfSignedHex(item.hex) : []);
      for (const key of keys) reserved.add(key);
    }
    return reserved;
  }

  /** Balance of one account — the active one unless `account` names another. */
  async balances(fetchUtxos: FetchUtxos, account?: number): Promise<WalletBalances> {
    const coins = await this.gatherUtxos(fetchUtxos, account);
    let totalSats = 0n;
    let confirmedSats = 0n;
    for (const c of coins) {
      totalSats += c.value;
      if (c.blockHeight != null) confirmedSats += c.value;
    }
    return { totalSats, confirmedSats };
  }

  /** Largest single-output amount that can leave the wallet at this fee rate. */
  async maxSpendable(opts: {
    fetchUtxos: FetchUtxos;
    feeRateSatPerKvB?: number;
  }): Promise<{ amountSats: string; fee: string; inputs: number }> {
    this.requireUnlocked();
    const rate = assertFeeRate(opts.feeRateSatPerKvB ?? MIN_RELAY_SAT_PER_KVB);
    const best = maxSpendable(await this.gatherUtxos(opts.fetchUtxos), rate);
    return { amountSats: best.amount.toString(), fee: best.fee.toString(), inputs: best.inputs.length };
  }

  async prepareSend(opts: {
    destination: string;
    amountSats: bigint;
    fetchUtxos: FetchUtxos;
    feeRateSatPerKvB?: number;
  }): Promise<{
    destination: string;
    amount: string;
    fee: string;
    change: string;
    inputs: number;
    feeRateSatPerKvB: number;
    vsize: number;
    weight: number;
  }> {
    this.requireUnlocked();
    const rate = assertFeeRate(opts.feeRateSatPerKvB ?? MIN_RELAY_SAT_PER_KVB);
    const plan = await this.buildPlan(opts.destination, opts.amountSats, opts.fetchUtxos, rate);
    return {
      destination: plan.destination,
      amount: plan.amount.toString(),
      fee: plan.fee.toString(),
      change: plan.change.toString(),
      inputs: plan.inputs.length,
      feeRateSatPerKvB: plan.feeRateSatPerKvB,
      vsize: plan.vsize,
      weight: plan.weight,
    };
  }

  /** The shared plan construction behind prepareSend and confirmSend. */
  private async buildPlan(
    destination: string,
    amountSats: bigint,
    fetchUtxos: FetchUtxos,
    feeRateSatPerKvB: number,
    account?: number,
  ): Promise<SendPlan & { changeIndex: number; account: number }> {
    const meta = await this.walletMeta();
    const rec =
      account === undefined ? activeRecord(meta) : meta.accounts.find((a) => a.index === account);
    if (!rec) throw new WalletError('BAD_PARAMS', 'Unknown account.');
    const utxos = await this.gatherUtxos(fetchUtxos, rec.index);
    const change = this.addressAt('internal', rec.internalNext, rec.index);
    const plan = planSend({
      utxos,
      destination,
      amount: amountSats,
      changeAddress: change.address,
      feeRateSatPerKvB,
    });
    return { ...plan, changeIndex: change.index, account: rec.index };
  }

  async confirmSend(opts: {
    destination: string;
    amountSats: bigint;
    password: string;
    fetchUtxos: FetchUtxos;
    broadcast: Broadcast;
    feeRateSatPerKvB?: number;
    now?: number;
  }): Promise<ConfirmSendResult> {
    // Pin the account *before* reauth yields on the KDF. The header switcher
    // stays clickable while the popup shows "Signing…"; without this pin a
    // concurrent switch would debit a different account than the one whose
    // UTXOs and fee the user just reviewed.
    const account = this.activeIndex;
    await this.reauth(opts.password);
    const seed = this.requireUnlocked();
    const rate = assertFeeRate(opts.feeRateSatPerKvB ?? MIN_RELAY_SAT_PER_KVB);
    const plan = await this.buildPlan(opts.destination, opts.amountSats, opts.fetchUtxos, rate, account);
    // Sign before any network call: a broadcast failure must never cost us the
    // bytes. previewFromSigned re-decodes them and refuses on any disagreement.
    const signed = signPlan(plan, (u) => deriveKeySeed(masterFromSeed(seed), u.chain, u.index, plan.account));
    const preview = previewFromSigned(signed);

    let broadcastStatus: 'pending' | 'signed';
    let broadcastError: string | null = null;
    let broadcastVia: BroadcastVia;
    try {
      const pushed = await opts.broadcast(signed.hex);
      if (pushed.txid !== signed.txid) {
        throw new BroadcastError(
          `The backend returned a different transaction id (${pushed.txid.slice(0, 12)}…) than the one we signed. Treat the signed hex as authoritative.`,
          pushed.via ?? null,
        );
      }
      broadcastStatus = 'pending';
      broadcastVia = pushed.via ?? null;
    } catch (e) {
      // Never swallowed: the node's policy text ("min relay fee not met",
      // "bad-txns-inputs-missingorspent") is the only way a user can tell a
      // rejected transaction from an explorer that simply cannot push at all.
      broadcastStatus = 'signed';
      broadcastError = e instanceof Error ? e.message : 'Broadcast failed.';
      broadcastVia = e instanceof BroadcastError ? e.via : null;
    }

    const item: ActivityItem = {
      txid: signed.txid,
      status: broadcastStatus,
      destination: signed.destination,
      amountSats: signed.amount.toString(),
      feeSats: signed.fee.toString(),
      hex: signed.hex,
      broadcastError,
      broadcastVia,
      spends: plan.inputs.map(outpointKey),
      at: opts.now ?? this.now(),
      accountIndex: plan.account,
    };
    const prev = await this.storage.loadActivity();
    await this.storage.saveActivity([item, ...prev].slice(0, 50));
    if (plan.change > 0n) {
      const meta = await this.walletMeta();
      const rec = meta.accounts.find((a) => a.index === plan.account);
      if (rec) {
        rec.internalNext = Math.max(rec.internalNext, plan.changeIndex + 1);
        mirrorActive(meta);
        await this.storage.saveMeta(meta);
      }
    }
    this.touch();
    return { ...preview, broadcastStatus, broadcastError, broadcastVia };
  }

  async listHistory(fetchHistory: FetchHistory, tip?: ChainTip | null): Promise<HistoryItem[]> {
    this.requireUnlocked();
    const seen = new Map<string, HistoryItem>();
    const rows = await this.eachAddress(async (_chain, _index, address) => fetchHistory(address));
    for (const h of rows) {
      const prev = seen.get(h.txid);
      if (!prev) {
        seen.set(h.txid, { ...h });
      } else {
        // The same transaction shows up on several of our addresses (a send
        // that pays change back to us); value changes add.
        seen.set(h.txid, {
          ...h,
          valueChange: prev.valueChange + h.valueChange,
          status: h.status === 'confirmed' || prev.status === 'confirmed' ? 'confirmed' : 'pending',
          blockHeight: h.blockHeight ?? prev.blockHeight,
        });
      }
    }

    const account = (await this.walletMeta()).activeAccount;
    const allLocal = await this.storage.loadActivity();
    const local = allLocal.filter((a) => (a.accountIndex ?? 0) === account);
    let activityChanged = false;
    for (const a of local) {
      const onchain = seen.get(a.txid);
      if (onchain?.status === 'confirmed') {
        if (a.status !== 'confirmed') {
          a.status = 'confirmed';
          activityChanged = true;
        }
      } else if (!onchain) {
        seen.set(a.txid, {
          txid: a.txid,
          blockHeight: null,
          valueChange: -BigInt(a.amountSats) - BigInt(a.feeSats),
          // A transaction no backend accepted stays 'signed', never 'pending':
          // rendering it as pending tells the user a payee was paid when
          // nothing was ever broadcast.
          status: a.status === 'confirmed' ? 'confirmed' : a.status,
          at: a.at,
        });
      } else {
        seen.set(a.txid, { ...onchain, at: a.at });
      }
    }
    if (activityChanged) await this.storage.saveActivity(allLocal);

    const height = tip?.height ?? null;
    return [...seen.values()].map((h) => ({
      ...h,
      confirmations: height !== null && h.blockHeight !== null ? Math.max(0, height - h.blockHeight + 1) : null,
    }));
  }

  async listActivity(): Promise<ActivityItem[]> {
    const account = (await this.walletMeta()).activeAccount;
    return (await this.storage.loadActivity()).filter((a) => (a.accountIndex ?? 0) === account);
  }

  /**
   * Every approval this wallet holds, as the (origin, account) pairs they are.
   *
   * Not lock-gated — Settings needs it and it was never gated — and
   * deliberately carrying the account *index* rather than its name: names are
   * the user's own words and do not leave a locked worker (see `status`).
   */
  async connectedSites(): Promise<SiteGrant[]> {
    return parseGrants(await this.storage.loadOrigins());
  }

  /**
   * The prompt an older build left in the single storage slot, if any.
   *
   * The service worker answers `wallet.pendingConnect` from its connect broker
   * instead — the broker is the only place a request with a live caller behind
   * it exists — and clears this slot as it migrates. This stays so a keyring
   * driven without that worker still reports what it can see, and so the
   * migration has something to read.
   */
  async pendingConnect(): Promise<{ origin: string } | null> {
    return this.storage.loadPendingConnect();
  }

  async requestAccounts(origin: string): Promise<{ accounts: string[] } | { pending: true }> {
    // Do not touch() — a connected page polling accounts must not pin the seed.
    this.maybeAutoLock();
    if (!this.hdSeed) throw new WalletError('LOCKED', 'Wallet is locked.');
    const o = canonicalOrigin(origin);
    const allowed = await this.storage.loadOrigins();
    // The grant is per (origin, account). A site approved for Account 1 asking
    // again while Account 2 is active is a site asking for something it has not
    // been given, so it goes back through the approval window like any other
    // first request.
    if (isGranted(allowed, o, await this.activeAccountIndex())) {
      return { accounts: [await this.peekReceiveAddress()] };
    }
    // Deliberately no durable record. A parked request lives and dies with the
    // service worker that holds its `sendResponse`; a note of it that outlives
    // the worker is a prompt the user could approve days later, granting a site
    // that is no longer asking. The broker keeps the pending set, timestamped.
    return { pending: true };
  }

  /**
   * What a connected page may see: the active account's address when *that*
   * pair was approved, and `[]` otherwise — including when the user has
   * switched to an account this site was never given. Switching is how a user
   * says "not this identity"; the worker must not answer it with an address.
   */
  async getAccounts(origin: string): Promise<{ accounts: string[] }> {
    this.maybeAutoLock();
    const o = canonicalOrigin(origin);
    const allowed = await this.storage.loadOrigins();
    if (this.hdSeed === null) return { accounts: [] };
    try {
      if (!isGranted(allowed, o, await this.activeAccountIndex())) return { accounts: [] };
      return { accounts: [await this.peekReceiveAddress()] };
    } catch (e) {
      if (e instanceof WalletError && e.code === 'LOCKED') return { accounts: [] };
      throw e;
    }
  }

  async approveConnect(origin: string): Promise<{ accounts: string[] }> {
    this.requireUnlocked();
    const o = canonicalOrigin(origin);
    // The approval screen says "this site will see one address": the address of
    // the account that is active as the user clicks Connect. That is the pair
    // that is stored, so it is also the only pair this grant can ever answer.
    const account = await this.activeAccountIndex();
    const allowed = grantSite(await this.storage.loadOrigins(), o, account);
    await this.storage.saveOrigins(allowed);
    await this.storage.savePendingConnect(null);
    return { accounts: [(await this.receiveAddress()).address] };
  }

  /**
   * Refuse a connection request. `origin` names the request being denied — one
   * outstanding prompt must never settle another — and is validated here so a
   * malformed one is a refusal rather than a silent no-op. Settling the parked
   * caller is the broker's job; all this does is drop any migrated record.
   */
  async denyConnect(origin?: string): Promise<void> {
    if (origin !== undefined) canonicalOrigin(origin);
    await this.storage.savePendingConnect(null);
  }

  /**
   * Take a grant back. One row in Settings is one (origin, account) pair, so
   * that is what `account` names. `page.disconnect` passes none: a site saying
   * "forget me" means every account it was ever approved for, not just the one
   * that happens to be active.
   */
  async revokeSite(origin: string, account?: number): Promise<void> {
    const allowed = revokeGrant(await this.storage.loadOrigins(), origin, account);
    await this.storage.saveOrigins(allowed);
  }

  /**
   * Gap scan one account's two chains, in place. The single place the address
   * walk is written down, so every account gets exactly the same treatment.
   *
   * The resume point is `externalNext` / `internalNext` — one past the highest
   * index already known to be used. Everything below that is settled, so a
   * wallet with 200 used addresses re-queries only the ~20-address gap window
   * instead of all 200. The window itself *is* re-queried on every scan: an
   * unused address becomes used the moment somebody pays it, and missing that
   * would freeze the receive address on an address that has already been used.
   *
   * `scannedExternal` / `scannedInternal` record how far the last pass looked,
   * for diagnostics and so `full: true` can be told apart from a resume.
   */
  private async scanAccount(
    rec: AccountRecord,
    lookup: AddressLookup,
    full: boolean,
  ): Promise<{ external: ChainScan; internal: ChainScan }> {
    const external = await scanChain({
      chain: 'external',
      addressAt: (i) => this.addressAt('external', i, rec.index).address,
      lookup,
      startIndex: full ? 0 : Math.max(0, rec.externalNext),
      lastUsedIndex: full ? -1 : rec.externalNext - 1,
    });
    const internal = await scanChain({
      chain: 'internal',
      addressAt: (i) => this.addressAt('internal', i, rec.index).address,
      lookup,
      startIndex: full ? 0 : Math.max(0, rec.internalNext),
      lastUsedIndex: full ? -1 : rec.internalNext - 1,
    });

    rec.externalNext = Math.max(full ? 0 : rec.externalNext, external.nextIndex);
    rec.internalNext = Math.max(full ? 0 : rec.internalNext, internal.nextIndex);
    rec.usedExternal = (full ? 0 : rec.usedExternal) + external.used.length;
    rec.usedInternal = (full ? 0 : rec.usedInternal) + internal.used.length;
    rec.scannedExternal = Math.max(full ? -1 : rec.scannedExternal, external.scannedTo);
    rec.scannedInternal = Math.max(full ? -1 : rec.scannedInternal, internal.scannedTo);
    rec.address = this.addressAt('external', rec.externalNext, rec.index).address;
    return { external, internal };
  }

  /**
   * Has this account's external chain ever been used? The BIP44 question, asked
   * of an account this device does not know about yet.
   *
   * External only, and deliberately: a change address is never published, so an
   * account with internal history and no external history cannot exist. Halving
   * the probe halves what a restore pays for accounts that were never made.
   */
  private async accountIsUsed(index: number, lookup: AddressLookup): Promise<boolean> {
    const scan = await scanChain({
      chain: 'external',
      addressAt: (i) => this.addressAt('external', i, index).address,
      lookup,
      startIndex: 0,
      lastUsedIndex: -1,
    });
    return scan.used.length > 0;
  }

  /**
   * Bring the wallet up to date with the chain.
   *
   * **Every known account is walked, not just the active one.** Restoring this
   * wallet from its phrase re-derives account 0 and nothing else unless the
   * scan goes looking: a wallet whose coins sit on Account 3 would otherwise
   * come back empty and stay empty, because the switcher is built from the
   * account list a scan of one account never grows.
   *
   * A full rescan — and the first scan a restored wallet ever runs — also
   * probes `ACCOUNT_GAP_LIMIT` accounts past the highest one it knows, and
   * adopts any whose external chain has been used. That is the only way a fresh
   * device learns that accounts above the first ever existed; the seed itself
   * does not say, and neither does btq-core, which hardcodes `0'`
   * (`scriptpubkeyman.cpp:1252`). **An account that never received coins cannot
   * be rediscovered this way at all** — there is nothing on any chain to find —
   * which is why the switcher says so at the point the account is created.
   *
   * The reported balance is the sum of `/utxos` over the derived addresses —
   * never the explorer's own `balance` field, which the live indexer reports as
   * negative for busy addresses (tests/fixtures/explorer/address-used.json).
   */
  async scan(
    lookup: AddressLookup,
    fetchUtxos?: FetchUtxos,
    tip?: ChainTip | null,
    opts: { full?: boolean } = {},
  ): Promise<{
    external: ChainScan;
    internal: ChainScan;
    usedExternal: number;
    usedInternal: number;
    totalBalanceSats: bigint;
    confirmedBalanceSats: bigint;
    tipHeight: number | null;
    lastScanAt: number;
    /** Accounts this pass found on chain that the device did not know about. */
    discoveredAccounts: number[];
  }> {
    this.requireUnlocked();
    const meta = await this.walletMeta();
    const rec = activeRecord(meta);
    const full = opts.full === true;
    // A restore's very first scan is a restore scan even though the user never
    // pressed "Rescan": it is the pass that has to find whatever the seed was
    // carrying. After that, discovery costs ~20 derivations per probed account
    // and is left to the explicit full rescan.
    const discover = full || meta.lastScanAt === null;

    let external: ChainScan | null = null;
    let internal: ChainScan | null = null;
    // Ascending, so a lower account is always settled before a higher one and
    // the discovery probe below starts from a list that is fully up to date.
    for (const record of [...meta.accounts].sort((a, b) => a.index - b.index)) {
      const scanned = await this.scanAccount(record, lookup, full);
      if (record.index === rec.index) {
        external = scanned.external;
        internal = scanned.internal;
      }
    }

    const discoveredAccounts: number[] = [];
    if (discover) {
      let empty = 0;
      let next = Math.max(...meta.accounts.map((a) => a.index)) + 1;
      while (next < MAX_ACCOUNTS && empty < ACCOUNT_GAP_LIMIT && meta.accounts.length < MAX_ACCOUNTS) {
        if (await this.accountIsUsed(next, lookup)) {
          const found = emptyAccount(next);
          await this.scanAccount(found, lookup, true);
          meta.accounts.push(found);
          meta.accounts.sort((a, b) => a.index - b.index);
          discoveredAccounts.push(next);
          empty = 0;
        } else {
          empty += 1;
        }
        next += 1;
      }
    }

    meta.tipHeight = tip?.height ?? meta.tipHeight;
    meta.lastScanAt = this.now();
    mirrorActive(meta);
    // Persist the new cursors first so the UTXO sweep below covers every
    // address — including a discovered account's, which `gatherUtxos` refuses
    // to walk until the account is in the stored list.
    await this.storage.saveMeta(meta);

    let totalBalanceSats = BigInt(rec.lastBalanceSats || '0');
    let confirmedBalanceSats = BigInt(rec.confirmedBalanceSats || '0');
    if (fetchUtxos) {
      for (const record of meta.accounts) {
        const b = await this.balances(fetchUtxos, record.index);
        record.lastBalanceSats = b.totalSats.toString();
        record.confirmedBalanceSats = b.confirmedSats.toString();
        if (record.index === rec.index) {
          totalBalanceSats = b.totalSats;
          confirmedBalanceSats = b.confirmedSats;
        }
      }
      mirrorActive(meta);
      await this.storage.saveMeta(meta);
    }

    this.touch();
    return {
      external: external ?? emptyChainScan('external', rec.externalNext),
      internal: internal ?? emptyChainScan('internal', rec.internalNext),
      usedExternal: rec.usedExternal,
      usedInternal: rec.usedInternal,
      totalBalanceSats,
      confirmedBalanceSats,
      tipHeight: meta.tipHeight,
      lastScanAt: meta.lastScanAt ?? this.now(),
      discoveredAccounts,
    };
  }

  maybeAutoLock(): void {
    // An in-progress reveal (no decrypted seed yet) stays in memory so the user
    // can write it down; it is never persisted. A leftover pending must not
    // keep an unlocked seed pinned in RAM.
    if (this.pending && this.hdSeed === null) return;
    if (this.hdSeed === null) return;
    if (this.lockAfterMs <= 0) return;
    if (this.lastActivity === 0) return;
    if (this.now() - this.lastActivity >= this.lockAfterMs) this.lock();
  }

  private receiveAt(index: number, account: number): DerivedAddress {
    const seed = this.requireUnlocked();
    this.touch();
    return addressFromHdSeed(seed, 'external', index, this.network, account);
  }

  /** Receive address without resetting the auto-lock clock. */
  private async peekReceiveAddress(): Promise<string> {
    const rec = activeRecord(await this.walletMeta());
    this.maybeAutoLock();
    const seed = this.hdSeed;
    if (!seed) throw new WalletError('LOCKED', 'Wallet is locked.');
    return addressFromHdSeed(seed, 'external', rec.externalNext, this.network, rec.index).address;
  }

  /**
   * The persisted active account. Read from storage rather than from
   * `activeIndex` so a service worker that restarted mid-session answers with
   * the account the user is actually looking at, not the 0 it woke up with.
   */
  private async activeAccountIndex(): Promise<number> {
    return (await this.walletMeta()).activeAccount;
  }

  private async walletMeta(): Promise<WalletMeta> {
    const loaded = await this.storage.loadMeta();
    const meta = mirrorActive(ensureAccounts(loaded ?? emptyMeta(this.network, 'bip39')));
    this.activeIndex = meta.activeAccount;
    return meta;
  }

  /**
   * Seal the vault. `entropy`, when given, is the BIP39 entropy the HD seed was
   * derived from — the only thing that lets the phrase be read back later. Both
   * byte arrays are wiped on the way out, whether or not the seal succeeded.
   */
  private async seal(
    hdSeed: Uint8Array,
    password: string,
    origin: SeedOrigin,
    entropy?: Uint8Array,
  ): Promise<void> {
    let plain: Uint8Array | undefined;
    try {
      // Inside the try so the finally still wipes both buffers: this is a
      // programming error, not a user one, and it must not leave a live seed
      // and a live entropy on the heap on its way out.
      if (entropy && origin !== 'bip39') throw new Error('raw seeds have no BIP39 entropy');
      if (await this.storage.loadVault()) {
        throw new WalletError('ALREADY_EXISTS', 'A wallet already exists on this device. Remove it first.');
      }
      const payload: VaultPayload = {
        v: 2,
        network: this.network,
        origin,
        hdSeedHex: bytesToHex(hdSeed),
        // Conditional spread, not `entropyHex: entropy && …`: an explicit
        // `undefined` survives as a key on the object, and anything that later
        // serialised it as null would be refused by decodePayload.
        ...(entropy ? { entropyHex: bytesToHex(entropy) } : {}),
      };
      plain = encodePayload(payload);
      const blob = await encryptVault(plain, password, this.opts.encrypt);
      await this.storage.saveVault(blob);
      await this.storage.saveMeta(emptyMeta(this.network, origin));
      this.hdSeed = new Uint8Array(hdSeed);
      this.phraseAvailable = entropy !== undefined;
      this.payloadOrigin = origin;
      this.activeIndex = 0;
      this.clearPending();
      this.touch();
    } finally {
      if (plain) wipePlaintext(plain);
      wipeBytes(hdSeed);
      if (entropy) wipeBytes(entropy);
    }
  }

  /**
   * Offline brute force against the vault blob is bounded by PBKDF2, but an
   * attacker sitting at an open popup otherwise gets unlimited free guesses.
   * This state is in-memory only (a service-worker restart clears it) — it
   * slows a person at the keyboard; it is not a substitute for the KDF.
   */
  private assertUnlockAllowed(): void {
    if (this.unlockBlockedUntil > this.now()) {
      const seconds = Math.ceil((this.unlockBlockedUntil - this.now()) / 1000);
      throw new WalletError(
        'TOO_MANY_ATTEMPTS',
        `Too many wrong passwords. Wait ${seconds} second${seconds === 1 ? '' : 's'} and try again.`,
      );
    }
  }

  private noteFailedUnlock(): void {
    this.failedUnlocks += 1;
    if (this.failedUnlocks >= UNLOCK_ATTEMPTS_BEFORE_BACKOFF) {
      const over = this.failedUnlocks - UNLOCK_ATTEMPTS_BEFORE_BACKOFF;
      const wait = Math.min(UNLOCK_BACKOFF_BASE_MS * 2 ** over, UNLOCK_BACKOFF_MAX_MS);
      this.unlockBlockedUntil = this.now() + wait;
    }
  }

  private requireUnlocked(): Uint8Array {
    this.maybeAutoLock();
    if (!this.hdSeed) throw new WalletError('LOCKED', 'Wallet is locked.');
    this.touch();
    return this.hdSeed;
  }

  private touch(): void {
    this.lastActivity = this.now();
  }

  private clearPending(): void {
    this.pending = null;
  }
}

/**
 * The "nothing was looked at" scan result, for the impossible case where the
 * active account is not in the list the loop walked. `activeRecord` guarantees
 * it is, so this exists to keep the return shape total rather than to be hit.
 */
function emptyChainScan(chain: Chain, nextIndex: number): ChainScan {
  return { chain, nextIndex, used: [], scannedTo: nextIndex - 1 };
}

/** Outpoints a signed transaction spends, for reserving them against re-selection. */
export function outpointsOfSignedHex(hex: string): string[] {
  try {
    return parseTx(hex).inputs.map((i) => outpointKey(i));
  } catch {
    return [];
  }
}
