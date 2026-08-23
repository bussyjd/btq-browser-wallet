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

| Piece | Tier 1 (default) | Tier 3 (`npm run demo:live`) |
|---|---|---|
| Extension (SW, popup, content script, provider) | **real**, loaded from `dist/` | **real**, same `dist/` |
| Browser | **real** Chromium, persistent context, extension loaded | the same, minus the DNS blackhole |
| Keys, vault, signing | **real** — ML-DSA-44, PBKDF2 + AES-GCM | **real** |
| Explorer API | mock on `127.0.0.1`, shapes copied from `tests/fixtures/explorer/*.json` | **the public explorer** |
| BTQ Core node RPC | mock on `127.0.0.1/rpc`, HTTP Basic auth | **a real `btqd`** on the operator's machine |
| Chain | in-memory ledger (`fixtures/ledger.ts`) | **BTQ testnet — real blocks, real coins** |

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
7. the txid is `sha256d(stripped)` reversed — recomputed from the parsed
   transaction, and required to differ from the hash of the witness-carrying
   bytes, so the id the popup shows cannot move when a signature is re-encoded.
   `mock-node.spec.ts` drives that check directly, including the two states it
   must reject.

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

### Stopping the service worker on purpose

`fixtures/extension.ts` exports `restartServiceWorker`, which ends the running
worker over CDP (`ServiceWorker.stopAllWorkers`) and waits for its replacement.
It does **not** sleep for thirty seconds: that would be slow, would still be a
guess — any event resets Chrome's idle timer — and would tie the suite to a
heuristic. The proof that it worked is a marker written onto the worker's global
scope, which the next instance cannot see.

Three details are load-bearing, each learned by getting it wrong: the marker
write is awaited (a floating one can land on the *next* worker); the debugging
session is detached before anything is checked (an attached session keeps a
service worker alive, which is how DevTools stops one dying mid-inspect); and the
replacement is started by sending it a real message, because reading a marker off
a worker nobody has woken does not fail — it hangs.

## What each hostile case proves

| Case | The thing that would otherwise go unnoticed |
|---|---|
| `smoke.spec.ts` pays external index **7** before Device B restores | a wallet that only ever looks at index 0/1 restores the same balance from a two-address scan |
| `connect.spec.ts` frames another origin, then forges a `MessageEvent` with `source: window` and a foreign `origin` | the content relay's two guards (`event.source`, `event.origin`) are enforced in the *shipped* bundle, not only in source |
| `negative.spec.ts` turns on `bogusBalance` | the wallet must sum `/utxos` and ignore the explorer's `balance` field, which is negative on the live indexer |
| `negative.spec.ts` decodes each stranded hex and re-runs the node's checks | "the bytes are kept" is worth nothing unless the kept bytes are still the transaction the user approved |
| `negative.spec.ts` sets `expectChangeScript` too | change derived from the wrong chain now fails in two files, not one |
| `smoke.spec.ts` types a **wrong** password into the phrase reveal first | a refusal that rendered an empty grid would be one missing `if` from rendering a full one, so the assertion is that no `seed-word-1` exists at all |
| `smoke.spec.ts` locks the wallet with the phrase on screen | the words live in one component's state; the proof that nothing else kept a copy is that locking, and then unlocking, brings none of it back |
| `negative.spec.ts` reveals on a raw-seed wallet | a wallet with no BIP39 entropy must say so — running words back out of its HD seed would hand the user a phrase that restores a different wallet |
| `accounts.spec.ts` restores from a backup file on a device with its **own** mock backend, then reads that backend's request log before the switcher is opened | "restoring the account list asks the explorer nothing" is only checkable against a log nobody else is writing to. The assertion is not merely "the other account's first address was not queried" but that every address queried belongs to the account on screen |
| `accounts.spec.ts` scans the downloaded file for the account name, both addresses and the password | the file is the one artefact of this wallet that leaves the machine; a plaintext account label beside an address in a downloads folder is a dossier |
| `lifetime.spec.ts` kills the real service worker between "write these words down" and "type three of them back" | the failure that only a *careful* user hits. Chrome ends an idle MV3 worker after about thirty seconds, which is less than it takes to copy twelve words onto paper — and the popup goes on painting them regardless. The unit suite models the restart by discarding a `Keyring`; only this proves the popup half survives it |
| `lifetime.spec.ts` then closes the popup as well and reopens the wallet | a setup abandoned mid-phrase has to come back to the confirmation gate, on a wallet that already exists — not to a Welcome screen offering to generate a second phrase over the top of the first |

### One thing this suite asserts *is* stored in the clear

