import { describe, it, expect } from 'vitest';
import { Keyring } from '../../src/core/wallet/keyring.js';
import { dispatch } from '../../src/core/rpc/dispatch.js';
import { canonicalOrigin, isGranted, grantSite, parseGrant } from '../../src/core/connect/permissions.js';
import { PAGE_METHODS } from '../../src/core/connect/permissions.js';
import { SECRET_RESULT_KEYS } from '../../src/core/rpc/protocol.js';
import { MemoryWalletStorage, TEST_ENCRYPT } from '../helpers/memory-store.js';
import type { ExplorerUtxo } from '../../src/core/explorer/utxo.js';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'testnet-ok';

function ring() {
  return new Keyring(new MemoryWalletStorage(), { encrypt: TEST_ENCRYPT, network: 'testnet' });
}

function keysOf(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) keysOf(v, into);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      into.push(k);
      keysOf(v, into);
    }
  }
  return into;
}

describe('site-connect exact origin', () => {
  it('does not treat a suffix or prefix lookalike as the same origin', () => {
    const allowed = grantSite([], 'https://example.com', 0);
    expect(isGranted(allowed, 'https://example.com', 0)).toBe(true);
    expect(isGranted(allowed, 'https://evil.example.com', 0)).toBe(false);
    expect(isGranted(allowed, 'https://example.com.evil.net', 0)).toBe(false);
    // …and the account is half of the key, not decoration.
    expect(isGranted(allowed, 'https://example.com', 1)).toBe(false);
    expect(canonicalOrigin('https://example.com')).toBe('https://example.com');
    expect(() => canonicalOrigin('https://example.com/path')).toThrow(/Invalid origin/);
  });

  it('reads a pre-accounts grant as account 0, and refuses a malformed one', () => {
    // Migration: every grant written before accounts existed was for the only
    // account there was. It stays stored as the bare origin, so an older build
    // can still read what this one writes for account 0.
    expect(parseGrant('https://example.com')).toEqual({ origin: 'https://example.com', account: 0 });
    expect(grantSite([], 'https://example.com', 0)).toEqual(['https://example.com']);
    expect(grantSite([], 'https://example.com', 3)).toEqual(['https://example.com#3']);
    expect(parseGrant('https://example.com#3')).toEqual({ origin: 'https://example.com', account: 3 });
    for (const bad of ['https://example.com#20', 'https://example.com#x', 'https://example.com/#1', 'not-an-origin', 42]) {
      expect(parseGrant(bad), String(bad)).toBeNull();
    }
  });

  it('a page cannot call wallet.confirmSend even with an approved origin', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    await k.approveConnect('https://dapp.example');
    await expect(
      dispatch(
        k,
        { method: 'wallet.confirmSend', params: { destination: 'tbtq1z', amountSats: '1', password: PASSWORD } },
        { fromTab: true, pageOrigin: 'https://dapp.example' },
      ),
    ).rejects.toThrow(/not available to pages/);
  });

  it('page.requestAccounts does not return seed material', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    await k.approveConnect('https://dapp.example');
    const result = await dispatch(
      k,
      { method: 'page.requestAccounts' },
      { fromTab: true, pageOrigin: 'https://dapp.example' },
    );
    const keys = keysOf(result);
    for (const secret of SECRET_RESULT_KEYS) expect(keys.includes(secret)).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/abandon/);
    expect(PAGE_METHODS.includes('page.requestAccounts')).toBe(true);
  });

  it('revoke removes the origin so getAccounts returns empty', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    await k.approveConnect('https://dapp.example');
    await k.revokeSite('https://dapp.example');
    const result = await k.getAccounts('https://dapp.example');
    expect(result.accounts).toEqual([]);
  });

  it('a connected page cannot keep the wallet unlocked by polling getAccounts', async () => {
    // Attacker gain: the HD seed would stay decrypted for the lifetime of the
    // tab, so a later memory dump or SW compromise recovers spendable keys
    // after the user thought the wallet had locked.
    const clock = { t: 1_000 };
    const k = new Keyring(new MemoryWalletStorage(), {
      encrypt: TEST_ENCRYPT,
      network: 'testnet',
      now: () => clock.t,
      lockAfterMs: 60_000,
    });
    await k.importMnemonic(MNEMONIC, PASSWORD);
    await k.approveConnect('https://dapp.example');
    clock.t += 50_000;
    const stillOpen = await dispatch(
      k,
      { method: 'page.getAccounts' },
      { fromTab: true, pageOrigin: 'https://dapp.example' },
    );
    expect(stillOpen).toEqual({ accounts: [expect.any(String)] });
    await dispatch(k, { method: 'page.requestAccounts' }, { fromTab: true, pageOrigin: 'https://dapp.example' });
    clock.t += 20_000;
    expect((await k.status()).unlocked).toBe(false);
    const afterLock = await dispatch(
      k,
      { method: 'page.getAccounts' },
      { fromTab: true, pageOrigin: 'https://dapp.example' },
    );
    expect(afterLock).toEqual({ accounts: [] });
    await expect(
      k.confirmSend({
        destination: 'tbtq1zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
        amountSats: 50_000_000n,
        password: PASSWORD,
        fetchUtxos: async (): Promise<ExplorerUtxo[]> => [],
        broadcast: async () => ({ txid: '00'.repeat(32) }),
      }),
    ).rejects.toThrow(/locked/i);
  });

  it('getAccounts returns the current receive address after a gap scan', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const first = await k.receiveAddress();
    await k.scan(async (address) => ({
      used: address === first.address,
      txCount: address === first.address ? 1 : 0,
      reportedBalanceSats: address === first.address ? 1n : 0n,
    }));
    const next = await k.receiveAddress();
    await k.approveConnect('https://dapp.example');
    const result = await k.getAccounts('https://dapp.example');
    expect(result.accounts).toEqual([next.address]);
    expect(result.accounts[0]).not.toBe(first.address);
  });
});

