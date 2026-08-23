import { publicKeyFromSeed } from '../crypto/mldsa.js';
import { masterFromSeed, deriveKeySeed, keyPath, type Chain } from '../crypto/hd.js';
import { addressForPublicKey, type BtqNetwork } from '../script/address.js';

export interface DerivedAddress {
  address: string;
  path: string;
  index: number;
  chain: Chain;
  network: BtqNetwork;
  account: number;
}

/** P2MR address at m/k'/{0,1}'/index'. Does not return key material. `account` defaults to 0. */
export function addressFromHdSeed(
  hdSeed: Uint8Array,
  chain: Chain,
  index: number,
  network: BtqNetwork,
  account = 0,
): DerivedAddress {
  const keySeed = deriveKeySeed(masterFromSeed(hdSeed), chain, index, account);
  const address = addressForPublicKey(publicKeyFromSeed(keySeed), network);
  return { address, path: keyPath(chain, index, account), index, chain, network, account };
}
