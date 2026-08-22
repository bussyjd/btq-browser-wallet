/**
 * Build and sign a single-key P2MR send. Leaves are always constructed here
 * from the wallet's own key, and every leaf is checked with commitsToProgram()
 * against the witness program of the output being spent before it is signed.
 * There is no path that signs a caller-supplied leaf.
 */
import { publicKeyFromSeed, signTransactionHash, TX_SIGNATURE_BYTES, SIGHASH_ALL } from '../crypto/mldsa.js';
import {
  commitsToProgram,
  merkleRootForPublicKey,
  outputScript,
  singleKeyLeafScript,
  singleLeafControlBlock,
  tapLeafHash,
} from '../script/p2mr.js';
import { scriptForAddress } from '../script/address.js';
import { WalletError } from '../wallet/errors.js';
import { assertDestination } from '../wallet/destination.js';
import { bytesToHex } from '../util/hex.js';
import { bytesEqual } from '../util/bytes.js';
import { DEFAULT_SEQUENCE, serializeWithWitness, serializeStripped, type Tx } from './serialize.js';
import { decodeTxPreview, type DecodedTx } from './parse.js';
import { p2mrSighash, txid, type SpentOutput } from './sighash.js';
import { selectCoins, type OwnedUtxo } from './coinselect.js';
import {
  assertFeeRate,
  feeForP2mrTx,
  MIN_RELAY_SAT_PER_KVB,
  P2MR_INPUT_WEIGHT,
  transactionWeight,
  virtualSizeCeil,
} from './fee.js';

export interface SendPlan {
  tx: Tx;
  spent: SpentOutput[];
  inputs: OwnedUtxo[];
  destination: string;
  amount: bigint;
  change: bigint;
  changeAddress: string | null;
  fee: bigint;
  feeRateSatPerKvB: number;
  /** Estimated weight/vsize of the signed transaction, at scale 16. */
  weight: number;
  vsize: number;
}

export interface SignedSend {
  tx: Tx;
  hex: string;
  txid: string;
  fee: bigint;
  weight: number;
  vsize: number;
  destination: string;
  amount: bigint;
  change: bigint;
  inputs: { txid: string; vout: number; value: string; address: string }[];
  outputs: { address: string; value: string }[];
}

export function assertCanSignLeaf(leaf: Uint8Array, control: Uint8Array, program: Uint8Array): void {
  if (!commitsToProgram(leaf, control, program)) {
    throw new WalletError(
      'NO_COMMITMENT',
      'Refusing to sign a leaf that does not commit to the output being spent.',
    );
  }
}

export function planSend(opts: {
  utxos: readonly OwnedUtxo[];
  destination: string;
  amount: bigint;
  changeAddress: string;
  feeRateSatPerKvB?: number;
}): SendPlan {
  const dest = assertDestination(opts.destination, 'testnet');
  const destScript = outputScript(dest.merkleRoot);
  const feeRate = assertFeeRate(opts.feeRateSatPerKvB ?? MIN_RELAY_SAT_PER_KVB);
  const sel = selectCoins(opts.utxos, opts.amount, feeRate);

  const outputs: Tx['outputs'] = [{ value: opts.amount, script: destScript }];
  let changeAddress: string | null = null;
  if (sel.change > 0n) {
    const changeScript = scriptForAddress(opts.changeAddress, 'testnet');
    outputs.push({ value: sel.change, script: changeScript });
    changeAddress = opts.changeAddress;
  }

  const tx: Tx = {
    version: 2,
    locktime: 0,
    inputs: sel.inputs.map((u) => ({ txid: u.txid, vout: u.vout, sequence: DEFAULT_SEQUENCE })),
    outputs,
  };
  const spent: SpentOutput[] = sel.inputs.map((u) => ({ value: u.value, script: u.script }));
  return {
    tx,
    spent,
    inputs: sel.inputs,
    destination: opts.destination,
    amount: opts.amount,
    change: sel.change,
    changeAddress,
    fee: sel.fee,
    feeRateSatPerKvB: feeRate,
    weight: sel.weight,
    vsize: virtualSizeCeil(sel.weight),
  };
}

