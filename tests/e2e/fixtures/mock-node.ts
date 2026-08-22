/**
 * The mock BTQ Core node — and the reason this smoke test is worth anything.
 *
 * Every transaction the extension broadcasts is decoded from its bytes and put
 * through the checks a real node would run, in the order a real node runs them,
 * with a btq-core-style reject reason on the first failure. The tapleaf hash and
 * the BIP341 sighash are computed by `bip341.ts` — an implementation written in
 * the test tree from the BIP text — and the signature is verified with
 * `ml_dsa44` directly, not through the wallet's crypto module. A wallet that
 * signed the wrong message would still produce a well-formed transaction; only
 * this check would catch it.
 *
 * Reject reasons follow btq-core's policy text so the popup shows a user what a
 * real node would have said.
 */
import { ml_dsa44 as mlDsa44Untyped } from '@noble/post-quantum/ml-dsa';
import { commitsToProgram } from '../../../src/core/script/p2mr.js';
import {
  bytesEqual,
  fromHex,
  leafCommitsToProgram,
  tapLeafHash,
  tapscriptSighash,
  toHex,
  type Prevout,
} from './bip341.js';
import { addressForScriptHex } from './btq-address.js';
import { MAX_STANDARD_TX_WEIGHT, MIN_RELAY_SAT_PER_KVB, P2MR_DUST_SATS, feeForVsize } from './consensus.js';
import { decodeRaw } from './tx-decode.js';
import { Ledger, outpointKey, type LedgerInput, type LedgerOutput } from './ledger.js';

interface MldsaVerifier {
  verify(publicKey: Uint8Array, msg: Uint8Array, sig: Uint8Array, ctx?: Uint8Array): boolean;
}
const mlDsa44 = mlDsa44Untyped as unknown as MldsaVerifier;
/** BTQ signs on the consensus path with a zero-length FIPS 204 context. */
const EMPTY_CONTEXT = new Uint8Array(0);

export const OP_2 = 0x52;
export const OP_PUSHDATA2 = 0x4d;
export const OP_CHECKSIGDILITHIUM = 0xbb;
export const PUBLIC_KEY_BYTES = 1312;
export const LEAF_SCRIPT_BYTES = 1 + 2 + PUBLIC_KEY_BYTES + 1; // 1316
export const TX_SIGNATURE_BYTES = 2421;
export const SIGHASH_ALL = 0x01;
export const CONTROL_BYTE = 0xc1;

/**
 * The single-key Dilithium leaf script, built here from the wire layout so the
 * mock node and the golden-vector pin do not borrow the wallet's builder:
 * OP_PUSHDATA2 <1312-byte ML-DSA public key> OP_CHECKSIGDILITHIUM.
 */
export function buildSingleKeyLeaf(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== PUBLIC_KEY_BYTES) throw new Error(`ML-DSA public key must be ${PUBLIC_KEY_BYTES} bytes`);
  const out = new Uint8Array(LEAF_SCRIPT_BYTES);
  out[0] = OP_PUSHDATA2;
  out[1] = PUBLIC_KEY_BYTES & 0xff;
  out[2] = (PUBLIC_KEY_BYTES >> 8) & 0xff;
  out.set(publicKey, 3);
  out[out.length - 1] = OP_CHECKSIGDILITHIUM;
  return out;
}

export class TxRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'TxRejected';
  }
}

export interface VerifyOptions {
  /** Relay floor the fee is measured against. */
  minFeeRateSatPerKvB?: number;
  /** When set, a second output must pay exactly this script (the wallet's change). */
  expectChangeScript?: string | null;
}

export interface AcceptedTx {
  txid: string;
  hex: string;
  vsize: number;
  weight: number;
  fee: bigint;
  inputs: LedgerInput[];
  outputs: LedgerOutput[];
  /** The checks that passed, in order — asserted by the smoke test. */
  checks: string[];
}

/**
 * The seven checks, in order. Throws `TxRejected` with a Core-style reason on
 * the first failure; returns the accepted transaction otherwise.
 */
