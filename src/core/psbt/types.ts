/**
 * BIP174 PSBT with BTQ's three Dilithium/P2MR input fields.
 *
 * btq-core reference:
 *   src/psbt.h:52-55     PSBT_IN_P2MR_LEAF_SCRIPT / _MERKLE_ROOT / _DILITHIUM_SCRIPT_SIG
 *   src/psbt.h:82-84     MAX_DILITHIUM_PARTIAL_SIG_VALUE_SIZE / _SIGS_PER_INPUT / MAX_P2MR_LEAF_SCRIPT_SIZE
 *   src/psbt.h:196-201   PSBTInput's Dilithium members and the maps that order them
 *   src/psbt.h:359-382   PSBTInput::Serialize, the P2MR block
 *   src/psbt.h:719-778   PSBTInput::Unserialize, the P2MR block
 *   src/script/interpreter.h:252-255  P2MR control block: 1 + 32*m, at most 128 nodes
 *
 * Why this module exists at all: `walletprocesspsbt` and
 * `createdilithiummultisig` are btq-core *wallet* RPCs, so they need private
 * keys loaded on a node. A browser extension has no wallet on anyone's node and
 * must never have one, which makes them unavailable by construction rather than
 * merely inconvenient — and the public explorer has no broadcast route either.
 * So the extension parses, validates, signs, combines and finalizes PSBTs
 * itself. btq-core is the oracle we check ourselves against (see
 * scripts/gen-psbt-vectors.py), never something we call at runtime.
 *
 * Everything here is pure and browser-safe: Uint8Array only, no Buffer, no
 * node: imports, no I/O.
 */
import type { Tx } from '../tx/serialize.js';

// ---------------------------------------------------------------- wire types

export const PSBT_MAGIC = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff]); // "psbt\xff"
export const PSBT_SEPARATOR = 0x00;

/** Global map key types (src/psbt.h:23-27). */
export const PSBT_GLOBAL_UNSIGNED_TX = 0x00;
export const PSBT_GLOBAL_XPUB = 0x01;
export const PSBT_GLOBAL_VERSION = 0xfb;
export const PSBT_GLOBAL_PROPRIETARY = 0xfc;

/** Input map key types (src/psbt.h:30-56). */
export const PSBT_IN_NON_WITNESS_UTXO = 0x00;
export const PSBT_IN_WITNESS_UTXO = 0x01;
export const PSBT_IN_PARTIAL_SIG = 0x02;
export const PSBT_IN_SIGHASH = 0x03;
export const PSBT_IN_REDEEMSCRIPT = 0x04;
export const PSBT_IN_WITNESSSCRIPT = 0x05;
export const PSBT_IN_BIP32_DERIVATION = 0x06;
export const PSBT_IN_SCRIPTSIG = 0x07;
export const PSBT_IN_SCRIPTWITNESS = 0x08;
export const PSBT_IN_RIPEMD160 = 0x0a;
export const PSBT_IN_SHA256 = 0x0b;
export const PSBT_IN_HASH160 = 0x0c;
export const PSBT_IN_HASH256 = 0x0d;
export const PSBT_IN_TAP_KEY_SIG = 0x13;
export const PSBT_IN_TAP_SCRIPT_SIG = 0x14;
export const PSBT_IN_TAP_LEAF_SCRIPT = 0x15;
export const PSBT_IN_TAP_BIP32_DERIVATION = 0x16;
export const PSBT_IN_TAP_INTERNAL_KEY = 0x17;
export const PSBT_IN_TAP_MERKLE_ROOT = 0x18;
/** BTQ: `0x19 ‖ control_block` → `leaf_script ‖ leaf_version`. */
export const PSBT_IN_P2MR_LEAF_SCRIPT = 0x19;
/** BTQ: `0x1A` alone → the 32-byte merkle root. */
export const PSBT_IN_P2MR_MERKLE_ROOT = 0x1a;
/** BTQ: `0x1B ‖ pubkey(1312) ‖ leaf_hash(32)` → the 2421-byte signature. */
export const PSBT_IN_P2MR_DILITHIUM_SCRIPT_SIG = 0x1b;
export const PSBT_IN_PROPRIETARY = 0xfc;

