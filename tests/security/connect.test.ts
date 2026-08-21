import { describe, it, expect } from 'vitest';
import { Keyring } from '../../src/core/wallet/keyring.js';
import { dispatch } from '../../src/core/rpc/dispatch.js';
import { canonicalOrigin, isOriginAllowed, grantOrigin } from '../../src/core/connect/permissions.js';
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
    const allowed = grantOrigin([], 'https://example.com');
    expect(isOriginAllowed(allowed, 'https://example.com')).toBe(true);
    expect(isOriginAllowed(allowed, 'https://evil.example.com')).toBe(false);
    expect(isOriginAllowed(allowed, 'https://example.com.evil.net')).toBe(false);
    expect(canonicalOrigin('https://example.com')).toBe('https://example.com');
    expect(() => canonicalOrigin('https://example.com/path')).toThrow(/Invalid origin/);
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
      balanceSats: address === first.address ? 1n : 0n,
    }));
    const next = await k.receiveAddress();
    await k.approveConnect('https://dapp.example');
    const result = await k.getAccounts('https://dapp.example');
    expect(result.accounts).toEqual([next.address]);
    expect(result.accounts[0]).not.toBe(first.address);
  });
});
