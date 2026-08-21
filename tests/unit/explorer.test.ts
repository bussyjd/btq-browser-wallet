import { describe, it, expect } from 'vitest';
import { parseAddressResponse } from '../../src/core/explorer/schema.js';

const ADDR = 'tbtq1zek5r5xh6e52qny5vj6xd6usdpur6x9qt6yxuzddgnekdnwfxwcvqz7qmm2';

describe('explorer address schema', () => {
  it('treats 404 and Address not found as unused, not invalid', () => {
    expect(parseAddressResponse(404, undefined, ADDR).used).toBe(false);
    expect(parseAddressResponse(200, { error: 'Address not found' }, ADDR).used).toBe(false);
  });

  it('parses a live-shaped used address', () => {
    const r = parseAddressResponse(
      200,
      {
        address: ADDR,
        script_type: 'witness_v2_p2mr',
        tx_count: 3,
        balance: '371047638925',
        isDilithium: true,
      },
      ADDR,
    );
    expect(r.used).toBe(true);
    expect(r.balanceSats).toBe(371047638925n);
  });

  it('refuses an explorer address that does not match what we asked for', () => {
    // Attacker gain: a compromised explorer swapping in a lookalike address
    // must not become the address we later sign for.
    expect(() =>
      parseAddressResponse(
        200,
        { address: 'tbtq1zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', tx_count: 1, balance: '1' },
        ADDR,
      ),
    ).toThrow(/does not match/);
  });

  it('does not treat HTTP 500 as unused', () => {
    expect(() => parseAddressResponse(500, { error: 'boom' }, ADDR)).toThrow(/HTTP 500/);
  });

  it('a failing explorer that says Address not found is not unused', () => {
    // Attacker gain: 20 consecutive "unused" answers during restore hide the
    // real gap and the wallet reports a zero balance for funds that still exist.
    expect(() => parseAddressResponse(500, { error: 'Address not found' }, ADDR)).toThrow(/HTTP 500/);
    expect(() => parseAddressResponse(502, { error: 'Address not found' }, ADDR)).toThrow(/HTTP 502/);
    expect(() => parseAddressResponse(0, { error: 'Address not found' }, ADDR)).toThrow(/HTTP 0/);
  });

  it('a used row that omits address is rejected', () => {
    // Attacker gain: a compromised explorer could attach another account's
    // balance to our derived address without an address field to trip the match.
    expect(() => parseAddressResponse(200, { tx_count: 1, balance: '1000' }, ADDR)).toThrow(/does not match/);
  });

  it('garbage payloads are failures, not unused', () => {
    const garbage = [null, undefined, [], 'unused', 1, { tx_count: '1' }, { tx_count: 1.5 }, { tx_count: -1 }];
    for (const json of garbage) {
      expect(() => parseAddressResponse(200, json, ADDR), JSON.stringify(json)).toThrow(/Unexpected explorer response/);
    }
  });
});
