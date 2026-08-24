/**
 * What the ceremony page is allowed to reach.
 *
 * Deliberately a thin re-export of the real modules rather than a wrapper with
 * logic of its own: if this file computed anything, the recording would be
 * demonstrating this file instead of `src/core`.
 */
export {
  parsePsbt,
  serializePsbtBase64,
  combinePsbts,
  finalizePsbt,

  signPsbt,
} from '../../../src/core/psbt/index.js';

export {
  thresholdLeafScript,
  canonicalThresholdLeafScript,
  canonicalCosigners,
  parseThresholdLeaf,
  multisigAddress,
  multisigMerkleRoot,
  multisigControlBlock,
  LEAF_SCRIPT_BYTES_FOR,
} from '../../../src/core/script/multisig.js';

export { publicKeyFromSeed } from '../../../src/core/crypto/mldsa.js';
export { bytesToHex, hexToBytes } from '../../../src/core/util/hex.js';

/**
 * Needed so the page can derive an address from a key list in **caller order**
 * as well as canonical order. `multisigAddress` sorts, which is what a wallet
 * should do; btq-core's `createdilithiummultisig` takes the list as given. The
 * ceremony has to reproduce btq-core's address to reproduce its transaction,
 * and showing both is the clearest way to state the footgun.
 */
export { tapLeafHash } from '../../../src/core/script/p2mr.js';
export { encodeAddress } from '../../../src/core/script/address.js';
