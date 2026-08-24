/**
 * Cross-implementation check for client-side PSBT.
 *
 * tests/vectors/psbt.json is produced by scripts/gen-psbt-vectors.py, which
 * drives a throwaway btq-core regtest node: every PSBT in it is the literal
 * base64 that `walletcreatefundedpsbt`, `walletprocesspsbt`, `combinepsbt` and
 * `finalizepsbt` handed back, and every raw transaction is what `finalizepsbt`
 * extracted and `testmempoolaccept` accepted.
 *
 * That provenance is the point. Checking an encoder against its own decoder
 * proves only that they share their bugs, so round-tripping our own output
 * appears here as an *additional* check and never as the primary one. The
 * primary checks are: we read btq-core's bytes; our combine reproduces
 * btq-core's `combinepsbt` byte-for-byte; our finalize reproduces its
 * `finalizepsbt` witness byte-for-byte; and our signatures — the keys are
 * deterministic on both sides — are the same 2421 bytes the node produced.
 *
 * Regenerate the vector file, never hand-edit it.
 */
import { describe, it, expect } from 'vitest';
import vectors from '../vectors/psbt.json' with { type: 'json' };
import {
  combinePsbts,
  decodeBase64,
  extractTransaction,
  finalizePsbt,
  inspectP2MRInput,
  parseLeafPolicy,
  parsePsbt,
  serializePsbt,
  spentOutputs,
  serializePsbtBase64,
  signPsbt,
  buildLeafWitnessStack,
  DILITHIUM_PARTIAL_SIG_SIZE,
  MAX_DILITHIUM_PARTIAL_SIGS_PER_INPUT,
  PSBT_IN_P2MR_DILITHIUM_SCRIPT_SIG,
  PSBT_IN_P2MR_LEAF_SCRIPT,
  PSBT_IN_P2MR_MERKLE_ROOT,
  PSBT_MAGIC,
  type Psbt,
  type PsbtInput,
} from '../../src/core/psbt/index.js';
import { thresholdLeafScript } from '../../src/core/script/multisig.js';
import { tapLeafHash } from '../../src/core/script/p2mr.js';
import { PUBLIC_KEY_BYTES, publicKeyFromSeed } from '../../src/core/crypto/mldsa.js';
import { compactSize, concatBytes, readCompactSize } from '../../src/core/util/bytes.js';
import { compareControlBlocks, compareDilithiumSigs, hash160, lexicographic } from '../../src/core/psbt/order.js';
import { bytesToHex, hexToBytes } from '../../src/core/util/hex.js';
import { WalletError } from '../../src/core/wallet/errors.js';

const seedOf = (keyIndex: number) => hexToBytes(vectors.seeds[keyIndex]!);
const hex = (b: Uint8Array) => bytesToHex(b);

/** The absolute key index sitting in slot `slot` of a case's leaf. */
const keyAt = (v: { keyIndexes: readonly number[] }, slot: number) => v.keyIndexes[slot]!;

// ---------------------------------------------------------------------------
// A raw PSBT splitter, used only to build malformed inputs. It is deliberately
// dumber than src/core/psbt/parse.ts — it has to be able to express PSBTs the
// real parser must refuse.
// ---------------------------------------------------------------------------

interface RawKV { key: Uint8Array; value: Uint8Array }

function splitPsbt(bytes: Uint8Array): RawKV[][] {
  let offset = PSBT_MAGIC.length;
  const maps: RawKV[][] = [];
  let current: RawKV[] = [];
  const size = () => {
    const { value, offset: next } = readCompactSize(bytes, offset);
    offset = next;
    return value;
  };
  while (offset < bytes.length) {
    const keyLength = size();
    if (keyLength === 0) {
      maps.push(current);
      current = [];
      continue;
    }
    const key = bytes.slice(offset, offset + keyLength);
    offset += keyLength;
    const valueLength = size();
    const value = bytes.slice(offset, offset + valueLength);
    offset += valueLength;
    current.push({ key, value });
  }
  return maps;
}

function joinPsbt(maps: RawKV[][]): Uint8Array {
  const parts: Uint8Array[] = [PSBT_MAGIC];
  for (const map of maps) {
    for (const { key, value } of map) {
      parts.push(compactSize(key.length), key, compactSize(value.length), value);
    }
    parts.push(new Uint8Array([0x00]));
  }
  return concatBytes(...parts);
}

/** Rewrite the input map (map index 1) of a real PSBT and re-encode. */
function withInputMap(psbtBase64: string, edit: (entries: RawKV[]) => RawKV[]): Uint8Array {
  const maps = splitPsbt(decodeBase64(psbtBase64));
  maps[1] = edit(maps[1]!);
  return joinPsbt(maps);
}

const entryOfType = (entries: RawKV[], type: number) => entries.find((e) => e.key[0] === type)!;

function expectPsbtError(fn: () => unknown, message: RegExp): void {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(WalletError);
  expect((thrown as WalletError).code).toBe('BAD_PSBT');
  expect((thrown as WalletError).message).toMatch(message);
}

// ---------------------------------------------------------------------------

describe('the vectors come from btq-core', () => {
  it('records the node that produced them', () => {
    expect(vectors._source).toMatch(/btq-core regtest/);
    expect(vectors.btqVersion).toMatch(/BTQ:/);
    expect(vectors.cases.length).toBeGreaterThanOrEqual(4);
  });

  it('agrees with Unit 1 about the leaf script btq-core built', () => {
    for (const v of vectors.cases) {
      // createdilithiummultisig takes the caller's key order and does not sort
      // it, so this reproduces btq-core's leaf with thresholdLeafScript rather
      // than the canonical one the wallet would choose for itself.
      const keys = v.keyIndexes.map((i) => hexToBytes(vectors.pubkeys[i]!));
      const leaf = thresholdLeafScript(v.m, keys);
      expect(hex(leaf)).toBe(v.leafScript);
      expect(hex(tapLeafHash(leaf))).toBe(v.merkleRoot);
    }
  });

  it('holds keys this repository derives identically', () => {
    for (let i = 0; i < vectors.seeds.length; i++) {
      expect(hex(publicKeyFromSeed(seedOf(i)))).toBe(vectors.pubkeys[i]);
    }
  });
});

