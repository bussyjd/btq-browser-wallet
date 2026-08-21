# BTQ Browser Wallet — project instructions

This repo is a take-home: a **MetaMask-style browser extension wallet for Bitcoin
Quantum (BTQ), testnet only**. We build the wallet, not a node. Keys stay in the
extension; balances/history come from the public explorer; signing and broadcast happen
inside the extension.

## Read these first, in order

1. `.claude/skills/btq-wallet/SKILL.md` — the rubric (138 pts), non-negotiable protocol
   facts, architecture, conventions, per-feature definition of done, known traps.
2. `docs/REFERENCE.md` — every protocol constant with its `btq-core` file:line, verified
   against a live regtest node (Milestone 0).
3. `docs/BTQ_CORE_MAP.md` — 95 verified BTQ-vs-Bitcoin differences, each tagged
   implemented / planned / n-a for this wallet. Coverage checklist.
4. `docs/HD_IMPORT.md` — the import-from-seed design with byte-level diagrams.
5. `docs/PLAN.md` — milestones M0–M6 and the test plan.

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
18332 (regtest 18443). The public testnet forked at height ~303676 during earlier work —
if balances look wrong, check which chain a node is on before blaming the wallet.

## Hard rules

- **Keys decrypt only in the MV3 service worker**, only while unlocked. Content scripts
  and pages never see key material. Any change that moves secrets outward is a bug.
- `src/core/` stays pure and browser-safe: no `Buffer`, no `node:` imports, no I/O.
- **Signatures are 2421 bytes** (2420 ML-DSA-44 + mandatory `0x01`); sign
  deterministically with an **empty context**; the noble `.d.ts` is stale — use the shim
  in `src/core/crypto/mldsa.ts`, never call `ml_dsa44` directly elsewhere.
- **Fees at witness scale 16** (input = 4402 WU = 275.125 vB), never scale 4.
- **Never sign a leaf script you did not build** without `commitsToProgram()`.
- `tests/vectors/golden.json` is the contract with consensus. Never regenerate it to make
  a test pass; regenerate only via `npx tsx scripts/gen-vectors.ts` with a fresh
  `BTQ_REGTEST=1` cross-check green.
- The take-home PDF is gitignored — keep it and any grading material out of the repo.

## Commands

```sh
npm test                                   # unit + security + golden vectors (no node needed)
npm run typecheck
npm run build                              # MV3 extension → dist/
BTQ_REGTEST=1 npx vitest run tests/integration   # cross-check vs regtest node (see README)
npx tsx scripts/gen-vectors.ts             # regenerate vectors (rule above applies)
```

## Review discipline

After any change to key handling, signing, or the send path, run the
**wallet-security-reviewer** agent (`.claude/agents/wallet-security-reviewer.md`). It
reviews like a security operations team: paths that leak secrets or move funds, not
happy paths. The graded test suite is written to that standard — negative cases
(bad seed, rejected send, page probing the extension) are the point, not the garnish.
