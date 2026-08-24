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
 *
 * **Nothing on this object is allowed to outlive the service worker.** Chrome
 * tears an idle MV3 worker down after about thirty seconds of no events, and
 * every private field here is gone with it — so a field is only ever a cache of
 * something the vault or the metadata can produce again, or a secret whose loss
 * locks the wallet. Onboarding used to break that rule (it parked the generated
 * mnemonic in a field between `create` and `confirm`, a gap in which the worker
 * receives no events at all, and lost it while the words were still on the
 * user's screen); `create` now seals the vault outright and the confirmation
 * challenge lives in storage. See `create` for why that is safe.
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
import {
  BACKUP_VERSION,
  MAX_BACKUP_BYTES,
  backupFileName,
  decodeBackup,
  encodeBackup,
  type BackupPayload,
} from '../vault/backup.js';
import { bytesToHex, hexToBytes, wipeBytes } from '../util/hex.js';
import { bytesEqual } from '../util/bytes.js';
import { BroadcastError, WalletError, type BroadcastVia } from './errors.js';
import { deriveKeySeed, masterFromSeed } from '../crypto/hd.js';
import { scriptForAddress } from '../script/address.js';
import { addressFromHdSeed, type DerivedAddress } from './derive.js';
import { scanChain, type AddressLookup, type ChainScan } from './gap.js';
import {
  MAX_ACCOUNTS,
  MAX_ACTIVITY,
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
import { addressForOutputScript, parseTx } from '../tx/parse.js';
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

/**
 * How long the plan behind a review card stays confirmable.
 *
 * Long enough that reading the numbers and typing a password is never a race,
 * short enough that a card left open on a desk cannot be confirmed against a
 * fee rate and a coin set from another hour. Expiry is a `PLAN_STALE` refusal
 * and the Send screen re-prices immediately, so the cost of it being too short
 * is one extra round trip and the cost of it being too long is a signature over
 * numbers nobody has looked at recently.
 */
export const SEND_PLAN_TTL_MS = 2 * 60 * 1000;

/**
 * Bytes of entropy behind a plan handle. The id is not a secret in the sense a
 * key is — the send methods are default-denied to pages, so nothing outside the
 * popup can present one — but it is the only thing standing between a caller
 * and "sign the plan you have cached", so it is drawn from the CSPRNG rather
 * than counted up.
 */
const PLAN_ID_BYTES = 16;

/** One sentence, one place: what a user is told when their plan has moved. */
const PLAN_STALE_MESSAGE =
  'The transaction changed since you reviewed it. Check the details and confirm again.';

export interface KeyringOptions {
  network?: BtqNetwork;
  lockAfterMs?: number;
  now?: () => number;
  randomBytes?: (n: number) => Uint8Array;
  encrypt?: EncryptOptions;
}

export type { BackupKind, KeyringStatus } from './types.js';

/**
 * What `create` hands back: the phrase of a wallet that is *already sealed*, and
 * the positions its confirmation gate will ask for. The words are shown once,
 * here, and are never held by the worker afterwards — Settings → Security
 * regenerates them from the vault when the user asks again.
 */
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

/**
 * How wide a scan reaches. `'active'` is the routine refresh — the account the
 * user is looking at; `'all'` is every account the user has *created*, which is
 * what the switcher asks for when it opens and what a full rescan implies.
 * There is no third value: a scan never reaches an account that does not exist
 * on this device.
 */
export type ScanScope = 'active' | 'all';

/**
 * The per-account fields a scan is allowed to write. Deliberately a type and
 * not `Partial<AccountRecord>`: `index`, `name` and the account's membership of
 * the list are the user's, and a scan that could name them is a scan that can
 * silently undo a rename. `full` records which kind of pass produced them, so
 * the merge knows whether it may move a cursor backwards — with `internalNext`
 * the standing exception, because the wallet moves that one itself and no
 * explorer can vouch for it in time (see `commitScan`).
 */
interface ScanCursors {
  full: boolean;
  externalNext: number;
  internalNext: number;
  usedExternal: number;
  usedInternal: number;
  scannedExternal: number;
  scannedInternal: number;
  address: string | null;
}

/**
 * The plan behind one review card, and everything needed to decide whether it
 * still describes the transaction it described when it was drawn.
 *
 * It never leaves this object. `prepareSend` hands out `id` and a summary; the
 * plan itself — which outpoints are about to be spent, which key signs each of
 * them — is worker-side state, because a popup that could name the inputs could
 * also choose them.
 */
interface PendingPlan {
  id: string;
  plan: SendPlan & { changeIndex: number; account: number };
  /**
   * The account the plan debits, decided when it was built. `confirmSend`
   * compares it against its own pin: a preview of one account confirmed while
   * another is active is a refusal, never a retargeted debit.
   */
  account: number;
  createdAt: number;
}

/**
 * What the review card is drawn from, plus the handle that signs it. Every
 * number here is read off the *stored* plan, so the card and the signature are
 * two views of one object rather than two computations that happen to agree.
 */
export interface SendPlanSummary {
  /** Opaque handle into worker-side state. Meaningless anywhere else. */
  planId: string;
  destination: string;
  amount: string;
  fee: string;
  change: string;
  inputs: number;
  feeRateSatPerKvB: number;
  vsize: number;
  weight: number;
}

/** The balance half, committed after the UTXO sweep, with its own timestamp. */
interface ScanBalance {
  lastBalanceSats: string;
  confirmedBalanceSats: string;
  balanceAt: number;
}

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
  private lastActivity = 0;
  private failedUnlocks = 0;
  private unlockBlockedUntil = 0;
  /**
   * Last-known active HD account. Updated synchronously on switch/create so
   * `confirmSend` can pin it *before* the password KDF yields — a concurrent
   * switch must not retarget a send the user already reviewed.
   */
  private activeIndex = 0;
  /**
   * The plan the review card on screen is showing, if there is one.
   *
   * Single-slot: a wallet previews one send at a time, and a second preview
   * replaces the first rather than leaving two confirmable plans behind. In
   * memory only, like everything else here — a worker teardown between Review
   * and Sign costs one `PLAN_STALE` and a re-price, which is exactly what the
   * user should get for a card whose numbers this build can no longer vouch
   * for.
   */
  private pendingPlan: PendingPlan | null = null;
  /**
   * Serialises every read-modify-write of `WalletMeta` (`updateMeta`). Storage
   * is async, so two handlers that each load, mutate and save can interleave
   * and the second write silently discards the first — which is how a scan in
   * flight used to revert an account switch the user had already made, leaving
   * the header on one account and the next send debiting another. Chaining the
   * critical sections is what makes each one atomic; scoping the scan only made
   * the window shorter.
   */
  private metaLock: Promise<unknown> = Promise.resolve();
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
    // The confirmation gate, read from storage rather than from this object.
    // That is the whole repair: it has to survive the worker being torn down
    // while the user is copying twelve words onto paper, and no field here can.
    // Only ever reported alongside a vault — a challenge with nothing sealed
    // behind it is not a gate, it is a leftover.
    const confirmChallenge = vault === null ? null : (meta?.confirmChallenge ?? null);
    return {
      hasVault: vault !== null,
      unlocked: this.hdSeed !== null,
      awaitingConfirm: confirmChallenge !== null,
      confirmChallenge,
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
              balanceAt: a.balanceAt,
              address: a.address,
            })),
    };
  }

  /**
   * Create a wallet: generate a phrase, **seal the vault with it now**, and hand
   * back the words together with the positions the user will be asked to type
   * back.
   *
   * The seal happens here and not in `confirm`, and that is the entire point.
   * The password is already in hand, and between showing the words and checking
   * them the service worker receives no events whatsoever — the popup is only
   * rendering. Chrome ends an idle MV3 worker after about thirty seconds, which
   * is less time than it takes to write twelve words down properly, so anything
   * held in memory across that gap is gone. The old design held the whole
   * mnemonic there: `confirm` woke up on a fresh object, found nothing pending
   * and refused to seal a wallet whose twelve words were still on screen, which
   * made careful users the only ones who could not finish setting up.
   *
   * A keepalive port would only have narrowed that window — Chrome closes the
   * popup on blur, so opening a text editor to write the phrase down kills the
   * popup and the port together. Sealing first removes it: the vault exists
   * before this returns, the challenge becomes a gate over a wallet that already
   * exists, and a worker death mid-way costs the user nothing.
   *
   * This is only safe because the phrase can be read back. `revealPhrase` shows
   * it at Settings → Security, behind this same password, on this same sealed
   * vault — so someone who abandons the challenge still owns a wallet and can
   * still get their words. Before that landed, this design would have been a
   * trap: a sealed wallet whose phrase nobody could ever see again.
   */
  async create(password: string): Promise<Reveal> {
    this.maybeAutoLock();
    assertPassword(password);
    if (await this.storage.loadVault()) {
      throw new WalletError('ALREADY_EXISTS', 'A wallet already exists on this device. Remove it first.');
    }
    this.lock();
    const mnemonic = generateMnemonic(128);
    const challenge = pickChallengeIndices(12, 3, this.opts.randomBytes);
    // Entropy into a local first: inlining it as the 4th argument would
    // evaluate the seed first, and a throw would then strand an un-wiped
    // 64-byte HD seed that never reaches seal()'s finally.
    const entropy = mnemonicToEntropy(mnemonic);
    await this.seal(mnemonicToHdSeed(mnemonic), password, 'bip39', entropy, challenge);
    return { mnemonic, challenge };
  }

  /**
   * The phrase-confirmation gate, over a vault that already exists.
   *
   * It proves two things and seals nothing: that the password opens this vault,
   * and that the words typed back are the ones it holds. The words are
   * regenerated from the vault's own entropy for the comparison and let go —
   * the same mechanism `revealPhrase` uses, and the reason this survives a
   * service-worker restart. Everything it needs is on disk; the password is the
   * only key to it, and the caller has just supplied one.
   *
   * A correct password installs the seed on the way through, so a user who ends
   * up confirming on a restarted worker lands on an open wallet instead of an
   * unlock screen. A wrong password costs the same back-off as a wrong unlock.
   * A wrong *word* costs nothing and leaves the challenge standing: the wallet
   * it guards is already sealed, so there is nothing to punish.
   */
  async confirm(answers: { index: number; word: string }[], password: string): Promise<void> {
    this.maybeAutoLock();
    assertPassword(password);
    if (!(await this.storage.loadVault())) {
      throw new WalletError('NO_VAULT', 'No wallet on this device.');
    }
    const challenge = (await this.walletMeta()).confirmChallenge;
    if (!challenge) {
      throw new WalletError('NO_PENDING', 'This wallet has no phrase waiting to be confirmed.');
    }
    const plain = await this.openVault(password);
    let entropy: Uint8Array | undefined;
    try {
      const payload = decodePayload(plain);
      if (payload.entropyHex === undefined) {
        // Only a create can raise a challenge, and a create always seals
        // entropy — so this is our own bug, never a user's, and it says so
        // rather than quietly passing a gate it cannot check.
        throw new WalletError('NO_PHRASE', NO_PHRASE_MESSAGE);
      }
      entropy = hexToBytes(payload.entropyHex);
      checkChallenge(challenge, entropyToMnemonic(entropy).split(' '), answers);
      this.installSeed(payload);
    } finally {
      if (entropy) wipeBytes(entropy);
      wipePlaintext(plain);
    }
    await this.updateMeta((meta) => {
      meta.confirmChallenge = null;
    });
    this.touch();
  }

  /**
   * Leave the confirmation challenge without passing it.
   *
   * Deliberately possible, and deliberately explicit. The vault is already
   * sealed, so walking away costs the user nothing — and a screen with no way
   * off it is how people end up photographing their phrase to get past it. What
   * this does not do is claim the phrase was confirmed: it drops the outstanding
   * challenge and nothing else, and the words stay readable at Settings →
   * Security behind the password.
   *
   * Unlocked-only, so a locked popup cannot quietly clear the reminder.
   */
  async dismissConfirm(): Promise<void> {
    this.requireUnlocked();
    await this.updateMeta((meta) => {
      meta.confirmChallenge = null;
    });
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
    const plain = await this.openVault(password);
    try {
      this.installSeed(decodePayload(plain));
      // A restarted worker defaults activeIndex to 0; restore the persisted
      // account before any confirmSend can pin the wrong one.
      await this.walletMeta();
      this.touch();
    } finally {
      wipePlaintext(plain);
    }
  }

  lock(): void {
    if (this.hdSeed) {
      wipeBytes(this.hdSeed);
      this.hdSeed = null;
    }
    this.phraseAvailable = false;
    this.payloadOrigin = null;
    this.lastActivity = 0;
    // A locked wallet has no reviewed transaction waiting to be signed. Dropped
    // here rather than checked at confirm time so that a plan cannot survive an
    // auto-lock and be confirmed by whoever unlocks next.
    this.forgetPlan();
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
    // The cached address is only ever a mirror of the cursor, so the write is
    // skipped when it already agrees — but the read and the write are still one
    // critical section, or a concurrent switch lands between them and this
    // caches the wrong account's address.
    return this.withMetaLock(async () => (await this.activeReceive()).derived);
  }

  /**
   * The active account's receive address, together with *which* account that
   * was — one read, one answer.
   *
   * **The meta lock must already be held.** `withMetaLock` is not reentrant, so
   * this deliberately does not take it: callers that need the address and one
   * more fact about the same account (`approveConnect` needs to record a grant
   * against it) take the lock once and get a single consistent answer, instead
   * of asking "which account?" and "what is its address?" as two questions with
   * a switch free to land in between.
   */
  private async activeReceive(): Promise<{ derived: DerivedAddress; account: number }> {
    const meta = await this.walletMeta();
    const rec = activeRecord(meta);
    const derived = this.receiveAt(rec.externalNext, rec.index);
    if (rec.address !== derived.address) {
      rec.address = derived.address;
      mirrorActive(meta);
      await this.storage.saveMeta(meta);
    }
    return { derived, account: rec.index };
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
    const created = await this.updateMeta((meta) => {
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
      return { index: rec.index, name: rec.name, address: rec.address };
    });
    // A review card describes one account's coins. Changing which account is
    // active is the user saying "not that one", so the plan goes with it.
    this.forgetPlan();
    this.touch();
    return created;
  }

  async switchAccount(index: number): Promise<{ index: number; name: string; address: string }> {
    this.requireUnlocked();
    if (!Number.isInteger(index) || index < 0 || index >= MAX_ACCOUNTS) {
      throw new WalletError('BAD_PARAMS', 'Unknown account.');
    }
    const switched = await this.updateMeta((meta) => {
      const rec = meta.accounts.find((a) => a.index === index);
      if (!rec) throw new WalletError('BAD_PARAMS', 'Unknown account.');
      meta.activeAccount = rec.index;
      this.activeIndex = rec.index;
      if (!rec.address) rec.address = this.addressAt('external', rec.externalNext, rec.index).address;
      return { index: rec.index, name: rec.name, address: rec.address };
    });
    // See `createAccount`. A confirmation already in flight is unaffected: it
    // took its plan and its account pin synchronously, before it awaited the
    // password, so this expires the card on screen and nothing else.
    this.forgetPlan();
    this.touch();
    return switched;
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
    const renamed = await this.updateMeta((meta) => {
      const rec = meta.accounts.find((a) => a.index === index);
      if (!rec) throw new WalletError('BAD_PARAMS', 'Unknown account.');
      rec.name = trimmed;
      return { index: rec.index, name: rec.name };
    });
    this.touch();
    return renamed;
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
    const plain = await this.openVault(password);
    this.touch();
    return plain;
  }

  /**
   * Decrypt the sealed vault with `password`, or refuse — the one place a
   * password is ever checked against the blob, and therefore the one place the
   * unlock back-off is charged.
   *
   * Returns the plaintext; the caller owns it and MUST wipe it. It installs
   * nothing: a correct password here does not by itself open a locked wallet,
   * which is what lets `revealPhrase` re-prove a password without changing the
   * lock state, and what lets `confirm` run on a worker that has just restarted.
   */
  private async openVault(password: string): Promise<Uint8Array> {
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
    return plain;
  }

  /** Install a decrypted payload as the open vault. The only writer of `hdSeed`
   * besides `seal`, which has the raw bytes rather than a payload. */
  private installSeed(payload: VaultPayload): void {
    this.hdSeed = hexToBytes(payload.hdSeedHex);
    this.phraseAvailable = payload.entropyHex !== undefined;
    this.payloadOrigin = payload.origin;
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
    try {
      const payload = decodePayload(plain);
      this.assertSealedSeedIsLive(payload.hdSeedHex);
      return { seedHex: payload.hdSeedHex };
    } finally {
      wipePlaintext(plain);
    }
  }

  /**
   * Hold "the sealed seed" and "the seed this wallet derives from" together.
   *
   * Every backup this wallet hands out passes through here first — the hex on
   * screen and the bytes in an exported file — for one reason: a backup that
   * restores a *different* wallet is worse than no backup, because the user
   * trusts it and loses their coins to it. It costs about a millisecond next to
   * the 600 000-round password check that got the caller this far, so it is free.
   *
   * Plain loop compare, not a constant-time one, and deliberately: both sides
   * are our own material out of one authenticated ciphertext, there is no
   * attacker input and no oracle, and the caller already proved the password.
   */
  private assertSealedSeedIsLive(hdSeedHex: string): void {
    const live = this.hdSeed;
    if (!live) throw new WalletError('LOCKED', 'Wallet is locked.');
    const stored = hexToBytes(hdSeedHex);
    try {
      let same = stored.length === live.length;
      if (same) {
        for (let i = 0; i < stored.length; i++) {
          if (stored[i] !== live[i]) same = false;
        }
      }
      if (!same) {
        throw new WalletError('NOT_A_VAULT', 'The sealed seed is not the seed this wallet is using.');
      }
    } finally {
      wipeBytes(stored);
    }
  }

  /**
   * Write the wallet backup file: the account list a phrase cannot carry,
   * sealed beside the seed under the same password.
   *
   * ### Why there is an export at all, when there deliberately was not
   *
   * The old rule was that `reveal` means "on this screen, now", and the wallet
   * writes nothing to a file, because a file leaves the machine, gets synced,
   * and outlives the vault it came from. That rule was about *plaintext* — the
   * phrase and the seed are still never written anywhere. What leaves here is
   * the `BTQ1` envelope, PBKDF2-SHA256 and AES-256-GCM, the same sealing the
   * on-disk vault already has, so the artefact is exactly as strong as the vault
   * it came from and the line falls where it should: cleartext never, ciphertext
   * when the user asks for it. The warning that motivated the old rule did not
   * stop being true; it moved to the copy beside the button.
   *
   * What made it necessary is upstream. Deleting speculative account discovery
   * left the account list with no recovery path, and no phrase can be given one,
   * so either the wallet hands the user something to keep or "write down how
   * many accounts you made" is the whole of the backup story.
   *
   * ### The discipline is the reveals' discipline, unchanged
   *
   * Unlocked or refuse; the password re-proved against the sealed vault through
   * `reauthPlaintext`, sharing the unlock back-off in both directions; a wrong
   * one names nothing but the password; unreachable from a page, because
   * `dispatch` refuses every `wallet.*` method to a tab before it looks at the
   * name. Both plaintexts — the vault's and the backup's — are wiped on the way
   * out, including when the seal throws.
   *
   * It re-seals rather than copying the bytes already on disk, and it has to:
   * the vault payload holds key material only. The account list lives in
   * `WalletMeta`, which is rewritten every time an account is added, renamed or
   * switched — none of which has the password to hand.
   */
  async exportBackup(password: string): Promise<{ fileName: string; backupHex: string }> {
    const plain = await this.reauthPlaintext(password);
    let body: Uint8Array | undefined;
    try {
      const payload = decodePayload(plain);
      this.assertSealedSeedIsLive(payload.hdSeedHex);
      const meta = await this.walletMeta();
      body = encodeBackup({
        b: BACKUP_VERSION,
        network: payload.network,
        origin: payload.origin,
        hdSeedHex: payload.hdSeedHex,
        // Conditional spread for the reason `seal()` uses one: an explicit
        // `undefined` survives as a key and serialises to `null`, which the
        // decoder on the other side refuses.
        ...(payload.entropyHex === undefined ? {} : { entropyHex: payload.entropyHex }),
        // Index and name, and nothing else. A balance is stale the moment it is
        // written and a cursor is re-found in one scan; the address is derived.
        accounts: meta.accounts.map((a) => ({ index: a.index, name: a.name })),
        activeAccount: meta.activeAccount,
      });
      const blob = await encryptVault(body, password, this.opts.encrypt);
      return { fileName: backupFileName(this.now()), backupHex: bytesToHex(blob) };
    } finally {
      if (body) wipePlaintext(body);
      wipePlaintext(plain);
    }
  }

  /**
   * Restore a wallet from a backup file — the third door onto a device with no
   * vault, beside a phrase and a raw seed, and the only one that brings the
   * account list with it.
   *
   * **It asks the chain nothing.** The accounts come out of the file, names and
   * all, so the restore itself costs zero explorer requests. That is the entire
   * point of having a file rather than a guess, and
   * `tests/security/scan-privacy.test.ts` asserts the zero. What happens after
   * it is the ordinary refresh of the account on screen, exactly as on any open.
   *
   * The file is treated as hostile input even though AES-GCM authenticated it,
   * because on this path the person who sealed it may be the person who handed
   * it over: `decodeBackup` bounds the indices, caps the list and strips the
   * names through the same filter the storage layer uses.
   *
   * There is no unlock back-off here, and none is missing: there is no vault on
   * this device to throttle access to, and anybody holding the file can guess
   * against their own copy as fast as their hardware allows. PBKDF2 is what
   * stands in that place, exactly as it does for the vault blob.
   */
  async importBackup(backupHex: string, password: string): Promise<{ accounts: number[] }> {
    this.maybeAutoLock();
    assertPassword(password);
    if (await this.storage.loadVault()) {
      throw new WalletError('ALREADY_EXISTS', 'A wallet already exists on this device. Remove it first.');
    }
    if (typeof backupHex !== 'string' || backupHex.length > MAX_BACKUP_BYTES * 2) {
      throw notABackupFile();
    }
    let blob: Uint8Array;
    try {
      blob = hexToBytes(backupHex);
    } catch {
      throw notABackupFile();
    }
    let plain: Uint8Array;
    try {
      plain = await decryptVault(blob, password);
    } catch (e) {
      // `NOT_A_VAULT` is the envelope's own "these bytes are not ours", and on
      // this screen the bytes are a file the user picked — so say it in terms of
      // the thing they picked. `WRONG_PASSWORD` passes through untouched: the
      // two failures send a user to opposite corners of the room and must never
      // be spelled the same.
      if (e instanceof WalletError && e.code === 'NOT_A_VAULT') throw notABackupFile();
      throw e;
    }
    let backup: BackupPayload;
    try {
      backup = decodeBackup(plain);
    } finally {
      wipePlaintext(plain);
    }
    if (backup.network !== this.network) {
      throw new WalletError(
        'WRONG_NETWORK',
        `That backup is for ${backup.network}. This wallet is ${this.network} only.`,
      );
    }
    const seed = hexToBytes(backup.hdSeedHex);
    const entropy = backup.entropyHex === undefined ? undefined : hexToBytes(backup.entropyHex);
    // `seal` wipes both buffers on its way out, whether it succeeded or threw,
    // and writes a fresh one-account meta; the list goes on top of it below.
    await this.seal(seed, password, backup.origin, entropy);
    // Derived outside the lock: `updateMeta`'s body is a critical section, and
    // twenty ML-DSA derivations inside one would park every other meta write
    // behind them.
    const records = backup.accounts.map((a) => {
      const rec = emptyAccount(a.index);
      rec.name = a.name;
      rec.address = this.addressAt('external', 0, a.index).address;
      return rec;
    });
    const accounts = await this.updateMeta((meta) => {
      meta.accounts = records.map((r) => ({ ...r }));
      meta.activeAccount = backup.activeAccount;
      this.activeIndex = meta.activeAccount;
      return meta.accounts.map((a) => a.index);
    });
    return { accounts };
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

  /**
   * One past the highest change index this wallet has paid that the chain
   * cannot vouch for yet — the floor a full rescan may not take `internalNext`
   * below. Zero when nothing of ours is in flight, which is the ordinary case,
   * and that zero is what makes "Rescan all addresses" mean what it says.
   *
   * **A row has to prove its claim.** `changeIndex` is a number in extension
   * storage, and whatever can write there could write a large one and pin the
   * cursor high for good — the exact wedge this floor exists to keep
   * repairable. So an index only counts once the row's own signed bytes are
   * seen to pay the address *this seed* derives at it, which nobody without the
   * seed can arrange. A forged row names an address we do not derive, proves
   * nothing, and holds nothing up.
   *
   * Highest claim first, stopping at the first that proves itself: only the
   * highest proven index can set the floor, so nothing under it is worth a
   * derivation. The walk is bounded by `MAX_ACTIVITY`, which `parseActivity`
   * enforces on the way in.
   */
  private async inFlightChangeNext(account: number): Promise<number> {
    const rows = (await this.storage.loadActivity()).filter(
      (a) =>
        (a.accountIndex ?? 0) === account &&
        // Confirmed is the chain's own answer, which the pass being floored has
        // just read from the explorer itself. Nothing left for us to add.
        a.status !== 'confirmed' &&
        a.changeIndex !== undefined &&
        a.hex !== undefined,
    );
    const claims = [...new Set(rows.map((a) => a.changeIndex as number))].sort((x, y) => y - x);
    for (const index of claims.slice(0, MAX_ACTIVITY)) {
      const address = this.addressAt('internal', index, account).address;
      const proved = rows.some(
        (a) =>
          a.changeIndex === index &&
          outputAddressesOfSignedHex(a.hex as string, this.network).includes(address),
      );
      if (proved) return index + 1;
    }
    return 0;
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

  /**
   * Build the plan the review card describes, keep it here, and hand back a
   * handle to it.
   *
   * The summary is what the user reads; `planId` is what `confirmSend` signs.
   * They are the same object, which is the whole point — this call used to
   * return a flattened copy and throw the plan away, and `confirmSend` then
   * built a *second* plan from a UTXO set that had moved on and signed that
   * one. Fee, inputs and change could all differ from the card, and because
   * this call previewed whatever account was active while `confirmSend` pinned
   * its own, a switch between the two screens previewed one account and debited
   * another.
   *
   * Only the handle crosses the worker boundary. A plan carries the outpoints
   * that are about to be spent, and a popup that could name them could pick
   * them; the id is a lookup into this object and is useless anywhere else.
   */
  async prepareSend(opts: {
    destination: string;
    amountSats: bigint;
    fetchUtxos: FetchUtxos;
    feeRateSatPerKvB?: number;
  }): Promise<SendPlanSummary> {
    this.requireUnlocked();
    const rate = assertFeeRate(opts.feeRateSatPerKvB ?? MIN_RELAY_SAT_PER_KVB);
    // One review at a time. Dropped before the build, not after: if this throws
    // (dust, insufficient, a bad address) the user is looking at an error, and
    // the plan they were shown before it is not one they can still confirm.
    this.forgetPlan();
    const plan = await this.buildPlan(opts.destination, opts.amountSats, opts.fetchUtxos, rate);
    const id = bytesToHex(this.randomBytes(PLAN_ID_BYTES));
    this.pendingPlan = {
      id,
      plan,
      account: plan.account,
      createdAt: this.now(),
    };
    return {
      planId: id,
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

  /** Drop the plan on the review card. Cheap, idempotent, and never throws. */
  private forgetPlan(): void {
    this.pendingPlan = null;
  }

  private randomBytes(n: number): Uint8Array {
    return this.opts.randomBytes?.(n) ?? crypto.getRandomValues(new Uint8Array(n));
  }

  /**
   * The plan is only as good as the coins under it. Between the review card and
   * the password, a UTXO can confirm, be spent by another device sharing the
   * seed, or be committed by an earlier send of ours — and a plan that spends a
   * coin that has moved is either an invalid transaction or a replacement of a
   * payment already in flight. Every stored input has to still be there, still
   * be ours, and still be worth exactly what the fee was computed against: the
   * sighash commits to the input value, so a changed one signs nothing valid.
   */
  private async revalidatePlan(held: PendingPlan, fetchUtxos: FetchUtxos): Promise<void> {
    const live = new Map(
      (await this.gatherUtxos(fetchUtxos, held.account)).map((u) => [outpointKey(u), u]),
    );
    for (const input of held.plan.inputs) {
      const now = live.get(outpointKey(input));
      if (
        !now ||
        now.value !== input.value ||
        now.address !== input.address ||
        !bytesEqual(now.script, input.script)
      ) {
        throw new WalletError('PLAN_STALE', PLAN_STALE_MESSAGE);
      }
    }
  }

  /**
   * Plan construction, in one place and with exactly one caller. It reads the
   * *persisted* active account and reports which one it built for, so the
   * account a plan debits is a property of the plan rather than of whatever is
   * active when it is signed.
   */
  private async buildPlan(
    destination: string,
    amountSats: bigint,
    fetchUtxos: FetchUtxos,
    feeRateSatPerKvB: number,
  ): Promise<SendPlan & { changeIndex: number; account: number }> {
    const meta = await this.walletMeta();
    const rec = activeRecord(meta);
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

  /**
   * Sign and broadcast the plan the user reviewed — that plan, not one like it.
   *
   * `planId` is the handle `prepareSend` returned. There is no destination and
   * no amount on this call: everything that ends up in the bytes was fixed when
   * the review card was drawn, so a popup cannot change what is signed after
   * the user has read it, and nothing here rebuilds a plan the user never saw.
   * Anything that cannot be resolved to the reviewed plan is `PLAN_STALE` and
   * signs nothing at all.
   */
  async confirmSend(opts: {
    planId: string;
    password: string;
    fetchUtxos: FetchUtxos;
    broadcast: Broadcast;
    now?: number;
  }): Promise<ConfirmSendResult> {
    // Both of these are read *synchronously*, before reauth yields on the KDF.
    // The header switcher stays clickable while the popup shows "Signing…";
    // without the pin a concurrent switch would debit a different account than
    // the one whose UTXOs and fee the user just reviewed, and without taking
    // the plan in the same breath that switch would expire the plan out from
    // under a confirmation that had already been consented to.
    const account = this.activeIndex;
    const held = this.pendingPlan;
    await this.reauth(opts.password);
    const seed = this.requireUnlocked();
    if (!held || held.id !== opts.planId) throw new WalletError('PLAN_STALE', PLAN_STALE_MESSAGE);
    // Belt and braces on top of expiring the plan on every switch: the pinned
    // account and the account the plan was *built* for must be the same one.
    if (held.account !== account) throw new WalletError('PLAN_STALE', PLAN_STALE_MESSAGE);
    // The card quoted a fee rate as well as a fee; both go stale.
    if (this.now() - held.createdAt > SEND_PLAN_TTL_MS) {
      this.forgetPlan();
      throw new WalletError('PLAN_STALE', PLAN_STALE_MESSAGE);
    }
    // One shot. Taken before signing, so a refusal below cannot leave a handle
    // behind that would sign the same coins twice.
    if (this.pendingPlan?.id === held.id) this.forgetPlan();
    await this.revalidatePlan(held, opts.fetchUtxos);
    const plan = held.plan;
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
    // Only when there is one. A send with no change consumed no internal index,
    // and a row claiming one would be claiming something its own bytes cannot
    // back up — see `inFlightChangeNext`, which would refuse it.
    if (plan.change > 0n) item.changeIndex = plan.changeIndex;
    const prev = await this.storage.loadActivity();
    await this.storage.saveActivity([item, ...prev].slice(0, MAX_ACTIVITY));
    if (plan.change > 0n) {
      await this.updateMeta((meta) => {
        const rec = meta.accounts.find((a) => a.index === plan.account);
        // The change cursor belongs to the account that produced the send, not
        // to whichever one is active by the time the broadcast comes back.
        if (rec) rec.internalNext = Math.max(rec.internalNext, plan.changeIndex + 1);
      });
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

  /**
   * Record the approval and answer with the address it was given for.
   *
   * The approval screen says "this site will see one address": the address of
   * the account that is active as the user clicks Connect. That is the pair
   * that is stored, so it is also the only pair this grant can ever answer —
   * and the address handed back has to come from the *same* `AccountRecord` the
   * grant was keyed on. It used to come from a second, separate read: the index
   * was taken once, then the address was fetched again after two storage
   * awaits, so a switch landing in that window recorded (origin, 0) and replied
   * with account 1's address. The site was handed an address of an account it
   * had never been approved for, and the grant it did hold answered `[]` from
   * then on. One critical section closes it; two locks would not, because the
   * hole was never inside either of them.
   */
  async approveConnect(origin: string): Promise<{ accounts: string[] }> {
    this.requireUnlocked();
    const o = canonicalOrigin(origin);
    return this.withMetaLock(async () => {
      const { derived, account } = await this.activeReceive();
      const allowed = grantSite(await this.storage.loadOrigins(), o, account);
      await this.storage.saveOrigins(allowed);
      await this.storage.savePendingConnect(null);
      return { accounts: [derived.address] };
    });
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
   * Bring the wallet up to date with the chain.
   *
   * **A routine refresh walks the active account only.** Walking every known
   * account on every refresh cost one gap window per chain per account — ~40
   * address lookups each — sent to a public explorer whether or not anything
   * had changed. Other accounts are brought up to date when the user opens the
   * switcher (`accounts: 'all'`) and on the explicit full rescan, and until then
   * the switcher prints each balance next to how old it is rather than passing
   * a stale number off as current.
   *
   * **Nothing here probes an account the user has not created.** An earlier
   * build walked `ACCOUNT_GAP_LIMIT` accounts past the highest one it knew, to
   * try to rediscover accounts after a restore. That is a category error: the
   * account list is *metadata*, not key material, and it was being recovered by
   * interrogating a third party. It could not work either — its own note admits
   * an account that never received coins leaves nothing on any chain to find —
   * and the price of the attempt was ~40 addresses of accounts that may never
   * have existed, handed to a public explorer, where the query itself binds
   * unused addresses of one wallet together in that explorer's logs before any
   * of them is used, and discloses how far along each chain the wallet is. The
   * recovery path that does work is deterministic and needs no network at all:
   * press **Add account**, and the same seed re-derives the same addresses, so
   * the coins reappear (`tests/security/scan-privacy.test.ts` pins it).
   *
   * The reported balance is the sum of `/utxos` over the derived addresses —
   * never the explorer's own `balance` field, which the live indexer reports as
   * negative for busy addresses (tests/fixtures/explorer/address-used.json).
   */
  async scan(
    lookup: AddressLookup,
    fetchUtxos?: FetchUtxos,
    tip?: ChainTip | null,
    opts: { full?: boolean; accounts?: ScanScope } = {},
  ): Promise<{
    external: ChainScan;
    internal: ChainScan;
    usedExternal: number;
    usedInternal: number;
    totalBalanceSats: bigint;
    confirmedBalanceSats: bigint;
    tipHeight: number | null;
    lastScanAt: number;
    /** Accounts this pass actually queried the explorer about. */
    scannedAccounts: number[];
  }> {
    this.requireUnlocked();
    const full = opts.full === true;
    // "Re-read everything" implies every account; the switcher asks for every
    // account without paying the from-index-0 cost.
    const scope: ScanScope = full ? 'all' : (opts.accounts ?? 'active');

    // This snapshot decides *what* to scan and nothing more. Not one field of
    // it is written back: everything the pass learns is merged into a freshly
    // loaded record at commit time, so a switch, an "Add account" or a rename
    // that lands while the lookups are in flight survives (see `commitScan`).
    const before = await this.walletMeta();
    const activeIndex = before.activeAccount;
    const targets = before.accounts
      .filter((a) => scope === 'all' || a.index === activeIndex)
      .sort((a, b) => a.index - b.index);

    let external: ChainScan | null = null;
    let internal: ChainScan | null = null;
    const cursors = new Map<number, ScanCursors>();
    for (const record of targets) {
      // A copy, because `scanAccount` mutates what it is handed and the
      // snapshot has to stay a snapshot.
      const working: AccountRecord = { ...record };
      const scanned = await this.scanAccount(working, lookup, full);
      cursors.set(working.index, {
        full,
        externalNext: working.externalNext,
        internalNext: working.internalNext,
        usedExternal: working.usedExternal,
        usedInternal: working.usedInternal,
        scannedExternal: working.scannedExternal,
        scannedInternal: working.scannedInternal,
        address: working.address,
      });
      if (working.index === activeIndex) {
        external = scanned.external;
        internal = scanned.internal;
      }
    }

    const lastScanAt = this.now();
    // Cursors first, so the UTXO sweep below covers every address this walk
    // just opened up: `gatherUtxos` reads the *stored* cursor, not this one.
    let meta = await this.commitScan(cursors, new Map(), { tipHeight: tip?.height ?? null, lastScanAt });

    const settled = meta.accounts.find((a) => a.index === activeIndex);
    let totalBalanceSats = BigInt(settled?.lastBalanceSats ?? '0');
    let confirmedBalanceSats = BigInt(settled?.confirmedBalanceSats ?? '0');
    if (fetchUtxos) {
      const balances = new Map<number, ScanBalance>();
      for (const index of cursors.keys()) {
        // Nothing here creates an account, so an index that is no longer in the
        // stored list is simply skipped rather than resurrected.
        if (!meta.accounts.some((a) => a.index === index)) continue;
        const b = await this.balances(fetchUtxos, index);
        balances.set(index, {
          lastBalanceSats: b.totalSats.toString(),
          confirmedBalanceSats: b.confirmedSats.toString(),
          balanceAt: this.now(),
        });
        if (index === activeIndex) {
          totalBalanceSats = b.totalSats;
          confirmedBalanceSats = b.confirmedSats;
        }
      }
      meta = await this.commitScan(new Map(), balances, {});
    }

    this.touch();
    const rec = meta.accounts.find((a) => a.index === activeIndex);
    // The cursors the wallet is actually deriving from, not this pass's raw
    // reading of them: `commitScan` floors `internalNext` at our own in-flight
    // change, so the walk's own number can be lower than the one every other
    // caller sees. `wallet.scan` reports these to the popup, and a cursor
    // nothing in the wallet uses is not a number worth reporting.
    const reported = (chain: Chain, pass: ChainScan | null, next: number): ChainScan =>
      pass ? { ...pass, nextIndex: next } : emptyChainScan(chain, next);
    return {
      external: reported('external', external, rec?.externalNext ?? 0),
      internal: reported('internal', internal, rec?.internalNext ?? 0),
      usedExternal: rec?.usedExternal ?? 0,
      usedInternal: rec?.usedInternal ?? 0,
      totalBalanceSats,
      confirmedBalanceSats,
      tipHeight: meta.tipHeight,
      lastScanAt,
      scannedAccounts: [...cursors.keys()],
    };
  }

  /**
   * Write back what a scan learned — and only what a scan learned.
   *
   * A scan owns facts about the chain: per-account gap cursors, used counts,
   * the cached receive address that follows the cursor, the balance and the
   * moment it was read, plus the tip height and the time of the pass. It owns
   * none of the user's choices — which accounts exist, which one is active,
   * what they are called — and none of those is assignable below, so a scan
   * that began before a switch, an "Add account" or a rename cannot undo any of
   * them. The record is re-read *inside the lock* and the scan's fields are laid
   * on top of whatever the user did in the meantime; an index that is no longer
   * in the list is skipped, because a scan never creates an account.
   */
  private async commitScan(
    cursors: Map<number, ScanCursors>,
    balances: Map<number, ScanBalance>,
    top: { tipHeight?: number | null; lastScanAt?: number },
  ): Promise<WalletMeta> {
    return this.withMetaLock(async () => {
      // Read on this side of the lock, and only for a pass that can lower a
      // cursor. `confirmSend` writes its activity row *before* it takes this
      // lock to move the cursor, so both orders come out right: either it had
      // the lock first and this read sees its row, or this pass had the lock
      // first and its bump lands afterwards, on top of whatever this pass
      // wrote. Reading the rows outside the lock is the one order that loses —
      // the row written after the read, the bump before the write.
      const floors = new Map<number, number>();
      for (const [index, c] of cursors) {
        if (c.full) floors.set(index, await this.inFlightChangeNext(index));
      }
      return this.applyMeta((meta) => {
        for (const [index, c] of cursors) {
          const rec = meta.accounts.find((a) => a.index === index);
          if (!rec) continue;
          // A send that landed while the lookups were in flight has already moved
          // the change cursor past anything this pass saw; an incremental scan
          // must never walk a cursor backwards. A full rescan is the one pass
          // that is authoritative about where the chain really stops.
          const keep = (stored: number, scanned: number) => (c.full ? scanned : Math.max(stored, scanned));
          rec.externalNext = keep(rec.externalNext, c.externalNext);
          rec.usedExternal = keep(rec.usedExternal, c.usedExternal);
          rec.usedInternal = keep(rec.usedInternal, c.usedInternal);
          rec.scannedExternal = keep(rec.scannedExternal, c.scannedExternal);
          rec.scannedInternal = keep(rec.scannedInternal, c.scannedInternal);
          // …and `internalNext` is the one cursor this wallet advances by itself,
          // so "the chain says lower" gets a second look here. `confirmSend`
          // moves it past the change address it has just paid, ahead of anything
          // an explorer can confirm: that output is unindexed while the
          // transaction sits in a mempool, and if the broadcast failed it is not
          // on the chain at all. A walk therefore reads the address as unused and
          // reports a *lower* stop — which is not "the chain says lower", it is
          // "I did not look recently enough to know". Taking that verbatim sent
          // the next send's change straight back to the address the previous one
          // already paid: two change outputs of two transactions on one address,
          // publicly and permanently linking them.
          //
          // Refusing to lower it at all was the wrong shape of fix, because a
          // cursor that is too high is not free. `eachAddress` walks
          // 0..internalNext *inclusive*: at 300 that is 302 explorer lookups and
          // 302 ML-DSA derivations on every `gatherUtxos` — so on every balance,
          // every history and every send — and it hands the explorer 302
          // addresses instead of the handful in use. An explorer that answers
          // "used" too freely drives it towards GAP_MAX_INDEX, and anything that
          // can write extension storage sets it outright (see `parseMeta`), so a
          // cursor that only ever rises is a wedge either of them can leave in
          // for good. "Rescan all addresses" has to be able to pull it back out.
          //
          // So a full pass is authoritative here too, floored by the one thing
          // the explorer cannot know and we can: the change indices of our own
          // sends it has not confirmed yet. That floor is *proved* against those
          // rows' signed bytes rather than believed (`inFlightChangeNext`), so the
          // storage writer who can set the cursor cannot also forge the thing
          // that would pin it. With nothing in flight the floor is 0, and the
          // rescan says exactly what the chain says.
          rec.internalNext = c.full
            ? Math.max(c.internalNext, floors.get(index) ?? 0)
            : Math.max(rec.internalNext, c.internalNext);
          // The cached address is the address *at* the cursor. If the merge kept
          // a cursor this pass never reached, the address it derived belongs to a
          // different index — leave the stored one, which `receiveAddress` will
          // re-derive under the same lock on its next call.
          if (rec.externalNext === c.externalNext) rec.address = c.address;
        }
        for (const [index, b] of balances) {
          const rec = meta.accounts.find((a) => a.index === index);
          if (!rec) continue;
          rec.lastBalanceSats = b.lastBalanceSats;
          rec.confirmedBalanceSats = b.confirmedBalanceSats;
          rec.balanceAt = b.balanceAt;
        }
        if (top.tipHeight != null) meta.tipHeight = top.tipHeight;
        if (top.lastScanAt != null) meta.lastScanAt = top.lastScanAt;
        return meta;
      });
    });
  }

  maybeAutoLock(): void {
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
   * Run one critical section against `WalletMeta` with nothing else touching it
   * in between.
   *
   * Every mutation of the stored metadata is a load-mutate-save across at least
   * two awaits, and the runtime is free to run another handler in the gap. Two
   * such sequences interleaved lose one of the two writes entirely: the loser is
   * whichever loaded first, and its edit is gone with no error anywhere. The
   * losses that mattered were the user's own — a switch, a new account, a rename
   * — thrown away by a scan that had loaded before the click.
   *
   * The body must not do network I/O. It holds the lock for its whole duration,
   * and an explorer call inside it would park every other meta write behind a
   * request that can take seconds or hang: a scan does its lookups first and
   * only then takes the lock to commit what it found.
   */
  private async withMetaLock<T>(body: () => Promise<T>): Promise<T> {
    // `catch(() => undefined)` and not the raw promise: a rejected predecessor
    // must not reject its successor, or one failed save would wedge the chain.
    const previous = this.metaLock.then(
      () => undefined,
      () => undefined,
    );
    const mine = previous.then(body);
    this.metaLock = mine.then(
      () => undefined,
      () => undefined,
    );
    return mine;
  }

  /**
   * Load the metadata, apply `edit`, write it back — atomically. `edit` is
   * synchronous by type, which is what keeps the lock short and makes it
   * impossible to await an explorer inside it.
   */
  private async updateMeta<T>(edit: (meta: WalletMeta) => T): Promise<T> {
    return this.withMetaLock(() => this.applyMeta(edit));
  }

  /**
   * The read-modify-write itself, **with the meta lock already held**. Split out
   * for the one caller that has to read something of its own inside the same
   * critical section — `commitScan`, whose floor has to be read on the same side
   * of the lock as the cursor it floors. Nothing that has not taken the lock may
   * call this.
   */
  private async applyMeta<T>(edit: (meta: WalletMeta) => T): Promise<T> {
    const meta = await this.walletMeta();
    const value = edit(meta);
    mirrorActive(meta);
    this.activeIndex = meta.activeAccount;
    await this.storage.saveMeta(meta);
    return value;
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
    confirmChallenge: number[] | null = null,
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
      // The challenge goes down in the same breath as the vault: a sealed wallet
      // that has forgotten it owes the user a confirmation would drop them
      // straight onto Home with twelve unwritten words behind them.
      await this.storage.saveMeta(emptyMeta(this.network, origin, confirmChallenge));
      this.hdSeed = new Uint8Array(hdSeed);
      this.phraseAvailable = entropy !== undefined;
      this.payloadOrigin = origin;
      this.activeIndex = 0;
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
}

/**
 * Check the typed-back words against the challenge, or throw.
 *
 * One sentence for every way of getting it wrong — a short answer, a word from
 * the wrong position, a position that is not in the challenge at all — because a
 * refusal that named which one would tell a guesser where to spend their next
 * try. `seen` is what stops one correct word being pasted into all three fields:
 * a challenge satisfied that way proves the user wrote down a twelfth of their
 * phrase, and device loss then burns the wallet.
 */
function checkChallenge(
  challenge: readonly number[],
  words: readonly string[],
  answers: readonly { index: number; word: string }[],
): void {
  const mismatch = (): WalletError =>
    new WalletError('CONFIRM_MISMATCH', 'Those words do not match the seed.');
  const expected = new Map(challenge.map((i) => [i, words[i]]));
  if (answers.length !== expected.size) throw mismatch();
  const seen = new Set<number>();
  for (const a of answers) {
    if (seen.has(a.index)) throw mismatch();
    seen.add(a.index);
    const want = expected.get(a.index);
    if (want === undefined || want !== a.word.trim().toLowerCase()) throw mismatch();
  }
}

/**
 * One sentence for "that file is not a backup", used by every refusal on the
 * import path. Written once so a corrupt file, a foreign file and a file that
 * decrypted onto the wrong shape cannot be told apart by their wording — the
 * same reason `NOT_A_VAULT` names no field.
 */
function notABackupFile(): WalletError {
  return new WalletError('NOT_A_BACKUP', 'That file is not a BTQ wallet backup.');
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

/**
 * Addresses a signed transaction pays, so a stored row can be checked against
 * its own bytes instead of taken at its word. Bytes that do not parse, and
 * outputs that are not a P2MR program, name no address at all — which is a
 * refusal to vouch for the row, never a match.
 */
export function outputAddressesOfSignedHex(hex: string, network: BtqNetwork): string[] {
  try {
    return parseTx(hex)
      .outputs.map((o) => addressForOutputScript(o.script, network))
      .filter((a): a is string => a !== null);
  } catch {
    return [];
  }
}