`negative.spec.ts` asserts that saving a node in Settings writes `{url, user, password}` to
`chrome.storage.local` verbatim — because it does. The RPC credential belongs to
a server the user runs; it is not sealed in the vault and is not treated as
wallet key material. The assertion states the real behaviour on purpose, so that
changing it is a decision somebody makes rather than a test quietly going green
for the wrong reason. Wallet secrets (the mnemonic, the HD seed, the password)
are asserted absent from storage in the same test, with a node configured.

The phrase reveal is held to the same standard rather than trusted. `smoke.spec.ts`
reads the words back under Settings → Security, checks they are the words the
create screen showed, and *then* re-reads all of `chrome.storage.local`: none of
the twelve words, the HD seed hex or the password is in it, and the vault is still
a few hundred bytes of ciphertext. Reading a phrase writes nothing.

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

## Tier 3 — the live recording

```sh
npm run demo:preflight   # will a take work? ~3 s, no browser
npm run demo:live        # preflight → build → record → stitch → demo/btq-wallet-demo.mp4
```

`live.spec.ts` is the same built extension with nothing mocked: the **public**
explorer, a **real** `btqd` on the operator's machine, and **real testnet coins**.
Ten captioned scenes on a 960×640 canvas — create and scan, restore Alice's funded
phrase, the receive address, point the wallet at the node, sign and broadcast a
real payment, the transaction on the public explorer, the confirmation, Bob
restoring and finding the money, the phrase read back behind the password, and a
site connected then revoked. Every number it dwells on is asserted first against
something read independently in Node, on the rule that **a live run that cannot
prove what it is showing must throw, not degrade**.

It is the only place the hermetic `--host-resolver-rules` flag is lifted
(`reach: 'live'`), and `tests/unit/demo-live.test.ts` asserts no other spec asks
for that. Without `BTQ_LIVE` set, `liveFromEnv()` returns null, `beforeAll`
returns and every test skips with a reason — `playwright.config.ts` is untouched
and CI never runs a byte of it.

### The environment

There is deliberately **no `.env.demo.example`**. This table is the contract, and
every preflight refusal names the one variable it wants, so nothing here can drift
silently. Put them in a git-ignored `./.env.demo`, which `scripts/demo-live.sh`
sources; `BTQ_LIVE=1` and `RECORD_VIDEO=1` are exported by the scripts themselves,
so a `.env.demo` never needs them.

| Variable | Default | |
|---|---|---|
| `BTQ_DEMO_RPC_PASSWORD` | **required** | the node's RPC password. No default, no fallback, and nothing ever prints it |
| `BTQ_DEMO_ALICE_MNEMONIC` | **required** | the funded wallet's phrase — Alice pays |
| `BTQ_DEMO_BOB_MNEMONIC` | **required** | the receiving wallet's phrase |
| `BTQ_DEMO_EXPLORER` | `https://explorer.bitcoinquantum.com` | |
| `BTQ_DEMO_NODE_URL` | `http://127.0.0.1:18432` | |
| `BTQ_DEMO_NODE_USER` | `btqwallet` | |
| `BTQ_DEMO_ALICE_PASSWORD` | `demo-alice-pass` | the wallet password typed on camera |
| `BTQ_DEMO_BOB_PASSWORD` | `demo-bob-pass` | |
| `BTQ_DEMO_AMOUNT` | `0.02` | tBTQ, exactly as it is typed into the form |
| `BTQ_DEMO_BOB_ADDRESS` | — | optional pin; the preflight refuses if Bob's phrase derives anything else |
| `BTQ_DEMO_REVEAL` | `1` | `0` drops scene 9, for a build without the reveal |
| `BTQ_DEMO_SCENES` | all | a cut list, e.g. `1,2,3` |
| `BTQ_DEMO_CONFIRM_TIMEOUT_MS` | `420000` | how long to wait for one block |

`npm run demo:preflight` checks the credentials, `ffmpeg`, the explorer tip, that
the node is on testnet, out of IBD, peered and on the explorer's chain, that its
`minrelaytxfee` is under the cheapest UI preset, that Bob derives, that the reveal
control exists in `src/ui` if scene 9 is on, and that **Alice actually holds a
confirmed UTXO** covering amount + fee + dust. It answers in about three seconds,
and a refusal names the shortfall and the address to top up, which is why
`demo-live.sh` runs it before the build rather than after.

### Operator notes

- **Real money, every take.** Keep Alice topped up; the preflight refuses before
  the build, not five minutes into a recording.
- 60-second blocks are nominal, not guaranteed. On a quiet testnet raise
  `BTQ_DEMO_CONFIRM_TIMEOUT_MS` to `900000` before a real take — a timeout after
  five minutes of good footage wastes the whole take.
- The public explorer is a shared dependency: five full gap scans per run, plus
  the preflight's own. Record when it is quiet, and do not loop takes back to back.
