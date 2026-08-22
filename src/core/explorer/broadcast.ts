import { BroadcastError } from '../wallet/errors.js';
import { isRecord, isRouteMiss, parseTxid } from './parse.js';

/**
 * The public explorer has **no push route**: `POST /api/v1/tx/send` answers 404
 * `{"message":"Route POST:/api/v1/tx/send not found",…}` (verified 2026-08-21).
 * We still POST so a self-hosted indexer that does implement it works, but a
 * 404 here is reported as "this backend cannot broadcast", not "tx rejected".
 */
export const BROADCAST_PATH = '/api/v1/tx/send';

const NO_ROUTE_MESSAGE =
  'This explorer has no broadcast route. The transaction is signed — add a BTQ Core node under Settings → Testnet, or copy the hex and push it from a node.';

export function parseBroadcastResponse(status: number, json: unknown): { txid: string; via: 'explorer' } {
  if (status === 404 || isRouteMiss(json)) {
    throw new BroadcastError(NO_ROUTE_MESSAGE, 'explorer', true);
  }
  if (status < 200 || status >= 300) {
    const msg =
      isRecord(json) && typeof json.error === 'string'
        ? json.error
        : isRecord(json) && typeof json.message === 'string'
          ? json.message
          : `Explorer returned HTTP ${status}.`;
    throw new BroadcastError(msg, 'explorer');
  }
  if (typeof json === 'string' && /^[0-9a-f]{64}$/i.test(json)) {
    return { txid: json.toLowerCase(), via: 'explorer' };
  }
  if (!isRecord(json)) throw new BroadcastError('Unexpected broadcast response.', 'explorer');
  const id = json.txid ?? json.tx_hash ?? json.hash;
  try {
    return { txid: parseTxid(id), via: 'explorer' };
  } catch {
    throw new BroadcastError('Explorer did not return a transaction id.', 'explorer');
  }
}

export function broadcastBody(hex: string): string {
  return JSON.stringify({ hex });
}