describe('site-connect state machine through dispatch', () => {
  const DAPP = 'https://dapp.example';
  const OTHER = 'https://other.example';
  const fromPage = (origin: string) => ({ fromTab: true as const, pageOrigin: origin });
  const fromPopup = { fromTab: false as const };

  function ringWithStore() {
    const store = new MemoryWalletStorage();
    return { k: new Keyring(store, { encrypt: TEST_ENCRYPT, network: 'testnet' }), store };
  }

  it('walks pending → denied → pending → approved without ever leaking accounts early', async () => {
    const { k, store } = ringWithStore();
    await k.importMnemonic(MNEMONIC, PASSWORD);

    // An origin nobody approved gets a prompt, not an address — and no durable
    // record of it: a parked request lives and dies with the worker holding the
    // page's `sendResponse`, so a note that outlived one would be a prompt the
    // user could approve after the site stopped asking.
    expect(await dispatch(k, { method: 'page.requestAccounts' }, fromPage(DAPP))).toEqual({ pending: true });
    expect(store.pendingConnect).toBeNull();
    expect(await dispatch(k, { method: 'page.getAccounts' }, fromPage(DAPP))).toEqual({ accounts: [] });

    // Deny names the request it is refusing, and changes nothing else.
    await dispatch(k, { method: 'wallet.denyConnect', params: { origin: DAPP } }, fromPopup);
    expect(store.pendingConnect).toBeNull();
    expect(await dispatch(k, { method: 'page.getAccounts' }, fromPage(DAPP))).toEqual({ accounts: [] });

    // A deny for an origin that is not an origin at all is refused outright.
    await expect(
      dispatch(k, { method: 'wallet.denyConnect', params: { origin: 'dapp.example' } }, fromPopup),
    ).rejects.toThrow(/Invalid origin/);

    // Ask again, approve this time.
    expect(await dispatch(k, { method: 'page.requestAccounts' }, fromPage(DAPP))).toEqual({ pending: true });
    await dispatch(k, { method: 'wallet.approveConnect', params: { origin: DAPP } }, fromPopup);
    expect(store.pendingConnect).toBeNull();
    const address = (await k.receiveAddress()).address;
    expect(await dispatch(k, { method: 'page.getAccounts' }, fromPage(DAPP))).toEqual({ accounts: [address] });
    expect(await dispatch(k, { method: 'page.requestAccounts' }, fromPage(DAPP))).toEqual({ accounts: [address] });

    // Approving one site says nothing about any other site.
    expect(await dispatch(k, { method: 'page.getAccounts' }, fromPage(OTHER))).toEqual({ accounts: [] });
    expect(await dispatch(k, { method: 'page.requestAccounts' }, fromPage(OTHER))).toEqual({ pending: true });
  });

  it('a tab whose sender carries no origin cannot call page.* at all', async () => {
    const { k } = ringWithStore();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    await expect(dispatch(k, { method: 'page.requestAccounts' }, { fromTab: true })).rejects.toThrow(
      /not available to pages/,
    );
    await expect(
      dispatch(k, { method: 'page.getAccounts', params: { origin: DAPP } }, { fromTab: true }),
    ).rejects.toThrow(/not available to pages/);
  });
});
