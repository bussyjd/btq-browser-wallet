# BTQ Browser Wallet

A Chrome (MV3) extension wallet for **Bitcoin Quantum testnet** — post-quantum ML-DSA-44
keys, P2MR (witness v2) addresses, `tbtq1z…`. The seed is generated, sealed and used only
inside the extension's service worker; balances and history come from the public explorer,
and every transaction is built and signed locally before anything touches the network.

> **Unofficial, unaudited, testnet only.** An independent project, not affiliated with or
> endorsed by Bitcoin Quantum. It has had no third-party security audit.
> Use it with testnet keys and testnet coins only — never a mainnet seed, never real funds.

Five-minute path: [load the extension](#load-the-extension) → [try the flows](#try-the-flows)
→ [run the tests](#run-the-tests). If you only read one caveat, read
[Broadcast: the truth](#broadcast-the-truth).

## Screenshots

| | |
|---|---|
| <img src="docs/screenshots/create-seed.png" alt="The recovery-phrase screen: twelve numbered slots, blanked for this screenshot, under a warning to write the words down on paper and a note that Settings can show the phrase again with the password" width="330"> | <img src="docs/screenshots/receive.png" alt="Receive tab: balance with the height it was checked at, then the tbtq1z address, its derivation path, a Copy address button, and a Show QR code control" width="330"> |
| **Create** — the vault is already sealed here; write the phrase down, and read it again in Settings if you are interrupted. | **Receive** — next unused address, its path, copy; the QR opens on request. |
| <img src="docs/screenshots/send-review.png" alt="Send review card: destination, amount, fee in tBTQ and sat/vB, change, inputs, total debited, password field" width="330"> | <img src="docs/screenshots/connect.png" alt="Connection request screen naming the site origin, the single account it will see, and what it will never see" width="330"> |
| **Send** — the review card replaces the form, so what you read is what gets signed. | **Site-connect** — exact origin, one account only, revocable, and it can never move funds. |

Dark theme shown; the popup follows the OS light/dark setting. The twelve words in the
first shot are covered before the capture — one bar of one fixed width per word, the same
way the demo recording covers them, so neither the words nor their lengths survive. A
wallet's own README is no place for a legible recovery phrase.

## Load the extension

Requires **Node 20.19+ (or 22.12+)** — Vite 7 and the Playwright runner both need it.

```sh
npm ci
npm run build      # → dist/
```

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select the `dist/` directory this build just produced.
4. Pin **BTQ Wallet** and click the icon.

Chrome 116 or newer (the provider is injected into the MAIN world, which is Chrome 111+).

## Try the flows

**Create.** **Create a wallet** → set a password (≥8 characters) → the 12 words appear →
**I wrote it down** → type three of them back → **Confirm the phrase**. The vault is
sealed at the *first* step, with the password you just chose: one AES-256-GCM blob behind
PBKDF2-SHA256 (600 000 iterations), holding the HD seed and the BIP39 entropy it came
from. The entropy is what lets **Settings → Security** show the phrase again later, with
your password; the words themselves are never stored, in the clear or otherwise.

Sealing first is deliberate, and it is why the phrase screen can be read at human speed.
Chrome shuts an extension's background worker down after roughly thirty seconds of
quiet — and writing twelve words on paper takes longer than that — so a wallet held in
memory until the confirmation came back was a wallet the careful user never got. What
the confirmation does now is prove you have your copy of the phrase, over a wallet that
already exists. Walk away from it and nothing is lost: the wallet is yours, and the
words are waiting under **Settings → Security**.

**Import — three forms.** **I already have a seed** offers **Use a seed phrase**, **Use a
backup file** and **Use a raw seed**:

- a **BIP39 phrase** (12 or 24 words, checksum validated) — the same mapping this wallet
  uses when it creates one;
- a **wallet backup file** (`.btqbackup`) plus the password that sealed it — the only one
  of the three that restores the account list, and the only one that reaches no network;
- a **raw 32-byte HD seed** (64 hex characters) — btq-core's `sethdseed` shape.

A phrase and a raw seed are different wallets from different inputs, not two spellings of
one, and both restore Account 1 alone. See
[`docs/HD_IMPORT.md`](docs/HD_IMPORT.md) for why BTQ has no published HD standard and what
this wallet does about it.

**Accounts.** The header name opens an account switcher. **Add account** derives the next
HD account from the same seed (`m/1'/…`, `m/2'/…`); Account 1 stays on Core's path
`m/0'/…`. Receive, send, history and `window.btq` follow whichever account is active.

Two things about extra accounts are said in the switcher itself, because they can cost
you coins:

- **btq-core cannot derive them.** It hardcodes the account level to `0'`
  (`scriptpubkeyman.cpp:1252`), so the seed that restores this wallet in Core restores
  Account 1 and nothing else. Accounts above the first are this wallet's own convention.
- **A phrase carries keys, not a list.** Twelve words are an encoding of entropy: they say
  what the master secret is and nothing about what you did with it, so a phrase restores
  **Account 1** and no more. Either keep a backup file (below), or press **Add account**
  the same number of times, in order — the same seed re-derives the same addresses, so the
  coins reappear, but you have to know how many there were. This wallet will not ask a
  public explorer to guess.

**Wallet backup file.** Settings → **Wallet backup file** → your password → a
`btq-wallet-backup-YYYY-MM-DD.btqbackup` download. It is the same envelope as the vault on
disk — `BTQ1`, PBKDF2-SHA256 at 600 000 iterations, AES-256-GCM — sealing the seed *and*
the account list, so **Import → Use a backup file** brings your accounts back with the
names you gave them, and asks the explorer nothing at all to do it. This is the model
Sparrow and Electrum have used for years: the phrase is the key material, a wallet file is
everything else.

The file is a new thing in the world, and the screen says so before it exists. Anyone who
has it *and* your password has your wallet — every key in it, and your account names with
them. Without the password it is sealed: the plaintext is padded to a fixed length, so
every backup this build writes is the same size and the file does not say how many accounts
are in it, and the default name carries no address, no account name and no balance. It
still says that a BTQ wallet exists. Keep it where you keep your recovery phrase, and save
it again after you add or rename an account — a file holds the list you had at the moment
you pressed the button.

The wallet also keeps its refresh narrow. A refresh scans the account on screen — one
20-address gap window per chain — and the other accounts are brought up to date when you
open the switcher or press **Rescan all addresses**; each row there shows how old its
balance is rather than presenting a stale number as current. On a four-account wallet
with nothing to find, that took an idle refresh from 168 explorer requests to 42.
Speculative account probing was removed outright: it could not find an account that had
never been paid, and the price of trying was handing a public explorer a batch of
addresses with no on-chain relationship to each other — which links them in that
explorer's logs before any of them is used, and shows how far along each chain the wallet
is. (It never exposed a public key: P2MR commits to a Merkle root, so the ML-DSA key
stays hashed until the output is spent.) See [`docs/HD_IMPORT.md`](docs/HD_IMPORT.md).

**A site connection is per account.** Approving a site approves it for the account that
is active at that moment. Switch to another account and the site is told
`accountsChanged([])` and sees nothing there until you approve it on that account too —
which goes through the same approval window. Settings → Connected sites lists one row
per site *and account*, and **Revoke** takes back that row alone; the page's own
**Disconnect** drops every account it was approved for.

**Receive.** The *Receive* tab shows the next unused external address (`tbtq1z…`), its
derivation path, a QR of exactly that string, and **Copy address**. Balance is the sum
of the **unspent outputs** of every derived address — not the explorer's `balance` field,
which goes negative on busy addresses. A restore runs a 20-address gap scan on both
chains, so a wallet funded at index 7 comes back with its coins.

**Send.** The *Send* tab → paste a `tbtq1z…` address, enter an amount in tBTQ (or press
**Max**), pick a fee (Economy 1 / Normal 2 / Priority 5 sat/vB) → **Review**. The review card
replaces the form and restates destination, amount, fee (tBTQ, sat/vB and vB), change,
input count and total debited. Enter the password → **Sign and broadcast**. Mainnet
`qbtc…`, legacy base58 Dilithium (`n…`) and anything that fails its checksum are refused
with a reason before signing, as are amounts below the 270-sat dust floor. The numbers in
the result are decoded back out of the signed bytes, not carried over from the form.

**Site-connect.** The demo page is
[`tests/e2e/fixtures/dapp.html`](tests/e2e/fixtures/dapp.html) — the same page the
end-to-end suite drives, so the page you try by hand is the page CI proves. Serve it over
HTTP (content scripts do not run on `file://`):

```sh
python3 -m http.server 8080 -d tests/e2e/fixtures   # → http://localhost:8080/dapp.html
```

**Connect wallet** calls `window.btq.request({ method: 'btq_requestAccounts' })`. The
extension opens an approval window naming the exact origin; the page's promise stays
unsettled until you answer. **Connect** hands it one address; **Cancel**, closing that
window, or five minutes of silence gets it `USER_REJECTED` (EIP-1193 code `4001`). A
waiting request lives in the background worker and cannot outlive it: if Chrome recycles
the worker while an approval window is open, the page is told the wallet is unreachable
and the window says the request is gone — never a Connect button over a site that is no
longer asking.
**Disconnect** — or Settings → Connected sites → **Revoke** — takes it back and fires
`accountsChanged([])`. The grant it hands out is for one account: the one that was
active when you clicked **Connect**. A page can never call `wallet.*`: send, unlock and the phrase
reveal are not on the relay's allowlist, which forwards `page.requestAccounts`,
`page.getAccounts` and `page.disconnect` and nothing else.

**Settings** (the sliders icon in the header). Explorer URL, an optional BTQ Core JSON-RPC
(URL, user, password), **Test connection** — which reports the explorer tip and the node's
chain and height, warns when the node is behind, and refuses one whose block hash at the
explorer's tip disagrees — **Connected sites** with **Revoke**, **Rescan all addresses**,
a **Security** card, **Wallet backup file**, and **Remove wallet from this device**, which
only proceeds once you type DELETE.

**Security → Show recovery phrase.** The words are readable again on an unlocked wallet,
behind a second deliberate step: the button, then a warning, then your password, then
**Show phrase**. A wrong password shares the unlock back-off; **Hide phrase** and **Lock
now** both take the grid off the screen. There is no copy button, and there never will be
— a phrase on the clipboard is readable by everything else on the machine and outlives
the screen that showed it. A wallet imported from a raw 32-byte seed has no phrase to
show, says so instead of inventing one, and is offered that seed hex instead — one control
or the other, and never a disabled one. This is not the wallet giving anything away that
the password did not already open ([`SECURITY.md`](SECURITY.md) argues the trade in full).

## Broadcast: the truth

**The public explorer has no broadcast route.** `POST /api/v1/tx/send` answers
`404 Route POST:/api/v1/tx/send not found`; a `GET` returns 400 only because it collides
with `/api/v1/tx/:txid`, and the api-docs page lists no push path. Anyone who tells you
otherwise (including earlier drafts of these docs) probed the GET and stopped there.

So broadcasting goes through a node's JSON-RPC — `testmempoolaccept` then
`sendrawtransaction` — configured under Settings. Two things matter:

- Build it from the **`v0.5.0-testnet`** tag. The explorer's chain diverged from the older
  testnet between heights 299000 and 300000; a node on the old fork will happily accept
  your transaction into a chain nobody is watching.
- Check it is on the same chain: compare `getblockchaininfo.blocks` with
  `https://explorer.bitcoinquantum.com/api/v1/blocks/tip`. **Test connection** does this
  for you and refuses a node whose block hash at the explorer's tip height disagrees.

Without a node the wallet still **signs**, and says so. The transaction is signed *before*
any network call, so a broadcast failure never costs you the bytes: the result card shows
the node's rejection reason verbatim, keeps the bytes behind **Copy signed hex**, and the
Activity row is marked **Not broadcast** so it is never mistaken for money in flight. Push
the hex yourself with `btq-cli sendrawtransaction <hex>` whenever you have a node.

## Run the tests

```sh
npm test            # 572 tests: unit, security, golden vectors — no node, no network
                    # (6 of them skip unless a regtest node is running — see below)
npm run typecheck   # src (browser-only types) and tests/tooling (node types) separately
npm run lint
npm run check       # all three
```

End to end, in a real browser:

```sh
npm run playwright:install   # once: fetches the Chromium build Playwright drives
npm run test:e2e             # builds dist/, loads it in Chromium: 35 tests, plus the
                             # regtest tier and the live-recording tier, which skip
                             # unless a node — or an operator — turns them on
npm run test:all             # the above, after npm test
SKIP_BUILD=1 npm run test:e2e    # reuse the current dist/ while iterating
```

Nothing in the extension is stubbed there: the real service worker, the real popup, the
real content relay and the real MAIN-world provider run from `dist/`. The explorer and the
BTQ Core JSON-RPC are a deterministic mock on `127.0.0.1` whose node re-derives the BIP341
sighash and verifies the ML-DSA-44 signature itself, so a wallet that signed the wrong
message would still fail. Chromium is launched with DNS blackholed except loopback, so a
stray call to the live explorer fails instead of making the run non-deterministic — the
live-recording tier below is the only thing that lifts that flag, and a unit test asserts
no other spec asks for it.

Two opt-in tiers need a real `btqd` and are gated on `BTQ_REGTEST=1`:

```sh
BTQ_REGTEST=1 npx vitest run tests/integration                 # consensus cross-check
BTQ_REGTEST=1 npm run test:e2e -- tests/e2e/regtest.spec.ts    # the same, through the UI
```

Without the variable the Vitest tier is skipped and the Playwright tier skips itself. With
it set and no node listening they *fail* rather than skip — deliberately, since an opt-in
cross-check that silently passes is worthless. Connection settings come from
`BTQ_RPC_URL`, `BTQ_RPC_USER`, `BTQ_RPC_PASS`, `BTQ_RPC_WALLET`, defaulting to the node
below (`tests/integration/rpc.ts`):

```sh
mkdir -p /tmp/btq-m0-regtest
cat > /tmp/btq-m0-regtest/btq.conf <<'CONF'
regtest=1
server=1
fallbackfee=0.0002
[regtest]
rpcuser=m0
rpcpassword=m0pass
rpcport=18999
CONF
/path/to/btq-core/src/btqd -datadir=/tmp/btq-m0-regtest -daemon
/path/to/btq-core/src/btq-cli -datadir=/tmp/btq-m0-regtest -rpcport=18999 \
  -rpcuser=m0 -rpcpassword=m0pass createwallet m0d
```

A third opt-in tier, [`tests/e2e/live.spec.ts`](tests/e2e/live.spec.ts), is not a test of
the wallet so much as a recording of it: it drives the built extension against the public
explorer and a real testnet node, spending real testnet coins, and is gated on `BTQ_LIVE=1`
plus the operator credentials described under [Video](#video). Unset, it skips with a
reason and CI never notices it.

### What each layer proves

| Layer | Runs | Proves |
|---|---|---|
| `tests/unit/` | always | Derivation, P2MR scripts, bech32m, BIP341 sighash (a frozen digest plus nine mutations), scale-16 weight/vsize/fee/dust, the explorer parsers against recorded live bodies, and a real on-chain transaction rebuilt byte-for-byte |
| `tests/vectors/` | always | `golden.json`, the frozen contract with consensus — addresses, scripts and tapleaf hashes cannot drift unnoticed |
| `tests/security/` | always | The paths that leak secrets or move funds: the vault ciphertext holds no seed, no entropy and no words, a wrong password (with back-off) opens nothing, a locked wallet cannot sign, derive or show a phrase, the phrase reveal needs the password and shares that back-off in both directions, a raw-seed wallet refuses instead of inventing words, a vault from the pre-2 build is refused by name rather than as corruption, the backup file is sealed under the same door as the reveals and carries no address, name or key in the clear while a hostile one cannot write a bidi override into an account name, a page cannot reach `wallet.*` or storage, a foreign leaf script is refused, a hostile explorer cannot inject an amount or a script into the signing path, plus the connect state machine and the RPC contract |
| `tests/e2e/` | `npm run test:e2e` | The extension as shipped: create → receive → lock/unlock → reveal the phrase behind the password → fund → node → send → restore on a second profile, a backup file written from Settings and restored on a third profile with its account list intact and no address of any other account asked about, site-connect approve/scope/revoke, and the negative cases — wrong password, refused destinations, a broken explorer, a node that rejects, a raw-seed wallet that has no phrase, a vault from an older build that is refused by name and can be removed from that same screen. The mock node re-verifies the signature and the sighash independently |
| `tests/integration/` | `BTQ_REGTEST=1` | btq-core itself: the node echoes our address, `scriptPubKey` and merkle root byte-for-byte, and `testmempoolaccept` accepts a transaction we signed (its real interpreter ran `OP_CHECKSIGDILITHIUM`) and rejects one signed over a tampered digest |

[`tests/e2e/README.md`](tests/e2e/README.md) says exactly what is mocked, what each hostile
case would otherwise miss, the one thing the suite asserts *is* stored in the clear, and
the whole environment contract for the live tier.
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs all of it on every push.

## Video

Two recordings, and they are not the same claim.

**[`demo/btq-wallet-suite.mp4`](demo/btq-wallet-suite.mp4) — the end-to-end suite
recording itself.** The real popup, driven by the tests, nothing staged: create → receive
→ lock and unlock → read the phrase back under Settings → fund → send, then a restore from
the phrase on a second profile. What it does *not* show is a real chain — the explorer and
the node in it are the suite's deterministic mocks on `127.0.0.1`, and the coins are
ledger entries. That is the price of a recording anybody can reproduce offline in thirty
seconds.

```sh
npm run demo:video     # RECORD_VIDEO=1 playwright test tests/e2e/smoke.spec.ts, then
                       # scripts/stitch-demo.sh → demo/btq-wallet-suite.mp4 (needs ffmpeg)
RECORD_VIDEO=1 npm run test:e2e && sh scripts/stitch-demo.sh demo/btq-wallet-suite.mp4
                       # the whole suite, site-connect included
```

**`demo/btq-wallet-demo.mp4` — the live one, with nothing mocked.** Ten captioned scenes
against the public explorer and a real `btqd` on the operator's machine: a wallet created
and scanned, a funded phrase restored, a real payment signed and broadcast, the
transaction found on
[explorer.bitcoinquantum.com](https://explorer.bitcoinquantum.com), one real confirmation,
the payee restoring his own wallet and finding the money, the phrase read back behind the
password, and a site connected and revoked. Every number it dwells on is asserted first
against a value read independently in Node, and a run that cannot prove what it is showing
throws instead of recording it anyway.

> **This take predates the last UI pass, and one screen in it is now wrong.** It was
> recorded on 22 Aug. Since then the create screen stopped saying "nothing is saved until
> you confirm" — the vault is now sealed *before* the phrase is shown, because the MV3
> service worker is torn down while you are writing twelve words on paper and the old flow
> failed for anyone who took their time. The receive tab also leads with the address rather
> than the QR, and the balance line reads "Checked just now · block N". The screenshots
> above are current; this video is not. A fresh take is pending only on BTQ testnet
> resuming block production — it stopped mid-recording during the re-run, which is why
> `npm run demo:preflight` now refuses a take when the tip has gone stale.

```sh
npm run demo:preflight   # will a take work? node, explorer, chain tip, Alice's coins — ~3 s, no browser
npm run demo:live        # preflight, build, record, stitch → demo/btq-wallet-demo.mp4
```

> **Recording one yourself needs your own node.** The take in this repository was made
> against BTQ testnet on 22 August 2026: the payment in it is
> [`87e45bc6…b55d62`](https://explorer.bitcoinquantum.com/tx/87e45bc62b7d44d837bb0394ea4625274c97a6f3b24e9c60523c8a13b2b55d62)
> and later takes are the same flow with fresh coins. To make your own you need a synced
> testnet node's RPC password and a funded wallet, both supplied through a git-ignored
> `.env.demo` — see [`tests/e2e/README.md`](tests/e2e/README.md) for the `BTQ_DEMO_*`
> contract. `npm run demo:preflight` says whether a take would work before it opens a
> browser.

Every `BTQ_DEMO_*` variable a live take reads, and every operator note about running one,
is in [`tests/e2e/README.md`](tests/e2e/README.md) — deliberately the only copy, so there
is no example file to drift out of date. Recording costs real testnet coins on every take.
CI is untouched by any of it: without `BTQ_LIVE=1` the live spec skips with a reason.

Playwright records video and nothing else, so both files are silent and show no cursor and
no browser chrome. The suite is popup-only at 360×600 and machine-paced; the live one
records a 960×640 canvas — wide enough for the explorer tab scene 6 opens — is slowed to
something a human can follow, and carries a caption per scene. Clips are written one per
page under `demo/raw/` — git-ignored, ordered by `demo/raw/order.txt` — and only the
stitched mp4 is committed.

The master secrets are barred out of both recordings for the same reason they are barred
out of the screenshot. Four selectors cover the five surfaces that put one on screen — the
twelve-word grid (which is now the onboarding screen *and* the Settings reveal), the
confirmation fields, the import box, and the HD-seed hex a wallet with no phrase is shown
instead — and they are covered before the first frame is painted, with one fixed bar size
so neither the word lengths nor the seed's line count leaks either.
Only the recording is masked — with `RECORD_VIDEO` unset the tests behave exactly as they
do in CI, and either way they read the real phrase and assert against it
([`tests/e2e/fixtures/redact.ts`](tests/e2e/fixtures/redact.ts)). The redaction list
enumerates both ids and `expectRedacted` refuses a selector that is not on it, so a
surface that loses its `seed-word-N` or `seed-hex` id fails the recording run rather than
quietly appearing in it.

## Protocol notes

- **Addresses** are bech32m witness v2 — `tbtq1z…` on testnet. The witness program *is* a
  TapLeaf merkle root; there is no key path, so every spend reveals
  `<1312-byte ML-DSA pubkey> OP_CHECKSIGDILITHIUM` plus a `0xc1` control block.
- **Signatures** are exactly 2421 bytes (2420 + a mandatory `SIGHASH_ALL` byte), signed
  deterministically with an empty FIPS 204 context. `SIGHASH_DEFAULT` is rejected by
  consensus.
- **Fees** use witness scale factor **16**, not 4: one P2MR input is 4402 WU = 275.125 vB,
  and `MAX_STANDARD_TX_WEIGHT` caps a transaction at ~90 inputs.
- **Dust** for a P2MR output is **270 sats** (a 43-byte output plus a 47-byte spend
  estimate × 3000 sat/kvB) — the node's own rule, not a stricter guess.
- **Derivation** is hardened-only over the 32-byte ML-DSA seed — `m/k'/0'/n'` external,
  `m/k'/1'/n'` internal. Account 0 (`m/0'/…`) is btq-core's legacy path; extra
  accounts are `m/1'/…`, `m/2'/…` from the same seed and are **this wallet's own
  convention** — Core hardcodes `0'` and cannot derive them. There is no xpub and no
  watch-only derivation.

Every constant with its `btq-core` source line: [`docs/REFERENCE.md`](docs/REFERENCE.md).
The import-from-seed design, byte by byte: [`docs/HD_IMPORT.md`](docs/HD_IMPORT.md). The
95-row BTQ-vs-Bitcoin difference map: [`docs/BTQ_CORE_MAP.md`](docs/BTQ_CORE_MAP.md).

## Security model

Keys decrypt **only** inside the MV3 service worker, only while unlocked. The content
script and `window.btq` never receive phrase or key material at all; the popup never
receives the HD seed or a secret key, and receives the twelve words only from the two
calls that exist to show them — onboarding, and the password-gated reveal. It does receive
the wallet **backup file**, and that is not a third exception: what crosses is the sealed
`BTQ1` envelope, which is why it may become a file when the phrase and the seed may not. `src/core/` is
pure, browser-safe and dependency-light (`@noble/*`, `@scure/*`) so it stays reviewable.
[`SECURITY.md`](SECURITY.md) has the trust boundary, what the wallet refuses, why showing
the phrase again is not a weaker boundary than the send screen, and what is deliberately
out of scope.

## What I'd ship next

None of this is built. It is what a real wallet needs next, in the order I would take it,
and the last paragraph is why it is two pieces of work rather than five.

**Multisig — and why the Sparrow model cannot be ported.** There is no xpub and there
cannot be one: `CDilithiumExtPubKey::Derive()` always returns false, because a lattice key
admits no analogue of `child_pub = parent_pub + hash*G` (`dilithium_key.h:370`). Sparrow,
Electrum and Caravan all rest on the opposite assumption — exchange xpubs once at setup,
then derive an unlimited chain of addresses independently and forever. On BTQ **every
multisig address needs a fresh 1312-byte public key from every cosigner**, delivered out of
band, and that one fact is the whole design problem.

The protocol already exists; the client does not. btq-core ships the threshold accumulator
leaf (`GetScriptForDilithiumThreshold`, `dilithium_leaf.cpp:13`) and the three PSBT fields
that carry a P2MR Dilithium spend — `0x19` leaf script, `0x1A` merkle root, `0x1B` partial
signature (`psbt.h:52-54`). What it does not ship is anything an extension can call:
`createdilithiummultisig` (`dilithium.cpp:447`) and `walletprocesspsbt` are **wallet** RPCs
and need the private keys loaded on a node, which is precisely what this wallet exists to
avoid. Construction, signing, combining and finalizing therefore all have to be
reimplemented client-side in `src/core/`, with btq-core as the oracle they are checked
against rather than a runtime dependency.

It is affordable, which is not obvious for a scheme whose every signature is 2421 bytes.
One input, two outputs:

| spend | witness | vsize |
|---|---|---|
| single-sig | 3746 B | 372 vB |
| 2-of-3 | 8815 B | 689 vB |
| 3-of-5 | 13878 B | 1005 vB |

A 2-of-3 costs 1.85× a single-sig spend, and a 3-of-5 2.7×, only because the witness scale
factor is **16** rather than Bitcoin's 4 — at 4 the same 2-of-3 witness would be ~2200 vB.
The full design — enrollment, key distribution, spend coordination, and what a cosigning
wallet must refuse — is [`docs/MULTISIG.md`](docs/MULTISIG.md).

**Air-gapped and hardware signing.** There is no device to talk to: an ML-DSA-44 secret key
is 2560 bytes and a signature 2421, against secp256k1's 32 and ~71, and no shipping
hardware wallet speaks ML-DSA. So the work is the *interface* — PSBT in, PSBT out, over
file, QR or USB-HID — built now so a device can drop into it later, and useful the day it
ships because the same interface serves an offline second copy of this wallet on a machine
that never sees a network. Sizing decides the UX: a 1312-byte public key fits in a single
QR (binary capacity 2953 B) and so does an unsigned PSBT, but a signed one carries 2421
bytes per signature and needs animated multi-part QR or a file. Signing here is
deterministic (Protocol notes above), so an air-gapped signer can be attested by replaying
a known vector and checking byte equality — an assurance a secp256k1 signer cannot give.

**RBF and CPFP fee bumping.** The gap is unusually clean: `src/core/tx/serialize.ts:23`
sets `DEFAULT_SEQUENCE = 0xfffffffd // opt in to RBF`, so **every transaction this wallet
has ever sent is replaceable and there is no way to replace one.** At the 1000 sat/kvB
incremental relay floor (`policy.h:38`) a bump on a 372 vB spend costs on the order of 372
extra sats. The case does not rest on block times: any wallet that lets the user choose a
fee rate needs a way to correct that choice, and one that marks every transaction
replaceable and then offers no way to replace one has the gap whatever the chain is doing.
On BTQ testnet today it is more than theoretical — blocks can be hours apart, so a
transaction that has to wait waits visibly. CPFP covers the inbound direction, where the
user never picked the fee at all. Where it gets
interesting is multisig: a replacement is a **new transaction needing m fresh signatures**,
so the fee is trivial and the coordination is not.

**A timelocked recovery leaf.** The most BTQ-specific item here. A P2MR output commits to a
merkle *tree*, not to one script, and `OP_CHECKLOCKTIMEVERIFY` / `OP_CHECKSEQUENCEVERIFY`
are gated on script flags rather than on sigversion (`interpreter.cpp:575,614`), so they
work inside a leaf. A hot leaf (2-of-3) and a recovery leaf
(`<90 days> OP_CHECKSEQUENCEVERIFY OP_DROP <backup key> OP_CHECKSIGDILITHIUM`) then commit
to one address, and **only the leaf actually spent is ever revealed** — the recovery branch
costs zero bytes unless it is used, and is never published if it never is. That is worth
more here than on Bitcoin, because every P2MR spend already publishes a 1312-byte key and
on-chain footprint is the scarce resource. The caveat belongs next to the feature: spending
one leaf needs the merkle branch to the other to build the control block, so the wallet
must persist the whole tree, and with no xpub it cannot be re-derived from the seed. Lose
the tree description and the coins are unspendable *even with the keys* — a hard
requirement on the backup format, settled before a line of it is written.

**Labels, coin control, watch-only.** Coin control is a privacy control on this chain, not
a power-user nicety: every spend reveals the 1312-byte public key of every input, so
combining two UTXOs publishes both keys in one transaction and links those addresses
permanently. On a chain built to resist quantum adversaries, involuntary input linkage is
the main leak and choosing your own inputs is the only defence against it. Labels are the
most sensitive non-key data a wallet holds and belong inside the sealed vault, not
plaintext `storage.local`. Watch-only can only ever mean "watch this explicit list of
addresses", a list that cannot extend itself, because `Derive()` returns false — there is
no "watch my cold wallet from my phone" on BTQ, and the one workable form is a batch export
of K addresses.

These are not five features but **two primitives**. Client-side PSBT — parse, validate,
sign, combine, finalize, none of which exists in this repo today — is multisig, air-gapped
signing and multisig fee bumping at once. Batch public-key export is multisig enrollment
and watch-only, the same mechanism answering both. The recovery leaf is the one item
neither covers: it needs a third thing, a backup format that carries the tree.

## Layout

```
src/core/          pure protocol code — no I/O, no Buffer, no chrome.*, unit-tested
src/background/    MV3 service worker — vault, keyring, explorer, node RPC, connect broker
src/content/       isolated-world relay: allowlisted page methods, never key material
src/inpage/        window.btq provider (MAIN world, frozen surface)
src/ui/            React popup: components/ screens/ hooks/, one screen per file
tests/unit/        crypto, derivation, script, address, fee, sighash, explorer parsers
tests/security/    secret leakage, locked wallet, bad seed, phrase reveal, page RPC, connect
tests/e2e/         the built extension in Chromium: journeys, connect, negatives, regtest,
                   and live.spec.ts — the recorded run against the real chain (opt-in)
tests/e2e/fixtures the mock explorer and node, the independent verifiers, dapp.html,
                   the recording redaction, the live chain reads and the scene pacing
tests/integration/ cross-checks against a live btq-core node (opt-in)
tests/vectors/     golden.json — the frozen contract with consensus
scripts/           gen-vectors.ts · stitch-demo.sh · demo-preflight.ts · demo-live.sh
docs/              REFERENCE · HD_IMPORT · BTQ_CORE_MAP · PLAN · screenshots
demo/              btq-wallet-suite.mp4, recorded by npm run demo:video; the live take
                   npm run demo:live writes lands beside it as btq-wallet-demo.mp4
.claude/           agent instructions: the wallet skill and a security-review reviewer
```

## License

[MIT](LICENSE). It is a take-home exercise against a testnet, so clone it, build
it, and take whatever is useful — but it has never held real money and nothing
here has been audited.
