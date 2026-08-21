import { WalletError } from '../wallet/errors.js';
import { isRecord, parseTxid } from './parse.js';

/** The public explorer currently has no push route; we still POST signed hex. */
export const BROADCAST_PATH = '/api/v1/tx/send';

export function parseBroadcastResponse(status: number, json: unknown): { txid: string } {
  if (status === 404) {
    throw new WalletError(
      'BROADCAST_FAILED',
      'Explorer has no broadcast route. The transaction is signed — copy the hex to push from a node.',
    );
  }
  if (status < 200 || status >= 300) {
    const msg =
      isRecord(json) && typeof json.error === 'string'
        ? json.error
        : isRecord(json) && typeof json.message === 'string'
          ? json.message
          : `Explorer returned HTTP ${status}.`;
    throw new WalletError('BROADCAST_FAILED', msg);
  }
  if (typeof json === 'string' && /^[0-9a-f]{64}$/i.test(json)) return { txid: json.toLowerCase() };
  if (!isRecord(json)) throw new WalletError('BROADCAST_FAILED', 'Unexpected broadcast response.');
  const id = json.txid ?? json.tx_hash ?? json.hash;
  return { txid: parseTxid(id) };
}

export function broadcastBody(hex: string): string {
  return JSON.stringify({ hex });
}
