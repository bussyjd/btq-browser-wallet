/**
 * The wallet backup file: what it carries, what it refuses, and what holding
 * one tells somebody who has no password.
 *
 * The phrase carries keys and cannot carry metadata, so the account list — how
 * many accounts, what they were called, which was in front — has no recovery
 * path in the words. This file is that path, and it is the same shape Sparrow
 * and Electrum have used for years: the phrase is the key material, a wallet
 * file is everything else.
 *
 * Three properties are held down here, in this order.
 *
 * 1. **It is a backup.** What comes out restores the accounts exactly, on a
 *    device that has never seen the wallet, with the names the user chose.
 * 2. **It is behind the same door as the reveals.** Unlocked or refuse; the
 *    password re-proved against the sealed vault; the shared unlock back-off in
 *    both directions; a page cannot ask; the plaintext buffers do not survive
 *    the call. A backup that could be taken without the password would be a
 *    whole wallet lifted from an unattended browser.
 * 3. **It is a new artefact, and it is honest about being one.** The file says
 *    a BTQ wallet exists. It does not say how many accounts are in it — the
 *    plaintext is padded to a fixed length, so every backup this build writes is
 *    the same size — and the default file name says nothing about the wallet at
 *    all. Neither of those makes it safe to leave lying about, which is what the
 *    copy beside the button is for; they make the claim precise.
 *
 * A backup being decrypted is *authenticated* input, not *trusted* input: on an
 * import the person who sealed it may be the person who handed it over. So the
 * hostile-file cases below are not paranoia about our own encoder, they are the
 * real threat model of the import screen.
 */
import { describe, it, expect } from 'vitest';
import { Keyring, UNLOCK_ATTEMPTS_BEFORE_BACKOFF } from '../../src/core/wallet/keyring.js';
import { dispatch } from '../../src/core/rpc/dispatch.js';
import { WalletError } from '../../src/core/wallet/errors.js';
import { decryptVault, encryptVault } from '../../src/core/vault/encrypt.js';
import {
  BACKUP_PLAINTEXT_BYTES,
  BACKUP_VERSION,
  MAX_BACKUP_BYTES,
  backupFileName,
  decodeBackup,
  encodeBackup,
  type BackupPayload,
} from '../../src/core/vault/backup.js';
import { addressFromHdSeed } from '../../src/core/wallet/derive.js';
import { ACCOUNT_NAME_MAX, MAX_ACCOUNTS } from '../../src/core/wallet/storage.js';
import { mnemonicToEntropy, mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';
import { bytesToHex, hexToBytes } from '../../src/core/util/hex.js';
import { MemoryWalletStorage, TEST_ENCRYPT } from '../helpers/memory-store.js';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'testnet-ok';
const RAW_SEED_HEX = 'a1'.repeat(32);
const HD = mnemonicToHdSeed(MNEMONIC);
const SEED_HEX = bytesToHex(HD);
const ENTROPY_HEX = bytesToHex(mnemonicToEntropy(MNEMONIC));

function ring(store = new MemoryWalletStorage(), clock?: { t: number }) {
  return new Keyring(store, {
    encrypt: TEST_ENCRYPT,
    network: 'testnet',
    now: clock ? () => clock.t : undefined,
  });
}

/** A wallet with `extra` accounts beyond the first, the last one renamed. */
async function walletWith(extra: number, name?: string) {
  const k = ring();
  await k.importMnemonic(MNEMONIC, PASSWORD);
  for (let i = 0; i < extra; i++) await k.createAccount();
  if (name !== undefined) await k.renameAccount(extra, name);
  await k.switchAccount(0);
  return k;
}

/** Seal an arbitrary backup body the way `exportBackup` does, for the hostile cases. */
async function sealBackup(body: Record<string, unknown>): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(body));
  const padded = new Uint8Array(BACKUP_PLAINTEXT_BYTES).fill(0x20);
  padded.set(json, 0);
  return bytesToHex(await encryptVault(padded, PASSWORD, TEST_ENCRYPT));
}

