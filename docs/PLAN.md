# BTQ Browser Wallet — implementation plan

A MetaMask-style browser extension for Bitcoin Quantum (testnet only). This plan
front-loads the two things that decide whether it works at all — **HD derivation
compatibility** and **the explorer API** — both verified against source in §1 and §2.

It is kept as written, with status marked where reality disagreed with the plan: §2 (the
explorer has no broadcast route), §4 (what shipped), §6 (what did not).

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
| `GET /api/v1/blocks/tip`, `/api/v1/block/{hash}` | tip height, confirmations |
| ~~`POST /api/v1/tx/send`~~ | **no push route** — 404 `Route POST:/api/v1/tx/send not found` |

**Resolved, against the plan's expectation:** there is no broadcast route. The 400 this
plan originally read as "the route exists and wants a body" was a `GET` colliding with
`/api/v1/tx/:txid`; the `POST` 404s, as does every other guessed path. Broadcast goes
through a BTQ Core node's `testmempoolaccept` + `sendrawtransaction`, configured under
Settings — so "explorer-only, no node" was not achievable. The wallet signs first and
keeps the hex when there is no node, rather than pretending. Paging, 404 semantics and the
untrustworthy `balance` field are recorded in `docs/REFERENCE.md §6`.

---

## 3. Stack & repo layout

**Chrome MV3 + TypeScript + React + Vite (`@crxjs/vite-plugin`), npm.**
Crypto: `@noble/post-quantum` (ML-DSA-44), `@noble/hashes` (HMAC-SHA512/SHA256/SHAKE),
`@scure/base` (bech32m), `@scure/bip39`. All audited, pure TS, no WASM — keeps the
bundle reviewable and MV3-safe (no `unsafe-eval`).

