/**
 * Explorer JSON validation. Amounts and addresses from the API are untrusted:
 * we never copy an explorer address into the signing path, and a mismatched
 * `address` field is a hard error (hostile-explorer injection).
 *
 * Unused addresses: the public explorer returns `{error:"Address not found"}`
 * (or HTTP 404) rather than a zeroed record. That is unused, not a failure.
 */
import { WalletError } from '../wallet/errors.js';
import type { AddressActivity } from '../wallet/gap.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseSats(v: unknown): bigint {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) {
    const n = BigInt(v);
    if (n < 0n) return 0n;
    return n;
  }
  throw new WalletError('EXPLORER_SCHEMA', 'Unexpected explorer response.');
}

const UNUSED: AddressActivity = { used: false, txCount: 0, balanceSats: 0n };

export function parseAddressResponse(status: number, json: unknown, expectedAddress: string): AddressActivity {
  if (status === 404) return UNUSED;
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

  const balanceSats = json.balance === undefined ? 0n : parseSats(json.balance);
  return {
    used,
    txCount: json.tx_count,
    balanceSats,
  };
}
