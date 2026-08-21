/**
 * ML-DSA-44 (FIPS 204, "Dilithium2") — the BTQ transaction signature scheme.
 *
 * btq-core reference:
 *   src/crypto/dilithium_wrapper.h:16-21   sizes 1312 / 2560 / 2420 / seed 32
 *   src/crypto/dilithium/ref/sign.c        crypto_sign_keypair_from_seed (FIPS 204 KeyGen, xi = seed)
 *   src/crypto/dilithium_wrapper.c:39-42   empty context => NULL/0 passed to the reference impl
 *   src/script/interpreter.cpp:116         witness signature must be exactly 2420 + 1 bytes
 *   src/script/interpreter.cpp:1965        SIGHASH_DEFAULT is rejected for P2MR
 */
import { ml_dsa44 as ml_dsa44_untyped } from '@noble/post-quantum/ml-dsa';

/**
 * The shipped .d.ts for @noble/post-quantum 0.3.1 declares the stale 3-argument
 * Signer shape; the runtime signature is (secretKey, msg, ctx, random) /
 * (publicKey, msg, sig, ctx). We re-declare the context-aware API we rely on.
 * With `random` omitted the implementation is deterministic, matching btq-core,
 * which leaves DILITHIUM_RANDOMIZED_SIGNING undefined
 * (src/crypto/dilithium/ref/config.h:5).
 */
interface MldsaContextApi {
  keygen(seed: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array };
  sign(secretKey: Uint8Array, msg: Uint8Array, ctx?: Uint8Array, random?: Uint8Array): Uint8Array;
  verify(publicKey: Uint8Array, msg: Uint8Array, sig: Uint8Array, ctx?: Uint8Array): boolean;
}
const ml_dsa44 = ml_dsa44_untyped as unknown as MldsaContextApi;

export const SEED_BYTES = 32;
export const PUBLIC_KEY_BYTES = 1312;
export const SECRET_KEY_BYTES = 2560;
export const SIGNATURE_BYTES = 2420;
/** Consensus witness item: the 2420-byte signature plus a mandatory sighash byte. */
export const TX_SIGNATURE_BYTES = SIGNATURE_BYTES + 1;
export const SIGHASH_ALL = 0x01;

/** Empty FIPS 204 context string — BTQ signs with ctx length 0 on the consensus path. */
const EMPTY_CONTEXT = new Uint8Array(0);

export interface MldsaKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** Deterministic keypair from a 32-byte seed (FIPS 204 KeyGen with xi = seed). */
export function keyPairFromSeed(seed: Uint8Array): MldsaKeyPair {
  if (seed.length !== SEED_BYTES) throw new Error(`ML-DSA seed must be ${SEED_BYTES} bytes`);
  const kp = ml_dsa44.keygen(seed);
  if (kp.publicKey.length !== PUBLIC_KEY_BYTES) throw new Error('unexpected ML-DSA public key size');
  if (kp.secretKey.length !== SECRET_KEY_BYTES) throw new Error('unexpected ML-DSA secret key size');
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

export function publicKeyFromSeed(seed: Uint8Array): Uint8Array {
  return keyPairFromSeed(seed).publicKey;
}

/**
 * Sign a 32-byte BTQ sighash and append the sighash-type byte, producing the
 * exact 2421-byte witness item consensus requires. The digest is signed raw:
 * no pre-hash mode, empty context.
 */
export function signTransactionHash(seed: Uint8Array, sighash: Uint8Array, sighashType = SIGHASH_ALL): Uint8Array {
  if (sighash.length !== 32) throw new Error('BTQ sighash must be 32 bytes');
  if (sighashType === 0x00) throw new Error('SIGHASH_DEFAULT is rejected by BTQ P2MR consensus');
  const { secretKey } = keyPairFromSeed(seed);
  const raw = ml_dsa44.sign(secretKey, sighash, EMPTY_CONTEXT);
  if (raw.length !== SIGNATURE_BYTES) throw new Error('unexpected ML-DSA signature size');
  const out = new Uint8Array(TX_SIGNATURE_BYTES);
  out.set(raw, 0);
  out[SIGNATURE_BYTES] = sighashType;
  return out;
}

/** Verify a 2421-byte witness signature against a 32-byte sighash. */
export function verifyTransactionHash(publicKey: Uint8Array, sighash: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== TX_SIGNATURE_BYTES) return false;
  if (signature[SIGNATURE_BYTES] !== SIGHASH_ALL) return false;
  return ml_dsa44.verify(publicKey, sighash, signature.subarray(0, SIGNATURE_BYTES), EMPTY_CONTEXT);
}
