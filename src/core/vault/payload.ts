import { WalletError } from '../wallet/errors.js';
import { hexToBytes } from '../util/hex.js';
import type { BtqNetwork } from '../script/address.js';

export type SeedOrigin = 'bip39' | 'raw32';

export interface VaultPayload {
  v: 1;
  network: BtqNetwork;
  origin: SeedOrigin;
  hdSeedHex: string;
}

const NETWORKS: ReadonlySet<string> = new Set(['mainnet', 'testnet', 'signet', 'regtest']);

export function encodePayload(payload: VaultPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

export function decodePayload(bytes: Uint8Array): VaultPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new WalletError('NOT_A_VAULT', 'Not a BTQ vault.');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new WalletError('NOT_A_VAULT', 'Not a BTQ vault.');
  const o = parsed as Record<string, unknown>;
  if (o.v !== 1) throw new WalletError('NOT_A_VAULT', 'Not a BTQ vault.');
  if (typeof o.network !== 'string' || !NETWORKS.has(o.network)) throw new WalletError('NOT_A_VAULT', 'Not a BTQ vault.');
  if (o.origin !== 'bip39' && o.origin !== 'raw32') throw new WalletError('NOT_A_VAULT', 'Not a BTQ vault.');
  if (typeof o.hdSeedHex !== 'string' || !/^[0-9a-f]+$/.test(o.hdSeedHex) || o.hdSeedHex.length % 2 !== 0) {
    throw new WalletError('NOT_A_VAULT', 'Not a BTQ vault.');
  }
  hexToBytes(o.hdSeedHex); // length-checked by hex parser
  return { v: 1, network: o.network as BtqNetwork, origin: o.origin, hdSeedHex: o.hdSeedHex };
}
