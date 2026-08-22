# btq-core reference map, through the browser-wallet lens

95 verified differences between Bitcoin Quantum and Bitcoin, each anchored to a
`btq-core` source line. The map was compiled by reading the btq-core sources directly
during earlier BTQ work, then re-audited for this repository (nine anchors corrected)
and re-framed around this wallet.

**How to use it:** treat the `btq-core` column as ground truth. The *In this wallet*
column says where the fact lives in our code, or why it does not apply — so this doubles
as a coverage checklist. Anything still marked _planned_ is a fact the wallet relies on
but does not encode — the four left are consensus limits (script element size, sigop cost,
the per-input validation budget, block weight) that only matter if a future change makes
them binding.

Legend: **implemented** · _planned_ · not applicable


_Coverage: 53 implemented, 4 planned, 38 not applicable. Re-audited after the send path,
the explorer client and the node RPC landed._

## Signatures and script validation

### ML-DSA-44 (FIPS 204) as the transaction signature scheme

- **Bitcoin:** secp256k1: 33-byte compressed / 32-byte x-only pubkeys, 71-72 byte DER ECDSA or 64/65-byte Schnorr signatures.
- **BTQ:** Vendored pq-crystals reference tree compiled at DILITHIUM_MODE=2, i.e. ML-DSA-44: public key 1312 B, secret key 2560 B, signature 2420 B, HD seed 32 B. FIPS 204 parameters (TRBYTES 64, RNDBYTES 32, CTILDEBYTES 32) confirm the post-round-3 standard, not round-3 Dilithium.
- **btq-core:** `src/crypto/dilithium_wrapper.h:16` (BTQ_DILITHIUM_PUBLIC_KEY_SIZE 1312), :17 (SECRET 2560), :18 (SIGNATURE 2420), :21 (SEED 32); `src/crypto/dilithium/ref/config.h:10` (DILITHIUM_MODE 2); `src/crypto/dilithium/ref/params.h:6-9`,24 (SEEDBYTES 32 / CRHBYTES 64 / TRBYTES 64 / RNDBYTES 32 / CTILDEBYTES 32); `src/crypto/dilithium_key.h:64` (DilithiumConstants::DILITHIUM2_PUBLIC_KEY_SIZE)
- **In this wallet:** **implemented** — `src/core/crypto/mldsa.ts`, `src/core/script/p2mr.ts`

### Deterministic (non-hedged) ML-DSA signing