- Scene 7 asserts `balanceBefore - balanceAfter === amount + fee` **exactly**, so
  an unrelated coin landing on one of Alice's addresses mid-take fails the run.
  That is the rule above applied literally; it is the first assertion to consider
  loosening to `>=` if takes prove expensive.
- Chrome profiles under `$TMPDIR/btq-e2e-*` are never cleaned up. Remove them
  after a session.
- `set -eu` in `demo-live.sh` means a refused preflight or a failed take never
  reaches the stitcher, so a broken run cannot overwrite a good video.
- **No take has been recorded yet.** The scenes have been driven no further than
  `beforeAll`, which correctly refused. Watch the first one rather than trusting
  it — particularly the caption geometry and the explorer's `/tx/` page at
  960×640 — and delete this note once a take exists.

## Video

```sh
RECORD_VIDEO=1 npm run test:e2e     # demo/raw/<NN-device>/*.webm
npm run demo:video                  # the above, smoke only + demo/btq-wallet-suite.mp4
npm run demo:live                   # tier 3 + demo/btq-wallet-demo.mp4
```

Two recordings share this machinery and are not the same claim:
`demo/btq-wallet-suite.mp4` is this suite driving the extension against the mocks,
and `demo/btq-wallet-demo.mp4` is tier 3 against the real chain.
`scripts/stitch-demo.sh` takes the output path as its optional first argument and
still writes `demo/btq-wallet-demo.mp4` when given none.

`RECORD_VIDEO` also turns on `fixtures/redact.ts`, which covers the recovery phrase
before the first frame is painted, with a bar of one fixed width per word. Three
selectors cover four surfaces: the twelve-word grid — rendered by
`components/SeedGrid.tsx` on the onboarding screen **and** on the Settings reveal,
which is why that component must stay the only thing emitting `seed-word-N` — the
confirmation fields, and the import textarea. It changes pixels only: the DOM keeps
the real words, the assertions still run against them, and with `RECORD_VIDEO`
unset none of it runs. `createWallet`, `confirmSeed`, the two import helpers and
the reveal assertions in `smoke.spec.ts` and `live.spec.ts` fail the recording run
if a surface is left uncovered, so a renamed test id cannot quietly put a phrase
back into the video.

## Files

| File | |
|---|---|
| `smoke.spec.ts` | create, receive, lock/unlock, read the phrase back in Settings, fund, configure a node, send, restore from seed, bad imports |
| `mock-node.spec.ts` | the mock node's own txid check, on transactions built in that file — no browser |
| `connect.spec.ts` | site-connect approval, per-origin scope, revoke, cancelling one of two prompts, and what a page can reach |
| `negative.spec.ts` | wrong password, refused destinations and amounts, misbehaving backends, storage contents, a raw-seed wallet with no phrase |
| `accounts.spec.ts` | add / switch / rename an account, a lock that closes the switcher, a site grant that does not follow the user into another account, and the backup file: written from Settings and restored on a fresh device with its account list intact |
| `global-setup.ts` | builds `dist/` before the run (`SKIP_BUILD=1` to reuse it) |
| `regtest.spec.ts` | tier 2 |
| `live.spec.ts` | tier 3 — the recorded run against the real chain |
| `fixtures/extension.ts` | launching the built extension, popup gestures |
| `fixtures/mock-explorer.ts` | the HTTP server: explorer API, node RPC, dapp page, `/__test/*` hooks |
| `fixtures/dapp.html` | the demo page — served here, and the one the README tells a reader to load by hand |
| `fixtures/static-dapp.ts` | tier 3 only: serves that same page over plain HTTP, with no mock API behind it |
| `fixtures/mock-node.ts` | the seven checks and the JSON-RPC surface |
| `fixtures/bip341.ts` | independent TapLeaf / TapSighash, from the BIP text |
| `fixtures/consensus.ts` | independent scale-16 weight, vsize, fee and dust math |
| `fixtures/tx-decode.ts` | independent serializers + txid over `src/core/tx/parse.ts` |
| `fixtures/btq-address.ts` | independent bech32m P2MR address codec |
| `fixtures/golden.ts` | loads `tests/vectors/golden.json` for the specs that pin to it |
| `fixtures/ledger.ts` | the in-memory chain, funding, mining and fault injection |
| `fixtures/regtest.ts` | tier 2 only: talking to a live `btqd` |
| `fixtures/live.ts` | tier 3 only: the env contract, the preflight, and the chain reads every live assertion is checked against |
| `fixtures/scene.ts` | tier 3 only: caption overlay, pacing, and `expectNoSecret` |
| `fixtures/video.ts` | where `RECORD_VIDEO` puts each device's clips |
| `fixtures/redact.ts` | `RECORD_VIDEO` only: covers the phrase before the video sees it |
