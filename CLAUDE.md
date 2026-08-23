# BTQ Browser Wallet — project instructions

This repo is a **MetaMask-style browser extension wallet for Bitcoin Quantum (BTQ),
testnet only**. We build the wallet, not a node. Keys stay in the extension; balances
and history come from the public explorer; signing happens inside the extension and
broadcast goes through a BTQ Core node's JSON-RPC.

## Read these first, in order

1. `.claude/skills/btq-wallet/SKILL.md` — non-negotiable protocol facts, architecture,
   conventions, per-feature definition of done, known traps.
2. `docs/REFERENCE.md` — every protocol constant with its `btq-core` file:line, verified
   against a live regtest node.
3. `docs/BTQ_CORE_MAP.md` — 95 verified BTQ-vs-Bitcoin differences, each tagged
   implemented / planned / n-a for this wallet. Coverage checklist.
4. `docs/HD_IMPORT.md` — the import-from-seed design with byte-level diagrams.
5. `docs/PLAN.md` — the engineering plan: protocol facts, build order, the test plan,
   and what is deliberately not built.

Never assert a protocol constant from memory — cite `docs/REFERENCE.md` or btq-core
source. Reading that source needs a local checkout of
[btq-core](https://github.com/btq-ag/btq-core); point `$BTQ_CORE` at it and cite paths
relative to it, e.g. `$BTQ_CORE/src/consensus/consensus.h:21`:

```sh
git clone https://github.com/btq-ag/btq-core ~/src/btq-core   # once, anywhere you like
export BTQ_CORE=~/src/btq-core
```

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
- The repo ships the product and nothing else. Working notes and scratch files stay
  outside it (`.gitignore` covers `*.pdf`); anything committed is something a reader of
  the wallet is meant to read.

## Architecture

```
src/core/          pure protocol code: crypto script tx vault wallet explorer connect
                   rpc network util
src/background/    MV3 service worker: index.ts (listener) keyring dispatch
                   explorer.ts node-rpc.ts backend-store.ts chrome-storage.ts connect.ts
src/content/       isolated-world relay — allowlisted page.* only
src/inpage/        btq-provider.js — MAIN world, frozen surface, no chrome.*
src/ui/            App.tsx router · hooks/useWallet.ts (the only caller of rpc())
                   components/ (Button Card Field Header Toast TabBar AddressBlock
                   SeedGrid qr …) — SeedGrid is the only renderer of `seed-word-N`
                   and must stay so; the recording redaction keys on that prefix
                   screens/ (Welcome Onboarding CreatePassword ShowSeed ConfirmSeed
                   ImportChoice ImportMnemonic ImportRawSeed Unlock Home Settings
                   ConnectApproval)
                   screens/home/ (Receive Send Activity) · types.ts = RPC result shapes
```

The popup⇄worker RPC surface is `wallet.*`; pages reach only `page.requestAccounts`,
`page.getAccounts`, `page.disconnect` through the relay. Add a method in
`src/core/rpc/protocol.ts` + `dispatch.ts`, its result shape in `src/ui/types.ts`.

**Phrase material crosses the worker boundary on exactly two methods** — `wallet.create`
(onboarding) and `wallet.revealPhrase` (Settings → Security, on an unlocked wallet, after
the password is re-typed against the sealed vault, sharing the unlock back-off). A v2
vault seals the BIP39 entropy next to `hdSeedHex`; the words are regenerated per call,
checked to re-derive that seed, and never cached — a raw-seed or v1 vault answers
`NO_PHRASE` rather than invent any. A third such method would be a design change, not a
convenience: keep the count at two.

**Connect lifecycle.** An unapproved origin's `page.requestAccounts` is *held*: the broker
(`src/background/connect.ts`) parks `sendResponse` in a map keyed by canonical origin, each
entry timestamped, and opens a dedicated approval window at
`src/ui/index.html?connect=1&origin=…` — the origin travels in the URL so the window can
only ever speak for the site it was opened for. (`chrome.action.openPopup()` is the last
resort when no window can be created: it has no window id to close, and no e2e test can
drive it.)

`wallet.approveConnect` requires both that the broker is still holding that origin and that
it matches the sender window's own `?origin=`; anything else is `FORBIDDEN`, so the popup
cannot grant a site that is not, right now, waiting. `wallet.denyConnect` carries its origin
too, so cancelling one prompt never rejects a site the user never looked at. Approve
resolves with one address; deny, a closed window, or the 5-minute timeout rejects with
`USER_REJECTED` → EIP-1193 `4001`. A second request from the same origin joins the first;
at most three origins wait at once (`MAX_PENDING_PROMPTS`) and the fourth is rejected rather
than queued. A locked wallet answers `LOCKED` and opens nothing. Storage holds only a
timestamped mirror of what is pending — stale or unheld entries are dropped when read, and
nothing is ever granted out of it.

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
npm run demo:video           # records tests/e2e/smoke.spec.ts → demo/btq-wallet-suite.mp4
npm run demo:preflight       # will a live take work? node, explorer, funds — ~3 s, no browser
npm run demo:live            # preflight, build, record live.spec.ts, stitch → demo/btq-wallet-demo.mp4
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
happy paths. The test suite is written to that standard — negative cases (bad seed,
rejected send, page probing the extension) are the point, not the garnish.
