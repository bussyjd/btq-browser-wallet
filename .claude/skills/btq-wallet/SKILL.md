---
name: btq-wallet
description: Build the BTQ (Bitcoin Quantum) post-quantum browser wallet — ML-DSA-44 / P2MR keys, addresses, signing, explorer integration, MV3 extension, and the security test suite. Use for any work in the btq-browser-wallet repo, or whenever implementing BTQ wallet functionality, P2MR addresses, Dilithium signing, or the extension's popup/service-worker surface.
---

# BTQ browser wallet — implementation skill

You are building a MetaMask-style **browser extension wallet for Bitcoin Quantum
(testnet)**. This skill carries the protocol knowledge and the working conventions.
**Read `docs/REFERENCE.md` before writing protocol code** — it has every constant with its
`btq-core` file:line, already verified against a live node. `docs/BTQ_CORE_MAP.md` is the
full 95-row BTQ-vs-Bitcoin difference map with coverage status per row; `docs/HD_IMPORT.md`
explains the import-from-seed design with diagrams.

## What the wallet has to do

A feature checklist, not a score sheet:

- Create a wallet from a new seed; import an existing one.
- Receive and send Dilithium (P2MR) payments on testnet.
- Read balance and history from the public explorer.
- Sign inside the extension; keep the keys there.
- Look and feel like something a person would trust with money, and say clearly what it is
  doing — in the UI and in the README.
- Structured, readable code, and a test suite written the way a professional security
  operations team would test a program that holds keys: create and import, unlock, a bad
  seed, a send that must be rejected, what is in storage, and what a webpage can reach.
- Site-connect like MetaMask: a page asks, the user approves an exact origin, and it can
  be revoked.
- Fee choice, onboarding polish, and everything else a real wallet ships — that last part
  is open-ended, and it is where the difference between a demo and a wallet shows.

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
   any other HRP, and reject the legacy base58 Dilithium namespace outright.
6. **Derivation is hardened-only** (`m/0'/0'/n'` external, `m/0'/1'/n'` internal) over
   the 32-byte ML-DSA seed, not over a private scalar. There is no xpub.
7. **Never sign a leaf script you did not build** without calling `commitsToProgram()`.
8. **Dust for a P2MR output is 270 sats** (43-byte output + 47-byte witness-branch spend
   estimate × 3000 sat/kvB) — btq-core `policy.cpp:26-63`. A stricter homemade threshold
   refuses legal payments.

## Architecture

```
src/core/       pure, browser-safe: no Buffer, no node:, no chrome.*, no fetch
  crypto/       mldsa.ts (sign/verify/keygen)  hd.ts (hardened derivation)  mnemonic.ts
  script/       p2mr.ts (leaf, tapleaf, scriptPubKey, commitsToProgram)  address.ts (bech32m)
  tx/           serialize · parse (raw-tx decoder) · sighash (BIP341 tapscript)
                fee (scale-16, dust) · coinselect · builder
  vault/        encrypt.ts (PBKDF2-SHA256 600k + AES-256-GCM)  payload.ts
  wallet/       keyring.ts (the state machine) derive gap storage destination format errors
  explorer/     parse · schema · utxo · history · broadcast (no I/O — pure parsers)
  rpc/          protocol.ts (method union) dispatch.ts origin.ts
  network/      backend.ts (endpoint validation) jsonrpc.ts
src/background/ MV3 service worker — THE ONLY place keys are decrypted
                index.ts (message listener) explorer.ts node-rpc.ts backend-store.ts
                chrome-storage.ts connect.ts (the approval broker)
src/content/    relay only; allowlisted page.* methods; never sees key material
src/inpage/     btq-provider.js — window.btq, MAIN world, frozen surface
src/ui/         React popup: App.tsx router, hooks/useWallet.ts, components/, screens/,
                screens/home/{Receive,Send,Activity}, types.ts (RPC result shapes)
```

