/**
 * Client-side PSBT for BTQ's Dilithium P2MR spends.
 *
 * The whole point of the module: `createdilithiummultisig` and
 * `walletprocesspsbt` are btq-core *wallet* RPCs and need private keys loaded
 * on a node, so a browser extension cannot call them — not as a matter of
 * convenience but by construction. `combinepsbt` and `finalizepsbt` need no
 * wallet, but leaning on them still means every cosigner runs a node, and the
 * public explorer has no broadcast route at all. So parsing, validating,
 * signing, combining and finalizing all happen here, in the browser.
 *
 * btq-core is how the module is *checked*, never something it calls:
 * scripts/gen-psbt-vectors.py drives a throwaway regtest node and freezes its
 * PSBTs into tests/vectors/psbt.json, and tests/unit/psbt.test.ts asserts we
 * reproduce them byte-for-byte.
 */
export * from './types.js';
export { parsePsbt, decodeBase64, keyType, psbtError } from './parse.js';
export { serializePsbt, serializePsbtBase64 } from './serialize.js';
export { combinePsbts } from './combine.js';
export { finalizePsbt, extractTransaction, type FinalizeResult } from './finalize.js';
export { signPsbt, type SignPsbtResult } from './sign.js';
export {
  inspectP2MRInput,
  validateP2MRDilithiumInput,
  validateP2MRDilithiumPsbt,
  hasP2MRFields,
  isFinalized,
  p2mrProgram,
  spentOutputs,
  type P2MRInputInfo,
  type P2MRInputStatus,
} from './validate.js';
export {
  buildLeafWitnessStack,
  findPolicyKeyIndex,
  parseLeafPolicy,
  type LeafPolicy,
  type LeafTemplate,
} from './leaf.js';
export { compareDilithiumSigs, compareControlBlocks, compareLeaves, hash160, lexicographic } from './order.js';
