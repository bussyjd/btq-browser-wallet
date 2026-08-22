/**
 * Byte primitives shared by the script, transaction and crypto layers.
 *
 * These lived in three places (serialize.ts, p2mr.ts, hd.ts) with three
 * slightly different implementations. One definition each keeps the
 * consensus-critical encodings (compact size, byte ordering) honest.
 * Browser-safe: no Node Buffer, no I/O.
 */

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Constant-shape equality for scripts/hashes. Not constant-time — no secrets pass here. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Lexicographic compare, as BIP341 orders merkle siblings. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/**
 * Bitcoin compact-size / varint encoding (BTQ inherits it unchanged).
 * The 9-byte form cannot appear in anything this wallet builds, so it throws
 * rather than silently truncating.
 */
export function compactSize(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) throw new Error('compact size must be a non-negative integer');
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff]);
  if (n <= 0xffffffff) {
    return new Uint8Array([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
  }
  throw new Error('compact size too large');
}

/**
 * Decode a compact size at `offset`. Returns the value and the next offset.
 *
 * The encoding is canonical: every value has exactly one representation, the
 * shortest one. `0xfd 0x01 0x00` is not "1", it is a malformed transaction, and
 * btq-core's own deserializer says so — `src/serialize.h:361-390`
 * `ReadCompactSize` throws "non-canonical ReadCompactSize()" for a 253-form
 * below 253, a 254-form below 0x10000, or a 255-form below 0x100000000. The
 * bounds below are those three, unchanged. A decoder that accepts the long
 * forms hands back a `Tx` that re-serialises to different bytes than the ones
 * it was given, and the approval screen is built out of exactly that re-decode.
 */
export function readCompactSize(bytes: Uint8Array, offset: number): { value: number; offset: number } {
  const first = bytes[offset];
  if (first === undefined) throw new Error('truncated compact size');
  if (first < 0xfd) return { value: first, offset: offset + 1 };
  if (first === 0xfd) {
    const v = readUintLE(bytes, offset + 1, 2);
    if (v < 0xfdn) throw new Error('non-canonical compact size');
    return { value: Number(v), offset: offset + 3 };
  }
  if (first === 0xfe) {
    const v = readUintLE(bytes, offset + 1, 4);
    if (v < 0x1_0000n) throw new Error('non-canonical compact size');
    return { value: Number(v), offset: offset + 5 };
  }
  const v = readUintLE(bytes, offset + 1, 8);
  if (v < 0x1_0000_0000n) throw new Error('non-canonical compact size');
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('compact size too large');
  return { value: Number(v), offset: offset + 9 };
}

/** Little-endian unsigned integer of `size` bytes as a bigint. */
export function readUintLE(bytes: Uint8Array, offset: number, size: number): bigint {
  if (offset + size > bytes.length) throw new Error('truncated integer');
  let v = 0n;
  for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[offset + i]!);
  return v;
}
