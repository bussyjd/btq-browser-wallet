/**
 * Password-sealed vault: PBKDF2-SHA256 + AES-256-GCM.
 *
 * Blob layout (big-endian):
 *   magic[4]="BTQ1" | kdf[1]=1 | iterations[4] | salt[16] | iv[12] | ciphertext+tag
 *
 * The KDF is deliberately slow. Tests inject a lower iteration count; production
 * never accepts a blob with iterations below MIN_PBKDF2_ITERATIONS.
 */
import { WalletError } from '../wallet/errors.js';
import { wipeBytes } from '../util/hex.js';

const MAGIC = new TextEncoder().encode('BTQ1');
const KDF_PBKDF2_SHA256 = 1;
const SALT_LEN = 16;
const IV_LEN = 12;
const HEADER_LEN = 4 + 1 + 4 + SALT_LEN + IV_LEN; // 37

/** OWASP-adjacent; ~200ms on a laptop, painful for offline brute force. */
export const DEFAULT_PBKDF2_ITERATIONS = 210_000;
export const MIN_PBKDF2_ITERATIONS = 1_000;

export interface EncryptOptions {
  iterations?: number;
  randomBytes?: (n: number) => Uint8Array;
}

function requireSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto SubtleCrypto is required');
  return subtle;
}

/** Copy into a standalone ArrayBuffer so TS accepts it as BufferSource. */
function asSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

async function deriveAesKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const subtle = requireSubtle();
  const base = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: asSource(salt), iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptVault(
  plaintext: Uint8Array,
  password: string,
  opts: EncryptOptions = {},
): Promise<Uint8Array> {
  const iterations = opts.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  if (iterations < MIN_PBKDF2_ITERATIONS) throw new Error('KDF iteration count is below the minimum');
  const randomBytes = opts.randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n)));
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  if (salt.length !== SALT_LEN || iv.length !== IV_LEN) throw new Error('randomBytes returned the wrong length');
  const key = await deriveAesKey(password, salt, iterations);
  const ct = new Uint8Array(await requireSubtle().encrypt({ name: 'AES-GCM', iv: asSource(iv) }, key, asSource(plaintext)));
  const out = new Uint8Array(HEADER_LEN + ct.length);
  out.set(MAGIC, 0);
  out[4] = KDF_PBKDF2_SHA256;
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(5, iterations, false);
  out.set(salt, 9);
  out.set(iv, 25);
  out.set(ct, HEADER_LEN);
  return out;
}

export async function decryptVault(blob: Uint8Array, password: string): Promise<Uint8Array> {
  if (blob.length < HEADER_LEN + 16) throw new WalletError('NOT_A_VAULT', 'Not a BTQ vault.');
  for (let i = 0; i < 4; i++) {
    if (blob[i] !== MAGIC[i]) throw new WalletError('NOT_A_VAULT', 'Not a BTQ vault.');
  }
  if (blob[4] !== KDF_PBKDF2_SHA256) throw new WalletError('NOT_A_VAULT', 'Not a BTQ vault.');
  const iterations = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(5, false);
  if (iterations < MIN_PBKDF2_ITERATIONS || iterations > 10_000_000) {
    throw new WalletError('NOT_A_VAULT', 'Not a BTQ vault.');
  }
  const salt = blob.subarray(9, 25);
  const iv = blob.subarray(25, HEADER_LEN);
  const ct = blob.subarray(HEADER_LEN);
  const key = await deriveAesKey(password, salt, iterations);
  try {
    return new Uint8Array(await requireSubtle().decrypt({ name: 'AES-GCM', iv: asSource(iv) }, key, asSource(ct)));
  } catch {
    // AES-GCM auth failure and a wrong password look the same on purpose.
    throw new WalletError('WRONG_PASSWORD', 'Incorrect password.');
  }
}

export function wipePlaintext(bytes: Uint8Array): void {
  wipeBytes(bytes);
}
