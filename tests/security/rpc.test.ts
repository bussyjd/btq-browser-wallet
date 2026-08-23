import { describe, it, expect } from 'vitest';
import { Keyring } from '../../src/core/wallet/keyring.js';
import { dispatch } from '../../src/core/rpc/dispatch.js';
import { isUntrustedSender } from '../../src/core/rpc/origin.js';
import { SECRET_RESULT_KEYS, WALLET_METHODS } from '../../src/core/rpc/protocol.js';
import { mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';
import { bytesToHex, hexToBytes } from '../../src/core/util/hex.js';
import { MemoryWalletStorage, TEST_ENCRYPT } from '../helpers/memory-store.js';

function keyring() {
  return new Keyring(new MemoryWalletStorage(), { encrypt: TEST_ENCRYPT, network: 'testnet' });
}

function collectKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, into);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      into.push(k);
      collectKeys(v, into);
    }
  }
  return into;
}

/** Every string value in a result, ignoring key names — a leak is always a value. */
function stringValues(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const v of value) stringValues(v, into);
  else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) stringValues(v, into);
  }
  return into;
}

describe('RPC surface — what a page could try', () => {
  it('a tab cannot call any wallet method', async () => {
    // Attacker gain: a webpage talking to the extension would unlock, wipe, or
    // pull a freshly generated mnemonic.
    const k = keyring();
    for (const method of WALLET_METHODS) {
      await expect(dispatch(k, { method, params: { password: 'testnet-ok', confirmation: 'DELETE' } }, { fromTab: true })).rejects.toThrow(
        /not available to pages/,
      );
    }
    expect((await k.status()).awaitingConfirm).toBe(false);
    expect((await k.status()).hasVault).toBe(false);
  });

  it('a tab cannot wipe a sealed vault', async () => {
    // Attacker gain: destroy the only copy of the encrypted seed (funds gone
    // if the user has no backup).
    const k = keyring();
    await k.importMnemonic(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      'testnet-ok',
    );
    await expect(
      dispatch(k, { method: 'wallet.wipe', params: { confirmation: 'DELETE' } }, { fromTab: true }),
    ).rejects.toThrow(/not available to pages/);
    expect((await k.status()).hasVault).toBe(true);
    expect((await k.status()).unlocked).toBe(true);
  });

  it('unknown methods are rejected', async () => {
    const k = keyring();
    await expect(
      dispatch(k, { method: 'wallet.exportSeed' }, { fromTab: false }),
    ).rejects.toThrow(/Unknown method/);
    expect(WALLET_METHODS.includes('wallet.exportSeed' as never)).toBe(false);
  });

  it('create, revealPhrase and revealSeedHex are the only responses that carry secret material', async () => {
    const k = keyring();
    const created = (await dispatch(k, { method: 'wallet.create', params: { password: 'testnet-ok' } }, { fromTab: false })) as {
      mnemonic: string;
      challenge: number[];
    };
    expect(created.mnemonic.split(' ')).toHaveLength(12);
    const status = await dispatch(k, { method: 'wallet.status' }, { fromTab: false });
    expect(collectKeys(status).includes('mnemonic')).toBe(false);
    expect(JSON.stringify(status).includes(created.mnemonic)).toBe(false);

    const words = created.mnemonic.split(' ');
    await dispatch(
      k,
      {
        method: 'wallet.confirm',
        params: { answers: created.challenge.map((index) => ({ index, word: words[index] })), password: 'testnet-ok' },
      },
      { fromTab: false },
    );
    k.lock();
    await dispatch(k, { method: 'wallet.unlock', params: { password: 'testnet-ok' } }, { fromTab: false });
    const receive = await dispatch(k, { method: 'wallet.receive' }, { fromTab: false });
    const keys = collectKeys(receive);
    for (const secret of SECRET_RESULT_KEYS) {
      expect(keys.includes(secret)).toBe(false);
    }

    // The second one. It carries the phrase deliberately, under exactly one
    // key, and only to an extension page that just re-typed the password.
    const revealed = (await dispatch(
      k,
      { method: 'wallet.revealPhrase', params: { password: 'testnet-ok' } },
      { fromTab: false },
    )) as { words: string[] };
    expect(Object.keys(revealed)).toEqual(['words']);
    expect(revealed.words).toEqual(words);

    // The third, and the one worth the most: `revealSeedHex` returns the master
    // secret itself, not an encoding of it. Taking the ground truth from the
    // method that is *allowed* to return it is deliberate — the scan below is
    // then over the wallet's own live seed rather than over a value the test
    // computed and hoped matched, and it cannot go stale if derivation changes.
    const seedReveal = (await dispatch(
      k,
      { method: 'wallet.revealSeedHex', params: { password: 'testnet-ok' } },
      { fromTab: false },
    )) as { seedHex: string };
    expect(Object.keys(seedReveal)).toEqual(['seedHex']);
    const seedHex = seedReveal.seedHex.toLowerCase();
    // Not vacuous, and it really is this phrase's seed: an empty or truncated
    // needle would make every assertion below pass against a leaking wallet.
    expect(seedHex).toHaveLength(128);
    expect(seedHex).toBe(bytesToHex(mnemonicToHdSeed(created.mnemonic)).toLowerCase());

    // And every other method still carries none of it — the honest replacement
    // for "only once", which a re-display feature cannot claim. Whole tokens,
    // so a word that happens to be a substring of an address does not mask a
    // real leak or invent one.
    const others: Record<string, unknown> = {
      status: await dispatch(k, { method: 'wallet.status' }, { fromTab: false }),
      receive: await dispatch(k, { method: 'wallet.receive' }, { fromTab: false }),
      activity: await dispatch(k, { method: 'wallet.activity' }, { fromTab: false }),
      history: await dispatch(k, { method: 'wallet.history' }, { fromTab: false, fetchHistory: async () => [] }),
      connectedSites: await dispatch(k, { method: 'wallet.connectedSites' }, { fromTab: false }),
    };
    for (const [name, result] of Object.entries(others)) {
      // Tokenise the string *values*, not the serialization: key names and JSON
      // literals are attacker-irrelevant (a leak lands in a value) and eleven of
      // them — address, balance, false, height, history, index, network, path,
      // receive, tip, true — are themselves BIP39 words, which made this assertion
      // fail on ~6% of runs against a perfectly correct wallet.
      const tokens = new Set(stringValues(result).join(' ').toLowerCase().split(/[^a-z]+/));
      for (const word of new Set(words)) expect(tokens.has(word), `${name} leaked "${word}"`).toBe(false);
      // Nothing may carry the phrase whole, in any encoding of it.
      expect(JSON.stringify(result).toLowerCase(), `${name} leaked the phrase`).not.toContain(
        words.join(' '),
      );

      // The same scan for the **HD seed hex**, which is now returned by an RPC
      // method of its own and is the master secret every key in this wallet
      // comes out of — worth strictly more to an attacker than the words, which
      // only encode it. The phrase scan above would not have caught this: a
      // 64-byte hex string tokenises into no BIP39 word at all.
      //
      // Joined with spaces, so a needle can only be found inside one value and
      // never manufactured by two harmless values sitting next to each other.
      const blob = stringValues(result).join(' ').toLowerCase();
      expect(blob, `${name} leaked the HD seed`).not.toContain(seedHex);
      // …and a partial leak is a leak. 32 hex characters is 128 bits: it cannot
      // occur by accident in an address, a txid or a derivation path, so this
      // catches a seed that is truncated, split across fields, or half-printed.
      expect(blob, `${name} leaked half the HD seed`).not.toContain(seedHex.slice(0, 32));
      expect(blob, `${name} leaked the tail of the HD seed`).not.toContain(seedHex.slice(-32));
      // Key names are not the leak, but the serialization catches an encoding
      // the value walk cannot reach — a seed inside a number array, say.
      expect(JSON.stringify(result).toLowerCase(), `${name} leaked the HD seed`).not.toContain(
        seedHex,
      );
      for (const secret of SECRET_RESULT_KEYS) {
        expect(collectKeys(result).includes(secret), `${name}.${secret}`).toBe(false);
      }
    }
    expect(collectKeys(others.status).includes('words')).toBe(false);
  });

  it('wallet.exportBackup hands over the whole wallet — sealed, and with none of it readable', async () => {
    // The one method that returns something the size of the wallet. It is the
    // `BTQ1` envelope and not key material, and this is where that claim is
    // checked rather than asserted: the bytes on the wire must hold no word of
    // the phrase, no run of the seed hex and no field name from the payload.
    // The scan is over the decoded ciphertext, not tokenised text, because a
    // leak here would be a whole encoding and never a coincidence of letters.
    const k = keyring();
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    await k.importMnemonic(mnemonic, 'testnet-ok');
    await k.createAccount();
    const result = (await dispatch(
      k,
      { method: 'wallet.exportBackup', params: { password: 'testnet-ok' } },
      { fromTab: false },
    )) as { fileName: string; backupHex: string };

    for (const secret of SECRET_RESULT_KEYS) {
      expect(collectKeys(result).includes(secret), secret).toBe(false);
    }
    const seedHex = bytesToHex(mnemonicToHdSeed(mnemonic));
    const bytes = new TextDecoder('latin1').decode(hexToBytes(result.backupHex));
    expect(seedHex).toHaveLength(128); // the scans below are not vacuous
    expect(bytes).not.toContain(seedHex);
    expect(bytes).not.toContain(seedHex.slice(0, 16));
    expect(bytes).not.toContain(mnemonic);
    expect(bytes).not.toContain('abandon');
    expect(bytes).not.toContain('hdSeedHex');
    expect(bytes).not.toContain('entropyHex');
    // …and the file name is not a place to put any of it either.
    expect(result.fileName).not.toContain(seedHex.slice(0, 8));
    expect(result.fileName).not.toContain('abandon');
  });
});

