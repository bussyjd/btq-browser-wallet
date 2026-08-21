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
import { WalletError } from './errors.js';
import { deriveKeySeed, masterFromSeed } from '../crypto/hd.js';
import { scriptForAddress } from '../script/address.js';
import { addressFromHdSeed, type DerivedAddress } from './derive.js';
import { scanChain, totalBalanceSats, type AddressLookup, type ChainScan } from './gap.js';
import { emptyMeta, type ActivityItem, type WalletStorage } from './storage.js';
import type { KeyringStatus } from './types.js';
import type { ExplorerUtxo } from '../explorer/utxo.js';
import type { HistoryItem } from '../explorer/history.js';
import { planSend, previewFromSigned, signPlan } from '../tx/builder.js';
import type { OwnedUtxo } from '../tx/coinselect.js';
import { MIN_RELAY_SAT_PER_KVB } from '../tx/fee.js';
import { grantOrigin, isOriginAllowed, revokeOrigin, canonicalOrigin } from '../connect/permissions.js';

export const DEFAULT_LOCK_MS = 5 * 60 * 1000;

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

export class Keyring {
  private hdSeed: Uint8Array | null = null;
  private pending: { mnemonic: string; challenge: number[] } | null = null;
  private lastActivity = 0;
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
    const blob = await this.storage.loadVault();
    if (!blob) throw new WalletError('NO_VAULT', 'No wallet on this device.');
    const plain = await decryptVault(blob, password);
    try {
      const payload = decodePayload(plain);
      this.hdSeed = hexToBytes(payload.hdSeedHex);
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
      throw new WalletError('BAD_PASSWORD', 'Type DELETE to remove the wallet from this device.');
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
    const blob = await this.storage.loadVault();
    if (!blob) throw new WalletError('NO_VAULT', 'No wallet on this device.');
    const plain = await decryptVault(blob, password);
    wipePlaintext(plain);
    this.touch();
  }

  async gatherUtxos(fetchUtxos: (address: string) => Promise<ExplorerUtxo[]>): Promise<OwnedUtxo[]> {
    this.requireUnlocked();
    const meta = await this.storage.loadMeta();
    const extN = Math.max(meta?.externalNext ?? 0, 0);
    const intN = Math.max(meta?.internalNext ?? 0, 0);
    const owned: OwnedUtxo[] = [];
    for (const chain of ['external', 'internal'] as const) {
      const last = chain === 'external' ? extN : intN;
      for (let i = 0; i <= last; i++) {
        const derived = this.addressAt(chain, i);
        const script = scriptForAddress(derived.address, this.network);
        const rows = await fetchUtxos(derived.address);
        for (const u of rows) {
          owned.push({
            txid: u.txid,
            vout: u.vout,
            value: u.value,
            script,
            address: derived.address,
            chain,
            index: i,
          });
        }
      }
    }
    return owned;
  }

  async prepareSend(opts: {
    destination: string;
    amountSats: bigint;
    fetchUtxos: (address: string) => Promise<ExplorerUtxo[]>;
    feeRateSatPerKvB?: number;
  }): Promise<{
    destination: string;
    amount: string;
    fee: string;
    change: string;
    inputs: number;
    feeRateSatPerKvB: number;
  }> {
    this.requireUnlocked();
    const utxos = await this.gatherUtxos(opts.fetchUtxos);
    const changeAddress = (await this.changeAddress()).address;
    const plan = planSend({
      utxos,
      destination: opts.destination,
      amount: opts.amountSats,
      changeAddress,
      feeRateSatPerKvB: opts.feeRateSatPerKvB ?? MIN_RELAY_SAT_PER_KVB,
    });
    return {
      destination: plan.destination,
      amount: plan.amount.toString(),
      fee: plan.fee.toString(),
      change: plan.change.toString(),
      inputs: plan.inputs.length,
      feeRateSatPerKvB: plan.feeRateSatPerKvB,
    };
  }

