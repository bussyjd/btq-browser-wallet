# BTQ protocol reference for wallet implementers

Everything here was **verified against btq-core source** (and, where marked ✅, against a
running regtest node). Line numbers come from a `btq-ag/btq-core` checkout on the
`v0.5.0-testnet` line; if yours has drifted, the symbol names are the stable anchor. This
file plus [`BTQ_CORE_MAP.md`](BTQ_CORE_MAP.md) is the protocol knowledge a BTQ wallet
needs.

---

## 0. One-paragraph orientation

BTQ is a Bitcoin fork whose signatures are post-quantum. Instead of secp256k1 it uses
**ML-DSA-44** (FIPS 204, "Dilithium2"), and instead of P2WPKH/P2TR it spends
**P2MR** — Pay-to-Merkle-Root, a **witness v2** output whose 32-byte program is a
TapLeaf-tagged merkle root. There is no key path: every spend reveals a leaf script
`<1312-byte pubkey> OP_CHECKSIGDILITHIUM` and a control block. The signature digest is
the **unmodified BIP341 tapscript sighash**. Because signatures are 2420 bytes, the
witness discount was deepened: **witness scale factor 16** instead of 4.

---

## 1. Cryptography

| Fact | Value | btq-core |
|---|---|---|
| Scheme | ML-DSA-44 / FIPS 204 (Dilithium mode 2) | `src/crypto/dilithium/ref/config.h:10` |
| Public key | **1312 bytes** | `src/crypto/dilithium_wrapper.h:16` |
| Secret key | 2560 bytes | `:17` |
| Raw signature | **2420 bytes** | `:18` |
| Key seed | **32 bytes** | `:21` |
| Keygen | `crypto_sign_keypair_from_seed` — standard FIPS 204 KeyGen with ξ = seed: `H(ξ ‖ k ‖ ℓ, 128)` → ρ, ρ′, K | `src/crypto/dilithium/ref/sign.c` |
| Signing mode | **Deterministic** (`DILITHIUM_RANDOMIZED_SIGNING` left undefined ⇒ rnd = 32 zero bytes) | `src/crypto/dilithium/ref/config.h:5` |
| Context string | **Empty** on the consensus path (message prefix is `0x00 0x00`) | `src/crypto/dilithium_wrapper.c:39-42` |
| Message signed | the raw 32-byte sighash — **no pre-hash mode** | `src/script/sign.cpp:116-117` |
| Witness signature | **exactly 2421 bytes** = 2420 + sighash byte, else `SCRIPT_ERR_SIG_DER` | `src/script/interpreter.cpp:116` |
| Public-key validity | size 1312, non-zero ρ (first 32 B), non-zero t1 | `src/crypto/dilithium_pubkey.cpp:36-61` |

**JS mapping:** `@noble/post-quantum` `ml_dsa44` matches all of the above. ⚠️ Its bundled
`.d.ts` declares a stale 3-argument API; the **runtime** signature is
`sign(secretKey, msg, ctx?, random?)` and `verify(publicKey, msg, sig, ctx?)`.
Pass `ctx = new Uint8Array(0)` and **omit `random`** (omitting it is deterministic,
which is what btq-core does). See `src/core/crypto/mldsa.ts`.

### Opcodes
| Opcode | Value | Implemented here? |
|---|---|---|
| `OP_CHECKSIGDILITHIUM` | `0xbb` | ✅ yes |
| `OP_CHECKSIGDILITHIUMVERIFY` | `0xbc` | no |
| `OP_CHECKMULTISIGDILITHIUM` | `0xbd` | no — single-key wallet |
| `OP_CHECKMULTISIGDILITHIUMVERIFY` | `0xbe` | no |
| `OP_DILITHIUM_PUBKEY` | `0xbf` | no |

`src/script/script.h:220-224`; `MAX_OPCODE` is raised to `0xbf` at `:230`, and
`IsOpSuccess` starts its upper range at 192 so these are never `OP_SUCCESSx`
(`src/script/script.cpp:353-362`). All five are consensus-valid **only inside P2MR
tapscript** — `SCRIPT_VERIFY_DILITHIUM_P2MR_ONLY` (`src/script/interpreter.h:155`),
`SigVersion::P2MR_TAPSCRIPT = 4` (`:207`).

