import { describe, it, expect } from 'vitest';
import { Keyring } from '../../src/core/wallet/keyring.js';
import { WalletError } from '../../src/core/wallet/errors.js';
import { mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';
import { bytesToHex } from '../../src/core/util/hex.js';
import { MemoryWalletStorage, TEST_ENCRYPT } from '../helpers/memory-store.js';

const PASSWORD = 'testnet-ok';
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function ring(store = new MemoryWalletStorage(), now?: { t: number }) {
  return new Keyring(store, {
    encrypt: TEST_ENCRYPT,
    network: 'testnet',
    now: now ? () => now.t : undefined,
    lockAfterMs: 60_000,
  });
}

describe('keyring — paths that leak secrets or skip the vault', () => {
  it('does not persist anything until the seed is confirmed', async () => {
    const store = new MemoryWalletStorage();
    const k = ring(store);
    const reveal = await k.create(PASSWORD);
    expect(reveal.mnemonic.split(' ')).toHaveLength(12);
    expect(await store.loadVault()).toBeNull();
    expect((await k.status()).hasVault).toBe(false);
    expect((await k.status()).pendingReveal).toBe(true);
  });

  it('status never re-returns the mnemonic after the one-shot reveal', async () => {
    const k = ring();
    const reveal = await k.create(PASSWORD);
    const status = await k.status();
    expect(JSON.stringify(status).includes(reveal.mnemonic)).toBe(false);
    expect('mnemonic' in status).toBe(false);
  });

  it('a wrong confirmation leaves the store empty', async () => {
    const store = new MemoryWalletStorage();
    const k = ring(store);
    const reveal = await k.create(PASSWORD);
    await expect(
      k.confirm(reveal.challenge.map((index) => ({ index, word: 'abandon' })), PASSWORD),
    ).rejects.toBeInstanceOf(WalletError);
    expect(await store.loadVault()).toBeNull();
  });

  it('confirm seals the vault and a later Keyring instance is locked until unlock', async () => {
    const store = new MemoryWalletStorage();
    const k = ring(store);
    const reveal = await k.create(PASSWORD);
    const words = reveal.mnemonic.split(' ');
    await k.confirm(reveal.challenge.map((index) => ({ index, word: words[index]! })), PASSWORD);
    expect(await store.loadVault()).not.toBeNull();

    const restarted = ring(store);
    expect((await restarted.status()).unlocked).toBe(false);
    await expect(restarted.receiveAddress()).rejects.toThrow(/locked/i);
    await restarted.unlock(PASSWORD);
    const a = await restarted.receiveAddress();
    expect(a.address.startsWith('tbtq1z')).toBe(true);
  });

  it('vault blob does not contain the mnemonic or HD seed hex', async () => {
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const blob = await store.loadVault();
    expect(blob).not.toBeNull();
    const latin = new TextDecoder('latin1').decode(blob!);
    expect(latin.includes(MNEMONIC)).toBe(false);
    expect(latin.includes(bytesToHex(mnemonicToHdSeed(MNEMONIC)))).toBe(false);
  });

  it('wrong unlock does not leave the keyring unlocked', async () => {
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    k.lock();
    await expect(k.unlock('wrong-pass')).rejects.toThrow('Incorrect password.');
    expect((await k.status()).unlocked).toBe(false);
    await expect(k.receiveAddress()).rejects.toThrow(/locked/i);
  });

  it('locked wallet cannot derive a receive address', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    k.lock();
    await expect(k.receiveAddress()).rejects.toThrow(/locked/i);
  });

  it('rejects a second import while a vault exists', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    await expect(k.importMnemonic(MNEMONIC, PASSWORD)).rejects.toThrow(/already exists/);
    await expect(k.importSeed('11'.repeat(32), PASSWORD)).rejects.toThrow(/already exists/);
  });

  it('importing the same mnemonic twice (after wipe) yields the same address', async () => {
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const first = await k.receiveAddress();
    await k.wipe('DELETE');
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const second = await k.receiveAddress();
    expect(second.address).toBe(first.address);
  });

  it('mnemonic import and raw-seed import are different wallets', async () => {
    const a = ring();
    await a.importMnemonic(MNEMONIC, PASSWORD);
    const b = ring();
    await b.importSeed('00'.repeat(32), PASSWORD);
    expect((await a.receiveAddress()).address).not.toBe((await b.receiveAddress()).address);
  });

  it('gap scan advances the receive index past used addresses', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const first = await k.receiveAddress();
    await k.scan(async (address) => ({
      used: address === first.address,
      txCount: address === first.address ? 1 : 0,
      reportedBalanceSats: address === first.address ? 50_000n : 0n,
    }));
    const next = await k.receiveAddress();
    expect(next.index).toBe(1);
    expect(next.address).not.toBe(first.address);
  });

  it('auto-lock clears the in-memory seed after the timeout', async () => {
    const clock = { t: 1_000 };
    const k = ring(new MemoryWalletStorage(), clock);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    expect((await k.status()).unlocked).toBe(true);
    clock.t += 61_000;
    expect((await k.status()).unlocked).toBe(false);
    await expect(k.receiveAddress()).rejects.toThrow(/locked/i);
  });

  it('seed confirmation cannot be satisfied by repeating one correct word', async () => {
    // Attacker gain: sealing the vault after writing down a single challenge
    // word leaves no usable backup — device loss then permanently burns funds.
    const store = new MemoryWalletStorage();
    const k = ring(store);
    const reveal = await k.create(PASSWORD);
    const words = reveal.mnemonic.split(' ');
    const only = reveal.challenge[0]!;
    await expect(
      k.confirm(
        reveal.challenge.map(() => ({ index: only, word: words[only]! })),
        PASSWORD,
      ),
    ).rejects.toThrow(/do not match/);
    expect(await store.loadVault()).toBeNull();
    expect((await k.status()).pendingReveal).toBe(true);
  });

  it('an abandoned create does not disable auto-lock after import', async () => {
    // Attacker gain: the HD seed would stay decrypted in the service worker
    // forever, so a later memory dump or SW compromise recovers spendable keys.
    const clock = { t: 1_000 };
    const k = ring(new MemoryWalletStorage(), clock);
    await k.create(PASSWORD);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    expect((await k.status()).pendingReveal).toBe(false);
    expect((await k.status()).unlocked).toBe(true);
    clock.t += 61_000;
    expect((await k.status()).unlocked).toBe(false);
    await expect(k.receiveAddress()).rejects.toThrow(/locked/i);
  });

  it('confirm cannot overwrite an imported vault with the unconfirmed create seed', async () => {
    // Attacker gain: swapping the imported seed for the never-backed-up create
    // mnemonic would make later spends burn the imported wallet's coins.
    const store = new MemoryWalletStorage();
    const k = ring(store);
    const reveal = await k.create(PASSWORD);
    const words = reveal.mnemonic.split(' ');
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const imported = await k.receiveAddress();
    await expect(
      k.confirm(
        reveal.challenge.map((index) => ({ index, word: words[index]! })),
        PASSWORD,
      ),
    ).rejects.toBeInstanceOf(WalletError);
    expect((await k.receiveAddress()).address).toBe(imported.address);
  });

  it('a failed unlock of an already-open wallet leaves it locked', async () => {
    // Attacker gain: password guesses against an unlocked session must not
    // keep the seed in RAM after the failed attempt.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    expect((await k.status()).unlocked).toBe(true);
    await expect(k.unlock('wrong-pass')).rejects.toThrow('Incorrect password.');
    expect((await k.status()).unlocked).toBe(false);
    await expect(k.receiveAddress()).rejects.toThrow(/locked/i);
  });

  it('receive addresses are testnet P2MR, never mainnet or legacy tdbt', async () => {
    // Attacker gain: a qbtc/tdbt receive string would send testnet funds to
    // an unspendable or wrong-network destination.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a = await k.receiveAddress();
    expect(a.network).toBe('testnet');
    expect(a.address.startsWith('tbtq1z')).toBe(true);
    expect(a.address.startsWith('qbtc')).toBe(false);
    expect(a.address.startsWith('tdbt')).toBe(false);
  });
});
