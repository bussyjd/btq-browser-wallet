/**
 * The orderings btq-core serializes its PSBT maps in.
 *
 * A PSBT is a set of key/value maps, so two encoders that hold the same fields
 * still produce different bytes unless they agree on order. btq-core's order is
 * whatever its `std::map` and `std::set` comparators give, and reproducing
 * `combinepsbt` byte-for-byte means reproducing those:
 *
 *   src/psbt.h:196-201                   the three P2MR members and their key types
 *   src/script/signingprovider.h:18-26   ShortestVectorFirstComparator
 *   src/addresstype.cpp:53               DilithiumPKHash = CDilithiumPubKey::GetID()
 *   src/crypto/dilithium_pubkey.cpp:21   ...which is Hash160(pubkey)
 *   src/uint256.h:54                     base_blob::Compare is a plain memcmp
 *
 * The subtlety worth spelling out: `std::vector<unsigned char>` orders
 * *lexicographically* — a proper prefix sorts before what extends it — while
 * `ShortestVectorFirstComparator` orders by length first. They disagree, and
 * both appear, so neither can be used for the other's map.
 */
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { compareBytes } from '../util/bytes.js';
import type { DilithiumPartialSignature, P2MRLeafScript } from './types.js';

/**
 * `std::vector<unsigned char>::operator<` — element-wise, and a proper prefix
 * comes first. Not `compareBytes`, which sorts by length first.
 */
export function lexicographic(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** Hash160 = RIPEMD160(SHA256(x)), the identity a Dilithium sig map is keyed by. */
export function hash160(bytes: Uint8Array): Uint8Array {
  return ripemd160(sha256(bytes));
}

/** ShortestVectorFirstComparator: by length, then lexicographically. */
export function compareControlBlocks(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length;
  return compareBytes(a, b);
}

/** `std::map<std::pair<script, leaf_version>, …>` order. */
export function compareLeaves(a: P2MRLeafScript, b: P2MRLeafScript): number {
  const byScript = lexicographic(a.script, b.script);
  return byScript !== 0 ? byScript : a.leafVersion - b.leafVersion;
}

/**
 * `std::map<std::pair<DilithiumPKHash, uint256>, …>` order — by the *hash* of
 * the public key, not by the key itself, and only then by the leaf hash.
 * Sorting by the 1312-byte key instead would produce a valid PSBT that is not
 * the one btq-core would have written.
 */
export function compareDilithiumSigs(a: DilithiumPartialSignature, b: DilithiumPartialSignature): number {
  const byKey = compareBytes(hash160(a.pubkey), hash160(b.pubkey));
  return byKey !== 0 ? byKey : compareBytes(a.leafHash, b.leafHash);
}
