/**
 * The decoder that stands between a decrypted blob and the keyring.
 *
 * Everything here is *inside* the AES-GCM envelope, so nothing an attacker can
 * write reaches this code — which is exactly why it is allowed to be strict:
 * anything malformed is our own bug, and rounding it off (a bad `entropyHex`
 * silently becoming "no phrase") would hide the bug behind a wallet that just
 * stops offering the reveal.
 *
 * There are two refusals and they are not interchangeable. `NOT_A_VAULT` is the
 * non-oracle one: corruption, a foreign blob, a hand-edited payload, always the
 * same sentence and never a named field. `VAULT_TOO_OLD` says something a user
 * is expected to act on — remove this wallet and import it again — so it is
 * reached only by a payload that is recognisably ours and recognisably from the
 * pre-2 build. A blob that is merely broken must never produce it.
 */
import { describe, it, expect } from 'vitest';
import {
  decodePayload,
  encodePayload,
  OLD_VAULT_MESSAGE,
  VAULT_PAYLOAD_VERSION,
  type VaultPayload,
} from '../../src/core/vault/payload.js';
import { WalletError } from '../../src/core/wallet/errors.js';

const SEED_HEX = 'ab'.repeat(64); // a 64-byte BIP39 HD seed
const RAW_HEX = 'cd'.repeat(32); // a 32-byte btq-core raw seed
const ENTROPY_12 = '0f'.repeat(16);
const ENTROPY_24 = '1e'.repeat(32);

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** Every rejection is the one non-oracle failure — no field is ever named. */
function expectRefused(value: unknown, label: string): void {
  let thrown: unknown;
  try {
    decodePayload(bytes(value));
  } catch (e) {
    thrown = e;
  }
  expect(thrown, label).toBeInstanceOf(WalletError);
  expect((thrown as WalletError).code, label).toBe('NOT_A_VAULT');
  expect((thrown as WalletError).message, label).toBe('Not a BTQ vault.');
}

/** The other refusal: ours, intact, and older than this build. */
function expectTooOld(value: unknown, label: string): void {
  let thrown: unknown;
  try {
    decodePayload(bytes(value));
  } catch (e) {
    thrown = e;
  }
  expect(thrown, label).toBeInstanceOf(WalletError);
  expect((thrown as WalletError).code, label).toBe('VAULT_TOO_OLD');
  expect((thrown as WalletError).message, label).toBe(OLD_VAULT_MESSAGE);
  // Whatever else it says, it must not read as damage.
  expect((thrown as WalletError).message, label).not.toBe('Not a BTQ vault.');
}

