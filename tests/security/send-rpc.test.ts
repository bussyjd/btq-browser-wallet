import { describe, it, expect } from 'vitest';
import vectors from '../vectors/golden.json' with { type: 'json' };
import { Keyring, PENDING_RESERVE_MS } from '../../src/core/wallet/keyring.js';
import { dispatch } from '../../src/core/rpc/dispatch.js';
import { WALLET_METHODS } from '../../src/core/rpc/protocol.js';
import { MemoryWalletStorage, TEST_ENCRYPT } from '../helpers/memory-store.js';
import { PUBLIC_KEY_BYTES, TX_SIGNATURE_BYTES, SIGHASH_ALL, verifyTransactionHash } from '../../src/core/crypto/mldsa.js';
import { scriptForAddress } from '../../src/core/script/address.js';
import { tapLeafHash } from '../../src/core/script/p2mr.js';
import { p2mrSighash, txid as txidOf } from '../../src/core/tx/sighash.js';
import { parseTx } from '../../src/core/tx/parse.js';
import { BroadcastError, WalletError } from '../../src/core/wallet/errors.js';
import type { ExplorerUtxo } from '../../src/core/explorer/utxo.js';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'testnet-ok';
const DEST = vectors.entries[1]!.addresses.testnet;
const COIN = 100_000_000n;

function ring() {
  return new Keyring(new MemoryWalletStorage(), { encrypt: TEST_ENCRYPT, network: 'testnet' });
}

/** The txid a node would echo back for these bytes. */
function parseTxidOf(hex: string): string {
  return txidOf(parseTx(hex));
}

