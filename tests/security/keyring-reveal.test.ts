/**
 * Showing the recovery phrase again — the paths that must refuse, and the one
 * property that makes showing it at all defensible: the words it hands back are
 * the words that restore *this* wallet.
 *
 * A reveal that skips the password, that does not share the unlock back-off,
 * that manufactures a phrase for a raw-seed wallet, or that returns words which
 * derive a different seed, is worse than no reveal at all — the last one is a
 * backup the user trusts and cannot use.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keyring, UNLOCK_ATTEMPTS_BEFORE_BACKOFF, NO_PHRASE_MESSAGE } from '../../src/core/wallet/keyring.js';
import { WalletError } from '../../src/core/wallet/errors.js';
import { addressFromHdSeed } from '../../src/core/wallet/derive.js';
import { generateMnemonic, mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';
import { bytesToHex } from '../../src/core/util/hex.js';
import { OLD_VAULT_MESSAGE } from '../../src/core/vault/payload.js';
import { MemoryWalletStorage, TEST_ENCRYPT } from '../helpers/memory-store.js';
import { sealV1 as buildV1Vault } from '../helpers/v1-vault.js';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'testnet-ok';
const RAW_SEED_HEX = 'a1'.repeat(32);

function ring(store = new MemoryWalletStorage(), clock?: { t: number }) {
  return new Keyring(store, {
    encrypt: TEST_ENCRYPT,
    network: 'testnet',
    now: clock ? () => clock.t : undefined,
  });
}

/** The pre-2 vault, built in `tests/helpers/v1-vault.ts` and nowhere else. */
async function sealV1(store: MemoryWalletStorage, mnemonic: string): Promise<void> {
  await buildV1Vault(store, mnemonic, PASSWORD);
}

describe('revealPhrase returns the phrase that restores this wallet', () => {
  it('reveals a 12-word phrase intact', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const { words } = await k.revealPhrase(PASSWORD);
    expect(words).toHaveLength(12);
    expect(words.join(' ')).toBe(MNEMONIC);
  });

  it('reveals a 24-word phrase intact', async () => {
    const long = generateMnemonic(256);
    expect(long.split(' ')).toHaveLength(24);
    const k = ring();
    await k.importMnemonic(long, PASSWORD);
    const { words } = await k.revealPhrase(PASSWORD);
    expect(words).toHaveLength(24);
    expect(words.join(' ')).toBe(long);
  });

  it('the revealed phrase re-derives the same wallet', async () => {
    // The property that makes a reveal worth having. A phrase that restores a
    // *different* wallet is a backup the user trusts and loses their coins to.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const onScreen = await k.receiveAddress();
    const { words } = await k.revealPhrase(PASSWORD);
    const restored = addressFromHdSeed(mnemonicToHdSeed(words.join(' ')), 'external', 0, 'testnet');
    expect(restored.address).toBe(onScreen.address);
  });

  it('a created wallet reads back exactly the phrase create returned', async () => {
    const k = ring();
    const reveal = await k.create(PASSWORD);
    const created = reveal.mnemonic.split(' ');
    await k.confirm(reveal.challenge.map((index) => ({ index, word: created[index]! })), PASSWORD);
    expect((await k.revealPhrase(PASSWORD)).words).toEqual(created);
  });

  it('two consecutive reveals return the same words, and it is not one-shot', async () => {
    // Stated plainly rather than pretended otherwise: anyone who can call this
    // has the password, so rate-limiting a *successful* reveal buys nothing.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const first = await k.revealPhrase(PASSWORD);
    const second = await k.revealPhrase(PASSWORD);
    expect(second.words).toEqual(first.words);
  });

  it('returns exactly one key, `words`', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    expect(Object.keys(await k.revealPhrase(PASSWORD))).toEqual(['words']);
  });
});