describe('a payload from the pre-2 build is refused as old, not as corrupt', () => {
  it('the version this build writes is 2, and it is not 1', () => {
    // Pinned, because the tempting cleanup is to renumber the only surviving
    // version to 1 — after which one of the old blobs below would decode as a
    // current payload instead of being refused. That is the one dangerous
    // outcome in this file.
    expect(VAULT_PAYLOAD_VERSION).toBe(2);
    expect(encodePayload({ v: 2, network: 'testnet', origin: 'raw32', hdSeedHex: RAW_HEX })).toEqual(
      bytes({ v: 2, network: 'testnet', origin: 'raw32', hdSeedHex: RAW_HEX }),
    );
  });

  it('refuses a v1 bip39 payload with the actionable message', () => {
    // Exactly the bytes the old build wrote for a wallet imported from a
    // phrase: no entropy field anywhere, because the field did not exist.
    expectTooOld({ v: 1, network: 'testnet', origin: 'bip39', hdSeedHex: SEED_HEX }, 'v1 bip39');
  });

  it('refuses a v1 raw32 payload the same way', () => {
    expectTooOld({ v: 1, network: 'testnet', origin: 'raw32', hdSeedHex: RAW_HEX }, 'v1 raw32');
  });

  it('the message tells the user what to do, and does not promise a hex round trip', () => {
    // The one route back is the phrase or the raw seed on the import screen.
    // There is deliberately no "export it first": a phrase-derived seed is 128
    // hex characters and `parseRawSeedHex` refuses those (tests/unit/mnemonic).
    expect(OLD_VAULT_MESSAGE).toMatch(/older build/i);
    expect(OLD_VAULT_MESSAGE).toMatch(/remove it/i);
    expect(OLD_VAULT_MESSAGE).toMatch(/import your recovery phrase/i);
    expect(OLD_VAULT_MESSAGE).toMatch(/64 bytes/);
  });

  it('an unknown field does not turn an old payload into a corrupt one', () => {
    expectTooOld(
      { v: 1, network: 'testnet', origin: 'bip39', hdSeedHex: SEED_HEX, note: 'hello' },
      'v1 + unknown field',
    );
  });

  it('a v1 payload carrying entropy is not one of ours at all', () => {
    // v1 predates the entropy field, so a v1 payload holding one was
    // hand-edited or written by something that is not this wallet. "Your
    // wallet is old, remove it" is the wrong thing to say about that blob.
    expectRefused(
      { v: 1, network: 'testnet', origin: 'bip39', hdSeedHex: SEED_HEX, entropyHex: ENTROPY_12 },
      'v1+entropy',
    );
  });

  it('a v1 payload with any field broken is corruption, not age', () => {
    // The separation that keeps the message honest: "remove this wallet" must
    // never be said about a blob that is merely damaged.
    expectRefused({ v: 1, network: 'bitcoin', origin: 'bip39', hdSeedHex: SEED_HEX }, 'v1 bad network');
    expectRefused({ v: 1, network: 'testnet', origin: 'ledger', hdSeedHex: SEED_HEX }, 'v1 bad origin');
    expectRefused({ v: 1, network: 'testnet', origin: 'bip39', hdSeedHex: 'abc' }, 'v1 odd-length seed');
    expectRefused({ v: 1, network: 'testnet', origin: 'bip39', hdSeedHex: 'ZZ'.repeat(32) }, 'v1 non-hex seed');
    expectRefused({ v: 1, network: 'testnet', origin: 'bip39' }, 'v1 no seed');
    expectRefused({ v: 1 }, 'v1 alone');
  });

  it('no other version is ever called old', () => {
    // Only 1 was ever written. A 0, a 3 or a "1" is a blob from somewhere else.
    for (const v of [0, 3, 1.5, -1, '1', true, null]) {
      expectRefused({ v, network: 'testnet', origin: 'raw32', hdSeedHex: RAW_HEX }, `v=${String(v)}`);
    }
  });
});