function goodBody(): Record<string, unknown> {
  return {
    b: BACKUP_VERSION,
    network: 'testnet',
    origin: 'bip39',
    hdSeedHex: SEED_HEX,
    entropyHex: ENTROPY_HEX,
    accounts: [
      { index: 0, name: 'Account 1' },
      { index: 3, name: 'Payroll' },
    ],
    activeAccount: 3,
  };
}

describe('a backup restores the account list a phrase cannot carry', () => {
  it('brings back every account, its index and the name the user chose', async () => {
    // The whole point, asserted first. Four accounts on one device; a second
    // device that has only ever seen the file ends up with the same four.
    const source = await walletWith(3, 'Payroll');
    const { backupHex } = await source.exportBackup(PASSWORD);

    const restored = ring();
    const { accounts } = await restored.importBackup(backupHex, PASSWORD);
    expect(accounts).toEqual([0, 1, 2, 3]);
    const before = (await source.status()).accounts;
    const after = (await restored.status()).accounts;
    expect(after.map((a) => [a.index, a.name])).toEqual(before.map((a) => [a.index, a.name]));
    expect(after.map((a) => a.name)).toContain('Payroll');
  });

  it('the restored accounts derive the identical addresses, so the coins are reachable', async () => {
    // A name that comes back attached to the wrong derivation path is worse
    // than no restore: the wallet looks right and the coins are not there.
    const source = await walletWith(3);
    const sourceAddresses: string[] = [];
    for (const index of [0, 1, 2, 3]) {
      await source.switchAccount(index);
      sourceAddresses.push((await source.receiveAddress()).address);
    }
    const { backupHex } = await source.exportBackup(PASSWORD);

    const restored = ring();
    await restored.importBackup(backupHex, PASSWORD);
    for (const index of [0, 1, 2, 3]) {
      await restored.switchAccount(index);
      expect((await restored.receiveAddress()).address, `account ${index}`).toBe(sourceAddresses[index]);
      expect(sourceAddresses[index]).toBe(addressFromHdSeed(HD, 'external', 0, 'testnet', index).address);
    }
  });

  it('the account that was in front is still in front', async () => {
    const source = await walletWith(2);
    await source.switchAccount(2);
    const { backupHex } = await source.exportBackup(PASSWORD);
    const restored = ring();
    await restored.importBackup(backupHex, PASSWORD);
    expect((await restored.status()).activeAccount).toBe(2);
  });

  it('a restored phrase wallet can still show its phrase, and a raw-seed one still cannot', async () => {
    // `origin` and the sealed entropy travel together or the restored wallet
    // lies about itself: it says it came from a phrase and then cannot produce
    // one, which is the third state this build deliberately does not have.
    const fromPhrase = ring();
    await fromPhrase.importMnemonic(MNEMONIC, PASSWORD);
    const phraseBackup = (await fromPhrase.exportBackup(PASSWORD)).backupHex;
    const restoredPhrase = ring();
    await restoredPhrase.importBackup(phraseBackup, PASSWORD);
    expect((await restoredPhrase.revealPhrase(PASSWORD)).words.join(' ')).toBe(MNEMONIC);
    expect((await restoredPhrase.status()).backup).toBe('recoveryPhrase');

    const fromSeed = ring();
    await fromSeed.importSeed(RAW_SEED_HEX, PASSWORD);
    const seedBackup = (await fromSeed.exportBackup(PASSWORD)).backupHex;
    const restoredSeed = ring();
    await restoredSeed.importBackup(seedBackup, PASSWORD);
    await expect(restoredSeed.revealPhrase(PASSWORD)).rejects.toMatchObject({ code: 'NO_PHRASE' });
    expect((await restoredSeed.status()).backup).toBe('hdSeed');
    expect((await restoredSeed.revealSeedHex(PASSWORD)).seedHex).toBe(RAW_SEED_HEX);
  });

  it('the restored wallet can export a backup of its own, unchanged in what it says', async () => {
    // A backup that cannot itself be backed up is a one-way door. The bytes
    // differ — a fresh salt and IV every seal — but what they open onto must not.
    const source = await walletWith(2, 'Savings');
    const first = await source.exportBackup(PASSWORD);
    const restored = ring();
    await restored.importBackup(first.backupHex, PASSWORD);
    const second = await restored.exportBackup(PASSWORD);
    expect(second.backupHex).not.toBe(first.backupHex);
    const open = async (hex: string) => decodeBackup(await decryptVault(hexToBytes(hex), PASSWORD));
    expect(await open(second.backupHex)).toEqual(await open(first.backupHex));
  });

  it('refuses to land on a device that already has a wallet', async () => {
    // Same refusal as the phrase and raw-seed imports, and for the same reason:
    // overwriting a vault is a way to destroy coins with one click.
    const source = await walletWith(1);
    const { backupHex } = await source.exportBackup(PASSWORD);
    const occupied = ring();
    await occupied.importMnemonic(MNEMONIC, 'another-password');
    await expect(occupied.importBackup(backupHex, PASSWORD)).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
    });
  });

  it('refuses a backup sealed for another network instead of re-deriving on this one', async () => {
    // Silently accepting it would show a mainnet wallet testnet addresses and
    // invite a send to an address the coins are not on.
    const hex = await sealBackup({ ...goodBody(), network: 'mainnet' });
    await expect(ring().importBackup(hex, PASSWORD)).rejects.toMatchObject({ code: 'WRONG_NETWORK' });
  });
});

