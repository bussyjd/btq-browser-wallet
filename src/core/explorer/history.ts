import { WalletError } from '../wallet/errors.js';
import { isRecord, parseSignedSats, parseTxid } from './parse.js';

export interface HistoryItem {
  txid: string;
  blockHeight: number | null;
  valueChange: bigint;
  status: 'pending' | 'confirmed';
}

export function parseHistoryResponse(status: number, json: unknown, expectedAddress: string): HistoryItem[] {
  if (status === 404) return [];
  if (status < 200 || status >= 300) {
    throw new WalletError('EXPLORER_UNAVAILABLE', `Explorer returned HTTP ${status}.`);
  }
  if (isRecord(json) && json.error === 'Address not found') return [];
  if (!isRecord(json) || !Array.isArray(json.items)) {
    throw new WalletError('EXPLORER_SCHEMA', 'Unexpected explorer response.');
  }
  const items: HistoryItem[] = [];
  for (const raw of json.items) {
    if (!isRecord(raw)) throw new WalletError('EXPLORER_SCHEMA', 'Unexpected explorer response.');
    if (typeof raw.address === 'string' && raw.address !== expectedAddress) {
      throw new WalletError('EXPLORER_SCHEMA', 'Explorer address does not match the derived address.');
    }
    const height = raw.block_height;
    const confirmed = typeof height === 'number' && Number.isInteger(height) && height > 0;
    items.push({
      txid: parseTxid(raw.txid),
      blockHeight: confirmed ? height : null,
      valueChange: parseSignedSats(raw.value_change),
      status: confirmed ? 'confirmed' : 'pending',
    });
  }
  return items;
}
