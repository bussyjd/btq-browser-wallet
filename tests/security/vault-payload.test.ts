/**
 * The decoder that stands between a decrypted blob and the keyring.
 *
 * Everything here is *inside* the AES-GCM envelope, so nothing an attacker can
 * write reaches this code — which is exactly why it is allowed to be strict:
 * anything malformed is our own bug, and rounding it off (a bad `entropyHex`
 * silently becoming "no phrase") would hide the bug behind a wallet that just
 * stops offering the reveal. Every refusal is the same non-oracle message.
 */
import { describe, it, expect } from 'vitest';
import { decodePayload, encodePayload, type VaultPayload } from '../../src/core/vault/payload.js';
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

describe('vault payload v1 stays readable', () => {
  it('round-trips a v1 bip39 payload', () => {
    const payload: VaultPayload = { v: 1, network: 'testnet', origin: 'bip39', hdSeedHex: SEED_HEX };
    expect(decodePayload(encodePayload(payload))).toEqual(payload);
  });

  it('round-trips a v1 raw32 payload', () => {
    const payload: VaultPayload = { v: 1, network: 'testnet', origin: 'raw32', hdSeedHex: RAW_HEX };
    expect(decodePayload(encodePayload(payload))).toEqual(payload);
  });

  it('decodes a v1 payload with an unknown field without carrying it', () => {
    // The return is a whitelist, and that is now load-bearing: a field a future
    // build adds must not travel into the keyring on an old vault, and a field
    // an old build wrote must not survive into a re-seal.
    const decoded = decodePayload(
      bytes({ v: 1, network: 'testnet', origin: 'bip39', hdSeedHex: SEED_HEX, note: 'hello', entropyHexish: 'ff' }),
    );
    expect(decoded).toEqual({ v: 1, network: 'testnet', origin: 'bip39', hdSeedHex: SEED_HEX });
    expect(Object.keys(decoded).sort()).toEqual(['hdSeedHex', 'network', 'origin', 'v']);
  });

  it('refuses entropy on a v1 payload', () => {
    // v1 predates the reveal. Entropy in one means somebody hand-edited a
    // payload or a writer regressed; either way it is not a vault we wrote.
    expectRefused({ v: 1, network: 'testnet', origin: 'bip39', hdSeedHex: SEED_HEX, entropyHex: ENTROPY_12 }, 'v1+entropy');
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

  it('round-trips a v2 bip39 payload with no entropy at all', () => {
    const payload: VaultPayload = { v: 2, network: 'testnet', origin: 'bip39', hdSeedHex: SEED_HEX };
    const decoded = decodePayload(encodePayload(payload));
    expect(decoded).toEqual(payload);
    expect('entropyHex' in decoded).toBe(false);
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
  it('refuses an unknown version', () => {
    for (const v of [0, 3, 1.5, -1, '1', '2', null, true]) {
      expectRefused({ v, network: 'testnet', origin: 'bip39', hdSeedHex: SEED_HEX }, `v=${String(v)}`);
    }
  });

  it('refuses a missing or unknown network', () => {
    for (const network of [undefined, 'bitcoin', 'Testnet', 42, null]) {
      expectRefused({ v: 2, network, origin: 'bip39', hdSeedHex: SEED_HEX }, String(network));
    }
  });

  it('refuses a missing or unknown origin', () => {
    for (const origin of [undefined, 'ledger', 'BIP39', 7, null]) {
      expectRefused({ v: 2, network: 'testnet', origin, hdSeedHex: SEED_HEX }, String(origin));
    }
  });

  it('refuses a seed that is not even-length lowercase hex', () => {
    for (const hdSeedHex of [undefined, '', 'abc', 'AB'.repeat(32), 'zz'.repeat(32), 42, null]) {
      expectRefused({ v: 2, network: 'testnet', origin: 'bip39', hdSeedHex }, String(hdSeedHex));
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