describe('a backup is behind the same door as a reveal', () => {
  it('a locked wallet refuses to export, even with the right password', async () => {
    // Attacker gain: an export that works while locked is the whole wallet —
    // seed, accounts and names — lifted out of an unattended browser and
    // cracked at leisure. It is strictly worse than the phrase reveal, because
    // the file survives the walk away from the desk.
    const k = await walletWith(1);
    k.lock();
    await expect(k.exportBackup(PASSWORD)).rejects.toThrow(/locked/i);
    expect((await k.status()).unlocked).toBe(false);
  });

  it('a wrong password refuses and names nothing but the password', async () => {
    const k = await walletWith(1);
    try {
      await k.exportBackup('not-the-password');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WalletError).code).toBe('WRONG_PASSWORD');
      expect((e as WalletError).message).toBe('Incorrect password.');
      expect((e as WalletError).message).not.toContain(SEED_HEX.slice(0, 16));
    }
    // …and the right one still works afterwards.
    expect((await k.exportBackup(PASSWORD)).backupHex.length).toBeGreaterThan(0);
  });

  it('wrong export attempts throttle the reveals, and wrong reveals throttle the export', async () => {
    // One counter or it is another unlimited password oracle against the same
    // vault, reachable from an open popup.
    const clock = { t: 1_000 };
    const k = ring(new MemoryWalletStorage(), clock);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    for (let i = 0; i < UNLOCK_ATTEMPTS_BEFORE_BACKOFF; i++) {
      await expect(k.exportBackup('wrong-password')).rejects.toThrow('Incorrect password.');
    }
    await expect(k.revealPhrase(PASSWORD)).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
    await expect(k.exportBackup(PASSWORD)).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });

    const other = ring(new MemoryWalletStorage(), { t: 1_000 });
    await other.importMnemonic(MNEMONIC, PASSWORD);
    for (let i = 0; i < UNLOCK_ATTEMPTS_BEFORE_BACKOFF; i++) {
      await expect(other.revealPhrase('wrong-password')).rejects.toThrow('Incorrect password.');
    }
    await expect(other.exportBackup(PASSWORD)).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
  });

  it('a page cannot export a backup or import one, with or without the password', async () => {
    // Attacker gain: one call from a web page and the site holds the whole
    // wallet, needing only the password it can then phish at leisure.
    const k = await walletWith(1);
    for (const params of [{}, { password: PASSWORD }, { password: PASSWORD, backupHex: '00' }]) {
      for (const method of ['wallet.exportBackup', 'wallet.importBackup'] as const) {
        await expect(dispatch(k, { method, params }, { fromTab: true })).rejects.toThrow(
          /not available to pages/,
        );
      }
    }
    // …and the same call from the popup answers, so the refusal is about the
    // sender rather than a method that is broken for everybody.
    const result = (await dispatch(
      k,
      { method: 'wallet.exportBackup', params: { password: PASSWORD } },
      { fromTab: false },
    )) as { fileName: string; backupHex: string };
    expect(Object.keys(result).sort()).toEqual(['backupHex', 'fileName']);
  });

  it('a missing parameter is a parameter error, never a wrong password or a bad file', async () => {
    const k = await walletWith(1);
    await expect(
      dispatch(k, { method: 'wallet.exportBackup', params: {} }, { fromTab: false }),
    ).rejects.toMatchObject({ code: 'BAD_PARAMS' });
    const fresh = ring();
    for (const params of [{}, { backupHex: '00' }, { password: PASSWORD }]) {
      await expect(
        dispatch(fresh, { method: 'wallet.importBackup', params }, { fromTab: false }),
      ).rejects.toMatchObject({ code: 'BAD_PARAMS' });
    }
  });

  it('exporting twice leaves the vault, the seed and the wallet exactly as they were', async () => {
    // The wipes in the `finally` must touch the copies and not the vault. No
    // test can watch a function's locals, so what is asserted is what wiping
    // the wrong buffer would break.
    const k = await walletWith(1);
    const before = (await k.receiveAddress()).address;
    const first = await k.exportBackup(PASSWORD);
    const second = await k.exportBackup(PASSWORD);
    expect(second.backupHex).not.toBe(first.backupHex); // fresh salt and IV
    await k.reauth(PASSWORD);
    expect((await k.receiveAddress()).address).toBe(before);
    expect((await k.revealPhrase(PASSWORD)).words.join(' ')).toBe(MNEMONIC);
    const restored = ring();
    await restored.importBackup(second.backupHex, PASSWORD);
    expect((await restored.receiveAddress()).address).toBe(before);
  });

  it('refuses to seal a backup of a vault that is not the wallet on screen', async () => {
    // Attacker gain: anything that can write extension storage swaps the vault
    // blob for one of its own, sealed under a password it knows the user will
    // type. The user then saves what they believe is their backup, and it
    // restores somebody else's wallet — so the real one is gone the day they
    // trust the file. The same guard the seed reveal has, and it is the reason
    // both go through one check rather than two.
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);

    const elsewhere = new MemoryWalletStorage();
    const decoy = ring(elsewhere);
    await decoy.importSeed(RAW_SEED_HEX, PASSWORD); // a different wallet, same password
    store.vault = elsewhere.vault;

    await expect(k.exportBackup(PASSWORD)).rejects.toMatchObject({ code: 'NOT_A_VAULT' });
    await expect(k.revealSeedHex(PASSWORD)).rejects.toMatchObject({ code: 'NOT_A_VAULT' });
  });

  it('exporting writes nothing new to storage — the file is the only copy that leaves', async () => {
    // Attacker gain: an export that cached the backup, or its plaintext, in
    // chrome.storage would turn "read extension storage" into "hold the wallet
    // file", with no password prompt anywhere in between.
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    await k.createAccount();
    const vaultBefore = bytesToHex((await store.loadVault())!);
    const { backupHex } = await k.exportBackup(PASSWORD);

    expect(bytesToHex((await store.loadVault())!)).toBe(vaultBefore);
    const onDisk = JSON.stringify({
      meta: await store.loadMeta(),
      activity: await store.loadActivity(),
      origins: await store.loadOrigins(),
    });
    expect(onDisk).not.toContain(backupHex.slice(0, 32));
    expect(onDisk).not.toContain(SEED_HEX.slice(0, 16));
    expect(onDisk).not.toContain(ENTROPY_HEX);
    expect(onDisk).not.toContain(PASSWORD);
  });
});

