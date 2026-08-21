# BTQ Browser Wallet — implementation plan

Take-home: a MetaMask-style browser extension for Bitcoin Quantum (testnet only).
138 points. This plan front-loads the two things that decide whether it works at all
— **HD derivation compatibility** and **the explorer API** — both already verified
against source in this plan (see §1, §2).

---

## 1. Protocol facts (verified against btq-core source, not assumed)

### 1.1 HD derivation — the make-or-break detail
"Import an existing HD wallet from the seed" only passes if our derivation is
byte-identical to btq-core's. ML-DSA has **no public derivation**, so btq-core uses a
hardened-only BIP32 variant over the 32-byte ML-DSA seed:

| Step | Definition | Source |
|---|---|---|
| Master | `I = HMAC-SHA512(key="Dilithium seed", msg=hd_seed)` → `I_L`=seed(32), `I_R`=chaincode(32) | `src/crypto/dilithium_key.cpp` `CDilithiumExtKey::SetSeed` |
| Child | `I = HMAC-SHA512(key=parent_chaincode, msg=0x00 ‖ parent_seed(32) ‖ ser32BE(index))` | `CDilithiumExtKey::Derive` |
| Hardening | **Hardened only** — non-hardened indices are refused by design | same |
| Path | `m/0'/0'/n'` external, `m/0'/1'/n'` internal (mirrors Core's legacy HD split) | `src/wallet/scriptpubkeyman.cpp` `DeriveNewDilithiumChildKey` |
| Keypair | `ML-DSA-44 KeyGen(ξ = seed)` — standard FIPS 204: `H(ξ ‖ k ‖ ℓ, 128)` → ρ, ρ′, K | `src/crypto/dilithium/ref/sign.c` `crypto_sign_keypair_from_seed` |
| Ext key | 73 bytes = depth(1) ‖ fingerprint(4) ‖ child(4 BE) ‖ chaincode(32) ‖ seed(32) | `Encode`/`Decode` |

Because KeyGen is standard FIPS 204, **`@noble/post-quantum`'s `ml_dsa44.keygen(seed)`
should match exactly** — to be proven by golden vectors in Milestone 0, not trusted.

**Open question to resolve first:** what bytes feed `SetSeed`? Core seeds HD from a
32-byte key (`sethdseed`-style), *not* BIP39. A MetaMask-style wallet must show a
mnemonic. Decision: use **BIP39 mnemonic → BIP39 seed → feed to `SetSeed`**, and pin
the exact mapping with a cross-check against a live regtest node (§5, M0). Document it
in the README as the wallet's stated standard, since BTQ has not published one.

### 1.2 Address & script (P2MR, witness v2)
- Leaf: `OP_PUSHDATA2 <1312-byte ML-DSA pubkey> OP_CHECKSIGDILITHIUM(0xbb)`, leaf version `0xc0`
- Merkle root = TapLeaf tagged hash; **witness program IS the root** (no internal key, no tweak)
- scriptPubKey = `OP_2 <32-byte root>` (`5220…`, 34 bytes)
- Address = bech32m, HRP **`tbtq`** on testnet (mainnet `qbtc`, signet `qtb`, regtest `qcrt`)
- Control block = single byte `0xc1` (parity bit must be set)

### 1.3 Signing
- Digest = **BIP341 tapscript sighash**, unchanged (epoch 0, ext_flag 1, key_version 0)
- `SIGHASH_DEFAULT` is **rejected** — signature is always 2420 B + `0x01` = **2421 bytes**
- ML-DSA context string is **empty**; the 32-byte sighash is signed directly (no pre-hash)
- Witness = `[signature, leafScript, controlBlock]`

### 1.4 Fees
- **Witness scale factor 16** (not 4). Single-key P2MR input = **4402 WU = 275.125 vB**
- `vsize = ceil((stripped_size × 15 + total_size) / 16)`
- Practical ceiling: `MAX_STANDARD_TX_WEIGHT` 400,000 WU ⇒ ~90 inputs max — enforce in coin selection

### 1.5 Chain parameters
1-minute blocks; subsidy 5 BTQ halving every 2,100,000 blocks; LWMA-1 per-block difficulty.
Confirmations accrue ~10× faster than Bitcoin — never equate confirmations with elapsed time in the UI.

---

## 2. Explorer API (probed live, working)

Base: `https://explorer.bitcoinquantum.com`

| Endpoint | Use |
|---|---|
| `GET /api/v1/address/{addr}` | balance, total_received/sent, tx_count, unspent_count, `script_type: witness_v2_p2mr`, `isDilithium` |
| `GET /api/v1/address/{addr}/utxos` | **coin selection** |
| `GET /api/v1/address/{addr}/txs` | history |
| `GET /api/v1/blocks`, `/api/v1/block/{hash}` | tip height, confirmations |
| `POST /api/v1/tx/send` | **broadcast** (returns 400 on GET ⇒ route exists, expects a body) |

Confirm the send payload shape in M0. Fallback if unusable: broadcast via a BTQ Core
testnet node over RPC behind a tiny proxy — but explorer-only is the goal (no node).

---

## 3. Stack & repo layout

**Chrome MV3 + TypeScript + React + Vite (`@crxjs/vite-plugin`), pnpm.**
Crypto: `@noble/post-quantum` (ML-DSA-44), `@noble/hashes` (HMAC-SHA512/SHA256/SHAKE),
`@scure/base` (bech32m), `@scure/bip39`. All audited, pure TS, no WASM — keeps the
bundle reviewable and MV3-safe (no `unsafe-eval`).

```
btq-browser-wallet/
├─ src/
│  ├─ core/                 # pure, dependency-free, 100%-tested
│  │  ├─ crypto/            # mldsa.ts, hd.ts (the §1.1 scheme), mnemonic.ts
│  │  ├─ script/            # p2mr.ts, address.ts, taproot-sighash.ts
│  │  ├─ tx/                # builder.ts, coinselect.ts, fee.ts (scale-16), psbt-lite.ts
│  │  └─ vault/             # encrypt.ts (AES-GCM + PBKDF2/Argon2), serialize.ts
│  ├─ background/           # MV3 service worker: the ONLY place keys are decrypted
│  │  ├─ keyring.ts         # unlock/lock, in-memory only, auto-lock timer
│  │  ├─ rpc-router.ts      # typed port messaging, origin checks
│  │  └─ explorer.ts        # API client, retry/backoff, response validation
│  ├─ ui/                   # popup + onboarding + approval screens (React)
│  ├─ content/              # injects provider, relays only; never sees secrets
│  └─ inpage/               # window.btq provider (EIP-1193-shaped)
├─ tests/
│  ├─ vectors/              # golden vectors incl. btq-core cross-check output
│  ├─ unit/  integration/  security/
│  └─ e2e/                  # Playwright, real extension in Chromium
├─ docs/  README.md  SECURITY.md  ARCHITECTURE.md
└─ scripts/gen-vectors.ts   # regenerates vectors from a regtest btq-core node
```

**Trust boundary (the thing a security team looks for):** the mnemonic and private
seeds exist **only** inside the service worker, only while unlocked. The content
script and page get a narrow, allowlisted message API — never key material, never a
signing primitive that doesn't route through explicit user approval.

---

## 4. Milestones

**M0 — Compatibility spike (before any UI).** Prove derivation + signing against a
real node. Run btq-core regtest locally, generate an HD wallet, and assert our TS
derivation reproduces its addresses; sign a P2MR spend in TS and have the node accept it
via `testmempoolaccept`. Freeze the results as golden vectors. *If this fails, nothing
else matters — so it happens first.*

**M1 — Core (rubric: create 8, import 8, receive 10).** BIP39 create/import, vault
encrypt/unlock, address derivation, gap-limit scan against the explorer, receive screen + QR.

**M2 — Send (12) + balance/history (8).** UTXO fetch, scale-16 fee estimation, coin
selection with the weight ceiling, sighash, sign, broadcast, pending→confirmed states.

**M3 — UX polish (looks/feels 10, writing 5).** Onboarding, seed-confirm challenge,
lock/auto-lock, activity list, error copy that says what to do next.

**M4 — Site-connect (4) + fees/accounts/onboarding (3).** `window.btq` provider,
connect approval with origin display, per-site permissions, multiple accounts, fee selection.

**M5 — Tests (15) + README + video (5+2).** See §5.

**M6 — The 40-point bucket** (§6).

---

## 5. Test plan — written for a security team, not a demo

Runner: **Vitest** (unit/integration) + **Playwright** (E2E on the real extension).
`pnpm test`, `pnpm test:e2e`, `pnpm test:security` — all documented in the README.

**Correctness / compatibility**
- Golden vectors from btq-core: seed → address, at multiple indices, both chains
- Sighash matches an independent BIP341 reference implementation
- Signature is exactly 2421 bytes and ends `0x01`; node accepts the finalized tx
- Fee math: 4402 WU / 275.125 vB; vsize formula vs node's own `getrawtransaction` vsize

**Paths that leak secrets**
- Vault ciphertext contains no plaintext seed bytes (scan the serialized blob)
- Wrong password fails; **no oracle** — same error, no timing signal, attempt throttling
- Locked wallet cannot sign, cannot export, cannot derive a new address
- Seed shown exactly once; not recoverable from any UI surface after confirmation
- `chrome.storage` never holds decrypted material; service-worker restart re-locks
- Memory hygiene: secrets zeroed after use where the runtime allows

**Paths that move funds**
- A page **cannot** trigger a send without explicit approval — assert the request is rejected
- Malicious origin cannot impersonate an approved one (exact-origin match, no substring)
- Sending to a mainnet/wrong-HRP address is rejected (network binding)
- Sending to a witness-v0/legacy Dilithium address is rejected, not silently mis-sent
- Amount > balance, dust, and >90-input transactions are rejected before signing
- **Tampered PSBT/leaf**: a supplied leaf script that does not commit to the witness
  program must be refused before signing *(this is a real bug class — btq-core guards it
  explicitly in `ValidateP2MRDilithiumInput`)*
- Replay/confused-deputy: two rapid approvals cannot double-spend the same UTXO set

**Extension surface**
- Content script exposes only the allowlisted method set; unknown methods rejected
- Page cannot read `chrome.storage`, cannot reach the keyring port
- CSP has no `unsafe-eval`/`unsafe-inline`; no remote code; dependency count kept small
- Explorer responses are schema-validated — a hostile/compromised explorer cannot
  inject an address or amount into the signing path (**amounts are verified against the
  UTXO being spent, not trusted from the API**)

**Abuse cases explicitly documented in SECURITY.md** with what we do and do not defend against.

---

## 6. The 40-point bucket — "what you'd ship in a real wallet"

Ranked by signal per unit of effort:
1. **Reproducible, verifiable builds** — pinned deps, `pnpm audit` in CI, a build that a reviewer can reproduce hash-for-hash
2. **Address verification UX** — full address display, checksummed chunking, copy-confirm, "first send to this address" warning
3. **Transaction preview that cannot lie** — decode our own signed tx and show inputs/outputs/fee from the *signed bytes*, not from intent
4. **Auto-lock + re-auth on send**, configurable timeout
5. **Encrypted vault backup / restore** file, with a documented format
6. **Explorer failover + offline mode** — cached balances, clear stale-data banner
7. **Phishing resistance** — connected-site list with revoke, origin pinning, anti-clickjacking on approval screens
8. **Accessibility & i18n scaffolding** — keyboard-navigable approvals, screen-reader labels
9. **Structured error taxonomy** and a debug log that redacts secrets by construction
10. **CI**: typecheck, lint, unit, E2E, and a packaged `.zip` artifact per commit

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| BIP39→`SetSeed` mapping is unstandardised | Resolve in M0 against a live node; document it explicitly; make it configurable if BTQ later publishes a standard |
| Explorer lacks a usable broadcast body | Node-RPC fallback behind a config flag (documented as such) |
| ML-DSA keygen mismatch vs btq-core | Golden vectors in M0; fail the build if they drift |
| 2421-byte signatures bloat popup memory | Stream/limit UTXO counts; cap inputs at the standardness ceiling anyway |
| Testnet funds | Old smoke-wallet funds are unreliable (chain fork during earlier work) — mine or faucet fresh coins for the demo |

---

## 8. Definition of done
Clone → `pnpm i && pnpm build` → load unpacked in Chrome → create wallet, import wallet,
receive, send, all against public testnet; `pnpm test && pnpm test:e2e` green from a
clean checkout; README walks a reviewer through each flow in under five minutes; video
shows create → import → receive → send.
