/**
 * P2MR — Pay-to-Merkle-Root, BTQ's witness-v2 output type (BIP360).
 *
 * The witness program IS the TapLeaf-tagged merkle root: unlike BIP341 there is
 * no internal key and no taptweak, so a single-leaf tree commits directly.
 *
 * btq-core reference:
 *   src/script/script.h:220              OP_CHECKSIGDILITHIUM = 0xbb
 *   src/addresstype.cpp:200              scriptPubKey = OP_2 <32-byte root>
 *   src/script/interpreter.cpp:2176      VerifyP2MRCommitment (root == program)
 *   src/script/interpreter.h:252-255     control block: 1 + 32*m bytes, parity bit set
 *   src/script/interpreter.cpp:2116      ComputeTapleafHash (tag "TapLeaf")
 *   src/wallet/p2mr.cpp:595              single-leaf Dilithium leaf script
 */
import { sha256 } from '@noble/hashes/sha256';
import { PUBLIC_KEY_BYTES } from '../crypto/mldsa.js';
import { compactSize, compareBytes, concatBytes } from '../util/bytes.js';

export { compactSize };

export const OP_CHECKSIGDILITHIUM = 0xbb;
export const OP_PUSHDATA2 = 0x4d;
export const OP_2 = 0x52;
/** Leaf version for a Dilithium P2MR leaf. */
export const LEAF_VERSION = 0xc0;
/** Single-leaf control block: leaf version with the parity bit set, no internal key, no path. */
export const CONTROL_BYTE = 0xc1;
/** 1 (OP_PUSHDATA2) + 2 (LE length) + 1312 (pubkey) + 1 (opcode). */
export const LEAF_SCRIPT_BYTES = 1 + 2 + PUBLIC_KEY_BYTES + 1;

/**
 * BIP340 tagged hash: sha256(sha256(tag) || sha256(tag) || msg). This module
 * owns tag semantics for the whole wallet; sighash.ts imports it from here.
 */
export function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
  const t = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(t, t, msg));
}

/** The single-key Dilithium leaf: OP_PUSHDATA2 <pubkey> OP_CHECKSIGDILITHIUM. */
export function singleKeyLeafScript(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== PUBLIC_KEY_BYTES) {
    throw new Error(`ML-DSA public key must be ${PUBLIC_KEY_BYTES} bytes`);
  }
  const out = new Uint8Array(LEAF_SCRIPT_BYTES);
  out[0] = OP_PUSHDATA2;
  out[1] = PUBLIC_KEY_BYTES & 0xff;         // little-endian 16-bit length
  out[2] = (PUBLIC_KEY_BYTES >> 8) & 0xff;
  out.set(publicKey, 3);
  out[out.length - 1] = OP_CHECKSIGDILITHIUM;
  return out;
}

/** TapLeaf hash: tagged_hash("TapLeaf", leaf_version || compact_size(len) || script). */
export function tapLeafHash(leafScript: Uint8Array, leafVersion = LEAF_VERSION): Uint8Array {
  const size = compactSize(leafScript.length);
  const msg = concatBytes(new Uint8Array([leafVersion]), size, leafScript);
  return taggedHash('TapLeaf', msg);
}

/** For a single-leaf tree the merkle root is the leaf hash itself. */
export function merkleRootForPublicKey(publicKey: Uint8Array): Uint8Array {
  return tapLeafHash(singleKeyLeafScript(publicKey));
}

/** scriptPubKey = OP_2 <32-byte merkle root> (34 bytes). */
export function outputScript(merkleRoot: Uint8Array): Uint8Array {
  if (merkleRoot.length !== 32) throw new Error('P2MR merkle root must be 32 bytes');
  const out = new Uint8Array(34);
  out[0] = OP_2;
  out[1] = 0x20;
  out.set(merkleRoot, 2);
  return out;
}

export function singleLeafControlBlock(): Uint8Array {
  return new Uint8Array([CONTROL_BYTE]);
}

/**
 * Does this leaf/control pair actually commit to the witness program?
 * btq-core enforces exactly this before signing a PSBT input
 * (src/psbt_dilithium.cpp ValidateP2MRDilithiumInput) because a signer that
 * skips it can be tricked into signing an unrelated script.
 */
export function commitsToProgram(leafScript: Uint8Array, controlBlock: Uint8Array, program: Uint8Array): boolean {
  if (controlBlock.length < 1) return false;
  if ((controlBlock[0]! & 1) !== 1) return false;                  // parity bit must be set
  if ((controlBlock.length - 1) % 32 !== 0) return false;          // 1 + 32*m
  const leafVersion = controlBlock[0]! & 0xfe;
  let node = tapLeafHash(leafScript, leafVersion);
  for (let i = 1; i + 32 <= controlBlock.length; i += 32) {
    const sibling = controlBlock.subarray(i, i + 32);
    const [a, b] = compareBytes(node, sibling) <= 0 ? [node, sibling] : [sibling, node];
    node = taggedHash('TapBranch', concatBytes(a, b));
  }
  return compareBytes(node, program) === 0;
}