describe('what the sealed file gives away', () => {
  it('holds neither the seed, the entropy nor the phrase in the clear', async () => {
    // Attacker gain: a file that carried any of the three would make the
    // password decorative — the artefact would be the wallet the moment it was
    // copied off the machine.
    const k = await walletWith(2, 'Payroll');
    const { backupHex } = await k.exportBackup(PASSWORD);
    const asLatin = new TextDecoder('latin1').decode(hexToBytes(backupHex));
    expect(SEED_HEX).toHaveLength(128); // the scans below are not vacuous
    expect(asLatin).not.toContain(SEED_HEX);
    expect(asLatin).not.toContain(SEED_HEX.slice(0, 16));
    expect(asLatin).not.toContain(ENTROPY_HEX);
    expect(asLatin).not.toContain(MNEMONIC);
    expect(asLatin).not.toContain('abandon abandon');
    expect(asLatin).not.toContain('hdSeedHex');
    expect(asLatin).not.toContain(PASSWORD);
  });

  it('does not carry the account names or the addresses in the clear either', async () => {
    // The account graph is the thing this whole feature exists to preserve, so
    // it is also the thing that must not be readable off the artefact that
    // preserves it. A label like "Payroll" beside an address is a dossier.
    const k = await walletWith(2, 'Payroll');
    const address = addressFromHdSeed(HD, 'external', 0, 'testnet', 2).address;
    const { backupHex } = await k.exportBackup(PASSWORD);
    const asLatin = new TextDecoder('latin1').decode(hexToBytes(backupHex));
    expect(asLatin).not.toContain('Payroll');
    expect(asLatin).not.toContain(address);
    expect(asLatin).not.toContain('accounts');
  });

  it('is the same size whatever the account list, so the file does not count them', async () => {
    // Ciphertext length tracks plaintext length. Without the fixed-length pad,
    // a twelve-account wallet's backup is visibly larger than a one-account
    // wallet's, and the count is legible to anyone holding the file — the exact
    // structural fact this feature exists to keep off a third party's disk.
    const sizes = new Set<number>();
    for (const extra of [0, 1, 11]) {
      const k = await walletWith(extra, extra > 0 ? 'a name that is a bit longer' : undefined);
      sizes.add(hexToBytes((await k.exportBackup(PASSWORD)).backupHex).length);
    }
    expect(sizes.size).toBe(1);
    expect([...sizes][0]).toBeGreaterThan(BACKUP_PLAINTEXT_BYTES);
  });

  it('the largest wallet this build can hold still fits the fixed plaintext', async () => {
    // The pad is only a pad while everything fits inside it: an encoder that
    // overflowed would throw rather than emit a short file, and this is the
    // worst case it must never throw on.
    const name = '\u{1f600}'.repeat(ACCOUNT_NAME_MAX);
    const accounts = Array.from({ length: MAX_ACCOUNTS }, (_, index) => ({ index, name }));
    const body: BackupPayload = {
      b: BACKUP_VERSION,
      network: 'testnet',
      origin: 'bip39',
      hdSeedHex: SEED_HEX,
      entropyHex: '1e'.repeat(32),
      accounts,
      activeAccount: MAX_ACCOUNTS - 1,
    };
    const encoded = encodeBackup(body);
    expect(encoded.length).toBe(BACKUP_PLAINTEXT_BYTES);
    expect(decodeBackup(encoded).accounts).toHaveLength(MAX_ACCOUNTS);
  });

  it('the default file name says what the file is and nothing about the wallet', async () => {
    // A file name is the one part of a backup that is never encrypted, and it
    // lands in a folder other software indexes. So: no address, no account name,
    // no balance, no network — the kind of thing that identifies *this* wallet.
    const k = await walletWith(2, 'Payroll');
    const { fileName } = await k.exportBackup(PASSWORD);
    expect(fileName).toBe(backupFileName(Date.now()));
    expect(fileName).toMatch(/^btq-wallet-backup-\d{4}-\d{2}-\d{2}\.btqbackup$/);
    for (const secret of ['Payroll', 'tbtq1', SEED_HEX.slice(0, 8), 'testnet']) {
      expect(fileName, secret).not.toContain(secret);
    }
    // Stable for one day and not a per-export nonce: the user is meant to
    // recognise their own file, and a name that changed every time would leave
    // a folder full of near-identical whole wallets.
    expect(backupFileName(Date.UTC(2026, 7, 23, 1))).toBe(backupFileName(Date.UTC(2026, 7, 23, 23)));
  });
});