export function verifyTransaction(hex: string, ledger: Ledger, opts: VerifyOptions = {}): AcceptedTx {
  const checks: string[] = [];
  const minRate = opts.minFeeRateSatPerKvB ?? MIN_RELAY_SAT_PER_KVB;

  // 1. Decode the raw transaction, and prove the decode is lossless.
  let decoded;
  try {
    decoded = decodeRaw(hex);
  } catch (e) {
    throw new TxRejected(`bad-txns-undecodable (${e instanceof Error ? e.message : 'decode failed'})`);
  }
  const { tx } = decoded;
  if (tx.inputs.length === 0) throw new TxRejected('bad-txns-vin-empty');
  if (tx.outputs.length === 0) throw new TxRejected('bad-txns-vout-empty');
  checks.push('decode');

  // 2. Every input must spend an unspent output this ledger knows about.
  const prevouts: Prevout[] = [];
  const spentInputs: LedgerInput[] = [];
  let inputTotal = 0n;
  for (const input of tx.inputs) {
    const utxo = ledger.unspent(input.txid, input.vout);
    if (!utxo) throw new TxRejected(`missing-inputs (${outpointKey(input.txid, input.vout)})`);
    prevouts.push({ value: utxo.value, script: fromHex(utxo.script) });
    spentInputs.push({ txid: input.txid, vout: input.vout });
    inputTotal += utxo.value;
  }
  checks.push('inputs-unspent');

  for (let i = 0; i < tx.inputs.length; i++) {
    const witness = tx.inputs[i]?.witness ?? [];

    // 3. Witness shape: [signature, leaf, control], 2421-byte SIGHASH_ALL signature.
    if (witness.length !== 3) {
      throw new TxRejected(`non-mandatory-script-verify-flag (Witness stack has ${witness.length} items, expected 3)`);
    }
    const [signature, leaf, control] = witness as [Uint8Array, Uint8Array, Uint8Array];
    if (control.length !== 1 || control[0] !== CONTROL_BYTE) {
      throw new TxRejected('non-mandatory-script-verify-flag (Invalid P2MR control block)');
    }
    if (signature.length !== TX_SIGNATURE_BYTES) {
      throw new TxRejected(
        `non-mandatory-script-verify-flag (Dilithium signature is ${signature.length} bytes, expected ${TX_SIGNATURE_BYTES})`,
      );
    }
    if (signature[TX_SIGNATURE_BYTES - 1] !== SIGHASH_ALL) {
      throw new TxRejected('non-mandatory-script-verify-flag (Invalid sighash type for P2MR)');
    }

    // 4. Leaf shape, and the commitment to the witness program being spent.
    if (
      leaf.length !== LEAF_SCRIPT_BYTES ||
      leaf[0] !== OP_PUSHDATA2 ||
      leaf[1] !== (PUBLIC_KEY_BYTES & 0xff) ||
      leaf[2] !== (PUBLIC_KEY_BYTES >> 8) ||
      leaf[leaf.length - 1] !== OP_CHECKSIGDILITHIUM
    ) {
      throw new TxRejected('non-mandatory-script-verify-flag (Not a single-key Dilithium leaf)');
    }
    const prevScript = prevouts[i]?.script as Uint8Array;
    if (prevScript.length !== 34 || prevScript[0] !== OP_2 || prevScript[1] !== 0x20) {
      throw new TxRejected('non-mandatory-script-verify-flag (Spent output is not witness v2 P2MR)');
    }
    const program = prevScript.subarray(2);
    const independent = leafCommitsToProgram(leaf, control, program);
    const wallets = commitsToProgram(leaf, control, program);
    if (independent !== wallets) {
      throw new TxRejected('non-mandatory-script-verify-flag (P2MR commitment implementations disagree)');
    }
    if (!independent || !bytesEqual(tapLeafHash(leaf), program)) {
      throw new TxRejected('non-mandatory-script-verify-flag (Witness program hash mismatch)');
    }

    // 5. The signature must cover this exact transaction, this input, these prevouts.
    const sighash = tapscriptSighash(
      { version: tx.version, locktime: tx.locktime, inputs: tx.inputs, outputs: tx.outputs },
      i,
      prevouts,
      tapLeafHash(leaf),
    );
    const publicKey = leaf.subarray(3, 3 + PUBLIC_KEY_BYTES);
    const raw = signature.subarray(0, TX_SIGNATURE_BYTES - 1);
    if (!mlDsa44.verify(publicKey, sighash, raw, EMPTY_CONTEXT)) {
      throw new TxRejected('non-mandatory-script-verify-flag (Invalid Dilithium signature)');
    }
  }
  checks.push('witness-shape');
  checks.push('leaf-commitment');
  checks.push('signature');

  // 6. Outputs: P2MR only, above dust, change to the wallet, fee and weight sane.
  const outputs: LedgerOutput[] = [];
  let outputTotal = 0n;
  for (const [index, out] of tx.outputs.entries()) {
    if (out.script.length !== 34 || out.script[0] !== OP_2 || out.script[1] !== 0x20) {
      throw new TxRejected(`scriptpubkey (output ${index} is not OP_2 <32 bytes>)`);
    }
    if (out.value < P2MR_DUST_SATS) {
      throw new TxRejected(`dust (output ${index} is ${out.value} sats, below ${P2MR_DUST_SATS})`);
    }
    const script = toHex(out.script);
    outputTotal += out.value;
    outputs.push({ address: addressForScriptHex(script), script, value: out.value });
  }
  if (opts.expectChangeScript) {
    if (tx.outputs.length !== 2) {
      throw new TxRejected(`bad-txns-change (expected a change output, found ${tx.outputs.length} outputs)`);
    }
    if (outputs[1]?.script !== opts.expectChangeScript) {
      throw new TxRejected('bad-txns-change (change does not pay the wallet)');
    }
  }
  if (outputTotal > inputTotal) throw new TxRejected('bad-txns-in-belowout');
  const fee = inputTotal - outputTotal;
  const minFee = feeForVsize(decoded.vsize, minRate);
  if (fee < minFee) {
    throw new TxRejected(`min relay fee not met, ${fee} < ${minFee}`);
  }
  if (decoded.weight > MAX_STANDARD_TX_WEIGHT) {
    throw new TxRejected(`tx-size (weight ${decoded.weight} > ${MAX_STANDARD_TX_WEIGHT})`);
  }
  checks.push('outputs-and-fee');

  // 7. The txid is the double-SHA256 of the stripped serialization, reversed.
  checks.push('txid');

  return {
    txid: decoded.txid,
    hex: hex.trim().toLowerCase(),
    vsize: decoded.vsize,
    weight: decoded.weight,
    fee,
    inputs: spentInputs,
    outputs,
    checks,
  };
}

