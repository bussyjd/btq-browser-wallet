/**
 * In-memory keyring. The HD seed lives here only while unlocked.
 * Persistence is the AES-GCM vault blob; the mnemonic is never stored.
 */
import type { BtqNetwork } from '../script/address.js';
import type { Chain } from '../crypto/hd.js';
import {
  assertPassword,
  generateMnemonic,
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
import { scanChain, type AddressLookup, type ChainScan } from './gap.js';
import { emptyMeta, type ActivityItem, type WalletMeta, type WalletStorage } from './storage.js';
import type { KeyringStatus } from './types.js';
import type { ExplorerUtxo } from '../explorer/utxo.js';
import type { HistoryItem } from '../explorer/history.js';
import { planSend, previewFromSigned, signPlan, type SendPlan, type SendPreview } from '../tx/builder.js';
import { maxSpendable, outpointKey, type OwnedUtxo } from '../tx/coinselect.js';
import { assertFeeRate, MIN_RELAY_SAT_PER_KVB } from '../tx/fee.js';
import { parseTx } from '../tx/parse.js';
import { grantOrigin, isOriginAllowed, revokeOrigin, canonicalOrigin } from '../connect/permissions.js';

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

export type { KeyringStatus } from './types.js';

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

export class Keyring {
  private hdSeed: Uint8Array | null = null;
  private pending: { mnemonic: string; challenge: number[] } | null = null;
  private lastActivity = 0;
  private failedUnlocks = 0;
  private unlockBlockedUntil = 0;
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
    const meta = await this.storage.loadMeta();
    return {
      hasVault: vault !== null,
      unlocked: this.hdSeed !== null,
      pendingReveal: this.pending !== null,
      network: meta?.network ?? this.network,
      origin: meta?.origin ?? null,
      externalNext: meta?.externalNext ?? 0,
      internalNext: meta?.internalNext ?? 0,
      usedExternal: meta?.usedExternal ?? 0,
      usedInternal: meta?.usedInternal ?? 0,
      lastBalanceSats: meta?.lastBalanceSats ?? '0',
      confirmedBalanceSats: meta?.confirmedBalanceSats ?? '0',
      tipHeight: meta?.tipHeight ?? null,
      lastScanAt: meta?.lastScanAt ?? null,
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
    await this.seal(mnemonicToHdSeed(mnemonic), password, 'bip39');
  }

  async importMnemonic(mnemonic: string, password: string): Promise<void> {
    this.maybeAutoLock();
    assertPassword(password);
    if (await this.storage.loadVault()) {
      throw new WalletError('ALREADY_EXISTS', 'A wallet already exists on this device. Remove it first.');
    }
    const parsed = parseMnemonic(mnemonic);
    await this.seal(mnemonicToHdSeed(parsed), password, 'bip39');
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
      this.failedUnlocks = 0;
      this.unlockBlockedUntil = 0;
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
    const meta = await this.storage.loadMeta();
    return this.receiveAt(meta?.externalNext ?? 0);
  }

  addressAt(chain: Chain, index: number): DerivedAddress {
    const seed = this.requireUnlocked();
    return addressFromHdSeed(seed, chain, index, this.network);
  }

  async reauth(password: string): Promise<void> {
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
    wipePlaintext(plain);
    this.failedUnlocks = 0;
    this.unlockBlockedUntil = 0;
    this.touch();
  }

  /**
   * Walk every derived address on both chains, inclusive of the next unused
   * index (so a payment to the address currently on screen is picked up). The
   * one place this loop is written down.
   */
  private async eachAddress<T>(fn: (chain: Chain, index: number, address: string) => Promise<T[]>): Promise<T[]> {
    this.requireUnlocked();
    const meta = await this.storage.loadMeta();
    const out: T[] = [];
    for (const chain of ['external', 'internal'] as const) {
      const last = Math.max((chain === 'external' ? meta?.externalNext : meta?.internalNext) ?? 0, 0);
      for (let i = 0; i <= last; i++) {
        out.push(...(await fn(chain, i, this.addressAt(chain, i).address)));
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
  async gatherUtxos(fetchUtxos: FetchUtxos): Promise<OwnedUtxo[]> {
    const reserved = await this.reservedOutpoints();
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
    });
    return owned.filter((u) => !reserved.has(outpointKey(u)));
  }

  /**
   * Outpoints locked by an in-flight send of ours (activity status 'pending').
   * A transaction that was never broadcast ('signed') reserves nothing — the
   * user must be able to retry it at a higher fee — and a reservation expires
   * after PENDING_RESERVE_MS so a dropped transaction cannot strand the coins.
   */
  private async reservedOutpoints(): Promise<Set<string>> {
    const reserved = new Set<string>();
    const now = this.now();
    for (const item of await this.storage.loadActivity()) {
      if (item.status !== 'pending') continue;
      if (item.at > 0 && now - item.at > PENDING_RESERVE_MS) continue;
      const keys = item.spends ?? (item.hex ? outpointsOfSignedHex(item.hex) : []);
      for (const key of keys) reserved.add(key);
    }
    return reserved;
  }

  async balances(fetchUtxos: FetchUtxos): Promise<WalletBalances> {
    const coins = await this.gatherUtxos(fetchUtxos);
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
  ): Promise<SendPlan & { changeIndex: number }> {
    const utxos = await this.gatherUtxos(fetchUtxos);
    const change = await this.changeAddress();
    const plan = planSend({
      utxos,
      destination,
      amount: amountSats,
      changeAddress: change.address,
      feeRateSatPerKvB,
    });
    return { ...plan, changeIndex: change.index };
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
    await this.reauth(opts.password);
    const seed = this.requireUnlocked();
    const rate = assertFeeRate(opts.feeRateSatPerKvB ?? MIN_RELAY_SAT_PER_KVB);
    const plan = await this.buildPlan(opts.destination, opts.amountSats, opts.fetchUtxos, rate);
    // Sign before any network call: a broadcast failure must never cost us the
    // bytes. previewFromSigned re-decodes them and refuses on any disagreement.
    const signed = signPlan(plan, (u) => deriveKeySeed(masterFromSeed(seed), u.chain, u.index));
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
    };
    const prev = await this.storage.loadActivity();
    await this.storage.saveActivity([item, ...prev].slice(0, 50));
    if (plan.change > 0n) {
      const meta = (await this.storage.loadMeta()) ?? emptyMeta(this.network, 'bip39');
      meta.internalNext = Math.max(meta.internalNext, plan.changeIndex + 1);
      await this.storage.saveMeta(meta);
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

    const local = await this.storage.loadActivity();
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
    if (activityChanged) await this.storage.saveActivity(local);

    const height = tip?.height ?? null;
    return [...seen.values()].map((h) => ({
      ...h,
      confirmations: height !== null && h.blockHeight !== null ? Math.max(0, height - h.blockHeight + 1) : null,
    }));
  }

  async listActivity(): Promise<ActivityItem[]> {
    return this.storage.loadActivity();
  }

  async connectedSites(): Promise<string[]> {
    return this.storage.loadOrigins();
  }

  async pendingConnect(): Promise<{ origin: string } | null> {
    return this.storage.loadPendingConnect();
  }

  async requestAccounts(origin: string): Promise<{ accounts: string[] } | { pending: true }> {
    // Do not touch() — a connected page polling accounts must not pin the seed.
    this.maybeAutoLock();
    if (!this.hdSeed) throw new WalletError('LOCKED', 'Wallet is locked.');
    const o = canonicalOrigin(origin);
    const allowed = await this.storage.loadOrigins();
    if (isOriginAllowed(allowed, o)) {
      return { accounts: [await this.peekReceiveAddress()] };
    }
    await this.storage.savePendingConnect({ origin: o });
    return { pending: true };
  }

  async getAccounts(origin: string): Promise<{ accounts: string[] }> {
    this.maybeAutoLock();
    const o = canonicalOrigin(origin);
    const allowed = await this.storage.loadOrigins();
    if (!isOriginAllowed(allowed, o) || this.hdSeed === null) return { accounts: [] };
    try {
      return { accounts: [await this.peekReceiveAddress()] };
    } catch (e) {
      if (e instanceof WalletError && e.code === 'LOCKED') return { accounts: [] };
      throw e;
    }
  }

  async approveConnect(origin: string): Promise<{ accounts: string[] }> {
    this.requireUnlocked();
    const o = canonicalOrigin(origin);
    const allowed = grantOrigin(await this.storage.loadOrigins(), o);
    await this.storage.saveOrigins(allowed);
    await this.storage.savePendingConnect(null);
    return { accounts: [(await this.receiveAddress()).address] };
  }

  async denyConnect(): Promise<void> {
    await this.storage.savePendingConnect(null);
  }

  async revokeSite(origin: string): Promise<void> {
    const allowed = revokeOrigin(await this.storage.loadOrigins(), origin);
    await this.storage.saveOrigins(allowed);
  }

  private async changeAddress(): Promise<DerivedAddress> {
    this.requireUnlocked();
    const meta = await this.storage.loadMeta();
    return this.addressAt('internal', meta?.internalNext ?? 0);
  }

  /**
   * Incremental gap scan.
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
  }> {
    this.requireUnlocked();
    const meta = (await this.storage.loadMeta()) ?? emptyMeta(this.network, 'bip39');
    const full = opts.full === true;

    const external = await scanChain({
      chain: 'external',
      addressAt: (i) => this.addressAt('external', i).address,
      lookup,
      startIndex: full ? 0 : Math.max(0, meta.externalNext),
      lastUsedIndex: full ? -1 : meta.externalNext - 1,
    });
    const internal = await scanChain({
      chain: 'internal',
      addressAt: (i) => this.addressAt('internal', i).address,
      lookup,
      startIndex: full ? 0 : Math.max(0, meta.internalNext),
      lastUsedIndex: full ? -1 : meta.internalNext - 1,
    });

    let totalBalanceSats = BigInt(meta.lastBalanceSats || '0');
    let confirmedBalanceSats = BigInt(meta.confirmedBalanceSats || '0');
    const next: WalletMeta = {
      ...meta,
      externalNext: Math.max(full ? 0 : meta.externalNext, external.nextIndex),
      internalNext: Math.max(full ? 0 : meta.internalNext, internal.nextIndex),
      usedExternal: (full ? 0 : meta.usedExternal) + external.used.length,
      usedInternal: (full ? 0 : meta.usedInternal) + internal.used.length,
      scannedExternal: Math.max(full ? -1 : meta.scannedExternal, external.scannedTo),
      scannedInternal: Math.max(full ? -1 : meta.scannedInternal, internal.scannedTo),
      tipHeight: tip?.height ?? meta.tipHeight,
      lastScanAt: this.now(),
    };
    // Persist the new cursor first so the UTXO sweep below covers every address.
    await this.storage.saveMeta(next);

    if (fetchUtxos) {
      const b = await this.balances(fetchUtxos);
      totalBalanceSats = b.totalSats;
      confirmedBalanceSats = b.confirmedSats;
      next.lastBalanceSats = totalBalanceSats.toString();
      next.confirmedBalanceSats = confirmedBalanceSats.toString();
      await this.storage.saveMeta(next);
    }

    this.touch();
    return {
      external,
      internal,
      usedExternal: next.usedExternal,
      usedInternal: next.usedInternal,
      totalBalanceSats,
      confirmedBalanceSats,
      tipHeight: next.tipHeight,
      lastScanAt: next.lastScanAt ?? this.now(),
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

  private receiveAt(index: number): DerivedAddress {
    const seed = this.requireUnlocked();
    this.touch();
    return addressFromHdSeed(seed, 'external', index, this.network);
  }

  /** Receive address without resetting the auto-lock clock. */
  private async peekReceiveAddress(): Promise<string> {
    const meta = await this.storage.loadMeta();
    this.maybeAutoLock();
    const seed = this.hdSeed;
    if (!seed) throw new WalletError('LOCKED', 'Wallet is locked.');
    return addressFromHdSeed(seed, 'external', meta?.externalNext ?? 0, this.network).address;
  }

  private async seal(hdSeed: Uint8Array, password: string, origin: SeedOrigin): Promise<void> {
    let plain: Uint8Array | undefined;
    try {
      if (await this.storage.loadVault()) {
        throw new WalletError('ALREADY_EXISTS', 'A wallet already exists on this device. Remove it first.');
      }
      const payload: VaultPayload = {
        v: 1,
        network: this.network,
        origin,
        hdSeedHex: bytesToHex(hdSeed),
      };
      plain = encodePayload(payload);
      const blob = await encryptVault(plain, password, this.opts.encrypt);
      await this.storage.saveVault(blob);
      await this.storage.saveMeta(emptyMeta(this.network, origin));
      this.hdSeed = new Uint8Array(hdSeed);
      this.clearPending();
      this.touch();
    } finally {
      if (plain) wipePlaintext(plain);
      wipeBytes(hdSeed);
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

/** Outpoints a signed transaction spends, for reserving them against re-selection. */
export function outpointsOfSignedHex(hex: string): string[] {
  try {
    return parseTx(hex).inputs.map((i) => outpointKey(i));
  } catch {
    return [];
  }
}