/** One confirmed 1 tBTQ coin on the wallet's own receive address. */
function fundOnce(address: string, txid = 'ab'.repeat(32), vout = 0) {
  return async (queried: string): Promise<ExplorerUtxo[]> => {
    if (queried !== address) return [];
    return [
      {
        txid,
        vout,
        value: COIN,
        script: scriptForAddress(queried, 'testnet'),
        blockHeight: 300_000,
      },
    ];
  };
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
    await expect(
      k.confirmSend({
        destination: DEST,
        amountSats: 50_000_000n,
        password: PASSWORD,
        fetchUtxos: async () => [],
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

  it('the signed witness verifies against the sighash over the real UTXO value', async () => {
    // Attacker gain / user loss: a signature that does not commit to the exact
    // input value and destination is either invalid (the payment never lands)
    // or, worse, replayable against a different amount.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const receive = await k.receiveAddress();
    const fetchUtxos = fundOnce(receive.address);

    const signed = await k.confirmSend({
      destination: DEST,
      amountSats: 10_000_000n,
      password: PASSWORD,
      fetchUtxos,
      broadcast: async () => {
        throw new BroadcastError('no route', 'explorer', true);
      },
    });

    const tx = parseTx(signed.hex);
    expect(tx.inputs).toHaveLength(1);
    const witness = tx.inputs[0]!.witness!;
    expect(witness).toHaveLength(3);
    const [signature, leaf, control] = witness as [Uint8Array, Uint8Array, Uint8Array];
    expect(signature.length).toBe(TX_SIGNATURE_BYTES);
    expect(signature[TX_SIGNATURE_BYTES - 1]).toBe(SIGHASH_ALL);
    expect(control).toEqual(new Uint8Array([0xc1]));

    const publicKey = leaf.subarray(3, 3 + PUBLIC_KEY_BYTES);
    const script = scriptForAddress(receive.address, 'testnet');
    const spent = [{ value: COIN, script }];
    const sighash = p2mrSighash(tx, 0, spent, tapLeafHash(leaf));
    expect(verifyTransactionHash(publicKey, sighash, signature)).toBe(true);

    // One satoshi difference in the spent value is a different sighash: this is
    // what "the signature commits to the input amount" actually means.
    const tampered = p2mrSighash(tx, 0, [{ value: COIN + 1n, script }], tapLeafHash(leaf));
    expect(verifyTransactionHash(publicKey, tampered, signature)).toBe(false);

    // And a changed output value must invalidate it too.
    const movedFunds = parseTx(signed.hex);
    movedFunds.outputs[0]!.value += 1n;
    const otherSighash = p2mrSighash(movedFunds, 0, spent, tapLeafHash(leaf));
    expect(verifyTransactionHash(publicKey, otherSighash, signature)).toBe(false);

    expect(signed.inputs[0]!.value).toBe(COIN.toString());
    expect(signed.amount).toBe('10000000');
    expect(signed.broadcastStatus).toBe('signed');
  });

  it('the preview the user approves is decoded from the bytes we broadcast', async () => {
    // User loss: showing plan fields instead of decoded bytes means a builder
    // bug pays a different address than the one on the confirmation screen.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const receive = await k.receiveAddress();
    const signed = await k.confirmSend({
      destination: DEST,
      amountSats: 10_000_000n,
      password: PASSWORD,
      fetchUtxos: fundOnce(receive.address),
      broadcast: async () => ({ txid: '00'.repeat(32) }),
    });
    expect(signed.decoded.outputs[0]!.address).toBe(DEST);
    expect(signed.decoded.outputs[0]!.value).toBe('10000000');
    // The change row shows a real address of ours, not an empty string.
    expect(signed.outputs[1]!.address.startsWith('tbtq1z')).toBe(true);
    expect(signed.decoded.vsize).toBe(signed.vsize);
  });

  it('a node rejection surfaces its reject-reason instead of being swallowed', async () => {
    // User loss: without the reason, "min relay fee not met" is indistinguishable
    // from "sent" — the user believes a payee was paid and may pay twice.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const receive = await k.receiveAddress();
    const result = await k.confirmSend({
      destination: DEST,
      amountSats: 10_000_000n,
      password: PASSWORD,
      fetchUtxos: fundOnce(receive.address),
      broadcast: async () => {
        throw new BroadcastError('min relay fee not met', 'node');
      },
    });
    expect(result.broadcastStatus).toBe('signed');
    expect(result.broadcastError).toBe('min relay fee not met');
    expect(result.broadcastVia).toBe('node');
    const activity = await k.listActivity();
    expect(activity[0]!.broadcastError).toBe('min relay fee not met');
    expect(activity[0]!.status).toBe('signed');
    // The bytes are never lost, whatever the backend said.
    expect(activity[0]!.hex).toBe(result.hex);
  });

  it('a failed broadcast is reported as signed in history, never as pending', async () => {
    // User loss: a "pending" row for a transaction that was never broadcast is
    // a payment the user thinks they made.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const receive = await k.receiveAddress();
    await k.confirmSend({
      destination: DEST,
      amountSats: 10_000_000n,
      password: PASSWORD,
      fetchUtxos: fundOnce(receive.address),
      broadcast: async () => {
        throw new BroadcastError('no broadcast route', 'explorer', true);
      },
    });
    const history = await k.listHistory(async () => []);
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe('signed');
  });

  it('a successful broadcast records which route accepted it', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const receive = await k.receiveAddress();
    const result = await k.confirmSend({
      destination: DEST,
      amountSats: 10_000_000n,
      password: PASSWORD,
      fetchUtxos: fundOnce(receive.address),
      broadcast: async (hex) => ({ txid: parseTxidOf(hex), via: 'node' }),
    });
    expect(result.broadcastStatus).toBe('pending');
    expect(result.broadcastError).toBeNull();
    expect(result.broadcastVia).toBe('node');
  });

  it('a second send cannot re-select the coins an in-flight send already spends', async () => {
    // User loss: re-selecting them builds an RBF replacement of a payment
    // already in flight, so the first payee silently gets nothing.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const receive = await k.receiveAddress();
    const fetchUtxos = fundOnce(receive.address);
    const first = await k.confirmSend({
      destination: DEST,
      amountSats: 10_000_000n,
      password: PASSWORD,
      fetchUtxos,
      broadcast: async (hex) => ({ txid: parseTxidOf(hex), via: 'node' }),
    });
    expect(first.broadcastStatus).toBe('pending');
    await expect(
      k.confirmSend({
        destination: DEST,
        amountSats: 10_000_000n,
        password: PASSWORD,
        fetchUtxos,
        broadcast: async (hex) => ({ txid: parseTxidOf(hex), via: 'node' }),
      }),
    ).rejects.toThrow(/No coins to spend|Not enough balance/);
  });

  it('a send that was never broadcast does not lock its coins forever', async () => {
    // The mirror of the test above: 'signed' means nothing is in flight, so the
    // user must be able to retry at a higher fee.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const receive = await k.receiveAddress();
    const fetchUtxos = fundOnce(receive.address);
    await k.confirmSend({
      destination: DEST,
      amountSats: 10_000_000n,
      password: PASSWORD,
      fetchUtxos,
      broadcast: async () => {
        throw new BroadcastError('no broadcast route', 'explorer', true);
      },
    });
    const retry = await k.confirmSend({
      destination: DEST,
      amountSats: 10_000_000n,
      password: PASSWORD,
      fetchUtxos,
      feeRateSatPerKvB: 2000,
      broadcast: async () => {
        throw new BroadcastError('no broadcast route', 'explorer', true);
      },
    });
    expect(retry.inputs).toHaveLength(1);
  });

  it('a stale pending reservation expires so dropped coins are not stranded', async () => {
    // User loss: if a broadcast transaction is dropped by the network, coins
    // reserved for it would otherwise be unspendable for the life of the wallet.
    const clock = { t: 1_000_000 };
    const k = new Keyring(new MemoryWalletStorage(), {
      encrypt: TEST_ENCRYPT,
      network: 'testnet',
      now: () => clock.t,
      lockAfterMs: 0, // auto-lock is not what this test is about
    });
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const receive = await k.receiveAddress();
    const fetchUtxos = fundOnce(receive.address);
    await k.confirmSend({
      destination: DEST,
      amountSats: 10_000_000n,
      password: PASSWORD,
      fetchUtxos,
      broadcast: async (hex) => ({ txid: parseTxidOf(hex), via: 'node' }),
    });
    await expect(k.gatherUtxos(fetchUtxos)).resolves.toHaveLength(0);
    clock.t += PENDING_RESERVE_MS + 1;
    await expect(k.gatherUtxos(fetchUtxos)).resolves.toHaveLength(1);
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
      fetchUtxos: fundOnce(receive.address),
      broadcast: async () => ({ txid: fake }),
    });
    expect(signed.txid).not.toBe(fake);
    expect(signed.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.broadcastStatus).toBe('signed');
    expect(signed.broadcastError).toMatch(/different transaction id/);
    const activity = await k.listActivity();
    expect(activity[0]!.txid).toBe(signed.txid);
    expect(activity[0]!.txid).not.toBe(fake);
  });

  it('a fee rate below the relay floor is refused before anything is signed', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const receive = await k.receiveAddress();
    const attempt = k.confirmSend({
      destination: DEST,
      amountSats: 10_000_000n,
      password: PASSWORD,
      feeRateSatPerKvB: 500,
      fetchUtxos: fundOnce(receive.address),
      broadcast: async () => ({ txid: '00'.repeat(32) }),
    });
    await expect(attempt).rejects.toThrow(/relay floor/);
    try {
      await attempt;
    } catch (e) {
      expect((e as WalletError).code).toBe('BAD_FEE_RATE');
    }
    expect(await k.listActivity()).toHaveLength(0);
  });
});
