/** Hex helpers. The core layer must stay browser-safe: no Node Buffer anywhere. */
export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('hex string must have an even length');
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error('invalid hex string');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function reverseBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes).reverse();
}

/** Best-effort wipe. JavaScript strings are immutable; only byte buffers can be cleared. */
export function wipeBytes(bytes: Uint8Array): void {
  bytes.fill(0);
}
