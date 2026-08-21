/**
 * BTQ P2MR addresses: bech32m, witness version 2, 32-byte program.
 *
 * btq-core HRPs (src/kernel/chainparams.cpp):
 *   :148 main "qbtc"   :267 test "tbtq"   :401 signet "qtb"   :552 regtest "qcrt"
 * Note btq-core also defines a separate legacy `dilithium_bech32_hrp`
 * (dbtc/tdbt/sdbt/rdbt) for non-P2MR Dilithium destinations; those are
 * non-standard for relay and this wallet deliberately does not produce or
 * accept them.
 */
import { bech32m } from '@scure/base';
import { outputScript, merkleRootForPublicKey } from './p2mr.js';

export type BtqNetwork = 'mainnet' | 'testnet' | 'signet' | 'regtest';

export const HRP: Record<BtqNetwork, string> = {
  mainnet: 'qbtc',
  testnet: 'tbtq',
  signet: 'qtb',
  regtest: 'qcrt',
};

export const WITNESS_VERSION = 2;

export function encodeAddress(merkleRoot: Uint8Array, network: BtqNetwork): string {
  if (merkleRoot.length !== 32) throw new Error('P2MR merkle root must be 32 bytes');
  const words = [WITNESS_VERSION, ...bech32m.toWords(merkleRoot)];
  return bech32m.encode(HRP[network], words, 128);
}

export interface DecodedAddress {
  network: BtqNetwork;
  witnessVersion: number;
  merkleRoot: Uint8Array;
}

/** Strict decode: correct HRP for the expected network, witness v2, 32-byte program. */
export function decodeAddress(address: string, expected?: BtqNetwork): DecodedAddress {
  const { prefix, words } = bech32m.decode(address as `${string}1${string}`, 128);
  const network = (Object.keys(HRP) as BtqNetwork[]).find((n) => HRP[n] === prefix);
  if (!network) throw new Error(`not a BTQ address: unknown prefix "${prefix}"`);
  if (expected && network !== expected) {
    throw new Error(`wrong network: address is ${network}, wallet is ${expected}`);
  }
  const version = words[0];
  if (version !== WITNESS_VERSION) {
    throw new Error(`not a P2MR address: witness version ${version}, expected ${WITNESS_VERSION}`);
  }
  const program = bech32m.fromWords(words.slice(1));
  if (program.length !== 32) throw new Error(`not a P2MR address: ${program.length}-byte program`);
  return { network, witnessVersion: version, merkleRoot: Uint8Array.from(program) };
}

export function addressForPublicKey(publicKey: Uint8Array, network: BtqNetwork): string {
  return encodeAddress(merkleRootForPublicKey(publicKey), network);
}

export function scriptForAddress(address: string, expected?: BtqNetwork): Uint8Array {
  return outputScript(decodeAddress(address, expected).merkleRoot);
}
