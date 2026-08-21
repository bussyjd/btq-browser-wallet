/**
 * Build and sign a single-key P2MR send. Leaves are always constructed here;
 * a supplied leaf is signed only after commitsToProgram() succeeds.
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
import { DEFAULT_SEQUENCE, serializeWithWitness, serializeStripped, type Tx } from './serialize.js';
import { p2mrSighash, txid, type SpentOutput } from './sighash.js';
import { selectCoins, type OwnedUtxo } from './coinselect.js';
import { feeForP2mrTx, MIN_RELAY_SAT_PER_KVB, P2MR_INPUT_WEIGHT, transactionWeight } from './fee.js';

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
  utxos: OwnedUtxo[];
  destination: string;
  amount: bigint;
  changeAddress: string;
  feeRateSatPerKvB?: number;
}): SendPlan {
  const dest = assertDestination(opts.destination, 'testnet');
  const destScript = outputScript(dest.merkleRoot);
  const feeRate = opts.feeRateSatPerKvB ?? MIN_RELAY_SAT_PER_KVB;
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
  };
}

export function signPlan(
  plan: SendPlan,
  keySeedFor: (utxo: OwnedUtxo) => Uint8Array,
  externalLeaf?: { leaf: Uint8Array; control: Uint8Array },
): SignedSend {
  const tx: Tx = {
    version: plan.tx.version,
    locktime: plan.tx.locktime,
    inputs: plan.tx.inputs.map((i) => ({ ...i })),
    outputs: plan.tx.outputs.map((o) => ({ ...o, script: new Uint8Array(o.script) })),
  };

  for (let i = 0; i < plan.inputs.length; i++) {
    const utxo = plan.inputs[i]!;
    const program = utxo.script.subarray(2); // OP_2 <32-byte program>
    let leaf: Uint8Array;
    let control: Uint8Array;
    if (externalLeaf) {
      assertCanSignLeaf(externalLeaf.leaf, externalLeaf.control, program);
      leaf = externalLeaf.leaf;
      control = externalLeaf.control;
    } else {
      const seed = keySeedFor(utxo);
      const pk = publicKeyFromSeed(seed);
      leaf = singleKeyLeafScript(pk);
      control = singleLeafControlBlock();
      assertCanSignLeaf(leaf, control, program);
      // Defence: the script we spend must be the one this key actually pays.
      const ours = outputScript(merkleRootForPublicKey(pk));
      if (ours.length !== utxo.script.length || ours.some((b, n) => b !== utxo.script[n])) {
        throw new WalletError('NO_COMMITMENT', 'UTXO script does not match the derived key.');
      }
      const sighash = p2mrSighash(tx, i, plan.spent, tapLeafHash(leaf));
      const signature = signTransactionHash(seed, sighash);
      if (signature.length !== TX_SIGNATURE_BYTES || signature[TX_SIGNATURE_BYTES - 1] !== SIGHASH_ALL) {
        throw new Error('signature is not a 2421-byte SIGHASH_ALL witness item');
      }
      tx.inputs[i]!.witness = [signature, leaf, control];
      continue;
    }
    // external leaf path (tests): still require a wallet key to produce the sig
    const seed = keySeedFor(utxo);
    const sighash = p2mrSighash(tx, i, plan.spent, tapLeafHash(leaf));
    const signature = signTransactionHash(seed, sighash);
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
    vsize: Math.ceil(weight / 16),
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

/** Decode a signed send for the approval UI — from the bytes we are about to broadcast. */
export function previewFromSigned(signed: SignedSend): {
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
} {
  return {
    txid: signed.txid,
    hex: signed.hex,
    fee: signed.fee.toString(),
    weight: signed.weight,
    vsize: signed.vsize,
    destination: signed.destination,
    amount: signed.amount.toString(),
    change: signed.change.toString(),
    inputs: signed.inputs,
    outputs: signed.outputs,
  };
}

export { P2MR_INPUT_WEIGHT, feeForP2mrTx };
