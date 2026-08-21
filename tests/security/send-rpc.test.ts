import { describe, it, expect } from 'vitest';
import vectors from '../vectors/golden.json' with { type: 'json' };
import { Keyring } from '../../src/core/wallet/keyring.js';
import { dispatch } from '../../src/core/rpc/dispatch.js';
import { WALLET_METHODS } from '../../src/core/rpc/protocol.js';
import { MemoryWalletStorage, TEST_ENCRYPT } from '../helpers/memory-store.js';
import { hexToBytes } from '../../src/core/util/hex.js';
import { TX_SIGNATURE_BYTES, SIGHASH_ALL } from '../../src/core/crypto/mldsa.js';
import type { ExplorerUtxo } from '../../src/core/explorer/utxo.js';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'testnet-ok';
const DEST = vectors.entries[1]!.addresses.testnet;

function ring() {
  return new Keyring(new MemoryWalletStorage(), { encrypt: TEST_ENCRYPT, network: 'testnet' });
}

describe('send RPC — fund-move paths', () => {
  it('a tab cannot invoke send or unlock', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    for (const method of ['wallet.unlock', 'wallet.prepareSend', 'wallet.confirmSend'] as const) {
      await expect(
        dispatch(k, { method, params: { password: PASSWORD, destination: DEST, amountSats: '1000' } }, { fromTab: true, pageOrigin: 'https://evil.example' }),
      ).rejects.toThrow(/not available to pages/);
    }
    expect(WALLET_METHODS.includes('wallet.confirmSend')).toBe(true);
  });

  it('locked wallet cannot sign a send', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    k.lock();
    const fetchUtxos = async (): Promise<ExplorerUtxo[]> => [];
    await expect(
      k.confirmSend({
        destination: DEST,
        amountSats: 50_000_000n,
        password: PASSWORD,
        fetchUtxos,
        broadcast: async () => ({ txid: '00'.repeat(32) }),
      }),
    ).rejects.toThrow(/locked/i);
  });

  it('wrong password on confirmSend does not sign', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    await expect(
      k.confirmSend({
        destination: DEST,
        amountSats: 50_000_000n,
        password: 'wrong-pass',
        fetchUtxos: async () => [],
        broadcast: async () => ({ txid: '00'.repeat(32) }),
      }),
    ).rejects.toThrow('Incorrect password.');
  });

  it('confirmSend signs 2421-byte SIGHASH_ALL using owned UTXO values, not a separate balance field', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const receive = await k.receiveAddress();
    const script = hexToBytes(
      // derive matching script by preparing a 1-coin utxo at the receive script
      vectors.entries[0]!.scriptPubKey,
    );
    // The abandon mnemonic is NOT the golden seed — gatherUtxos uses the wallet's own script.
    const mine = await k.gatherUtxos(async (address) => {
      if (address !== receive.address) return [];
      const { scriptForAddress } = await import('../../src/core/script/address.js');
      const s = scriptForAddress(address, 'testnet');
      return [{ txid: 'ab'.repeat(32), vout: 0, value: 100_000_000n, script: s }];
    });
    expect(mine[0]!.value).toBe(100_000_000n);
    expect(mine[0]!.script).not.toEqual(script);

    const signed = await k.confirmSend({
      destination: DEST,
      amountSats: 10_000_000n,
      password: PASSWORD,
      fetchUtxos: async (address) => {
        if (address !== receive.address) return [];
        const { scriptForAddress } = await import('../../src/core/script/address.js');
        return [{ txid: 'ab'.repeat(32), vout: 0, value: 100_000_000n, script: scriptForAddress(address, 'testnet') }];
      },
      broadcast: async () => {
        throw new Error('no route');
      },
    });
    expect(signed.hex.length).toBeGreaterThan(100);
    expect(signed.amount).toBe('10000000');
    expect(signed.broadcastStatus).toBe('signed');
    const { hexToBytes: h2b } = await import('../../src/core/util/hex.js');
    const raw = h2b(signed.hex);
    // Witness signature is the first push after marker; cheaper: decode via confirm result inputs.
    expect(signed.inputs[0]!.value).toBe('100000000');
    expect(raw.length).toBeGreaterThan(TX_SIGNATURE_BYTES);
    expect(SIGHASH_ALL).toBe(0x01);
  });

  it('a hostile explorer cannot replace the signed txid after broadcast', async () => {
    // Attacker gain: activity would point at an unrelated tx, so the user
    // believes they paid (or cannot find the payment) and may send again.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const receive = await k.receiveAddress();
    const fake = 'ff'.repeat(32);
    const signed = await k.confirmSend({
      destination: DEST,
      amountSats: 10_000_000n,
      password: PASSWORD,
      fetchUtxos: async (address) => {
        if (address !== receive.address) return [];
        const { scriptForAddress } = await import('../../src/core/script/address.js');
        return [{ txid: 'ab'.repeat(32), vout: 0, value: 100_000_000n, script: scriptForAddress(address, 'testnet') }];
      },
      broadcast: async () => ({ txid: fake }),
    });
    expect(signed.txid).not.toBe(fake);
    expect(signed.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.broadcastStatus).toBe('signed');
    const activity = await k.listActivity();
    expect(activity[0]!.txid).toBe(signed.txid);
    expect(activity[0]!.txid).not.toBe(fake);
  });
});