describe('vault payload v2 carries BIP39 entropy, or nothing', () => {
  it('round-trips a 12-word entropy', () => {
    const payload: VaultPayload = {
      v: 2,
      network: 'testnet',
      origin: 'bip39',
      hdSeedHex: SEED_HEX,
      entropyHex: ENTROPY_12,
    };
    expect(decodePayload(encodePayload(payload))).toEqual(payload);
  });

  it('round-trips a 24-word entropy', () => {
    const payload: VaultPayload = {
      v: 2,
      network: 'testnet',
      origin: 'bip39',
      hdSeedHex: SEED_HEX,
      entropyHex: ENTROPY_24,
    };
    expect(decodePayload(encodePayload(payload))).toEqual(payload);
  });

  it('refuses a bip39 payload that carries no entropy', () => {
    // `origin` and `entropyHex` are two spellings of one fact and the decoder
    // holds them together. Accepting this shape would reintroduce the wallet
    // that says it came from a phrase and cannot show one — the third state
    // this build does not have. Nothing writes it: `seal()` passes the entropy
    // on both bip39 paths, so a payload like this is a writer that regressed.
    expectRefused({ v: 2, network: 'testnet', origin: 'bip39', hdSeedHex: SEED_HEX }, 'bip39 without entropy');
  });

  it('decodes a payload with an unknown field without carrying it', () => {
    // The return is a whitelist, and that is load-bearing in both directions: a
    // field a future build adds must not travel into the keyring, and a field
    // something else wrote must not survive into a re-seal.
    const decoded = decodePayload(
      bytes({
        v: 2,
        network: 'testnet',
        origin: 'bip39',
        hdSeedHex: SEED_HEX,
        entropyHex: ENTROPY_12,
        note: 'hello',
        entropyHexish: 'ff',
      }),
    );
    expect(decoded).toEqual({
      v: 2,
      network: 'testnet',
      origin: 'bip39',
      hdSeedHex: SEED_HEX,
      entropyHex: ENTROPY_12,
    });
    expect(Object.keys(decoded).sort()).toEqual(['entropyHex', 'hdSeedHex', 'network', 'origin', 'v']);
  });

  it('round-trips a v2 raw32 payload with no entropy', () => {
    const payload: VaultPayload = { v: 2, network: 'testnet', origin: 'raw32', hdSeedHex: RAW_HEX };
    expect(decodePayload(encodePayload(payload))).toEqual(payload);
  });

  it('encodePayload omits an absent entropy rather than writing null', () => {
    const json = new TextDecoder().decode(
      encodePayload({ v: 2, network: 'testnet', origin: 'raw32', hdSeedHex: RAW_HEX }),
    );
    expect(json).not.toContain('entropyHex');
    expect(json).not.toContain('null');
  });

  it('refuses entropy on a raw32 payload', () => {
    // A raw 32-byte HD seed has no phrase. Entropy alongside one would let the
    // reveal hand back words for a *different* wallet — a fake backup.
    expectRefused({ v: 2, network: 'testnet', origin: 'raw32', hdSeedHex: RAW_HEX, entropyHex: ENTROPY_12 }, 'raw32+entropy');
  });

  it('refuses an entropy that is not 16 or 32 bytes', () => {
    for (const hex of ['', '00', '0f'.repeat(15), '0f'.repeat(17), '1e'.repeat(31), '1e'.repeat(33), '1e'.repeat(64)]) {
      expectRefused(
        { v: 2, network: 'testnet', origin: 'bip39', hdSeedHex: SEED_HEX, entropyHex: hex },
        `entropy ${hex.length} hex chars`,
      );
    }
  });

  it('refuses entropy that is not lowercase hex', () => {
    for (const hex of [ENTROPY_12.toUpperCase(), '0F'.repeat(16), 'zz'.repeat(16), '0x' + '0f'.repeat(15)]) {
      expectRefused({ v: 2, network: 'testnet', origin: 'bip39', hdSeedHex: SEED_HEX, entropyHex: hex }, hex);
    }
  });

  it('refuses a null, numeric or array entropy', () => {
    // `entropyHex: null` is the shape a seal that spread `entropyHex: undefined`
    // through JSON.stringify would *not* produce — and the shape one that built
    // the field unconditionally would. Catching it here catches that bug.
    for (const value of [null, 0, 16, true, ['0f'], { hex: ENTROPY_12 }]) {
      expectRefused({ v: 2, network: 'testnet', origin: 'bip39', hdSeedHex: SEED_HEX, entropyHex: value }, String(value));
    }
  });
});

describe('anything that is not one of our payloads is refused identically', () => {
  // Each of these is an otherwise-complete payload with one field broken, so
  // the refusal it draws is the one this case is about and not a side effect of
  // some other missing field.
  it('refuses an unknown version', () => {
    for (const v of [0, 3, 1.5, -1, '1', '2', null, true]) {
      expectRefused(
        { v, network: 'testnet', origin: 'bip39', hdSeedHex: SEED_HEX, entropyHex: ENTROPY_12 },
        `v=${String(v)}`,
      );
    }
  });

  it('refuses a missing or unknown network', () => {
    for (const network of [undefined, 'bitcoin', 'Testnet', 42, null]) {
      expectRefused(
        { v: 2, network, origin: 'bip39', hdSeedHex: SEED_HEX, entropyHex: ENTROPY_12 },
        String(network),
      );
    }
  });

  it('refuses a missing or unknown origin', () => {
    for (const origin of [undefined, 'ledger', 'BIP39', 7, null]) {
      expectRefused(
        { v: 2, network: 'testnet', origin, hdSeedHex: SEED_HEX, entropyHex: ENTROPY_12 },
        String(origin),
      );
    }
  });

  it('refuses a seed that is not even-length lowercase hex', () => {
    for (const hdSeedHex of [undefined, '', 'abc', 'AB'.repeat(32), 'zz'.repeat(32), 42, null]) {
      expectRefused(
        { v: 2, network: 'testnet', origin: 'bip39', hdSeedHex, entropyHex: ENTROPY_12 },
        String(hdSeedHex),
      );
    }
  });

  it('refuses non-JSON, arrays, null and scalars', () => {
    let thrown: unknown;
    try {
      decodePayload(new TextEncoder().encode('not json at all'));
    } catch (e) {
      thrown = e;
    }
    expect((thrown as WalletError).code).toBe('NOT_A_VAULT');
    expect((thrown as WalletError).message).toBe('Not a BTQ vault.');
    for (const value of [null, [], [{ v: 2 }], 'v2', 5, true]) {
      expectRefused(value, JSON.stringify(value));
    }
  });
});