/** Output map key types (src/psbt.h:59-65). */
export const PSBT_OUT_REDEEMSCRIPT = 0x00;
export const PSBT_OUT_WITNESSSCRIPT = 0x01;
export const PSBT_OUT_BIP32_DERIVATION = 0x02;
export const PSBT_OUT_TAP_INTERNAL_KEY = 0x05;
export const PSBT_OUT_TAP_TREE = 0x06;
export const PSBT_OUT_TAP_BIP32_DERIVATION = 0x07;
export const PSBT_OUT_PROPRIETARY = 0xfc;

// ------------------------------------------------------------------- bounds

/** btq-core src/psbt.h:82 — CDilithiumPubKey::SIGNATURE_SIZE + 1 sighash byte. */
export const DILITHIUM_PARTIAL_SIG_SIZE = 2421;
/** btq-core src/psbt.h:83 — MAX_PUBKEYS_PER_MULTISIG. */
export const MAX_DILITHIUM_PARTIAL_SIGS_PER_INPUT = 20;
/** btq-core src/psbt.h:84 — MAX_SCRIPT_SIZE. */
export const MAX_P2MR_LEAF_SCRIPT_SIZE = 100000;
/** btq-core src/script/interpreter.h:252-255. */
export const P2MR_CONTROL_BASE_SIZE = 1;
export const P2MR_CONTROL_NODE_SIZE = 32;
export const P2MR_CONTROL_MAX_NODE_COUNT = 128;
export const P2MR_CONTROL_MAX_SIZE =
  P2MR_CONTROL_BASE_SIZE + P2MR_CONTROL_NODE_SIZE * P2MR_CONTROL_MAX_NODE_COUNT;
/** btq-core src/script/interpreter.h:245 — TAPROOT_LEAF_MASK. */
export const TAPROOT_LEAF_MASK = 0xfe;
/** The witness program of a P2MR output is 32 bytes (WITNESS_V2_P2MR_SIZE). */
export const WITNESS_V2_P2MR_SIZE = 32;

// -------------------------------------------------------------- value shapes

/** A key/value pair we do not model, carried verbatim so re-serialization is exact. */
export interface PsbtKeyValue {
  key: Uint8Array;
  value: Uint8Array;
}

/** The output being spent, in the shape `p2mrSighash()` wants. */
export interface WitnessUtxo {
  value: bigint;
  script: Uint8Array;
}

/**
 * One advertised leaf and every control block offered for it.
 *
 * btq-core keys `m_p2mr_scripts` by `(script, leaf_version)` and stores the
 * control blocks in a set ordered shortest-first
 * (`ShortestVectorFirstComparator`, src/script/signingprovider.h:18-26), which
 * is why one leaf can have several: the same script can sit in more than one
 * tree. The first one is the one a spend uses.
 */
export interface P2MRLeafScript {
  script: Uint8Array;
  leafVersion: number;
  /** Shortest-first, then lexicographic — btq-core's set ordering. */
  controlBlocks: Uint8Array[];
}

/**
 * A Dilithium partial signature. The full 1312-byte public key rides in the
 * wire key, so a combiner needs no lookup table, and the 32-byte leaf hash
 * binds the signature to one leaf — the same key can sign several leaves of one
 * tree without colliding.
 */
export interface DilithiumPartialSignature {
  pubkey: Uint8Array;
  leafHash: Uint8Array;
  /** Exactly 2421 bytes: the 2420-byte signature plus the sighash byte. */
  signature: Uint8Array;
}

export interface PsbtInput {
  witnessUtxo?: WitnessUtxo;
  sighashType?: number;
  finalScriptSig?: Uint8Array;
  finalScriptWitness?: Uint8Array[];
  p2mrLeaves: P2MRLeafScript[];
  p2mrMerkleRoot?: Uint8Array;
  dilithiumSigs: DilithiumPartialSignature[];
  /** Everything else, verbatim. */
  other: PsbtKeyValue[];
}

export interface PsbtOutput {
  other: PsbtKeyValue[];
}

export interface Psbt {
  /** The unsigned transaction, decoded. */
  tx: Tx;
  /**
   * The exact bytes of the global 0x00 value. Kept alongside `tx` so
   * re-serialization is byte-identical rather than merely equivalent; parsing
   * asserts the two agree, so this can never drift into a second source of
   * truth.
   */
  unsignedTxBytes: Uint8Array;
  globals: PsbtKeyValue[];
  inputs: PsbtInput[];
  outputs: PsbtOutput[];
}
