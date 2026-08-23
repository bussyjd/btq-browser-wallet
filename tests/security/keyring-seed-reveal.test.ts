/**
 * Showing the HD seed — the backup for every wallet that has no phrase to show.
 *
 * Two wallets can never produce a recovery phrase: one imported from a raw
 * 32-byte seed, which never had one, and a v1 vault sealed before the reveal
 * existed, whose BIP39 entropy is gone because `mnemonicToHdSeed` is one-way.
 * Refusing both and offering nothing else leaves the user with a wallet they
 * cannot back up — so they are offered the HD seed itself, the hex every key
 * here is derived from. How far that gets them back differs by wallet and the
 * popup says which: see the round-trip tests at the bottom of this file.
 *
 * It is the same secret behind the same door as the phrase, so this file holds
 * the same properties down: locked refuses, the password is re-proved against
 * the sealed vault, a wrong one costs the shared back-off, a page cannot ask at
 * all, and the hex that comes back re-derives *this* wallet rather than some
 * other one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keyring, UNLOCK_ATTEMPTS_BEFORE_BACKOFF } from '../../src/core/wallet/keyring.js';
import { dispatch } from '../../src/core/rpc/dispatch.js';
import { WalletError } from '../../src/core/wallet/errors.js';
import { addressFromHdSeed } from '../../src/core/wallet/derive.js';
import { emptyMeta } from '../../src/core/wallet/storage.js';
import { mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';
import { bytesToHex, hexToBytes } from '../../src/core/util/hex.js';
import { MemoryWalletStorage, TEST_ENCRYPT } from '../helpers/memory-store.js';
import { sealV1 } from '../helpers/v1-vault.js';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'testnet-ok';
const RAW_SEED_HEX = 'a1'.repeat(32);
const V1_SEED_HEX = bytesToHex(mnemonicToHdSeed(MNEMONIC));

function ring(store = new MemoryWalletStorage(), clock?: { t: number }) {
  return new Keyring(store, {
    encrypt: TEST_ENCRYPT,
    network: 'testnet',
    now: clock ? () => clock.t : undefined,
  });
}

/** An open v1 wallet — the one the user in the bug report actually has. */
async function openV1(store = new MemoryWalletStorage()) {
  await sealV1(store, MNEMONIC, PASSWORD);
  const k = ring(store);
  await k.unlock(PASSWORD);
  return k;
}

/** An open raw-32 wallet — no phrase because there never was one. */
async function openRaw32(store = new MemoryWalletStorage()) {
  const k = ring(store);
  await k.importSeed(RAW_SEED_HEX, PASSWORD);
  return k;
}