---

## 2. P2MR output type ✅ verified against a node

```
leaf script   = OP_PUSHDATA2 <1312-byte pubkey> OP_CHECKSIGDILITHIUM
              = 0x4d ‖ len_le16(1312) ‖ pubkey ‖ 0xbb          (1316 bytes)
leaf version  = 0xc0
tapleaf hash  = tagged_hash("TapLeaf", 0xc0 ‖ compact_size(1316) ‖ leaf)
merkle root   = tapleaf hash            (single-leaf tree)
scriptPubKey  = OP_2 <32-byte root> = 0x52 0x20 ‖ root          (34 bytes)
control block = 0xc1                    (1 byte: leaf version | parity bit)
witness       = [signature(2421), leafScript(1316), controlBlock(1)]
address       = bech32m(hrp, witness_version=2, root)
```

- The witness program **is** the merkle root — no internal key, no taptweak
  (`src/script/interpreter.cpp:2176` `VerifyP2MRCommitment`).
- Control block is `1 + 32·m` bytes, up to 128 nodes ⇒ max 4097
  (`src/script/interpreter.h:252-255`). The parity bit **must** be set.
- No key path: the interpreter requires ≥ 2 witness items
  (`src/script/interpreter.cpp:2290-2292`).
- `Solver` returns `TxoutType::WITNESS_V2_P2MR` (`src/script/solver.cpp:225`).

### Address prefixes (`src/kernel/chainparams.cpp`)
| Network | HRP | Example |
|---|---|---|
| mainnet | `qbtc` | `qbtc1z…` (`:148`) |
| **testnet** | **`tbtq`** | `tbtq1z…` (`:267`) |
| signet | `qtb` (`:401`) | |
| regtest | `qcrt` (`:552`) | |

⚠️ btq-core **also** defines a separate legacy Dilithium namespace —
`dilithium_bech32_hrp` = `dbtc`/`tdbt`/`sdbt`/`rdbt` (`:149,:268,:402,:553`) plus base58
version bytes 76/136 — for non-P2MR Dilithium destinations. These are **non-standard for
relay** (`src/policy/policy.cpp:89-95`). This wallet must **reject** them rather than
mis-send.

---

## 3. Signature hash ✅ verified against a node

BTQ reuses the **BIP341/342 tapscript sighash unchanged** for witness v2. Everything
below is identical to Bitcoin's taproot script path:

```
sighash = tagged_hash("TapSighash",
    0x00                      // epoch          interpreter.cpp:1724
  ‖ hash_type(1) = 0x01       // SIGHASH_ALL
  ‖ nVersion(4 LE) ‖ nLockTime(4 LE)
  ‖ sha256(all outpoints) ‖ sha256(all input amounts, 8 LE each)
  ‖ sha256(all spent scriptPubKeys, each length-prefixed) ‖ sha256(all sequences)
  ‖ sha256(all outputs)       // SIGHASH_ALL only
  ‖ spend_type(1) = 0x02      // (ext_flag=1 << 1) + no annex   :1749
  ‖ input_index(4 LE)
  ‖ tapleaf_hash(32) ‖ key_version(1) = 0x00 ‖ codesep_pos(4 LE) = 0xffffffff)
```

- `ext_flag = 1`, `key_version = 0` for `P2MR_TAPSCRIPT` (`src/script/interpreter.cpp:1705`)
- **`SIGHASH_DEFAULT` (0x00) is REJECTED** for P2MR — unlike taproot, the sighash byte is
  mandatory, so signatures are always 2421 bytes (`src/script/interpreter.cpp:1965`)
- Annex handling, codeseparator position and the epoch byte are all unchanged from BIP341

---

## 4. Weight, fees, limits

