# BTQ Browser Wallet

A browser wallet for **Bitcoin Quantum (BTQ)** — post-quantum ML-DSA-44 signatures and
P2MR (witness v2) addresses, on **testnet**. Keys are generated, encrypted and used
entirely inside the extension; balances and history come from the public explorer.

> **Status: create, import, receive, and send are implemented** for testnet. Addresses and
> signatures were proven against btq-core (Milestone 0). Fees use witness scale **16**
> (a P2MR input is **4402 WU = 275.125 vB**). The public explorer has no broadcast POST
> today — Sign still produces a 2421-byte ML-DSA witness; copy the hex to push from a node
> if the explorer returns 404.

## Why this order

The riskiest part of a BTQ wallet is not the UI — it is whether the keys, addresses and
signatures match consensus exactly. ML-DSA has no public derivation, P2MR is a witness
version Bitcoin wallets treat as anyone-can-spend, and the witness scale factor is 16
rather than 4. So the first milestone proves compatibility end-to-end against a real
node, and everything else is built on a verified foundation.

## What works today

```
src/core/crypto/          ML-DSA-44, Dilithium HD, BIP39
src/core/script/          P2MR leaf, bech32m tbtq1z…
src/core/tx/              serialize, BIP341 sighash, scale-16 fees, coinselect, builder
src/core/vault/           AES-256-GCM + PBKDF2 vault
src/core/wallet/          keyring, gap-limit restore, send
src/background/           MV3 service worker — the only place keys decrypt
src/content/ + src/inpage/  window.btq site-connect relay (no keys)
src/ui/                   create / import / unlock / receive / send / activity
```

## Load the extension

```sh
npm install
npm test            # unit + security + golden vectors (no node required)
npm run typecheck   # src (browser-only types) and tests/tooling (node) separately
npm run lint
npm run build
```

1. Open Chrome (or Chromium) at `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** and select the `dist/` directory this build just produced.
4. Pin **BTQ Wallet**. Click the icon.

**Create:** set a password → write the 12 words down (shown once) → confirm three of them.
**Import:** seed phrase *or* 64-hex-character raw seed (those are different wallets).
**Receive:** testnet address `tbtq1z…`, QR, copy. A 20-address gap scan hits
`https://explorer.bitcoinquantum.com`.
**Send:** Receive tab → Send → paste a `tbtq1z…` address and an amount in tBTQ → Review fee
→ enter the password → Sign and broadcast. Mainnet `qbtc` and legacy `tdbt` addresses are
rejected. The approval amounts come from the signed transaction, not from the explorer
balance field.

**Node / explorer:** click **Testnet** (top right) to set the explorer URL and an optional
BTQ Core JSON-RPC (`http://127.0.0.1:18332`, user, password). Test connection, then Save.
Sends then call `testmempoolaccept` + `sendrawtransaction` on that node. The public explorer
has no broadcast POST; without a node, copy the signed hex.

A page can request `window.btq.request({ method: 'btq_requestAccounts' })`. You approve
the exact origin in the popup; revoke it under Activity.

The vault is sealed before anything is written to `chrome.storage`. Wrong password yields one
error and no seed. Locking (or a service-worker restart) wipes keys from memory. See
[`SECURITY.md`](SECURITY.md).

## Run the tests

```sh
npm test            # unit tests + golden vectors + security tests (no node required)
npm run typecheck   # src (browser-only types) and tests/tooling (node) separately
npm run lint        # eslint, type-aware on src/
npm run check       # all three
```

### End to end, in a real browser

`npm run test:e2e` builds `dist/`, loads it into Chromium as an unpacked extension and
drives the real popup: create, receive, lock/unlock, fund, configure a node, send, restore
on a second device, plus site-connect and the negative paths. Nothing in the extension is
stubbed; the explorer and the BTQ Core JSON-RPC are a deterministic mock on `127.0.0.1`
whose node re-derives the BIP341 sighash and verifies the ML-DSA-44 signature itself. No
BTQ node and no network access required.

```sh
npm run playwright:install   # once: downloads the Chromium Playwright drives
npm run test:e2e             # the whole suite (builds dist/ first; ~30 s)
npm run test:all             # npm test, then the end-to-end suite
```

[`tests/e2e/README.md`](tests/e2e/README.md) explains what each journey proves, what is
mocked, and how to run the opt-in tier 2 against a live regtest `btqd` (`BTQ_REGTEST=1`).

### Video