What shipped (the plan's layout, corrected to the tree that exists):

```
btq-browser-wallet/
├─ src/
│  ├─ core/                 # pure, browser-safe, no I/O
│  │  ├─ crypto/            # mldsa.ts, hd.ts (the §1.1 scheme), mnemonic.ts
│  │  ├─ script/            # p2mr.ts, address.ts
│  │  ├─ tx/                # serialize, parse, sighash, fee (scale-16), coinselect, builder
│  │  ├─ vault/             # encrypt.ts (PBKDF2-SHA256 600k + AES-256-GCM), payload.ts
│  │  ├─ wallet/            # keyring.ts, derive, gap, storage, destination, format, errors
│  │  ├─ explorer/          # parse, schema, utxo, history, broadcast (parsers only)
│  │  ├─ rpc/               # protocol.ts, dispatch.ts, origin.ts
│  │  └─ network/           # backend.ts (endpoint validation), jsonrpc.ts
│  ├─ background/           # MV3 service worker: the ONLY place keys are decrypted
│  │  ├─ index.ts           # message listener, auto-lock alarm, connect wiring
│  │  ├─ connect.ts         # the approval broker (holds the page's promise)
│  │  ├─ explorer.ts        # API client: retry/backoff, paging, schema validation
│  │  └─ node-rpc.ts  backend-store.ts  chrome-storage.ts
│  ├─ ui/                   # React popup: App.tsx, hooks/, components/, screens/
│  ├─ content/              # relays allowlisted page.* only; never sees secrets
│  └─ inpage/               # btq-provider.js — window.btq, MAIN world, frozen
├─ tests/
│  ├─ vectors/              # golden.json — the frozen contract with consensus
│  ├─ unit/  security/  integration/
│  ├─ fixtures/explorer/    # bodies recorded from the live explorer
│  └─ e2e/                  # Playwright, the built extension in Chromium
├─ examples/dapp.html  demo/  docs/  README.md  SECURITY.md
└─ scripts/gen-vectors.ts  scripts/stitch-demo.sh
```

`ARCHITECTURE.md` was never written as a separate file: `README.md` §Layout,
`docs/REFERENCE.md` and this plan cover it, and a fourth overlapping document would rot.

**Trust boundary (the thing a security team looks for):** the mnemonic and private
seeds exist **only** inside the service worker, only while unlocked. The content
script and page get a narrow, allowlisted message API — never key material, never a
signing primitive that doesn't route through explicit user approval.

---

## 4. Milestones

**M0 — Compatibility spike (before any UI). ✅ done.** Derivation and signing proved
against a regtest btq-core: our addresses, `scriptPubKey` and merkle roots match
`getnewp2mraddress` byte for byte, and `testmempoolaccept` accepted a transaction we
signed (`tests/integration/`). Frozen as `tests/vectors/golden.json`.

**M1 — Create, import, receive. ✅ done.** BIP39 create/import plus raw 32-byte HD seed
import, PBKDF2 + AES-GCM vault, hardened derivation, 20-address gap scan on both chains,
receive screen with QR and path.

**M2 — Send, balance and history. ✅ done.** UTXOs and history paged from the explorer,
balance summed from `/utxos`, scale-16 fee estimation, coin selection under the weight
ceiling, BIP341 sighash, signing, and node broadcast. Broadcast turned out to require a
node (§2); a failed broadcast keeps the signed hex and says why.

**M3 — UX polish. ✅ done.** Onboarding, seed-confirm challenge, lock and a 1-minute
auto-lock alarm, activity list with confirmations, brand palette in both colour schemes,
and error copy that names the cause and the next step.

**M4 — Site-connect, fees, onboarding. ◐ mostly.** `window.btq` provider, held approval
with the origin displayed, per-site permissions with revoke, `accountsChanged`, three fee
presets and a Max button. **Not done: multiple accounts** — the keyring derives one
account (`m/0'/…`) and no RPC exposes a second, so it was left out rather than faked.

**M5 — Tests, README, video. ✅ done.** 311 unit + security tests, an 18-journey Playwright
suite against the built extension, this README, and `demo/btq-wallet-demo.mp4` recorded by
that suite (`npm run demo:video`); `docs/VIDEO.md` is the shot list for a narrated cut.

**M6 — "What you'd ship in a real wallet." ◐ partly** — see §6 for which of the ten
landed.

---

## 5. Test plan — written for a security team, not a demo

Runner: **Vitest** (unit, security, integration) + **Playwright** (end-to-end on the real
extension). `npm test`, `npm run test:e2e`, `npm run test:all` — documented in the README;
there is no separate `test:security` script, the security suite runs inside `npm test`.
What each layer proves is tabulated in the README; `tests/e2e/README.md` covers what is
mocked and what each hostile case would otherwise miss.

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

## 6. "What you'd ship in a real wallet" — what landed

Ranked as planned, marked against the tree:

1. **Reproducible builds** ◐ — lockfile committed, CI runs `npm ci` and uploads `dist/`. No
   `npm audit` gate and no hash-for-hash reproducibility claim.
2. **Address verification UX** ◐ — full address, mono chunking, copy with confirmation, the
   derivation path on screen. No "first send to this address" warning.
3. **Transaction preview that cannot lie** ✅ — `previewFromSigned` decodes the signed bytes
   back (`src/core/tx/parse.ts`) and refuses to display if txid, weight, outputs or change
   disagree with the plan the user approved.
4. **Auto-lock + re-auth on send** ✅ — a 1-minute alarm enforces the idle timeout and every
   `confirmSend` re-authenticates with the password. The timeout is not user-configurable.
5. **Encrypted vault backup / restore file** ✗ — not built. Recovery is the phrase or the
   raw seed; a second export path is a second thing that can leak.
6. **Explorer failover / offline mode** ✗ — deliberately not built. A failed lookup is a
   loud error, never a silent "0"; caching a stale balance behind a banner was judged worse
   than saying the backend is down.
7. **Phishing resistance** ✅ — exact-origin matching on the browser-reported origin,
   connected-site list with revoke, the approval lives in the extension's own window, and
   the relay drops any message whose source or origin is not this page.
8. **Accessibility** ◐ — real forms, submit buttons, autofocus, `role="tablist"` with roving
   focus, `aria-busy`, `aria-pressed`, contrast checked in both schemes. **i18n** ✗.
9. **Structured error taxonomy** ✅ — `WalletError` codes across the RPC surface, with
   user-facing text written per code; `SECRET_RESULT_KEYS` keeps secrets out of results.
   No debug log was added (nothing to redact is better than redacting).
10. **CI** ✅ — `.github/workflows/ci.yml` runs lint, typecheck, the unit and security
    suites, the build, and the end-to-end suite against that exact `dist/`, and uploads it.
    No packaged `.zip` release artifact.

Also shipped, not on the original list: unlock back-off after 5 failures, pending-outpoint
reservation so a second send cannot replace one in flight, node-vs-explorer chain identity
checking, and a warning when the RPC password would cross the network in the clear.

---

## 7. Risks

| Risk | How it played out |
|---|---|
| BIP39→`SetSeed` mapping is unstandardised | Still unstandardised. Resolved by implementing btq-core's scheme and documenting our BIP39 mapping as this wallet's own (`docs/HD_IMPORT.md`), plus raw-32-byte-seed import for a btq-core wallet |
| Explorer lacks a usable broadcast body | **Realised, worse than expected** — there is no route at all (§2). Node RPC under Settings is the only push path; without one the wallet signs and keeps the hex |
| ML-DSA keygen mismatch vs btq-core | Did not happen; `golden.json` + `tests/integration/` pin it, and the e2e mock node re-verifies every signature |
| 2421-byte signatures bloat popup memory | Inputs capped at 90 by the standardness ceiling; the bulky decoded view stays in the worker and never crosses the RPC |
| Testnet funds | **Realised** — the chain forked between heights 299000 and 300000, so old coins and old nodes are on a dead fork. A demo needs a `v0.5.0-testnet` node on the explorer's chain |

---

## 8. Definition of done
Clone → `npm install && npm run build` → load unpacked in Chrome → create wallet, import
wallet, receive, send; `npm test && npm run test:e2e` green from a clean checkout; README
walks a reviewer through each flow in under five minutes; video shows create → import →
receive → send.

**Status:** all of it, with one asterisk — "send, against public testnet" needs a BTQ Core
`v0.5.0-testnet` node configured under Settings, because the explorer cannot broadcast.
The end-to-end suite (`tests/e2e/smoke.spec.ts`) walks the whole definition of done
against the built extension on every run, and `npm run demo:video` records it.
