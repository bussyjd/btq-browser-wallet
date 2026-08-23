/**
 * Extra HD accounts. Account 0 is the golden path (m/0'/…); extra accounts
 * are m/k'/… from the same seed. A mix-up here either hides coins or spends
 * from the wrong key.
 */
import { describe, it, expect } from 'vitest';
import { Keyring } from '../../src/core/wallet/keyring.js';
import { dispatch } from '../../src/core/rpc/dispatch.js';
import { SECRET_RESULT_KEYS } from '../../src/core/rpc/protocol.js';
import { scriptForAddress } from '../../src/core/script/address.js';
import { addressFromHdSeed } from '../../src/core/wallet/derive.js';
import { emptyAccount, MAX_ACCOUNTS, parseMeta } from '../../src/core/wallet/storage.js';
import { mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';
import { bytesToHex, hexToBytes } from '../../src/core/util/hex.js';
import { PUBLIC_KEY_BYTES, TX_SIGNATURE_BYTES, SIGHASH_ALL, verifyTransactionHash } from '../../src/core/crypto/mldsa.js';
import { tapLeafHash } from '../../src/core/script/p2mr.js';
import { p2mrSighash } from '../../src/core/tx/sighash.js';
import { parseTx } from '../../src/core/tx/parse.js';
import { MemoryWalletStorage, TEST_ENCRYPT } from '../helpers/memory-store.js';
import type { ExplorerUtxo } from '../../src/core/explorer/utxo.js';
import vectors from '../vectors/golden.json' with { type: 'json' };

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'testnet-ok';
const DAPP = 'https://dapp.example';
const DEST = vectors.entries[1]!.addresses.testnet;
const HD = mnemonicToHdSeed(MNEMONIC);

function ring(store = new MemoryWalletStorage()) {
  return new Keyring(store, { encrypt: TEST_ENCRYPT, network: 'testnet' });
}

function utxo(address: string, value: bigint, txid = 'ab'.repeat(32)): ExplorerUtxo {
  return {
    txid,
    vout: 0,
    value,
    script: scriptForAddress(address, 'testnet'),
    blockHeight: 300_000,
  };
}

function coins(map: Record<string, ExplorerUtxo[]>): (address: string) => Promise<ExplorerUtxo[]> {
  return async (address) => map[address] ?? [];
}

/** Storage whose vault load can be parked, so a switch can race confirmSend's KDF. */
class GatedVaultStore extends MemoryWalletStorage {
  holdVault = false;
  private wait: Promise<void> = Promise.resolve();
  private releaseHold: () => void = () => undefined;

  arm(): void {
    this.holdVault = true;
    this.wait = new Promise<void>((resolve) => {
      this.releaseHold = resolve;
    });
  }

  release(): void {
    this.holdVault = false;
    this.releaseHold();
  }

  override async loadVault() {
    if (this.holdVault) await this.wait;
    return super.loadVault();
  }
}

describe('extra HD accounts', () => {
  it('account 0 still matches golden.json after extra-account derivation exists', async () => {
    const seed = hexToBytes(vectors.hdSeedHex);
    const a0 = addressFromHdSeed(seed, 'external', 0, 'testnet', 0);
    expect(a0.path).toBe("m/0'/0'/0'");
    expect(a0.address).toBe(vectors.entries[0]!.addresses.testnet);
    expect(addressFromHdSeed(seed, 'external', 0, 'testnet').address).toBe(a0.address);
    expect(addressFromHdSeed(seed, 'external', 0, 'testnet', 1).address).not.toBe(a0.address);

    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const recv = await k.receiveAddress();
    expect(recv.path).toBe("m/0'/0'/0'");
    expect(recv.account).toBe(0);
    expect(recv.address).toBe(addressFromHdSeed(HD, 'external', 0, 'testnet', 0).address);
    await k.createAccount();
    await k.switchAccount(0);
    expect((await k.receiveAddress()).address).toBe(recv.address);
    expect((await k.status()).accounts).toEqual([
      expect.objectContaining({ index: 0, name: 'Account 1', address: recv.address }),
      expect.objectContaining({ index: 1, name: 'Account 2' }),
    ]);
  });

  it('Add account derives m/1\'/0\'/0\' and does not reuse account 0', async () => {
    // Attacker gain: if extra accounts were aliases of m/0'/…, a user who
    // "isolated" funds on Account 2 would be handing the same coins to a site
    // connected to Account 1.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const first = await k.receiveAddress();
    const created = await k.createAccount();
    expect(created.index).toBe(1);
    expect(created.name).toBe('Account 2');
    expect(created.address).not.toBe(first.address);
    const recv = await k.receiveAddress();
    expect(recv.path).toBe("m/1'/0'/0'");
    expect(recv.address).toBe(created.address);
    expect(recv.address).toBe(
      addressFromHdSeed(mnemonicToHdSeed(MNEMONIC), 'external', 0, 'testnet', 1).address,
    );
    expect((await k.status()).activeAccount).toBe(1);
    expect((await k.status()).canRevealPhrase).toBe(true);
  });

  it('switching back restores account 0 coins and the original receive address', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    await k.createAccount();
    await k.switchAccount(0);
    expect((await k.receiveAddress()).address).toBe(a0);
    expect((await k.status()).activeAccount).toBe(0);

    const coins = async (address: string) => (address === a0 ? [utxo(a0, 50_000n)] : []);
    expect((await k.balances(coins)).totalSats).toBe(50_000n);
    await k.switchAccount(1);
    expect((await k.balances(coins)).totalSats).toBe(0n);
  });

  it('a page cannot create or switch accounts', async () => {
    // Attacker gain: a connected dapp that could switch the active account
    // would silently change which address getAccounts returns, and which
    // UTXOs a later user-approved send would spend.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    await k.approveConnect(DAPP);
    for (const method of [
      'wallet.createAccount',
      'wallet.switchAccount',
      'wallet.renameAccount',
      'page.createAccount',
      'page.switchAccount',
      'page.renameAccount',
    ] as const) {
      await expect(
        dispatch(k, { method, params: { index: 0, name: 'Hacked' } }, { fromTab: true, pageOrigin: DAPP }),
      ).rejects.toThrow(/not available to pages/);
    }
    expect((await k.status()).accounts).toHaveLength(1);
  });

  it('getAccounts follows the active account after a switch', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    await k.approveConnect(DAPP);
    const before = (await k.getAccounts(DAPP)).accounts;
    const created = await k.createAccount();
    const after = (await k.getAccounts(DAPP)).accounts;
    expect(before).toEqual([expect.any(String)]);
    expect(after).toEqual([created.address]);
    expect(after[0]).not.toBe(before[0]);
  });

  it('rename rejects an empty name and does not write control characters', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    await expect(k.renameAccount(0, '   ')).rejects.toMatchObject({ code: 'BAD_PARAMS' });
    const renamed = await k.renameAccount(0, '  Savings\u0000  ');
    expect(renamed.name).toBe('Savings');
    expect((await k.status()).accounts[0]?.name).toBe('Savings');
  });

  it('refuses a twenty-first account', async () => {
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const meta = await store.loadMeta();
    expect(meta).not.toBeNull();
    meta!.accounts = Array.from({ length: MAX_ACCOUNTS }, (_, i) => emptyAccount(i));
    meta!.activeAccount = 0;
    await store.saveMeta(meta!);
    await expect(k.createAccount()).rejects.toMatchObject({ code: 'BAD_PARAMS' });
  });

  it('unknown or locked switch is refused without touching the seed', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    await expect(k.switchAccount(7)).rejects.toMatchObject({ code: 'BAD_PARAMS' });
    k.lock();
    await expect(k.createAccount()).rejects.toThrow(/locked/i);
    await expect(k.switchAccount(0)).rejects.toThrow(/locked/i);
    await expect(k.renameAccount(0, 'Hacked')).rejects.toThrow(/locked/i);
    await expect(
      dispatch(k, { method: 'wallet.createAccount' }, { fromTab: false }),
    ).rejects.toThrow(/locked/i);
  });

  it('confirming history on one account does not drop another account\'s activity', async () => {
    // Attacker / user loss: a refresh on Account 2 that rewrote the whole
    // activity list would erase Account 1's signed hex — the only copy of a
    // broadcast that failed.
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const tx0 = 'aa'.repeat(32);
    const tx1 = 'bb'.repeat(32);
    await store.saveActivity([
      {
        txid: tx0,
        status: 'pending',
        destination: 'tbtq1z0',
        amountSats: '1',
        feeSats: '1',
        hex: 'dead',
        at: 1,
        accountIndex: 0,
      },
      {
        txid: tx1,
        status: 'pending',
        destination: 'tbtq1z1',
        amountSats: '1',
        feeSats: '1',
        hex: 'beef',
        at: 1,
        accountIndex: 1,
      },
    ]);
    await k.createAccount();
    await k.listHistory(async () => [
      { txid: tx1, blockHeight: 10, valueChange: -2n, status: 'confirmed' },
    ]);
    const rows = await store.loadActivity();
    expect(rows.map((r) => r.txid).sort()).toEqual([tx0, tx1].sort());
    expect(rows.find((r) => r.accountIndex === 0)).toMatchObject({ status: 'pending', hex: 'dead' });
    expect(rows.find((r) => r.accountIndex === 1)?.status).toBe('confirmed');
  });

  it('gatherUtxos for one account never selects another account\'s coins', async () => {
    // User loss: coinselect on Account 2 that picked Account 1's outpoints
    // would sign with the wrong key and burn the fee, or worse double-spend
    // across "isolated" accounts.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    const a1 = (await k.createAccount()).address;
    const coins = async (address: string) => {
      if (address === a0) return [utxo(a0, 80_000n)];
      if (address === a1) return [utxo(a1, 3_000n)];
      return [];
    };
    const from1 = await k.gatherUtxos(coins, 1);
    expect(from1.map((u) => u.address)).toEqual([a1]);
    expect(from1[0]?.value).toBe(3_000n);
    await k.switchAccount(0);
    const from0 = await k.gatherUtxos(coins, 0);
    expect(from0.map((u) => u.address)).toEqual([a0]);
  });

  it('a send on account 1 spends account 1 coins and change, never account 0', async () => {
    // User loss: signing account 1's leaf against account 0's outpoints is an
    // invalid spend (fee burned, coins stuck until the reservation expires);
    // the other way around spends the "isolated" account.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    const a1 = (await k.createAccount()).address;
    const change1 = addressFromHdSeed(HD, 'internal', 0, 'testnet', 1).address;
    const fetchUtxos = coins({
      [a0]: [utxo(a0, 80_000n, 'aa'.repeat(32))],
      [a1]: [utxo(a1, 50_000n, 'bb'.repeat(32))],
    });
    const signed = await k.confirmSend({
      destination: DEST,
      amountSats: 10_000n,
      password: PASSWORD,
      fetchUtxos,
      broadcast: async () => {
        throw new Error('no route');
      },
    });
    expect(signed.inputs).toHaveLength(1);
    expect(signed.inputs[0]!.address).toBe(a1);
    expect(signed.inputs[0]!.txid).toBe('bb'.repeat(32));
    expect(signed.outputs[1]!.address).toBe(change1);

    const tx = parseTx(signed.hex);
    const witness = tx.inputs[0]!.witness as [Uint8Array, Uint8Array, Uint8Array];
    const [signature, leaf] = witness;
    expect(signature.length).toBe(TX_SIGNATURE_BYTES);
    expect(signature[TX_SIGNATURE_BYTES - 1]).toBe(SIGHASH_ALL);
    const publicKey = leaf.subarray(3, 3 + PUBLIC_KEY_BYTES);
    const script = scriptForAddress(a1, 'testnet');
    const sighash = p2mrSighash(tx, 0, [{ value: 50_000n, script }], tapLeafHash(leaf));
    expect(verifyTransactionHash(publicKey, sighash, signature)).toBe(true);
    const wrong = p2mrSighash(tx, 0, [{ value: 50_000n, script: scriptForAddress(a0, 'testnet') }], tapLeafHash(leaf));
    expect(verifyTransactionHash(publicKey, wrong, signature)).toBe(false);
  });

  it('a switch during the password check cannot retarget a send already started', async () => {
    // Attacker / user loss: the header switcher stays clickable while the
    // popup shows "Signing…". If confirmSend re-read activeAccount after the
    // KDF, the reviewed Account 1 fee and UTXOs would be discarded and
    // Account 2's coins would leave instead.
    const store = new GatedVaultStore();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    const a1 = (await k.createAccount()).address;
    await k.switchAccount(0);
    const fetchUtxos = coins({
      [a0]: [utxo(a0, 80_000n, 'aa'.repeat(32))],
      [a1]: [utxo(a1, 80_000n, 'bb'.repeat(32))],
    });

    store.arm();
    const send = k.confirmSend({
      destination: DEST,
      amountSats: 10_000n,
      password: PASSWORD,
      fetchUtxos,
      broadcast: async () => {
        throw new Error('no route');
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    await k.switchAccount(1);
    store.release();
    expect((await k.status()).activeAccount).toBe(1);
    const signed = await send;
    expect(signed.inputs[0]!.address).toBe(a0);
    expect(signed.inputs[0]!.txid).toBe('aa'.repeat(32));
    expect(signed.outputs[1]!.address).toBe(addressFromHdSeed(HD, 'internal', 0, 'testnet', 0).address);
  });

  it('unlock on a restarted keyring spends the persisted active account, not account 0', async () => {
    // User loss: a service-worker restart defaults in-memory state to 0. If
    // confirmSend pinned that default, a user sitting on Account 2 would
    // debit Account 1 after the worker woke up.
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    const a1 = (await k.createAccount()).address;
    k.lock();

    const restarted = ring(store);
    await restarted.unlock(PASSWORD);
    expect((await restarted.status()).activeAccount).toBe(1);
    const signed = await restarted.confirmSend({
      destination: DEST,
      amountSats: 10_000n,
      password: PASSWORD,
      fetchUtxos: coins({
        [a0]: [utxo(a0, 80_000n, 'aa'.repeat(32))],
        [a1]: [utxo(a1, 50_000n, 'bb'.repeat(32))],
      }),
      broadcast: async () => {
        throw new Error('no route');
      },
    });
    expect(signed.inputs[0]!.address).toBe(a1);
  });

  it('gatherUtxos of an unknown account refuses instead of walking the active one', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    await expect(k.gatherUtxos(async () => [], 7)).rejects.toMatchObject({ code: 'BAD_PARAMS' });
  });

  it('extra accounts do not give a raw-seed wallet a phrase', async () => {
    const k = ring();
    await k.importSeed('ab'.repeat(32), PASSWORD);
    expect((await k.status()).canRevealPhrase).toBe(false);
    await k.createAccount();
    expect((await k.status()).canRevealPhrase).toBe(false);
    expect((await k.status()).origin).toBe('raw32');
  });

  it('status after adding an account does not carry seed or phrase material', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    await k.createAccount();
    const status = await k.status();
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) {
        for (const x of v) walk(x);
      } else if (v && typeof v === 'object') {
        for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
          keys.push(key);
          walk(val);
        }
      }
    };
    walk(status);
    for (const secret of SECRET_RESULT_KEYS) expect(keys.includes(secret), secret).toBe(false);
    const blob = JSON.stringify(status);
    expect(blob).not.toContain(MNEMONIC);
    expect(blob).not.toContain(bytesToHex(HD));
  });

  it('a scan of account 1 does not advance account 0\'s gap cursor', async () => {
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a1 = (await k.createAccount()).address;
    await k.scan(
      async (address) => ({
        used: address === a1,
        txCount: address === a1 ? 1 : 0,
        reportedBalanceSats: 0n,
      }),
      async () => [],
    );
    const meta = await store.loadMeta();
    expect(meta?.accounts.find((a) => a.index === 0)?.externalNext).toBe(0);
    expect(meta?.accounts.find((a) => a.index === 1)?.externalNext).toBe(1);
  });

  it('parseMeta does not let a missing account 0 hide the golden-path coins', () => {
    // Attacker gain: a storage write that kept only index 19 would hide
    // m/0'/… funds and, because nextIndex is already 20, block adding 0 back.
    const meta = parseMeta({
      network: 'testnet',
      origin: 'bip39',
      activeAccount: 19,
      accounts: [{ index: 19, name: 'Trap', externalNext: 3 }],
    });
    expect(meta?.accounts.some((a) => a.index === 0)).toBe(true);
    expect(meta?.accounts.find((a) => a.index === 19)?.name).toBe('Trap');
    expect(meta?.activeAccount).toBe(19);
  });
});
