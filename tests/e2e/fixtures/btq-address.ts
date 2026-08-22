/**
 * P2MR address encoding for the mock chain, written in the test tree so the
 * ledger resolves `OP_2 <32 bytes>` to an address without borrowing
 * `src/core/script/address.ts`. `smoke.spec.ts` pins both directions to
 * `tests/vectors/golden.json`, which was verified against btq-core.
 *
 * BIP350 bech32m, witness version 2, 32-byte program. btq-core HRPs
 * (src/kernel/chainparams.cpp): main "qbtc", test "tbtq", signet "qtb",
 * regtest "qcrt".
 */
import { bech32m } from '@scure/base';
import { fromHex, toHex } from './bip341.js';

export const HRP = { mainnet: 'qbtc', testnet: 'tbtq', signet: 'qtb', regtest: 'qcrt' } as const;
export type BtqNetwork = keyof typeof HRP;
export const WITNESS_VERSION = 2;
export const OP_2 = 0x52;

export function encodeP2mr(program: Uint8Array, network: BtqNetwork = 'testnet'): string {
  if (program.length !== 32) throw new Error('a P2MR witness program is 32 bytes');
  return bech32m.encode(HRP[network], [WITNESS_VERSION, ...bech32m.toWords(program)], 128);
}

export function decodeP2mr(address: string): { network: BtqNetwork; program: Uint8Array } {
  const { prefix, words } = bech32m.decode(address as `${string}1${string}`, 128);
  const network = (Object.keys(HRP) as BtqNetwork[]).find((n) => HRP[n] === prefix);
  if (!network) throw new Error(`unknown BTQ prefix "${prefix}"`);
  if (words[0] !== WITNESS_VERSION) throw new Error(`witness version ${words[0]}, expected ${WITNESS_VERSION}`);
  const program = Uint8Array.from(bech32m.fromWords(words.slice(1)));
  if (program.length !== 32) throw new Error(`${program.length}-byte program, expected 32`);
  return { network, program };
}

/** scriptPubKey hex for an address: OP_2 0x20 <32-byte program>. */
export function scriptHexFor(address: string): string {
  return `5220${toHex(decodeP2mr(address).program)}`;
}

/** The address an `OP_2 <32 bytes>` script pays, or null for anything else. */
export function addressForScriptHex(scriptHex: string, network: BtqNetwork = 'testnet'): string | null {
  const script = fromHex(scriptHex);
  if (script.length !== 34 || script[0] !== OP_2 || script[1] !== 0x20) return null;
  try {
    return encodeP2mr(script.subarray(2), network);
  } catch {
    return null;
  }
}
