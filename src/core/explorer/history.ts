import { WalletError } from '../wallet/errors.js';
import { isAddressNotFound, isRecord, parseBlockHeight, parseSignedSats, parseTxid } from './parse.js';

export interface HistoryItem {
  txid: string;
  blockHeight: number | null;
  valueChange: bigint;
  /** 'signed' = built by this wallet but never accepted by any backend. */
  status: 'pending' | 'confirmed' | 'signed';
  /** tipHeight - blockHeight + 1 when both are known. */
  confirmations?: number | null;
  /** Local ms-epoch timestamp for wallet-originated rows. */
  at?: number;
}

export interface HistoryPage {
  items: HistoryItem[];
  /** `total` from the explorer when it is an integer — used to stop paging. */
  total: number | null;
  page: number | null;
  limit: number | null;
}

/**
 * Parse one page of `/api/v1/address/{addr}/txs`.
 * Live shape: `{items:[{address, txid, block_height, tx_index, value_change}], total, page, limit}`,
 * default limit 25, maximum 100 (limit=1000 returns nothing), `page` 1-based.
 */
export function parseHistoryPage(status: number, json: unknown, expectedAddress: string): HistoryPage {
  const empty: HistoryPage = { items: [], total: 0, page: null, limit: null };
  if (status === 404) {
    // A never-seen address answers 200 `items: []`; a 404 is the wrong route.
    if (isAddressNotFound(json)) return empty;
    throw new WalletError(
      'EXPLORER_UNAVAILABLE',
      'Explorer returned HTTP 404 for the history route — check the explorer URL in Settings.',
    );
  }
  if (status < 200 || status >= 300) {
    throw new WalletError('EXPLORER_UNAVAILABLE', `Explorer returned HTTP ${status}.`);
  }
  if (isAddressNotFound(json)) return empty;
  if (!isRecord(json) || !Array.isArray(json.items)) {
    throw new WalletError('EXPLORER_SCHEMA', 'Unexpected explorer response.');
  }
  const items: HistoryItem[] = [];
  for (const raw of json.items) {
    if (!isRecord(raw)) throw new WalletError('EXPLORER_SCHEMA', 'Unexpected explorer response.');
    if (typeof raw.address === 'string' && raw.address !== expectedAddress) {
      throw new WalletError('EXPLORER_SCHEMA', 'Explorer address does not match the derived address.');
    }
    const blockHeight = parseBlockHeight(raw.block_height);
    items.push({
      txid: parseTxid(raw.txid),
      blockHeight,
      valueChange: parseSignedSats(raw.value_change),
      status: blockHeight === null ? 'pending' : 'confirmed',
    });
  }
  return { items, total: intOrNull(json.total), page: intOrNull(json.page), limit: intOrNull(json.limit) };
}

/** Single-page view for callers that do their own paging. */
export function parseHistoryResponse(status: number, json: unknown, expectedAddress: string): HistoryItem[] {
  return parseHistoryPage(status, json, expectedAddress).items;
}

function intOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}