describe('parse', () => {
  const everyPsbt: [string, string][] = [
    ...vectors.cases.flatMap((v): [string, string][] => [
      [`${v.name} unsigned`, v.unsignedPsbt],
      ...v.singlySignedPsbts.map((s): [string, string] => [`${v.name} signed by slot ${s.keyIndex}`, s.psbt]),
      [`${v.name} combined`, v.combinedPsbt],
      [`${v.name} finalized`, v.finalizedPsbt],
    ]),
    ['single-key unsigned', vectors.singleKey.unsignedPsbt],
    ['single-key signed', vectors.singleKey.signedPsbt],
    ['single-key finalized', vectors.singleKey.finalizedPsbt],
    ['sign-from-PSBT-alone probe', vectors.signFromPsbtAlone.unsignedPsbt],
  ];

  it.each(everyPsbt)('reads %s', (_name, psbt) => {
    const parsed = parsePsbt(psbt);
    expect(parsed.inputs.length).toBe(parsed.tx.inputs.length);
    expect(parsed.outputs.length).toBe(parsed.tx.outputs.length);
  });

  // Round-tripping our own output proves only self-consistency, which is why it
  // sits here as a supporting check rather than as the verification.
  it.each(everyPsbt)('re-serialises %s byte-for-byte', (_name, psbt) => {
    expect(serializePsbtBase64(parsePsbt(psbt))).toBe(psbt);
  });

  it('reads the three BTQ input fields off an unsigned multisig PSBT', () => {
    const v = vectors.cases[0]!;
    const psbt = parsePsbt(v.unsignedPsbt);
    const input = psbt.inputs[0]!;
    expect(input.p2mrLeaves.length).toBe(1);
    expect(hex(input.p2mrLeaves[0]!.script)).toBe(v.leafScript);
    expect(input.p2mrLeaves[0]!.leafVersion).toBe(0xc0);
    expect(hex(input.p2mrLeaves[0]!.controlBlocks[0]!)).toBe('c1');
    expect(hex(input.p2mrMerkleRoot!)).toBe(v.merkleRoot);
    expect(input.dilithiumSigs.length).toBe(0);
    expect(hex(input.witnessUtxo!.script)).toBe(v.prevout.script);
    expect(input.witnessUtxo!.value.toString()).toBe(v.prevout.value);
  });

  it('reports the leaf policy and the signing progress of every case', () => {
    for (const v of vectors.cases) {
      expect(inspectP2MRInput(parsePsbt(v.unsignedPsbt), 0).status).toBe('unsigned');

      const half = inspectP2MRInput(parsePsbt(v.singlySignedPsbts[0]!.psbt), 0);
      expect(half.policy!.type).toBe('dilithium_threshold');
      expect(half.policy!.m).toBe(v.m);
      expect(half.policy!.pubkeys.length).toBe(v.n);
      expect(half.signaturesRequired).toBe(v.m);
      expect(half.signaturesPresent).toBe(1);
      expect(half.status).toBe(v.m === 1 ? 'finalizable' : 'partially_signed');

      const combined = inspectP2MRInput(parsePsbt(v.combinedPsbt), 0);
      expect(combined.signaturesPresent).toBe(v.signerKeyIndexes.length);
      expect(combined.status).toBe('finalizable');

      expect(inspectP2MRInput(parsePsbt(v.finalizedPsbt), 0).status).toBe('finalized');
    }
  });

  it('classifies the single-key leaf', () => {
    const info = inspectP2MRInput(parsePsbt(vectors.singleKey.signedPsbt), 0);
    expect(info.policy!.type).toBe('dilithium_single');
    expect(info.policy!.m).toBe(1);
    expect(hex(info.policy!.pubkeys[0]!)).toBe(vectors.singleKey.pubkey);
    expect(info.status).toBe('finalizable');
  });
});

