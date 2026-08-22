import { describe, it, expect } from 'vitest';
import {
  addressForOutputScript,
  decodeTxPreview,
  parseTx,
  reserializesIdentically,
  TxParseError,
} from '../../src/core/tx/parse.js';
import {
  DEFAULT_SEQUENCE,
  serializeStripped,
  serializeWithWitness,
  type Tx,
} from '../../src/core/tx/serialize.js';
import { bytesToHex, hexToBytes } from '../../src/core/util/hex.js';
import { encodeAddress, scriptForAddress } from '../../src/core/script/address.js';
import vectors from '../vectors/golden.json' with { type: 'json' };

const e0 = vectors.entries[0]!;
const e1 = vectors.entries[1]!;
const SCRIPT0 = hexToBytes(e0.scriptPubKey);
const SCRIPT1 = hexToBytes(e1.scriptPubKey);
/** A legacy Dilithium P2PKH script as seen on the live chain (76a914…88bb). */
const LEGACY_SCRIPT = hexToBytes('76a914f0bd29f1f7684c0654408dc2133f2308c699e03c88bb');

function witnessOf(size: number, fill: number): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

const shapes: { name: string; tx: Tx }[] = [
  {
    name: '1-in 2-out with witness',
    tx: {
      version: 2,
      locktime: 0,
      inputs: [
        {
          txid: 'aa'.repeat(32),
          vout: 1,
          sequence: DEFAULT_SEQUENCE,
          witness: [witnessOf(2421, 7), witnessOf(1316, 9), new Uint8Array([0xc1])],
        },
      ],
      outputs: [
        { value: 10_000_000n, script: SCRIPT1 },
        { value: 89_999_628n, script: SCRIPT0 },
      ],
    },
  },
  {
    name: '3-in 1-out with witness and a legacy output script',
    tx: {
      version: 2,
      locktime: 500_000,
      inputs: [0, 1, 2].map((n) => ({
        txid: n.toString(16).padStart(64, '0'),
        vout: n,
        sequence: 0xfffffffe,
        witness: [witnessOf(2421, n + 1), witnessOf(1316, n + 2), new Uint8Array([0xc1])],
      })),
      outputs: [{ value: 825_999_773n, script: LEGACY_SCRIPT }],
    },
  },
  {
    name: 'no witness (stripped form)',
    tx: {
      version: 1,
      locktime: 0,
      inputs: [{ txid: 'bb'.repeat(32), vout: 0, sequence: 0xffffffff }],
      outputs: [{ value: 1n, script: SCRIPT0 }],
    },
  },
  {
    name: '300 outputs (compact size crosses 0xfd)',
    tx: {
      version: 2,
      locktime: 7,
      inputs: [{ txid: 'cc'.repeat(32), vout: 4, sequence: DEFAULT_SEQUENCE }],
      outputs: Array.from({ length: 300 }, (_, i) => ({ value: BigInt(1000 + i), script: SCRIPT1 })),
    },
  },
];

describe('raw transaction parser', () => {
  for (const { name, tx } of shapes) {
    it(`round-trips ${name} through serializeWithWitness`, () => {
      const raw = serializeWithWitness(tx);
      expect(parseTx(raw)).toEqual(tx);
      expect(reserializesIdentically(raw)).toBe(true);
    });

    it(`round-trips ${name} through serializeStripped`, () => {
      const stripped = serializeStripped(tx);
      const parsed = parseTx(stripped);
      expect(parsed.version).toBe(tx.version);
      expect(parsed.locktime).toBe(tx.locktime);
      expect(parsed.outputs).toEqual(tx.outputs);
      expect(parsed.inputs.map((i) => ({ txid: i.txid, vout: i.vout, sequence: i.sequence }))).toEqual(
        tx.inputs.map((i) => ({ txid: i.txid, vout: i.vout, sequence: i.sequence })),
      );
      expect(parsed.inputs.every((i) => i.witness === undefined)).toBe(true);
    });
  }

  it('accepts hex as well as bytes', () => {
    const raw = serializeWithWitness(shapes[0]!.tx);
    expect(parseTx(bytesToHex(raw))).toEqual(shapes[0]!.tx);
  });

  it('rejects truncated, trailing-byte and malformed input', () => {
    // A parser that quietly accepts junk would let a corrupted stored hex be
    // re-broadcast as a different transaction than the one we signed.
    const raw = serializeWithWitness(shapes[0]!.tx);
    expect(() => parseTx(raw.subarray(0, raw.length - 1))).toThrow(TxParseError);
    const extra = new Uint8Array(raw.length + 1);
    extra.set(raw);
    expect(() => parseTx(extra)).toThrow(/trailing bytes/);
    expect(() => parseTx(new Uint8Array(4))).toThrow(/too short/);
    expect(reserializesIdentically(new Uint8Array(40))).toBe(false);
  });

  it('rejects a non-empty scriptSig on a P2MR spend', () => {
    // Witness-v2 spends carry no scriptSig; anything there is a different
    // (non-standard) transaction than the one this wallet builds.
    const raw = serializeWithWitness(shapes[2]!.tx);
    const withSig = new Uint8Array(raw.length + 2);
    // version(4) + count(1) + outpoint(36) => scriptSig length byte at offset 41
    withSig.set(raw.subarray(0, 41), 0);
    withSig.set(new Uint8Array([0x01, 0x51]), 41);
    withSig.set(raw.subarray(42), 43);
    expect(() => parseTx(withSig)).toThrow(/scriptSig/);
  });
});

describe('decoded preview', () => {
  it('recovers the destination address from the output script', () => {
    // This is what makes the approval screen trustworthy: the address shown is
    // the one the bytes actually pay, not the string we typed into the plan.
    const preview = decodeTxPreview(serializeWithWitness(shapes[0]!.tx));
    expect(preview.outputs[0]!.address).toBe(e1.addresses.testnet);
    expect(preview.outputs[0]!.value).toBe('10000000');
    expect(preview.outputs[1]!.address).toBe(e0.addresses.testnet);
    expect(preview.inputs[0]!.witnessItems).toBe(3);
    expect(preview.hasWitness).toBe(true);
    expect(preview.vsize).toBe(Math.ceil(preview.weight / 16));
  });

  it('reports a non-P2MR output as having no address instead of guessing', () => {
    const preview = decodeTxPreview(serializeWithWitness(shapes[1]!.tx));
    expect(preview.outputs[0]!.address).toBeNull();
    expect(preview.outputs[0]!.script).toBe(bytesToHex(LEGACY_SCRIPT));
  });

  it('address round-trips through scriptForAddress', () => {
    const address = encodeAddress(SCRIPT1.subarray(2), 'testnet');
    expect(addressForOutputScript(scriptForAddress(address, 'testnet'), 'testnet')).toBe(address);
    expect(addressForOutputScript(new Uint8Array([0x52, 0x20]), 'testnet')).toBeNull();
  });
});