describe('message sender origin', () => {
  const EXT = 'chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef';

  it('a page origin cannot pass as the extension even with no tab', () => {
    // Attacker gain: if origin were matched with includes/startsWith, a site
    // whose origin contains the extension id could call wallet.*.
    expect(isUntrustedSender({ origin: 'https://evil.example' }, EXT)).toBe(true);
    expect(isUntrustedSender({ origin: `${EXT}.evil.example` }, EXT)).toBe(true);
    expect(isUntrustedSender({ origin: `https://evil.example/?q=${EXT}` }, EXT)).toBe(true);
    expect(isUntrustedSender({ origin: EXT.slice(0, -1) }, EXT)).toBe(true);
    expect(isUntrustedSender({ origin: EXT }, EXT)).toBe(false);
  });

  it('a content script in a tab is untrusted whatever the page claims', () => {
    // Attacker gain: a content script that passed as the extension would reach
    // wallet.unlock / wallet.confirmSend with page-supplied parameters.
    expect(isUntrustedSender({ tab: { id: 1 }, origin: 'https://evil.example' }, EXT)).toBe(true);
    expect(isUntrustedSender({ tab: { id: 1 }, origin: `${EXT}.evil.example` }, EXT)).toBe(true);
    expect(isUntrustedSender({ tab: { id: 1 }, url: 'https://evil.example/x' }, EXT)).toBe(true);
    // No origin at all and attached to a tab: refuse rather than guess.
    expect(isUntrustedSender({ tab: { id: 1 } }, EXT)).toBe(true);
  });

  it('an extension page in a tab or window is trusted — the approval window is one', () => {
    // Regression: treating any tab sender as a page locked the site-connect
    // approval window (chrome.windows.create) and an onboarding tab out of
    // wallet.*, so a user could never approve a site or finish onboarding.
    expect(isUntrustedSender({ tab: { id: 7 }, origin: EXT }, EXT)).toBe(false);
    expect(isUntrustedSender({ tab: { id: 7 }, url: `${EXT}/src/ui/index.html?connect=1` }, EXT)).toBe(false);
  });

  it('a popup with no tab and the exact extension origin is trusted', () => {
    expect(isUntrustedSender({}, EXT)).toBe(false);
    expect(isUntrustedSender({ origin: EXT }, EXT)).toBe(false);
  });
});
