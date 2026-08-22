/**
 * BIP39 front-end for btq-core's Dilithium HD scheme.
 *
 * Mapping (this wallet's documented standard — BTQ has not published one):
 *   mnemonic → BIP39 seed (PBKDF2-HMAC-SHA512, 2048 rounds, salt "mnemonic" + passphrase)
 *            → CDilithiumExtKey::SetSeed (HMAC-SHA512 key="Dilithium seed")
 *
 * The BIP39 seed is 64 bytes; SetSeed takes a Span of any length
 * (btq-core src/crypto/dilithium_key.cpp:357-364), so we feed it whole.
 * A raw 32-byte hex seed skips BIP39 and is what sethdseed consumes.
 *
 * These two inputs of "the same entropy" are different wallets — see docs/HD_IMPORT.md.
 */
import { generateMnemonic as scureGenerate, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { WalletError } from '../wallet/errors.js';
import { hexToBytes } from '../util/hex.js';

const WORD_SET = new Set(wordlist);

export function normalizeMnemonic(input: string): string {
  return input.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

/** 12-word (128-bit) mnemonic; 24-word if strength is 256. Uses CSPRNG via @scure/bip39. */
export function generateMnemonic(strength: 128 | 256 = 128): string {
  return scureGenerate(wordlist, strength);
}

export function parseMnemonic(input: string): string {
  const normalized = normalizeMnemonic(input);
  const words = normalized.length === 0 ? [] : normalized.split(' ');
  if (words.length !== 12 && words.length !== 24) {
    throw new WalletError('BAD_MNEMONIC', `Seed phrases are 12 or 24 words, not ${words.length}.`);
  }
  const unknown = words.find((w) => !WORD_SET.has(w));
  if (unknown !== undefined) {
    throw new WalletError('BAD_WORD', `Word not in the BIP39 list: "${unknown}".`);
  }
  if (!validateMnemonic(normalized, wordlist)) {
    throw new WalletError('BAD_CHECKSUM', 'That seed checksum is wrong. Check the words and try again.');
  }
  return normalized;
}

/** 64-byte BIP39 seed — the bytes we feed to masterFromSeed. */
export function mnemonicToHdSeed(mnemonic: string, passphrase = ''): Uint8Array {
  return mnemonicToSeedSync(parseMnemonic(mnemonic), passphrase);
}

/** Raw btq-core HD seed: exactly 32 bytes as hex (sethdseed shape). */
export function parseRawSeedHex(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase().replace(/^0x/, '');
  if (clean.length === 0 || !/^[0-9a-f]+$/.test(clean)) {
    throw new WalletError('BAD_SEED_HEX', 'A raw seed must be hexadecimal.');
  }
  if (clean.length !== 64) {
    throw new WalletError(
      'BAD_SEED_HEX',
      clean.length === 128
        ? 'A raw BTQ seed is 32 bytes (64 hex characters). For a 12/24-word phrase, use Import seed phrase.'
        : `A raw BTQ seed is 32 bytes (64 hex characters), not ${clean.length / 2}.`,
    );
  }
  return hexToBytes(clean);
}

function defaultRandomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Distinct random word positions for the confirmation challenge (0-based). */
export function pickChallengeIndices(
  wordCount: number,
  count = 3,
  randomBytes: (n: number) => Uint8Array = defaultRandomBytes,
): number[] {
  if (count > wordCount) throw new Error('challenge longer than mnemonic');
  const idx = Array.from({ length: wordCount }, (_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const rb = randomBytes(4);
    const r = ((rb[0]! << 24) | (rb[1]! << 16) | (rb[2]! << 8) | rb[3]!) >>> 0;
    const j = r % (i + 1);
    const tmp = idx[i]!;
    idx[i] = idx[j]!;
    idx[j] = tmp;
  }
  return idx.slice(0, count).sort((a, b) => a - b);
}

export function assertPassword(password: string): void {
  if (password.length < 8) {
    throw new WalletError('WEAK_PASSWORD', 'Password must be at least 8 characters.');
  }
  if (password !== password.trim()) {
    throw new WalletError('WEAK_PASSWORD', 'Password cannot start or end with a space.');
  }
}