describe('revealSeedHex hands back the seed that restores this wallet', () => {
  it('a raw-seed wallet gets back exactly the hex it was imported from', async () => {
    const k = await openRaw32();
    expect((await k.revealSeedHex(PASSWORD)).seedHex).toBe(RAW_SEED_HEX);
  });

  it('a v1 wallet gets back the seed its lost phrase derives', async () => {
    // The property that makes this a backup at all: the hex on screen is the
    // hex the user's own written-down phrase would produce.
    const k = await openV1();
    expect((await k.revealSeedHex(PASSWORD)).seedHex).toBe(V1_SEED_HEX);
  });

  it('the revealed hex is the seed this wallet actually derives from', async () => {
    // Hex that belongs to a *different* wallet is worse than no backup: it is a
    // backup the user trusts and loses their coins to. Checked against the
    // address on screen, through the same derivation the wallet uses.
    for (const [open, expected] of [
      [openV1, V1_SEED_HEX],
      [openRaw32, RAW_SEED_HEX],
    ] as const) {
      const k = await open();
      const onScreen = await k.receiveAddress();
      const { seedHex } = await k.revealSeedHex(PASSWORD);
      expect(seedHex).toBe(expected);
      const derived = addressFromHdSeed(hexToBytes(seedHex), 'external', 0, 'testnet');
      expect(derived.address).toBe(onScreen.address);
    }
  });

  it('is lowercase hex of the length the vault actually holds', async () => {
    // Not one fixed length: a raw-32 import seals 32 bytes and a wallet built
    // from a phrase seals the 64-byte BIP39 seed. A test that pinned 64
    // characters would have been asserting a wish.
    const raw = await (await openRaw32()).revealSeedHex(PASSWORD);
    expect(raw.seedHex).toMatch(/^[0-9a-f]{64}$/);
    const v1 = await (await openV1()).revealSeedHex(PASSWORD);
    expect(v1.seedHex).toMatch(/^[0-9a-f]{128}$/);
  });

  it('a raw-32 wallet\'s seed goes back in through Import → raw seed', async () => {
    // The round trip the Settings copy promises that wallet, asserted end to
    // end: reveal, re-import into a fresh vault, same first address.
    const k = await openRaw32();
    const onScreen = await k.receiveAddress();
    const { seedHex } = await k.revealSeedHex(PASSWORD);
    const restored = ring();
    await restored.importSeed(seedHex, PASSWORD);
    expect((await restored.receiveAddress()).address).toBe(onScreen.address);
  });

  it('a phrase-derived seed is refused by that import, which is why the copy sends the user to the phrase', async () => {
    // `parseRawSeedHex` deliberately refuses 64-byte hex so a BIP39 seed is not
    // imported as a raw one (tests/unit/mnemonic.test.ts pins that decision).
    // The consequence is load-bearing for what Settings may honestly say to a
    // v1 wallet: the seed it shows is that wallet's master secret, but on this
    // build the phrase on paper is what restores it. If this refusal is ever
    // lifted, this test fails and that copy has to be revisited — which is the
    // whole reason it is written down here.
    const k = await openV1();
    const { seedHex } = await k.revealSeedHex(PASSWORD);
    await expect(ring().importSeed(seedHex, PASSWORD)).rejects.toMatchObject({
      code: 'BAD_SEED_HEX',
    });
    await expect(ring().importSeed(seedHex, PASSWORD)).rejects.toThrow(/Import seed phrase/);
  });

  it('returns exactly one key, `seedHex`', async () => {
    const k = await openRaw32();
    expect(Object.keys(await k.revealSeedHex(PASSWORD))).toEqual(['seedHex']);
  });

  it('a phrase wallet can show its seed too, and it is the same seed', async () => {
    // Settings never offers both controls, but the method must not pretend the
    // seed does not exist for a v2 vault: it is the same secret, one derivation
    // away from the words that method already hands out.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    expect((await k.revealSeedHex(PASSWORD)).seedHex).toBe(V1_SEED_HEX);
  });

  it('two consecutive reveals return the same hex, and the wallet still works', async () => {
    const k = await openV1();
    const first = await k.revealSeedHex(PASSWORD);
    const second = await k.revealSeedHex(PASSWORD);
    expect(second.seedHex).toBe(first.seedHex);
    // The wipes in the `finally` touched the copies, not the vault: re-auth
    // still passes and the wallet still derives from the same seed.
    await k.reauth(PASSWORD);
    expect((await k.receiveAddress()).address).toBe(
      addressFromHdSeed(mnemonicToHdSeed(MNEMONIC), 'external', 0, 'testnet').address,
    );
  });
});

describe('revealSeedHex refuses without the password', () => {
  it('a locked wallet refuses even with the right password', async () => {
    // Attacker gain: a seed reveal that works while locked turns "I stepped
    // away from an open browser" into "the master secret was on screen".
    for (const open of [openV1, openRaw32]) {
      const k = await open();
      k.lock();
      await expect(k.revealSeedHex(PASSWORD)).rejects.toThrow(/locked/i);
    }
  });

  it('revealing never unlocks a locked wallet as a side effect', async () => {
    const k = await openRaw32();
    k.lock();
    await expect(k.revealSeedHex(PASSWORD)).rejects.toThrow(/locked/i);
    expect((await k.status()).unlocked).toBe(false);
    await expect(k.receiveAddress()).rejects.toThrow(/locked/i);
  });

  it('a wrong password refuses, and the right one still works after', async () => {
    const k = await openV1();
    await expect(k.revealSeedHex('not-the-password')).rejects.toThrow('Incorrect password.');
    expect((await k.revealSeedHex(PASSWORD)).seedHex).toBe(V1_SEED_HEX);
  });

  it('a wrong password names the password and never any of the secret', async () => {
    const k = await openRaw32();
    try {
      await k.revealSeedHex('not-the-password');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WalletError).code).toBe('WRONG_PASSWORD');
      expect((e as WalletError).message).not.toContain(RAW_SEED_HEX);
      expect((e as WalletError).message).not.toContain('a1a1');
    }
  });
});

