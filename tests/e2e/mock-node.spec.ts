/**
 * The mock node's own checks, checked.
 *
 * `fixtures/mock-node.ts` is what makes the rest of this suite worth running:
 * it decodes the bytes the extension broadcast and puts them through the checks
 * a real node would run. A check that cannot fail is worse than no check, since
 * the `checks` array the journeys assert on would still name it — so the one
 * check that has nothing to reject a transaction *for* is exercised here
 * directly, on transactions built in this file.
 *
 * No browser and no extension: this runs against the fixture code alone.
 */
import { expect, test } from '@playwright/test';
import { fromHex, reverse, sha256d, toHex } from './fixtures/bip341.js';
import { TxRejected, checkTxid } from './fixtures/mock-node.js';
import { decodeRaw, serializeStripped, serializeWithWitness, type Tx } from './fixtures/tx-decode.js';

/** A structurally valid segwit transaction. Nothing here has to be spendable. */
function sampleTx(): Tx {
  return {
    version: 2,
    locktime: 0,
    inputs: [
      {
        txid: 'aa'.repeat(32),
        vout: 1,
        sequence: 0xfffffffd,
        // Stands in for [signature, leaf, control]; only its presence matters.
        witness: [new Uint8Array(9).fill(0x11), new Uint8Array(4).fill(0x22), new Uint8Array([0xc1])],
      },
    ],
    outputs: [{ value: 25_000_000n, script: fromHex(`0220${'33'.repeat(32)}`) }],
  };
}

test('the txid a transaction is accepted under is the hash of its stripped bytes', () => {
  const tx = sampleTx();
  const decoded = decodeRaw(toHex(serializeWithWitness(tx)));

  // Independent of the decoder: hash the stripped serialization here.
  const expected = toHex(reverse(sha256d(serializeStripped(tx))));
  expect(checkTxid(decoded)).toBe(expected);
  expect(decoded.txid).toBe(expected);
  expect(expected).toMatch(/^[0-9a-f]{64}$/);
});

test('a txid that does not hash from the stripped bytes is rejected', () => {
  const decoded = decodeRaw(toHex(serializeWithWitness(sampleTx())));
  const lying = { ...decoded, txid: 'ff'.repeat(32) };

  expect(() => checkTxid(lying)).toThrow(TxRejected);
  expect(() => checkTxid(lying)).toThrow(/bad-txns-txid/);
});

test('an id that is not independent of the witness is rejected', () => {
  const decoded = decodeRaw(toHex(serializeWithWitness(sampleTx())));
  // The state a stripped serialization that quietly kept the witness would
  // produce: the two serializations hash to the same id, so re-encoding a
  // signature would move the id the wallet and the explorer index by.
  const malleable = { ...decoded, raw: serializeStripped(decoded.tx) };
  expect(toHex(reverse(sha256d(malleable.raw)))).toBe(malleable.txid);

  expect(() => checkTxid(malleable)).toThrow(TxRejected);
  expect(() => checkTxid(malleable)).toThrow(/not independent of the witness/);
});
