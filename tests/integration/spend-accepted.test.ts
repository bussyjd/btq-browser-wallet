/**
 * MILESTONE 0 — a transaction our wallet signs must be accepted by btq-core.
 *
 * This exercises the whole signing path against real consensus code: BIP341
 * tapscript sighash, ML-DSA-44 signature with an empty context, the mandatory
 * SIGHASH_ALL byte, and the [signature, leafScript, controlBlock] witness.
 * `testmempoolaccept` runs the real interpreter, so acceptance means the
 * signature verified under OP_CHECKSIGDILITHIUM.
 *
 * Run:  BTQ_REGTEST=1 npx vitest run tests/integration
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { rpc, rpcConfigFromEnv, hex } from './rpc.js';
import { keyPairFromSeed, signTransactionHash } from '../../src/core/crypto/mldsa.js';
import { masterFromSeed, deriveKeySeed } from '../../src/core/crypto/hd.js';
import { singleKeyLeafScript, merkleRootForPublicKey, outputScript, singleLeafControlBlock, tapLeafHash } from '../../src/core/script/p2mr.js';
import { addressForPublicKey } from '../../src/core/script/address.js';
import { serializeWithWitness, DEFAULT_SEQUENCE, type Tx } from '../../src/core/tx/serialize.js';
import { p2mrSighash } from '../../src/core/tx/sighash.js';

const cfg = rpcConfigFromEnv();
const maybe = cfg ? describe : describe.skip;

maybe('btq-core accepts a wallet-signed P2MR spend', () => {
  const master = masterFromSeed(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]));
  const keySeed = deriveKeySeed(master, 'external', 5);
  const { publicKey } = keyPairFromSeed(keySeed);
  const address = addressForPublicKey(publicKey, 'regtest');
  const script = outputScript(merkleRootForPublicKey(publicKey));

  let fundingTxid = '';
  let vout = -1;
  let value = 0n;

  beforeAll(async () => {
    const miner = await rpc<string>(cfg!, 'getnewaddress', []);
    const height = await rpc<number>(cfg!, 'getblockcount', [], false);
    if (height < 101) await rpc(cfg!, 'generatetoaddress', [101, miner], false);
    // Pay our P2MR address, then locate the output by its scriptPubKey.
    fundingTxid = await rpc<string>(cfg!, 'sendtoaddress', [address, 1.0]);
    await rpc(cfg!, 'generatetoaddress', [1, miner], false);
    const walletTx = await rpc<{ hex: string }>(cfg!, 'gettransaction', [fundingTxid, true]);
    const raw = await rpc<any>(cfg!, 'decoderawtransaction', [walletTx.hex], false);
    const target = hex(script);
    for (const o of raw.vout) {
      if (String(o.scriptPubKey.hex).toLowerCase() === target) {
        vout = o.n;
        value = BigInt(Math.round(Number(o.value) * 1e8));
      }
    }
    expect(vout, 'funding output must be found by scriptPubKey').toBeGreaterThanOrEqual(0);
  });

  it('funds a P2MR address the node recognises as ours', () => {
    expect(value).toBe(100_000_000n);
  });

  it('signs a spend that testmempoolaccept accepts', async () => {
    const destination = addressForPublicKey(
      keyPairFromSeed(deriveKeySeed(master, 'internal', 0)).publicKey, 'regtest',
    );
    const destScript = outputScript(
      merkleRootForPublicKey(keyPairFromSeed(deriveKeySeed(master, 'internal', 0)).publicKey),
    );
    const fee = 50_000n; // generous on regtest; scale-16 fee math is exercised in unit tests

    const tx: Tx = {
      version: 2,
      locktime: 0,
      inputs: [{ txid: fundingTxid, vout, sequence: DEFAULT_SEQUENCE }],
      outputs: [{ value: value - fee, script: destScript }],
    };

    const leaf = singleKeyLeafScript(publicKey);
    const sighash = p2mrSighash(tx, 0, [{ value, script }], tapLeafHash(leaf));
    const signature = signTransactionHash(keySeed, sighash);
    tx.inputs[0]!.witness = [signature, leaf, singleLeafControlBlock()];

    const rawHex = hex(serializeWithWitness(tx));
    const [result] = await rpc<any[]>(cfg!, 'testmempoolaccept', [[rawHex]], false);

    expect(result['reject-reason'] ?? null, `node rejected: ${result['reject-reason']}`).toBeNull();
    expect(result.allowed).toBe(true);
    expect(destination.startsWith('qcrt1z')).toBe(true);
  });

  it('rejects a spend signed over a tampered digest', async () => {
    const tx: Tx = {
      version: 2,
      locktime: 0,
      inputs: [{ txid: fundingTxid, vout, sequence: DEFAULT_SEQUENCE }],
      outputs: [{ value: value - 50_000n, script }],
    };
    const leaf = singleKeyLeafScript(publicKey);
    const wrong = new Uint8Array(32).fill(0xab); // not this transaction's sighash
    tx.inputs[0]!.witness = [signTransactionHash(keySeed, wrong), leaf, singleLeafControlBlock()];
    const [result] = await rpc<any[]>(cfg!, 'testmempoolaccept', [[hex(serializeWithWitness(tx))]], false);
    expect(result.allowed).toBe(false);
  });
});
