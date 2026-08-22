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

### Which layer the golden pin reaches

The pin starts at `entry.keySeed`: from a golden key seed the test builds the
leaf, hashes it and compares with `entry.tapLeafHash`, and round-trips
`entry.scriptPubKey` against `entry.addresses.testnet` in both directions. The
independent sighash is pinned to the digest `tests/unit/sighash.test.ts` freezes
for the wallet's own implementation, over a spend built from golden scripts.

**The BIP32-style HD layer above that is not pinned here.** Every expected
address in `tests/e2e/**` is derived with the extension's own
`addressFromHdSeed` / `mnemonicToHdSeed`, so a change to the derivation path
would move the test and the wallet together. `tests/vectors/golden.json` has a
16-byte `hdSeedHex` and the raw-seed importer requires 32, so it cannot be
imported to close the loop end to end (`smoke.spec.ts` asserts that refusal
instead). `tests/unit/vectors.test.ts` is what pins derivation to the vectors.

## What each hostile case proves

| Case | The thing that would otherwise go unnoticed |
|---|---|
| `smoke.spec.ts` 8 pays external index **7** before Device B restores | a wallet that only ever looks at index 0/1 restores the same balance from a two-address scan |
| `connect.spec.ts` 11b frames another origin, then forges a `MessageEvent` with `source: window` and a foreign `origin` | the content relay's two guards (`event.source`, `event.origin`) are enforced in the *shipped* bundle, not only in source |
| `negative.spec.ts` N4 turns on `bogusBalance` | the wallet must sum `/utxos` and ignore the explorer's `balance` field, which is negative on the live indexer |
| `negative.spec.ts` N5 decodes each stranded hex and re-runs the node's checks | "the bytes are kept" is worth nothing unless the kept bytes are still the transaction the user approved |
| `negative.spec.ts` sets `expectChangeScript` too | change derived from the wrong chain now fails in two files, not one |

### One thing this suite asserts *is* stored in the clear

`N5` asserts that saving a node in Settings writes `{url, user, password}` to
`chrome.storage.local` verbatim — because it does. The RPC credential belongs to
a server the user runs; it is not sealed in the vault and is not treated as
wallet key material. The assertion states the real behaviour on purpose, so that
changing it is a decision somebody makes rather than a test quietly going green
for the wrong reason. Wallet secrets (the mnemonic, the HD seed, the password)
are asserted absent from storage in the same test, with a node configured.

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
| `global-setup.ts` | builds `dist/` before the run (`SKIP_BUILD=1` to reuse it) |
| `regtest.spec.ts` | tier 2 |
| `fixtures/extension.ts` | launching the built extension, popup gestures |
| `fixtures/mock-explorer.ts` | the HTTP server: explorer API, node RPC, dapp page, `/__test/*` hooks |
| `fixtures/mock-node.ts` | the seven checks and the JSON-RPC surface |
| `fixtures/bip341.ts` | independent TapLeaf / TapSighash, from the BIP text |
| `fixtures/consensus.ts` | independent scale-16 weight, vsize, fee and dust math |
| `fixtures/tx-decode.ts` | independent serializers + txid over `src/core/tx/parse.ts` |
| `fixtures/btq-address.ts` | independent bech32m P2MR address codec |
| `fixtures/ledger.ts` | the in-memory chain, funding, mining and fault injection |