describe('parse refuses what btq-core refuses', () => {
  const v = vectors.cases[0]!;
  const signed = v.singlySignedPsbts[0]!.psbt;

  it('rejects a forged signature at decode time, not at finalize', () => {
    // The same byte flip test/functional/wallet_dilithium_psbt_multisig.py:166
    // makes, and the same answer: an error out of the decoder.
    expectPsbtError(() => parsePsbt(v.tamperedPsbt), /signature does not verify/);
  });

  it('rejects a partial signature that is not 2421 bytes', () => {
    for (const length of [DILITHIUM_PARTIAL_SIG_SIZE - 1, DILITHIUM_PARTIAL_SIG_SIZE + 1]) {
      const bytes = withInputMap(signed, (entries) => entries.map((e) =>
        e.key[0] === PSBT_IN_P2MR_DILITHIUM_SCRIPT_SIG
          ? { key: e.key, value: concatBytes(e.value, new Uint8Array(4)).slice(0, length) }
          : e));
      expectPsbtError(() => parsePsbt(bytes), /invalid length/);
    }
  });

  it('rejects a signature key that is not 1 + 1312 + 32 bytes', () => {
    const bytes = withInputMap(signed, (entries) => entries.map((e) =>
      e.key[0] === PSBT_IN_P2MR_DILITHIUM_SCRIPT_SIG
        ? { key: e.key.slice(0, e.key.length - 1), value: e.value }
        : e));
    expectPsbtError(() => parsePsbt(bytes), /not the expected size/);
  });

  it('rejects a control block that is not 1 + 32k bytes', () => {
    const bytes = withInputMap(signed, (entries) => entries.map((e) =>
      e.key[0] === PSBT_IN_P2MR_LEAF_SCRIPT
        ? { key: concatBytes(e.key, new Uint8Array(31)), value: e.value }
        : e));
    expectPsbtError(() => parsePsbt(bytes), /control block size is not valid/);
  });

  it('rejects an empty leaf-script value', () => {
    const bytes = withInputMap(signed, (entries) => entries.map((e) =>
      e.key[0] === PSBT_IN_P2MR_LEAF_SCRIPT ? { key: e.key, value: new Uint8Array(0) } : e));
    expectPsbtError(() => parsePsbt(bytes), /at least 1 byte/);
  });

  it('rejects a duplicate key', () => {
    const bytes = withInputMap(signed, (entries) => [...entries, entryOfType(entries, PSBT_IN_P2MR_MERKLE_ROOT)]);
    expectPsbtError(() => parsePsbt(bytes), /duplicate key/);
  });

  it('rejects more than 20 partial signatures on one input', () => {
    const template = entryOfType(splitPsbt(decodeBase64(signed))[1]!, PSBT_IN_P2MR_DILITHIUM_SCRIPT_SIG);
    const bytes = withInputMap(signed, (entries) => {
      const rest = entries.filter((e) => e.key[0] !== PSBT_IN_P2MR_DILITHIUM_SCRIPT_SIG);
      const many: RawKV[] = [];
      for (let i = 0; i <= MAX_DILITHIUM_PARTIAL_SIGS_PER_INPUT; i++) {
        const key = Uint8Array.from(template.key);
        key[100] = i; // a distinct, still structurally valid, public key each time
        many.push({ key, value: template.value });
      }
      return [...rest, ...many];
    });
    expectPsbtError(() => parsePsbt(bytes), /too many/i);
  });

  it('rejects a leaf script that does not commit to the witness program', () => {
    const bytes = withInputMap(signed, (entries) => entries.map((e) => {
      if (e.key[0] !== PSBT_IN_P2MR_LEAF_SCRIPT) return e;
      const value = Uint8Array.from(e.value);
      value[10] = value[10]! ^ 0xff; // inside the first pubkey of the leaf
      return { key: e.key, value };
    }));
    expectPsbtError(() => parsePsbt(bytes), /does not commit to the witness program/);
  });

  it('rejects a merkle root that disagrees with the witness program', () => {
    const bytes = withInputMap(signed, (entries) => entries.map((e) => {
      if (e.key[0] !== PSBT_IN_P2MR_MERKLE_ROOT) return e;
      const value = Uint8Array.from(e.value);
      value[0] = value[0]! ^ 0xff;
      return { key: e.key, value };
    }));
    expectPsbtError(() => parsePsbt(bytes), /merkle root does not match/);
  });

  it('rejects a signature from a key the leaf does not authorise', () => {
    const outsider = publicKeyFromSeed(seedOf(5));
    const bytes = withInputMap(signed, (entries) => entries.map((e) => {
      if (e.key[0] !== PSBT_IN_P2MR_DILITHIUM_SCRIPT_SIG) return e;
      const key = Uint8Array.from(e.key);
      key.set(outsider, 1);
      return { key, value: e.value };
    }));
    expectPsbtError(() => parsePsbt(bytes), /does not authorise/);
  });

  it('rejects base64 that is not a PSBT', () => {
    expectPsbtError(() => parsePsbt('bm90IGEgcHNidA=='), /magic bytes/);
    expectPsbtError(() => parsePsbt('not base64 at all!!'), /not valid base64/);
  });
});

describe('sign', () => {
  it('reproduces btq-core signature for signature, PSBT for PSBT', () => {
    for (const v of vectors.cases) {
      for (const singly of v.singlySignedPsbts) {
        const seed = seedOf(keyAt(v, singly.keyIndex));
        const { psbt, added } = signPsbt(parsePsbt(v.unsignedPsbt), [seed]);
        expect(added).toBe(1);
        // Byte-for-byte with what `walletprocesspsbt` produced: same sighash,
        // same deterministic ML-DSA signature, same field placement.
        expect(serializePsbtBase64(psbt)).toBe(singly.psbt);
      }
    }
  });

  it('signs the single-key leaf the same way', () => {
    const seed = seedOf(vectors.singleKey.keyIndex);
    const { psbt, added } = signPsbt(parsePsbt(vectors.singleKey.unsignedPsbt), [seed]);
    expect(added).toBe(1);
    expect(serializePsbtBase64(psbt)).toBe(vectors.singleKey.signedPsbt);
  });

  it('signs every slot it holds a key for in one pass', () => {
    const v = vectors.cases[0]!;
    const seeds = v.signerKeyIndexes.map((slot) => seedOf(keyAt(v, slot)));
    const { psbt, added } = signPsbt(parsePsbt(v.unsignedPsbt), seeds);
    expect(added).toBe(2);
    expect(serializePsbtBase64(psbt)).toBe(v.combinedPsbt);
  });

  it('adds nothing when a key has already signed', () => {
    const v = vectors.cases[0]!;
    const seed = seedOf(keyAt(v, v.signerKeyIndexes[0]!));
    const once = signPsbt(parsePsbt(v.singlySignedPsbts[0]!.psbt), [seed]);
    expect(once.added).toBe(0);
    expect(serializePsbtBase64(once.psbt)).toBe(v.singlySignedPsbts[0]!.psbt);
  });

  it('adds nothing for a key the leaf does not name', () => {
    const v = vectors.cases[0]!;
    const { added } = signPsbt(parsePsbt(v.unsignedPsbt), [seedOf(5)]);
    expect(added).toBe(0);
  });

  it('refuses a seed of the wrong length rather than deriving something', () => {
    const v = vectors.cases[0]!;
    expectPsbtError(() => signPsbt(parsePsbt(v.unsignedPsbt), [new Uint8Array(31)]), /32 bytes/);
  });

  it('refuses to sign a leaf that does not commit to the witness program', () => {
    // The commitment check has to happen at the moment of signing and not only
    // at parse: a caller holding a Psbt object assembled some other way must
    // still not be able to get a key applied to a foreign script.
    const v = vectors.cases[0]!;
    const psbt = parsePsbt(v.unsignedPsbt);
    const tampered: Psbt = {
      ...psbt,
      inputs: psbt.inputs.map((input) => ({
        ...input,
        p2mrLeaves: input.p2mrLeaves.map((leaf) => {
          const script = Uint8Array.from(leaf.script);
          script[10] = script[10]! ^ 0xff;
          return { ...leaf, script };
        }),
      })),
    };
    expectPsbtError(() => signPsbt(tampered, [seedOf(0)]), /does not commit|recognises/);
  });

  it('refuses an input it cannot recognise as a P2MR spend', () => {
    const v = vectors.cases[0]!;
    const psbt = parsePsbt(v.unsignedPsbt);
    const foreign: Psbt = {
      ...psbt,
      inputs: psbt.inputs.map((input) => ({
        ...input,
        witnessUtxo: { value: input.witnessUtxo!.value, script: hexToBytes('0014' + '11'.repeat(20)) },
        p2mrLeaves: [],
        p2mrMerkleRoot: undefined,
      })),
    };
    expectPsbtError(() => signPsbt(foreign, [seedOf(0)]), /not a P2MR spend/);
  });
});

