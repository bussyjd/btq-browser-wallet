---
name: btq-wallet
description: Build the BTQ (Bitcoin Quantum) post-quantum browser wallet take-home — ML-DSA-44 / P2MR keys, addresses, signing, explorer integration, MV3 extension, and the security test suite. Use for any work in the btq-browser-wallet repo, or whenever implementing BTQ wallet functionality, P2MR addresses, Dilithium signing, or the take-home's graded features.
---

# BTQ browser wallet — implementation skill

You are building a MetaMask-style **browser extension wallet for Bitcoin Quantum
(testnet)**. This skill carries the protocol knowledge, the grading rubric, and the
working conventions. **Read `docs/REFERENCE.md` before writing protocol code** — it has
every constant with its `btq-core` file:line, already verified against a live node.
`docs/BTQ_CORE_MAP.md` is the full 95-row BTQ-vs-Bitcoin difference map with coverage
status per row; `docs/HD_IMPORT.md` explains the import-from-seed design with diagrams.

## The brief (138 points)

| Feature | Pts | Feature | Pts |
|---|---|---|---|
| Create a new wallet from a seed | 8 | Code structured and readable | 8 |
| Import an existing HD wallet | 8 | **Tests** | **15** |
| Receive Dilithium payments | 10 | GitHub repo we can clone | 2 |
| **Send Dilithium payments** | **12** | Video of the four flows | 5 |
| Balance and history from the explorer | 8 | Site-connect flow (MetaMask-like) | 4 |
| Looks good and feels smooth | 10 | Fees, extra accounts, onboarding polish | 3 |
| Clear writing in UI and README | 5 | **Anything else you'd ship in a real wallet** | **40** |

The 40-point bucket is the largest single item — treat "what a real wallet ships" as a
first-class feature area, not a nice-to-have. Testing is explicitly to be judged the way
"a professional security operations team would treat a wallet that holds keys".

## Non-negotiable protocol facts

These are the ones that silently destroy funds if you get them wrong:

1. **Signatures are exactly 2421 bytes** — 2420-byte ML-DSA + a mandatory `SIGHASH_ALL`
   (`0x01`) byte. `SIGHASH_DEFAULT` is rejected by consensus.
2. **Sign deterministically with an empty context.** With `@noble/post-quantum`, call
   `sign(sk, msg, new Uint8Array(0))` and omit the 4th `random` argument. The bundled
   `.d.ts` is stale — see the shim in `src/core/crypto/mldsa.ts`.
3. **Witness scale factor is 16, not 4.** A single-key P2MR input is **4402 WU =
   275.125 vB**. Fee math using Bitcoin's scale-4 vsize overestimates ~4×.
4. **Witness order is `[signature, leafScript, controlBlock]`** and the control block is
   the single byte `0xc1`.
5. **Testnet addresses are `tbtq1z…`** (bech32m, witness v2, 32-byte program). Reject
   any other HRP, and reject the legacy `tdbt…` Dilithium namespace outright.
6. **Derivation is hardened-only** (`m/0'/0'/n'` external, `m/0'/1'/n'` internal) over
   the 32-byte ML-DSA seed, not over a private scalar. There is no xpub.
7. **Never sign a leaf script you did not build** without calling `commitsToProgram()`.

## Architecture

```
src/core/       pure, browser-safe, no Node Buffer, 100% unit-tested
  crypto/       mldsa.ts (sign/verify/keygen)  hd.ts (BIP32-style hardened derivation)
  script/       p2mr.ts (leaf, tapleaf, scriptPubKey, commitment check)  address.ts (bech32m)
  tx/           serialize.ts  sighash.ts (BIP341 tapscript)  builder/coinselect/fee (todo)
  util/         hex.ts
src/background/ MV3 service worker — THE ONLY place keys are ever decrypted
src/content/    relay only; never sees key material
src/inpage/     window.btq provider for the site-connect flow
src/ui/         React popup, onboarding, approval screens
```

**Trust boundary:** the mnemonic and derived seeds exist only inside the service worker,
only while unlocked. Content scripts and pages get a narrow allowlisted message API.
Any change that moves key material outward is a bug, however convenient.

## Working conventions

- **TypeScript strict**, `noUncheckedIndexedAccess` on. No `any` in `src/core`.
- Core must run in a browser: **no `Buffer`, no `node:` imports** outside tests/scripts.
- Every protocol constant carries a comment citing its `btq-core` source line.
- Imports use ESM `.js` specifiers; vitest aliases them to `.ts`.
- Prefer small pure functions in `core/` and keep I/O (fetch, storage) at the edges.

## Verify before you trust

Run the regtest cross-check whenever you touch derivation, scripts, addresses or signing:

```sh
# start a node (once)
btqd -datadir=/tmp/btq-m0-regtest -daemon
BTQ_REGTEST=1 npx vitest run tests/integration
npx vitest run                      # unit + golden vectors
npx tsx scripts/gen-vectors.ts      # regenerate vectors (only with a node cross-check)
```

`tests/vectors/golden.json` is the contract with consensus. **Never regenerate it to
make a test pass** — a diff there means addresses or signatures changed.

## Definition of done for each feature

- **Create (8):** BIP39 mnemonic generated with real entropy, shown exactly once,
  confirmation challenge, vault sealed with a password before anything is persisted.
- **Import (8):** BIP39 mnemonic *and* raw 32-byte btq-core HD seed; validates checksum;
  rejects a bad seed with a clear message.
- **Receive (10):** derived address, QR, copy, gap-limit scan so a restored wallet finds
  used addresses.
- **Send (12):** UTXOs from the explorer, coin selection, scale-16 fee, sighash, sign,
  broadcast, pending → confirmed. Validate the destination network and reject dust.
- **Balance/history (8):** explorer client with retry and schema validation; never trust
  an amount from the API in the signing path.
- **Tests (15):** see the security list in `docs/REFERENCE.md §9` and the plan; cover
  create/import/unlock, bad seed, rejected sends, storage, and what a page can read.
- **Site-connect (4):** `window.btq` provider, explicit approval, exact-origin matching,
  revocable per-site permissions.

## Traps found the hard way

- `getrawtransaction` needs `-txindex`; use the wallet's `gettransaction` on regtest.
- Legacy BDB wallets can't be created on modern builds — don't design a test around them.
- The explorer's `/api/v1/tx/{txid}` 404s for transactions it hasn't indexed; don't infer
  "invalid" from a 404.
- btq-core testnet needs the LWMA fix or a fresh node forks at height 300000.
