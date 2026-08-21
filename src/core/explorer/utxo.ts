import { WalletError } from '../wallet/errors.js';
import { isRecord, parseSats, parseScriptPubKey, parseTxid, scriptsEqual } from './parse.js';

export interface ExplorerUtxo {
  txid: string;
  vout: number;
  value: bigint;
  script: Uint8Array;
}

/**
 * Parse `/api/v1/address/{addr}/utxos`. Amounts are not used for signing until
 * the caller has matched `script` to a script it derived itself.
 */
export function parseUtxoResponse(
  status: number,
  json: unknown,
  expectedAddress: string,
  expectedScript: Uint8Array,
): ExplorerUtxo[] {
  if (status === 404) return [];
  if (status < 200 || status >= 300) {
    throw new WalletError('EXPLORER_UNAVAILABLE', `Explorer returned HTTP ${status}.`);
  }
  if (isRecord(json) && json.error === 'Address not found') return [];
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
    });
  }
  return out;
}