describe('combine', () => {
  it('reproduces btq-core combinepsbt byte-for-byte', () => {
    for (const v of vectors.cases) {
      const parts = v.singlySignedPsbts.map((s) => parsePsbt(s.psbt));
      expect(serializePsbtBase64(combinePsbts(parts))).toBe(v.combinedPsbt);
    }
  });

  it('does not depend on the order the copies arrive in', () => {
    for (const v of vectors.cases) {
      const parts = v.singlySignedPsbts.map((s) => parsePsbt(s.psbt));
      expect(serializePsbtBase64(combinePsbts([...parts].reverse()))).toBe(v.combinedPsbt);
    }
  });

  it('is idempotent: combining a copy with itself changes nothing', () => {
    const v = vectors.cases[0]!;
    const one = parsePsbt(v.singlySignedPsbts[0]!.psbt);
    expect(serializePsbtBase64(combinePsbts([one, parsePsbt(v.singlySignedPsbts[0]!.psbt)])))
      .toBe(v.singlySignedPsbts[0]!.psbt);
  });

  it('refuses to combine PSBTs that describe different transactions', () => {
    expectPsbtError(
      () => combinePsbts([parsePsbt(vectors.cases[0]!.unsignedPsbt), parsePsbt(vectors.cases[1]!.unsignedPsbt)]),
      /different transactions/);
  });

  it('refuses a merge that would exceed the 20-signature cap', () => {
    // Reachable through ordinary parsed PSBTs, despite the cap being enforced
    // at parse: each side may legitimately carry 20 signatures *on its own
    // leaf*, and the union is 40 across two leaves. Built directly here rather
    // than by producing 40 real signatures, which would buy nothing.
    const v = vectors.cases[0]!;
    const base = parsePsbt(v.singlySignedPsbts[0]!.psbt);
    const real = base.inputs[0]!.dilithiumSigs[0]!;
    const bulk = (leafHashByte: number) => Array.from({ length: 11 }, (_, i) => {
      const pubkey = Uint8Array.from(real.pubkey);
      pubkey[100] = i;
      const leafHash = Uint8Array.from(real.leafHash);
      leafHash[0] = leafHashByte;
      return { pubkey, leafHash, signature: real.signature };
    });
    const withSigs = (sigs: ReturnType<typeof bulk>): Psbt => ({
      ...base,
      inputs: base.inputs.map((input) => ({ ...input, dilithiumSigs: sigs })),
    });
    expectPsbtError(() => combinePsbts([withSigs(bulk(1)), withSigs(bulk(2))]), /more than 20/);
  });

  it('keeps one control block per leaf when both copies offer the same one', () => {
    // btq-core stores a leaf's control blocks in a set and merges by union
    // (src/psbt.cpp:239-241), which reads as though a leaf could accumulate
    // several. Under validation it cannot: every advertised control block has to
    // commit to the *one* witness program being spent, and a leaf has exactly
    // one path to a given root. So the union is faithful to btq-core and, for
    // anything our own decoder would accept, always a no-op — which is what this
    // pins, rather than inventing a second block that could never validate.
    const v = vectors.cases[0]!;
    const merged = combinePsbts([parsePsbt(v.unsignedPsbt), parsePsbt(v.unsignedPsbt)]);
    expect(merged.inputs[0]!.p2mrLeaves.length).toBe(1);
    expect(merged.inputs[0]!.p2mrLeaves[0]!.controlBlocks.map(hex)).toEqual(['c1']);
  });

  it('orders signatures by Hash160 of the key, and by leaf hash only on a tie', () => {
    // The pair is (Hash160(pubkey), leaf_hash), so the second component decides
    // nothing until the first ties — and a tie is exactly what one key signing
    // two leaves of one tree produces. The fixture set never ties, so it could
    // not have caught the components being weighted the other way round.
    const pubkeyA = publicKeyFromSeed(seedOf(0));
    const pubkeyB = publicKeyFromSeed(seedOf(1));
    const leafLow = new Uint8Array(32);
    const leafHigh = new Uint8Array(32).fill(0xff);
    const sig = new Uint8Array(DILITHIUM_PARTIAL_SIG_SIZE);

    // Same key, different leaves: the leaf hash breaks the tie.
    expect(compareDilithiumSigs(
      { pubkey: pubkeyA, leafHash: leafLow, signature: sig },
      { pubkey: pubkeyA, leafHash: leafHigh, signature: sig })).toBeLessThan(0);
    // Identical pairs compare equal, so the ordering is a total order.
    expect(compareDilithiumSigs(
      { pubkey: pubkeyA, leafHash: leafLow, signature: sig },
      { pubkey: pubkeyA, leafHash: leafLow, signature: sig })).toBe(0);
    // Different keys: the key hash decides regardless of the leaf hash, and it
    // is the *hash* that decides — for this pair, the opposite of what ordering
    // by the public keys themselves would give.
    const byHash = compareDilithiumSigs(
      { pubkey: pubkeyA, leafHash: leafHigh, signature: sig },
      { pubkey: pubkeyB, leafHash: leafLow, signature: sig });
    expect(Math.sign(byHash)).toBe(Math.sign(lexicographic(hash160(pubkeyA), hash160(pubkeyB))));
    expect(Math.sign(byHash)).not.toBe(Math.sign(lexicographic(pubkeyA, pubkeyB)));
  });

  it('orders control blocks shortest-first, not lexicographically', () => {
    // btq-core's ShortestVectorFirstComparator (src/script/signingprovider.h:18-26)
    // sorts by length before content, unlike the std::vector ordering the leaf
    // map uses. Pinned directly because the two disagree exactly where a
    // deeper tree would put a longer control block first.
    const short_ = hexToBytes('c1');
    const long_ = hexToBytes('c0' + '00'.repeat(32));
    expect(compareControlBlocks(short_, long_)).toBeLessThan(0);
    expect(lexicographic(short_, long_)).toBeGreaterThan(0);
  });

  it('refuses copies that disagree about the output being spent', () => {
    // The sighash commits to every spent output, so two copies that disagree
    // were signed over different messages. Merging them would produce a PSBT
    // our own decoder rejects — and, before this refusal existed, one that
    // finalize would still call complete.
    const v = vectors.cases[0]!;
    const honest = signPsbt(parsePsbt(v.unsignedPsbt), [seedOf(keyAt(v, v.signerKeyIndexes[0]!))]).psbt;
    const lying = parsePsbt(v.unsignedPsbt);
    const inflated: Psbt = {
      ...lying,
      inputs: lying.inputs.map((input) => ({
        ...input,
        witnessUtxo: { value: input.witnessUtxo!.value + 12345n, script: input.witnessUtxo!.script },
      })),
    };
    const otherSlot = v.signerKeyIndexes[1]!;
    const signedOverTheLie = signPsbt(inflated, [seedOf(keyAt(v, otherSlot))]).psbt;
    expectPsbtError(() => combinePsbts([honest, signedOverTheLie]), /disagree about the output/);
  });

  it('refuses a merge whose result would not validate', () => {
    // Belt to the previous braces: whatever route a bad signature takes into a
    // merged input, the merged object has to clear the same bar a decoded one
    // does before any caller sees it.
    const v = vectors.cases[0]!;
    const honest = parsePsbt(v.singlySignedPsbts[0]!.psbt);
    const forged: Psbt = {
      ...honest,
      inputs: honest.inputs.map((input) => ({
        ...input,
        dilithiumSigs: input.dilithiumSigs.map((sig) => {
          const signature = Uint8Array.from(sig.signature);
          signature[100] = signature[100]! ^ 0xff;
          return { ...sig, signature };
        }),
      })),
    };
    // Merged into the *unsigned* copy, not the honest one: the two forgeries
    // share a (pubkey, leaf) pair with the honest signature, so a merge that
    // held both would keep the honest one and hide the forgery.
    expectPsbtError(() => combinePsbts([parsePsbt(v.unsignedPsbt), forged]), /does not verify/);
  });
});

