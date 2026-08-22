# BTQ Browser Wallet — project instructions

This repo is a take-home: a **MetaMask-style browser extension wallet for Bitcoin
Quantum (BTQ), testnet only**. We build the wallet, not a node. Keys stay in the
extension; balances and history come from the public explorer; signing happens inside
the extension and broadcast goes through a BTQ Core node's JSON-RPC.

## Read these first, in order

1. `.claude/skills/btq-wallet/SKILL.md` — non-negotiable protocol facts, architecture,
   conventions, per-feature definition of done, known traps.
2. `docs/REFERENCE.md` — every protocol constant with its `btq-core` file:line, verified
   against a live regtest node (Milestone 0).
3. `docs/BTQ_CORE_MAP.md` — 95 verified BTQ-vs-Bitcoin differences, each tagged
   implemented / planned / n-a for this wallet. Coverage checklist.
4. `docs/HD_IMPORT.md` — the import-from-seed design with byte-level diagrams.
5. `docs/PLAN.md` — milestones M0–M6 and the test plan, with what landed.

Never assert a protocol constant from memory — cite `docs/REFERENCE.md` or btq-core
source. The local btq-core checkout is at `/Users/bussyjd/Development/btq-core`.

## BTQ resources

| What | Where |
|---|---|
| Website | https://bitcoinquantum.com/ |
| Technical guides | https://bitcoinquantum.com/guides |
| X / Twitter | https://x.com/btc_quantum |
| GitHub (node) | https://github.com/btq-ag/btq-core |
| Docs | https://docs.bitcoinquantum.com/ (wallet basics: /wallet/basics) |
| **Explorer (our backend)** | https://explorer.bitcoinquantum.com/ — REST under `/api/v1/…`, see `docs/REFERENCE.md §6` |
| Mining pool | https://pool.bitcoinquantum.com/ |

Testnet facts: addresses `tbtq1z…` (bech32m, witness v2); 60-second blocks; RPC port
18332 (regtest 18443). The explorer's chain **diverged from the older testnet between
heights 299000 and 300000**, and upstream tagged `v0.5.0-testnet` for it ("consensus
change is not a 0.4.x patch"). A node built from an older tag will sit on the dead fork
with 0 peers — if balances look wrong, check which chain the node is on before blaming
the wallet.

## Hard rules

- **Keys decrypt only in the MV3 service worker**, only while unlocked. Content scripts
  and pages never see key material. Any change that moves secrets outward is a bug.
- `src/core/` stays pure and browser-safe: no `Buffer`, no `node:` imports, no `chrome.*`,
  no `fetch`. `tests/security/source-boundary.test.ts` enforces this.
- **Signatures are 2421 bytes** (2420 ML-DSA-44 + mandatory `0x01`); sign
  deterministically with an **empty context**; the noble `.d.ts` is stale — use the shim
  in `src/core/crypto/mldsa.ts`, never call `ml_dsa44` directly elsewhere.
- **Fees at witness scale 16** (input = 4402 WU = 275.125 vB), never scale 4. Dust for a
  P2MR output is **270 sats** — the node's own threshold; do not invent a stricter one.
- **Never sign a leaf script you did not build** without `commitsToProgram()`.
- Balance is the sum of `/utxos`. The explorer's `balance` field goes negative on busy
  addresses and is display-only. A failed lookup is an error, never "0".
- `tests/vectors/golden.json` is the contract with consensus. Never regenerate it to make
  a test pass; regenerate only via `npx tsx scripts/gen-vectors.ts` with a fresh
  `BTQ_REGTEST=1` cross-check green.
- The take-home PDF is gitignored — keep it and any grading material out of the repo.

## Architecture

```
src/core/          pure protocol code: crypto script tx vault wallet explorer rpc network
src/background/    MV3 service worker: index.ts (listener) keyring dispatch
                   explorer.ts node-rpc.ts backend-store.ts chrome-storage.ts connect.ts
src/content/       isolated-world relay — allowlisted page.* only
src/inpage/        btq-provider.js — MAIN world, frozen surface, no chrome.*
src/ui/            App.tsx router · hooks/useWallet.ts (the only caller of rpc())
                   components/ (Button Card Field Header Toast TabBar AddressBlock qr …)
                   screens/ (Welcome CreatePassword ShowSeed ConfirmSeed ImportChoice
                   ImportMnemonic ImportRawSeed Unlock Home Settings ConnectApproval)
                   screens/home/ (Receive Send Activity) · types.ts = RPC result shapes
```

The popup⇄worker RPC surface is `wallet.*`; pages reach only `page.requestAccounts`,
`page.getAccounts`, `page.disconnect` through the relay. Add a method in
`src/core/rpc/protocol.ts` + `dispatch.ts`, its result shape in `src/ui/types.ts`.

**Connect lifecycle.** An unapproved origin's `page.requestAccounts` is *held*: the broker
(`src/background/connect.ts`) parks `sendResponse`, stores the pending origin, and opens
the approval UI (`chrome.action.openPopup()`, else `chrome.windows.create(…?connect=1)`).
`wallet.approveConnect` resolves it with one address; deny, a closed window, or a
5-minute timeout rejects with `USER_REJECTED` → EIP-1193 `4001`. One pending request per
origin. A locked wallet answers `LOCKED` and opens nothing.

## Commands

```sh
npm test                     # unit + security + golden vectors (no node, no network)
npm run typecheck            # src (browser types) and tests/tooling (node types)
npm run lint                 # eslint, type-aware on src/
npm run check                # typecheck + lint + test
npm run build                # MV3 extension → dist/
npm run playwright:install   # once, before the first e2e run
npm run test:e2e             # builds dist/, drives it in real Chromium (SKIP_BUILD=1 to reuse)
npm run test:all             # npm test, then the e2e suite
npm run demo:video           # records tests/e2e/smoke.spec.ts → demo/btq-wallet-demo.mp4
BTQ_REGTEST=1 npx vitest run tests/integration   # cross-check vs a regtest node (see README)
npx tsx scripts/gen-vectors.ts                   # regenerate vectors (rule above applies)
```

## Test fixtures

- `tests/fixtures/explorer/*.json` — bodies recorded from the live explorer (used address,
  never-seen address, negative balance, utxos, txs paging, tx, tip, mempool). Driven
  through the real parsers by `tests/unit/explorer-fixtures.test.ts`.
- `tests/helpers/` — `fake-chrome.ts` (runtime/storage/alarms/windows), `fake-fetch.ts`,
  `memory-store.ts`.
- `tests/e2e/fixtures/` — the launcher, a mock explorer + JSON-RPC node on `127.0.0.1`,
  an in-memory ledger with fault injection, and **independent** implementations
  (`bip341.ts`, `consensus.ts`, `tx-decode.ts`, `btq-address.ts`) that must never import
  `src/core`'s sighash, script or fee code. They are pinned to `golden.json`.

## Review discipline

After any change to key handling, signing, or the send path, run the
**wallet-security-reviewer** agent (`.claude/agents/wallet-security-reviewer.md`). It
reviews like a security operations team: paths that leak secrets or move funds, not
happy paths. The graded test suite is written to that standard — negative cases
(bad seed, rejected send, page probing the extension) are the point, not the garnish.
