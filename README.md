# BTQ Browser Wallet

A browser wallet for **Bitcoin Quantum (BTQ)** — post-quantum ML-DSA-44 signatures and
P2MR (witness v2) addresses, on **testnet**. Keys are generated, encrypted and used
entirely inside the extension; balances and history come from the public explorer.

> **Status: Milestone 0 complete.** The cryptographic core is built and *proven against
> btq-core itself*: addresses this wallet derives are byte-identical to the node's, and a
> transaction signed here is accepted by the node's real consensus interpreter. UI and
> extension packaging are next.

## Why this order

The riskiest part of a BTQ wallet is not the UI — it is whether the keys, addresses and
signatures match consensus exactly. ML-DSA has no public derivation, P2MR is a witness
version Bitcoin wallets treat as anyone-can-spend, and the witness scale factor is 16
rather than 4. So the first milestone proves compatibility end-to-end against a real
node, and everything else is built on a verified foundation.

## What works today

```
src/core/crypto/mldsa.ts    ML-DSA-44 keygen / sign / verify  (2421-byte witness signatures)
src/core/crypto/hd.ts       btq-core's hardened-only HD derivation over the ML-DSA seed
src/core/script/p2mr.ts     leaf script, TapLeaf hash, scriptPubKey, commitment check
src/core/script/address.ts  bech32m witness-v2 encode/decode with strict network binding
src/core/tx/serialize.ts    transaction serialization (stripped + witness)
src/core/tx/sighash.ts      BIP341 tapscript sighash, as BTQ reuses it unchanged
```

## Run the tests

```sh
npm install
npm test            # unit tests + golden vectors (no node required)
npm run typecheck
```

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
accepting a **raw 32-byte HD seed** so a btq-core wallet can be imported. See
`docs/REFERENCE.md §5`.

## Security model

Key material is decrypted **only** inside the MV3 service worker and only while the
wallet is unlocked. Content scripts and injected page providers relay messages over a
narrow allowlisted API and never receive key material. The `core/` layer is
browser-safe and dependency-light (`@noble/*`, `@scure/*`) so it stays reviewable.

`SECURITY.md` (with the threat model and what is deliberately out of scope) lands with
the extension packaging.

## Layout

```
src/core/       pure protocol code — no I/O, no Buffer, fully unit-tested
tests/unit/     crypto, derivation, script, address, golden vectors
tests/integration/  cross-checks against a live btq-core node (opt-in)
tests/vectors/  golden.json — the frozen contract with consensus
scripts/        gen-vectors.ts
docs/           REFERENCE.md — the protocol, with source anchors
.claude/        skill + security-reviewer agent used to build this
```