describe('revealPhrase refuses without the password', () => {
  it('a locked wallet refuses even with the right password', async () => {
    // Attacker gain: a reveal that works while locked turns "I stepped away
    // from an open browser" into "the phrase was on screen".
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    k.lock();
    await expect(k.revealPhrase(PASSWORD)).rejects.toThrow(/locked/i);
  });

  it('revealing never unlocks a locked wallet as a side effect', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    k.lock();
    await expect(k.revealPhrase(PASSWORD)).rejects.toThrow(/locked/i);
    expect((await k.status()).unlocked).toBe(false);
    await expect(k.receiveAddress()).rejects.toThrow(/locked/i);
  });

  it('a wrong password refuses, and the right one still works after', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    await expect(k.revealPhrase('not-the-password')).rejects.toThrow('Incorrect password.');
    expect((await k.revealPhrase(PASSWORD)).words.join(' ')).toBe(MNEMONIC);
  });

  it('a wrong password never names the failure as anything but the password', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    try {
      await k.revealPhrase('not-the-password');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WalletError).code).toBe('WRONG_PASSWORD');
      expect((e as WalletError).message).not.toContain('abandon');
    }
  });
});

describe('revealPhrase shares the unlock throttle in both directions', () => {
  it('wrong reveals throttle a later correct reveal', async () => {
    // Attacker gain: without the shared counter, the reveal is a second
    // unlimited password oracle against the same vault.
    const clock = { t: 1_000 };
    const k = ring(new MemoryWalletStorage(), clock);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    for (let i = 0; i < UNLOCK_ATTEMPTS_BEFORE_BACKOFF; i++) {
      await expect(k.revealPhrase('wrong-password')).rejects.toThrow('Incorrect password.');
    }
    const blocked = k.revealPhrase(PASSWORD);
    await expect(blocked).rejects.toThrow(/Too many wrong passwords/);
    try {
      await blocked;
    } catch (e) {
      expect((e as WalletError).code).toBe('TOO_MANY_ATTEMPTS');
    }
  });

  it('wrong reveals throttle the send path too', async () => {
    const clock = { t: 1_000 };
    const k = ring(new MemoryWalletStorage(), clock);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    for (let i = 0; i < UNLOCK_ATTEMPTS_BEFORE_BACKOFF; i++) {
      await expect(k.revealPhrase('wrong-password')).rejects.toThrow('Incorrect password.');
    }
    await expect(k.reauth(PASSWORD)).rejects.toThrow(/Too many wrong passwords/);
  });

  it('wrong unlocks throttle a later reveal', async () => {
    const clock = { t: 1_000 };
    const store = new MemoryWalletStorage();
    const k = ring(store, clock);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    k.lock();
    for (let i = 0; i < UNLOCK_ATTEMPTS_BEFORE_BACKOFF; i++) {
      await expect(k.unlock('wrong-password')).rejects.toThrow('Incorrect password.');
    }
    clock.t += 600_000; // wait out the back-off, then open the wallet
    await k.unlock(PASSWORD);
    // The successful unlock reset the counter, so the reveal is allowed again.
    expect((await k.revealPhrase(PASSWORD)).words.join(' ')).toBe(MNEMONIC);
  });

  it('a successful reveal resets the counter', async () => {
    const clock = { t: 1_000 };
    const k = ring(new MemoryWalletStorage(), clock);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    for (let i = 0; i < UNLOCK_ATTEMPTS_BEFORE_BACKOFF - 1; i++) {
      await expect(k.revealPhrase('wrong-password')).rejects.toThrow('Incorrect password.');
    }
    await k.revealPhrase(PASSWORD);
    for (let i = 0; i < UNLOCK_ATTEMPTS_BEFORE_BACKOFF - 1; i++) {
      await expect(k.revealPhrase('wrong-password')).rejects.toThrow('Incorrect password.');
    }
    await k.reauth(PASSWORD); // still allowed: the counter restarted
  });
});

