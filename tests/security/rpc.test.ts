import { describe, it, expect } from 'vitest';
import { Keyring } from '../../src/core/wallet/keyring.js';
import { dispatch } from '../../src/core/rpc/dispatch.js';
import { isUntrustedSender } from '../../src/core/rpc/origin.js';
import { SECRET_RESULT_KEYS, WALLET_METHODS } from '../../src/core/rpc/protocol.js';
import { MemoryWalletStorage, TEST_ENCRYPT } from '../helpers/memory-store.js';

function keyring() {
  return new Keyring(new MemoryWalletStorage(), { encrypt: TEST_ENCRYPT, network: 'testnet' });
}

function collectKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, into);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      into.push(k);
      collectKeys(v, into);
    }
  }
  return into;
}

describe('RPC surface — what a page could try', () => {
  it('a tab cannot call any wallet method', async () => {
    // Attacker gain: a webpage talking to the extension would unlock, wipe, or
    // pull a freshly generated mnemonic.
    const k = keyring();
    for (const method of WALLET_METHODS) {
      await expect(dispatch(k, { method, params: { password: 'testnet-ok', confirmation: 'DELETE' } }, { fromTab: true })).rejects.toThrow(
        /not available to pages/,
      );
    }
    expect((await k.status()).pendingReveal).toBe(false);
    expect((await k.status()).hasVault).toBe(false);
  });

  it('a tab cannot wipe a sealed vault', async () => {
    // Attacker gain: destroy the only copy of the encrypted seed (funds gone
    // if the user has no backup).
    const k = keyring();
    await k.importMnemonic(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      'testnet-ok',
    );
    await expect(
      dispatch(k, { method: 'wallet.wipe', params: { confirmation: 'DELETE' } }, { fromTab: true }),
    ).rejects.toThrow(/not available to pages/);
    expect((await k.status()).hasVault).toBe(true);
    expect((await k.status()).unlocked).toBe(true);
  });

  it('unknown methods are rejected', async () => {
    const k = keyring();
    await expect(
      dispatch(k, { method: 'wallet.exportSeed' }, { fromTab: false }),
    ).rejects.toThrow(/Unknown method/);
    expect(WALLET_METHODS.includes('wallet.exportSeed' as never)).toBe(false);
  });

  it('create is the only response that contains a mnemonic, and only once', async () => {
    const k = keyring();
    const created = (await dispatch(k, { method: 'wallet.create', params: { password: 'testnet-ok' } }, { fromTab: false })) as {
      mnemonic: string;
      challenge: number[];
    };
    expect(created.mnemonic.split(' ')).toHaveLength(12);
    const status = await dispatch(k, { method: 'wallet.status' }, { fromTab: false });
    expect(collectKeys(status).includes('mnemonic')).toBe(false);
    expect(JSON.stringify(status).includes(created.mnemonic)).toBe(false);

    const words = created.mnemonic.split(' ');
    await dispatch(
      k,
      {
        method: 'wallet.confirm',
        params: { answers: created.challenge.map((index) => ({ index, word: words[index] })), password: 'testnet-ok' },
      },
      { fromTab: false },
    );
    k.lock();
    await dispatch(k, { method: 'wallet.unlock', params: { password: 'testnet-ok' } }, { fromTab: false });
    const receive = await dispatch(k, { method: 'wallet.receive' }, { fromTab: false });
    const keys = collectKeys(receive);
    for (const secret of SECRET_RESULT_KEYS) {
      expect(keys.includes(secret)).toBe(false);
    }
  });
});

describe('message sender origin', () => {
  const EXT = 'chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef';

  it('a page origin cannot pass as the extension even with no tab', () => {
    // Attacker gain: if origin were matched with includes/startsWith, a site
    // whose origin contains the extension id could call wallet.*.
    expect(isUntrustedSender({ origin: 'https://evil.example' }, EXT)).toBe(true);
    expect(isUntrustedSender({ origin: `${EXT}.evil.example` }, EXT)).toBe(true);
    expect(isUntrustedSender({ origin: `https://evil.example/?q=${EXT}` }, EXT)).toBe(true);
    expect(isUntrustedSender({ origin: EXT.slice(0, -1) }, EXT)).toBe(true);
    expect(isUntrustedSender({ origin: EXT }, EXT)).toBe(false);
  });

  it('a content script in a tab is untrusted whatever the page claims', () => {
    // Attacker gain: a content script that passed as the extension would reach
    // wallet.unlock / wallet.confirmSend with page-supplied parameters.
    expect(isUntrustedSender({ tab: { id: 1 }, origin: 'https://evil.example' }, EXT)).toBe(true);
    expect(isUntrustedSender({ tab: { id: 1 }, origin: `${EXT}.evil.example` }, EXT)).toBe(true);
    expect(isUntrustedSender({ tab: { id: 1 }, url: 'https://evil.example/x' }, EXT)).toBe(true);
    // No origin at all and attached to a tab: refuse rather than guess.
    expect(isUntrustedSender({ tab: { id: 1 } }, EXT)).toBe(true);
  });

  it('an extension page in a tab or window is trusted — the approval window is one', () => {
    // Regression: treating any tab sender as a page locked the site-connect
    // approval window (chrome.windows.create) and an onboarding tab out of
    // wallet.*, so a user could never approve a site or finish onboarding.
    expect(isUntrustedSender({ tab: { id: 7 }, origin: EXT }, EXT)).toBe(false);
    expect(isUntrustedSender({ tab: { id: 7 }, url: `${EXT}/src/ui/index.html?connect=1` }, EXT)).toBe(false);
  });

  it('a popup with no tab and the exact extension origin is trusted', () => {
    expect(isUntrustedSender({}, EXT)).toBe(false);
    expect(isUntrustedSender({ origin: EXT }, EXT)).toBe(false);
  });
});