export function signPlan(plan: SendPlan, keySeedFor: (utxo: OwnedUtxo) => Uint8Array): SignedSend {
  const tx: Tx = {
    version: plan.tx.version,
    locktime: plan.tx.locktime,
    inputs: plan.tx.inputs.map((i) => ({ ...i })),
    outputs: plan.tx.outputs.map((o) => ({ ...o, script: new Uint8Array(o.script) })),
  };

  for (let i = 0; i < plan.inputs.length; i++) {
    const utxo = plan.inputs[i]!;
    const program = utxo.script.subarray(2); // OP_2 <32-byte program>
    const seed = keySeedFor(utxo);
    const pk = publicKeyFromSeed(seed);
    const leaf = singleKeyLeafScript(pk);
    const control = singleLeafControlBlock();
    // Never sign a leaf that does not commit to the program being spent.
    assertCanSignLeaf(leaf, control, program);
    // Defence: the script we spend must be the one this key actually pays.
    if (!bytesEqual(outputScript(merkleRootForPublicKey(pk)), utxo.script)) {
      throw new WalletError('NO_COMMITMENT', 'UTXO script does not match the derived key.');
    }
    const sighash = p2mrSighash(tx, i, plan.spent, tapLeafHash(leaf));
    const signature = signTransactionHash(seed, sighash);
    if (signature.length !== TX_SIGNATURE_BYTES || signature[TX_SIGNATURE_BYTES - 1] !== SIGHASH_ALL) {
      throw new Error('signature is not a 2421-byte SIGHASH_ALL witness item');
    }
    tx.inputs[i]!.witness = [signature, leaf, control];
  }

  const raw = serializeWithWitness(tx);
  const stripped = serializeStripped(tx);
  const weight = transactionWeight(stripped.length, raw.length);
  const outputs = tx.outputs.map((o, n) => ({
    address: n === 0 ? plan.destination : (plan.changeAddress ?? ''),
    value: o.value.toString(),
  }));
  return {
    tx,
    hex: bytesToHex(raw),
    txid: txid(tx),
    fee: plan.fee,
    weight,
    vsize: virtualSizeCeil(weight),
    destination: plan.destination,
    amount: plan.amount,
    change: plan.change,
    inputs: plan.inputs.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value.toString(),
      address: u.address,
    })),
    outputs,
  };
}

export interface SendPreview {
  txid: string;
  hex: string;
  fee: string;
  weight: number;
  vsize: number;
  destination: string;
  amount: string;
  change: string;
  inputs: SignedSend['inputs'];
  outputs: SignedSend['outputs'];
  /** Everything below decoded straight back out of `hex`. */
  decoded: DecodedTx;
}

/**
 * Approval view of a signed send, decoded from the bytes we are about to
 * broadcast. Every field the user reads comes back out of `hex`, and a
 * disagreement between the plan and the bytes is a hard refusal: that is the
 * difference between showing what we meant to send and what we are sending.
 */
export function previewFromSigned(signed: SignedSend): SendPreview {
  const decoded = decodeTxPreview(signed.hex, 'testnet');
  const mismatch = (what: string): never => {
    throw new WalletError('NO_COMMITMENT', `The signed transaction does not match the approved ${what}.`);
  };
  if (decoded.txid !== signed.txid) mismatch('transaction id');
  if (decoded.weight !== signed.weight) mismatch('weight');
  const first = decoded.outputs[0];
  if (!first) mismatch('output count');
  else if (first.value !== signed.amount.toString()) mismatch('amount');
  else if (first.address !== signed.destination) mismatch('destination');
  if (signed.change > 0n) {
    const change = decoded.outputs[1];
    if (!change || change.value !== signed.change.toString()) mismatch('change');
  } else if (decoded.outputs.length !== 1) {
    mismatch('output count');
  }

  return {
    txid: decoded.txid,
    hex: signed.hex,
    fee: signed.fee.toString(),
    weight: decoded.weight,
    vsize: decoded.vsize,
    destination: signed.destination,
    amount: signed.amount.toString(),
    change: signed.change.toString(),
    inputs: signed.inputs,
    // Output addresses are decoded from the scripts, so the change row shows a
    // real address instead of an empty string.
    outputs: decoded.outputs.map((o) => ({ address: o.address ?? '', value: o.value })),
    decoded,
  };
}

export { P2MR_INPUT_WEIGHT, feeForP2mrTx };
