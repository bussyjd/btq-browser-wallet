import { describe, it, expect } from 'vitest';
import { parseUtxoResponse } from '../../src/core/explorer/utxo.js';
import { parseHistoryPage, parseHistoryResponse } from '../../src/core/explorer/history.js';
import { parseBroadcastResponse } from '../../src/core/explorer/broadcast.js';
import { MAX_MONEY } from '../../src/core/explorer/parse.js';
import { hexToBytes } from '../../src/core/util/hex.js';
import { u32le, u64le } from '../../src/core/tx/serialize.js';
import { BroadcastError } from '../../src/core/wallet/errors.js';
import vectors from '../vectors/golden.json' with { type: 'json' };

const ADDR = vectors.entries[0]!.addresses.testnet;
const SCRIPT = hexToBytes(vectors.entries[0]!.scriptPubKey);
const ROUTE_MISS = { message: 'Route GET:/api/v1/address/x/utxos not found', error: 'Not Found', statusCode: 404 };

describe('explorer UTXO/history/broadcast parsers (shipped)', () => {
  it('treats the indexer "Address not found" body as empty, not spendable', () => {
    expect(parseUtxoResponse(404, { error: 'Address not found' }, ADDR, SCRIPT)).toEqual([]);
    expect(parseUtxoResponse(200, { error: 'Address not found' }, ADDR, SCRIPT)).toEqual([]);
    expect(parseHistoryResponse(404, { error: 'Address not found' }, ADDR)).toEqual([]);
  });

  it('a route-miss 404 on /utxos or /txs is a failure, not an empty wallet', () => {
    // User loss: a wrong explorer URL would report every address as having no
    // coins, so the balance reads 0 and every send fails with "no coins".
    expect(() => parseUtxoResponse(404, ROUTE_MISS, ADDR, SCRIPT)).toThrow(/HTTP 404/);
    expect(() => parseUtxoResponse(404, undefined, ADDR, SCRIPT)).toThrow(/HTTP 404/);
    expect(() => parseHistoryResponse(404, ROUTE_MISS, ADDR)).toThrow(/HTTP 404/);
  });

  it('HTTP 5xx does not count as unused/spendable', () => {
    expect(() => parseUtxoResponse(500, { error: 'Address not found' }, ADDR, SCRIPT)).toThrow(/HTTP 500/);
    expect(() => parseHistoryResponse(503, { items: [] }, ADDR)).toThrow(/HTTP 503/);
  });

  it('rejects a UTXO whose script does not match the derived script', () => {
    expect(() =>
      parseUtxoResponse(
        200,
        {
          items: [
            {
              txid: '11'.repeat(32),
              vout: 0,
              value: '1000',
              script_pub_key: { type: 'Buffer', data: Array(34).fill(0) },
              script_type: 'witness_v2_p2mr',
            },
          ],
        },
        ADDR,
        SCRIPT,
      ),
    ).toThrow(/scriptPubKey/);
  });

  it('rejects a history row whose address does not match', () => {
    expect(() =>
      parseHistoryResponse(
        200,
        { items: [{ address: 'tbtq1zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', txid: '11'.repeat(32), value_change: '1', block_height: 1 }] },
        ADDR,
      ),
    ).toThrow(/does not match/);
  });

  it('parses a live-shaped UTXO after the script matches, keeping block height', () => {
    const data = Array.from(SCRIPT);
    const rows = parseUtxoResponse(
      200,
      {
        items: [
          {
            txid: 'aa'.repeat(32),
            vout: 1,
            value: '500000000',
            block_height: 300741,
            script_pub_key: { type: 'Buffer', data },
            script_type: 'witness_v2_p2mr',
            spent_txid: null,
          },
        ],
      },
      ADDR,
      SCRIPT,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(500000000n);
    expect(rows[0]!.vout).toBe(1);
    expect(rows[0]!.blockHeight).toBe(300741);
  });

  it('a mempool UTXO keeps blockHeight null so it can be told from a confirmed coin', () => {
    // User loss: spending an unconfirmed coin without knowing it is
    // unconfirmed makes the new transaction die with its unconfirmed parent.
    const data = Array.from(SCRIPT);
    const rows = parseUtxoResponse(
      200,
      {
        items: [
          {
            txid: 'bb'.repeat(32),
            vout: 0,
            value: '1000',
            block_height: null,
            script_pub_key: { type: 'Buffer', data },
            script_type: 'witness_v2_p2mr',
          },
        ],
      },
      ADDR,
      SCRIPT,
    );
    expect(rows[0]!.blockHeight).toBeNull();
  });

  it('a mempool history row is pending, a mined one is confirmed', () => {
    const page = parseHistoryPage(
      200,
      {
        items: [
          { address: ADDR, txid: 'aa'.repeat(32), block_height: null, value_change: '-1000' },
          { address: ADDR, txid: 'bb'.repeat(32), block_height: 300741, value_change: '500600000' },
        ],
        total: 2,
        page: 1,
        limit: 100,
      },
      ADDR,
    );
    expect(page.items.map((i) => i.status)).toEqual(['pending', 'confirmed']);
    expect(page.items[0]!.blockHeight).toBeNull();
    expect(page.items[0]!.valueChange).toBe(-1000n);
    expect(page.total).toBe(2);
  });

  it('broadcast 404 is a failure tagged to the explorer, not a txid', () => {
    // User loss: a 404 read as success marks the payment "pending" forever
    // while the payee never sees it and the hex is thrown away.
    const attempt = () => parseBroadcastResponse(404, { message: 'Route POST:/api/v1/tx/send not found' });
    expect(attempt).toThrow(/no broadcast route/);
    try {
      attempt();
    } catch (e) {
      expect(e).toBeInstanceOf(BroadcastError);
      expect((e as BroadcastError).via).toBe('explorer');
      expect((e as BroadcastError).noRoute).toBe(true);
    }
  });

  it('rejects a UTXO whose address does not match the derived address', () => {
    // Attacker gain: a compromised explorer swapping in another account's
    // outpoint must not become an input we later put in a sighash.
    const data = Array.from(SCRIPT);
    expect(() =>
      parseUtxoResponse(
        200,
        {
          items: [
            {
              address: 'tbtq1zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
              txid: 'aa'.repeat(32),
              vout: 0,
              value: '1000',
              script_pub_key: { type: 'Buffer', data },
              script_type: 'witness_v2_p2mr',
            },
          ],
        },
        ADDR,
        SCRIPT,
      ),
    ).toThrow(/does not match/);
  });

  it('rejects a UTXO value that cannot appear on the wire as a satoshi amount', () => {
    // Attacker gain: an amount outside MoneyRange / uint64 would wrap in the
    // 8-byte sighash field so the signed bytes commit to a different value
    // than coinselect used.
    const data = Array.from(SCRIPT);
    const row = (value: unknown, vout = 0) => ({
      items: [
        {
          txid: 'aa'.repeat(32),
          vout,
          value,
          script_pub_key: { type: 'Buffer', data },
          script_type: 'witness_v2_p2mr',
        },
      ],
    });
    expect(() => parseUtxoResponse(200, row((MAX_MONEY + 1n).toString()), ADDR, SCRIPT)).toThrow(
      /Unexpected explorer response/,
    );
    expect(() => parseUtxoResponse(200, row((1n << 64n).toString()), ADDR, SCRIPT)).toThrow(
      /Unexpected explorer response/,
    );
    expect(() => parseUtxoResponse(200, row(Number.MAX_SAFE_INTEGER + 1), ADDR, SCRIPT)).toThrow(
      /Unexpected explorer response/,
    );
    expect(() => parseUtxoResponse(200, row('1000', 2 ** 32), ADDR, SCRIPT)).toThrow(/Unexpected explorer response/);
    expect(() => u32le(2 ** 32)).toThrow(/uint32/);
    expect(() => u64le(1n << 64n)).toThrow(/uint64/);
    expect((2 ** 32) >>> 0).toBe(0);
  });
});
