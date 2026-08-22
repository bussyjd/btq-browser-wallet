import { WalletError } from '../wallet/errors.js';
import {
  isAddressNotFound,
  isRecord,
  parseBlockHeight,
  parseSats,
  parseScriptPubKey,
  parseTxid,
  scriptsEqual,
} from './parse.js';

export interface ExplorerUtxo {
  txid: string;
  vout: number;
  value: bigint;
  script: Uint8Array;
  /** null while the coin is still only in the mempool (`block_height: null`). */
  blockHeight: number | null;
}

/**
 * Parse `/api/v1/address/{addr}/utxos`. Amounts are not used for signing until
 * the caller has matched `script` to a script it derived itself.
 *
 * A never-seen address answers 200 with `items: []` on the live indexer, so a
 * 404 here is a wrong-URL/route problem unless the body is the indexer's own
 * "Address not found" — a route miss must never read as "no coins".
 */
export function parseUtxoResponse(
  status: number,
  json: unknown,
  expectedAddress: string,
  expectedScript: Uint8Array,
): ExplorerUtxo[] {
  if (status === 404) {
    if (isAddressNotFound(json)) return [];
    throw new WalletError(
      'EXPLORER_UNAVAILABLE',
      'Explorer returned HTTP 404 for the UTXO route — check the explorer URL in Settings.',
    );
  }
  if (status < 200 || status >= 300) {
    throw new WalletError('EXPLORER_UNAVAILABLE', `Explorer returned HTTP ${status}.`);
  }
  if (isAddressNotFound(json)) return [];
  if (!isRecord(json) || !Array.isArray(json.items)) {
    throw new WalletError('EXPLORER_SCHEMA', 'Unexpected explorer response.');
  }
  const out: ExplorerUtxo[] = [];
  for (const raw of json.items) {
    if (!isRecord(raw)) throw new WalletError('EXPLORER_SCHEMA', 'Unexpected explorer response.');
    if (typeof raw.address === 'string' && raw.address !== expectedAddress) {
      throw new WalletError('EXPLORER_SCHEMA', 'Explorer address does not match the derived address.');
    }
    if (raw.spent_txid != null && raw.spent_txid !== '') continue;
    if (typeof raw.script_type === 'string' && raw.script_type !== 'witness_v2_p2mr') {
      throw new WalletError('EXPLORER_SCHEMA', 'Explorer address does not match the derived address.');
    }
    // vout is a uint32 on the wire (serialize.ts u32le uses `n >>> 0`, which wraps).
    if (
      typeof raw.vout !== 'number' ||
      !Number.isInteger(raw.vout) ||
      raw.vout < 0 ||
      raw.vout > 0xffffffff
    ) {
      throw new WalletError('EXPLORER_SCHEMA', 'Unexpected explorer response.');
    }
    const script = parseScriptPubKey(raw.script_pub_key);
    if (!scriptsEqual(script, expectedScript)) {
      throw new WalletError('EXPLORER_SCHEMA', 'Explorer scriptPubKey does not match the derived script.');
    }
    out.push({
      txid: parseTxid(raw.txid),
      vout: raw.vout,
      value: parseSats(raw.value),
      script,
      blockHeight: parseBlockHeight(raw.block_height),
    });
  }
  return out;
}
