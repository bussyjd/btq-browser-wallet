import { describe, it, expect } from 'vitest';
import { assertDestination } from '../../src/core/wallet/destination.js';
import { WalletError } from '../../src/core/wallet/errors.js';
import vectors from '../vectors/golden.json' with { type: 'json' };

const OK = vectors.entries[0]!.addresses.testnet;

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof WalletError ? e.code : 'NOT_A_WALLET_ERROR';
  }
  return 'NO_THROW';
}

describe('destination validation', () => {
  it('accepts a testnet P2MR address', () => {
    expect(assertDestination(OK, 'testnet').witnessVersion).toBe(2);
    expect(assertDestination(` ${OK} `, 'testnet').merkleRoot).toHaveLength(32);
  });

  it('returns the canonical lowercase encoding, never the caller\'s string', () => {
    // User loss: bech32m legally accepts an all-uppercase address, and a paste
    // picks up stray whitespace. planSend carries this field into the plan, and
    // previewFromSigned compares it against the address decoded back out of the
    // signed bytes — which encodeAddress always emits lowercase. Echoing the raw
    // string means the send is signed and *then* thrown away with "does not
    // match the approved destination", after the password has been typed.
    expect(OK).toBe(OK.toLowerCase());
    expect(assertDestination(OK, 'testnet').address).toBe(OK);
    expect(assertDestination(OK.toUpperCase(), 'testnet').address).toBe(OK);
    expect(assertDestination(`  ${OK}\n`, 'testnet').address).toBe(OK);
    expect(assertDestination(` ${OK.toUpperCase()} `, 'testnet').address).toBe(OK);
    // The merkle root is the same either way — only the string differs.
    expect(assertDestination(OK.toUpperCase(), 'testnet').merkleRoot).toEqual(
      assertDestination(OK, 'testnet').merkleRoot,
    );
  });

  it('rejects a mainnet address as WRONG_NETWORK', () => {
    // User loss: a qbtc destination would be paid on the wrong chain and the
    // coins would be unrecoverable.
    expect(codeOf(() => assertDestination(vectors.entries[0]!.addresses.mainnet, 'testnet'))).toBe('WRONG_NETWORK');
  });

  it('rejects a legacy base58 Dilithium destination with an explanation, not a library string', () => {
    // These outputs are real on the live chain (script_type dilithium_pubkeyhash,
    // base58 n…), so a payee can genuinely hand one over. "Invalid checksum"
    // would send them re-copying a perfectly correct address forever.
    const legacy = 'nSoU4Y55XduxKtGYQWaqpZ6yZEVV3Ancsu';
    expect(codeOf(() => assertDestination(legacy, 'testnet'))).toBe('LEGACY_DILITHIUM');
    expect(() => assertDestination(legacy, 'testnet')).toThrow(/tbtq1z/);
    expect(() => assertDestination(legacy, 'testnet')).toThrow(/legacy Dilithium/i);
  });

  it('rejects the legacy tdbt bech32 namespace', () => {
    const tdbt = 'tdbt1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    expect(codeOf(() => assertDestination(tdbt, 'testnet'))).toBe('LEGACY_DILITHIUM');
    expect(() => assertDestination(tdbt, 'testnet')).toThrow(/tdbt/);
  });

  it('names Bitcoin addresses as the wrong chain rather than a checksum problem', () => {
    for (const btc of [
      'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
    ]) {
      expect(codeOf(() => assertDestination(btc, 'testnet')), btc).toBe('WRONG_NETWORK');
      expect(() => assertDestination(btc, 'testnet')).toThrow(/BTQ/);
    }
  });

  it('a typo reads as a typo, and no bech32 library text leaks through', () => {
    const typo = OK.slice(0, -1) + (OK.endsWith('q') ? 'p' : 'q');
    expect(codeOf(() => assertDestination(typo, 'testnet'))).toBe('BAD_ADDRESS');
    expect(() => assertDestination(typo, 'testnet')).toThrow(/checksum/);
    expect(() => assertDestination(typo, 'testnet')).not.toThrow(/Invalid checksum in/);
  });

  it('an empty or shapeless string asks for a tbtq1z address', () => {
    expect(() => assertDestination('', 'testnet')).toThrow(/tbtq1z/);
    expect(() => assertDestination('   ', 'testnet')).toThrow(/tbtq1z/);
    expect(() => assertDestination('notanaddress', 'testnet')).toThrow(/tbtq1z/);
  });
});