describe('wallets that have no phrase say so, and never invent one', () => {
  it('a raw-seed wallet refuses with NO_PHRASE and shows no words', async () => {
    // Attacker/user loss: running entropyToMnemonic over a raw 32-byte HD seed
    // yields a valid-looking 24-word phrase whose BIP39 seed is a *different*
    // wallet — an actively dangerous fake backup.
    const k = ring();
    await k.importSeed(RAW_SEED_HEX, PASSWORD);
    try {
      await k.revealPhrase(PASSWORD);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WalletError).code).toBe('NO_PHRASE');
      expect((e as WalletError).message).toContain('raw 32-byte seed');
      // No phrase-shaped material anywhere in the refusal.
      expect((e as WalletError).message.split(/\s+/).length).toBeLessThan(40);
    }
  });

  it('the raw-seed refusal is reached only after a correct password', async () => {
    // Pleasant consequence of re-auth first: NO_PHRASE is not a probe a
    // passer-by at an open popup can run.
    const k = ring();
    await k.importSeed(RAW_SEED_HEX, PASSWORD);
    await expect(k.revealPhrase('not-the-password')).rejects.toMatchObject({ code: 'WRONG_PASSWORD' });
  });

  it('the raw-seed refusal is the only one — nothing else can reach NO_PHRASE', async () => {
    // The decoder holds `origin === 'bip39'` and "carries entropy" together, so
    // a wallet that says it came from a phrase can always produce one. That is
    // why this refusal has a single sentence and not a table of them.
    expect(NO_PHRASE_MESSAGE).toContain('raw 32-byte seed');
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    expect((await k.revealPhrase(PASSWORD)).words.join(' ')).toBe(MNEMONIC);
  });
});

describe('a vault from the older build is refused, not opened', () => {
  it('unlock fails with VAULT_TOO_OLD and the actionable message', async () => {
    // The bytes the pre-2 build wrote, sealed with the same envelope and the
    // same KDF. The password is right — decryption succeeds — and what fails is
    // the payload version, so the error must not read as a wrong password or as
    // a corrupt vault. Both would send the user looking for the wrong problem.
    const store = new MemoryWalletStorage();
    await sealV1(store, MNEMONIC);
    const k = ring(store);
    try {
      await k.unlock(PASSWORD);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WalletError).code).toBe('VAULT_TOO_OLD');
      expect((e as WalletError).message).toBe(OLD_VAULT_MESSAGE);
      expect((e as WalletError).message).not.toBe('Not a BTQ vault.');
      expect((e as WalletError).message).not.toContain('assword');
      expect((e as WalletError).message).not.toContain('abandon');
    }
  });

  it('no wallet is opened by the attempt, and no key material is kept', async () => {
    const store = new MemoryWalletStorage();
    await sealV1(store, MNEMONIC);
    const k = ring(store);
    await expect(k.unlock(PASSWORD)).rejects.toMatchObject({ code: 'VAULT_TOO_OLD' });
    const status = await k.status();
    expect(status.unlocked).toBe(false);
    expect(status.hasVault).toBe(true);
    expect(status.backup).toBeNull();
    await expect(k.receiveAddress()).rejects.toThrow(/locked/i);
    await expect(k.revealPhrase(PASSWORD)).rejects.toThrow(/locked/i);
    await expect(k.revealSeedHex(PASSWORD)).rejects.toThrow(/locked/i);
    expect(JSON.stringify(k)).not.toContain(bytesToHex(mnemonicToHdSeed(MNEMONIC)));
  });

  it('the refusal deletes nothing — removing the wallet stays the user\'s decision', async () => {
    // A build that quietly wiped what it could not read would destroy a wallet
    // whose owner had not yet found their phrase. The blob is still there after
    // the refusal, byte for byte.
    const store = new MemoryWalletStorage();
    await sealV1(store, MNEMONIC);
    const before = new Uint8Array((await store.loadVault())!);
    const k = ring(store);
    await expect(k.unlock(PASSWORD)).rejects.toMatchObject({ code: 'VAULT_TOO_OLD' });
    expect(await store.loadVault()).toEqual(before);
    // And the way out is the one the message names, on a device the user cleared.
    await k.wipe('DELETE');
    expect(await store.loadVault()).toBeNull();
    const fresh = ring(store);
    await fresh.importMnemonic(MNEMONIC, PASSWORD);
    const expected = addressFromHdSeed(mnemonicToHdSeed(MNEMONIC), 'external', 0, 'testnet');
    expect((await fresh.receiveAddress()).address).toBe(expected.address);
    expect((await fresh.revealPhrase(PASSWORD)).words.join(' ')).toBe(MNEMONIC);
  });

  it('a wrong password on an old vault is still just a wrong password', async () => {
    // The version is inside the ciphertext, so it cannot be reported before the
    // password is proved: VAULT_TOO_OLD must never become an unlock oracle.
    const store = new MemoryWalletStorage();
    await sealV1(store, MNEMONIC);
    const k = ring(store);
    await expect(k.unlock('not-the-password')).rejects.toMatchObject({ code: 'WRONG_PASSWORD' });
  });
});

