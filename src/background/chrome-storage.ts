import { bytesToHex, hexToBytes } from '../core/util/hex.js';
import type { ActivityItem, WalletMeta, WalletStorage } from '../core/wallet/storage.js';

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
    const v = r[META_KEY];
    if (!v || typeof v !== 'object') return null;
    return v as WalletMeta;
  }

  async saveMeta(meta: WalletMeta): Promise<void> {
    await chrome.storage.local.set({ [META_KEY]: meta });
  }

  async loadOrigins(): Promise<string[]> {
    const r = await chrome.storage.local.get(ORIGINS_KEY);
    return Array.isArray(r[ORIGINS_KEY]) ? (r[ORIGINS_KEY] as string[]) : [];
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
    return Array.isArray(r[ACTIVITY_KEY]) ? (r[ACTIVITY_KEY] as ActivityItem[]) : [];
  }

  async saveActivity(items: ActivityItem[]): Promise<void> {
    await chrome.storage.local.set({ [ACTIVITY_KEY]: items });
  }

  async clear(): Promise<void> {
    await chrome.storage.local.remove([VAULT_KEY, META_KEY, ORIGINS_KEY, PENDING_KEY, ACTIVITY_KEY]);
  }
}