- **Bitcoin:** RFC 6979 deterministic ECDSA; BIP340 Schnorr with optional aux randomness.
- **BTQ:** DILITHIUM_RANDOMIZED_SIGNING is left undefined, so rnd = 32 zero bytes (the deterministic FIPS 204 variant). Upstream flipped its own default to hedged in Sept 2024; BTQ deliberately did not follow.
- **btq-core:** `src/crypto/dilithium/ref/config.h:5` (//#define DILITHIUM_RANDOMIZED_SIGNING, left commented); `src/crypto/dilithium/ref/sign.c:259-264` (#ifdef branch zero-fills rnd); `src/crypto/dilithium/PROVENANCE.md:98-110`
- **In this wallet:** **implemented** — `src/core/crypto/mldsa.ts`, `src/core/script/p2mr.ts`

### Empty FIPS 204 context string on every consensus signature

- **Bitcoin:** No context-string concept; BIP340 uses fixed tagged hashes.
- **BTQ:** ctx length 0 everywhere on the consensus path, so the ML-DSA message prefix is exactly (0x00, 0x00). btq-core passes NULL/0 down to pqcrystals_dilithium2_ref_{signature,verify}; the context is domain-separating, so any non-empty ctx fails to verify.
- **btq-core:** `src/crypto/dilithium_pubkey.cpp:73-88` (CDilithiumPubKey::VerifyMessage, default context={}); `src/script/interpreter.cpp:1983` (VerifyDilithiumSignature -> pubkey.Verify(sighash, vchSig) with the default empty context); `src/crypto/dilithium_wrapper.c:39-42` (ctx_ptr=NULL when ctxlen==0); `src/crypto/dilithium/ref/sign.c:253-257` (pre = 0 || ctxlen || ctx)
- **In this wallet:** **implemented** — `src/core/crypto/mldsa.ts`, `src/core/script/p2mr.ts`

### Sign the 32-byte sighash directly (pure ML-DSA, no pre-hash mode)

- **Bitcoin:** ECDSA/Schnorr sign the 32-byte sighash directly.
- **BTQ:** The message handed to ML-DSA.Sign is the raw 32-byte BIP341 tapscript sighash; ML-DSA pre-hash (HashML-DSA) is not used, and BouncyCastle rejects pre-hash parameters on this path.
- **btq-core:** `src/script/sign.cpp:116-117` (SignatureHashSchnorr -> key.Sign(hash, vchSig)); `src/crypto/dilithium_key.cpp:104-112` (CDilithiumKey::Sign passes a Span over the uint256 as the message); `src/script/interpreter.cpp:1964-1971` (verifier recomputes the same 32-byte sighash)
- **In this wallet:** **implemented** — `src/core/crypto/mldsa.ts`, `src/core/script/p2mr.ts`

### Fixed 2421-byte witness signature: 2420-byte ML-DSA sig + explicit sighash byte

- **Bitcoin:** Variable-length DER + hashtype byte; BIP341 allows 64 bytes (SIGHASH_DEFAULT, byte omitted) or 65.
- **BTQ:** A Dilithium witness signature must be empty or exactly BTQ_DILITHIUM_SIGNATURE_SIZE + 1 = 2421 bytes, otherwise SCRIPT_ERR_SIG_DER. The trailing byte is the hashtype and SIGHASH_DEFAULT (0x00) is rejected in P2MR, so the byte is mandatory. PSBT field 0x1b likewise fixes the value at 2421.
- **btq-core:** `src/script/interpreter.cpp:116` (sig.size() != BTQ_DILITHIUM_SIGNATURE_SIZE + 1 -> SCRIPT_ERR_SIG_DER), :1958-1959 (nHashType = vchSig.back(); pop_back), :1966 (P2MR rejects SIGHASH_DEFAULT); `src/psbt.h:82` (MAX_DILITHIUM_PARTIAL_SIG_VALUE_SIZE = SIGNATURE_SIZE + 1), :774
- **In this wallet:** **implemented** — `src/core/crypto/mldsa.ts`, `src/core/script/p2mr.ts`

### OP_CHECKSIGDILITHIUM (0xbb) / OP_CHECKSIGDILITHIUMVERIFY (0xbc)

- **Bitcoin:** 0xbb-0xbf are undefined, and in BIP342 tapscript 0xbb falls in the OP_SUCCESSx range (187-254), making any script containing it anyone-can-spend.
- **BTQ:** Real opcodes. MAX_OPCODE is raised from OP_NOP10 to OP_DILITHIUM_PUBKEY (0xbf), and IsOpSuccess starts its upper success range at 192 instead of 187 so the five Dilithium opcodes are never OP_SUCCESSx. Evaluation runs through EvalChecksigDilithium -> BaseSignatureChecker::CheckDilithiumSignature, with SCRIPT_VERIFY_NULLFAIL applied to a non-empty failing signature.
- **btq-core:** `src/script/script.h:220-221` (opcodes), :230 (MAX_OPCODE = OP_DILITHIUM_PUBKEY); `src/script/script.cpp:353-362` (IsOpSuccess, 192..254); `src/script/interpreter.cpp:114-141` (EvalChecksigDilithium), :1270-1310 (opcode case), :1297 (NULLFAIL)
- **In this wallet:** not applicable — Single-key wallet: only `OP_CHECKSIGDILITHIUM` (0xbb) is produced.

### OP_CHECKMULTISIGDILITHIUM (0xbd) / VERIFY (0xbe) and the threshold-accumulator leaf

- **Bitcoin:** OP_CHECKMULTISIG exists in legacy/P2WSH but is banned in tapscript (SCRIPT_ERR_TAPSCRIPT_CHECKMULTISIG); OP_CHECKSIGADD replaces it.
- **BTQ:** btq-core re-enables a CHECKMULTISIG-shaped Dilithium opcode inside P2MR tapscript (including the historical one-extra-argument bug and NULLDUMMY), capped at MAX_PUBKEYS_PER_MULTISIG = 20, plus an OP_CHECKSIGDILITHIUM accumulator template. ECDSA OP_CHECKMULTISIG stays banned in P2MR (interpreter.cpp:1161).
- **btq-core:** `src/script/script.h:222-223`; `src/script/interpreter.cpp:1312-1405` (multisig case; key cap at :1336, NULLFAIL :1381, NULLDUMMY :1391); `src/script/dilithium_leaf.cpp:13-25` (GetScriptForDilithiumThreshold), :41-77 (ParseThresholdAccumulator)
- **In this wallet:** not applicable — Single-key wallet: only `OP_CHECKSIGDILITHIUM` (0xbb) is produced.

### OP_DILITHIUM_PUBKEY (0xbf) structural pubkey predicate

- **Bitcoin:** No equivalent opcode.
- **BTQ:** Pops one stack item and pushes true iff it is a structurally valid 1312-byte ML-DSA public key (size + non-zero rho + non-zero t1). Same P2MR-only and SCRIPT_VERIFY_DILITHIUM gating as the CHECKSIG opcodes.
- **btq-core:** `src/script/script.h:224` (OP_DILITHIUM_PUBKEY = 0xbf); `src/script/interpreter.cpp:1407-1432` (opcode case), :1428 (fSuccess = IsValidDilithiumPubKey), :100-107 (IsValidDilithiumPubKey)
- **In this wallet:** not applicable — Single-key wallet: only `OP_CHECKSIGDILITHIUM` (0xbb) is produced.

### Dilithium opcodes are consensus-valid only inside P2MR (witness v2) tapscript

- **Bitcoin:** No such concept; tapscript opcodes are valid in BIP341 tapscript only by construction.
- **BTQ:** SCRIPT_VERIFY_DILITHIUM_P2MR_ONLY (1U<<23) makes all five opcodes fail with SCRIPT_ERR_TAPSCRIPT_DILITHIUM outside SigVersion::P2MR_TAPSCRIPT and disables the legacy witness-v0 1312-byte-key routing. Mainnet activates it at height 1; testnet leaves nDilithiumP2MRHeight = INT_MAX so it is policy-only there. Legacy BASE Dilithium templates are non-standard to relay on every chain.
- **btq-core:** `src/script/interpreter.h:155` (SCRIPT_VERIFY_DILITHIUM_P2MR_ONLY), :207 (SigVersion::P2MR_TAPSCRIPT); `src/script/interpreter.cpp:1278-1282`, :2211-2221; `src/validation.cpp:2158-2164` (GetBlockScriptFlags); `src/kernel/chainparams.cpp:101` (mainnet = 1), :219 (testnet = INT_MAX); `src/policy/policy.cpp:89-95`; `src/policy/policy.h:140`
- **In this wallet:** **implemented** — `src/core/crypto/mldsa.ts`, `src/core/script/p2mr.ts`

### Dilithium sigop cost 50 and tapscript validation-weight cost 500

- **Bitcoin:** OP_CHECKSIG counts 1 sigop (20 for bare CHECKMULTISIG); BIP342 charges 50 validation-weight units per passing signature against a budget of witness size + 50.
- **BTQ:** DILITHIUM_SIGOP_COST = 50 per Dilithium CHECKSIG opcode (keys x 50 for CHECKMULTISIGDILITHIUM); VALIDATION_WEIGHT_PER_DILITHIUM_SIGOP_PASSED = 500 is deducted per non-empty Dilithium signature check inside P2MR tapscript, against the same witness-size + VALIDATION_WEIGHT_OFFSET(50) budget. P2MR witness sigops are counted by re-running GetSigOpCount(true) on the leaf script.
- **btq-core:** `src/script/script.h:67` (VALIDATION_WEIGHT_PER_DILITHIUM_SIGOP_PASSED 500), :68 (DILITHIUM_SIGOP_COST 50), :70 (VALIDATION_WEIGHT_OFFSET 50); `src/script/script.cpp:175-176`, :184-188 (GetSigOpCount); `src/script/interpreter.cpp:126-132` (weight deduction), :2478-2491 (WitnessSigOps for witness v2), :2454-2469 (pre-activation witness-v0 grandfathering)
- **In this wallet:** not applicable — Single-key wallet: only `OP_CHECKSIGDILITHIUM` (0xbb) is produced.

### Structural ML-DSA public-key validity rule (IsFullyValid)

- **Bitcoin:** Pubkey encoding check plus secp256k1 curve membership; STRICTENC / WITNESS_PUBKEYTYPE reject bad encodings.
- **BTQ:** IsFullyValid() checks size == 1312, non-zero rho (first 32 bytes) and non-zero t1 (remaining 1280). There is deliberately no coefficient-range or membership analogue — random blobs pass, so this rejects only degenerate encodings keygen cannot produce. Script failure is SCRIPT_ERR_PUBKEYTYPE; PSBT decode throws 'Invalid Dilithium pubkey'.
- **btq-core:** `src/crypto/dilithium_pubkey.cpp:36-61` (CDilithiumPubKey::IsFullyValid, with the explicit non-goal documented at :41-45); `src/script/interpreter.cpp:100-107` (IsValidDilithiumPubKey), :121-123 (SCRIPT_ERR_PUBKEYTYPE); `src/psbt.h:769`; `src/script/dilithium_leaf.cpp:88`, :101
- **In this wallet:** **implemented** — `src/core/crypto/mldsa.ts`, `src/core/script/p2mr.ts`

### Every ML-DSA-signed transaction is re-validated by btq-core's own interpreter before broadcast

- **Bitcoin:** A wallet that pushes through an Electrum server or a public API gets no consensus check of the signature it just produced; the first real validation happens on a node it cannot see.
- **BTQ:** testmempoolaccept is a usable dry run: it runs the real P2MR witness-program check, the tapleaf commitment and OP_CHECKSIGDILITHIUM verification, so a wallet can refuse to broadcast unless Core's txid and wtxid match the bytes it serialized locally, and only then call sendrawtransaction and re-check the returned txid.
- **btq-core:** `src/script/interpreter.cpp:2276-2314` (witness v2 P2MR: control-block size/parity at :2296-2303, ComputeTapleafHash with control[0] & TAPROOT_LEAF_MASK at :2304, VerifyP2MRCommitment at :2305, then ExecuteWitnessScript at SigVersion::P2MR_TAPSCRIPT at :2314); `src/policy/policy.cpp:295-313`
- **In this wallet:** **implemented** — `src/core/crypto/mldsa.ts`, `src/core/script/p2mr.ts`

### Watch-only registration proves btq-core recognises the wallet's Dilithium leaf template

- **Bitcoin:** Descriptor import of an xpub; the node derives the same scripts from the descriptor.
- **BTQ:** ML-DSA has no descriptor form, so a wallet registers the leaf explicitly via getnewp2mraddress({depth:0, leaf_version:0xc0, script:<leaf hex>}) and then requires Core to echo back the identical address, scriptPubKey and merkle_root, plus getaddressinfo reporting witness_version 2, solvable and isdilithium — the last of which is true only when Core's own solver parses the leaf as a single Dilithium key.
- **btq-core:** `src/wallet/rpc/p2mr.cpp:41-92` (getnewp2mraddress); `src/wallet/rpc/addresses.cpp:723-731` (isdilithium requires GetSingleDilithiumKeyIDForP2MR for a WitnessV2P2MR dest); `src/script/dilithium_leaf.cpp:80-93` (ParseP2MRDilithiumLeaf); `src/script/solver.cpp:115-129` (MatchPayToDilithiumPubkey, OP_PUSHDATA2 form)
- **In this wallet:** **implemented** — `src/core/crypto/mldsa.ts`, `src/core/script/p2mr.ts`

## Output type and addresses

### Witness v2 as a first-class standard output type (TxoutType::WITNESS_V2_P2MR)

- **Bitcoin:** Witness v2+ programs solve to WITNESS_UNKNOWN and are anyone-can-spend under consensus; only DISCOURAGE_UPGRADABLE_WITNESS_PROGRAM (policy) keeps them out of the mempool.
- **BTQ:** Solver() returns TxoutType::WITNESS_V2_P2MR for witness version 2 with a 32-byte program (WITNESS_V2_P2MR_SIZE = 32), RPC name "witness_v2_p2mr"; SCRIPT_VERIFY_P2MR sits in MANDATORY_SCRIPT_VERIFY_FLAGS and is set unconditionally in GetBlockScriptFlags (no deployment height, no script_flag_exception can clear it), so P2MR was never anyone-can-spend on any BTQ chain.
- **btq-core:** `src/script/solver.cpp:225` (Solver, witnessversion==2 branch → TxoutType::WITNESS_V2_P2MR); `src/script/solver.h:33` (TxoutType::WITNESS_V2_P2MR); `src/script/solver.cpp:31` (GetTxnOutputType → "witness_v2_p2mr"); `src/policy/policy.h:111` (SCRIPT_VERIFY_P2MR in MANDATORY_SCRIPT_VERIFY_FLAGS); `src/validation.cpp:2165` (flags |= SCRIPT_VERIFY_P2MR, unconditional)
- **In this wallet:** **implemented** — `src/core/script/p2mr.ts`, `src/core/script/address.ts`

### scriptPubKey form OP_2 <32-byte Merkle root> (34 bytes)

- **Bitcoin:** No defined v2 output; P2TR is OP_1 <32-byte tweaked output key>.
- **BTQ:** GetScriptForDestination(WitnessV2P2MR) emits CScript() << OP_2 << 32 bytes, i.e. 0x52 0x20 <root>, 34 bytes total — same UTXO footprint as P2TR. CScript::IsWitnessProgram accepts it (size 34, byte0 OP_2, byte1+2 == size).
- **btq-core:** `src/addresstype.cpp:200` (CScript operator()(const WitnessV2P2MR&) → CScript() << OP_2 << root); `src/addresstype.h:93` (struct WitnessV2P2MR, SIZE = 32); `src/script/script.cpp:238` (CScript::IsWitnessProgram); `src/script/interpreter.h:242` (WITNESS_V2_P2MR_SIZE = 32)
- **In this wallet:** **implemented** — `src/core/script/p2mr.ts`, `src/core/script/address.ts`

### Witness program IS the TapLeaf-tagged Merkle root — no internal key, no taptweak

- **Bitcoin:** BIP341: output key Q = P + H_TapTweak(P||merkle_root)·G; the program commits to a key, and the merkle root is recovered only via the control block's internal key.
- **BTQ:** VerifyP2MRCommitment compares ComputeP2MRMerkleRoot(control, tapleaf_hash) directly against the 32-byte program — no XOnlyPubKey, no CheckTapTweak. Leaf hashing reuses BIP341 exactly: ComputeTapleafHash = tagged_hash("TapLeaf", leaf_version || compactSize(len) || script) with leaf version 0xc0 (TAPROOT_LEAF_TAPSCRIPT), and internal nodes use the BIP341 lexicographic TapBranch hash.
- **btq-core:** `src/script/interpreter.cpp:2176` (VerifyP2MRCommitment: ComputeP2MRMerkleRoot(control, tapleaf_hash) == uint256(Span{program})); `src/script/interpreter.cpp:2145` (ComputeP2MRMerkleRoot); `src/script/interpreter.cpp:2114` (ComputeTapleafHash, HASHER_TAPLEAF); `src/script/interpreter.h:245` (TAPROOT_LEAF_TAPSCRIPT = 0xc0)
- **In this wallet:** **implemented** — `src/core/script/p2mr.ts`, `src/core/script/address.ts`

### Control block: 1 + 32·m bytes with the parity bit forced to 1 (single leaf = one byte, 0xc1)

- **Bitcoin:** BIP341 control block is 33 + 32·m bytes: leaf_version|parity, then the 32-byte internal key, then the path.
- **BTQ:** P2MR_CONTROL_BASE_SIZE = 1 (no internal key), P2MR_CONTROL_NODE_SIZE = 32, P2MR_CONTROL_MAX_NODE_COUNT = 128 → P2MR_CONTROL_MAX_SIZE = 4097. The interpreter requires 1 ≤ size ≤ 4097 and (size−1) % 32 == 0 (else SCRIPT_ERR_TAPROOT_WRONG_CONTROL_SIZE), then requires (control[0] & 1) == 1 (else SCRIPT_ERR_WITNESS_PROGRAM_MISMATCH) and derives the leaf version as control[0] & 0xfe. For a one-leaf tree the control block is therefore exactly one byte, 0xc1 — 32 bytes smaller than the P2TR equivalent. Core's own builder writes control_block[0] = leaf_version | 1.
- **btq-core:** `src/script/interpreter.h:252-255` (P2MR_CONTROL_BASE_SIZE/NODE_SIZE/MAX_NODE_COUNT/MAX_SIZE); `src/script/interpreter.cpp:2296` (size check); `src/script/interpreter.cpp:2301` (parity bit must be 1); `src/script/interpreter.cpp:2304` (ComputeTapleafHash(control[0] & TAPROOT_LEAF_MASK, script)); `src/script/signingprovider.cpp:778` (P2MRBuilder::GetSpendData, control_block[0] = leaf.leaf_version | 1)
- **In this wallet:** **implemented** — `src/core/script/p2mr.ts`, `src/core/script/address.ts`

### No key path: every P2MR spend is a script path, witness = [args…, leafScript, controlBlock]

- **Bitcoin:** P2TR with a single witness element is a key-path spend (Schnorr sig against the output key).
- **BTQ:** After stripping an optional annex, the interpreter requires stack.size() >= 2 and errors SCRIPT_ERR_WITNESS_PROGRAM_MISMATCH otherwise; it pops control then script and executes the leaf under SigVersion::P2MR_TAPSCRIPT. Policy mirrors this: fewer than 2 elements is non-standard, annexes are non-standard.
- **btq-core:** `src/script/interpreter.cpp:2290` (if (stack.size() < 2) → SCRIPT_ERR_WITNESS_PROGRAM_MISMATCH); `src/script/interpreter.cpp:2314` (ExecuteWitnessScript … SigVersion::P2MR_TAPSCRIPT); `src/policy/policy.cpp:295-310` (witness v2 standardness, no-key-path branch)
- **In this wallet:** **implemented** — `src/core/script/p2mr.ts`, `src/core/script/address.ts`

### Bech32m witness-v2 address encoding under BTQ-specific HRPs (qbtc / tbtq / qtb / qcrt)

- **Bitcoin:** HRPs bc / tb / tb / bcrt; witness v2 has no defined address type, so wallets treat bc1z… as unknown.
- **BTQ:** chainparams sets bech32_hrp = "qbtc" (BTQMAIN), "tbtq" (BTQTEST), "qtb" (BTQSIGNET), "qcrt" (BTQREGTEST). EncodeDestination(WitnessV2P2MR) prepends the 5-bit value 2, ConvertBits<8,5,true> over the 32-byte root, and uses Encoding::BECH32M. DecodeDestination rejects any HRP other than the chain's, requires Bech32m for version != 0, and accepts version 2 only at exactly 32 bytes.
- **btq-core:** `src/kernel/chainparams.cpp:148` (main "qbtc"), :267 (test "tbtq"), :401 (signet "qtb"), :552 (regtest "qcrt"); `src/key_io.cpp:68-73` (operator()(const WitnessV2P2MR&), data = {2}, BECH32M, m_params.Bech32HRP()); `src/key_io.cpp:196` (HRP must equal params.Bech32HRP()), :210 (version != 0 must use Bech32m), :247 (version == 2 && size == WITNESS_V2_P2MR_SIZE → WitnessV2P2MR)
- **In this wallet:** **implemented** — `src/core/script/p2mr.ts`, `src/core/script/address.ts`

### Wallet↔Core P2MR commitment round-trip: the node recomputes the root from the leaf and the wallet asserts byte equality

- **Bitcoin:** No analogue — Bitcoin wallets derive addresses locally from descriptors the node also holds.
- **BTQ:** getnewp2mraddress takes the DFS leaf tree ({depth, leaf_version, script}), runs it through P2MRBuilder, and returns address, p2mr_id, scriptPubKey and merkle_root. The wallet sends depth 0 / leaf_version 0xc0 / its own 1316-byte leaf and refuses to proceed unless Core's address, scriptPubKey and merkle_root all equal the values it computed locally; listunspent rows are re-parsed as same-network P2MR and their scriptPubKey re-derived from the address.
- **btq-core:** `src/wallet/rpc/p2mr.cpp:41` (getnewp2mraddress), :54-57 (returns address / p2mr_id / scriptPubKey / merkle_root); `src/wallet/p2mr.cpp:399-402` (leaf_version parity check then P2MRBuilder::Add); `src/wallet/p2mr.cpp:595-599` (CreateSingleLeafDilithiumP2MR: CScript() << ToByteVector(pubkey) << OP_CHECKSIGDILITHIUM at depth 0, leaf_version TAPROOT_LEAF_TAPSCRIPT)
- **In this wallet:** **implemented** — `src/core/script/p2mr.ts`, `src/core/script/address.ts`

### A P2MR address comes from an ML-DSA public key, not from an EC key

- **Bitcoin:** A wallet picks an output type per keystore — P2PKH / P2SH-P2WPKH / P2WPKH / P2WSH / P2TR — and every one of them hangs off a secp256k1 key and has a descriptor.
- **BTQ:** A BTQ wallet is P2MR-only, and there is no EC key anywhere in the path: the address and the output script are derived from the 1312-byte ML-DSA public key wrapped in a single leaf. The key is over 0xff bytes, so CScript encodes the push as OP_PUSHDATA2 + LE16 (0x4d 0x20 0x05) — a leaf built with a one-byte push length is a different script and a different address. Descriptor export degrades to addr(<address>): no descriptor language exists for a raw ML-DSA key.
- **btq-core:** `src/wallet/p2mr.cpp:595` (single-leaf Dilithium P2MR leaf script); `src/script/script.h:494` (CScript push encoding: >0xff ⇒ OP_PUSHDATA2 + LE16, so the 1312-byte key encodes as 0x4d 0x20 0x05); `src/script/script.h:220` (OP_CHECKSIGDILITHIUM = 0xbb); `src/crypto/dilithium_key.h:243` (CDilithiumPubKey::SIZE = DilithiumConstants::PUBLIC_KEY_SIZE, 1312 at line 64)
- **In this wallet:** **implemented** — `src/core/script/p2mr.ts`, `src/core/script/address.ts`

## Transaction digest

### P2MR script-path digest is the BIP341/342 TapSighash

- **Bitcoin:** SignatureHashSchnorr is reachable only for SigVersion::TAPROOT and TAPSCRIPT (witness v1, 32-byte program).
- **BTQ:** A fourth SigVersion P2MR_TAPSCRIPT = 4 (witness v2, 32-byte program) enters the SAME SignatureHashSchnorr with ext_flag = 1 and key_version = 0; no BTQ-specific field, tag or ordering is added. Tag is TaggedHash("TapSighash"), single SHA256.
- **btq-core:** `src/script/interpreter.cpp:1696` (SignatureHashSchnorr), :1705 (case SigVersion::P2MR_TAPSCRIPT -> ext_flag=1, key_version=0), :1774 (BIP342 extension block applies to P2MR), :1679 (HASHER_TAPSIGHASH); `src/script/interpreter.h:207` (P2MR_TAPSCRIPT = 4)
- **In this wallet:** **implemented** — `src/core/tx/sighash.ts`

### Sighash epoch byte

- **Bitcoin:** First byte of the TapSighash message is a constant 0x00 epoch (BIP341).
- **BTQ:** Unchanged: EPOCH = 0 written first, no BTQ epoch bump for witness v2.
- **btq-core:** `src/script/interpreter.cpp:1724` (static constexpr uint8_t EPOCH = 0), :1725 (ss << EPOCH)
- **In this wallet:** **implemented** — `src/core/tx/sighash.ts`

### ext_flag / spend_type

- **Bitcoin:** spend_type = (ext_flag << 1) + annex_present; ext_flag = 0 for key path, 1 for BIP342 tapscript.
- **BTQ:** Unchanged formula. P2MR has NO key path (witness must carry at least script + control block), so ext_flag is always 1 and spend_type is always 0x02 (or 0x03 with an annex).
- **btq-core:** `src/script/interpreter.cpp:1749` (spend_type = (ext_flag << 1) + have_annex), :1705 (P2MR_TAPSCRIPT -> ext_flag=1), :2295-2297 (P2MR requires >= 2 stack items, no key path)
- **In this wallet:** **implemented** — `src/core/tx/sighash.ts`

### TapLeaf hash inside the digest

- **Bitcoin:** ss << tagged_hash("TapLeaf", leaf_version || compact_size(len(script)) || script), with leaf_version taken from control[0] & 0xfe.
- **BTQ:** Identical construction and identical tag. P2MR additionally requires the control byte's parity bit to be 1 (so the canonical control byte is 0xc1) and only leaf version 0xc0 is executed as tapscript; the merkle root is committed in the witness v2 program instead of a tweaked output key.
- **btq-core:** `src/script/interpreter.cpp:2116` (ComputeTapleafHash: HASHER_TAPLEAF << leaf_version << CompactSizeWriter(script.size()) << script), :1680 (HASHER_TAPLEAF = TaggedHash("TapLeaf")), :2301 (control[0] & 1 must be 1), :2304 (ComputeTapleafHash(control[0] & TAPROOT_LEAF_MASK, script)), :1776 (ss << execdata.m_tapleaf_hash); `src/script/interpreter.h:244-245` (TAPROOT_LEAF_MASK 0xfe, TAPROOT_LEAF_TAPSCRIPT 0xc0)
- **In this wallet:** **implemented** — `src/core/tx/sighash.ts`

### key_version byte

- **Bitcoin:** BIP342 appends a key_version byte of 0x00 after the tapleaf hash.
- **BTQ:** Unchanged 0x00, even though the key being checked is a 1312-byte ML-DSA-44 key rather than a 32-byte x-only key. BTQ did NOT allocate a new key_version for Dilithium.
- **btq-core:** `src/script/interpreter.cpp:1705-1710` (key_version = 0 for both TAPSCRIPT and P2MR_TAPSCRIPT), :1777 (ss << key_version)
- **In this wallet:** **implemented** — `src/core/tx/sighash.ts`

### Codeseparator position

- **Bitcoin:** BIP342 commits uint32 codeseparator_pos, defaulting to 0xFFFFFFFF and set to the opcode index of the last executed OP_CODESEPARATOR.
- **BTQ:** Unchanged: EvalScript initialises 0xFFFFFFFFUL and OP_CODESEPARATOR updates it identically inside a P2MR leaf. btq-core's own signer only ever produces the 0xFFFFFFFF form.
- **btq-core:** `src/script/interpreter.cpp:487` (execdata.m_codeseparator_pos = 0xFFFFFFFFUL), :1101-1108 (OP_CODESEPARATOR sets m_codeseparator_pos = opcode_pos), :1779 (ss << execdata.m_codeseparator_pos); `src/script/sign.cpp:113` (signer hardcodes 0xFFFFFFFF for the Dilithium path)
- **In this wallet:** **implemented** — `src/core/tx/sighash.ts`

### Annex handling

- **Bitcoin:** Optional last witness element beginning with 0x50 is stripped, its sha256(ser_string(annex)) folded into the digest, and the low bit of spend_type set; annexes are nonstandard.
- **BTQ:** Identical stripping, hashing and standardness rejection, applied to the witness v2 P2MR branch as well.
- **btq-core:** `src/script/interpreter.cpp:2280-2288` (P2MR annex strip, m_annex_hash, m_annex_init), :1747-1749 (assert m_annex_init, spend_type low bit), :1758-1759 (ss << m_annex_hash); `src/policy/policy.cpp:295-299` (witness v2 P2MR annexes nonstandard)
- **In this wallet:** **implemented** — `src/core/tx/sighash.ts`

### Permitted SIGHASH types for a Dilithium input; 0x00 vs 0x01

- **Bitcoin:** Schnorr: a 64-byte signature means SIGHASH_DEFAULT (0x00, digest commits 0x00); a 65-byte signature carries an explicit byte and 0x00 is rejected as non-minimal. Permitted set is {0x00, 0x01, 0x02, 0x03, 0x81, 0x82, 0x83}.
- **BTQ:** A Dilithium signature MUST be exactly 2420 + 1 = 2421 bytes, i.e. the sighash byte is mandatory, never implied. SIGHASH_DEFAULT (0x00) is explicitly rejected for Dilithium before the digest is even computed, so the accepted set is {0x01, 0x02, 0x03, 0x81, 0x82, 0x83}. Everything else is rejected inside SignatureHashSchnorr's range check. btq-core's own signer maps a requested SIGHASH_DEFAULT to SIGHASH_ALL rather than erroring. A wrong byte on a non-empty signature aborts the script via NULLFAIL, it does not merely push false.
- **btq-core:** `src/script/interpreter.cpp:1966` (if (nHashType == SIGHASH_DEFAULT) return false), :116 (sig.size() must be BTQ_DILITHIUM_SIGNATURE_SIZE + 1), :1730 (hash_type <= 0x03 || 0x81..0x83), :1728 (SIGHASH_DEFAULT -> SIGHASH_ALL for output_type), :1296-1297 (NULLFAIL on non-empty failing sig); `src/script/sign.cpp:105` (hashtype = nHashType == SIGHASH_DEFAULT ? SIGHASH_ALL : nHashType), :119 (vchSig.push_back(hashtype)); `src/crypto/dilithium_wrapper.h:18` (BTQ_DILITHIUM_SIGNATURE_SIZE 2420)
- **In this wallet:** **implemented** — `src/core/tx/sighash.ts`

### Nothing but the wallet computes the digest, so verify it against a node

- **Bitcoin:** A wallet signs the digest it computed itself, and the backend it broadcasts through never re-derives it.
- **BTQ:** Same exposure, larger blast radius: the P2MR digest is the BIP341 tapscript sighash over a leaf only the wallet holds, and no explorer or PSBT field carries it. The cheap defence is a dry run against testmempoolaccept before broadcast, where a wrong digest surfaces as a rejection rather than a lost coin.
- **btq-core:** `src/script/interpreter.cpp:1974` (VerifyDilithiumSignature gate reached only after the P2MR digest matches), :2314 (ExecuteWitnessScript with SigVersion::P2MR_TAPSCRIPT)
- **In this wallet:** **implemented** — `src/core/tx/sighash.ts`

## Weight, fees and limits

### Witness scale factor of 16

- **Bitcoin:** WITNESS_SCALE_FACTOR = 4; a witness byte costs 1/4 vbyte (75% discount).
- **BTQ:** WITNESS_SCALE_FACTOR = 16; a witness byte costs 1/16 vbyte (93.75% discount), so a 2421-byte ML-DSA signature prices at ~151 vB instead of ~605 vB. Every weight/vsize/dust constant below is derived from this one change.
- **btq-core:** `src/consensus/consensus.h:21` (WITNESS_SCALE_FACTOR = 16)
- **In this wallet:** **implemented** — `src/core/tx/fee.ts` — every weight, vsize and fee number derives from this constant

### Transaction weight formula

- **Bitcoin:** GetTransactionWeight = stripped_size * 3 + total_size.
- **BTQ:** GetTransactionWeight = stripped_size * (WITNESS_SCALE_FACTOR - 1) + total_size = stripped_size * 15 + total_size. Same for GetBlockWeight and GetTransactionInputWeight (which adds the separately-serialized witness stack).
- **btq-core:** `src/consensus/validation.h:148-151` (GetTransactionWeight); :152-155 (GetBlockWeight); :156-160 (GetTransactionInputWeight)
- **In this wallet:** **implemented** — `src/core/tx/fee.ts` `transactionWeight()`

### Virtual size computation

- **Bitcoin:** GetVirtualTransactionSize = (max(weight, sigops*bytes_per_sigop) + 3) / 4.
- **BTQ:** GetVirtualTransactionSize = (max(nWeight, nSigOpCost * bytes_per_sigop) + WITNESS_SCALE_FACTOR - 1) / WITNESS_SCALE_FACTOR, i.e. ceil(weight/16). DEFAULT_BYTES_PER_SIGOP is unchanged at 20 (policy.h:40).
- **btq-core:** `src/policy/policy.cpp:357-360` (GetVirtualTransactionSize(nWeight,...)); :362-365 (from CTransaction); :367-370 (GetVirtualTransactionInputSize)
- **In this wallet:** **implemented** — `src/core/tx/fee.ts` `virtualSizeCeil()`

### Standard-transaction weight ceiling vs P2MR input cost

- **Bitcoin:** MAX_STANDARD_TX_WEIGHT = 400,000 WU = 100,000 vB; ~2,700 P2WPKH inputs fit in one standard tx.
- **BTQ:** MAX_STANDARD_TX_WEIGHT is still 400,000 WU but now equals only 25,000 vB. With a single-key P2MR input at 4402 WU, a consolidation tx (2 P2MR outputs) holds at most 90 inputs: 90 inputs = 397,718 WU (standard), 91 inputs = 402,120 WU (rejected 'tx-size').
- **btq-core:** `src/policy/policy.h:30` (MAX_STANDARD_TX_WEIGHT{400'000}); `src/policy/policy.cpp:112-116` (IsStandardTx sets reason="tx-size"); `src/wallet/spend.cpp:1298-1302` ("Transaction too large")
- **In this wallet:** **implemented** — `src/core/tx/fee.ts` / `src/core/tx/coinselect.ts` — inputs capped at MAX_P2MR_INPUTS = 90

### Single-key P2MR input weight = 4402 WU / 275.125 vB

- **Bitcoin:** P2WPKH input ~272 WU (68 vB); P2TR key-path input ~230 WU (57.5 vB).
- **BTQ:** 41 non-witness bytes (32 txid + 4 vout + 1 empty scriptSig len + 4 nSequence) * 16 = 656 WU, plus a 3746-byte witness = 4402 WU = 275.125 vB. The 3746 is exact: varint(3) + [3-byte len + 2421-byte ML-DSA sig] + [3-byte len + 1316-byte leaf script (OP_PUSHDATA2 <1312-byte pubkey> OP_CHECKSIGDILITHIUM)] + [1-byte len + 1-byte control block].
- **btq-core:** `src/consensus/validation.h:156-160` (GetTransactionInputWeight); `src/wallet/rpc/spend.cpp:690-695` (min_input_weight CHECK_NONFATAL == 41*WITNESS_SCALE_FACTOR + 1 = 657)
- **In this wallet:** **implemented** — `src/core/tx/fee.ts` `P2MR_INPUT_WEIGHT = 4402`, `P2MR_INPUT_VSIZE = 275.125`

### Passing the P2MR input weight hint to btq-core over RPC

- **Bitcoin:** walletcreatefundedpsbt input {"weight": N} is optional; Core solves the input itself from wallet/solving data.
- **BTQ:** btq-core cannot solve a watch-only P2MR input, so the caller must supply weight explicitly. The RPC validates it against min_input_weight = 41*16+1 = 657 and against MAX_STANDARD_TX_WEIGHT = 400,000, then uses it for fee sizing.
- **btq-core:** `src/wallet/rpc/spend.cpp:685-701` (weight parsing, min/max checks, coinControl.SetInputWeight)
- **In this wallet:** not applicable — the wallet builds and signs its own transactions; it never asks a node to fund one, so there is no weight hint to pass

### Dust threshold for a P2MR output

- **Bitcoin:** A 43-byte serialized witness txout (P2TR/P2WSH) gets nSize = 43 + (32+4+1+107/4+4) = 43+67 = 110, so dust = 110*3000/1000 = 330 sats. P2WPKH = 294 sats.
- **BTQ:** The scale factor enters GetDustThreshold only through the integer division 107/WITNESS_SCALE_FACTOR: 107/16 = 6, so nSize = 43 + (32+4+1+6+4) = 90 and dust = 90*3000/1000 = 270 sats for a P2MR output (34-byte scriptPubKey OP_2 <32>, 43 bytes serialized). P2WPKH drops to 234 sats. DUST_RELAY_TX_FEE is unchanged at 3000 sat/kvB.
- **btq-core:** `src/policy/policy.cpp:26-63` (GetDustThreshold; witness branch at :54-57 adds 32+4+1+(107/WITNESS_SCALE_FACTOR)+4); `src/policy/policy.h:61` (DUST_RELAY_TX_FEE{3000}); `src/policy/policy.cpp:147-150` (IsDust -> reason="dust")
- **In this wallet:** **implemented** — `src/core/tx/fee.ts` `P2MR_DUST_SATS = 270n`, enforced on the destination and on change

### Minimum relay fee rate

- **Bitcoin:** DEFAULT_MIN_RELAY_TX_FEE = 1000 sat/kvB = 1 sat/vB; a 1-in/2-out P2WPKH spend at the floor costs ~141 sats.
- **BTQ:** Unchanged at 1000 sat/kvB, but a vbyte is now 16 WU, so the same floor charges ~4x less per witness byte. A 1-in/2-out single-key P2MR spend costs 372 sats at the floor (372 vB) rather than the ~1074 sats it would cost at scale 4. DEFAULT_INCREMENTAL_RELAY_FEE also unchanged at 1000.
- **btq-core:** `src/policy/policy.h:63` (DEFAULT_MIN_RELAY_TX_FEE{1000}); :38 (DEFAULT_INCREMENTAL_RELAY_FEE{1000})
- **In this wallet:** **implemented** — `src/core/tx/fee.ts` `MIN_RELAY_SAT_PER_KVB`; the UI offers 1000 / 2000 / 5000 sat/kvB

### Witness stack item size limit raised for post-quantum pushes

- **Bitcoin:** MAX_SCRIPT_ELEMENT_SIZE = 520 (consensus push limit); MAX_STANDARD_P2WSH_STACK_ITEM_SIZE = MAX_STANDARD_TAPSCRIPT_STACK_ITEM_SIZE = 80 (policy). A 2421-byte signature is non-standard and consensus-invalid.
- **BTQ:** MAX_SCRIPT_ELEMENT_SIZE = 15000, and both standardness caps are defined as MAX_SCRIPT_ELEMENT_SIZE (15000). MAX_STANDARD_SCRIPTSIG_SIZE is also 15000, with a static_assert that 15000*16 < MAX_STANDARD_TX_WEIGHT. That is what makes the 2421-byte ML-DSA signature stack item standard; the 1312-byte pubkey is not a separate stack item but a push inside the 1316-byte leaf script, bounded by the same 15000 at EvalScript push time.
- **btq-core:** `src/script/script.h:29` (MAX_SCRIPT_ELEMENT_SIZE = 15000); `src/policy/policy.h:46`, :48, :52, :55 (P2WSH/tapscript/scriptSig caps + static_assert); `src/script/interpreter.cpp:2100-2103` (witness stack item check) and :500 (EvalScript push check); `src/policy/policy.cpp:295-314` (IsWitnessStandard v2 P2MR branch: pops control block and script, then checks each remaining item against MAX_STANDARD_TAPSCRIPT_STACK_ITEM_SIZE)
- **In this wallet:** _planned_ — `src/core/tx/fee.ts`

### Sigop cost of a P2MR input

- **Bitcoin:** Taproot/tapscript spends contribute 0 to GetTransactionSigOpCost; CScript::GetSigOpCount counts OP_CHECKSIG as 1.
- **BTQ:** Witness v2 P2MR is NOT free: WitnessSigOps recovers the leaf script (mirroring the annex/control-block indexing) and returns leafScript.GetSigOpCount(true), where OP_CHECKSIGDILITHIUM costs DILITHIUM_SIGOP_COST = 50 and OP_CHECKMULTISIGDILITHIUM costs 50 per key. A single-key P2MR input therefore costs 50 sigops against MAX_STANDARD_TX_SIGOPS_COST = 16,000 and MAX_BLOCK_SIGOPS_COST = 80,000, and feeds the max(nWeight, nSigOpCost*20) term of the mempool's vsize.
- **btq-core:** `src/script/interpreter.cpp:2478-2491` (WitnessSigOps, witversion == 2 branch); `src/script/script.cpp:175-176`, :184-189 (DILITHIUM_SIGOP_COST weighting); `src/script/script.h:68` (DILITHIUM_SIGOP_COST = 50); `src/policy/policy.h:36` (MAX_STANDARD_TX_SIGOPS_COST = MAX_BLOCK_SIGOPS_COST/5)
- **In this wallet:** _planned_ — `src/core/tx/fee.ts` — coin selection and fee policy

### Per-input tapscript validation-weight budget for Dilithium checks

- **Bitcoin:** BIP342: budget = serialized witness stack size + VALIDATION_WEIGHT_OFFSET (50); each passing signature check costs VALIDATION_WEIGHT_PER_SIGOP_PASSED (50).
- **BTQ:** P2MR uses the same budget formula, but a passing Dilithium check costs VALIDATION_WEIGHT_PER_DILITHIUM_SIGOP_PASSED = 500 (10x an ECDSA/Schnorr check). A single-key P2MR spend has budget 3746 + 50 = 3796 and consumes 500, so it passes with room; the rule caps a P2MR leaf at floor((witness_bytes + 50)/500) Dilithium checks. Failure is SCRIPT_ERR_TAPSCRIPT_VALIDATION_WEIGHT.
- **btq-core:** `src/script/interpreter.cpp:2312-2313` (P2MR budget init) and :125-132 (Dilithium sigop debit); `src/script/script.h:67` (VALIDATION_WEIGHT_PER_DILITHIUM_SIGOP_PASSED{500}), :71 (VALIDATION_WEIGHT_OFFSET{50})
- **In this wallet:** _planned_ — `src/core/tx/fee.ts` — coin selection and fee policy

### Block weight and minimum-transaction-weight constants

- **Bitcoin:** MAX_BLOCK_WEIGHT = 4,000,000 WU, MAX_BLOCK_SERIALIZED_SIZE = 4,000,000 B, so the stripped (UTXO-affecting) block cap is 1,000,000 B and max block vsize is 1,000,000 vB. MIN_TRANSACTION_WEIGHT = 240, MIN_SERIALIZABLE_TRANSACTION_WEIGHT = 40.
- **BTQ:** MAX_BLOCK_WEIGHT = 8,000,000 WU and MAX_BLOCK_SERIALIZED_SIZE = 8,000,000 B, but because a stripped byte now costs 16 WU the stripped block cap falls to 8,000,000/16 = 500,000 B and max block vsize is 500,000 vB — half of Bitcoin's — while up to ~7.5 MB of witness data fits. MIN_TRANSACTION_WEIGHT = 16*60 = 960 and MIN_SERIALIZABLE_TRANSACTION_WEIGHT = 16*10 = 160. DEFAULT_BLOCK_MAX_WEIGHT = 7,600,000.
- **btq-core:** `src/consensus/consensus.h:13`, :15, :23, :24; `src/policy/policy.h:24` (DEFAULT_BLOCK_MAX_WEIGHT{7600000}); enforced at `src/validation.cpp:3709-3714` (CheckBlock stripped-size limit) and :3937 (GetBlockWeight > MAX_BLOCK_WEIGHT)
- **In this wallet:** _planned_ — `src/core/tx/fee.ts` — coin selection and fee policy

### Scale-16 fee rate and virtual size in the UI

- **Bitcoin:** Weight/4 is vsize everywhere, so a UI can divide by 4 wherever it needs a size or a fee rate.
- **BTQ:** Every size a user sees has to come out of the scale-16 arithmetic: the transaction's vsize, the fee rate in sat/vB, the sizing of an RBF replacement or a CPFP child, and the price of one more P2MR input (witness bytes/16, not /4). A display left on Bitcoin's /4 reports a fee rate roughly 4x too low for the same fee.
- **btq-core:** `src/core_write.cpp:183-184` (RPC "vsize" = GetVirtualTransactionSize(tx), "weight" = GetTransactionWeight(tx)) — the values the UI must reproduce
- **In this wallet:** **implemented** — `src/ui/screens/home/Send.tsx` — the review card shows sat/vB and vB alongside the fee in tBTQ

## Key management and derivation

### No public (xpub-style) derivation for ML-DSA

- **Bitcoin:** BIP32 lets an xpub derive every child public key without the private key, which is what makes watch-only wallets possible.
- **BTQ:** ML-DSA has no group law, so CDilithiumExtPubKey::Derive unconditionally returns false and CDilithiumExtKey::Derive rejects any index without DILITHIUM_HARDENED_BIT set; the wallet compensates by caching the 1312-byte public keys it can only produce while the secret is decrypted.
- **btq-core:** `src/crypto/dilithium_key.cpp:416` (CDilithiumExtPubKey::Derive returns false); `src/crypto/dilithium_key.cpp:308` (hardened-only guard in CDilithiumExtKey::Derive); `src/crypto/dilithium_key.h:368` (class comment stating the design)
- **In this wallet:** **implemented** — `src/core/crypto/hd.ts`, `src/core/crypto/mldsa.ts`

### btq-core scheme #1: legacy-wallet BIP32-analogue Dilithium tree

- **Bitcoin:** Legacy HD wallets derive secp256k1 keys down m/0'/0'/n' from the wallet HD seed using BIP32 CKDpriv.
- **BTQ:** CDilithiumExtKey mirrors the same path m/0'/0'/n' (all hardened) from the wallet's ECDSA HD seed: master = HMAC-SHA512(key="Dilithium seed", msg=hd_seed) split into 32-byte seed + 32-byte chaincode, child = HMAC-SHA512(key=parent_chaincode, msg=0x00||parent_seed(32)||ser32BE(index)), and the seed is expanded with btq_dilithium_keypair_from_seed; the durable state is a 32-byte seed, not the 2560-byte sk.
- **btq-core:** `src/wallet/scriptpubkeyman.cpp:1236` (LegacyScriptPubKeyMan::DeriveNewDilithiumChildKey, hdKeypath "m/0'/0'/n'" at :1267); `src/crypto/dilithium_key.cpp:357` (SetSeed, hashkey "Dilithium seed"); `src/crypto/dilithium_key.cpp:317` (child HMAC construction)
- **In this wallet:** **implemented** — `src/core/crypto/hd.ts`, `src/core/crypto/mldsa.ts`

### btq-core scheme #2: descriptor-wallet Dilithium key generation

- **Bitcoin:** Descriptor wallets derive every key from the descriptor's own key expression; there is no second, out-of-band key derivation.
- **BTQ:** Descriptor wallets take a completely different path: seed = first 32 bytes of HMAC-SHA512(key="Dilithium desc secret", msg = descriptor_privkey || WalletDescriptor::GetID() (uint256) || ser32BE(next_index) || 0x04), where 0x04 is static_cast<unsigned char>(OutputType::DILITHIUM_LEGACY) and is retained only for backwards compatibility; it then consumes the LEGACY descriptor's m_wallet_descriptor.next_index, the same counter used for ordinary ECDSA address expansion.
- **btq-core:** `src/wallet/scriptpubkeyman.cpp:2448` (GenerateNewDilithiumKeyLocked); :2467 (desc_ctx literal); :2472 (htobe32(next_index)); :2477 (type_byte = OutputType::DILITHIUM_LEGACY); :2503 (next_index++); `src/wallet/p2mr.cpp:640` (requires an active OutputType::LEGACY ScriptPubKeyMan)
- **In this wallet:** **implemented** — `src/core/crypto/hd.ts`, `src/core/crypto/mldsa.ts`

### Wallet-level derivation is unstandardised, and consensus never sees it

- **Bitcoin:** Key derivation is standardised across implementations by BIP32/BIP44/BIP84/BIP86, so any wallet can restore any other wallet's seed.
- **BTQ:** Outside btq-core's own two schemes there is no published BTQ standard, and derivation is not consensus-visible at all: the only key material a block ever sees is the 1312-byte public key pushed on the witness stack. Two wallets can therefore disagree about how a seed becomes keys and both produce valid spends — which makes a seed portable only between wallets that state, and share, the same convention.
- **btq-core:** `src/script/interpreter.cpp:1270` (OP_CHECKSIGDILITHIUM reads sig and pubkey off the stack; no derivation is consensus-visible); `src/outputtype.h:24` (comment: P2MR "is not descriptor-backed: destinations come from wallet/p2mr.cpp, which stores the script tree as wallet metadata")
- **In this wallet:** **implemented** — `src/core/crypto/hd.ts`; the convention this wallet adopts, and why, is stated in `docs/HD_IMPORT.md`

### Seed-to-keypair expansion is FIPS 204 ML-DSA-44 on both sides

- **Bitcoin:** secp256k1 private keys are the 32-byte scalar itself; no expansion step exists.
- **BTQ:** Both sides expand a 32-byte seed with the standard FIPS 204 ML-DSA-44 KeyGen (seed || K || L hashed with SHAKE256 into rho/rhoprime/key), so a wallet-derived seed and a btq-core seed produce byte-identical 1312-byte public keys and 2560-byte secret keys even though the two derivations that produce the seed are unrelated.
- **btq-core:** `src/crypto/dilithium/ref/sign.c:34` (crypto_sign_keypair_from_seed, seedbuf[SEEDBYTES+0]=K, [+1]=L, shake256 expansion); `src/crypto/dilithium_wrapper.h:21` (BTQ_DILITHIUM_SEED_SIZE 32); `src/crypto/dilithium_wrapper.c:21` (btq_dilithium_keypair_from_seed)
- **In this wallet:** **implemented** — `src/core/crypto/hd.ts`, `src/core/crypto/mldsa.ts`

### Descriptors cannot express a Dilithium key or a P2MR output

- **Bitcoin:** Every wallet output type has a descriptor (pk/pkh/wpkh/sh/wsh/tr/rawtr/multi/…) that fully describes how to derive and spend it.
- **BTQ:** There is no dilithium()/mldsa() key expression and no p2mr() script expression in the descriptor parser; addr(<p2mr address>) parses but AddressDescriptor::IsSolvable returns false for WitnessV2P2MR (only the four legacy Dilithium destination variants return true), so the descriptor carries no key material and no tree.
- **btq-core:** `src/script/descriptor.cpp:735` (AddressDescriptor::IsSolvable, P2MR falls through to return false at :744); `src/script/descriptor.cpp:1588-1820` (ParseScript Func list contains no p2mr/dilithium/mldsa); `src/key_io.h:21-22` (only DecodeDilithiumSecret/EncodeDilithiumSecret exist — no encoder for CDilithiumExtPubKey)
- **In this wallet:** **implemented** — `src/core/crypto/hd.ts`, `src/core/crypto/mldsa.ts`

### p2mr_id: a random wallet-local handle replaces descriptor identity

- **Bitcoin:** An address is identified by its descriptor plus derivation index; nothing wallet-local is needed to re-create it.
- **BTQ:** btq-core assigns each P2MR destination a 16-hex-character id from GetRandHash().GetHex().substr(0,16) and stores the whole tree as an address-book "receive request" under the key prefix "rrp2mr:"; the id is not derivable, is not exported by any descriptor, and is the required handle for getdilithiumpubkey / getp2mrinfo / createp2mrspend / signp2mrtransaction.
- **btq-core:** `src/wallet/p2mr.cpp:59` (NewP2MRId); `src/wallet/wallet.cpp:2963` (P2MR_RECEIVE_REQUEST_PREFIX "rrp2mr:"); `src/wallet/wallet.cpp:2966` (SetP2MRMetadata); `src/wallet/rpc/dilithium.cpp:45` (p2mr_id result field); `src/wallet/rpc/dilithium.cpp:395` (getdilithiumpubkey takes p2mr_id)
- **In this wallet:** **implemented** — `src/core/crypto/hd.ts`, `src/core/crypto/mldsa.ts`

### Key generation entry points: node-derived vs wallet-derived

- **Bitcoin:** getnewaddress always makes the node derive the key from its own descriptor/HD seed.
- **BTQ:** btq-core offers getnewdilithiumaddress, which derives a Dilithium key internally and wraps it in a single leaf <pubkey> OP_CHECKSIGDILITHIUM at depth 0, leaf_version TAPROOT_LEAF_TAPSCRIPT (0xc0), and rejects any address_type other than "p2mr". A wallet that derives its own keys never calls it and pushes its leaf through getnewp2mraddress instead, so btq-core can hold and watch key material it never generated.
- **btq-core:** `src/wallet/rpc/dilithium.cpp:30` (getnewdilithiumaddress, address_type must be "p2mr" at :68); `src/wallet/p2mr.cpp:656` (CreateDilithiumP2MRReceive); `src/wallet/p2mr.cpp:595` (single-leaf script construction); `src/wallet/rpc/p2mr.cpp:41` (getnewp2mraddress takes tree/label/internal and generates no key)
- **In this wallet:** **implemented** — `src/core/crypto/hd.ts`, `src/core/crypto/mldsa.ts`

### What btq-core stores at rest: the whole 3872-byte keypair

- **Bitcoin:** A wallet stores a 32-byte private key (or just the HD seed) per key.
- **BTQ:** btq-core stores one full CDilithiumKey per address — GetKeySize() = SECRET_KEY_SIZE (2560) + PUBLIC_KEY_SIZE (1312) = 3872 bytes — in mapDilithiumKeys/mapCryptedDilithiumKeys and base58-check-encodes all 3872 bytes for WIF export. A wallet that persists only the 32-byte seed and re-derives on demand writes nothing key-sized at all — and cannot import or export in btq-core's WIF form.
- **btq-core:** `src/crypto/dilithium_key.h:222` (GetKeySize); `src/crypto/dilithium_key.h:91` (KeyType = SECRET_KEY_SIZE + PUBLIC_KEY_SIZE array); `src/key_io.cpp:388` (EncodeDilithiumSecret over the whole key); `src/wallet/scriptpubkeyman.cpp:1037` (mapDilithiumKeys[keyID] = key)
- **In this wallet:** **implemented** — `src/core/crypto/hd.ts`, `src/core/crypto/mldsa.ts`

### Encryption of Dilithium secret material

- **Bitcoin:** Wallet encryption wraps each private key with the master key using an IV derived from the public key hash.
- **BTQ:** btq-core encrypts each 3872-byte Dilithium key with EncryptDilithiumSecret under an IV of Hash(keyid) (double-SHA256 of the CKeyID), keeping a legacy fallback IV of the raw CKeyID bytes for pre-existing wallets, and revalidates on decrypt that the recovered key's pubkey hashes back to the stored keyid — per key, because per key is what it stores.
- **btq-core:** `src/wallet/crypter.cpp:153` (DeriveDilithiumKeyIV = Hash(Span{keyid})); `src/wallet/crypter.cpp:158` (DeriveLegacyDilithiumKeyIV fallback); `src/wallet/crypter.cpp:165-173` (SetDilithiumKeyFromSecret checks CKeyID(candidate.GetPubKey().GetID()) == keyid)
- **In this wallet:** **implemented** — `src/core/crypto/hd.ts`, `src/core/crypto/mldsa.ts`

### Network binding of the derivation

- **Bitcoin:** BIP32 derivation is network-agnostic; BIP44 encodes the network only as a coin-type path element the wallet may ignore.
- **BTQ:** btq-core's two Dilithium derivations mix in no chain identifier at all, so one HD seed yields identical Dilithium keys on mainnet, testnet, signet and regtest. Only the address HRP separates the networks: a seed used on testnet also owns the corresponding mainnet addresses, which is why a testnet-only wallet must never be handed a phrase that guards real funds.
- **btq-core:** `src/crypto/dilithium_key.cpp:362` (SetSeed hashkey is only "Dilithium seed"); `src/wallet/scriptpubkeyman.cpp:2467-2478` (desc_ctx HMAC input is descriptor key + descriptor id + index + type byte, with no chain component)
- **In this wallet:** **implemented** — `src/core/crypto/hd.ts`, `src/core/crypto/mldsa.ts`

### Master fingerprint and derivation-path identity for a keyless-BIP32 wallet

- **Bitcoin:** A keystore is identified by the BIP32 master fingerprint HASH160(master pubkey)[0:4] plus a real derivation path, both of which a signing device can reproduce.
- **BTQ:** btq-core's legacy path still writes BIP32-shaped metadata (hdKeypath "m/0'/0'/n'" and a fingerprint taken from the Dilithium master extended key's own pubkey id), while the descriptor path writes none. Neither is reproducible by a second implementation from the seed alone, so a Dilithium keystore has no portable identity to quote at a signing device.
- **btq-core:** `src/wallet/scriptpubkeyman.cpp:1267` (metadata.hdKeypath "m/0'/0'/n'"), :1277-1279 (fingerprint from CKeyID(masterKey.key.GetPubKey().GetID())); `src/wallet/scriptpubkeyman.cpp:2448` (descriptor path records no key origin)
- **In this wallet:** **implemented** — `src/core/crypto/hd.ts`, `src/core/crypto/mldsa.ts`

### No xpub means the public keys have to be cached, and the cache is large

- **Bitcoin:** A wallet persists an xprv (or a mnemonic) plus an xpub, and re-derives every address from the xpub on open — no secret involved.
- **BTQ:** There is no public derivation, so a 1312-byte public key exists only while the secret does. Anything a wallet wants to show while locked — the receive address, the address book, a gap scan — has to be cached, at 1312 bytes per address on each of the two chains, and a hole in that cache silently re-indexes every key above it. btq-core's own equivalent store is the address-book receive-request map, keyed by p2mr_id.
- **btq-core:** `src/wallet/wallet.cpp:2966` (SetP2MRMetadata — the address-book receive-request map, not a key cache); `src/wallet/wallet.cpp:2984` (ListP2MRMetadata)
- **In this wallet:** **implemented** — `src/core/wallet/storage.ts` caches addresses and gap cursors as public metadata; the seed stays in the sealed vault

### Wallet creation: btq-core has no mnemonic for a Dilithium wallet

- **Bitcoin:** A new wallet is a BIP39 mnemonic with a wordlist checksum, optionally plus a passphrase.
- **BTQ:** There is no mnemonic path at all: btq-core's nearest equivalent is sethdseed, which takes an ECDSA WIF (legacy wallets only) and hangs the Dilithium tree off it. What has to survive a backup is 32 bytes; whether a wallet shows them as 64 hex characters or wraps them in a checksummed word list is its own decision, and the two forms are not interchangeable — the same words and the same hex are different wallets.
- **btq-core:** `src/wallet/rpc/wallet.cpp:502` (sethdseed); `src/wallet/scriptpubkeyman.cpp:1246` (DeriveNewDilithiumChildKey reads that seed via GetKey(hd_chain.seed_id, seed))
- **In this wallet:** **implemented** — `src/core/crypto/mnemonic.ts`, `src/core/crypto/hd.ts` — both forms are offered as separate imports, and `docs/HD_IMPORT.md` states the mapping

### Signing re-derives from the seed and re-checks the leaf commitment

- **Bitcoin:** A signer looks up the private key for the scriptPubKey and signs; the pubkey is implied by the script.
- **BTQ:** btq-core resolves the key id out of the P2MR tree it stored and looks it up in the keystore. A wallet that keeps no such tree has to work the other way round — derive the seed for the input, expand it to the 1312-byte public key, rebuild the leaf <pubkey> OP_CHECKSIGDILITHIUM, and refuse to sign unless that leaf is the one the output being spent commits to. Skipping the check means signing for a script somebody else chose.
- **btq-core:** `src/wallet/p2mr.cpp:461` (GetSingleDilithiumKeyIDForP2MR); `src/wallet/p2mr.cpp:125` (GetP2MRDilithiumKeyIDs parses each leaf); `src/wallet/p2mr.cpp:473` (BuildP2MRSigningProvider populates dilithium_keys/dilithium_pubkeys from the tree)
- **In this wallet:** **implemented** — `src/core/script/p2mr.ts` (`commitsToProgram`), `src/core/tx/builder.ts`; the foreign-leaf refusal is a security test

## Node RPC surface (context for the explorer client)

### getnewdilithiumaddress returns an object, P2MR-only

- **Bitcoin:** No such RPC; getnewaddress returns a bare address string and accepts address_type legacy/p2sh-segwit/bech32/bech32m.
- **BTQ:** Returns an OBJ {address, p2mr_id, scriptPubKey, merkle_root}; the optional second arg address_type must be exactly "p2mr" or the call throws RPC_INVALID_ADDRESS_OR_KEY (-5). Legacy Dilithium destination types are refused.
- **btq-core:** `src/wallet/rpc/dilithium.cpp:30` (getnewdilithiumaddress); result shape declared :42-47; address_type gate :68-71; result pushed :80-83; registered `src/wallet/rpc/wallet.cpp:965`
- **In this wallet:** not applicable — Watch-only-wallet registration is a node concept; this wallet reads the explorer instead.

### getnewp2mraddress(tree, label, internal)

- **Bitcoin:** No equivalent. Watch-only registration is done only with importdescriptors/importaddress; there is no script-tree metadata store.
- **BTQ:** Takes a DFS leaf array of {depth 0..128, leaf_version (0x01 parity bit must be unset), script hex}; persists wallet-local P2MR metadata and returns {address, p2mr_id, scriptPubKey, merkle_root}. internal=true skips the receive address book (so getaddressinfo reports ischange=true); internal=true on an entry already classified receive throws -4 "already classified as receive". Idempotent per (scriptPubKey, tree): the existing p2mr_id is returned.
- **btq-core:** `src/wallet/rpc/p2mr.cpp:41` (getnewp2mraddress); internal arg :49; parsed :67; CreateP2MR(add_to_address_book=!internal) :70; receive/change reclassification :74-82; result :85-88. Tree validation `src/wallet/p2mr.cpp:342` (ParseP2MRTreeChecked), :346, :367, :369. Idempotence `src/wallet/p2mr.cpp:697-705` (CreateP2MR)
- **In this wallet:** not applicable — Watch-only-wallet registration is a node concept; this wallet reads the explorer instead.

### P2MR metadata id (p2mr_id) format

- **Bitcoin:** No analogue.
- **BTQ:** 16 lowercase hex characters, the first 16 chars of a GetRandHash(); the RPC help says only "Wallet-local metadata id" and never states the format or its stability.
- **btq-core:** `src/wallet/p2mr.cpp:59-62` (NewP2MRId: GetRandHash().GetHex().substr(0, 16))
- **In this wallet:** not applicable — Watch-only-wallet registration is a node concept; this wallet reads the explorer instead.

### getaddressinfo.isdilithium

- **Bitcoin:** Field does not exist.
- **BTQ:** Always present. True for DilithiumPKHash / DilithiumWitnessV0KeyHash / DilithiumScriptHash / DilithiumWitnessV0ScriptHash / DilithiumPubKeyDestination, and for WitnessV2P2MR only when the stored metadata tree yields exactly one Dilithium key id (Solver template OP_PUSHDATA2 <1312-byte pubkey> OP_CHECKSIGDILITHIUM). No private key is required.
- **btq-core:** `src/wallet/rpc/addresses.cpp:723-731` (is_dilithium computation); `src/wallet/p2mr.cpp:461-468` (GetSingleDilithiumKeyIDForP2MR, size()!=1 -> nullopt); `src/wallet/p2mr.cpp:125-161` (GetP2MRDilithiumKeyIDs); `src/script/solver.cpp:117-121` + :267 (DILITHIUM_PUBKEY template); size constant `src/crypto/dilithium_wrapper.h:16` (1312)
- **In this wallet:** not applicable — Watch-only-wallet registration is a node concept; this wallet reads the explorer instead.

### getaddressinfo.witness_version = 2 for P2MR

- **Bitcoin:** Highest witness version reported is 1 (Taproot); witness v2+ decodes to WitnessUnknown and is not a wallet destination type.
- **BTQ:** WitnessV2P2MR is a first-class destination; DescribeAddressVisitor emits isscript=true, iswitness=true, witness_version=2, witness_program=<32-byte merkle root>.
- **btq-core:** `src/rpc/util.cpp:325-333` (DescribeAddressVisitor::operator()(const WitnessV2P2MR&), witness_version pushed at :330); declared in getaddressinfo help at `src/wallet/rpc/addresses.cpp:524`; reached via DescribeWalletAddress `src/wallet/rpc/addresses.cpp:490-500` and :727
- **In this wallet:** not applicable — Watch-only-wallet registration is a node concept; this wallet reads the explorer instead.

### getaddressinfo.solvable for a keyless tracked P2MR

- **Bitcoin:** solvable is InferDescriptor(script, provider)->IsSolvable(); an imported addr() descriptor is never solvable.
- **BTQ:** getaddressinfo overrides the inferred verdict for WitnessV2P2MR: solvable=true if the wallet holds a single-Dilithium-leaf metadata entry, or if IsTrackedP2MRScript matches a structurally valid stored tree — with no key material present. The same override exists on the null-provider path.
- **btq-core:** `src/wallet/rpc/addresses.cpp:642-651` (provider path) and :700-702 (null-provider path); `src/wallet/p2mr.cpp:527-535` (IsTrackedP2MRScript) and :285-288 (IsP2MREntryValid)
- **In this wallet:** not applicable — Watch-only-wallet registration is a node concept; this wallet reads the explorer instead.

### ismine semantics for imported addr() descriptors vs. P2MR-metadata-only scripts

- **Bitcoin:** Descriptor wallets report ismine=true (ISMINE_SPENDABLE) for any imported descriptor, key material or not; iswatchonly is legacy-only.
- **BTQ:** Same for descriptors, but CWallet::IsMine has a BTQ-only fallback: a script known ONLY from P2MR metadata (no descriptor) resolves through GetTrackedP2MRScriptIsMine to ISMINE_WATCH_ONLY when no leaf is spendable, so getaddressinfo.ismine is false. ismine=true is therefore precisely the "addr() descriptor is imported" signal, which is what makes the wallet's registration probe correct.
- **btq-core:** `src/wallet/wallet.cpp:1581-1600` (SPKM loop first, P2MR fallback at :1595-1597); `src/wallet/p2mr.cpp:537-546` (GetTrackedP2MRScriptIsMine) and :290-296 (IsP2MREntrySpendable); `src/wallet/rpc/addresses.cpp:586-587`
- **In this wallet:** not applicable — Watch-only-wallet registration is a node concept; this wallet reads the explorer instead.

### ismine cache invalidation across the two-step registration

- **Bitcoin:** No m_ismine_cache; IsMine is recomputed per call.
- **BTQ:** BTQ adds a per-script ismine memo. Both registration steps invalidate it: writing P2MR metadata erases that script's entry, and adding a new DescriptorScriptPubKeyMan clears the whole cache. This is what stops the pre-registration probe from poisoning the post-registration verification in the same refresh.
- **btq-core:** `src/wallet/wallet.cpp:1585-1588` and :1599 (cache); :2969 (SetP2MRMetadata erases the script); :3669 (AddScriptPubKeyMan clears, reached from CWallet::AddWalletDescriptor `src/wallet/wallet.cpp:3908-3913`)
- **In this wallet:** not applicable — Watch-only-wallet registration is a node concept; this wallet reads the explorer instead.

### ischange for P2MR change addresses

- **Bitcoin:** ischange = IsMine(script) && no address-book entry (a documented TODO heuristic). Unchanged in BTQ.
- **BTQ:** Unchanged code, but BTQ makes it load-bearing: getnewp2mraddress(internal=true) is the only way to keep a P2MR destination out of the receive address book, and importdescriptors additionally rejects internal=true combined with a label (-8).
- **btq-core:** `src/wallet/receive.cpp:51-71` (ScriptIsChange); emitted `src/wallet/rpc/addresses.cpp:733`; address-book suppression `src/wallet/rpc/p2mr.cpp:70`; internal+label rejection `src/wallet/rpc/backup.cpp:1640-1642`; internal descriptors skip SetAddressBook `src/wallet/wallet.cpp:3936-3944`
- **In this wallet:** not applicable — Watch-only-wallet registration is a node concept; this wallet reads the explorer instead.

### importdescriptors with un-ranged addr() descriptors as the birth-time / rescan mechanism

- **Bitcoin:** Identical RPC; timestamps drive a rescan from the lowest timestamp, clamped to a minimum of 1.
- **BTQ:** Unchanged, and deliberately used as the ONLY thing that gives a P2MR script a birth time and block-scan coverage — P2MR metadata alone does not. Requests are un-ranged, active=false, internal per key purpose, label only when not internal. Private keys in the descriptor are refused outright in a disable-private-keys wallet.
- **btq-core:** `src/wallet/rpc/backup.cpp:1722` (importdescriptors); ProcessDescriptorImport :1582; disable-private-keys guard :1652; active-must-be-ranged :1631; internal+label :1640-1642; descriptor persisted via CWallet::AddWalletDescriptor -> `src/wallet/wallet.cpp:3947` (WriteDescriptor); timestamp clamp `src/wallet/rpc/backup.cpp:1813`; rescan and per-item error rewrite :1830-1870
- **In this wallet:** not applicable — Watch-only-wallet registration is a node concept; this wallet reads the explorer instead.

### getdescriptorinfo used as a safety gate on the watch descriptor

- **Bitcoin:** Identical RPC and fields.
- **BTQ:** Unchanged, but the wallet uses it as a hard precondition: the canonical form must be exactly addr(<address>)# with isrange=false, issolvable=false, hasprivatekeys=false before anything is imported.
- **btq-core:** `src/rpc/output_script.cpp:187-227` (getdescriptorinfo; descriptor :221, checksum :222, isrange :223, issolvable :224, hasprivatekeys :225)
- **In this wallet:** not applicable — Watch-only-wallet registration is a node concept; this wallet reads the explorer instead.

### Watch-only wallet invariant: blank + descriptors + private_keys_enabled=false

- **Bitcoin:** getwalletinfo exposes the same three flags; blank means "no keys, scripts, or descriptors".
- **BTQ:** Unchanged code, but importing an addr() descriptor does NOT clear WALLET_FLAG_BLANK_WALLET — AddWalletDescriptor reaches only WriteDescriptor, and the descriptor-wallet UnsetBlankWalletFlag call site is SetupDescriptorGeneration, unreachable in a disable-private-keys wallet. A watch-only wallet registered this way therefore stays blank=true forever, which is worth re-asserting on every poll rather than treating as an error.
- **btq-core:** `src/wallet/rpc/wallet.cpp:122` (private_keys_enabled), :132 (descriptors), :134 (blank); createwallet flag wiring :342, :345, :376; blank never unset on import: `src/wallet/wallet.cpp:3947` (WriteDescriptor) vs. `src/wallet/scriptpubkeyman.cpp:3123` (only UnsetBlankWalletFlag on the descriptor path, inside SetupDescriptorGeneration)
- **In this wallet:** not applicable — Watch-only-wallet registration is a node concept; this wallet reads the explorer instead.

### listtransactions / gettransaction fields the history feed consumes

- **Bitcoin:** Identical semantics: confirmations negative for conflicted, "generated" only for coinbase, details[].abandoned, blockheight/blockhash/time/fee/hex.
- **BTQ:** Unchanged; BTQ adds no fields here. confirmations = tip - confirmed_height + 1, or -(tip - conflicting_height + 1) for conflicted, 0 otherwise. gettransaction's second positional is include_watchonly (verbose is the third).
- **btq-core:** `src/wallet/rpc/transactions.cpp:22` (confirmations), :24 (generated), :27-28 (blockhash/blockheight), :43 (time), :351 and :392 (details[].abandoned), :403-409 (help text), :432 (listtransactions), :686 (gettransaction, arg order :691-695), :729 (hex); depth formula `src/wallet/wallet.cpp:3478-3488`
- **In this wallet:** **implemented** — `src/background/explorer.ts` — history paged from `/api/v1/address/{a}/txs`

### testmempoolaccept + sendrawtransaction as the only broadcast path

- **Bitcoin:** Identical RPCs and shapes.
- **BTQ:** Unchanged. btq-core additionally ships a wallet-scoped testp2mrtransaction returning [{txid, allowed, reject-reason}] — with no wtxid — but the wallet deliberately uses the node-level testmempoolaccept so it can pin the witness txid of the locally finalised bytes before broadcasting. maxfeerate defaults to COIN/10 per kvB on both calls.
- **btq-core:** `src/rpc/mempool.cpp:103` (testmempoolaccept; txid :128, wtxid :129, allowed :131, reject-reason :142) and :34 (sendrawtransaction; result :53-55); `src/node/transaction.h:27` (DEFAULT_MAX_RAW_TX_FEE_RATE = COIN/10); BTQ-only variant `src/wallet/rpc/p2mr.cpp:346` (testp2mrtransaction)
- **In this wallet:** **implemented** — `src/background/node-rpc.ts` — `testmempoolaccept` + `sendrawtransaction` over JSON-RPC. The explorer has **no push route** (`POST /api/v1/tx/send` → 404), so a node is the only broadcast path; see `docs/REFERENCE.md §6`

### Per-input weight hint in walletcreatefundedpsbt (the only way a keyless watch wallet can size a P2MR input)

- **Bitcoin:** Same option; the floor is GetTransactionInputWeight(CTxIn()) = 41*4 + 1 = 165, ceiling MAX_STANDARD_TX_WEIGHT = 400000.
- **BTQ:** WITNESS_SCALE_FACTOR is 16, so the asserted floor is 41*16 + 1 = 657 and the same 400000 ceiling covers far fewer bytes. A single-key P2MR input is declared at 4402 weight units by the wallet.
- **btq-core:** `src/wallet/rpc/spend.cpp:685-701` (weight parsing, CHECK_NONFATAL(min_input_weight == (41 * WITNESS_SCALE_FACTOR) + 1) at :691, ceiling :697); `src/consensus/consensus.h:21` (WITNESS_SCALE_FACTOR = 16); `src/policy/policy.h:30` (MAX_STANDARD_TX_WEIGHT = 400000)
- **In this wallet:** not applicable — Watch-only-wallet registration is a node concept; this wallet reads the explorer instead.

### getmininginfo.signet_challenge

- **Bitcoin:** getmininginfo has no signet_challenge; the field exists only in getblocktemplate.
- **BTQ:** getmininginfo gains signet_challenge (hex, present only on signet) so a client can prove it is on the default BTQ signet rather than a custom-challenge fork.
- **btq-core:** `src/rpc/mining.cpp:406` (getmininginfo), :421 (result declaration), :446 (obj.pushKV("signet_challenge", ...)); default challenge bytes `src/kernel/chainparams.cpp:302`
- **In this wallet:** not applicable — Watch-only-wallet registration is a node concept; this wallet reads the explorer instead.

### Chain identity handshake: subversion + chain + genesis hash

- **Bitcoin:** Same RPCs; no client typically gates on all three.
- **BTQ:** Unchanged RPCs but BTQ-specific constants: CLIENT_NAME is "BTQ" (so subversion contains it), chain names are main/test/signet/regtest, and each network has a distinct BTQ genesis hash and bech32 HRP (qbtc/tbtq/qtb/qcrt).
- **btq-core:** `src/clientversion.cpp:19` (CLIENT_NAME("BTQ")); genesis asserts `src/kernel/chainparams.cpp:135`, :251, :385, :505; HRPs :148, :267, :401, :552
- **In this wallet:** not applicable — Watch-only-wallet registration is a node concept; this wallet reads the explorer instead.

### Wallet-scoped vs node-scoped RPC endpoint split

- **Bitcoin:** Identical: /wallet/<name> selects the wallet, root falls back to the single loaded wallet.
- **BTQ:** Unchanged, but the wallet enforces the split explicitly: chain identity, help, testmempoolaccept and sendrawtransaction go to the root endpoint; every wallet RPC goes to /wallet/<name>, and the URI is validated (loopback-only for plain HTTP, no credentials/query/fragment in the URI).
- **btq-core:** `src/wallet/rpc/util.cpp:62-70` (GetWalletNameFromJSONRPCRequest, URI-prefix based) and :72-82 (GetWalletForJSONRPCRequest, CHECK_NONFATAL(request.mode == EXECUTE) at :74 — which is why `help <walletrpc>` works on the root endpoint)
- **In this wallet:** **implemented** — `src/core/network/jsonrpc.ts` + `src/background/node-rpc.ts` — node-level calls go to the root endpoint, and `parseHttpEndpoint()` refuses credentials, fragments and non-http(s) schemes

### IBD guard and Core-sourced tip height

- **Bitcoin:** getblockchaininfo.initialblockdownload exists; a wallet normally takes the tip from an Electrum server or a block explorer instead.
- **BTQ:** Unchanged RPC, but BTQ has no Electrum backend, so a node-backed wallet takes both the IBD verdict and the chain tip from getblockchaininfo — and must refuse to register addresses or present history while initialblockdownload is true, because a syncing node reports coins that are not there yet.
- **btq-core:** getblockchaininfo blocks/headers/initialblockdownload/pruned/pruneheight (standard Bitcoin fields, unmodified in BTQ)
- **In this wallet:** not applicable — Watch-only-wallet registration is a node concept; this wallet reads the explorer instead.

### listunspent as the coin-selection source with full client-side re-derivation

- **Bitcoin:** Identical RPC.
- **BTQ:** Unchanged, but nothing it returns should be trusted into the signing path: every entry's address has to be re-parsed as same-network P2MR and its output script re-derived and compared with the scriptPubKey the node reported, duplicates and out-of-range amounts rejected, zero-value outputs dropped.
- **btq-core:** `src/wallet/rpc/coins.cpp:500` (listunspent; args minconf/maxconf/addresses/include_unsafe/query_options), entry fields :718-729 (spendable, solvable, safe, desc)
- **In this wallet:** **implemented** — `src/background/explorer.ts` — UTXOs paged from `/api/v1/address/{a}/utxos`

## PSBT extensions (not used here)

### PSBT_IN_P2MR_LEAF_SCRIPT (0x19)

- **Bitcoin:** No such field; BIP371 stops at PSBT_IN_TAP_MERKLE_ROOT 0x18 and taproot leaves ride on 0x15.
- **BTQ:** Type 0x19, modelled byte-for-byte on BIP371 0x15: KEY = <0x19> || control_block (raw, no length prefix; 1 + 32*k bytes, k <= 128); VALUE = leaf_script || leaf_version (one trailing byte, 0xc0). Control block base is 1 byte, not taproot's 33, because P2MR has no internal key. One record per (leaf, control block) pair, so one leaf with two Merkle paths serializes twice.
- **btq-core:** `src/psbt.h:52` (PSBT_IN_P2MR_LEAF_SCRIPT = 0x19); `src/psbt.h:360-368` (PSBTInput::Serialize, SerializeToVector(s, PSBT_IN_P2MR_LEAF_SCRIPT, Span{control_block}) then value_v.push_back(leaf_ver)); `src/psbt.h:719-743` (Unserialize case PSBT_IN_P2MR_LEAF_SCRIPT); `src/psbt.h:233` (m_p2mr_scripts, map<pair<script,int>, set<control block>>); `src/script/interpreter.h:252-255` (P2MR_CONTROL_BASE_SIZE=1, NODE_SIZE=32, MAX_NODE_COUNT=128)
- **In this wallet:** not applicable — This wallet builds and signs transactions directly; no PSBT interchange. Revisit if hardware signing or multi-party flows are added.

### PSBT_IN_P2MR_MERKLE_ROOT (0x1A)

- **Bitcoin:** No such field; BIP371's PSBT_IN_TAP_MERKLE_ROOT 0x18 carries the taproot tree root alongside an internal key.
- **BTQ:** Type 0x1A: KEY = <0x1A> only (exactly one byte); VALUE = compactsize(32) || 32-byte script-tree Merkle root, in the same raw byte order as the witness program. Because P2MR has no internal key, the root IS the 32-byte witness program, and btq-core rejects the PSBT at decode if the two disagree.
- **btq-core:** `src/psbt.h:53` (PSBT_IN_P2MR_MERKLE_ROOT = 0x1A); `src/psbt.h:370-374` (Serialize: SerializeToVector(s, PSBT_IN_P2MR_MERKLE_ROOT) then SerializeToVector(s, m_p2mr_merkle_root)); `src/psbt.h:744-753` (Unserialize, key.size() != 1 rejected); `src/psbt.h:234` (m_p2mr_merkle_root); `src/psbt_dilithium.cpp:147-149` (root vs witness program check in ValidateP2MRDilithiumInput)
- **In this wallet:** not applicable — This wallet builds and signs transactions directly; no PSBT interchange. Revisit if hardware signing or multi-party flows are added.

### PSBT_IN_P2MR_DILITHIUM_SCRIPT_SIG (0x1B)

- **Bitcoin:** Partial signatures live in PSBT_IN_PARTIAL_SIG 0x02 (key = 33/65-byte EC pubkey) or BIP371 PSBT_IN_TAP_SCRIPT_SIG 0x14 (key = 32-byte x-only pubkey || 32-byte leaf hash). Neither can carry an ML-DSA key or signature.
- **BTQ:** Type 0x1B, shaped like 0x14: KEY = <0x1B> || 1312-byte ML-DSA-44 public key (raw, no length prefix) || 32-byte leaf hash = exactly 1345 bytes; VALUE = compactsize(2421) || 2420-byte ML-DSA signature || 1-byte sighash type. Length is enforced as an exact equality, not a maximum, and the pubkey must pass IsFullyValid(). btq-core keys the in-memory map by DilithiumPKHash but always puts the full pubkey on the wire. At most 20 records per input.
- **btq-core:** `src/psbt.h:54` (PSBT_IN_P2MR_DILITHIUM_SCRIPT_SIG = 0x1B); `src/psbt.h:376-382` (Serialize: SerializeToVector(s, type, pubkey, keyid_leaf.second) then s << sig); `src/psbt.h:754-780` (Unserialize: key.size() != 1 + CDilithiumPubKey::SIZE + uint256::size(); sig.size() != MAX_DILITHIUM_PARTIAL_SIG_VALUE_SIZE); `src/psbt.h:82-83` (MAX_DILITHIUM_PARTIAL_SIG_VALUE_SIZE = SIGNATURE_SIZE + 1 = 2421; MAX_DILITHIUM_PARTIAL_SIGS_PER_INPUT = MAX_PUBKEYS_PER_MULTISIG = 20); `src/crypto/dilithium_key.h:243-244` + :64,:66 (SIZE 1312, SIGNATURE_SIZE 2420); `src/crypto/dilithium_key.h:311-315` (CDilithiumPubKey::Serialize writes Span{vch} raw)
- **In this wallet:** not applicable — This wallet builds and signs transactions directly; no PSBT interchange. Revisit if hardware signing or multi-party flows are added.

### Bounded parsing of the P2MR fields

- **Bitcoin:** BIP371 fields are bounded implicitly by fixed key sizes; taproot control blocks are checked at 33 + 32k, k <= 128 in the PSBT parser.
- **BTQ:** btq-core bounds every P2MR field at parse time against the consensus limits, deliberately matching rather than tightening them: control block key 1 + 1 .. 1 + 1 + 32*128 with (len-2) % 32 == 0; leaf script <= MAX_SCRIPT_SIZE (100000) after stripping the version byte and >= 1 byte; at most 20 Dilithium partial sigs.
- **btq-core:** `src/psbt.h:723-729` (control block key size + modulo checks); `src/psbt.h:731-737` (leaf script empty / MAX_P2MR_LEAF_SCRIPT_SIZE); `src/psbt.h:84` (MAX_P2MR_LEAF_SCRIPT_SIZE = MAX_SCRIPT_SIZE); `src/script/script.h:43` (MAX_SCRIPT_SIZE = 100000); `src/psbt.h:761-763` (MAX_DILITHIUM_PARTIAL_SIGS_PER_INPUT cap)
- **In this wallet:** not applicable — This wallet builds and signs transactions directly; no PSBT interchange. Revisit if hardware signing or multi-party flows are added.

### Whole-PSBT Dilithium validation at decode

- **Bitcoin:** Bitcoin Core's DecodeRawPSBT only unserializes; per-field checks are structural and no signature is verified until signing/finalizing.
- **BTQ:** btq-core runs ValidateP2MRDilithiumPSBT inside DecodeRawPSBT and zeroes the PSBT on failure, because a Dilithium partial signature cannot be checked field-by-field (it needs the unsigned tx and every input amount). It enforces: input actually spends a witness-v2/32-byte program; 0x1a root == program; sighash_type, if present, is SIGHASH_ALL; every 0x19 leaf has at least one control block; each control block has valid size, parity bit set, leaf version matching the 0x19 value byte, and commits to the program via ComputeP2MRMerkleRoot; no two leaves collide on a leaf hash; every 0x1b sig references a contained leaf, all sigs reference one leaf, the pubkey is authorised by the parsed leaf policy, the trailing byte is SIGHASH_ALL, and the ML-DSA signature verifies against the recomputed BIP341 P2MR sighash.
- **btq-core:** `src/psbt.cpp:588-593` (DecodeRawPSBT calls ValidateP2MRDilithiumPSBT and resets the PSBT); `src/psbt_dilithium.cpp:128-224` (ValidateP2MRDilithiumInput); :147-149 (root vs program), :151-153 (SIGHASH_ALL only), :162-165 (leaf with no control block), :169-171 (control size), :172-174 (parity bit), :175-177 (leaf version), :178-180 (commitment), :207-209 (sig trailing byte), :220-222 (pubkey.Verify); `src/psbt_dilithium.cpp:226-249` (ValidateP2MRDilithiumPSBT)
- **In this wallet:** not applicable — This wallet builds and signs transactions directly; no PSBT interchange. Revisit if hardware signing or multi-party flows are added.

### P2MR witness finalization order [signature, leafScript, controlBlock]

- **Bitcoin:** Taproot script path finalizes to [...script inputs, script, control_block] with a 33+32k control block carrying the internal key and parity.
- **BTQ:** P2MR has no key path, so a spend is always script path. The interpreter pops the control block first, then the script, leaving the leaf's stack inputs below; the control block's low bit must be 1 (no internal key means fixed parity) and the leaf version is control[0] & 0xfe. For a single-key leaf btq-core produces exactly [sig, leafScript, controlBlock] — SignStep pushes the 2421-byte sig for TxoutType::DILITHIUM_PUBKEY, then SignP2MR appends the script and the shortest control block.
- **btq-core:** `src/script/interpreter.cpp:2276-2318` (VerifyWitnessProgram witversion == 2 branch); :2289-2294 (require >= 2 elements, pop control then script); :2299-2301 (parity bit must be 1); :2303-2307 (tapleaf hash + VerifyP2MRCommitment); `src/script/sign.cpp:518-544` (SignP2MR); :533-535 (push script, then *control_blocks.begin()); `src/script/sign.cpp:636-640` (TxoutType::DILITHIUM_PUBKEY pushes the sig); `src/script/sign.cpp:759-764` (WITNESS_V2_P2MR result becomes sigdata.scriptWitness.stack)
- **In this wallet:** not applicable — This wallet builds and signs transactions directly; no PSBT interchange. Revisit if hardware signing or multi-party flows are added.

### Finalized P2MR input drops the signing material

- **Bitcoin:** BIP174 combiners/finalizers remove partial sigs and other non-final fields once 0x07/0x08 exist; Core gates all partial fields behind a not-finalized check.
- **BTQ:** btq-core extends the same rule to the P2MR fields: PSBTInput::Serialize writes 0x19/0x1A/0x1B only inside the `final_script_sig.empty() && final_script_witness.IsNull()` block, and FromSignatureData clears m_p2mr_scripts, m_p2mr_dilithium_script_sigs and m_p2mr_merkle_root when sigdata.complete, because that material (1312 + 2420 bytes per key) dwarfs the rest of the input. A producer that emits the three fields unconditionally alongside 0x08 leaves ~3.7 KB of dead weight per input in every finalized PSBT.
- **btq-core:** `src/psbt.h:340`,383 (Serialize gate opening and closing around the partial fields, P2MR writes at 359-382); `src/psbt.cpp:166-172` (FromSignatureData clears the three P2MR members when sigdata.complete); `src/psbt.cpp:322-325` (PSBTInputSigned = final scriptSig or final witness present)
- **In this wallet:** not applicable — This wallet builds and signs transactions directly; no PSBT interchange. Revisit if hardware signing or multi-party flows are added.

### PSBT combine/merge semantics for the P2MR fields

- **Bitcoin:** PSBTInput::Merge unions maps and keeps the existing scalar when non-empty (first writer wins). For taproot, m_tap_scripts uses a plain map::insert, which drops a second control block for a leaf already present.
- **BTQ:** btq-core unions P2MR control blocks per leaf (an incoming empty set can never discard a known control block), unions the Dilithium partial-signature map (keyed by pubkey hash + leaf hash, so independent signers accumulate up to the leaf's threshold), and keeps the existing 0x1a root — first writer wins. This is a deliberate improvement over the taproot line immediately above it in the same function; a combiner that instead lets the incoming input overwrite the local leaf, control block, root or signature throws away work another signer already did.
- **btq-core:** `src/psbt.cpp:222-252` (PSBTInput::Merge); :239-241 (per-leaf control-block union); :242 (Dilithium sig map union); :251 (m_p2mr_merkle_root keep-existing); :237 (m_tap_scripts plain insert, unchanged from upstream); `src/psbt.cpp:25-48` (PartiallySignedTransaction::Merge)
- **In this wallet:** not applicable — This wallet builds and signs transactions directly; no PSBT interchange. Revisit if hardware signing or multi-party flows are added.

### Duplicate-key rejection for the P2MR records

- **Bitcoin:** BIP174 requires unique keys per map; Core throws "Duplicate Key" from key_lookup during Unserialize.
- **BTQ:** Each of the three P2MR types participates in the same key_lookup set, so an exact repeat of any full key is rejected with a type-specific message. Because the control block lives in the 0x19 key and the pubkey+leaf hash in the 0x1B key, two different control blocks for one leaf and two different signers on one leaf are distinct keys and are legitimately accepted, so a generic per-input duplicate scan is not equivalent: it has no multi-record model.
- **btq-core:** `src/psbt.h:721-723` (0x19 duplicate), :746-748 (0x1A duplicate), :756-758 (0x1B duplicate)
- **In this wallet:** not applicable — This wallet builds and signs transactions directly; no PSBT interchange. Revisit if hardware signing or multi-party flows are added.

### SIGHASH_ALL-only P2MR PSBT signatures

- **Bitcoin:** BIP341/342 taproot signatures default to SIGHASH_DEFAULT (0x00), serialized as a bare 64-byte signature with no trailing type byte.
- **BTQ:** The P2MR tapscript checker rejects SIGHASH_DEFAULT outright, so every Dilithium leaf signature carries a trailing hash-type byte — which is why the 0x1B value is fixed at 2421 bytes and why the PSBT layer refuses any input sighash_type other than SIGHASH_ALL. A signer therefore computes the BIP341 tapscript sighash with SIGHASH_ALL and the leaf script as the tapleaf, and never the taproot default.
- **btq-core:** `src/script/interpreter.cpp:1965-1968` (P2MR_TAPSCRIPT: `if (nHashType == SIGHASH_DEFAULT) return false` before SignatureHashSchnorr); `src/psbt_dilithium.cpp:149-153` (PSBT rejects non-SIGHASH_ALL sighash_type); `src/psbt_dilithium.cpp:27-41` (ComputeLeafSighash: SigVersion::P2MR_TAPSCRIPT, annex absent, codeseparator 0xFFFFFFFF)
- **In this wallet:** not applicable — This wallet builds and signs transactions directly; no PSBT interchange. Revisit if hardware signing or multi-party flows are added.

### Core-funded P2MR PSBT handed to a local ML-DSA signer

- **Bitcoin:** walletcreatefundedpsbt + walletprocesspsbt both run in the node; the node holds or can be given the keys.
- **BTQ:** BTQ Core funds an explicit-input P2MR PSBT via walletcreatefundedpsbt on a private-keys-disabled descriptor wallet and never signs. Whether that PSBT already carries 0x19/0x1A depends on registration: an address registered through getnewp2mraddress becomes P2MR wallet metadata, and CWallet::FillPSBT's dedicated P2MR pass fills m_p2mr_scripts/m_p2mr_merkle_root through BuildP2MRSigningProvider even with sign=false; an address imported only as addr() is not P2MR-solvable and the fields are absent. The wallet handles both: it supplies its own single-leaf 0x19/0x1A when Core omitted them, then writes 0x1B.
- **btq-core:** `src/wallet/wallet.cpp:2211-2243` (CWallet::FillPSBT P2MR fallback pass: GetP2MRByScript + BuildP2MRSigningProvider + SignPSBTInput); `src/wallet/wallet.cpp:3624-3631` (GetSolvingProvider P2MR metadata fallback); `src/script/sign.cpp:520-523` (SignP2MR merges provider spend data into sigdata.p2mr_spenddata); `src/psbt.cpp:210-219` (FromSignatureData writes m_p2mr_merkle_root and m_p2mr_scripts even when incomplete); `src/wallet/rpc/p2mr.cpp:41` (getnewp2mraddress)
- **In this wallet:** not applicable — This wallet builds and signs transactions directly; no PSBT interchange. Revisit if hardware signing or multi-party flows are added.

### Locally finalized transaction dry-run and broadcast (no Core-side PSBT finalization)

- **Bitcoin:** finalizepsbt / FinalizePSBT run in the node: SignPSBTInput with DUMMY_SIGNING_PROVIDER re-derives the witness from the partial fields and gates on VerifyScript.
- **BTQ:** BTQ Core can still finalize a P2MR PSBT with no keys at all — the 0x19/0x1B fields alone are enough for CreateDilithiumSig to return the stored signature and for ProduceSignature to assemble and verify the witness. A wallet need not use that path: finalizing locally and submitting the raw hex to testmempoolaccept — comparing Core's txid and wtxid with the locally computed ones before sendrawtransaction — makes consensus, rather than Core's PSBT finalizer, the equivalence oracle.
- **btq-core:** `src/psbt.cpp:509-522` (FinalizePSBT via DUMMY_SIGNING_PROVIDER); `src/script/sign.cpp:203-210` (CreateDilithiumSig returns the sig already in sigdata.p2mr_dilithium_script_sigs keyed by (DilithiumPKHash, leaf hash)); `src/script/sign.cpp:779` (sigdata.complete = solved && VerifyScript(... STANDARD_SCRIPT_VERIFY_FLAGS | SCRIPT_VERIFY_DILITHIUM ...))
- **In this wallet:** not applicable — This wallet builds and signs transactions directly; no PSBT interchange. Revisit if hardware signing or multi-party flows are added.

### Sign, finalize and broadcast are a separate route at every step

- **Bitcoin:** One route: sign with the wallet's keystores, finalize, extract, broadcast through Electrum or a node.
- **BTQ:** A P2MR input diverges at each step. The partial signature is written as 0x19/0x1A/0x1B, not PSBT_IN_PARTIAL_SIG; finalization has to assemble [signature, leafScript, controlBlock] itself; and the only broadcast target is a node's testmempoolaccept + sendrawtransaction, because no Electrum server speaks P2MR and the public explorer has no push route. A signer that derives keys on demand also has to fold the new public keys back into its cache, or the addresses stop resolving once it locks.
- **btq-core:** `src/psbt.h:52-54` (the three input types the wallet writes); `src/script/interpreter.cpp:2276` (witversion == 2 && program.size() == WITNESS_V2_P2MR_SIZE — the consensus branch this path targets)
- **In this wallet:** not applicable — This wallet builds and signs transactions directly; no PSBT interchange. Revisit if hardware signing or multi-party flows are added.

## Chain parameters

### One-minute blocks and a 10x subsidy schedule

- **Bitcoin:** 600-second target spacing, 50 BTC initial subsidy halving every 210,000 blocks (~4 years).
- **BTQ:** nPowTargetSpacing = 60 seconds with nSubsidyHalvingInterval = 2,100,000 blocks and a 5 BTQ initial subsidy - ten times the block rate, ten times the interval, so the ~4-year halving cadence is preserved. Confirmation counts accrue 10x faster, and any UI that equates confirmations with elapsed time is wrong by an order of magnitude.
- **btq-core:** `src/kernel/chainparams.cpp:92` (nPowTargetSpacing = 1 * 60), :75 (nSubsidyHalvingInterval = 2100000)
- **In this wallet:** not applicable — Informational — affects confirmation cadence and UI copy, not signing.

### LWMA-1 per-block difficulty retargeting

- **Bitcoin:** Difficulty retargets once every 2016 blocks against the elapsed-time ratio.
- **BTQ:** Above nLWMAHeight, GetNextWorkRequired delegates to LwmaGetNextWorkRequired - a linearly weighted moving average that retargets every block, and PermittedDifficultyTransition becomes unconditional above that height. A node built without this change forks off testnet at height 300000 with bad-diffbits.
- **btq-core:** `src/pow.cpp:25-26` (LWMA routing), :62 (LwmaGetNextWorkRequired), :154-155 (PermittedDifficultyTransition)
- **In this wallet:** not applicable — Informational — affects confirmation cadence and UI copy, not signing.

### A second Dilithium address namespace beyond P2MR

- **Bitcoin:** One bech32 HRP per network plus the two base58 version bytes.
- **BTQ:** Alongside bech32_hrp (qbtc/tbtq/qtb/qcrt) chainparams defines dilithium_bech32_hrp - dbtc / tdbt / sdbt / rdbt - and base58 DILITHIUM_PUBKEY_ADDRESS / DILITHIUM_SCRIPT_ADDRESS version bytes (76 / 136 on mainnet). These are legacy Dilithium destination forms, distinct from P2MR, and are non-standard for relay.
- **btq-core:** `src/kernel/chainparams.cpp:149` (dbtc), :268 (tdbt), :402 (sdbt), :553 (rdbt), :145-146 (base58 76/136); `src/policy/policy.cpp:89-95` (DILITHIUM_* destinations non-standard)
- **In this wallet:** not applicable — Informational — affects confirmation cadence and UI copy, not signing.

### Block sigop cost, not block weight, caps P2MR inputs per block

- **Bitcoin:** MAX_BLOCK_SIGOPS_COST 80,000 with 1 sigop per CHECKSIG; weight is the binding constraint in practice.
- **BTQ:** A single-key P2MR input costs DILITHIUM_SIGOP_COST = 50 sigops, and legacy/P2SH sigops are additionally multiplied by WITNESS_SCALE_FACTOR = 16. Against the unchanged block sigop ceiling this - not the 8,000,000 WU block weight - is what bounds P2MR inputs per block.
- **btq-core:** `src/script/script.h:68` (DILITHIUM_SIGOP_COST 50); `src/script/interpreter.cpp:2478-2491` (witness v2 sigop counting); `src/consensus/tx_verify.cpp:147` (GetTransactionSigOpCost)
- **In this wallet:** not applicable — Informational — affects confirmation cadence and UI copy, not signing.