[`demo/btq-wallet-demo.mp4`](demo/btq-wallet-demo.mp4) is a recording of that suite — the
popup, driven by the tests, with nothing staged. Regenerate it with `npm run demo:video`
(`RECORD_VIDEO=1 playwright test tests/e2e/smoke.spec.ts`, then `scripts/stitch-demo.sh`
concatenates the clips; needs `ffmpeg`).

### Cross-check against a real btq-core node

The integration tests prove compatibility with consensus. They skip unless a node is
running, so `npm test` stays green anywhere.

```sh
# 1. start a regtest node (path to your btq-core build)
mkdir -p /tmp/btq-m0-regtest
cat > /tmp/btq-m0-regtest/btq.conf <<'EOF'
regtest=1
server=1
fallbackfee=0.0002
[regtest]
rpcuser=m0
rpcpassword=m0pass
rpcport=18999
EOF
/path/to/btq-core/src/btqd -datadir=/tmp/btq-m0-regtest -daemon

# 2. create a wallet for the tests to fund from
/path/to/btq-core/src/btq-cli -datadir=/tmp/btq-m0-regtest -rpcport=18999 \
  -rpcuser=m0 -rpcpassword=m0pass createwallet m0d

# 3. run them
BTQ_REGTEST=1 npx vitest run tests/integration
```

What those tests prove:

| Test | Proves |
|---|---|
| `address-compat` | the node echoes our address, `scriptPubKey` and `merkle_root` byte-for-byte, and classifies the address as `isdilithium`, witness v2 |
| `spend-accepted` | `testmempoolaccept` accepts a transaction we signed — the real interpreter ran `OP_CHECKSIGDILITHIUM` — and rejects one signed over a tampered digest |
| `vectors` | derivation, scripts and addresses have not drifted since that cross-check |

## Protocol notes worth knowing

- **Addresses** are bech32m witness v2: `tbtq1z…` on testnet. The witness program *is* a
  TapLeaf merkle root; there is no key path, so every spend reveals
  `<1312-byte pubkey> OP_CHECKSIGDILITHIUM` plus a `0xc1` control block.
- **Signatures** are exactly 2421 bytes (2420 + a mandatory `SIGHASH_ALL` byte); BTQ
  rejects `SIGHASH_DEFAULT`.
- **Fees** use witness scale factor **16**, so one input costs 4402 WU ≈ 275 vB.
- **Derivation** is hardened-only over the 32-byte ML-DSA seed — `m/0'/0'/n'` external,
  `m/0'/1'/n'` internal. There is no xpub and no watch-only derivation.

Full detail, with every constant's `btq-core` source line, is in
[`docs/REFERENCE.md`](docs/REFERENCE.md).

### A note on "import an existing HD wallet"

BTQ does not currently publish an interoperable HD standard. btq-core's Dilithium HD
path exists only in **legacy BDB wallets**, which modern builds cannot create, and
descriptor wallets generate Dilithium keys outside the descriptor system (so they have no
descriptor backup). This wallet therefore implements btq-core's scheme faithfully and
seeds it from a **BIP39 mnemonic**, documenting that mapping as its standard — while also
accepting a **raw 32-byte HD seed** so a btq-core wallet can be imported. The full
design, with the byte-level pipeline drawn out, is in
[`docs/HD_IMPORT.md`](docs/HD_IMPORT.md); see also `docs/REFERENCE.md §5`.

## Security model

Key material is decrypted **only** inside the MV3 service worker and only while the
wallet is unlocked. Content scripts and injected page providers relay messages over a
narrow allowlisted API and never receive key material. The `core/` layer is
browser-safe and dependency-light (`@noble/*`, `@scure/*`) so it stays reviewable.

`SECURITY.md` (with the threat model and what is deliberately out of scope) lands with
the extension packaging.

## Layout

```
src/core/          pure protocol code — no I/O, no Buffer, fully unit-tested
src/background/    MV3 service worker (vault I/O, explorer, RPC)
src/ui/            popup
tests/unit/        crypto, derivation, script, address, golden vectors
tests/security/    secret leakage, locked-wallet, bad seed, page RPC
tests/integration/ cross-checks against a live btq-core node (opt-in)
tests/e2e/         the built extension in Chromium: journeys, connect, negatives
tests/vectors/     golden.json — the frozen contract with consensus
scripts/           gen-vectors.ts · stitch-demo.sh
demo/              btq-wallet-demo.mp4, recorded by npm run demo:video
docs/              REFERENCE.md · BTQ_CORE_MAP.md · HD_IMPORT.md · PLAN.md
.claude/           skill + security-reviewer agent used to build this
```
