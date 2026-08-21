import { decodeAddress, type BtqNetwork, type DecodedAddress } from '../script/address.js';
import { WalletError } from './errors.js';

const LEGACY_DILITHIUM_HRP = new Set(['tdbt', 'dbtc', 'sdbt', 'rdbt']);

function hrpOf(address: string): string {
  const sep = address.indexOf('1');
  if (sep < 1) throw new WalletError('BAD_ADDRESS', 'Not a BTQ address.');
  return address.slice(0, sep).toLowerCase();
}

/** Testnet P2MR only. Rejects mainnet `qbtc` and the legacy Dilithium namespace. */
export function assertDestination(address: string, network: BtqNetwork = 'testnet'): DecodedAddress {
  const hrp = hrpOf(address);
  if (LEGACY_DILITHIUM_HRP.has(hrp)) {
    throw new WalletError(
      'LEGACY_DILITHIUM',
      'Legacy Dilithium addresses (tdbt…) are not supported. Use a tbtq1z… P2MR address.',
    );
  }
  try {
    return decodeAddress(address, network);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Not a BTQ address.';
    if (msg.includes('wrong network')) {
      throw new WalletError('WRONG_NETWORK', 'That address is not testnet. Testnet addresses start with tbtq1z.');
    }
    throw new WalletError('BAD_ADDRESS', msg);
  }
}
