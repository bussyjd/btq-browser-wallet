# Engineering plan and status

A browser-extension wallet for Bitcoin Quantum, testnet only. This document records what
the wallet is, the order it was built in, what it deliberately does not do, and what is
next. The protocol facts in §1 and the explorer findings in §2 were settled before any UI
existed, because either of them could have made the whole thing impossible.

---

## 1. Protocol facts (verified against btq-core source, not assumed)

### 1.1 HD derivation — the make-or-break detail

Importing an existing BTQ HD wallet only works if derivation is byte-identical to
btq-core's. ML-DSA has **no public derivation**, so btq-core uses a hardened-only BIP32
variant over the 32-byte ML-DSA seed:

| Step | Definition | Source |
|---|---|---|
| Master | `I = HMAC-SHA512(key="Dilithium seed", msg=hd_seed)` → `I_L`=seed(32), `I_R`=chaincode(32) | `src/crypto/dilithium_key.cpp` `CDilithiumExtKey::SetSeed` |
| Child | `I = HMAC-SHA512(key=parent_chaincode, msg=0x00 ‖ parent_seed(32) ‖ ser32BE(index))` | `CDilithiumExtKey::Derive` |
| Hardening | **Hardened only** — non-hardened indices are refused by design | same |
| Path | `m/k'/0'/n'` external, `m/k'/1'/n'` internal (`k = 0` is Core's legacy HD split) | `src/wallet/scriptpubkeyman.cpp` `DeriveNewDilithiumChildKey` |
| Keypair | `ML-DSA-44 KeyGen(ξ = seed)` — standard FIPS 204: `H(ξ ‖ k ‖ ℓ, 128)` → ρ, ρ′, K | `src/crypto/dilithium/ref/sign.c` `crypto_sign_keypair_from_seed` |
| Ext key | 73 bytes = depth(1) ‖ fingerprint(4) ‖ child(4 BE) ‖ chaincode(32) ‖ seed(32) | `Encode`/`Decode` |

Because KeyGen is standard FIPS 204, `@noble/post-quantum`'s `ml_dsa44.keygen(seed)`
matches btq-core exactly — proven by golden vectors and a live regtest cross-check, not
assumed.

**The one thing BTQ does not define** is what bytes feed `SetSeed`. btq-core seeds its HD
tree from a 32-byte value (`sethdseed`-shaped), and there is no BTQ mnemonic standard at
all. This wallet therefore does two separate things and says so: a **BIP39 mnemonic →
BIP39 seed → `SetSeed`** mapping of its own, stated in [`HD_IMPORT.md`](HD_IMPORT.md),
and a **raw 32-byte hex seed** import for a wallet that came out of btq-core. They are
different wallets from different inputs, not two spellings of one.

### 1.2 Address and script (P2MR, witness v2)

- Leaf: `OP_PUSHDATA2 <1312-byte ML-DSA pubkey> OP_CHECKSIGDILITHIUM(0xbb)`, leaf version `0xc0`
- Merkle root = TapLeaf tagged hash; **witness program IS the root** (no internal key, no tweak)
- scriptPubKey = `OP_2 <32-byte root>` (`5220…`, 34 bytes)
- Address = bech32m, HRP **`tbtq`** on testnet (mainnet `qbtc`, signet `qtb`, regtest `qcrt`)
- Control block = the single byte `0xc1` (the parity bit must be set)

### 1.3 Signing

- Digest = **BIP341 tapscript sighash**, unchanged (epoch 0, ext_flag 1, key_version 0)
- `SIGHASH_DEFAULT` is **rejected** — the signature is always 2420 B + `0x01` = **2421 bytes**
- The ML-DSA context string is **empty**; the 32-byte sighash is signed directly (no pre-hash)
- Witness = `[signature, leafScript, controlBlock]`

### 1.4 Fees

- **Witness scale factor 16** (not 4). A single-key P2MR input is **4402 WU = 275.125 vB**
- `vsize = ceil((stripped_size × 15 + total_size) / 16)`
- `MAX_STANDARD_TX_WEIGHT` 400,000 WU ⇒ ~90 inputs maximum, enforced in coin selection

### 1.5 Chain parameters

1-minute blocks; subsidy 5 BTQ halving every 2,100,000 blocks; LWMA-1 per-block
difficulty. Confirmations accrue ~10× faster than Bitcoin, so the UI never equates a
confirmation count with elapsed time.

Every constant with its source line is in [`REFERENCE.md`](REFERENCE.md); the full
BTQ-vs-Bitcoin difference map is [`BTQ_CORE_MAP.md`](BTQ_CORE_MAP.md).

---

## 2. Explorer API

Base: `https://explorer.bitcoinquantum.com`

| Endpoint | Use |
|---|---|
| `GET /api/v1/address/{addr}` | balance, total_received/sent, tx_count, unspent_count, `script_type: witness_v2_p2mr`, `isDilithium` |
| `GET /api/v1/address/{addr}/utxos` | **coin selection** |
| `GET /api/v1/address/{addr}/txs` | history |
| `GET /api/v1/blocks/tip`, `/api/v1/block/{hash}` | tip height, confirmations |
| ~~`POST /api/v1/tx/send`~~ | **no push route** — 404 `Route POST:/api/v1/tx/send not found` |

**There is no broadcast route.** The 400 that early probing read as "the route exists and
wants a body" was a `GET` colliding with `/api/v1/tx/:txid`; the `POST` 404s, as does
every other guessed path. An explorer-only wallet therefore cannot exist on this chain:
broadcast goes through a BTQ Core node's `testmempoolaccept` + `sendrawtransaction`,
configured under Settings. Without a node the wallet still signs, keeps the hex, and says
so rather than pretending. Paging, 404 semantics and the untrustworthy `balance` field are
recorded in [`REFERENCE.md`](REFERENCE.md) §6.

---

## 3. Stack and layout

**Chrome MV3 + TypeScript + React + Vite (`@crxjs/vite-plugin`), npm.**
Crypto: `@noble/post-quantum` (ML-DSA-44), `@noble/hashes` (HMAC-SHA512/SHA256/SHAKE),
`@scure/base` (bech32m), `@scure/bip39`. Pure TypeScript, no WASM — which keeps the bundle
reviewable and MV3-safe (no `unsafe-eval`).

```
btq-browser-wallet/
├─ src/
│  ├─ core/                 # pure, browser-safe, no I/O
│  │  ├─ crypto/            # mldsa.ts, hd.ts (the §1.1 scheme), mnemonic.ts
│  │  ├─ script/            # p2mr.ts, address.ts
│  │  ├─ tx/                # serialize, parse, sighash, fee (scale-16), coinselect, builder
│  │  ├─ vault/             # encrypt.ts (PBKDF2-SHA256 600k + AES-256-GCM), payload.ts
│  │                       #   one payload version; anything older is refused by name
│  │  ├─ wallet/            # keyring.ts, derive, gap, storage, destination, format, errors
│  │  ├─ explorer/          # parse, schema, utxo, history, broadcast (parsers only)
│  │  ├─ connect/           # permissions.ts — the per-origin allowlist
│  │  ├─ rpc/               # protocol.ts, dispatch.ts, origin.ts
│  │  ├─ network/           # backend.ts (endpoint validation), jsonrpc.ts
│  │  └─ util/              # bytes.ts, hex.ts
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
├─ demo/  docs/  README.md  SECURITY.md
└─ scripts/gen-vectors.ts  stitch-demo.sh  demo-preflight.ts  demo-live.sh
```

There is no separate `ARCHITECTURE.md`: the README's Layout section, `REFERENCE.md` and
this document cover it, and a fourth overlapping description would rot.

**Trust boundary.** The HD seed and the BIP39 entropy the vault seals beside it exist
**only** inside the service worker, only while unlocked; the phrase is regenerated from
that entropy on request and never cached. The content script and the page get a narrow
allowlisted message API — never key material, never a phrase, and never a signing
primitive that does not route through explicit user approval.
[`SECURITY.md`](../SECURITY.md) is the full model.

---

## 4. Build order

**Compatibility spike, before any UI.** Derivation and signing proved against a regtest
btq-core: our addresses, `scriptPubKey` and merkle roots match `getnewp2mraddress` byte
for byte, and `testmempoolaccept` accepted a transaction we signed
(`tests/integration/`). Frozen as `tests/vectors/golden.json`. Had this failed, nothing
built on top of it would have been worth writing.

**Create, import, receive.** BIP39 create and import plus raw 32-byte HD seed import, the
PBKDF2 + AES-GCM vault, hardened derivation, a 20-address gap scan on both chains, and a
receive screen carrying the derivation path and a QR.

**Send, balance and history.** UTXOs and history paged from the explorer, balance summed
from `/utxos`, scale-16 fee estimation, coin selection under the weight ceiling, BIP341
sighash, signing, and node broadcast. Broadcast turned out to require a node (§2); a
failed broadcast keeps the signed hex and says why.

**Polish.** Onboarding, the seed-confirmation challenge, lock and auto-lock after five
minutes idle, an activity list with confirmations, the brand palette in both colour
schemes, and error copy that names the cause and the next step.

**Site-connect and fees.** The `window.btq` provider, a held approval that names the
origin, per-site permissions with revoke, `accountsChanged`, three fee presets and a Max
button.

**Tests, docs, demo.** The unit and security suites, a Playwright suite that drives the
built extension in Chromium, the README, and `demo/btq-wallet-suite.mp4` recorded by that
suite (`npm run demo:video`). Test counts live in the README so there is one number of
record.

**A phrase reveal, and a second recording.** Settings → Security shows the recovery phrase
again on an unlocked wallet, behind the password — which meant a vault payload carrying
the BIP39 entropy next to the HD seed. And a live tier, `tests/e2e/live.spec.ts`, that
records the same extension against the public explorer and a real testnet node with real
coins (`npm run demo:live` → `demo/btq-wallet-demo.mp4`), because a recording of a mocked
chain answers a different question from the one a reader is asking.

---

## 5. Test plan

Runner: **Vitest** (unit, security, integration) + **Playwright** (end-to-end on the real
extension). `npm test`, `npm run test:e2e`, `npm run test:all`. There is no separate
`test:security` script — the security suite runs inside `npm test`. What each layer proves
is tabulated in the README; `tests/e2e/README.md` covers what is mocked and what each
hostile case would otherwise miss.

**Correctness and compatibility**

- Golden vectors from btq-core: seed → address, at several indices, on both chains
- The sighash matches an independent BIP341 implementation that never imports `src/core`
- The signature is exactly 2421 bytes and ends `0x01`; a node accepts the finalized tx
- Fee math: 4402 WU / 275.125 vB, and the vsize formula against the node's own `vsize`

**Paths that leak secrets**

- Vault ciphertext contains no plaintext seed bytes (the serialized blob is scanned)
- A wrong password fails with no oracle — one error, no timing signal, attempt back-off
- A locked wallet cannot sign, export (a backup file included), or derive a new address
- The phrase is reachable again only through Settings → Security, only on an unlocked
  wallet, and only after the password is re-checked against the sealed vault — sharing the
  unlock back-off both ways, refusing with `NO_PHRASE` for a raw-seed wallet rather than
  inventing words, and never returning words that do not re-derive that vault's seed
- `chrome.storage` never holds decrypted material; a service-worker restart re-locks
- There is one vault payload version. A payload from the pre-2 development build is
  recognised — parsed far enough to see that it is ours and intact — and refused with
  `VAULT_TOO_OLD` and its own copy, so it never reads as a wrong password or as
  corruption; corrupt and foreign blobs still get the one non-oracle `NOT_A_VAULT`. The
  vault is left on the device: removing it stays the user's decision

**Paths that move funds**

- A page cannot trigger a send at all: `wallet.*` is not on the relay's allowlist
- A hostile origin cannot impersonate an approved one (exact-origin match, no substring)
- Mainnet, wrong-HRP, witness-v0 and legacy base58 Dilithium destinations are refused
- Amounts over the balance, dust, and >90-input transactions are rejected before signing
- A supplied leaf script that does not commit to the witness program is refused before
  signing — a real bug class, guarded in btq-core by `ValidateP2MRDilithiumInput`
- Two rapid approvals cannot double-spend one UTXO set: pending outpoints are reserved

**Extension surface**

- The content script exposes only the allowlisted method set; unknown methods are rejected
- A page cannot read `chrome.storage` or reach the keyring port
- The CSP has no `unsafe-eval`/`unsafe-inline`, no remote code, and few dependencies
- Explorer responses are schema-validated, so a hostile explorer cannot inject an address
  or an amount into the signing path — amounts come from the UTXO being spent

---

## 6. Deliberately not built

Each of these was considered and left out on purpose; none is blocked on an unknown.

- ~~**Encrypted vault backup file.**~~ **Built** — see `docs/HD_IMPORT.md`. It was left out
  while recovery meant "the phrase or the raw seed", because a second export path is a
  second thing that can leak. What reopened it was not a change of taste but a change of
  fact: deleting speculative account discovery left the account *list* with no recovery
  path, and no phrase can be given one — a BIP39 phrase encodes entropy and says nothing
  about what was done with it. So the wallet either hands the user something to keep, or
  "write down how many accounts you made" is the whole of the backup story.

  Everything the original entry said about a file is still true and now sits beside the
  button: it leaves the machine, gets synced, outlives the vault it came from. What
  changed is what is *in* it. The file is `encryptVault`'s own `BTQ1` envelope — PBKDF2
  600 000, AES-256-GCM — so no cleartext key material is written anywhere, which is the
  line that mattered, and it has not moved. There is still no copy button, and a phrase
  and a seed are still shown on a screen and never written.
- **Explorer failover and offline mode.** A failed lookup is a loud error, never a silent
  "0". Caching a stale balance behind a banner was judged worse than saying the backend is
  down.
- **i18n.** English only.
- **Configurable auto-lock.** Fixed at five minutes idle — a `chrome.alarms` tick every
  minute checks the threshold — with re-authentication on every send.
- **Hardware signing and PSBT interchange.** btq-core's P2MR PSBT fields are mapped in
  `BTQ_CORE_MAP.md`, but nothing here reads or writes a PSBT: the wallet builds and signs
  its own transactions.
- **Mainnet.** Testnet HRPs only, and mainnet destinations are refused by name.

---

## 7. What is next

- A packaged release artifact; today CI uploads the unpacked `dist/`.
- The first live take of `demo/btq-wallet-demo.mp4`. Everything but the recording is in
  the tree; making one needs a synced testnet node's RPC password and a funded wallet.
- An `npm audit` gate in CI, and a reproducibility claim stronger than a committed
  lockfile.
- A "first send to this address" warning on the send screen.
- Fee estimation from live mempool data rather than three fixed presets.
- Broadcast through more than one node, or through the explorer if it grows a push route.

---

## 8. Risks, and how they played out

| Risk | Outcome |
|---|---|
| The BIP39→`SetSeed` mapping is unstandardised | Still unstandardised. Handled by implementing btq-core's scheme exactly and publishing this wallet's own BIP39 mapping (`HD_IMPORT.md`), plus raw-32-byte import for a btq-core wallet |
| The explorer lacks a usable broadcast body | Worse than expected: there is no route at all (§2). A node's RPC under Settings is the only push path; without one the wallet signs and keeps the hex |
| ML-DSA keygen might not match btq-core | It matches. `golden.json` and `tests/integration/` pin it, and the e2e mock node re-verifies every signature |
| 2421-byte signatures bloat popup memory | Inputs are capped at 90 by the standardness ceiling, and the bulky decoded transaction stays in the worker instead of crossing the RPC |
| Testnet funds | The chain forked between heights 299000 and 300000, so old coins and old nodes sit on a dead fork. Anything that broadcasts needs a `v0.5.0-testnet` node on the explorer's chain |

---

## 9. Where it stands

`npm ci && npm run build` produces an MV3 extension that loads unpacked in Chrome and
walks create → import → receive → send. `npm test` and `npm run test:e2e` are green from a
clean checkout, and `tests/e2e/smoke.spec.ts` drives that whole path against the built
extension on every run. The one asterisk is broadcast: sending on public testnet needs a
BTQ Core `v0.5.0-testnet` node configured under Settings, because the explorer cannot push
a transaction.
