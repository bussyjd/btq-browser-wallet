/** Bech32 grouping: keep `tbtq1` intact, then 4-character clusters. */
export function chunkAddress(address: string): string[] {
  const sep = address.indexOf('1');
  if (sep < 0) return [address];
  const prefix = address.slice(0, sep + 1);
  const rest = address.slice(sep + 1);
  const groups: string[] = [prefix];
  for (let i = 0; i < rest.length; i += 4) groups.push(rest.slice(i, i + 4));
  return groups;
}

/** Parse a tBTQ decimal amount into satoshis. */
export function parseBtqAmount(input: string): bigint {
  const t = input.trim();
  if (!t || !/^\d+(\.\d{1,8})?$/.test(t)) throw new Error('Enter an amount like 0.01');
  const [w, f = ''] = t.split('.');
  const frac = (f + '00000000').slice(0, 8);
  return BigInt(w || '0') * 100_000_000n + BigInt(frac);
}

export function formatSats(sats: bigint): string {
  const neg = sats < 0n;
  const n = neg ? -sats : sats;
  const whole = n / 100_000_000n;
  const frac = (n % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  const body = frac.length === 0 ? whole.toString() : `${whole.toString()}.${frac}`;
  return neg ? `-${body}` : body;
}