**Trust boundary:** the mnemonic and derived seeds exist only inside the service worker,
only while unlocked. Content scripts and pages get a narrow allowlisted message API.
Any change that moves key material outward is a bug, however convenient.

**Connect lifecycle:** an unapproved origin's `page.requestAccounts` is held — the broker
parks the response, stores the pending origin, and opens the approval window. Approve →
one address; deny, closed window, or a 5-minute timeout → `USER_REJECTED` (EIP-1193
`4001`). One pending request per origin; a locked wallet answers `LOCKED` and opens
nothing.

## Working conventions

- **TypeScript strict**, `noUncheckedIndexedAccess` on. No `any` in `src/core`.
- Core must run in a browser: **no `Buffer`, no `node:` imports** outside tests/scripts.
  `tests/security/source-boundary.test.ts` enforces the boundary — including the UI's.
- Every protocol constant carries a comment citing its `btq-core` source line.
- Imports use ESM `.js` specifiers; vitest aliases them to `.ts`.
- Prefer small pure functions in `core/` and keep I/O (fetch, storage) at the edges.
- One screen per file in `src/ui/screens/`; `hooks/useWallet.ts` is the only caller of
  `rpc()`; every interactive element the tests drive carries a `data-testid`.

## Verify before you trust

```sh
npm run check                        # typecheck + lint + unit/security suites
npm run test:e2e                     # the built extension in real Chromium
BTQ_REGTEST=1 npx vitest run tests/integration    # against a live btqd
npx tsx scripts/gen-vectors.ts       # regenerate vectors (only with a node cross-check)
```

`tests/vectors/golden.json` is the contract with consensus. **Never regenerate it to
make a test pass** — a diff there means addresses or signatures changed.

## Definition of done for each feature

- **Create:** BIP39 mnemonic generated with real entropy, shown exactly once,
  confirmation challenge, vault sealed with a password before anything is persisted.
- **Import:** BIP39 mnemonic *and* raw 32-byte btq-core HD seed; validates checksum;
  rejects a bad seed with a clear message.
- **Receive:** derived address, QR, copy, gap-limit scan so a restored wallet finds
  used addresses.
- **Send:** UTXOs from the explorer, coin selection, scale-16 fee, sighash, sign,
  broadcast, pending → confirmed. Validate the destination network, reject dust, and
  never lose the signed hex when broadcast fails.
- **Balance/history:** explorer client with retry, paging and schema validation. Balance
  is the sum of `/utxos`; never trust an amount from the API in the signing path.
- **Tests:** see the security list in `docs/REFERENCE.md §9` and `docs/PLAN.md §5`; cover
  create/import/unlock, bad seed, rejected sends, storage, and what a page can read.
- **Site-connect:** `window.btq` provider, explicit approval, exact-origin matching,
  revocable per-site permissions, `accountsChanged` on revoke.

## Traps found the hard way

- `getrawtransaction` needs `-txindex`; use the wallet's `gettransaction` on regtest.
- Legacy BDB wallets can't be created on modern builds — don't design a test around them.
- The explorer's `/api/v1/tx/{txid}` 404s for transactions it hasn't indexed; don't infer
  "invalid" from a 404. On the address routes, only `{"error":"Address not found"}` means
  unused — a route-miss body is an outage.
- **There is no explorer broadcast route.** `POST /api/v1/tx/send` → 404; the `GET` 400 is
  a collision with `/tx/:txid`. Broadcast needs a node's `sendrawtransaction`.
- The public testnet forked between heights 299000 and 300000; a node must be built from
  the `v0.5.0-testnet` tag to be on the explorer's chain.
- `chrome.windows.create` produces a *tab*, so `sender.tab` alone cannot distinguish a web
  page from an extension page — match `sender.origin` against the extension origin.
- A content script that `import()`s a module registers its listeners after
  `document_start`; the MAIN-world provider does not. Do not let the provider post into a
  relay that is not listening yet.