describe('finalize', () => {
  it('reproduces btq-core finalizepsbt byte-for-byte', () => {
    for (const v of vectors.cases) {
      const result = finalizePsbt(parsePsbt(v.combinedPsbt));
      expect(result.complete).toBe(true);
      expect(result.hex).toBe(v.finalizedHex);
      expect(serializePsbtBase64(result.psbt)).toBe(v.finalizedPsbt);
    }
  });

  it('reproduces btq-core witness stack item for item', () => {
    for (const v of vectors.cases) {
      const { psbt } = finalizePsbt(parsePsbt(v.combinedPsbt));
      expect(psbt.inputs[0]!.finalScriptWitness!.map(hex)).toEqual(v.finalizedWitness);
    }
  });

  it('finalizes the single-key leaf', () => {
    const result = finalizePsbt(parsePsbt(vectors.singleKey.signedPsbt));
    expect(result.complete).toBe(true);
    expect(result.hex).toBe(vectors.singleKey.finalizedHex);
    expect(result.psbt.inputs[0]!.finalScriptWitness!.map(hex)).toEqual(vectors.singleKey.finalizedWitness);
  });

  it('refuses below the threshold, exactly as btq-core does', () => {
    for (const v of vectors.cases) {
      expect(v.underThresholdComplete).toBe(false);
      const result = finalizePsbt(parsePsbt(v.singlySignedPsbts[0]!.psbt));
      expect(result.complete).toBe(false);
      expect(result.hex).toBeUndefined();
      // The partial signature is still there to be handed to the next cosigner.
      expect(result.psbt.inputs[0]!.dilithiumSigs.length).toBe(1);
      expect(() => extractTransaction(result.psbt)).toThrow(/no final witness/);
    }
  });

  it('leaves an empty slot for every key that did not sign', () => {
    // 2-of-3 signed by slots 0 and 1 leaves slot 2 empty, so the stack — which
    // is pushed in reverse — starts with the empty item.
    const v = vectors.cases.find((c) => c.name === '2-of-3-first-two')!;
    const { psbt } = finalizePsbt(parsePsbt(v.combinedPsbt));
    const stack = psbt.inputs[0]!.finalScriptWitness!;
    expect(stack.slice(0, 3).map((item) => item.length)).toEqual([0, DILITHIUM_PARTIAL_SIG_SIZE, DILITHIUM_PARTIAL_SIG_SIZE]);
  });

  it('pushes the signature slots in reverse key order', () => {
    // Stated directly rather than only implied by the frozen bytes: witness
    // item i must hold the signature of key n-1-i. Key 0 is evaluated first by
    // the accumulator, so its slot has to end up on top of the stack.
    for (const v of vectors.cases) {
      const combined = parsePsbt(v.combinedPsbt);
      const policy = parseLeafPolicy(combined.inputs[0]!.p2mrLeaves[0]!.script)!;
      const { psbt } = finalizePsbt(combined);
      const stack = psbt.inputs[0]!.finalScriptWitness!;
      expect(stack.length).toBe(v.n + 2); // n slots, the leaf script, the control block

      for (let slot = 0; slot < v.n; slot++) {
        const item = stack[v.n - 1 - slot]!;
        const signedHere = v.signerKeyIndexes.includes(slot);
        expect(item.length).toBe(signedHere ? DILITHIUM_PARTIAL_SIG_SIZE : 0);
        if (!signedHere) continue;
        const sig = combined.inputs[0]!.dilithiumSigs.find((s) => hex(s.pubkey) === hex(policy.pubkeys[slot]!))!;
        expect(hex(item)).toBe(hex(sig.signature));
      }
      expect(hex(stack[v.n]!)).toBe(v.leafScript);
      expect(hex(stack[v.n + 1]!)).toBe('c1');
    }
  });

  it('would have caught the slot order being reversed', () => {
    // The failure mode this guards against is silent: a forwards-pushed witness
    // serialises, has the right length, and is rejected only by consensus. So
    // build the wrong one deliberately and assert it differs from btq-core's.
    const v = vectors.cases.find((c) => c.name === '3-of-5')!;
    const combined = parsePsbt(v.combinedPsbt);
    const policy = parseLeafPolicy(combined.inputs[0]!.p2mrLeaves[0]!.script)!;
    const slots = policy.pubkeys.map((pubkey) =>
      combined.inputs[0]!.dilithiumSigs.find((s) => hex(s.pubkey) === hex(pubkey))?.signature ?? null);

    const right = buildLeafWitnessStack(policy, slots)!;
    const wrong = [...right].reverse();
    expect(right.map(hex)).toEqual(v.finalizedWitness.slice(0, v.n));
    expect(wrong.map(hex)).not.toEqual(v.finalizedWitness.slice(0, v.n));
  });

  it('refuses to build a witness below the threshold', () => {
    const v = vectors.cases.find((c) => c.name === '3-of-5')!;
    const combined = parsePsbt(v.combinedPsbt);
    const policy = parseLeafPolicy(combined.inputs[0]!.p2mrLeaves[0]!.script)!;
    const tooFew = policy.pubkeys.map(() => null);
    expect(buildLeafWitnessStack(policy, tooFew)).toBeNull();
  });

  it('is a no-op on an already finalized PSBT', () => {
    for (const v of vectors.cases) {
      const again = finalizePsbt(parsePsbt(v.finalizedPsbt));
      expect(again.complete).toBe(true);
      expect(again.hex).toBe(v.finalizedHex);
      expect(serializePsbt(again.psbt)).toEqual(decodeBase64(v.finalizedPsbt));
    }
  });
});

