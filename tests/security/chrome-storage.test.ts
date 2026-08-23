/**
 * The real ChromeWalletStorage against a fake chrome.storage.local — the
 * production storage class, not the in-memory double the other tests use.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChromeWalletStorage } from '../../src/background/chrome-storage.js';
import { loadBackend, saveBackend } from '../../src/background/backend-store.js';
import { Keyring } from '../../src/core/wallet/keyring.js';
import { emptyMeta, parseActivity, parseMeta } from '../../src/core/wallet/storage.js';
import { mnemonicToEntropy, mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';
import { encryptVault } from '../../src/core/vault/encrypt.js';
import { bytesToHex } from '../../src/core/util/hex.js';
import { FakeChrome, uninstallChrome } from '../helpers/fake-chrome.js';
import { TEST_ENCRYPT } from '../helpers/memory-store.js';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'testnet-ok';

let fake: FakeChrome;

beforeEach(() => {
  fake = new FakeChrome();
  fake.install();
});

afterEach(() => {
  uninstallChrome();
});

function dump(): string {
  return JSON.stringify([...fake.store.entries()]);
}

describe('persisted extension storage', () => {
  it('stores only the sealed vault and metadata after an import', async () => {
    // Attacker gain: anything readable in storage that reconstructs the seed
    // turns "read chrome.storage" into "spend every coin".
    const keyring = new Keyring(new ChromeWalletStorage(), { encrypt: TEST_ENCRYPT, network: 'testnet' });
    await keyring.importMnemonic(MNEMONIC, PASSWORD);

    expect([...fake.store.keys()].sort()).toEqual(['meta', 'vault']);
    const vault = fake.store.get('vault') as string;
    expect(vault.startsWith('42545131')).toBe(true); // "BTQ1" magic

    const serialized = dump();
    expect(serialized).not.toContain(MNEMONIC);
    expect(serialized).not.toContain('abandon abandon');
    expect(serialized).not.toContain(bytesToHex(mnemonicToHdSeed(MNEMONIC)));
    expect(serialized).not.toContain(PASSWORD);
    // The BIP39 entropy the v2 vault seals is the phrase's preimage; it is
    // stored inside the ciphertext and nowhere a reader of storage can see.
    const entropyHex = bytesToHex(mnemonicToEntropy(MNEMONIC));
    expect(entropyHex).toHaveLength(32);
    expect(serialized).not.toContain(entropyHex);
    expect(serialized).not.toContain('entropyHex');
  });

  it('a wipe removes every wallet key from storage', async () => {
    // User loss: leftovers after "remove wallet" mean the encrypted seed is
    // still on a machine the user believes they cleaned.
    const storage = new ChromeWalletStorage();
    const keyring = new Keyring(storage, { encrypt: TEST_ENCRYPT, network: 'testnet' });
    await keyring.importMnemonic(MNEMONIC, PASSWORD);
    await storage.saveOrigins(['https://dapp.example']);
    await storage.savePendingConnect({ origin: 'https://dapp.example' });
    // The multi-prompt mirror the service worker writes (`pendingConnects`).
    // The single-slot `pendingConnect` above is the record older builds wrote;
    // a wipe that only knows the legacy name leaves the live one behind.
    fake.store.set('pendingConnects', [{ origin: 'https://dapp.example', at: 1 }]);
    await storage.saveActivity([
      { txid: 'aa'.repeat(32), status: 'signed', destination: 'x', amountSats: '1', feeSats: '1', at: 1 },
    ]);
    await keyring.wipe('DELETE');
    for (const key of ['vault', 'meta', 'origins', 'pendingConnect', 'pendingConnects', 'activity']) {
      expect(fake.store.has(key), key).toBe(false);
    }
    expect([...fake.store.keys()]).toEqual([]);
  });

  it('the node RPC password lives only under `backend`, never in the vault record', async () => {
    const keyring = new Keyring(new ChromeWalletStorage(), { encrypt: TEST_ENCRYPT, network: 'testnet' });
    await keyring.importMnemonic(MNEMONIC, PASSWORD);
    await saveBackend({
      explorerBase: 'https://explorer.example',
      node: { url: 'http://127.0.0.1:18332', user: 'm0', password: 'node-secret' },
    });
    expect(JSON.stringify(fake.store.get('vault'))).not.toContain('node-secret');
    expect(JSON.stringify(fake.store.get('meta'))).not.toContain('node-secret');
    expect((await loadBackend()).node?.password).toBe('node-secret');
  });

  it('rejects tampered metadata instead of trusting it', async () => {
    // Attacker gain: a huge externalNext makes every unlock derive thousands of
    // ML-DSA keys (a wedge), and a junk balance string breaks the popup.
    const storage = new ChromeWalletStorage();
    await storage.saveMeta(emptyMeta('testnet', 'bip39'));
    fake.store.set('meta', { network: 'testnet', origin: 'bip39', externalNext: 9e12, lastBalanceSats: { evil: 1 } });
    const meta = await storage.loadMeta();
    expect(meta?.externalNext).toBe(0);
    expect(meta?.lastBalanceSats).toBe('0');

    fake.store.set('meta', { network: 'bitcoin', origin: 'bip39' });
    expect(await storage.loadMeta()).toBeNull();
    fake.store.set('meta', 'not an object');
    expect(await storage.loadMeta()).toBeNull();
  });

  it('drops malformed activity rows and non-origin entries in the allowlist', async () => {
    // Attacker gain: a forged origin string in storage would silently grant a
    // site the connect permission the user never approved.
    const storage = new ChromeWalletStorage();
    fake.store.set('origins', ['https://ok.example', 'not-an-origin', 42, 'https://evil.example/path']);
    expect(await storage.loadOrigins()).toEqual(['https://ok.example']);

    fake.store.set('activity', [
      { txid: 'zz'.repeat(32), status: 'pending', destination: 'x', amountSats: '1', feeSats: '1', at: 1 },
      { txid: 'aa'.repeat(32), status: 'nonsense', destination: 'x', amountSats: '1', feeSats: '1', at: 1 },
      { txid: 'bb'.repeat(32), status: 'pending', destination: 'x', amountSats: '1', feeSats: '1', at: 1 },
    ]);
    const activity = await storage.loadActivity();
    expect(activity).toHaveLength(1);
    expect(activity[0]!.txid).toBe('bb'.repeat(32));
  });

  it('a vault written by an older build still round-trips through the same class', async () => {
    const storage = new ChromeWalletStorage();
    const keyring = new Keyring(storage, { encrypt: TEST_ENCRYPT, network: 'testnet' });
    await keyring.importMnemonic(MNEMONIC, PASSWORD);
    const before = await keyring.receiveAddress();
    const restarted = new Keyring(new ChromeWalletStorage(), { encrypt: TEST_ENCRYPT, network: 'testnet' });
    await restarted.unlock(PASSWORD);
    expect((await restarted.receiveAddress()).address).toBe(before.address);
  });

  it('a genuine v1 vault record is refused as too old, through the real storage class', async () => {
    // The test above writes a *current-build* vault, so it cannot notice a
    // decoder that quietly accepted an old one. This one writes the bytes the
    // pre-2 build actually produced — v1, no entropy field at all — into the
    // same `chrome.storage.local` the extension reads, and the refusal has to
    // survive the whole round trip rather than only the in-memory one.
    const storage = new ChromeWalletStorage();
    const plain = new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        network: 'testnet',
        origin: 'bip39',
        hdSeedHex: bytesToHex(mnemonicToHdSeed(MNEMONIC)),
      }),
    );
    await storage.saveVault(await encryptVault(plain, PASSWORD, TEST_ENCRYPT));
    await storage.saveMeta(emptyMeta('testnet', 'bip39'));

    const keyring = new Keyring(new ChromeWalletStorage(), { encrypt: TEST_ENCRYPT, network: 'testnet' });
    await expect(keyring.unlock(PASSWORD)).rejects.toMatchObject({ code: 'VAULT_TOO_OLD' });
    expect((await keyring.status()).unlocked).toBe(false);
    await expect(keyring.receiveAddress()).rejects.toThrow(/locked/i);
    // Nothing was destroyed on the way past: the record is still in storage for
    // the user to remove deliberately, and it is still the old one.
    expect(await new ChromeWalletStorage().loadVault()).not.toBeNull();

    // Once removed, the phrase behind it imports into a wallet that works — the
    // route the refusal actually names.
    await storage.clear();
    const reference = new Keyring(new ChromeWalletStorage(), { encrypt: TEST_ENCRYPT, network: 'testnet' });
    await reference.importMnemonic(MNEMONIC, PASSWORD);
    expect((await reference.receiveAddress()).address).toMatch(/^tbtq1z/);
    expect((await reference.status()).canRevealPhrase).toBe(true);
  });
});

describe('storage validators in isolation', () => {
  it('parseMeta keeps a well-formed record and fills in new fields', () => {
    const meta = parseMeta({ network: 'testnet', origin: 'bip39', externalNext: 3, usedExternal: 2 });
    expect(meta).toMatchObject({ externalNext: 3, usedExternal: 2, confirmedBalanceSats: '0', tipHeight: null });
    expect(meta?.scannedExternal).toBe(-1);
    expect(meta?.activeAccount).toBe(0);
    expect(meta?.accounts).toHaveLength(1);
    expect(meta?.accounts[0]).toMatchObject({ index: 0, name: 'Account 1', externalNext: 3, usedExternal: 2 });
  });

  it('parseMeta keeps extra accounts and mirrors the active one onto the top-level cursors', () => {
    const meta = parseMeta({
      network: 'testnet',
      origin: 'bip39',
      externalNext: 0,
      activeAccount: 1,
      accounts: [
        { index: 0, name: 'Savings', externalNext: 2 },
        { index: 1, name: 'Spending', externalNext: 4, lastBalanceSats: '123' },
      ],
    });
    expect(meta?.activeAccount).toBe(1);
    expect(meta?.externalNext).toBe(4);
    expect(meta?.lastBalanceSats).toBe('123');
    expect(meta?.accounts.map((a) => a.name)).toEqual(['Savings', 'Spending']);
  });

  it('parseMeta drops a huge or duplicate accounts list instead of deriving it', () => {
    const raw = {
      network: 'testnet',
      origin: 'bip39',
      accounts: Array.from({ length: 50 }, (_, i) => ({ index: i, name: `A${i}`, externalNext: 9e12 })),
    };
    const meta = parseMeta(raw);
    expect(meta?.accounts.length).toBeLessThanOrEqual(20);
    expect(meta?.accounts.every((a) => a.externalNext === 0)).toBe(true);
  });

  it('parseMeta inserts account 0 when a poisoned list omits it', () => {
    // Attacker gain: hiding m/0'/… behind a lone index-19 record makes the
    // wallet look empty and, with nextIndex already at the cap, unrecoverable
    // without a wipe-and-restore.
    const meta = parseMeta({
      network: 'testnet',
      origin: 'bip39',
      activeAccount: 19,
      accounts: [{ index: 19, name: 'Trap', externalNext: 4, lastBalanceSats: '9' }],
    });
    expect(meta?.accounts.map((a) => a.index)).toEqual([0, 19]);
    expect(meta?.accounts.find((a) => a.index === 0)?.externalNext).toBe(0);
    expect(meta?.activeAccount).toBe(19);
    expect(meta?.externalNext).toBe(4);
  });

  it('parseActivity keeps hex, broadcast fields and reserved outpoints', () => {
    const rows = parseActivity([
      {
        txid: 'AB'.repeat(32),
        status: 'signed',
        destination: 'tbtq1z…',
        amountSats: '1000',
        feeSats: '372',
        hex: 'deadBEEF',
        broadcastError: 'min relay fee not met',
        broadcastVia: 'node',
        spends: ['aa'.repeat(32) + ':0', 'garbage'],
        at: 5,
      },
    ]);
    expect(rows[0]!.txid).toBe('ab'.repeat(32));
    expect(rows[0]!.hex).toBe('deadBEEF');
    expect(rows[0]!.broadcastVia).toBe('node');
    expect(rows[0]!.spends).toEqual(['aa'.repeat(32) + ':0']);
    expect(rows[0]!.accountIndex).toBe(0);
  });

  it('parseActivity keeps a well-formed accountIndex and defaults a missing one to 0', () => {
    const rows = parseActivity([
      {
        txid: 'aa'.repeat(32),
        status: 'pending',
        destination: 'x',
        amountSats: '1',
        feeSats: '1',
        at: 1,
        accountIndex: 3,
      },
      {
        txid: 'bb'.repeat(32),
        status: 'signed',
        destination: 'x',
        amountSats: '1',
        feeSats: '1',
        at: 1,
      },
      {
        txid: 'cc'.repeat(32),
        status: 'pending',
        destination: 'x',
        amountSats: '1',
        feeSats: '1',
        at: 1,
        accountIndex: 99,
      },
    ]);
    expect(rows[0]!.accountIndex).toBe(3);
    expect(rows[1]!.accountIndex).toBe(0);
    expect(rows[2]!.accountIndex).toBe(0);
  });
});
