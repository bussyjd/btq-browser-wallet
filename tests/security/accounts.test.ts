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
import { ACCOUNT_NAME_MAX, emptyAccount, MAX_ACCOUNTS, parseMeta } from '../../src/core/wallet/storage.js';
import { mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';
import { bytesToHex, hexToBytes } from '../../src/core/util/hex.js';
import { PUBLIC_KEY_BYTES, TX_SIGNATURE_BYTES, SIGHASH_ALL, verifyTransactionHash } from '../../src/core/crypto/mldsa.js';
import { tapLeafHash } from '../../src/core/script/p2mr.js';
import { p2mrSighash, txid as txidOf } from '../../src/core/tx/sighash.js';
import { decodeTxPreview, parseTx } from '../../src/core/tx/parse.js';
import { MemoryWalletStorage, TEST_ENCRYPT } from '../helpers/memory-store.js';
import { reviewAndSend } from '../helpers/send.js';
import type { ExplorerUtxo } from '../../src/core/explorer/utxo.js';
import vectors from '../vectors/golden.json' with { type: 'json' };

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'testnet-ok';
const DAPP = 'https://dapp.example';
const OTHER = 'https://other.example';
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

/**
 * Storage whose origin load can be parked, so a switch can land inside
 * `approveConnect` — between deciding which account is being granted and
 * answering with an address.
 */
class GatedOriginsStore extends MemoryWalletStorage {
  private wait: Promise<void> | null = null;
  private releaseHold: () => void = () => undefined;

  arm(): void {
    this.wait = new Promise<void>((resolve) => {
      this.releaseHold = resolve;
    });
  }

  release(): void {
    this.releaseHold();
    this.wait = null;
  }

  override async loadOrigins() {
    const held = this.wait;
    if (held) {
      this.wait = null; // park the first read only
      await held;
    }
    return super.loadOrigins();
  }
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

  it('a site grant does not follow the user into another account', async () => {
    // Attacker / user gain: the second account exists precisely to keep an
    // identity away from this site. A grant stored per origin alone handed the
    // site that account's address the moment the user switched — or pressed
    // "Add account", which switches — with no prompt and no way to tell from
    // the connected-sites list that it had happened.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    await k.approveConnect(DAPP);
    const before = (await k.getAccounts(DAPP)).accounts;
    expect(before).toEqual([expect.any(String)]);

    const created = await k.createAccount();
    expect((await k.getAccounts(DAPP)).accounts).toEqual([]);
    // Not merely absent from the answer — the address must not appear at all.
    expect(JSON.stringify(await k.getAccounts(DAPP))).not.toContain(created.address);
    // And asking again from the page is a fresh approval, not a silent yes.
    expect(await k.requestAccounts(DAPP)).toEqual({ pending: true });

    await k.switchAccount(0);
    expect((await k.getAccounts(DAPP)).accounts).toEqual(before);
  });

  it('approving on the second account grants that pair alone, and revoke is per pair', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    await k.approveConnect(DAPP);
    const a1 = (await k.createAccount()).address;
    await k.approveConnect(DAPP);

    expect(await k.connectedSites()).toEqual([
      { origin: DAPP, account: 0 },
      { origin: DAPP, account: 1 },
    ]);
    expect((await k.getAccounts(DAPP)).accounts).toEqual([a1]);
    // A second site, approved only on account 1, stays blind on account 0.
    await k.approveConnect(OTHER);
    await k.switchAccount(0);
    expect((await k.getAccounts(DAPP)).accounts).toEqual([a0]);
    expect((await k.getAccounts(OTHER)).accounts).toEqual([]);

    // Revoking one row leaves the other standing…
    await k.revokeSite(DAPP, 0);
    expect((await k.getAccounts(DAPP)).accounts).toEqual([]);
    await k.switchAccount(1);
    expect((await k.getAccounts(DAPP)).accounts).toEqual([a1]);
    // …and the page's own disconnect drops the site entirely.
    await k.revokeSite(DAPP);
    expect(await k.connectedSites()).toEqual([{ origin: OTHER, account: 1 }]);
  });

  it('a switch inside approveConnect cannot grant one account and answer with another', async () => {
    // Attacker / user loss: the grant and the address it is answered with came
    // from two separate reads of the active account, with two storage awaits
    // between them. A switch landing in that window recorded (origin, 0) and
    // handed the page account 1's address — an address of an account it had
    // never been approved for — after which the grant it *did* hold answered
    // `[]` for good. The meta lock did not close it: they were never in the
    // same critical section.
    const store = new GatedOriginsStore();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    const a1 = (await k.createAccount()).address;
    await k.switchAccount(0);
    expect(a1).not.toBe(a0);

    store.arm();
    const approving = k.approveConnect(DAPP);
    await new Promise((r) => setTimeout(r, 20));
    // The user clicks Account 1 in the header while the approval is in flight.
    const switching = k.switchAccount(1);
    store.release();

    const granted = await approving;
    await switching;

    // One account, one answer: the address handed to the site belongs to the
    // pair that was recorded.
    expect(await k.connectedSites()).toEqual([{ origin: DAPP, account: 0 }]);
    expect(granted.accounts).toEqual([a0]);
    expect(granted.accounts).not.toContain(a1);
    // The switch really did land — this is a race that happened, not one that
    // was serialised away by the test.
    expect((await k.status()).activeAccount).toBe(1);
    // And the grant behaves: silent on account 1, live again on account 0.
    expect((await k.getAccounts(DAPP)).accounts).toEqual([]);
    await k.switchAccount(0);
    expect((await k.getAccounts(DAPP)).accounts).toEqual([a0]);
  });

  it('a locked wallet hands out no address and no account name', async () => {
    // Attacker gain: a locked popup on a borrowed laptop, a shoulder, or a
    // screen recording of the unlock screen would otherwise read every
    // account's address — and the names the user chose to label them
    // ("Payroll", "Exchange") — and pull the whole history of each off the
    // public explorer. No address left this worker while locked before extra
    // accounts existed, and none may now.
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    const a1 = (await k.createAccount()).address;
    await k.renameAccount(1, 'Payroll');
    expect((await k.status()).accounts).toHaveLength(2);

    k.lock();
    const locked = await k.status();
    expect(locked.unlocked).toBe(false);
    expect(locked.accounts).toEqual([]);
    const blob = JSON.stringify(locked);
    expect(blob).not.toContain(a0);
    expect(blob).not.toContain(a1);
    expect(blob).not.toContain('Payroll');
    // The account the wallet will open on is not a secret, and the Unlock
    // screen keeps working.
    expect(locked.activeAccount).toBe(1);
    expect(locked.hasVault).toBe(true);
    expect(locked.canRevealPhrase).toBe(false);

    // Unlocking gives them back.
    await k.unlock(PASSWORD);
    expect((await k.status()).accounts).toEqual([
      expect.objectContaining({ index: 0, address: a0 }),
      expect.objectContaining({ index: 1, address: a1, name: 'Payroll' }),
    ]);
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
    const signed = await reviewAndSend(k, {
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

    // Reviewed on Account 0, so the plan — inputs, fee and change alike — is
    // Account 0's before the password is typed.
    const { planId } = await k.prepareSend({ destination: DEST, amountSats: 10_000n, fetchUtxos });
    store.arm();
    const send = k.confirmSend({
      planId,
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
    const signed = await reviewAndSend(restarted, {
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

  it('a routine refresh scans the active account only', async () => {
    // Privacy, and the cost that carries it: walking every known account on
    // every refresh sent one 20-address gap window per chain per account to a
    // public explorer whether or not anything had changed — measured at 168
    // requests for a four-account wallet with nothing to find. The other
    // accounts move on an explicit rescan and when the switcher opens.
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a1 = (await k.createAccount()).address;
    await k.switchAccount(0);
    expect((await k.status()).activeAccount).toBe(0);

    const seen = new Set<string>();
    const lookup = async (address: string) => {
      seen.add(address);
      return {
        used: address === a1,
        txCount: address === a1 ? 1 : 0,
        reportedBalanceSats: 0n,
      };
    };

    await k.scan(lookup, coins({ [a1]: [utxo(a1, 7_000n)] }));
    // Account 1's very first address was never asked about, so its payment is
    // not seen yet — and nothing about account 1 reached the explorer.
    expect(seen.has(a1)).toBe(false);
    let meta = await store.loadMeta();
    expect(meta?.accounts.find((a) => a.index === 1)?.externalNext).toBe(0);
    expect(meta?.accounts.find((a) => a.index === 1)?.lastBalanceSats).toBe('0');

    // Opening the switcher is the pass that fills the others in.
    await k.scan(lookup, coins({ [a1]: [utxo(a1, 7_000n)] }), null, { accounts: 'all' });
    expect(seen.has(a1)).toBe(true);
    meta = await store.loadMeta();
    expect(meta?.accounts.find((a) => a.index === 1)?.externalNext).toBe(1);
    expect(meta?.accounts.find((a) => a.index === 1)?.lastBalanceSats).toBe('7000');
    // …and the account nobody paid is left exactly where it was.
    expect(meta?.accounts.find((a) => a.index === 0)?.externalNext).toBe(0);
    expect(meta?.accounts.find((a) => a.index === 0)?.lastBalanceSats).toBe('0');
  });

  it('a full rescan reaches every account the user created', async () => {
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a1 = (await k.createAccount()).address;
    await k.switchAccount(0);
    const scan = await k.scan(
      async (address) => ({
        used: address === a1,
        txCount: address === a1 ? 1 : 0,
        reportedBalanceSats: 0n,
      }),
      coins({ [a1]: [utxo(a1, 7_000n)] }),
      null,
      { full: true },
    );
    expect(scan.scannedAccounts).toEqual([0, 1]);
    const meta = await store.loadMeta();
    expect(meta?.accounts.find((a) => a.index === 1)?.lastBalanceSats).toBe('7000');
  });

  it('no scan of any kind adds an account the user never created', async () => {
    // The deleted feature, pinned shut. Speculative account discovery could not
    // do what it promised — an account that never received coins leaves nothing
    // on any chain — and paid for the attempt by handing a public explorer ~20
    // addresses per guessed account. The switcher and the docs now tell the
    // user to press Add account instead; this is what keeps that true.
    const restored = ring();
    await restored.importMnemonic(MNEMONIC, PASSWORD);
    // Funded accounts 1 and 2, on chain, that this device has never heard of.
    const funded = new Set(
      [1, 2].map((n) => addressFromHdSeed(HD, 'external', 0, 'testnet', n).address),
    );
    const asked = new Set<string>();
    const lookup = async (address: string) => {
      asked.add(address);
      const used = funded.has(address);
      return { used, txCount: used ? 1 : 0, reportedBalanceSats: 0n };
    };
    for (const opts of [{}, { full: true }, { accounts: 'all' as const }]) {
      const scan = await restored.scan(lookup, async () => [], null, opts);
      expect(scan.scannedAccounts).toEqual([0]);
      expect((await restored.status()).accounts.map((a) => a.index)).toEqual([0]);
    }
    // Not merely "not adopted": never asked about. The explorer was told
    // nothing at all about an account this device does not have.
    for (const address of funded) expect(asked.has(address)).toBe(false);
  });

  it('a meta a pre-accounts build round-tripped does not hand account 0 another account\'s balance', () => {
    // User loss: the top-level cursors are a mirror of the *active* account. A
    // rollback build (or a hand-edited record) drops the accounts list but can
    // leave `activeAccount` behind, and account 0 then showed account 2's
    // balance and re-derived from account 2's cursor — a receive address that
    // is not account 0's, and a number that is nobody's.
    const rolled = parseMeta({
      network: 'testnet',
      origin: 'bip39',
      activeAccount: 2,
      externalNext: 5,
      internalNext: 3,
      lastBalanceSats: '123456',
      confirmedBalanceSats: '100000',
    });
    expect(rolled?.accounts.find((a) => a.index === 0)).toMatchObject({
      externalNext: 0,
      internalNext: 0,
      lastBalanceSats: '0',
      confirmedBalanceSats: '0',
    });
    expect(rolled?.accounts.find((a) => a.index === 2)).toMatchObject({
      externalNext: 5,
      internalNext: 3,
      lastBalanceSats: '123456',
      confirmedBalanceSats: '100000',
    });
    expect(rolled?.activeAccount).toBe(2);

    // The genuine pre-accounts record — no activeAccount at all — is still
    // account 0's, and keeps its cursors. Migration must not regress.
    const v1 = parseMeta({
      network: 'testnet',
      origin: 'bip39',
      externalNext: 5,
      internalNext: 3,
      lastBalanceSats: '123456',
    });
    expect(v1?.accounts).toHaveLength(1);
    expect(v1?.accounts[0]).toMatchObject({ index: 0, externalNext: 5, lastBalanceSats: '123456' });
    expect(v1?.externalNext).toBe(5);
  });

  it('an account name carries no invisible controls and no half a character', async () => {
    // Attacker gain: the name is the only attacker-writable string this chrome
    // renders, right beside a shortened address. U+202E reverses what follows
    // it, U+200B pads with width the user cannot see, U+2028 ends the line —
    // all of them survived a filter that only dropped C0 and DEL.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const renamed = await k.renameAccount(0, 'Pay\u202Eroll\u200B\u2028\u0007');
    expect(renamed.name).toBe('Payroll');
    expect(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(renamed.name)).toBe(false);

    // Storage is the real attacker path, and it goes through the same filter.
    const poisoned = parseMeta({
      network: 'testnet',
      origin: 'bip39',
      accounts: [{ index: 0, name: 'Sav\u202Eings\u200B' }],
    });
    expect(poisoned?.accounts[0]?.name).toBe('Savings');

    // The cap is code points, not UTF-16 units: an astral name must never be
    // stored cut in half, which is what `slice(0, 32)` did to it.
    const long = await k.renameAccount(0, `a${'\u{1F600}'.repeat(40)}`);
    expect([...long.name]).toHaveLength(ACCOUNT_NAME_MAX);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(long.name)).toBe(false);
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

/**
 * A refresh is a long read. The user goes on using the wallet while it runs,
 * and every choice they make in that window is a write to the same record.
 */
describe('a scan in flight never overwrites the user\'s own choices', () => {
  /** A lookup that parks on its first call, so a scan can be held mid-flight. */
  function gatedLookup() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let parked = false;
    const lookup = async () => {
      if (!parked) {
        parked = true;
        await gate;
      }
      return { used: false, txCount: 0, reportedBalanceSats: 0n };
    };
    return { lookup, release: () => release() };
  }

  const tick = () => new Promise((r) => setTimeout(r, 20));

  it('a switch that lands mid-scan stays switched — and the next send is not redirected', async () => {
    // The failure this pins, in full: `scan` loaded the whole WalletMeta, awaited
    // dozens of lookups, then wrote its stale snapshot back — reverting the
    // active account. The header still said Account 2 (the popup re-reads it
    // only on the next status), so the user's next send debited Account 1.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    await k.approveConnect(DAPP);
    await k.createAccount();
    await k.switchAccount(0);

    const { lookup, release } = gatedLookup();
    const scanning = k.scan(lookup, async () => []);
    await tick();
    await k.switchAccount(1);
    release();
    await scanning;

    expect((await k.status()).activeAccount).toBe(1);
    // The site approved on account 0 must still see nothing: a reverted switch
    // silently handed it back an address the user had moved away from.
    expect((await k.getAccounts(DAPP)).accounts).toEqual([]);
    expect((await k.receiveAddress()).address).not.toBe(a0);
  });

  it('an account created mid-scan is still there when the scan lands', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const { lookup, release } = gatedLookup();
    const scanning = k.scan(lookup, async () => []);
    await tick();
    const made = await k.createAccount();
    release();
    await scanning;

    const after = await k.status();
    expect(after.accounts.map((a) => a.index)).toContain(made.index);
    expect(after.activeAccount).toBe(made.index);
  });

  it('a rename that lands mid-scan is not written back over', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const { lookup, release } = gatedLookup();
    const scanning = k.scan(lookup, async () => []);
    await tick();
    await k.renameAccount(0, 'Payroll');
    release();
    await scanning;

    expect((await k.status()).accounts.find((a) => a.index === 0)?.name).toBe('Payroll');
  });

  it('the scan still commits what it learned about the chain', async () => {
    // The merge must not be a no-op: the cursors, tip and balance are the
    // scan's own and have to land even though the user moved underneath it.
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let parked = false;
    const lookup = async (address: string) => {
      if (!parked) {
        parked = true;
        await gate;
      }
      return { used: address === a0, txCount: address === a0 ? 1 : 0, reportedBalanceSats: 0n };
    };

    const scanning = k.scan(lookup, coins({ [a0]: [utxo(a0, 5_000n)] }), { height: 900_100, hash: 'ab' });
    await tick();
    await k.renameAccount(0, 'Payroll');
    release();
    await scanning;

    const meta = await store.loadMeta();
    const rec = meta?.accounts.find((a) => a.index === 0);
    expect(rec?.name).toBe('Payroll');
    expect(rec?.externalNext).toBe(1);
    expect(rec?.lastBalanceSats).toBe('5000');
    expect(rec?.balanceAt).not.toBeNull();
    expect(meta?.tipHeight).toBe(900_100);
  });
});

describe('a scan never hands the same change address out twice', () => {
  /**
   * The change cursor is the one cursor the wallet advances by itself:
   * `confirmSend` moves `internalNext` past the address it has just paid change
   * to. Everything else in an `AccountRecord` is a reading of the chain, and a
   * full rescan is authoritative about those. It is not authoritative about
   * this one, because the transaction it would have to see is in a mempool the
   * explorer has not indexed — or, when the broadcast failed, is nowhere at
   * all. A walk therefore reads that change address as unused and reports a
   * lower stop, and taking it verbatim sends the *next* change straight back to
   * the same address. Two change outputs of two transactions on one address is
   * a permanent, public link between them, for anyone reading the chain.
   */
  const tick = () => new Promise((r) => setTimeout(r, 20));

  /** Every address unused except `used`; the explorer knows nothing of our sends. */
  function blindLookup(used: string[]) {
    const seen = new Set(used);
    return async (address: string) => ({
      used: seen.has(address),
      txCount: seen.has(address) ? 1 : 0,
      reportedBalanceSats: 0n,
    });
  }

  /** Two coins on the receive address, so a second send has something to spend. */
  function twoCoins(a0: string) {
    return coins({
      [a0]: [utxo(a0, 90_000_000n, 'aa'.repeat(32)), utxo(a0, 90_000_000n, 'bb'.repeat(32))],
    });
  }

  /** The address the change output of a signed transaction pays. */
  function changeAddressOf(hex: string): string {
    const outs = decodeTxPreview(hex, 'testnet').outputs;
    expect(outs).toHaveLength(2);
    return outs[1]!.address!;
  }

  async function send(k: Keyring, fetchUtxos: (a: string) => Promise<ExplorerUtxo[]>) {
    return reviewAndSend(k, {
      destination: DEST,
      amountSats: 10_000_000n,
      password: PASSWORD,
      fetchUtxos,
      broadcast: async (hex) => ({ txid: txidOf(parseTx(hex)), via: 'node' as const }),
    });
  }

  it('a full rescan in flight over a send does not walk the change cursor back', async () => {
    // The reported race: Settings → Rescan all addresses, close the popup, then
    // send. The rescan keeps running in the worker and commits last.
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    const fetchUtxos = twoCoins(a0);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let parked = false;
    const lookup = async (address: string) => {
      if (!parked) {
        parked = true;
        await gate;
      }
      return { used: address === a0, txCount: address === a0 ? 1 : 0, reportedBalanceSats: 0n };
    };

    const scanning = k.scan(lookup, undefined, null, { full: true });
    await tick();
    const first = await send(k, fetchUtxos);
    release();
    await scanning;

    expect((await store.loadMeta())?.accounts.find((a) => a.index === 0)?.internalNext).toBe(1);
    // The money assertion: the next send's change goes somewhere new.
    const second = await send(k, fetchUtxos);
    expect(changeAddressOf(second.hex)).not.toBe(changeAddressOf(first.hex));
    expect(changeAddressOf(first.hex)).toBe(k.addressAt('internal', 0).address);
    expect(changeAddressOf(second.hex)).toBe(k.addressAt('internal', 1).address);
  });

  it('a full rescan the send finished before does not either', async () => {
    // The wider door, and the one with no race in it at all: the send committed
    // first and the rescan started afterwards, so a snapshot taken when the
    // pass began already carries the advanced cursor. What makes the walk read
    // low is not *when* it started but that the explorer has not indexed the
    // transaction — a mempool it does not serve, an indexer minutes behind, or
    // a broadcast that failed outright and left the change output nowhere.
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    const fetchUtxos = twoCoins(a0);

    const first = await send(k, fetchUtxos);
    expect((await store.loadMeta())?.accounts.find((a) => a.index === 0)?.internalNext).toBe(1);

    await k.scan(blindLookup([a0]), undefined, null, { full: true });

    expect((await store.loadMeta())?.accounts.find((a) => a.index === 0)?.internalNext).toBe(1);
    const second = await send(k, fetchUtxos);
    expect(changeAddressOf(second.hex)).not.toBe(changeAddressOf(first.hex));
  });

  /** The stored change cursor of account 0 — the number the whole walk is sized by. */
  async function internalNext(store: MemoryWalletStorage): Promise<number | undefined> {
    return (await store.loadMeta())?.accounts.find((a) => a.index === 0)?.internalNext;
  }

  it('a full rescan still walks a cursor down when the chain really disagrees', async () => {
    // The other half of the contract, and the reason `full` exists: a receive
    // cursor that ran ahead of the chain — a bad explorer answer, a reorg — has
    // to be correctable, or "Rescan all addresses" fixes nothing. Nothing but
    // the chain advances this one, so there is no local knowledge to protect.
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const used = [0, 1, 2].map((i) => k.addressAt('external', i).address);

    await k.scan(blindLookup(used));
    expect((await store.loadMeta())?.accounts.find((a) => a.index === 0)?.externalNext).toBe(3);

    await k.scan(blindLookup([]), undefined, null, { full: true });
    expect((await store.loadMeta())?.accounts.find((a) => a.index === 0)?.externalNext).toBe(0);
  });

  it('a full rescan walks the change cursor down too, not only the receive one', async () => {
    // The same half of the contract, on the other chain — and the half that
    // went missing when the concurrent-send race was closed. "Rescan all
    // addresses" that repairs one cursor and not the other does not mean what
    // its label says, and the chain it skips is the expensive one: `eachAddress`
    // walks 0..internalNext *inclusive* on every `gatherUtxos`, so a change
    // cursor stranded at 300 is 302 explorer lookups and 302 ML-DSA derivations
    // behind every balance, every history and every send, for good.
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const used = [0, 1, 2].map((i) => k.addressAt('internal', i).address);

    // An explorer that says our change addresses are used drives the cursor up.
    await k.scan(blindLookup(used));
    expect(await internalNext(store)).toBe(3);

    // An honest one, and nothing of ours in flight, has to be able to bring it
    // back. There is no local knowledge to protect here: no send is pending.
    await k.scan(blindLookup([]), undefined, null, { full: true });
    expect(await internalNext(store)).toBe(0);
  });

  it('a change cursor a hostile storage write left behind is repaired, not permanent', async () => {
    // `parseMeta` names this threat in its own words: anything that can write
    // extension storage can set a huge cursor and make the wallet derive
    // thousands of keys. `counter()` bounds it at 1_000_000 — which is the
    // number of explorer lookups and ML-DSA derivations that would then sit in
    // front of every balance read. A wallet the user cannot repair from the
    // Settings button labelled "Rescan all addresses" is bricked.
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);

    const poisoned = (await store.loadMeta())!;
    poisoned.accounts.find((a) => a.index === 0)!.internalNext = 1_000_000;
    poisoned.internalNext = 1_000_000;
    await store.saveMeta(poisoned);

    await k.scan(blindLookup([]), undefined, null, { full: true });
    expect(await internalNext(store)).toBe(0);
  });

  it('a forged activity row cannot pin the change cursor high', async () => {
    // The floor is what lets a rescan lower this cursor safely, so the floor is
    // the next thing to attack: write the cursor *and* a row claiming a change
    // index that would hold it there. The row carries a real transaction of
    // ours — the attacker can copy one out of storage — but its outputs pay the
    // index it actually paid, not the one the row now names, and that is the
    // check. Forging the address instead would take the seed.
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    const first = await send(k, twoCoins(a0));
    expect(await internalNext(store)).toBe(1);

    const poisoned = (await store.loadMeta())!;
    poisoned.accounts.find((a) => a.index === 0)!.internalNext = 500;
    poisoned.internalNext = 500;
    await store.saveMeta(poisoned);
    const rows = await store.loadActivity();
    expect(rows[0]?.changeIndex).toBe(0);
    await store.saveActivity([...rows, { ...rows[0]!, txid: 'cd'.repeat(32), changeIndex: 499 }]);

    await k.scan(blindLookup([a0]), undefined, null, { full: true });

    // Back to the floor the real send proved, not to the one the forgery
    // claimed — and the genuine in-flight change is still protected.
    expect(await internalNext(store)).toBe(1);
    const second = await send(k, twoCoins(a0));
    expect(changeAddressOf(second.hex)).not.toBe(changeAddressOf(first.hex));
    expect(changeAddressOf(second.hex)).toBe(k.addressAt('internal', 1).address);
  });
});
