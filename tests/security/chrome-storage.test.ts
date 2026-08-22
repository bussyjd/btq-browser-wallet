/**
 * The real ChromeWalletStorage against a fake chrome.storage.local — the
 * production storage class, not the in-memory double the other tests use.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChromeWalletStorage } from '../../src/background/chrome-storage.js';
import { loadBackend, saveBackend } from '../../src/background/backend-store.js';
import { Keyring } from '../../src/core/wallet/keyring.js';
import { emptyMeta, parseActivity, parseMeta } from '../../src/core/wallet/storage.js';
import { mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';
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
  });

  it('a wipe removes every wallet key from storage', async () => {
    // User loss: leftovers after "remove wallet" mean the encrypted seed is
    // still on a machine the user believes they cleaned.
    const storage = new ChromeWalletStorage();
    const keyring = new Keyring(storage, { encrypt: TEST_ENCRYPT, network: 'testnet' });
    await keyring.importMnemonic(MNEMONIC, PASSWORD);
    await storage.saveOrigins(['https://dapp.example']);
    await storage.savePendingConnect({ origin: 'https://dapp.example' });
    await storage.saveActivity([
      { txid: 'aa'.repeat(32), status: 'signed', destination: 'x', amountSats: '1', feeSats: '1', at: 1 },
    ]);
    await keyring.wipe('DELETE');
    for (const key of ['vault', 'meta', 'origins', 'pendingConnect', 'activity']) {
      expect(fake.store.has(key), key).toBe(false);
    }
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
});

describe('storage validators in isolation', () => {
  it('parseMeta keeps a well-formed record and fills in new fields', () => {
    const meta = parseMeta({ network: 'testnet', origin: 'bip39', externalNext: 3, usedExternal: 2 });
    expect(meta).toMatchObject({ externalNext: 3, usedExternal: 2, confirmedBalanceSats: '0', tipHeight: null });
    expect(meta?.scannedExternal).toBe(-1);
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
  });
});
