import { describe, it, expect } from 'vitest';
import { Keyring } from '../../src/core/wallet/keyring.js';
import { dispatch } from '../../src/core/rpc/dispatch.js';
import { MemoryWalletStorage, TEST_ENCRYPT } from '../helpers/memory-store.js';
import { PUBLIC_EXPLORER } from '../../src/core/network/backend.js';

function keyring() {
  return new Keyring(new MemoryWalletStorage(), { encrypt: TEST_ENCRYPT, network: 'testnet' });
}

describe('backend RPC is not a page surface', () => {
  it('a tab cannot set or test a node endpoint', async () => {
    const k = keyring();
    await expect(
      dispatch(
        k,
        { method: 'wallet.setBackend', params: { nodeUrl: 'http://evil.example:18332', nodePassword: 'x' } },
        { fromTab: true, pageOrigin: 'https://dapp.example' },
      ),
    ).rejects.toThrow(/not available to pages/);
    await expect(
      dispatch(k, { method: 'wallet.getBackend' }, { fromTab: true, pageOrigin: 'https://dapp.example' }),
    ).rejects.toThrow(/not available to pages/);
  });

  it('getBackend does not return a node password', async () => {
    const k = keyring();
    const result = await dispatch(k, { method: 'wallet.getBackend' }, {
      fromTab: false,
      getBackend: async () => ({
        explorerBase: PUBLIC_EXPLORER,
        nodeUrl: 'http://127.0.0.1:18332',
        nodeUser: 'm0',
        hasNodePassword: true,
      }),
    });
    expect(JSON.stringify(result)).not.toContain('nodePassword');
    expect(result).toMatchObject({ nodeUrl: 'http://127.0.0.1:18332', hasNodePassword: true });
  });
});