| Fact | Value | btq-core |
|---|---|---|
| **Witness scale factor** | **16** (Bitcoin: 4) | `src/consensus/consensus.h:21` |
| Weight | `stripped_size × 15 + total_size` | `src/consensus/validation.h:148-151` |
| Virtual size | `ceil(weight / 16)` | `src/policy/policy.cpp:357-360` |
| Single-key P2MR input | **4402 WU = 275.125 vB** (41 non-witness B × 16 + ~3746 B witness) | |
| `MAX_STANDARD_TX_WEIGHT` | 400,000 WU ⇒ **~90 P2MR inputs max** | `src/policy/policy.h:30` |
| Max script element | 15,000 B (Bitcoin: 520) — makes 2421-byte pushes standard | `src/script/script.h:29` |
| Max script size | 100,000 B | `src/script/script.h:43` |
| Dilithium sigop cost | 50 per CHECKSIG | `src/script/script.h:68` |
| Validation weight / sigop | 500 | `src/script/script.h:71` |
| Min relay fee | 1000 sat/kvB (unchanged, but a vB is now 16 WU) | `src/policy/policy.h:63` |
| Dust, P2MR output | **270 sats** — 43-byte output + (32+4+1+⌊107/16⌋+4)=47 B spend estimate = 90 B × 3000 sat/kvB | `src/policy/policy.cpp:26-63`, `src/policy/policy.h:61` |
| Block weight | 8,000,000 WU | `src/consensus/consensus.h:13` |

**Always compute fees from the scale-16 vsize.** Using Bitcoin's scale-4 vsize
overestimates a P2MR input's cost ~4×.

---

## 5. HD derivation ⚠️ read this carefully

ML-DSA has **no homomorphic public derivation**, so there is no xpub and no watch-only
derivation. btq-core's scheme (`src/crypto/dilithium_key.cpp`):

```
master:  I = HMAC-SHA512(key = "Dilithium seed", msg = hd_seed)
         I_L(32) -> master ML-DSA seed      I_R(32) -> master chaincode
child:   I = HMAC-SHA512(key = parent_chaincode,
                         msg = 0x00 ‖ parent_seed(32) ‖ ser32BE(index))
         I_L -> child seed                  I_R -> child chaincode
         *** HARDENED ONLY *** — non-hardened indices are refused by design
extkey:  73 bytes = depth(1) ‖ fingerprint(4) ‖ child(4 BE) ‖ chaincode(32) ‖ seed(32)
path:    external m/0'/0'/n'      internal m/0'/1'/n'
         (src/wallet/scriptpubkeyman.cpp DeriveNewDilithiumChildKey)
key:     ML-DSA-44 KeyGen(ξ = derived seed)
```

**The interoperability gap (important, and worth stating in the README):**
that HD path lives in `LegacyScriptPubKeyMan`, i.e. **BDB legacy wallets only** — which
modern btq-core builds cannot even create (`Compiled without bdb support`). A
**descriptor** wallet's `listdescriptors` contains only classical descriptors; its
Dilithium keys are generated outside the descriptor system, so they have **no descriptor
backup path**. Practical conclusion: **BTQ has no usable, published HD standard today.**

This wallet therefore:
1. implements btq-core's scheme faithfully (the only precedent), and
2. seeds it from a **BIP39 mnemonic** (BIP39 seed → `masterFromSeed`), documenting that
   mapping explicitly as *this wallet's* standard, and
3. also accepts a **raw 32-byte HD seed (hex)** so a btq-core wallet can be imported.

---

## 6. Explorer API ✅ probed live

Base `https://explorer.bitcoinquantum.com`. Recorded response bodies, byte for byte, live
in `tests/fixtures/explorer/*.json` and are driven through the real parsers by
`tests/unit/explorer-fixtures.test.ts`.

| Endpoint | Returns |
|---|---|
| `GET /api/v1/address/{addr}` | `balance`, `total_received`, `total_sent`, `tx_count`, `unspent_count`, `script_type: "witness_v2_p2mr"`, `isDilithium`, `first_seen_height` |
| `GET /api/v1/address/{addr}/utxos` | `{items:[{txid, vout, block_height, value, script_pub_key{type:"Buffer",data:[…]}, script_type, spent_txid, spent_vin}]}` — **coin selection** |
| `GET /api/v1/address/{addr}/txs` | `{items:[{address, txid, block_height, tx_index, value_change}], total, page, limit}` |
| `GET /api/v1/tx/{txid}` | `fee, vsize, weight, is_dilithium, block_height, inputs[], outputs[]` |
| `GET /api/v1/blocks/tip` | `{hash, height, timestamp, …}` — confirmations |
| `GET /api/v1/blocks?limit=n`, `/api/v1/block/{hash}` | recent blocks, one block |
| `GET /api/v1/mempool/summary` | `{txCount, totalVsize, totalFees, feeHistogram}` |