describe('an imported backup is authenticated, not trusted', () => {
  it('a hostile file cannot write invisible characters into an account name', async () => {
    // The one attacker-writable string this UI renders. A bidi override turns a
    // name into something that reads backwards beside a real address, and a
    // lone surrogate is not a string the chrome or JSON can round-trip. The
    // file is sealed, but on this path whoever sealed it is the attacker.
    const hex = await sealBackup({
      ...goodBody(),
      accounts: [
        { index: 0, name: 'Account 1' },
        { index: 1, name: 'Payroll‮gpj.exe​' },
      ],
    });
    const k = ring();
    await k.importBackup(hex, PASSWORD);
    const names = (await k.status()).accounts.map((a) => a.name);
    for (const name of names) {
      expect(name, name).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    }
    expect(names.some((n) => n.includes('Payroll'))).toBe(true);
  });

  it('refuses an account index outside the range this wallet derives', async () => {
    // An index the wallet cannot hold either wedges the list or makes the popup
    // render a row with no key behind it.
    for (const index of [MAX_ACCOUNTS, 1e9, -1, 1.5, '2', null] as unknown[]) {
      const hex = await sealBackup({
        ...goodBody(),
        accounts: [{ index: 0, name: 'Account 1' }, { index, name: 'x' }],
      });
      await expect(ring().importBackup(hex, PASSWORD), String(index)).rejects.toMatchObject({
        code: 'NOT_A_BACKUP',
      });
    }
  });

  it('refuses a list longer than the wallet, a duplicate index, or one with no account 0', async () => {
    // The first of these is refused by the index bound rather than by a length
    // check — twenty-one distinct indices cannot all fit in [0, MAX_ACCOUNTS) —
    // which is why the decoder carries no separate cap. Asserted here anyway:
    // what matters is that the list cannot outgrow the wallet, not which line
    // says so.
    const tooMany = Array.from({ length: MAX_ACCOUNTS + 1 }, (_, index) => ({ index, name: 'x' }));
    const cases: Record<string, unknown>[] = [
      { accounts: tooMany },
      { accounts: [{ index: 0, name: 'a' }, { index: 0, name: 'b' }] },
      // Account 0 is btq-core's own path: a list without it hides those coins
      // and, with the next index already taken, leaves no way to add it back.
      { accounts: [{ index: 1, name: 'only' }] },
      { accounts: [] },
      { accounts: 'not-a-list' },
    ];
    for (const patch of cases) {
      const hex = await sealBackup({ ...goodBody(), ...patch });
      await expect(ring().importBackup(hex, PASSWORD), JSON.stringify(patch).slice(0, 40)).rejects.toMatchObject({
        code: 'NOT_A_BACKUP',
      });
    }
  });

  it('refuses a seed that is not one of the two lengths this wallet seals', async () => {
    for (const hdSeedHex of ['', 'ab', 'zz'.repeat(32), 'ab'.repeat(48), SEED_HEX.toUpperCase()]) {
      const hex = await sealBackup({ ...goodBody(), hdSeedHex });
      await expect(ring().importBackup(hex, PASSWORD), hdSeedHex.slice(0, 8)).rejects.toMatchObject({
        code: 'NOT_A_BACKUP',
      });
    }
  });

  it('refuses a backup whose origin and entropy disagree, in either direction', async () => {
    // The invariant `decodePayload` holds for the vault, held here too: a wallet
    // that says it came from a phrase must be able to produce one.
    const noEntropy = { ...goodBody() };
    delete noEntropy.entropyHex;
    for (const body of [
      noEntropy,
      { ...goodBody(), entropyHex: null },
      { ...goodBody(), entropyHex: 'ab' },
      { ...goodBody(), origin: 'raw32', hdSeedHex: RAW_SEED_HEX },
    ]) {
      const hex = await sealBackup(body);
      await expect(ring().importBackup(hex, PASSWORD)).rejects.toMatchObject({ code: 'NOT_A_BACKUP' });
    }
    // …and the matching raw-32 body, with no entropy, is accepted.
    const raw = await sealBackup({
      b: BACKUP_VERSION,
      network: 'testnet',
      origin: 'raw32',
      hdSeedHex: RAW_SEED_HEX,
      accounts: [{ index: 0, name: 'Account 1' }],
      activeAccount: 0,
    });
    await expect(ring().importBackup(raw, PASSWORD)).resolves.toEqual({ accounts: [0] });
  });

  it('an activeAccount that is not in the list falls back to the first, never to nothing', async () => {
    const hex = await sealBackup({ ...goodBody(), activeAccount: 7 });
    const k = ring();
    await k.importBackup(hex, PASSWORD);
    const status = await k.status();
    expect(status.activeAccount).toBe(0);
    expect(status.accounts.map((a) => a.index)).toEqual([0, 3]);
    // And it is a real account, not a name over an empty slot.
    expect((await k.receiveAddress()).address).toBe(addressFromHdSeed(HD, 'external', 0, 'testnet', 0).address);
  });

  it('a vault blob is not a backup, and a backup is not a vault', async () => {
    // They share the `BTQ1` envelope, so only the payload shape keeps them
    // apart. A vault silently opening as a backup would restore a wallet with
    // no account list and call it complete; a backup opening as a vault would
    // drop the list on the floor without a word.
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const vaultHex = bytesToHex((await store.loadVault())!);
    await expect(ring().importBackup(vaultHex, PASSWORD)).rejects.toMatchObject({
      code: 'NOT_A_BACKUP',
    });
    const { backupHex } = await k.exportBackup(PASSWORD);
    const asBackup = await decryptVault(hexToBytes(backupHex), PASSWORD);
    await expect(async () => {
      const { decodePayload } = await import('../../src/core/vault/payload.js');
      decodePayload(asBackup);
    }).rejects.toMatchObject({ code: 'NOT_A_VAULT' });
  });

  it('refuses a file that is not ours before it says anything about the password', async () => {
    // "That is not a backup" and "that is the wrong password" send a user to
    // opposite corners of the room; they must never be spelled the same.
    for (const hex of ['', 'zz', '00'.repeat(64), 'ab'.repeat(200)]) {
      await expect(ring().importBackup(hex, PASSWORD), hex.slice(0, 6)).rejects.toMatchObject({
        code: 'NOT_A_BACKUP',
      });
    }
    const good = await sealBackup(goodBody());
    await expect(ring().importBackup(good, 'not-the-password')).rejects.toMatchObject({
      code: 'WRONG_PASSWORD',
    });
  });

  it('refuses a file larger than any backup this build writes, without decrypting it', async () => {
    // A hostile 50 MB "backup" would otherwise be hexed, sent over the message
    // channel and run through PBKDF2 before anything noticed.
    const huge = 'ab'.repeat(MAX_BACKUP_BYTES + 1);
    await expect(ring().importBackup(huge, PASSWORD)).rejects.toMatchObject({ code: 'NOT_A_BACKUP' });
  });

  it('a short password is refused as a weak password, not as a bad file', async () => {
    const good = await sealBackup(goodBody());
    await expect(ring().importBackup(good, 'short')).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
  });
});

describe('the codec round-trips and pads', () => {
  it('pads to the fixed length and reads back exactly what went in', () => {
    const body: BackupPayload = {
      b: BACKUP_VERSION,
      network: 'testnet',
      origin: 'bip39',
      hdSeedHex: SEED_HEX,
      entropyHex: ENTROPY_HEX,
      accounts: [
        { index: 0, name: 'Account 1' },
        { index: 1, name: 'Payroll' },
      ],
      activeAccount: 1,
    };
    const encoded = encodeBackup(body);
    expect(encoded.length).toBe(BACKUP_PLAINTEXT_BYTES);
    expect(decodeBackup(encoded)).toEqual(body);
  });

  it('drops fields it does not know rather than carrying them into the keyring', () => {
    const encoded = encodeBackup({
      ...(goodBody() as unknown as BackupPayload),
      // @ts-expect-error a field a future build (or an attacker) might add
      lastBalanceSats: '4100000',
    });
    expect(Object.keys(decodeBackup(encoded)).sort()).toEqual(
      ['accounts', 'activeAccount', 'b', 'entropyHex', 'hdSeedHex', 'network', 'origin'].sort(),
    );
  });
});