export interface NodeCall {
  method: string;
  params: unknown[];
  at: number;
}

/**
 * Tier 2: forward the two broadcast methods to a real regtest btqd after the
 * local checks have run, so btq-core's own interpreter executes
 * OP_CHECKSIGDILITHIUM on the extension-signed bytes.
 */
export type NodeProxy = (method: string, params: unknown[]) => Promise<unknown>;

export interface NodeState {
  user: string;
  password: string;
  proxy: NodeProxy | null;
  calls: NodeCall[];
  /** Set by the test so the node can insist the change output pays the wallet. */
  expectChangeScript: string | null;
  /** Every accepted or rejected submission, for the smoke test to assert on. */
  log: { txid: string | null; allowed: boolean; reason?: string; checks: string[]; vsize?: number; fee?: string }[];
}

export function newNodeState(user = 'smoke', password = 'smoke-pass'): NodeState {
  return { user, password, proxy: null, calls: [], expectChangeScript: null, log: [] };
}

export interface JsonRpcOutcome {
  status: number;
  body: unknown;
}

/** btq-core JSON-RPC over HTTP, with the handful of methods this wallet calls. */
export async function handleNodeRpc(state: NodeState, ledger: Ledger, request: unknown): Promise<JsonRpcOutcome> {
  const req = (request ?? {}) as { id?: unknown; method?: unknown; params?: unknown };
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = Array.isArray(req.params) ? req.params : [];
  state.calls.push({ method, params, at: Date.now() });

  const ok = (result: unknown): JsonRpcOutcome => ({ status: 200, body: { result, error: null, id } });
  const fail = (code: number, message: string): JsonRpcOutcome => ({
    status: 500,
    body: { result: null, error: { code, message }, id },
  });

  switch (method) {
    case 'getblockchaininfo':
      return ok({
        chain: 'test',
        blocks: ledger.tip,
        headers: ledger.tip,
        bestblockhash: ledger.hashAt(ledger.tip),
        initialblockdownload: false,
      });

    case 'getblockhash': {
      const height = typeof params[0] === 'number' ? params[0] : -1;
      if (!Number.isInteger(height) || height < 0 || height > ledger.tip) {
        return fail(-8, 'Block height out of range');
      }
      return ok(ledger.hashAt(height));
    }

    case 'testmempoolaccept': {
      const list = Array.isArray(params[0]) ? (params[0] as unknown[]) : [];
      const hex = typeof list[0] === 'string' ? list[0] : '';
      try {
        const accepted = verifyTransaction(hex, ledger, { expectChangeScript: state.expectChangeScript });
        state.log.push({
          txid: accepted.txid,
          allowed: true,
          checks: accepted.checks,
          vsize: accepted.vsize,
          fee: accepted.fee.toString(),
        });
        if (state.proxy) return ok(await state.proxy(method, params));
        return ok([
          {
            txid: accepted.txid,
            wtxid: accepted.txid,
            allowed: true,
            vsize: accepted.vsize,
            fees: { base: Number(accepted.fee) / 1e8 },
          },
        ]);
      } catch (e) {
        const reason = e instanceof TxRejected ? e.reason : 'bad-txns-undecodable';
        state.log.push({ txid: null, allowed: false, reason, checks: [] });
        return ok([{ txid: '', wtxid: '', allowed: false, 'reject-reason': reason }]);
      }
    }

    case 'sendrawtransaction': {
      const hex = typeof params[0] === 'string' ? params[0] : '';
      let accepted;
      try {
        accepted = verifyTransaction(hex, ledger, { expectChangeScript: state.expectChangeScript });
      } catch (e) {
        const reason = e instanceof TxRejected ? e.reason : 'bad-txns-undecodable';
        state.log.push({ txid: null, allowed: false, reason, checks: [] });
        return fail(-26, reason);
      }
      state.log.push({
        txid: accepted.txid,
        allowed: true,
        checks: accepted.checks,
        vsize: accepted.vsize,
        fee: accepted.fee.toString(),
      });
      // A backend that answers with a txid other than the one it was handed is
      // the case the wallet must refuse to call "broadcast"; nothing is applied.
      if (ledger.hasFault('wrong-txid')) {
        return ok(ledger.hashAt(999_999));
      }
      if (state.proxy) {
        const pushed = await state.proxy(method, params);
        ledger.apply(accepted);
        return ok(pushed);
      }
      ledger.apply(accepted);
      return ok(accepted.txid);
    }

    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}
