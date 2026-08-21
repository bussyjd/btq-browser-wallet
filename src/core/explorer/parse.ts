import { WalletError } from '../wallet/errors.js';
import { hexToBytes } from '../util/hex.js';

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

export function parseTxid(v: unknown): string {
  if (typeof v !== 'string' || !/^[0-9a-f]{64}$/i.test(v)) {
    throw new WalletError('EXPLORER_SCHEMA', 'Unexpected explorer response.');
  }
  return v.toLowerCase();
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

export function scriptsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
