import type { ActivityItem, WalletMeta, WalletStorage } from '../../src/core/wallet/storage.js';

export class MemoryWalletStorage implements WalletStorage {
  vault: Uint8Array | null = null;
  meta: WalletMeta | null = null;
  origins: string[] = [];
  pendingConnect: { origin: string } | null = null;
  activity: ActivityItem[] = [];

  async loadVault(): Promise<Uint8Array | null> {
    return this.vault ? new Uint8Array(this.vault) : null;
  }
  async saveVault(blob: Uint8Array): Promise<void> {
    this.vault = new Uint8Array(blob);
  }
  async loadMeta(): Promise<WalletMeta | null> {
    return this.meta ? { ...this.meta } : null;
  }
  async saveMeta(meta: WalletMeta): Promise<void> {
    this.meta = { ...meta };
  }
  async loadOrigins(): Promise<string[]> {
    return [...this.origins];
  }
  async saveOrigins(origins: string[]): Promise<void> {
    this.origins = [...origins];
  }
  async loadPendingConnect(): Promise<{ origin: string } | null> {
    return this.pendingConnect ? { ...this.pendingConnect } : null;
  }
  async savePendingConnect(pending: { origin: string } | null): Promise<void> {
    this.pendingConnect = pending ? { ...pending } : null;
  }
  async loadActivity(): Promise<ActivityItem[]> {
    return this.activity.map((a) => ({ ...a }));
  }
  async saveActivity(items: ActivityItem[]): Promise<void> {
    this.activity = items.map((a) => ({ ...a }));
  }
  async clear(): Promise<void> {
    this.vault = null;
    this.meta = null;
    this.origins = [];
    this.pendingConnect = null;
    this.activity = [];
  }
}

export const TEST_ENCRYPT = { iterations: 1_000 };