**There is no broadcast route.** `POST /api/v1/tx/send` answers
`404 {"message":"Route POST:/api/v1/tx/send not found"}`, every other guessed push path
404s, and the api-docs page lists none. The `GET` on that path returns 400 only because it
collides with `/api/v1/tx/:txid` — that 400 is not evidence of a route. Broadcast
therefore goes through a BTQ Core node's JSON-RPC (`testmempoolaccept` +
`sendrawtransaction`); `src/core/explorer/broadcast.ts` keeps the constant and the 404
handling so the failure is reported honestly rather than guessed at.

Facts worth pinning, all verified against the live API:

- Amounts are **strings** in satoshis. **Never trust an explorer amount for signing** —
  verify against the UTXO you are spending, whose script you re-derived.
- The `balance` field is **not trustworthy**: a heavily used address reported
  `balance: -266828342816391` and `unspent_count: -224` while `/utxos` listed 91 real
  unspents. Spendable balance is the sum of `/utxos`, nothing else.
- A never-seen address returns **404** `{"error":"Address not found"}`, while its `/utxos`
  and `/txs` return 200 with `items: []`. Only that exact body means "unused" — a Fastify
  route-miss body or a non-JSON 404 is an outage and must not be read as an empty wallet.
- `/utxos` pages with **`?offset=N&limit=M`** (`page` is ignored, no `total` is returned).
  The default returned all 91 for the test address; the cap is undocumented, so page
  defensively until a short page comes back.
- `/txs` pages with **`?page=N&limit=M`**, 1-based, **default limit 25, max 100**
  (`limit=1000` returns nothing). `total` is present, so the walk can stop on
  `page * limit >= total`.
- The chain still carries **legacy Dilithium P2PKH** outputs (`script_type:
  "dilithium_pubkeyhash"`, `76a914…88bb`, base58 `n…` on testnet). The docs call them
  historical; P2MR is the only supported receive type, and this wallet refuses them as
  destinations with that reason.

---

## 7. Chain parameters

- Block spacing **60 s** (`src/kernel/chainparams.cpp:92`) — confirmations accrue ~10× faster than Bitcoin
- Subsidy 5 BTQ, halving every 2,100,000 blocks (`:75`)
- Difficulty: **LWMA-1, retargeted every block** (`src/pow.cpp:25-26,62`)
- Testnet HRP `tbtq`; testnet RPC port 18332, regtest 18443

---

## 8. Cross-check evidence ✅

Reproduce with a regtest node (see README):

| Proof | Test |
|---|---|
| Our address == node's `getnewp2mraddress` (address, scriptPubKey, merkle_root) | `tests/integration/address-compat.test.ts` |
| Node classifies it `isdilithium: true`, `witness_version: 2` | same |
| A transaction we sign passes `testmempoolaccept` (real interpreter runs OP_CHECKSIGDILITHIUM) | `tests/integration/spend-accepted.test.ts` |
| A tampered digest is rejected | same |
| Derivation/scripts/addresses frozen | `tests/unit/vectors.test.ts` + `tests/vectors/golden.json` |

---

## 9. Security notes for a P2MR signer

- **Never sign a PSBT-supplied leaf without checking it commits to the witness program.**
  btq-core enforces this in `src/psbt_dilithium.cpp` `ValidateP2MRDilithiumInput`
  ("a signer could be tricked into signing an unrelated script"). We expose
  `commitsToProgram()` in `src/core/script/p2mr.ts` for exactly this.
- btq-core validates whole Dilithium PSBTs at **decode** time and zeroes them on failure
  (`src/psbt.cpp:588-593`), including verifying every partial signature.
- PSBT proprietary input fields, if you add PSBT support: `0x19` leaf script (control
  block in the **key**, leaf version appended to the **value**), `0x1A` merkle root,
  `0x1B` Dilithium sig (key = pubkey ‖ leaf hash) — `src/psbt.h:52-54`.
