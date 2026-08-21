import { publicKeyFromSeed } from '../crypto/mldsa.js';
import { masterFromSeed, deriveKeySeed, keyPath, type Chain } from '../crypto/hd.js';
import { addressForPublicKey, type BtqNetwork } from '../script/address.js';

export interface DerivedAddress {
  address: string;
  path: string;
  index: number;
  chain: Chain;
  network: BtqNetwork;
}

/** P2MR address at m/0'/{0,1}'/index'. Does not return key material. */
export function addressFromHdSeed(
  hdSeed: Uint8Array,
  chain: Chain,
  index: number,
  network: BtqNetwork,
): DerivedAddress {
  const keySeed = deriveKeySeed(masterFromSeed(hdSeed), chain, index);
  const address = addressForPublicKey(publicKeyFromSeed(keySeed), network);
  return { address, path: keyPath(chain, index), index, chain, network };
}
