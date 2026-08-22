/**
 * Drives the recorded live explorer responses (tests/fixtures/explorer/*.json,
 * captured 2026-08-21) through the real parsers *and* through the real HTTP
 * client in src/background/explorer.ts with an injected fetch. If the live wire
 * format moves, or our client stops paging, these fail.
 */
import { describe, it, expect } from 'vitest';
import { explorerHistory, explorerLookup, explorerTip, explorerUtxos, PAGE_LIMIT } from '../../src/background/explorer.js';
import { scriptForAddress } from '../../src/core/script/address.js';
import { bytesToHex } from '../../src/core/util/hex.js';
import { fakeFetch } from '../helpers/fake-fetch.js';
import vectors from '../vectors/golden.json' with { type: 'json' };

import addressUsed from '../fixtures/explorer/address-used.json' with { type: 'json' };
import addressUnused from '../fixtures/explorer/address-unused.json' with { type: 'json' };
import addressUnusedUtxos from '../fixtures/explorer/address-unused-utxos.json' with { type: 'json' };
import addressUnusedTxs from '../fixtures/explorer/address-unused-txs.json' with { type: 'json' };
import addressUtxos from '../fixtures/explorer/address-utxos.json' with { type: 'json' };
import addressTxs from '../fixtures/explorer/address-txs-page1.json' with { type: 'json' };
import blocksTip from '../fixtures/explorer/blocks-tip.json' with { type: 'json' };

const BASE = 'https://explorer.example';
const USED = addressUsed.body.address;
/** A real derived address that has never been seen on-chain. */
const UNUSED = vectors.entries[3]!.addresses.testnet;
const ROUTE_MISS = {
  status: 404,
  body: { message: 'Route GET:/api/v1/address/x not found', error: 'Not Found', statusCode: 404 },
};

