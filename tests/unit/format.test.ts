import { describe, it, expect } from 'vitest';
import { chunkAddress, formatSats, parseBtqAmount } from '../../src/core/wallet/format.js';
import vectors from '../vectors/golden.json' with { type: 'json' };

describe('amount parsing on the send path', () => {
  it('parses whole and fractional tBTQ to satoshis', () => {
    // This is the only conversion between what the user types and what gets
    // signed: a factor-of-ten slip here sends ten times the intended amount.
    expect(parseBtqAmount('1')).toBe(100_000_000n);
    expect(parseBtqAmount('0.01')).toBe(1_000_000n);
    expect(parseBtqAmount('0.00000001')).toBe(1n);
    expect(parseBtqAmount('12.5')).toBe(1_250_000_000n);
    expect(parseBtqAmount('0')).toBe(0n);
    expect(parseBtqAmount(' 2 ')).toBe(200_000_000n);
    expect(parseBtqAmount('0.10000000')).toBe(10_000_000n);
  });

  it('refuses anything it cannot convert exactly', () => {
    // Silently truncating a 9th decimal, or reading "1e8", would sign an
    // amount the user never approved.
    for (const bad of ['', '.', '.5', '1.', '1.123456789', '-1', '1e8', 'abc', '1,5', '0x10', '1 2', '١']) {
      expect(() => parseBtqAmount(bad), bad).toThrow(/Enter an amount/);
    }
  });

  it('round-trips through formatSats', () => {
    for (const s of ['0.00000001', '1', '12.5', '0.001']) {
      expect(formatSats(parseBtqAmount(s))).toBe(s.replace(/0+$/, '').replace(/\.$/, ''));
    }
    expect(formatSats(0n)).toBe('0');
    expect(formatSats(-1_000_000n)).toBe('-0.01');
    expect(formatSats(2_100_000_000_000_000n)).toBe('21000000');
  });
});

describe('address chunking', () => {
  it('keeps the tbtq1 prefix intact and groups the rest in fours', () => {
    const address = vectors.entries[0]!.addresses.testnet;
    const groups = chunkAddress(address);
    expect(groups[0]).toBe('tbtq1');
    expect(groups.join('')).toBe(address);
    expect(groups.slice(1).every((g) => g.length <= 4)).toBe(true);
  });
});
