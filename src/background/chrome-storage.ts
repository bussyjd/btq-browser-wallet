import { bytesToHex, hexToBytes } from '../core/util/hex.js';
import {
  parseActivity,
  parseMeta,
  type ActivityItem,
  type WalletMeta,
  type WalletStorage,
} from '../core/wallet/storage.js';

const VAULT_KEY = 'vault';
const META_KEY = 'meta';
const ORIGINS_KEY = 'origins';
const PENDING_KEY = 'pendingConnect';
const ACTIVITY_KEY = 'activity';

export class ChromeWalletStorage implements WalletStorage {
  async loadVault(): Promise<Uint8Array | null> {
    const r = await chrome.storage.local.get(VAULT_KEY);
    const v = r[VAULT_KEY];
    if (typeof v !== 'string' || v.length === 0) return null;
    return hexToBytes(v);
  }

  async saveVault(blob: Uint8Array): Promise<void> {
    await chrome.storage.local.set({ [VAULT_KEY]: bytesToHex(blob) });
  }

  async loadMeta(): Promise<WalletMeta | null> {
    const r = await chrome.storage.local.get(META_KEY);
    // Validated, never cast: chrome.storage is writable by anything with
    // extension access, and a bogus externalNext would make unlock derive
    // thousands of ML-DSA keys.
    return parseMeta(r[META_KEY]);
  }

  async saveMeta(meta: WalletMeta): Promise<void> {
    await chrome.storage.local.set({ [META_KEY]: meta });
  }

  async loadOrigins(): Promise<string[]> {
    const r = await chrome.storage.local.get(ORIGINS_KEY);
    const raw = r[ORIGINS_KEY];
    if (!Array.isArray(raw)) return [];
    // Only well-formed origins; a junk entry must never widen the allowlist.
    return raw.filter((o): o is string => typeof o === 'string' && /^https?:\/\/[^/]+$/.test(o));
  }

  async saveOrigins(origins: string[]): Promise<void> {
    await chrome.storage.local.set({ [ORIGINS_KEY]: origins });
  }

  async loadPendingConnect(): Promise<{ origin: string } | null> {
    const r = await chrome.storage.local.get(PENDING_KEY);
    const v = r[PENDING_KEY];
    if (!v || typeof v !== 'object' || typeof (v as { origin?: unknown }).origin !== 'string') return null;
    return { origin: (v as { origin: string }).origin };
  }

  async savePendingConnect(pending: { origin: string } | null): Promise<void> {
    if (pending) await chrome.storage.local.set({ [PENDING_KEY]: pending });
    else await chrome.storage.local.remove(PENDING_KEY);
  }

  async loadActivity(): Promise<ActivityItem[]> {
    const r = await chrome.storage.local.get(ACTIVITY_KEY);
    return parseActivity(r[ACTIVITY_KEY]);
  }

  async saveActivity(items: ActivityItem[]): Promise<void> {
    await chrome.storage.local.set({ [ACTIVITY_KEY]: items });
  }

  async clear(): Promise<void> {
    await chrome.storage.local.remove([VAULT_KEY, META_KEY, ORIGINS_KEY, PENDING_KEY, ACTIVITY_KEY]);
  }
}
