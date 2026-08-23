import { WalletError } from '../wallet/errors.js';
import { hexToBytes } from '../util/hex.js';
import type { BtqNetwork } from '../script/address.js';

export type SeedOrigin = 'bip39' | 'raw32';

/**
 * 1 = pre-reveal vaults. 2 = may carry BIP39 entropy.
 *
 * The union, never the literal `2`: a v1 vault stays fully readable and the
 * tests that hand-build one keep compiling. Narrowing this is how a "migration"
 * quietly becomes "old vaults are corrupt".
 */
export type PayloadVersion = 1 | 2;

export interface VaultPayload {
  v: PayloadVersion;
  network: BtqNetwork;
  origin: SeedOrigin;
  hdSeedHex: string;
  /**
   * BIP39 entropy, 16 or 32 bytes, lowercase hex. Present only on a v2 vault
   * sealed from a phrase. Absent means "cannot show a phrase", not "empty" —
   * a raw32 wallet genuinely has none, and running the words back out of its
   * HD seed would manufacture a phrase for a different wallet.
   */
  entropyHex?: string;
}

const NETWORKS: ReadonlySet<string> = new Set(['mainnet', 'testnet', 'signet', 'regtest']);

export function encodePayload(payload: VaultPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

/**
 * Decode a plaintext vault payload, or refuse with the one non-oracle failure.
 *
 * Strictness is safe — and required — because the envelope is AES-GCM
 * authenticated: only our own `seal()` can produce a decodable payload, so a
 * malformed `entropyHex` is always our own bug and must fail loudly rather than
 * be rounded off to "no phrase". The return is a whitelist: unknown fields are
 * dropped, never carried into the keyring.
 */
export function decodePayload(bytes: Uint8Array): VaultPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new WalletError('NOT_A_VAULT', 'Not a BTQ vault.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new WalletError('NOT_A_VAULT', 'Not a BTQ vault.');
  }
  const o = parsed as Record<string, unknown>;
  if (o.v !== 1 && o.v !== 2) throw new WalletError('NOT_A_VAULT', 'Not a BTQ vault.');
  if (typeof o.network !== 'string' || !NETWORKS.has(o.network)) throw new WalletError('NOT_A_VAULT', 'Not a BTQ vault.');
  if (o.origin !== 'bip39' && o.origin !== 'raw32') throw new WalletError('NOT_A_VAULT', 'Not a BTQ vault.');
  if (typeof o.hdSeedHex !== 'string' || !/^[0-9a-f]+$/.test(o.hdSeedHex) || o.hdSeedHex.length % 2 !== 0) {
    throw new WalletError('NOT_A_VAULT', 'Not a BTQ vault.');
  }
  hexToBytes(o.hdSeedHex); // length-checked by hex parser
  const out: VaultPayload = {
    v: o.v,
    network: o.network as BtqNetwork,
    origin: o.origin,
    hdSeedHex: o.hdSeedHex,
  };
  if (o.entropyHex !== undefined) {
    if (o.v !== 2) throw new WalletError('NOT_A_VAULT', 'Not a BTQ vault.');
    if (o.origin !== 'bip39') throw new WalletError('NOT_A_VAULT', 'Not a BTQ vault.');
    if (typeof o.entropyHex !== 'string' || !/^[0-9a-f]+$/.test(o.entropyHex)) {
      throw new WalletError('NOT_A_VAULT', 'Not a BTQ vault.');
    }
    if (o.entropyHex.length !== 32 && o.entropyHex.length !== 64) {
      throw new WalletError('NOT_A_VAULT', 'Not a BTQ vault.');
    }
    out.entropyHex = o.entropyHex;
  }
  return out;
}