describe('canRevealPhrase is a UI affordance that never over-promises', () => {
  it('is false on a fresh keyring with no vault', async () => {
    expect((await ring().status()).canRevealPhrase).toBe(false);
  });

  it('is true right after import, create-confirm and unlock', async () => {
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    expect((await k.status()).canRevealPhrase).toBe(true);
    k.lock();
    await k.unlock(PASSWORD);
    expect((await k.status()).canRevealPhrase).toBe(true);

    const created = ring();
    const reveal = await created.create(PASSWORD);
    const words = reveal.mnemonic.split(' ');
    await created.confirm(reveal.challenge.map((index) => ({ index, word: words[index]! })), PASSWORD);
    expect((await created.status()).canRevealPhrase).toBe(true);
  });

  it('is false whenever locked, so a locked popup learns nothing', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    k.lock();
    const locked = await k.status();
    expect(locked.canRevealPhrase).toBe(false);
    expect(locked.hasVault).toBe(true);
  });

  it('is false after auto-lock, not merely after an explicit lock', async () => {
    const clock = { t: 1_000 };
    const k = new Keyring(new MemoryWalletStorage(), {
      encrypt: TEST_ENCRYPT,
      network: 'testnet',
      now: () => clock.t,
      lockAfterMs: 60_000,
    });
    await k.importMnemonic(MNEMONIC, PASSWORD);
    expect((await k.status()).canRevealPhrase).toBe(true);
    clock.t += 61_000;
    expect((await k.status()).canRevealPhrase).toBe(false);
  });

  it('is false for a raw-seed wallet, which is the only wallet without a phrase', async () => {
    const raw = ring();
    await raw.importSeed(RAW_SEED_HEX, PASSWORD);
    const status = await raw.status();
    expect(status.canRevealPhrase).toBe(false);
    expect(status.backup).toBe('hdSeed');
    expect(status.origin).toBe('raw32');
  });
});

describe('a reveal leaves nothing behind on disk', () => {
  it('the vault blob and metadata contain none of the revealed words', async () => {
    // Attacker gain: a reveal that wrote the words anywhere would turn "read
    // chrome.storage" into "read the phrase", which is the whole boundary.
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const { words } = await k.revealPhrase(PASSWORD);

    const blob = new TextDecoder('latin1').decode((await store.loadVault())!);
    expect(blob).not.toContain(words.join(' '));
    expect(blob).not.toContain('abandon abandon');
    const meta = JSON.stringify(await store.loadMeta());
    for (const word of new Set(words)) expect(meta, word).not.toContain(word);
    expect(JSON.stringify(await store.loadActivity())).toBe('[]');
  });

  it('the sealed blob never holds the entropy hex in the clear', async () => {
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const blob = new TextDecoder('latin1').decode((await store.loadVault())!);
    expect(blob).not.toContain('00'.repeat(16)); // the entropy behind MNEMONIC
    expect(blob).not.toContain('entropyHex');
  });
});

describe('the popup and the worker refuse in the same words', () => {
  it('Settings renders the worker\'s own no-phrase copy verbatim', () => {
    // The popup cannot import the keyring (source-boundary.test.ts), so the
    // explanation beside the seed control is a second copy of this sentence.
    // Without this, the two drift and a raw-seed wallet is told one thing on
    // screen and another by the error it would get.
    const settings = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../src/ui/screens/Settings.tsx'),
      'utf8',
    );
    expect(settings).toContain(NO_PHRASE_MESSAGE);
  });

  it('the popup never describes a wallet that cannot show its phrase', () => {
    // The third state, gone from the screen as well as from the decoder: there
    // is no vault this build opens that has to be told its words are lost.
    const settings = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../src/ui/screens/Settings.tsx'),
      'utf8',
    );
    expect(settings).not.toContain('sealed before');
    expect(settings).not.toMatch(/cannot produce it/);
  });
});
