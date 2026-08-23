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
import { Keyring, UNLOCK_ATTEMPTS_BEFORE_BACKOFF, noPhraseMessage } from '../../src/core/wallet/keyring.js';
import { WalletError } from '../../src/core/wallet/errors.js';
import { addressFromHdSeed } from '../../src/core/wallet/derive.js';
import { emptyMeta } from '../../src/core/wallet/storage.js';
import { generateMnemonic, mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';
import { encodePayload } from '../../src/core/vault/payload.js';
import { encryptVault } from '../../src/core/vault/encrypt.js';
import { bytesToHex } from '../../src/core/util/hex.js';
import { MemoryWalletStorage, TEST_ENCRYPT } from '../helpers/memory-store.js';

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

/** A vault exactly as a pre-reveal build wrote it: v1, no entropy anywhere. */
async function sealV1(store: MemoryWalletStorage, mnemonic: string): Promise<void> {
  const plain = encodePayload({
    v: 1,
    network: 'testnet',
    origin: 'bip39',
    hdSeedHex: bytesToHex(mnemonicToHdSeed(mnemonic)),
  });
  await store.saveVault(await encryptVault(plain, PASSWORD, TEST_ENCRYPT));
  await store.saveMeta(emptyMeta('testnet', 'bip39'));
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

  it('a v1 vault refuses with NO_PHRASE — there is no in-place upgrade', async () => {
    // PBKDF2 is one-way and generateMnemonic discarded the entropy, so no
    // re-seal and no lazy fill-in at unlock can recover it. The only honest
    // path is a user-initiated wipe and re-import; asking the user to paste
    // their phrase "so we can upgrade the vault" is the phishing script.
    const store = new MemoryWalletStorage();
    await sealV1(store, MNEMONIC);
    const k = ring(store);
    await k.unlock(PASSWORD);
    try {
      await k.revealPhrase(PASSWORD);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WalletError).code).toBe('NO_PHRASE');
      expect((e as WalletError).message).toContain('sealed before');
      expect((e as WalletError).message).not.toContain('abandon');
    }
  });

  it('a v1 vault still unlocks and derives the right address', async () => {
    // The migration is "the reveal refuses", not "old vaults are corrupt".
    const store = new MemoryWalletStorage();
    await sealV1(store, MNEMONIC);
    const k = ring(store);
    await k.unlock(PASSWORD);
    const expected = addressFromHdSeed(mnemonicToHdSeed(MNEMONIC), 'external', 0, 'testnet');
    expect((await k.receiveAddress()).address).toBe(expected.address);
    expect((await k.status()).unlocked).toBe(true);
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

  it('is false for a raw-seed wallet and for a v1 vault', async () => {
    const raw = ring();
    await raw.importSeed(RAW_SEED_HEX, PASSWORD);
    expect((await raw.status()).canRevealPhrase).toBe(false);

    const store = new MemoryWalletStorage();
    await sealV1(store, MNEMONIC);
    const old = ring(store);
    await old.unlock(PASSWORD);
    expect((await old.status()).canRevealPhrase).toBe(false);
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
    // disabled-button explanation is a second copy of these two sentences.
    // Without this, the two drift and a raw-seed wallet is told one thing on
    // screen and another by the error it would get.
    const settings = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../src/ui/screens/Settings.tsx'),
      'utf8',
    );
    expect(settings).toContain(noPhraseMessage('raw32'));
    expect(settings).toContain(noPhraseMessage('bip39'));
    expect(noPhraseMessage('raw32')).not.toBe(noPhraseMessage('bip39'));
  });
});