describe('more signatures than the threshold needs', () => {
  const v = vectors.overSigned;

  it('records what btq-core does, which is emit all of them', () => {
    // Measured, not reasoned about. The accumulator succeeds on sum >= m, so a
    // third signature on a 2-of-3 is valid but unnecessary, and a finalizer
    // could legitimately select m and drop the rest. btq-core does not:
    // BuildDilithiumLeafWitness fills every slot it has a signature for
    // (src/script/dilithium_leaf.cpp:163-173), and `finalizepsbt` emits all
    // three. The cost is real — 816 vsize against 665 — but the transaction
    // still relayed at the fee walletcreatefundedpsbt chose.
    expect(v.signaturesInCombinedPsbt).toBe(3);
    expect(v.signaturesEmittedByFinalize).toBe(3);
    expect(v.finalizedWitness.map((w) => w.length / 2))
      .toEqual([2421, 2421, 2421, 3960, 1]);
    expect(v.vsize).toBeGreaterThan(v.vsizeWithTwoSignatures);
    expect(v.relays).toBe(true);
  });

  it('matches btq-core byte-for-byte rather than selecting m itself', () => {
    // Selecting exactly m would be defensible on size and on privacy, and it is
    // the wrong call *here*: our transaction would differ from the one btq-core
    // builds out of the same PSBT, so the two would disagree on the txid, and
    // every byte-for-byte check in this file would be measuring our preference
    // instead of the protocol. The place to avoid a surplus signature is before
    // it exists — see the next test.
    const combined = combinePsbts(v.singlySignedPsbts.map((s) => parsePsbt(s.psbt)));
    expect(combined.inputs[0]!.dilithiumSigs.length).toBe(3);
    const final = finalizePsbt(combined);
    expect(final.hex).toBe(v.finalizedHex);
    expect(final.psbt.inputs[0]!.finalScriptWitness!.map(hex)).toEqual(v.finalizedWitness);
    expect(serializePsbtBase64(final.psbt)).toBe(v.finalizedPsbt);
  });

  it('does not create a surplus signature in the first place', () => {
    // A third cosigner can see from the PSBT that the input is already
    // finalizable, so the default is to add nothing: no extra 2424 witness
    // bytes against a fee quoted before they existed, and no ML-DSA signature
    // published for a cosigner who was not needed.
    const twoOfThree = combinePsbts([
      parsePsbt(v.singlySignedPsbts[0]!.psbt),
      parsePsbt(v.singlySignedPsbts[1]!.psbt),
    ]);
    expect(inspectP2MRInput(twoOfThree, 0).status).toBe('finalizable');

    const thirdSeed = seedOf(keyAt(v, 2));
    expect(signPsbt(twoOfThree, [thirdSeed]).added).toBe(0);

    // ...but the caller can ask for it, and then we are back to btq-core's bytes.
    const forced = signPsbt(twoOfThree, [thirdSeed], { signWhenAlreadyFinalizable: true });
    expect(forced.added).toBe(1);
    expect(serializePsbtBase64(forced.psbt)).toBe(v.combinedPsbt);
    expect(finalizePsbt(forced.psbt).hex).toBe(v.finalizedHex);
  });

  it('signs m of the keys and stops, even holding more than m', () => {
    // The guard has to hold inside one call too: a wallet handed all three
    // seeds at once would otherwise walk straight past the threshold and
    // produce the 816-vsize spend rather than the 665-vsize one.
    const allThree = v.keyIndexes.map((i) => hexToBytes(vectors.seeds[i]!));
    const { psbt, added } = signPsbt(parsePsbt(v.unsignedPsbt), allThree);
    expect(added).toBe(2);
    expect(psbt.inputs[0]!.dilithiumSigs.length).toBe(2);
    expect(finalizePsbt(psbt).complete).toBe(true);

    const forced = signPsbt(parsePsbt(v.unsignedPsbt), allThree, { signWhenAlreadyFinalizable: true });
    expect(forced.added).toBe(3);
    expect(serializePsbtBase64(forced.psbt)).toBe(v.combinedPsbt);
  });

  it('still signs an input that is one signature short', () => {
    // The guard must key on "already finalizable", not on "already signed".
    const oneOfTwoNeeded = parsePsbt(v.singlySignedPsbts[0]!.psbt);
    expect(inspectP2MRInput(oneOfTwoNeeded, 0).status).toBe('partially_signed');
    expect(signPsbt(oneOfTwoNeeded, [seedOf(keyAt(v, 1))]).added).toBe(1);
  });
});

