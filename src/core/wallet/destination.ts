import { decodeAddress, encodeAddress, HRP, type BtqNetwork, type DecodedAddress } from '../script/address.js';
import { WalletError } from './errors.js';

/** btq-core's separate legacy Dilithium bech32 namespace (chainparams.cpp). */
const LEGACY_DILITHIUM_HRP = new Set(['tdbt', 'dbtc', 'sdbt', 'rdbt']);
/** Bitcoin's own HRPs — a pasted BTC address is the likeliest wrong-chain mistake. */
const BITCOIN_HRP = new Set(['bc', 'tb', 'bcrt']);
/**
 * Legacy Dilithium P2PKH (`76a914…88bb`) still exists on the live chain and
 * renders as base58: `n…`/`m…` on testnet, `X…` on mainnet. It is historical
 * and not relayed; this wallet pays P2MR only.
 */
const LEGACY_BASE58 = /^[mnX2][1-9A-HJ-NP-Za-km-z]{24,34}$/;

function hrpOf(address: string): string | null {
  const sep = address.lastIndexOf('1');
  if (sep < 1) return null;
  return address.slice(0, sep).toLowerCase();
}

export interface CheckedDestination extends DecodedAddress {
  /**
   * The canonical bech32m encoding of `merkleRoot` — lowercase, untrimmed
   * whitespace gone. bech32m legally accepts an all-uppercase address and the
   * user can paste one with a stray space, but `encodeAddress` only ever emits
   * the lowercase form. Carrying the raw string instead means the plan and the
   * address decoded back out of the signed bytes disagree, and the send is
   * thrown away *after* the password. Everything downstream — plan, preview,
   * activity — uses this field, never the caller's input.
   */
  address: string;
}

/**
 * Testnet P2MR only. Every rejection carries a sentence the user can act on —
 * raw bech32 library text ("Invalid checksum for …") is never passed through,
 * because someone reading that cannot tell whether to re-copy the address or
 * ask the payee for a different one.
 */
export function assertDestination(address: string, network: BtqNetwork = 'testnet'): CheckedDestination {
  const trimmed = address.trim();
  if (!trimmed) {
    throw new WalletError('BAD_ADDRESS', 'Enter a destination address — BTQ testnet addresses start with tbtq1z.');
  }
  if (LEGACY_BASE58.test(trimmed)) {
    throw new WalletError(
      'LEGACY_DILITHIUM',
      'That is a legacy Dilithium address (base58, n… or X…). Those outputs still exist on-chain but are not a supported destination — ask for a tbtq1z… P2MR address.',
    );
  }
  const hrp = hrpOf(trimmed);
  if (hrp === null) {
    throw new WalletError('BAD_ADDRESS', 'That is not a BTQ address. Testnet addresses start with tbtq1z.');
  }
  if (LEGACY_DILITHIUM_HRP.has(hrp)) {
    throw new WalletError(
      'LEGACY_DILITHIUM',
      'Legacy Dilithium addresses (tdbt…) are not supported. Use a tbtq1z… P2MR address.',
    );
  }
  if (BITCOIN_HRP.has(hrp)) {
    throw new WalletError(
      'WRONG_NETWORK',
      'That is a Bitcoin address, not a BTQ one. BTQ testnet addresses start with tbtq1z.',
    );
  }
  if (!Object.values(HRP).includes(hrp)) {
    throw new WalletError(
      'WRONG_NETWORK',
      `Unknown address prefix "${hrp}". BTQ testnet addresses start with tbtq1z.`,
    );
  }

  let decoded: DecodedAddress;
  try {
    decoded = decodeAddress(trimmed, network);
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('wrong network')) {
      throw new WalletError('WRONG_NETWORK', 'That address is not testnet. Testnet addresses start with tbtq1z.');
    }
    if (/witness version|byte program|P2MR address/i.test(msg)) {
      throw new WalletError('BAD_ADDRESS', 'Only P2MR addresses (tbtq1z…) can be paid from this wallet.');
    }
    // Anything else out of the bech32m decoder means the string has a typo.
    throw new WalletError(
      'BAD_ADDRESS',
      'That address failed its checksum — a character is wrong. Copy it again and re-paste.',
    );
  }
  // Re-encode rather than echo: this is the one string the rest of the send
  // path is allowed to carry.
  return { ...decoded, address: encodeAddress(decoded.merkleRoot, decoded.network) };
}