describe('revealSeedHex shares the unlock throttle in both directions', () => {
  it('wrong seed reveals throttle a later correct seed reveal', async () => {
    // Attacker gain: without the shared counter, this is a second unlimited
    // password oracle against the same vault.
    const clock = { t: 1_000 };
    const k = await openRaw32(new MemoryWalletStorage());
    const throttled = new Keyring(new MemoryWalletStorage(), {
      encrypt: TEST_ENCRYPT,
      network: 'testnet',
      now: () => clock.t,
    });
    await throttled.importSeed(RAW_SEED_HEX, PASSWORD);
    for (let i = 0; i < UNLOCK_ATTEMPTS_BEFORE_BACKOFF; i++) {
      await expect(throttled.revealSeedHex('wrong-password')).rejects.toThrow('Incorrect password.');
    }
    await expect(throttled.revealSeedHex(PASSWORD)).rejects.toMatchObject({
      code: 'TOO_MANY_ATTEMPTS',
    });
    // A different keyring is untouched — the back-off is per vault, in memory.
    expect((await k.revealSeedHex(PASSWORD)).seedHex).toBe(RAW_SEED_HEX);
  });

  it('wrong seed reveals throttle the send path and the phrase reveal too', async () => {
    const clock = { t: 1_000 };
    const k = ring(new MemoryWalletStorage(), clock);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    for (let i = 0; i < UNLOCK_ATTEMPTS_BEFORE_BACKOFF; i++) {
      await expect(k.revealSeedHex('wrong-password')).rejects.toThrow('Incorrect password.');
    }
    await expect(k.reauth(PASSWORD)).rejects.toThrow(/Too many wrong passwords/);
    await expect(k.revealPhrase(PASSWORD)).rejects.toThrow(/Too many wrong passwords/);
  });

  it('wrong phrase reveals throttle a later seed reveal', async () => {
    // The other direction: one counter, or it is two independent oracles.
    const clock = { t: 1_000 };
    const k = ring(new MemoryWalletStorage(), clock);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    for (let i = 0; i < UNLOCK_ATTEMPTS_BEFORE_BACKOFF; i++) {
      await expect(k.revealPhrase('wrong-password')).rejects.toThrow('Incorrect password.');
    }
    await expect(k.revealSeedHex(PASSWORD)).rejects.toThrow(/Too many wrong passwords/);
  });

  it('wrong unlocks throttle a later seed reveal, and a good unlock clears it', async () => {
    const clock = { t: 1_000 };
    const store = new MemoryWalletStorage();
    await sealV1(store, MNEMONIC, PASSWORD);
    const k = ring(store, clock);
    await k.unlock(PASSWORD);
    k.lock();
    for (let i = 0; i < UNLOCK_ATTEMPTS_BEFORE_BACKOFF; i++) {
      await expect(k.unlock('wrong-password')).rejects.toThrow('Incorrect password.');
    }
    clock.t += 600_000; // wait out the back-off, then open the wallet
    await k.unlock(PASSWORD);
    expect((await k.revealSeedHex(PASSWORD)).seedHex).toBe(V1_SEED_HEX);
  });

  it('a successful seed reveal resets the counter', async () => {
    const clock = { t: 1_000 };
    const k = ring(new MemoryWalletStorage(), clock);
    await k.importSeed(RAW_SEED_HEX, PASSWORD);
    for (let i = 0; i < UNLOCK_ATTEMPTS_BEFORE_BACKOFF - 1; i++) {
      await expect(k.revealSeedHex('wrong-password')).rejects.toThrow('Incorrect password.');
    }
    await k.revealSeedHex(PASSWORD);
    for (let i = 0; i < UNLOCK_ATTEMPTS_BEFORE_BACKOFF - 1; i++) {
      await expect(k.revealSeedHex('wrong-password')).rejects.toThrow('Incorrect password.');
    }
    await k.reauth(PASSWORD); // still allowed: the counter restarted
  });
});

describe('a page cannot ask for the seed', () => {
  it('wallet.revealSeedHex is refused to a tab, with or without the password', async () => {
    // Attacker gain: one call from a web page and the site owns every coin the
    // wallet will ever hold, on every device the seed is restored to.
    const k = await openRaw32();
    for (const params of [{}, { password: PASSWORD }]) {
      await expect(
        dispatch(k, { method: 'wallet.revealSeedHex', params }, { fromTab: true }),
      ).rejects.toThrow(/not available to pages/);
    }
    // …and the same call from the popup answers, so the refusal above is about
    // the sender rather than a method that is broken for everyone.
    const result = (await dispatch(
      k,
      { method: 'wallet.revealSeedHex', params: { password: PASSWORD } },
      { fromTab: false },
    )) as { seedHex: string };
    expect(Object.keys(result)).toEqual(['seedHex']);
    expect(result.seedHex).toBe(RAW_SEED_HEX);
  });

  it('a missing password is a parameter error, not a reveal', async () => {
    const k = await openRaw32();
    await expect(
      dispatch(k, { method: 'wallet.revealSeedHex', params: {} }, { fromTab: false }),
    ).rejects.toMatchObject({ code: 'BAD_PARAMS' });
  });
});

