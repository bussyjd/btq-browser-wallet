import { describe, it, expect } from 'vitest';
import { parseAddressResponse, parseTipResponse } from '../../src/core/explorer/schema.js';

const ADDR = 'tbtq1zek5r5xh6e52qny5vj6xd6usdpur6x9qt6yxuzddgnekdnwfxwcvqz7qmm2';

/** Fastify's 404 body when the base URL or path is wrong. */
const ROUTE_MISS = { message: 'Route GET:/api/v1/address/x not found', error: 'Not Found', statusCode: 404 };

describe('explorer address schema', () => {
  it('treats the indexer 404 "Address not found" as unused, not invalid', () => {
    expect(parseAddressResponse(404, { error: 'Address not found' }, ADDR).used).toBe(false);
    expect(parseAddressResponse(200, { error: 'Address not found' }, ADDR).used).toBe(false);
  });

  it('a route-miss 404 is EXPLORER_UNAVAILABLE, never "unused"', () => {
    // User loss: point the wallet at the wrong host and every derived address
    // looks unused — a funded, restorable wallet renders as brand new and empty.
    expect(() => parseAddressResponse(404, ROUTE_MISS, ADDR)).toThrow(/HTTP 404/);
    expect(() => parseAddressResponse(404, undefined, ADDR)).toThrow(/HTTP 404/);
    expect(() => parseAddressResponse(404, '<html>Not Found</html>', ADDR)).toThrow(/HTTP 404/);
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
    expect(r.reportedBalanceSats).toBe(371047638925n);
  });

  it('the negative balance the live indexer reports is display-only, not an error', () => {
    // The recorded live record for this address reads balance "-266828024798707"
    // while /utxos lists 91 real unspents (tests/fixtures/explorer/address-used.json).
    const r = parseAddressResponse(200, { address: ADDR, tx_count: 1397, balance: '-266828024798707' }, ADDR);
    expect(r.used).toBe(true);
    expect(r.reportedBalanceSats).toBe(0n);
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

describe('explorer tip schema', () => {
  it('parses a live tip', () => {
    expect(
      parseTipResponse(200, {
        hash: '00000000035a0298ff41786f60a01995a7ff290b5d80f067b758a494eb470489',
        height: 300741,
      }),
    ).toEqual({ hash: '00000000035a0298ff41786f60a01995a7ff290b5d80f067b758a494eb470489', height: 300741 });
  });

  it('refuses a tip without a real height or hash', () => {
    // User loss: a fabricated tip drives the confirmation count, so a payment
    // with zero confirmations could be shown as deeply confirmed.
    expect(() => parseTipResponse(200, { height: 1 })).toThrow(/Unexpected explorer response/);
    expect(() => parseTipResponse(200, { hash: 'zz', height: 1 })).toThrow(/Unexpected explorer response/);
    expect(() => parseTipResponse(503, {})).toThrow(/HTTP 503/);
  });
});
