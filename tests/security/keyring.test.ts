import { describe, it, expect } from 'vitest';
import { Keyring } from '../../src/core/wallet/keyring.js';
import { WalletError } from '../../src/core/wallet/errors.js';
import { mnemonicToEntropy, mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';
import { addressFromHdSeed } from '../../src/core/wallet/derive.js';
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
  it('seals the vault at create, before the words ever reach the screen', async () => {
    // The inverse of what this file used to assert, and deliberately so. Holding
    // the phrase in memory until the challenge came back meant the service
    // worker had to survive a person copying twelve words onto paper, and Chrome
    // ends an idle MV3 worker in about thirty seconds — so the careful user was
    // the one whose wallet never got sealed. The vault exists first now, and the
    // challenge is a gate in front of it.
    const store = new MemoryWalletStorage();
    const k = ring(store);
    const reveal = await k.create(PASSWORD);
    expect(reveal.mnemonic.split(' ')).toHaveLength(12);
    expect(await store.loadVault()).not.toBeNull();
    const status = await k.status();
    expect(status.hasVault).toBe(true);
    expect(status.unlocked).toBe(true);
    expect(status.awaitingConfirm).toBe(true);
    expect(status.confirmChallenge).toEqual(reveal.challenge);
    // The vault is what was shown, not something adjacent to it.
    expect((await k.receiveAddress()).address).toBe(
      addressFromHdSeed(mnemonicToHdSeed(reveal.mnemonic), 'external', 0, 'testnet').address,
    );
  });

  it('status never carries the mnemonic', async () => {
    const k = ring();
    const reveal = await k.create(PASSWORD);
    const status = await k.status();
    expect(JSON.stringify(status).includes(reveal.mnemonic)).toBe(false);
    expect('mnemonic' in status).toBe(false);
  });

  it('a wrong confirmation changes nothing — the vault stands and the gate stays up', async () => {
    const store = new MemoryWalletStorage();
    const k = ring(store);
    const reveal = await k.create(PASSWORD);
    const sealed = await store.loadVault();
    await expect(
      k.confirm(reveal.challenge.map((index) => ({ index, word: 'abandon' })), PASSWORD),
    ).rejects.toBeInstanceOf(WalletError);
    // Not "the store is empty" any more: the wallet is the user's either way,
    // and a failed challenge must neither re-seal it nor drop the reminder.
    expect(await store.loadVault()).toEqual(sealed);
    expect((await k.status()).confirmChallenge).toEqual(reveal.challenge);
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

  it('vault blob does not contain the mnemonic, the HD seed, or the entropy in the clear', async () => {
    // The entropy is the newest thing in the vault and the shortest, so it is
    // the one most likely to end up somewhere it should not. It is also the
    // preimage of the phrase: leaking it leaks the words themselves.
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const blob = await store.loadVault();
    expect(blob).not.toBeNull();
    const latin = new TextDecoder('latin1').decode(blob!);
    expect(latin.includes(MNEMONIC)).toBe(false);
    expect(latin.includes(bytesToHex(mnemonicToHdSeed(MNEMONIC)))).toBe(false);
    const entropyHex = bytesToHex(mnemonicToEntropy(MNEMONIC));
    expect(entropyHex).toHaveLength(32); // the scan below is not vacuous
    expect(latin.includes(entropyHex)).toBe(false);
    expect(latin.includes('entropyHex')).toBe(false);
    // The metadata is not encrypted at all, so it must never have seen either.
    const meta = JSON.stringify(await store.loadMeta());
    expect(meta.includes(entropyHex)).toBe(false);
    expect(meta.includes('abandon')).toBe(false);
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
    expect((await k.status()).awaitingConfirm).toBe(true);
    expect((await k.status()).confirmChallenge).toEqual(reveal.challenge);
    // And the gate is passable by someone who really did write it down.
    await k.confirm(reveal.challenge.map((index) => ({ index, word: words[index]! })), PASSWORD);
    expect((await k.status()).awaitingConfirm).toBe(false);
  });

  it('an abandoned create still auto-locks', async () => {
    // Attacker gain: the HD seed would stay decrypted in the service worker
    // forever, so a later memory dump or SW compromise recovers spendable keys.
    // An outstanding challenge used to suppress the auto-lock so the reveal
    // could survive; nothing is held across it now, so nothing suppresses it.
    const clock = { t: 1_000 };
    const k = ring(new MemoryWalletStorage(), clock);
    await k.create(PASSWORD);
    expect((await k.status()).unlocked).toBe(true);
    clock.t += 61_000;
    expect((await k.status()).unlocked).toBe(false);
    expect((await k.status()).awaitingConfirm, 'the gate outlives the seed').toBe(true);
    await expect(k.receiveAddress()).rejects.toThrow(/locked/i);
  });

  it('a second wallet cannot be created or confirmed over the first', async () => {
    // Attacker gain: swapping a wallet's seed for another would make later
    // spends burn the first wallet's coins. `create` is now the only caller of
    // `seal`, and it refuses a device that already holds a vault — so the swap
    // has to be refused at both doors, before and after the challenge.
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const imported = await k.receiveAddress();
    await expect(k.create(PASSWORD)).rejects.toThrow(/already exists/);
    await expect(
      k.confirm([{ index: 0, word: 'abandon' }], PASSWORD),
    ).rejects.toMatchObject({ code: 'NO_PENDING' });
    expect((await k.receiveAddress()).address).toBe(imported.address);
    expect((await k.status()).awaitingConfirm).toBe(false);
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

  it('an import raises no challenge — the user already has the phrase', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    expect((await k.status()).awaitingConfirm).toBe(false);
    expect((await k.status()).confirmChallenge).toBeNull();
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

/**
 * The regression suite for the bug this design exists to remove.
 *
 * None of it sleeps. A Chrome service worker dies of *idleness*, and waiting
 * thirty seconds for that in a unit test would be slow, flaky and still not
 * proof — so the restart is modelled exactly instead: build a Keyring, do the
 * first half, **throw the instance away and build a new one over the same
 * storage**, and finish. That is what a woken worker is. Everything that used to
 * be held in a field between the two halves fails here in milliseconds.
 */
describe('onboarding survives the service worker being torn down', () => {
  /** The worker restart itself: same disk, new object, nothing carried over. */
  function restart(store: MemoryWalletStorage): Keyring {
    return ring(store);
  }

  it('confirm succeeds on a Keyring that never saw the create', async () => {
    // This is the reported failure, in one test: the popup keeps the twelve
    // words in React state and goes on rendering them, while the worker that
    // generated them is gone. Sealing at create is what makes the second half
    // answerable by an object that was not there for the first.
    const store = new MemoryWalletStorage();
    const reveal = await ring(store).create(PASSWORD);
    const words = reveal.mnemonic.split(' ');

    const woken = restart(store);
    expect((await woken.status()).unlocked, 'a woken worker holds no seed').toBe(false);
    expect((await woken.status()).awaitingConfirm).toBe(true);
    expect((await woken.status()).confirmChallenge).toEqual(reveal.challenge);

    await woken.confirm(reveal.challenge.map((index) => ({ index, word: words[index]! })), PASSWORD);

    expect((await woken.status()).awaitingConfirm).toBe(false);
    // A correct password on the way through opens the wallet, so the user lands
    // on their coins rather than on an unlock screen they just answered.
    expect((await woken.status()).unlocked).toBe(true);
    expect((await woken.receiveAddress()).address).toBe(
      addressFromHdSeed(mnemonicToHdSeed(reveal.mnemonic), 'external', 0, 'testnet').address,
    );
  });

  it('a wrong word on a woken worker leaves the gate up and the wallet shut', async () => {
    const store = new MemoryWalletStorage();
    const reveal = await ring(store).create(PASSWORD);
    const woken = restart(store);
    await expect(
      woken.confirm(reveal.challenge.map((index) => ({ index, word: 'abandon' })), PASSWORD),
    ).rejects.toMatchObject({ code: 'CONFIRM_MISMATCH' });
    expect((await woken.status()).awaitingConfirm).toBe(true);
    expect((await woken.status()).unlocked, 'a failed challenge is not an unlock').toBe(false);
  });

  it('a wrong password on a woken worker is a wrong password, not a wrong word', async () => {
    // The two failures send a user to opposite corners of the room, and the
    // wrong one costs them their confidence in the words they wrote down.
    const store = new MemoryWalletStorage();
    const reveal = await ring(store).create(PASSWORD);
    const words = reveal.mnemonic.split(' ');
    const woken = restart(store);
    await expect(
      woken.confirm(reveal.challenge.map((index) => ({ index, word: words[index]! })), 'not-the-pass'),
    ).rejects.toMatchObject({ code: 'WRONG_PASSWORD' });
    expect((await woken.status()).awaitingConfirm).toBe(true);
  });

  it('the phrase is still readable after the challenge is abandoned', async () => {
    // The reason this design is available at all. A user who walks away from the
    // challenge owns a wallet, and Settings → Security gives them their words
    // back behind the password — before that existed, sealing first would have
    // been a trap rather than a fix.
    const store = new MemoryWalletStorage();
    const reveal = await ring(store).create(PASSWORD);

    const woken = restart(store);
    await woken.unlock(PASSWORD);
    expect((await woken.status()).canRevealPhrase).toBe(true);
    expect((await woken.revealPhrase(PASSWORD)).words.join(' ')).toBe(reveal.mnemonic);
  });

  it('leaving the challenge clears it without claiming it was passed', async () => {
    const store = new MemoryWalletStorage();
    await ring(store).create(PASSWORD);
    const woken = restart(store);

    // Locked, it cannot be cleared: the reminder is not something a borrowed
    // laptop gets to dismiss on the owner's behalf.
    await expect(woken.dismissConfirm()).rejects.toMatchObject({ code: 'LOCKED' });
    expect((await woken.status()).awaitingConfirm).toBe(true);

    await woken.unlock(PASSWORD);
    await woken.dismissConfirm();
    expect((await woken.status()).awaitingConfirm).toBe(false);
    expect((await woken.status()).confirmChallenge).toBeNull();
    // And it stays gone across the next restart, so the user is asked once.
    expect((await restart(store).status()).awaitingConfirm).toBe(false);
  });

  it('a challenge naming a word the phrase does not have can never be satisfied silently', async () => {
    // Storage is attacker-adjacent. A hand-written challenge cannot widen
    // anything — the worst it does is ask for a position that is not there, and
    // that must refuse rather than pass on `undefined === undefined`.
    const store = new MemoryWalletStorage();
    await ring(store).create(PASSWORD);
    const meta = (await store.loadMeta())!;
    meta.confirmChallenge = [13];
    await store.saveMeta(meta);
    const woken = restart(store);
    await expect(woken.confirm([{ index: 13, word: 'abandon' }], PASSWORD)).rejects.toMatchObject({
      code: 'CONFIRM_MISMATCH',
    });
  });
});
