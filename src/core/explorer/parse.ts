import { WalletError } from '../wallet/errors.js';
import { hexToBytes } from '../util/hex.js';
import { bytesEqual } from '../util/bytes.js';

/** btq-core src/consensus/amount.h:26 — MAX_MONEY = 21000000 * COIN. */
export const MAX_MONEY = 21_000_000n * 100_000_000n;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseSats(v: unknown): bigint {
  const n = parseSignedSats(v);
  if (n < 0n || n > MAX_MONEY) throw new WalletError('EXPLORER_SCHEMA', 'Unexpected explorer response.');
  return n;
}

export function parseSignedSats(v: unknown): bigint {
  // IEEE numbers above 2^53 are not exact; a hostile explorer could otherwise
  // inject a rounded amount that later wraps in the 8-byte sighash field.
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  throw new WalletError('EXPLORER_SCHEMA', 'Unexpected explorer response.');
}

/**
 * The `balance` field of `/api/v1/address/{a}`. Display-only: the live indexer
 * returns a **negative** balance (and a negative `unspent_count`) for heavily
 * used addresses — tests/fixtures/explorer/address-used.json records
 * `"balance": "-266828024798707"` for an address that has 91 real unspents.
 * Spendable balance is always the sum of `/utxos`, never this number, so a
 * negative is reported as 0 instead of being treated as a schema error.
 */
export function parseDisplayBalanceSats(v: unknown): bigint {
  const n = parseSignedSats(v);
  return n < 0n ? 0n : n;
}

export function parseTxid(v: unknown): string {
  if (typeof v !== 'string' || !/^[0-9a-f]{64}$/i.test(v)) {
    throw new WalletError('EXPLORER_SCHEMA', 'Unexpected explorer response.');
  }
  return v.toLowerCase();
}

/** A block height from the indexer, or null for a mempool row (`block_height: null`). */
export function parseBlockHeight(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isInteger(v)) return v > 0 ? v : null;
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  throw new WalletError('EXPLORER_SCHEMA', 'Unexpected explorer response.');
}

/**
 * A 404 from this explorer means one of two very different things:
 *   - `{"error":"Address not found"}` — the address has never been seen: unused.
 *   - `{"message":"Route GET:/… not found","error":"Not Found","statusCode":404}`
 *     — the base URL or path is wrong. Treating that as "unused" would render a
 *     funded wallet as empty, so it must surface as EXPLORER_UNAVAILABLE.
 * A 404 with a non-JSON body (an HTML page from a proxy) is a route problem too.
 */
export function isAddressNotFound(json: unknown): boolean {
  return isRecord(json) && json.error === 'Address not found';
}

/** Fastify's default 404 body — i.e. we are pointed at the wrong route or host. */
export function isRouteMiss(json: unknown): boolean {
  return isRecord(json) && typeof json.message === 'string' && /Route\s+\S+\s+not found/i.test(json.message);
}

/** Node-Buffer JSON `{type:"Buffer",data:[...]}` or a hex string. */
export function parseScriptPubKey(v: unknown): Uint8Array {
  if (typeof v === 'string') return hexToBytes(v);
  if (isRecord(v) && v.type === 'Buffer' && Array.isArray(v.data)) {
    const out = new Uint8Array(v.data.length);
    for (let i = 0; i < v.data.length; i++) {
      const n = v.data[i];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255) {
        throw new WalletError('EXPLORER_SCHEMA', 'Unexpected explorer response.');
      }
      out[i] = n;
    }
    return out;
  }
  throw new WalletError('EXPLORER_SCHEMA', 'Unexpected explorer response.');
}

/** One definition of byte equality lives in util/bytes.ts. */
export const scriptsEqual = bytesEqual;