describe('a seed reveal leaves nothing behind on disk', () => {
  it('the vault blob, metadata and activity hold none of the hex', async () => {
    // Attacker gain: a reveal that wrote the seed anywhere would turn "read
    // chrome.storage" into "spend everything", which is the whole boundary.
    for (const seedHex of [RAW_SEED_HEX, V1_SEED_HEX]) {
      const store = new MemoryWalletStorage();
      const k =
        seedHex === RAW_SEED_HEX ? await openRaw32(store) : await openV1(store);
      const revealed = (await k.revealSeedHex(PASSWORD)).seedHex;
      expect(revealed).toBe(seedHex);

      const blob = new TextDecoder('latin1').decode((await store.loadVault())!);
      expect(blob).not.toContain(seedHex);
      // Not merely the whole 64 characters: any long run of it would do.
      expect(blob).not.toContain(seedHex.slice(0, 16));
      expect(blob).not.toContain('hdSeedHex');
      const rest = JSON.stringify({
        meta: await store.loadMeta(),
        activity: await store.loadActivity(),
        origins: await store.loadOrigins(),
      });
      expect(rest).not.toContain(seedHex);
      expect(rest).not.toContain(seedHex.slice(0, 16));
      expect(rest).not.toContain(PASSWORD);
    }
  });

  it('the reveal is not cached on the keyring between calls', async () => {
    // A keyring that kept the hex would hand it to anything that could reach
    // the object after the password had been forgotten. Locking and re-opening
    // has to go back through the vault, so a locked wallet has nothing to give.
    const store = new MemoryWalletStorage();
    const k = await openV1(store);
    await k.revealSeedHex(PASSWORD);
    k.lock();
    await expect(k.revealSeedHex(PASSWORD)).rejects.toThrow(/locked/i);
    expect(JSON.stringify(k)).not.toContain(V1_SEED_HEX);
  });
});

describe('status().backup names the one control Settings may render', () => {
  it('a phrase wallet says `phrase`, and canRevealPhrase agrees', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const status = await k.status();
    expect(status.backup).toBe('recoveryPhrase');
    expect(status.canRevealPhrase).toBe(true);
  });

  it('a v1 vault and a raw-seed wallet both say `seed`', async () => {
    for (const open of [openV1, openRaw32]) {
      const status = await (await open()).status();
      expect(status.backup).toBe('hdSeed');
      expect(status.canRevealPhrase).toBe(false);
    }
  });

  it('is null whenever locked, and null with no vault at all', async () => {
    expect((await ring().status()).backup).toBeNull();
    const k = await openV1();
    k.lock();
    const locked = await k.status();
    expect(locked.backup).toBeNull();
    expect(locked.hasVault).toBe(true);
  });

  it('is null after an auto-lock, not merely after an explicit one', async () => {
    const clock = { t: 1_000 };
    const k = new Keyring(new MemoryWalletStorage(), {
      encrypt: TEST_ENCRYPT,
      network: 'testnet',
      now: () => clock.t,
      lockAfterMs: 60_000,
    });
    await k.importSeed(RAW_SEED_HEX, PASSWORD);
    expect((await k.status()).backup).toBe('hdSeed');
    clock.t += 61_000;
    expect((await k.status()).backup).toBeNull();
  });

  it('canRevealPhrase can never disagree with backup, on any wallet', async () => {
    // The reason `backup` replaced a second boolean: two independently computed
    // flags are two flags that can drift, and the one that says "yes" is the one
    // that renders a control which can only fail.
    const phrase = ring();
    await phrase.importMnemonic(MNEMONIC, PASSWORD);
    const wallets = [phrase, await openV1(), await openRaw32()];
    for (const k of wallets) {
      for (const status of [await k.status(), (k.lock(), await k.status())]) {
        expect(status.canRevealPhrase).toBe(status.backup === 'recoveryPhrase');
      }
    }
  });

  it('every wallet type has a control, and the control it names actually works', async () => {
    // The whole point, stated once: an unlocked wallet is never left with
    // nothing to offer, and what it offers is never a button that can only
    // fail. Settings renders `backup` and nothing else, so this is the
    // assertion that keeps a dead control off the screen.
    const phrase = ring();
    await phrase.importMnemonic(MNEMONIC, PASSWORD);
    for (const k of [phrase, await openV1(), await openRaw32()]) {
      const { backup } = await k.status();
      expect(backup).not.toBeNull();
      if (backup === 'recoveryPhrase') {
        expect((await k.revealPhrase(PASSWORD)).words.join(' ')).toBe(MNEMONIC);
      } else {
        expect((await k.revealSeedHex(PASSWORD)).seedHex).toMatch(/^([0-9a-f]{2})+$/);
      }
    }
  });
});