describe('two inputs in one transaction', () => {
  const v = vectors.twoInputs;

  it('reads both inputs and both spent outputs', () => {
    const psbt = parsePsbt(v.unsignedPsbt);
    expect(psbt.inputs.length).toBe(2);
    expect(spentOutputs(psbt)!.map((s) => s.value.toString())).toEqual(v.prevouts.map((p) => p.value));
    expect(spentOutputs(psbt)!.map((s) => hex(s.script))).toEqual(v.prevouts.map((p) => p.script));
  });

  it('signs both inputs with a sighash that differs per index', () => {
    // The BIP341 sighash commits to the input index, so the two signatures from
    // one key over one transaction must differ. A signer that computed the
    // sighash once and reused it would produce two identical ones here and a
    // transaction the chain rejects on the second input.
    const seed = seedOf(keyAt(v, v.signerKeyIndexes[0]!));
    const { psbt, added } = signPsbt(parsePsbt(v.unsignedPsbt), [seed]);
    expect(added).toBe(2);
    const [first, second] = psbt.inputs.map((i) => hex(i.dilithiumSigs[0]!.signature));
    expect(first).not.toBe(second);
    expect(serializePsbtBase64(psbt)).toBe(v.singlySignedPsbts[0]!.psbt);
  });

  it('combines and finalizes both inputs to btq-core bytes', () => {
    const combined = combinePsbts(v.singlySignedPsbts.map((s) => parsePsbt(s.psbt)));
    expect(serializePsbtBase64(combined)).toBe(v.combinedPsbt);
    const final = finalizePsbt(combined);
    expect(final.complete).toBe(true);
    expect(final.hex).toBe(v.finalizedHex);
    expect(serializePsbtBase64(final.psbt)).toBe(v.finalizedPsbt);
    expect(final.psbt.inputs.map((i) => i.finalScriptWitness!.map(hex))).toEqual(v.finalizedWitnesses);
  });

  it('is incomplete while only one of the two inputs is finalizable', () => {
    // `complete` has to mean every input, not the first one. Finalizing a copy
    // that is one signature short everywhere must yield no transaction at all.
    expect(v.underThresholdComplete).toBe(false);
    const half = finalizePsbt(parsePsbt(v.singlySignedPsbts[0]!.psbt));
    expect(half.complete).toBe(false);
    expect(half.hex).toBeUndefined();
    expect(half.psbt.inputs.every((i) => i.finalScriptWitness === undefined)).toBe(true);
  });
});

describe('validation branches that no btq-core vector exercises', () => {
  // Reached by building a Psbt directly rather than through the wire, because
  // several of them describe states the wire format cannot even express — a
  // leaf with no control block, two leaves colliding on one hash. They still
  // have to hold: signPsbt and finalizePsbt accept a Psbt from any caller.
  const v = vectors.cases[0]!;
  const edit = (source: string, change: (input: PsbtInput) => PsbtInput): Psbt => {
    const psbt = parsePsbt(source);
    return { ...psbt, inputs: psbt.inputs.map(change) };
  };

  it('refuses a control block with the parity bit clear', () => {
    const psbt = edit(v.unsignedPsbt, (input) => ({
      ...input,
      p2mrLeaves: input.p2mrLeaves.map((leaf) => ({ ...leaf, controlBlocks: [hexToBytes('c0')] })),
    }));
    expectPsbtError(() => signPsbt(psbt, [seedOf(0)]), /parity bit/);
  });

  it('refuses a control block whose leaf version disagrees with the leaf', () => {
    const psbt = edit(v.unsignedPsbt, (input) => ({
      ...input,
      p2mrLeaves: input.p2mrLeaves.map((leaf) => ({ ...leaf, leafVersion: 0xc2 })),
    }));
    expectPsbtError(() => signPsbt(psbt, [seedOf(0)]), /leaf version does not match/);
  });

  it('refuses a leaf advertised with no control block', () => {
    const psbt = edit(v.unsignedPsbt, (input) => ({
      ...input,
      p2mrLeaves: input.p2mrLeaves.map((leaf) => ({ ...leaf, controlBlocks: [] })),
    }));
    expectPsbtError(() => finalizePsbt(psbt), /no control block/);
  });

  it('refuses a sighash type other than SIGHASH_ALL', () => {
    // BTQ P2MR consensus rejects SIGHASH_DEFAULT outright, so SIGHASH_ALL is
    // the only type a Dilithium leaf signature can usefully commit to.
    const psbt = edit(v.unsignedPsbt, (input) => ({ ...input, sighashType: 0x81 }));
    expectPsbtError(() => signPsbt(psbt, [seedOf(0)]), /only support SIGHASH_ALL/);
  });

  it('refuses signatures that refer to more than one leaf', () => {
    const signed = parsePsbt(v.singlySignedPsbts[0]!.psbt);
    const strayLeafHash = Uint8Array.from(signed.inputs[0]!.dilithiumSigs[0]!.leafHash);
    strayLeafHash[0] = strayLeafHash[0]! ^ 0xff;
    const psbt: Psbt = {
      ...signed,
      inputs: signed.inputs.map((input) => ({
        ...input,
        dilithiumSigs: [...input.dilithiumSigs,
          { ...input.dilithiumSigs[0]!, leafHash: strayLeafHash }],
      })),
    };
    // The stray leaf hash names a leaf the PSBT does not carry, which is the
    // first of the two refusals it earns.
    expectPsbtError(() => finalizePsbt(psbt), /leaf the PSBT does not contain|more than one leaf/);
  });
});

