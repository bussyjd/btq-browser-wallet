/**
 * BTQ hierarchical-deterministic derivation for ML-DSA keys.
 *
 * ML-DSA admits no homomorphic public derivation, so btq-core uses a
 * hardened-only BIP32 variant over the 32-byte ML-DSA *seed* rather than over a
 * private scalar. This module reproduces it byte-for-byte.
 *
 * btq-core reference (src/crypto/dilithium_key.cpp):
 *   SetSeed  : I = HMAC-SHA512(key="Dilithium seed", msg=hd_seed)
 *              I_L -> master seed (32B), I_R -> master chaincode (32B)
 *   Derive   : I = HMAC-SHA512(key=parent_chaincode,
 *                              msg=0x00 || parent_seed(32) || ser32BE(index))
 *              I_L -> child seed,        I_R -> child chaincode
 *              non-hardened indices are refused (Derive returns false)
 *   Encode   : 73 bytes = depth(1) || fingerprint(4) || child(4 BE) || chaincode(32) || seed(32)
 * Path (src/wallet/scriptpubkeyman.cpp DeriveNewDilithiumChildKey):
 *   external m/0'/0'/n'   internal m/0'/1'/n'
 */
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { publicKeyFromSeed } from './mldsa.js';

export const HARDENED = 0x80000000;
export const EXTKEY_SIZE = 73;
const MASTER_HMAC_KEY = new TextEncoder().encode('Dilithium seed');

export interface DilithiumExtKey {
  depth: number;
  fingerprint: Uint8Array; // 4 bytes, parent key id prefix
  child: number;           // BE child index of this node
  chaincode: Uint8Array;   // 32
  seed: Uint8Array;        // 32 — the ML-DSA keygen seed
}

function ser32BE(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** btq-core CDilithiumPubKey::GetID — HASH160 of the 1312-byte public key. */
export function publicKeyId(publicKey: Uint8Array): Uint8Array {
  return ripemd160(sha256(publicKey));
}

/** Master key from an HD seed (btq-core CDilithiumExtKey::SetSeed). */
export function masterFromSeed(hdSeed: Uint8Array): DilithiumExtKey {
  if (hdSeed.length === 0) throw new Error('HD seed must not be empty');
  const I = hmac(sha512, MASTER_HMAC_KEY, hdSeed);
  return {
    depth: 0,
    fingerprint: new Uint8Array(4),
    child: 0,
    chaincode: I.slice(32, 64),
    seed: I.slice(0, 32),
  };
}

/** Derive a hardened child (btq-core CDilithiumExtKey::Derive). */
export function deriveChild(parent: DilithiumExtKey, index: number): DilithiumExtKey {
  if ((index & HARDENED) === 0) {
    throw new Error('BTQ ML-DSA derivation is hardened-only: index must have the 0x80000000 bit set');
  }
  if (parent.depth === 0xff) throw new Error('maximum derivation depth reached');
  const I = hmac(sha512, parent.chaincode, concat(new Uint8Array([0x00]), parent.seed, ser32BE(index)));
  const parentId = publicKeyId(publicKeyFromSeed(parent.seed));
  return {
    depth: parent.depth + 1,
    fingerprint: parentId.slice(0, 4),
    child: index >>> 0,
    chaincode: I.slice(32, 64),
    seed: I.slice(0, 32),
  };
}

/** Derive along a hardened path, e.g. [0', 0', n']. */
export function derivePath(master: DilithiumExtKey, path: number[]): DilithiumExtKey {
  return path.reduce((k, i) => deriveChild(k, i), master);
}

export type Chain = 'external' | 'internal';

/**
 * The account key for a chain: m/0'/0' (external) or m/0'/1' (internal),
 * mirroring btq-core's legacy HD split.
 */
export function accountKey(master: DilithiumExtKey, chain: Chain): DilithiumExtKey {
  return derivePath(master, [HARDENED, HARDENED + (chain === 'internal' ? 1 : 0)]);
}

/** The ML-DSA seed at m/0'/{0,1}'/index'. */
export function deriveKeySeed(master: DilithiumExtKey, chain: Chain, index: number): Uint8Array {
  if (index < 0 || index >= HARDENED) throw new Error('index out of range');
  return deriveChild(accountKey(master, chain), (index | HARDENED) >>> 0).seed;
}

export function keyPath(chain: Chain, index: number): string {
  return `m/0'/${chain === 'internal' ? 1 : 0}'/${index}'`;
}

/** 73-byte serialization (btq-core CDilithiumExtKey::Encode). */
export function encodeExtKey(k: DilithiumExtKey): Uint8Array {
  return concat(new Uint8Array([k.depth]), k.fingerprint, ser32BE(k.child), k.chaincode, k.seed);
}