describe('origin is the payload\'s, never the metadata copy', () => {
  it('a raw-seed wallet stays raw32 after its metadata is re-stamped bip39', async () => {
    // `walletMeta()` falls back to `emptyMeta(…, 'bip39')` when meta is missing,
    // and the next save writes that fallback down. If Settings read origin from
    // there, a raw-seed wallet would be told its phrase was merely "sealed
    // before the wallet could read one back" — and the user would go looking for
    // twelve words that never existed.
    const store = new MemoryWalletStorage();
    const k = await openRaw32(store);
    expect((await k.status()).origin).toBe('raw32');

    await store.saveMeta(emptyMeta('testnet', 'bip39'));
    expect((await store.loadMeta())?.origin).toBe('bip39');
    const status = await k.status();
    expect(status.origin).toBe('raw32');
    expect(status.backup).toBe('hdSeed');
  });

  it('a locked wallet falls back to metadata rather than inventing one', async () => {
    const store = new MemoryWalletStorage();
    const k = await openRaw32(store);
    k.lock();
    expect((await k.status()).origin).toBe('raw32'); // the meta seal() wrote
  });
});

describe('the popup renders one control, never a dead one', () => {
  const SETTINGS = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../src/ui/screens/Settings.tsx'),
    'utf8',
  );

  it('no control is disabled on anything but its own busyness or its own input', () => {
    // The bug this whole change exists to kill: a button rendered greyed out
    // because the wallet cannot do the thing. A wallet that cannot do a thing
    // must not put the control on screen at all — a disabled control tells the
    // user their wallet is broken and gives them nowhere to go.
    const disabled = [...SETTINGS.matchAll(/disabled=\{([^}]*)\}/g)].map((m) => m[1]!.trim());
    expect(disabled.length).toBeGreaterThan(0);
    for (const expr of disabled) {
      // Allowed: "this action is running" and "this form is not filled in yet".
      // Both are states the user can leave from this screen.
      expect(expr, `disabled={${expr}}`).toMatch(/\.busy|wallet\.scanning|confirmation !== 'DELETE'/);
      // Refused: anything that asks what the wallet is capable of.
      for (const capability of ['backup', 'canReveal', 'origin', 'status', 'hasVault']) {
        expect(expr.includes(capability), `disabled={${expr}} gates on ${capability}`).toBe(false);
      }
    }
  });

  it('each reveal control is rendered inside its own backup branch', () => {
    // Not "is not disabled" but "is not rendered": the phrase button exists
    // only under `backup === 'recoveryPhrase'`, the seed one only under `'hdSeed'`.
    const phraseAt = SETTINGS.indexOf("backup === 'recoveryPhrase'");
    const seedAt = SETTINGS.indexOf("backup === 'hdSeed'");
    expect(phraseAt).toBeGreaterThan(-1);
    expect(seedAt).toBeGreaterThan(phraseAt);
    expect(SETTINGS.indexOf("data-testid=\"reveal-phrase\"")).toBeGreaterThan(phraseAt);
    expect(SETTINGS.indexOf("data-testid=\"reveal-seed\"")).toBeGreaterThan(seedAt);
    // …and neither branch is the fall-through: an unknown `backup` renders null.
    expect(SETTINGS).toContain(') : null}');
  });

  it('the seed copy tells each wallet the truth about restoring it', () => {
    // A raw-32 wallet's seed really does go back in through the import screen;
    // a phrase-derived one does not, because that screen takes 32 bytes. One
    // sentence covering both would be half wrong for each.
    const seedBranch = SETTINGS.slice(SETTINGS.indexOf("backup === 'hdSeed'"));
    expect(seedBranch).toContain("wallet.status?.origin === 'raw32'");
    expect(seedBranch).toContain('restores this wallet exactly');
    expect(seedBranch).toContain('64 bytes');
    // And it never invites the phrase back in, which is the phishing script.
    expect(seedBranch.toLowerCase()).not.toContain('paste your');
    expect(seedBranch.toLowerCase()).not.toContain('enter your phrase');
    expect(seedBranch).toContain('trying to steal it');
  });

  it('neither reveal screen offers a clipboard button', () => {
    // The clipboard is readable by anything else on the machine, and a secret
    // that reaches it outlives the screen that showed it.
    const security = SETTINGS.slice(SETTINGS.indexOf("backup === 'recoveryPhrase'"));
    expect(security).not.toContain('copy');
    expect(security).not.toContain('clipboard');
  });
});