describe('malformed containers', () => {
  const good = decodeBase64(vectors.cases[0]!.unsignedPsbt);

  it('refuses a map with no separator', () => {
    expectPsbtError(() => parsePsbt(good.slice(0, good.length - 1)), /separator is missing/);
  });

  it('refuses trailing bytes after the last map', () => {
    expectPsbtError(() => parsePsbt(concatBytes(good, new Uint8Array([0x00]))), /trailing bytes|separator/);
  });

  it('refuses a PSBT with no unsigned transaction', () => {
    const maps = splitPsbt(good);
    maps[0] = maps[0]!.filter((e) => e.key[0] !== 0x00);
    expectPsbtError(() => parsePsbt(joinPsbt(maps)), /missing its unsigned transaction/);
  });

  it('refuses an unsigned transaction that does not re-serialise to its own bytes', () => {
    // A non-canonical compact size decodes to the same transaction and back to
    // different bytes. Accepting it would mean computing a sighash over bytes
    // no other implementation ever saw.
    const maps = splitPsbt(good);
    const tx = maps[0]!.find((e) => e.key[0] === 0x00)!;
    const padded = concatBytes(tx.value.slice(0, 4), hexToBytes('fd0100'), tx.value.slice(5));
    maps[0] = [{ key: tx.key, value: padded }];
    expectPsbtError(() => parsePsbt(joinPsbt(maps)), /does not decode|does not re-serialise/);
  });

  it('refuses an unsupported PSBT version', () => {
    const maps = splitPsbt(good);
    maps[0] = [...maps[0]!, { key: new Uint8Array([0xfb]), value: hexToBytes('01000000') }];
    expectPsbtError(() => parsePsbt(joinPsbt(maps)), /unsupported PSBT version/);
  });

  it('refuses a global xpub key of the wrong size', () => {
    const maps = splitPsbt(good);
    maps[0] = [...maps[0]!, { key: concatBytes(new Uint8Array([0x01]), new Uint8Array(40)), value: new Uint8Array(4) }];
    expectPsbtError(() => parsePsbt(joinPsbt(maps)), /expected size for the type global xpub/);
  });

  it('refuses an output key with a malformed type prefix', () => {
    // Caught at parse rather than surfacing much later as a throw from the
    // serializer, which is where it used to land.
    const maps = splitPsbt(good);
    maps[2] = [...maps[2]!, { key: new Uint8Array([0xfd]), value: new Uint8Array(1) }];
    expectPsbtError(() => parsePsbt(joinPsbt(maps)), /no valid type prefix/);
  });

  it('refuses two global xpubs, whose btq-core order it cannot reproduce', () => {
    const psbt = parsePsbt(vectors.cases[0]!.unsignedPsbt);
    const xpub = (fill: number) => ({
      key: concatBytes(new Uint8Array([0x01]), new Uint8Array(78).fill(fill)),
      value: new Uint8Array(4),
    });
    expectPsbtError(() => serializePsbt({ ...psbt, globals: [xpub(2), xpub(1)] }), /orders them by something other/);
  });
});

describe('the end-to-end path a cosigning extension actually walks', () => {
  it('parses, signs twice independently, combines and finalizes to btq-core bytes', () => {
    for (const v of vectors.cases) {
      const seeds = v.signerKeyIndexes.map((slot) => seedOf(keyAt(v, slot)));
      // Each cosigner starts from the same unsigned PSBT, in ignorance of the
      // others — the shape that makes parallel signing work at all.
      const halves = seeds.map((seed) => signPsbt(parsePsbt(v.unsignedPsbt), [seed]).psbt);
      const combined = combinePsbts(halves);
      expect(serializePsbtBase64(combined)).toBe(v.combinedPsbt);
      const final = finalizePsbt(combined);
      expect(final.hex).toBe(v.finalizedHex);
    }
  });

  it('sequential signing arrives at the same transaction as parallel signing', () => {
    for (const v of vectors.cases) {
      let psbt = parsePsbt(v.unsignedPsbt);
      for (const slot of v.signerKeyIndexes) {
        psbt = signPsbt(psbt, [seedOf(keyAt(v, slot))]).psbt;
      }
      expect(finalizePsbt(psbt).hex).toBe(v.finalizedHex);
    }
  });
});

describe('what btq-core will not do for us', () => {
  it('cannot sign a Dilithium P2MR input from the PSBT alone', () => {
    // Measured, not assumed — scripts/gen-psbt-vectors.py runs both halves on a
    // regtest node. A wallet holding the key but no registration of the address
    // signs nothing; the same wallet after createdilithiummultisig signs. That
    // is the whole reason this module exists rather than shelling out to a node:
    // there is no node-side path an extension could have used.
    expect(vectors.signFromPsbtAlone.supported).toBe(false);
    expect(vectors.signFromPsbtAlone.unregisteredWalletSignatures).toBe(0);
    expect(vectors.signFromPsbtAlone.registeredWalletSignatures).toBe(1);
  });

  it('but the PSBT it produces already carries everything a signer needs', () => {
    // ...which is why *this* wallet can sign it: the leaf, its control block and
    // the merkle root are all in the PSBT, and the key is ours.
    const probe = vectors.signFromPsbtAlone;
    const psbt = parsePsbt(probe.unsignedPsbt);
    const info = inspectP2MRInput(psbt, 0);
    expect(hex(info.leaf!.script)).toBe(probe.leafScript);
    expect(info.policy!.pubkeys.map(hex)).toEqual(probe.pubkeys);

    const signerSeed = seedOf(vectors.pubkeys.indexOf(probe.pubkeys[0]!));
    const { added, psbt: signed } = signPsbt(psbt, [signerSeed]);
    expect(added).toBe(1);
    expect(inspectP2MRInput(signed, 0).status).toBe('partially_signed');
  });
});

describe('public key size', () => {
  it('is the 1312 bytes the wire key reserves for it', () => {
    expect(PUBLIC_KEY_BYTES).toBe(1312);
    expect(1 + PUBLIC_KEY_BYTES + 32).toBe(1345);
  });
});