describe('recorded explorer fixtures through the shipped client', () => {
  it('a used address is used; its untrustworthy negative balance is not the wallet balance', () => {
    // The recorded record reads balance "-266828024798707" and
    // unspent_count -224 while /utxos lists real coins. Reading the header
    // balance from this field renders a funded wallet as empty.
    expect(addressUsed.body.balance.startsWith('-')).toBe(true);
    expect(addressUsed.body.unspent_count).toBeLessThan(0);
  });

  it('explorerLookup reports used / unused from the live bodies', async () => {
    const { fetch } = fakeFetch((url) => {
      if (url.pathname === `/api/v1/address/${USED}`) return addressUsed;
      if (url.pathname === `/api/v1/address/${UNUSED}`) return addressUnused;
      return undefined;
    });
    const lookup = explorerLookup(BASE, fetch);
    const used = await lookup(USED);
    expect(used.used).toBe(true);
    expect(used.txCount).toBe(1397);
    expect(used.reportedBalanceSats).toBe(0n); // negative is clamped for display only
    expect((await lookup(UNUSED)).used).toBe(false);
  });

  it('a route-miss 404 fails the lookup instead of reporting an empty wallet', async () => {
    // User loss: a typo'd explorer URL would otherwise make every address look
    // unused, so a restored wallet shows no funds and no history.
    const { fetch } = fakeFetch(() => ROUTE_MISS);
    await expect(explorerLookup(BASE, fetch)(USED)).rejects.toThrow(/HTTP 404/);
    await expect(explorerUtxos(BASE, fetch)(USED)).rejects.toThrow(/HTTP 404/);
    await expect(explorerHistory(BASE, fetch)(USED)).rejects.toThrow(/HTTP 404/);
  });

  it('a non-JSON 404 is also a failure, never "unused"', async () => {
    const { fetch } = fakeFetch(() => ({ status: 404, body: undefined }));
    await expect(explorerLookup(BASE, fetch)(USED)).rejects.toThrow(/HTTP 404/);
  });

  it('explorerUtxos parses the recorded rows and matches the derived script', async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url.pathname === `/api/v1/address/${USED}/utxos` ? addressUtxos : undefined,
    );
    const rows = await explorerUtxos(BASE, fetch)(USED);
    expect(rows).toHaveLength(3);
    expect(bytesToHex(rows[0]!.script)).toBe(bytesToHex(scriptForAddress(USED, 'testnet')));
    expect(rows[0]!.value).toBe(178_864_075_180n);
    expect(rows[0]!.blockHeight).toBe(300741);
    // Paging uses offset/limit, which is what this explorer honours.
    expect(calls[0]!.url).toContain(`offset=0&limit=${PAGE_LIMIT}`);
    expect(calls).toHaveLength(1); // a short page ends the walk
  });

  it('explorerUtxos keeps paging until a short page (a full first page is not the end)', async () => {
    // User loss: stopping at page 1 under-reports the balance, so a legitimate
    // send is refused with "not enough balance" while the coins are right there.
    const script = { type: 'Buffer', data: Array.from(scriptForAddress(USED, 'testnet')) };
    const page = (n: number, count: number) => ({
      status: 200,
      body: {
        items: Array.from({ length: count }, (_, i) => ({
          txid: (n * 1000 + i).toString(16).padStart(64, '0'),
          vout: 0,
          block_height: 300000 + i,
          value: '1000',
          script_pub_key: script,
          script_type: 'witness_v2_p2mr',
          spent_txid: null,
        })),
      },
    });
    const { fetch, calls } = fakeFetch((url) => {
      const offset = Number(url.searchParams.get('offset'));
      if (offset === 0) return page(0, PAGE_LIMIT);
      if (offset === PAGE_LIMIT) return page(1, 7);
      return undefined;
    });
    const rows = await explorerUtxos(BASE, fetch)(USED);
    expect(rows).toHaveLength(PAGE_LIMIT + 7);
    expect(calls).toHaveLength(2);
  });

  it('an explorer that ignores offset cannot make the UTXO walk loop or double-count', async () => {
    const script = { type: 'Buffer', data: Array.from(scriptForAddress(USED, 'testnet')) };
    const same = {
      status: 200,
      body: {
        items: Array.from({ length: PAGE_LIMIT }, (_, i) => ({
          txid: i.toString(16).padStart(64, '0'),
          vout: 0,
          block_height: 1,
          value: '1000',
          script_pub_key: script,
          script_type: 'witness_v2_p2mr',
        })),
      },
    };
    const { fetch, calls } = fakeFetch(() => same);
    const rows = await explorerUtxos(BASE, fetch)(USED);
    expect(rows).toHaveLength(PAGE_LIMIT); // de-duplicated by outpoint
    expect(calls.length).toBeLessThanOrEqual(20); // and bounded
  });

  it('explorerHistory reads the recorded page and stops on a short page', async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url.pathname === `/api/v1/address/${USED}/txs` ? addressTxs : undefined,
    );
    const rows = await explorerHistory(BASE, fetch)(USED);
    expect(rows).toHaveLength(5);
    expect(rows[0]!.blockHeight).toBe(300741);
    expect(rows[0]!.status).toBe('confirmed');
    expect(rows[0]!.valueChange).toBe(178_864_075_180n);
    expect(calls[0]!.url).toContain(`page=1&limit=${PAGE_LIMIT}`);
    expect(calls).toHaveLength(1);
  });

  it('explorerHistory pages past the first 100 rows using `total`', async () => {
    // User loss: the live default is 25 rows and the cap is 100, so page 1 only
    // is a truncated ledger — old payments simply vanish from history.
    const page = (n: number, count: number) => ({
      status: 200,
      body: {
        items: Array.from({ length: count }, (_, i) => ({
          address: USED,
          txid: (n * 1000 + i).toString(16).padStart(64, '0'),
          block_height: 300000 + i,
          tx_index: i,
          value_change: '1000',
        })),
        total: 150,
        page: n,
        limit: PAGE_LIMIT,
      },
    });
    const { fetch, calls } = fakeFetch((url) => {
      const n = Number(url.searchParams.get('page'));
      return n === 1 ? page(1, PAGE_LIMIT) : n === 2 ? page(2, 50) : undefined;
    });
    const rows = await explorerHistory(BASE, fetch)(USED);
    expect(rows).toHaveLength(150);
    expect(calls).toHaveLength(2);
  });

  it('a mempool history row (block_height null) is pending', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 200,
      body: {
        items: [{ address: USED, txid: 'aa'.repeat(32), block_height: null, tx_index: 0, value_change: '-2500' }],
        total: 1,
        page: 1,
        limit: PAGE_LIMIT,
      },
    }));
    const rows = await explorerHistory(BASE, fetch)(USED);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.blockHeight).toBeNull();
    expect(rows[0]!.valueChange).toBe(-2500n);
  });

  it('an unused address answers 200 with empty items on both sub-routes', async () => {
    const { fetch } = fakeFetch((url) =>
      url.pathname.endsWith('/utxos') ? addressUnusedUtxos : addressUnusedTxs,
    );
    expect(await explorerUtxos(BASE, fetch)(UNUSED)).toEqual([]);
    expect(await explorerHistory(BASE, fetch)(UNUSED)).toEqual([]);
  });

  it('explorerTip reads the recorded tip and caches it for 30 s', async () => {
    let clock = 1_000;
    const { fetch, calls } = fakeFetch((url) => (url.pathname === '/api/v1/blocks/tip' ? blocksTip : undefined));
    const tip = explorerTip(BASE, fetch, () => clock);
    expect(await tip()).toEqual({ height: 300741, hash: blocksTip.body.hash });
    await tip();
    expect(calls).toHaveLength(1);
    clock += 31_000;
    await tip();
    expect(calls).toHaveLength(2);
  });

  it('retries a 5xx and succeeds when the explorer recovers', async () => {
    // User loss: one flaky response during a gap scan would otherwise abort the
    // whole refresh, or (worse, if it were swallowed) end the scan early.
    let calls = 0;
    const { fetch } = fakeFetch(() => {
      calls += 1;
      return calls < 3 ? { status: 503, body: { error: 'busy' } } : addressUsed;
    });
    expect((await explorerLookup(BASE, fetch)(USED)).used).toBe(true);
    expect(calls).toBe(3);
  });

  it('a persistent 5xx is reported, never reported as "unused"', async () => {
    const { fetch } = fakeFetch(() => ({ status: 503, body: { error: 'Address not found' } }));
    await expect(explorerLookup(BASE, fetch)(USED)).rejects.toThrow(/HTTP 503/);
  });

  it('retries a network error but never turns it into an empty result', async () => {
    // User loss: a swallowed network error reads as "no coins" and the wallet
    // reports a zero balance for money that is still there.
    let attempts = 0;
    const flaky = (async () => {
      attempts += 1;
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(explorerUtxos(BASE, flaky)(USED)).rejects.toThrow(/Could not reach the explorer/);
    expect(attempts).toBe(3);
  });
});
