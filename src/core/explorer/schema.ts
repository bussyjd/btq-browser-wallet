/**
 * Explorer JSON validation. Amounts and addresses from the API are untrusted:
 * we never copy an explorer address into the signing path, and a mismatched
 * `address` field is a hard error (hostile-explorer injection).
 *
 * Unused addresses: the public explorer answers a never-seen address with HTTP
 * 404 `{error:"Address not found"}`. A 404 that is a *route* miss (wrong base
 * URL, proxy error page) must never look the same — see parse.ts.
 *
 * The `balance` field here is display-only; spendable balance is the sum of
 * `/utxos` (the live indexer reports negative balances for busy addresses).
 */
import { WalletError } from '../wallet/errors.js';
import type { AddressActivity } from '../wallet/gap.js';
import { isAddressNotFound, isRecord, parseDisplayBalanceSats } from './parse.js';

const UNUSED: AddressActivity = { used: false, txCount: 0, reportedBalanceSats: 0n };

export function parseAddressResponse(status: number, json: unknown, expectedAddress: string): AddressActivity {
  if (status === 404) {
    // Only the indexer's own "Address not found" body means unused. A wrong
    // explorer URL 404s too, and calling that "unused" would silently render a
    // funded wallet as empty and let a restore stop at index 0.
    if (isAddressNotFound(json)) return UNUSED;
    throw new WalletError(
      'EXPLORER_UNAVAILABLE',
      'Explorer returned HTTP 404 for the address route — check the explorer URL in Settings.',
    );
  }
  // Non-2xx is a failure even if the body says "Address not found" — treating
  // that as unused would hide funds when the explorer is down or hostile.
  if (status < 200 || status >= 300) {
    throw new WalletError('EXPLORER_UNAVAILABLE', `Explorer returned HTTP ${status}.`);
  }
  if (isRecord(json) && json.error === 'Address not found' && json.tx_count === undefined) return UNUSED;
  if (!isRecord(json)) throw new WalletError('EXPLORER_SCHEMA', 'Unexpected explorer response.');

  if (typeof json.tx_count !== 'number' || !Number.isInteger(json.tx_count) || json.tx_count < 0) {
    throw new WalletError('EXPLORER_SCHEMA', 'Unexpected explorer response.');
  }

  const used = json.tx_count > 0;
  // Used rows must echo the address we queried. Omitting it is as hostile as swapping it.
  if (used || typeof json.address === 'string') {
    if (json.address !== expectedAddress) {
      throw new WalletError('EXPLORER_SCHEMA', 'Explorer address does not match the derived address.');
    }
  }

  return {
    used,
    txCount: json.tx_count,
    reportedBalanceSats: json.balance === undefined ? 0n : parseDisplayBalanceSats(json.balance),
  };
}

/** `/api/v1/blocks/tip` — the chain tip we count confirmations against. */
export function parseTipResponse(status: number, json: unknown): { height: number; hash: string } {
  if (status < 200 || status >= 300) {
    throw new WalletError('EXPLORER_UNAVAILABLE', `Explorer returned HTTP ${status} for /blocks/tip.`);
  }
  if (
    !isRecord(json) ||
    typeof json.height !== 'number' ||
    !Number.isInteger(json.height) ||
    json.height < 0 ||
    typeof json.hash !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(json.hash)
  ) {
    throw new WalletError('EXPLORER_SCHEMA', 'Unexpected explorer response.');
  }
  return { height: json.height, hash: json.hash.toLowerCase() };
}