  async confirmSend(opts: {
    destination: string;
    amountSats: bigint;
    password: string;
    fetchUtxos: (address: string) => Promise<ExplorerUtxo[]>;
    broadcast: (hex: string) => Promise<{ txid: string }>;
    feeRateSatPerKvB?: number;
    now?: number;
  }): Promise<ReturnType<typeof previewFromSigned> & { broadcastStatus: 'pending' | 'signed'; hex: string }> {
    await this.reauth(opts.password);
    const seed = this.requireUnlocked();
    const utxos = await this.gatherUtxos(opts.fetchUtxos);
    const change = await this.changeAddress();
    const plan = planSend({
      utxos,
      destination: opts.destination,
      amount: opts.amountSats,
      changeAddress: change.address,
      feeRateSatPerKvB: opts.feeRateSatPerKvB ?? MIN_RELAY_SAT_PER_KVB,
    });
    const signed = signPlan(plan, (u) => deriveKeySeed(masterFromSeed(seed), u.chain, u.index));
    const preview = previewFromSigned(signed);
    let broadcastStatus: 'pending' | 'signed' = 'signed';
    try {
      const pushed = await opts.broadcast(signed.hex);
      if (pushed.txid !== signed.txid) {
        throw new WalletError(
          'BROADCAST_FAILED',
          'Explorer returned a txid that does not match the signed transaction.',
        );
      }
      broadcastStatus = 'pending';
    } catch {
      broadcastStatus = 'signed';
    }
    const item: ActivityItem = {
      txid: signed.txid,
      status: broadcastStatus,
      destination: signed.destination,
      amountSats: signed.amount.toString(),
      feeSats: signed.fee.toString(),
      hex: signed.hex,
      at: opts.now ?? this.now(),
    };
    const prev = await this.storage.loadActivity();
    await this.storage.saveActivity([item, ...prev].slice(0, 50));
    if (plan.change > 0n) {
      const meta = (await this.storage.loadMeta()) ?? emptyMeta(this.network, 'bip39');
      meta.internalNext = Math.max(meta.internalNext, change.index + 1);
      await this.storage.saveMeta(meta);
    }
    this.touch();
    return { ...preview, txid: signed.txid, broadcastStatus, hex: signed.hex };
  }

  async listHistory(fetchHistory: (address: string) => Promise<HistoryItem[]>): Promise<HistoryItem[]> {
    this.requireUnlocked();
    const meta = await this.storage.loadMeta();
    const seen = new Map<string, HistoryItem>();
    const extN = Math.max(meta?.externalNext ?? 0, 0);
    const intN = Math.max(meta?.internalNext ?? 0, 0);
    for (const chain of ['external', 'internal'] as const) {
      const last = chain === 'external' ? extN : intN;
      for (let i = 0; i <= last; i++) {
        const addr = this.addressAt(chain, i).address;
        for (const h of await fetchHistory(addr)) {
          const prev = seen.get(h.txid);
          if (!prev) seen.set(h.txid, h);
          else {
            seen.set(h.txid, {
              ...h,
              valueChange: prev.valueChange + h.valueChange,
              status: h.status === 'confirmed' || prev.status === 'confirmed' ? 'confirmed' : 'pending',
            });
          }
        }
      }
    }
    const local = await this.storage.loadActivity();
    for (const a of local) {
      const onchain = seen.get(a.txid);
      if (onchain?.status === 'confirmed') {
        a.status = 'confirmed';
      } else if (!onchain) {
        seen.set(a.txid, {
          txid: a.txid,
          blockHeight: null,
          valueChange: -BigInt(a.amountSats) - BigInt(a.feeSats),
          status: a.status === 'confirmed' ? 'confirmed' : 'pending',
        });
      }
    }
    await this.storage.saveActivity(local);
    return [...seen.values()];
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

  async disconnectOrigin(origin: string): Promise<void> {
    await this.revokeSite(origin);
  }

  private async changeAddress(): Promise<DerivedAddress> {
    this.requireUnlocked();
    const meta = await this.storage.loadMeta();
    return this.addressAt('internal', meta?.internalNext ?? 0);
  }

  async scan(lookup: AddressLookup): Promise<{ external: ChainScan; internal: ChainScan; totalBalanceSats: bigint }> {
    this.requireUnlocked();
    const external = await scanChain({
      chain: 'external',
      addressAt: (i) => this.addressAt('external', i).address,
      lookup,
    });
    const internal = await scanChain({
      chain: 'internal',
      addressAt: (i) => this.addressAt('internal', i).address,
      lookup,
    });
    const total = totalBalanceSats([external, internal]);
    const meta = (await this.storage.loadMeta()) ?? emptyMeta(this.network, 'bip39');
    meta.externalNext = external.nextIndex;
    meta.internalNext = internal.nextIndex;
    meta.usedExternal = external.used.length;
    meta.usedInternal = internal.used.length;
    meta.lastBalanceSats = total.toString();
    await this.storage.saveMeta(meta);
    this.touch();
    return { external, internal, totalBalanceSats: total };
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
