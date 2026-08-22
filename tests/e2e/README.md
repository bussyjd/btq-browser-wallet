# End-to-end suite

`npm run test:e2e` builds the extension and drives the built `dist/` in a real
Chromium: the service worker, the popup, the content relay and the MAIN-world
provider all run unmodified. Nothing about the extension is stubbed.

```sh
npm run playwright:install      # once: fetches the full chromium build
npm run test:e2e                # builds dist/ and runs every journey
SKIP_BUILD=1 npm run test:e2e   # reuse the current dist/ while iterating
npm run test:all                # unit + security + e2e
```

## What is real and what is mocked

| Piece | Tier 1 (default) |
|---|---|
| Extension (SW, popup, content script, provider) | **real**, loaded from `dist/` |
| Browser | **real** Chromium, persistent context, extension loaded |
| Keys, vault, signing | **real** — ML-DSA-44, PBKDF2 + AES-GCM |
| Explorer API | mock on `127.0.0.1`, shapes copied from `tests/fixtures/explorer/*.json` |
| BTQ Core node RPC | mock on `127.0.0.1/rpc`, HTTP Basic auth |
| Chain | in-memory ledger (`fixtures/ledger.ts`) |

The mock node is not a rubber stamp. For every transaction the extension
broadcasts it runs, in order, and rejects with a btq-core-style reason on the
first failure:

1. decode the raw bytes and prove they re-serialize identically;
2. every input spends an unspent ledger UTXO (`missing-inputs`);
3. the witness is `[signature, leaf, control]`, control is `0xc1`, the signature
   is 2421 bytes ending in `SIGHASH_ALL`;
4. the leaf is `OP_PUSHDATA2 <1312-byte ML-DSA key> OP_CHECKSIGDILITHIUM` and
   commits to the witness program — checked twice, once with the wallet's
   `commitsToProgram` and once with an independent TapLeaf hash;
5. the BIP341 tapscript sighash is recomputed **in the test tree** over the
   ledger's own amounts and scripts, and `ml_dsa44.verify` must accept the
   signature with an empty context;
6. every output is `OP_2 <32 bytes>` above the 270-sat dust floor, the change
   pays the wallet's own internal address, the fee clears the relay floor at
   scale-16 vsize, and the weight is under 400 000;
7. the txid is `sha256d(stripped)` reversed — the id the popup shows.

`fixtures/bip341.ts` and `fixtures/consensus.ts` never import
`src/core/tx/sighash.ts`, `src/core/script/p2mr.ts` or `src/core/tx/fee.ts`;
`smoke.spec.ts` pins them to `tests/vectors/golden.json`, which was verified
against btq-core. So a wallet that signed the wrong message would still produce
a well-formed transaction — and this suite would still catch it.

## Tier 2 — a real regtest node

```sh
BTQ_REGTEST=1 npm run test:e2e -- tests/e2e/regtest.spec.ts
```

The mock node then forwards `testmempoolaccept` / `sendrawtransaction` to a live
`btqd`, and the coins are real: the wallet's 32-byte witness program is
re-encoded under the regtest HRP (`qcrt1z…`), paid with `sendtoaddress`, and the
outpoint is adopted into the mock ledger under its `tbtq1z…` name — the
scriptPubKey is identical, so btq-core's own interpreter executes
`OP_CHECKSIGDILITHIUM` on the extension-signed bytes. The file skips cleanly
when no node answers. Connection settings match `tests/integration/rpc.ts`
(`BTQ_RPC_URL`, `BTQ_RPC_USER`, `BTQ_RPC_PASS`, `BTQ_RPC_WALLET`).

## Video

```sh
RECORD_VIDEO=1 npm run test:e2e     # demo/raw/<NN-device>/*.webm
npm run demo:video                  # the above + demo/btq-wallet-demo.mp4
```

## Files

| File | |
|---|---|
| `smoke.spec.ts` | create, receive, lock/unlock, fund, configure a node, send, restore from seed, bad imports |
| `connect.spec.ts` | site-connect approval, per-origin scope, revoke, and what a page can reach |
| `negative.spec.ts` | wrong password, refused destinations and amounts, misbehaving backends, storage contents |
| `regtest.spec.ts` | tier 2 |
| `fixtures/extension.ts` | launching the built extension, popup gestures |
| `fixtures/mock-explorer.ts` | the HTTP server: explorer API, node RPC, dapp page, `/__test/*` hooks |
| `fixtures/mock-node.ts` | the seven checks and the JSON-RPC surface |
| `fixtures/bip341.ts` | independent TapLeaf / TapSighash, from the BIP text |
| `fixtures/consensus.ts` | independent scale-16 weight, vsize, fee and dust math |
| `fixtures/tx-decode.ts` | independent serializers + txid over `src/core/tx/parse.ts` |
| `fixtures/btq-address.ts` | independent bech32m P2MR address codec |
| `fixtures/ledger.ts` | the in-memory chain, funding, mining and fault injection |
