# Multisig across independent wallets, on a chain with no xpub

> **Nothing in this document is built.** This wallet is single-key: it produces one leaf
> template, `<pubkey> OP_CHECKSIGDILITHIUM` (`src/core/script/p2mr.ts:41`), and it has no
> PSBT code at all. What follows is a design for work that does not exist yet, written
> against btq-core as it actually is. Where a sibling spike exists it is named as a spike
> and nothing more. Where a question is open it is left open.

Bitcoin's multisig wallets — Sparrow, Electrum, Caravan — all rest on one assumption:
cosigners exchange extended public keys once, at setup, and then each of them derives an
unbounded chain of shared addresses forever, alone and offline. Setup is a ceremony;
everything after it is arithmetic.

On BTQ that assumption is false, and it is false at the level of the mathematics rather
than the software. Everything below follows from that.

---

## 1. There is no xpub, and there cannot be one

`CDilithiumExtPubKey::Derive()` always returns `false`
(`src/crypto/dilithium_key.cpp:416-424`). Not "not yet", not "unimplemented" — the
function body is a comment explaining why the operation does not exist, followed by
`return false`. The class documentation states it as a property of the key structure
(`src/crypto/dilithium_key.h:368-371`):

> Hardened-only by design. Dilithium's lattice-based key structure does not admit
> BIP32-style homomorphic ("non-hardened") public key derivation (there is no analogue of
> `child_pub = parent_pub + hash*G`). Calling `Derive()` with a non-hardened child index
> therefore returns false.

BIP32's watch-only magic is one identity: `child_pub = parent_pub + H(...)·G`. A public
key plus a chaincode walks the whole tree because the tweak is added in the group, and the
group operation commutes with the map from private key to public key. ML-DSA is a lattice
scheme; the public key is a matrix product with small error terms, and there is no group
law over it to exploit. This wallet enforces
the same rule on its own derivation — `deriveChild` throws on any index without the
hardened bit set (`src/core/crypto/hd.ts:66-69`) — and the README states the single-key
consequence already (`README.md:380`: "There is no xpub and no watch-only derivation").

The multisig consequence is sharper and is stated nowhere yet:

**Every new multisig address requires a fresh 1312-byte public key from every cosigner,
delivered out of band.** There is no derivation shortcut, no gap-limit scan that finds
addresses a cosigner generated alone, and no way to hand someone a string that lets them
produce your future keys. A 2-of-3 wallet that wants a hundred shared addresses needs each
of the three machines to be holding the other two's hundred keys — 262 KB that arrived out
of band, per machine.

That is not a UX inconvenience. It is the design problem, and it collides directly with
privacy. The path of least resistance is to agree one address and reuse it forever, which
is exactly what btq-core's own test does — it funds the same multisig address three times
(`test/functional/wallet_dilithium_psbt_multisig.py:72,126,144`). On a chain whose premise
is resisting a quantum adversary, address reuse means every spend republishes the same n
public keys, and the cosigner set stays linkable in the explorer forever. A design that
shrugs at reuse has given up the thing the chain exists for.

---

## 2. What btq-core already gives you — and what it cannot give a browser extension

### It gives you a protocol, fully exercised

Cross-wallet Dilithium multisig is not speculative. `wallet_dilithium_psbt_multisig.py`
stands up three separate wallets holding one key each
(`test/functional/wallet_dilithium_psbt_multisig.py:34-42`), has all three independently
derive the same 2-of-3 address and assert byte equality on the address, the scriptPubKey
and the leaf script (`:61-69`), and then moves base64 PSBTs between them. It proves
parallel signing — two wallets sign independent copies and `combinepsbt` merges the two
partial signatures (`:110-115`) — sequential signing, idempotent re-signing, refusal to
finalize under threshold, and rejection of a forged signature at *decode* time
(`:159-165`).

| piece | where |
|---|---|
| `createdilithiummultisig(m, pubkeys, label)` | `src/wallet/rpc/dilithium.cpp:447` |
| canonical leaf builder `GetScriptForDilithiumThreshold` | `src/script/dilithium_leaf.cpp:13-25` |
| leaf classifier `ParseP2MRDilithiumLeaf`, policy name `dilithium_threshold` | `src/script/dilithium_leaf.cpp:80` |
| PSBT leaf script / merkle root / partial sig | `src/psbt.h:52,53,54` |
| partial-sig value size, and max 20 per input | `src/psbt.h:82,83` |
| consensus opcode `OP_CHECKMULTISIGDILITHIUM` | `src/script/script.h:222` |

So this is a protocol to speak, not a feature to invent.

### It cannot be a runtime dependency

`createdilithiummultisig` and `walletprocesspsbt` are **wallet** RPCs. They require a
loaded wallet holding the private keys *on the node*. A browser extension has no wallet on
anyone's node and must never have one — its keys decrypt only inside the MV3 service
worker. Those two calls are therefore unavailable **by construction**, not by
configuration.

The split is visible in the test's own call sites: `alice.walletprocesspsbt(...)` addresses
a wallet, while `node.combinepsbt(...)`, `node.finalizepsbt(...)` and
`node.sendrawtransaction(...)` address the node. Combine and finalize need no wallet — but
depending on them still means requiring every cosigner to run btq-core, and the public
explorer has no broadcast route at all (`POST /api/v1/tx/send` → 404; `README.md:186-189`).

**The extension must implement address construction, signing, combining and finalizing
itself, in `src/core`. btq-core's RPCs are how the implementation is *verified*, never
something called at runtime.** A node, where the user has one, is a broadcast endpoint and
a dry-run oracle (`testmempoolaccept`) and nothing else.

PSBT stays the right interchange format anyway — not because we can call btq-core, but
because it is the format btq-core defines, it is what air-gapped and future hardware
tooling will speak, and it lets a power user drop into btq-core if they choose.

Two pieces of the existing crypto layer already generalize and are the reason this is
tractable: `tapLeafHash()` takes an arbitrary script
(`src/core/script/p2mr.ts:55`), and `commitsToProgram()` already walks a multi-level merkle
path with the parity check (`src/core/script/p2mr.ts:86-98`). Only
`singleKeyLeafScript()` is single-key specific.

---

## 3. The leaf: use the accumulator, not `OP_CHECKMULTISIGDILITHIUM`

Two leaf templates carry a threshold policy. `OP_CHECKMULTISIGDILITHIUM` (0xbd,
`src/script/script.h:222`) is the CHECKMULTISIG-shaped one, historical off-by-one and
NULLDUMMY included. The other is the accumulator form built by
`GetScriptForDilithiumThreshold` (`src/script/dilithium_leaf.cpp:13-25`):

```
OP_0
(OP_TOALTSTACK <pubkey> OP_CHECKSIGDILITHIUM OP_FROMALTSTACK OP_ADD) × n
<m> OP_GREATERTHANOREQUAL
```

Use the accumulator. btq-core gives the reason itself
(`src/script/dilithium_leaf.h:47-51`):

> Unlike `OP_CHECKMULTISIGDILITHIUM`, this accumulator form lets a key that did not sign
> contribute an empty signature slot, so any m-sized subset of the n signers produces a
> valid witness. This is the form btq-multisig uses and the **only one that supports
> partial signing across independent wallets.**

That property is the whole feature. A non-signer's empty slot is scored 0 by
`OP_CHECKSIGDILITHIUM` without failing the script, so a witness can be assembled from
*any* m of the n cosigners without the signers having coordinated on which subset would
sign. The CHECKMULTISIG form constrains signature ordering and cannot express "whichever
two of you got to it first".

Two mechanical details a finalizer must get right:

- **Slots go in reverse key order.** Key index 0 is evaluated first, so the witness pushes
  slots last-key-first. btq-core's own test spells it out:
  `exec_items = [sigs.get(k, b'') for k in reversed(range(len(self.pubkeys)))]`
  (`test/functional/feature_p2mr_dilithium_multisig.py:140-142`).
- **An empty slot is one byte and costs nothing.** It contributes a zero-length witness
  item, and `EvalChecksigDilithium` skips the validation-weight deduction entirely when the
  signature is empty (`src/script/interpreter.cpp:126`). Sparse m-of-n is free.

---

## 4. Two footguns btq-core does not close

**Key order is caller-supplied and unsorted.** `createdilithiummultisig` parses the pubkey
array in the order given, rejects duplicates (`src/wallet/rpc/dilithium.cpp:512-515`), and
hands the list straight to `GetScriptForDilithiumThreshold` in that order
(`:519`). Its own help text says the quiet part out loud
(`src/wallet/rpc/dilithium.cpp:450-453`):

> Every co-signer must call this with the same m and the same pubkey list in the **same
> order**; they then all derive the same address.

There is no `sortedmulti` equivalent. Two cosigners who enroll the same three keys in
different orders derive **different addresses**, both perfectly valid, and silently never
see each other's funds. The failure mode is not an error message; it is an empty balance.

A real wallet must canonicalize. The design here is to sort the n public keys
lexicographically by their 1312-byte encoding at enrollment, before the leaf is built, and
to make that ordering part of the enrollment record so it is reproducible and auditable.
An accompanying spike does exactly this in `src/core/script/multisig.ts` and checks the
resulting address against btq-core-generated vectors — construction only, not a shipping
feature.

**There is no descriptor language for it.** `multi` and `sortedmulti` are ECDSA and are
gated to the TOP, P2SH and P2WSH contexts (`src/script/descriptor.cpp:1626`); `multi_a` is
x-only P2TR (`src/script/descriptor.cpp:966`). Neither accepts a Dilithium key. What
Dilithium handling `descriptor.cpp` does have is confined to keyhash and script-hash
*destinations* (`:736-742`, `:779-781`) — there is no threshold form.

The consequence: a BTQ multisig wallet is RPC state or application state, with **no
portable descriptor** to back it up or move it to another implementation. Recovery cannot
mean "import this string". It has to mean "restore this structured record", which raises
the stakes of the backup question in §6.

---

## 5. The three sub-problems

btq-core solves the *format* of all three and the *transport* of none.

| | problem | what btq-core supplies | what is missing |
|---|---|---|---|
| **A** | **Enrollment** — agreeing on `(m, ordered key list)` | leaf builder, address derivation, duplicate rejection | canonical ordering, mutual authentication of the key list, independence checking |
| **B** | **Address generation** — a fresh shared address | address derivation from n keys | *any* way to get n fresh keys without a live round trip — see §1 |
| **C** | **Spend coordination** — move a PSBT until m sigs exist, then finalize | PSBT field definitions, decode-time validation, combine and finalize semantics | a client-side implementation, and a way to move bytes between two browsers |

(A) is the smallest of the three and mostly a UI problem, with one hazard worth naming
here because it is invisible: see the same-seed hazard in §8.

(B) is where the absence of an xpub does its damage, and where the real design work is.
(C) is where this collides with the wallet's existing send architecture.

---

## 6. (B) Key distribution — four options, one recommendation

### The options

**1. Reuse one address.** What btq-core's test does. It works, it needs one ceremony ever,
and it is rejected here on privacy grounds: every spend republishes the same n public keys
and the cosigner set is permanently linkable. A post-quantum wallet that treats key
republication as free has misunderstood its own threat model. Support it if the user
insists; never make it the default and never make it silent.

**2. Batch pre-share at enrollment.** ← **recommended.** Each cosigner exports K public
keys at enrollment (their `m/k'/0'/i'` for `i` in `0..K`). At K = 100 that is 131 KB per
cosigner, ~393 KB exchanged for a 2-of-3. Every wallet can then derive K shared addresses
alone, with zero further interaction, and a refill ceremony happens when the pool runs low.

**3. Interactive per-address.** Best privacy — a fresh key per address, generated on
demand. The cost is that every cosigner must be online to *receive*, which is a strange
property for a receive address to have. Ship it as an option for users who want it; never
as the only mode.

**4. Commit-and-reveal.** At enrollment each cosigner publishes a merkle root over their K
future public keys, revealing leaves lazily. This does not reduce what the *receiving*
wallet needs — it still needs all n keys to build the address — but it does let a wallet
verify that a key it is handed belongs to the enrolled set without holding all K, which is
useful in the relay transports of §7. A refinement on top of (2), not an alternative to it.

### The asymmetry that makes (2) tolerable

**Only the wallet generating a receive address needs all n keys at that moment.** A signer
learns the script later from the PSBT itself, which carries the leaf in field `0x19`
(`src/psbt.h:52`) — it does not need the cosigner key pool to sign, only to *verify*, and
verification against the enrolled set is exactly what §9 requires. So the refill ceremony
is a receiving-side concern, and a cosigner who is offline for months can still sign the
moment they come back.

### Where the keys live — and the storage wall

Cosigner public keys are public, so they belong outside the sealed vault on principle. This
repo turns that preference into a hard constraint, twice:

- The vault blob is asserted **under 400 bytes** in four end-to-end files
  (`tests/e2e/smoke.spec.ts:149`, `:245`, `tests/e2e/connect.spec.ts:353`,
  `tests/e2e/negative.spec.ts:255`); it is 288 B for a 12-word wallet. Two hex-encoded
  cosigner public keys add ~5.2 KB. That assertion fails instantly.
- Harder: `BACKUP_PLAINTEXT_BYTES = 8192` (`src/core/vault/backup.ts:70`) is a **fixed
  pad**, and `encodeBackup` throws rather than emit a short file, because a short file
  would leak the account count (`src/core/vault/backup.ts:62-69`). Its own comment computes
  roughly 3 KB of slack against the largest payload this build can produce. Two 1312-byte
  keys at 5248 hex characters exceed that, and the export throws.

So cosigner keys live in `chrome.storage.local['meta']`. That storage is
**attacker-adjacent and attacker-writable**, and the repo already says so in the place that
parses it (`src/core/wallet/storage.ts:295-300`): anything that can write extension storage
could set a huge cursor and make the wallet derive thousands of ML-DSA keys on unlock.
Cosigner keys need their own validator in `parseMeta` (`src/core/wallet/storage.ts:302`)
with the same posture — structural check, then fall back to a fresh record rather than
trust what is there.

Substituted cosigner keys are precisely the attack `src/core/tx/builder.ts:136` already
defends against for the single-key case: the wallet re-derives the output script from its
own key and refuses if it does not equal the UTXO's script. The multisig analogue is
re-deriving the address from the *enrolled* set, which is only meaningful if the enrolled
set is itself trustworthy — which is why the enrollment record, not just the key blob,
needs integrity.

There is no platform quota problem. The manifest requests `['storage', 'alarms']` with no
`unlimitedStorage` (`src/manifest.config.ts:28`), which is roughly 10 MB — comfortable for
a 393 KB pool with three orders of magnitude of headroom. **Every binding constraint here
is self-imposed**, which is the good kind: it means the decision is ours.

### The open decision

The backup format has to change, and how it changes is not settled.

A `.btqbackup` file today seals seed + account list at a fixed 8192-byte plaintext, so a
restore is complete by construction. A multisig wallet's enrollment record — thresholds,
canonical key order, and the K-key pools — cannot fit that envelope, and unlike single-key
state it **cannot be re-derived from the seed** (§1 again: your cosigners' keys were never
yours to derive). Losing it loses the ability to construct the address, which for a
receive-side wallet means losing the ability to find the coins.

Three ways out, none free:

| option | cost |
|---|---|
| Raise `BACKUP_PLAINTEXT_BYTES` to a larger fixed pad | Every backup file grows for every user, including single-key ones, or the padding tier itself leaks whether the wallet is multisig |
| A second file type for enrollment records | Two things to lose instead of one; the failure mode is a user who kept the phrase and not the record |
| Bucketed padding (8 KB / 64 KB / 512 KB tiers) | Preserves "one file", leaks a coarse size class |

This document does not pick one. The point of naming it is that the fixed-pad property is
a real privacy control the repo argues for at length, and multisig is the first feature
that genuinely strains it. Whoever builds this should decide it deliberately rather than
discover it when `encodeBackup` throws.

---

## 7. (C) Transport — four paths

None of these is a protocol question. All four move the same bytes: 1312-byte public keys
at enrollment, and base64 PSBTs at spend time.

### 1. Manual / air-gapped — file, clipboard, QR

Zero infrastructure, zero metadata leak, works across vendors, cannot be taken away by a
service going down. Sizing decides the UX, and it splits the two payloads cleanly:

- **A public key fits one QR.** 1312 bytes against a 2953-byte binary capacity at QR
  version 40, level L. Enrollment and pool refills can be a camera and a screen.
- **A multisig PSBT does not, ever.** The unsigned PSBT already carries the leaf script in
  field `0x19` — 3960 bytes for a 2-of-3 — and each partial signature adds 3766 more: 2421
  bytes of signature plus the 1345-byte wire key it is filed under
  (`src/psbt.h:756-760`). Exchanged as base64 that is another third on top. A singly
  signed 2-of-3 PSBT is comfortably past 10 KB of transport payload, so this path means
  animated multi-part QR or a file, and a file is the honest answer.

**This is the floor, and it should ship first.** Every other path is a convenience layer
over it, and building it first means the feature is never hostage to infrastructure.

### 2. Coordinator dapp over the existing page API — best fit for this codebase

The wallet already has an origin-scoped page surface: three methods
(`src/core/connect/permissions.ts:110`), an allowlist duplicated in the content relay so
drift fails a test (`src/content/index.ts:19-23`), an approval window, and a relay that
never touches key material. A coordinator would add a PSBT-shaped method to that surface.

**What the page gets is not `wallet.signPsbt`.** The page-reachable method is
`page.proposePsbt` — it hands the worker bytes and opens an approval window, and that is
the entire extent of its authority. Signing happens on the worker's own path, from the
popup, with the password, exactly as `confirmSend` does today. This is the same shape as
`page.requestAccounts`: the page asks, the worker decides, the user approves. §8 explains
why `wallet.signPsbt` must never be on the relay allowlist; this transport is compatible
with that rule rather than an exception to it.

The page stays untrusted and nothing about that changes. The worker independently
re-derives everything: `commitsToProgram()` against the actual witness program, the sighash
recomputed from the wallet's own serialization, every output checked against the wallet's
own derivation. A lying coordinator achieves a refusal and nothing else. That is the same
argument the send path already makes, and it is why this transport is the cheapest one to
justify.

### 3. Encrypted relay / pubsub — best UX, two things that must be said

Cosigners in different timezones, asynchronous, no "both online" requirement. Two
statements belong in the UI, not just in a design doc:

- **The relay learns the cosigner graph.** Channel identifiers and timing metadata reveal
  who signs with whom and how often, even when every payload is encrypted. Encryption is
  not anonymity. Channel IDs must additionally not be derivable from on-chain data, or the
  explorer becomes an index into the relay.
- **The transport encryption must be ML-KEM (FIPS 203), not X25519.** A relay is
  store-and-forward; the ciphertext sits on someone's disk. Wrapping a post-quantum wallet
  in an X25519 channel is a harvest-now-decrypt-later hole with a post-quantum wallet
  bolted to one end of it. The PSBTs in that channel contain public keys, amounts and
  cosigner identities — exactly the metadata the chain design is trying not to publish.

### 4. Direct peer (WebRTC)

Data never rests on a server. Still needs a signaling server, which still sees who
connects to whom, and both parties must be online. A middle ground: better than (3) on
data-at-rest, no better on graph metadata, worse than (3) on availability.

### Summary

| path | infrastructure | metadata leak | both online? | cross-vendor |
|---|---|---|---|---|
| Manual / QR / file | none | none | no | yes |
| Coordinator dapp | a web page | the coordinator sees the graph | no | via PSBT |
| Encrypted relay | a relay service | graph + timing, content sealed (ML-KEM) | no | via PSBT |
| WebRTC | signaling only | graph, no data at rest | yes | needs shared signaling |

---

## 8. Where this collides with this wallet's design

A design document is most likely to be wrong where it touches code that already exists.
This is that section.

### `planId` refuses, structurally, what a cosigning wallet must do

The entire send path exists so that **no caller — popup or page — can describe a
transaction to be signed**. `wallet.confirmSend` takes exactly two parameters, and the
dispatcher explains why in a comment that is worth quoting in full
(`src/core/rpc/dispatch.ts:213-219`):

> Two parameters, and neither of them describes the transaction. The destination, the
> amount, the fee rate and the chosen inputs were all fixed when `wallet.prepareSend` drew
> the review card; `planId` is an opaque handle into worker-side state and carries none of
> them. A popup — compromised, or merely showing numbers that have since moved — can
> therefore no longer change what is signed after the user has read it, and the worker
> never rebuilds a plan the user has not seen.

The plan behind that handle is deliberately fragile. It is a **single** in-memory slot
(`src/core/wallet/keyring.ts:292`), with a **two-minute TTL**
(`src/core/wallet/keyring.ts:105`, enforced at `:1281-1282`), dropped on lock so it cannot
survive an auto-lock and be confirmed by whoever unlocks next
(`src/core/wallet/keyring.ts:539`), dropped on account create and account switch
(`:612`, `:633`), and gone entirely when the service worker is torn down — which Chrome
does after roughly thirty seconds of quiet.

A cosigning request is the exact opposite shape. It is a transaction *described by someone
else*, arriving *whenever the other party gets to it*. **A `PendingPlan` cannot survive
long enough to be circulated to a cosigner, by construction**, and the ways it could be
made to — a longer TTL, more than one slot, survival across lock — are each individually a
regression in the property the comment above is protecting.

### Why a PSBT is a different object, and earns its own path

The resolution is not to weaken the plan rule. It is to notice that `confirmSend`'s rule is
about *description* and a PSBT is not a description.

A `planId` is opaque because the alternative — a caller naming the destination and the
amount — would be **trusted input**. A PSBT is the opposite: it is a fully specified,
independently checkable artifact. The worker does not believe a word of it. It re-derives
the leaf and checks `commitsToProgram()` against the real witness program
(`src/core/script/p2mr.ts:86`); it recomputes the sighash from its own serialization; it
checks every output against its own derivation, including change; it checks every input
against UTXOs it recognises. Nothing the sender claims is load-bearing. A PSBT that lies
produces a refusal, deterministically, before any key is touched.

That is a *different trust story*, not a relaxed one, and it deserves a different, reviewed
path: **`wallet.signPsbt`**, worker-only, password-gated, never on the page allowlist and
never sharing code with `confirmSend`'s plan slot. The review card it draws is generated
from the wallet's own re-derivation of the PSBT, not from anything the sender attached — so
what the user reads is again what gets signed, arrived at by a different route.

Concretely, that means a cosigning path does not need a long-lived plan at all. The PSBT
*is* the durable object; it lives wherever the user put it, and the ephemeral worker-side
state is created and destroyed inside a single `signPsbt` call. The two-minute TTL survives
untouched.

### The same-seed hazard

Every path component in this wallet is hardened, and the account level is a small integer
starting at `0'` (`src/core/crypto/hd.ts:107-112`). btq-core hardcodes the account level to
`0'` outright (`src/wallet/scriptpubkeyman.cpp:1252`).

Therefore **two wallets restored from the same seed produce identical keys at identical
paths.** Cosigner independence rests entirely on the seeds being independent — there is no
"different account, same seed" arrangement that produces genuinely separate cosigners,
because both would sign with the same key and a 2-of-3 would be a 2-of-3 in name and a
1-of-1 in fact.

An enrollment UI must actively check for this rather than assume it. It is cheap: reject
duplicate public keys in the key list (btq-core already does this much,
`src/wallet/rpc/dilithium.cpp:512-515`, with the right reasoning — a duplicate "would
silently lower the effective threshold, since one private key could then fill several
accumulator slots"), and additionally reject the case where two cosigners' *entire pools*
coincide, which is the signature of a copied seed and which duplicate-checking one address
would miss. Say it in words on the enrollment screen too. "Add a cosigner from a backup of
this wallet" is a thing users will try, because on Bitcoin the account level would have
saved them.

---

## 9. What a cosigning wallet must refuse

Short and concrete, because this is where judgment shows.

- **Never sign a leaf that fails `commitsToProgram()`.** Already the wallet's rule for
  single-key spends (`src/core/tx/builder.ts:134`), and btq-core enforces the same check
  before it will act on a PSBT input (`src/psbt_dilithium.h:56-59`). A signer that skips it
  can be induced to sign an unrelated script.
- **Verify every output, not just the one the coordinator highlights** — including that
  change goes to an address the wallet can re-derive from the enrolled cosigner set.
  Otherwise a malicious coordinator relabels the attacker's address as change and the user
  approves a payment they read as a refund.
- **Refuse inputs the wallet does not recognise.** Foreign inputs are how a coordinator
  inflates the fee without touching a single output the user is looking at.
- **Show absolute fee *and* sat/vB.** A 2-of-3 witness is 8815 bytes; large witnesses make
  fee abuse easy to hide behind a plausible-looking rate. Both numbers, always.
- **Cap partial signatures at 20 per input**, matching
  `MAX_DILITHIUM_PARTIAL_SIGS_PER_INPUT` (`src/psbt.h:83`, which is
  `MAX_PUBKEYS_PER_MULTISIG` at `src/script/script.h:35`).
- **Validate every partial signature at parse time and fail closed.** btq-core does exactly
  this: `ValidateP2MRDilithiumPSBT` runs after deserialization and, on failure, **zeroes the
  entire PSBT** before returning (`src/psbt.cpp:588-594`) so no caller can act on
  unvalidated material. Its comment explains why it cannot be done field-by-field —
  verifying a partial signature needs the unsigned transaction and every input amount. A
  decoder that accepts a forged signature and discovers it at finalize time is strictly
  worse than the reference implementation, and there is no reason to be worse.

### One open question, unresolved

Every btq-core functional test registers the multisig in each wallet via
`createdilithiummultisig` *before* signing. The **sign-from-the-PSBT-alone** path — which
is what an extension with no node wallet must do — is supported by the code structure:
`SignP2MR` merges PSBT-supplied spend data into the signer's own
(`src/script/sign.cpp:518-533`) and explicitly handles a PSBT-carried leaf that arrives
without a control block. But **no test exercises it.**

If it turns out not to work, the design survives — the extension derives the leaf itself
from the enrolled cosigner set and never depends on the PSBT to tell it what it is signing,
which is the safer posture regardless. But it changes what "PSBT interchange with btq-core"
means, and it should be proven with a minimal regtest case before anything is built on it.
It is listed here as unproven rather than assumed.

---

## 10. Sizing: the 16× witness discount is what makes this affordable

BTQ's witness scale factor is 16, not Bitcoin's 4 (`docs/REFERENCE.md:19`). For a chain
where one signature is 2421 bytes and one public key is 1312, that choice is the difference
between multisig being usable and being theoretical.

### The derivation, so the table can be recomputed

**Leaf script.** `1319n + 3` bytes for m ≤ 16: `OP_0`, then 1319 bytes per key
(`OP_TOALTSTACK`, a 3-byte `OP_PUSHDATA2` header, the 1312-byte key,
`OP_CHECKSIGDILITHIUM`, `OP_FROMALTSTACK`, `OP_ADD`), then the threshold push and
`OP_GREATERTHANOREQUAL`.

It is **`1319n + 4` for m ≥ 17**, and this is easy to miss. `GetScriptForDilithiumThreshold`
emits the threshold with `script << m` (`src/script/dilithium_leaf.cpp:23`); 1 through 16
have single opcodes `OP_1`..`OP_16`, but 17 and above have none and serialize as a two-byte
minimal data push. `MAX_PUBKEYS_PER_MULTISIG = 20` (`src/script/script.h:35`) makes that
range reachable, so a 20-of-20 leaf is 26384 bytes, not 26383. A test suite written around
2-of-3 never sees it.

**Witness.** m signatures at 2424 bytes each (2421 plus a 3-byte compact size prefix), plus
`n − m` empty slots at one byte each, plus the leaf script with its 3-byte length prefix,
plus the 1-byte control block with its own, plus the stack-item count.

**Transaction.** For 1 input and 2 P2MR outputs — and note that the segwit marker and flag
belong to `total`, never to `stripped`:

```
stripped = 4 + varint(1) + 41 + varint(2) + 2×43 + 4  = 137
total    = stripped + 2 + witness
weight   = stripped × 15 + total
vsize    = ceil(weight / 16)
```

| spend | leaf script | witness | weight | vsize | vs single-key |
|---|---|---|---|---|---|
| single-key | 1316 B | 3746 B | 5940 | **372 vB** | 1.00× |
| 2-of-2 | 2641 B | 7495 B | 9689 | **606 vB** | 1.63× |
| 2-of-3 | 3960 B | 8815 B | 11009 | **689 vB** | 1.85× |
| 3-of-5 | 6598 B | 13878 B | 16072 | **1005 vB** | 2.70× |
| 20-of-20 (max) | 26384 B | 74870 B | 77064 | **4817 vB** | 12.95× |

The single-key row is not a new calculation; it reproduces the wallet's already-verified
constants exactly — `P2MR_WITNESS_BYTES = 3746` (`src/core/tx/fee.ts:23`) and
`P2MR_INPUT_WEIGHT = 41 × 16 + 3746 = 4402` (`:20`) — which is what ties the rest of the
table to something checked against consensus. Two of these rows were wrong in an earlier
draft, and both were caught by recomputing rather than by reading. That is the argument for
printing the derivation next to the figures.

**The comparison that matters.** At Bitcoin's scale factor of 4, the same 2-of-3 witness
alone would contribute ~2204 vB instead of ~551. Post-quantum multisig is economically
viable on BTQ *specifically because* the chain chose 16. That is the strongest argument in
this document for BTQ's parameter choice, and it only becomes visible when you look at
multisig.

**All rows are standard and relayable**, which is worth checking rather than assuming,
because the 20-of-20 leaf is 26384 bytes and
`MAX_STANDARD_TAPSCRIPT_STACK_ITEM_SIZE = 15000` (`src/policy/policy.h:48`). The reason it
passes: for a witness-v2 P2MR spend, `IsWitnessStandard` pops the control block and the leaf
script off the stack *before* applying the per-item size limit
(`src/policy/policy.cpp:302-308`), so the limit applies only to signatures (2421 B) and
empty slots. The leaf is bounded instead by `MAX_SCRIPT_SIZE = 100000`
(`src/script/script.h:43`). And the 15000 itself was raised from Bitcoin's 520 precisely to
carry these objects (`src/script/script.h:25-29`).

Two limits that sound binding and are not:

- **`MAX_OPS_PER_SCRIPT` (201) is not enforced under P2MR tapscript.** The op counter is
  incremented only for `SigVersion::BASE` and `WITNESS_V0`
  (`src/script/interpreter.cpp:503-508`), per BIP342. A 20-key accumulator runs 81
  non-push opcodes — four per key plus `OP_GREATERTHANOREQUAL` — so it would clear 201
  anyway; the point is that the ceiling is not there to clear.
- **The validation-weight budget does not bind.** The budget is witness size + 50
  (`src/script/script.h:70`) and each passing Dilithium signature costs 500
  (`src/script/script.h:67`). Each signature *adds* 2424 bytes to the budget and *spends*
  500 — a 4.8× margin that grows with every signature — and empty slots add a byte and cost
  nothing (`src/script/interpreter.cpp:126`).

**Inputs per transaction.** The fixed overhead is charged once per transaction, not once
per input, which is the easy mistake here. For n inputs and 2 outputs,
`stripped = 95 + varint(n) + 41n`, so

```
weight = 16 × (95 + varint(n)) + 2 + n × (41 × 16 + witness)
       = 1538 + n × (656 + witness)        for n ≤ 252
```

against `MAX_STANDARD_TX_WEIGHT = 400000` (`src/policy/policy.h:30`):

| input type | marginal WU | max inputs |
|---|---|---|
| single-key | 4402 | **90** |
| 2-of-3 | 9471 | **42** |
| 3-of-5 | 14534 | **27** |

**The single-key row is the reason to believe the other two.** 4402 is
`P2MR_INPUT_WEIGHT` (`src/core/tx/fee.ts:20`) and 90 is `MAX_P2MR_INPUTS`
(`src/core/tx/fee.ts:24`) — both shipping constants, checked against consensus long before
this document existed. A formula that reproduces them exactly is a formula that can be
trusted on rows nothing has verified yet. Prefer that check to asserting 42 as a magic
number.

A sibling spike implements `thresholdWitnessBytes(m, n)` in `src/core/tx/fee.ts` and
asserts this table, including that the degenerate 1-of-1 case reproduces 3746. That is
arithmetic proved against a verified constant, not a multisig feature.

---

## 11. A concrete upstream proposal: PSBT key types `0x1C` and `0x1D`

btq-core's PSBT extension defines three input fields for P2MR Dilithium material
(`src/psbt.h:52-54`):

| const | byte | key | value |
|---|---|---|---|
| `PSBT_IN_P2MR_LEAF_SCRIPT` | `0x19` | `0x19 ‖ control_block` | `leaf_script ‖ leaf_version` |
| `PSBT_IN_P2MR_MERKLE_ROOT` | `0x1A` | `0x1A` (1 byte) | 32-byte merkle root |
| `PSBT_IN_P2MR_DILITHIUM_SCRIPT_SIG` | `0x1B` | `0x1B ‖ pubkey(1312) ‖ leaf_hash(32)` = 1345 B | signature, exactly 2421 B |

The `0x1B` design is good and worth stating explicitly because the proposal below copies
it: a signature binds to a leaf through the 32-byte `leaf_hash` in the *wire key*, so one
key can sign different leaves of the same tree without collision, and a combiner needs no
lookup table because the full public key rides in the key
(`src/psbt.h:756-781`).

And then, in a comment (`src/psbt.h:55`):

```c
// 0x1C and 0x1D are reserved for Dilithium BIP32 derivation and pubkey hints.
```

Reserved, named, unimplemented. Earmarked for precisely the two things this design needs.
Below is a concrete encoding, grounded in the batch pre-share model of §6.

### `PSBT_IN_P2MR_DILITHIUM_BIP32_DERIVATION = 0x1C`

```
key:   0x1C ‖ pubkey (1312 bytes)                       — 1313 bytes
value: master_key_fingerprint (4) ‖ path[] (4·depth, LE uint32 each)
```

The BIP32 shape from `PSBT_IN_BIP32_DERIVATION`, with the 33-byte secp256k1 key replaced by
the 1312-byte ML-DSA key — the same substitution `0x1B` already makes.

The semantics differ from Bitcoin's in one way that must be documented rather than assumed:
**this field is a locator, not a derivation instruction.** On Bitcoin a signer can be handed
an xpub and a path and produce the key. Here the path only tells a wallet *which of its own
hardened keys* to regenerate, and only a wallet holding that seed can act on it. To anyone
else it is an opaque hint. Every path component is hardened by definition
(`src/crypto/dilithium_key.cpp:416-424`), so the hardened bit carries no information and the
encoding could in principle drop it — but keeping the BIP32 wire format identical is worth
more than one bit per component, and it means existing PSBT tooling can display the path
without special-casing BTQ.

What it buys: a public key does not say which index produced it, and on BTQ nothing can
recover that association from the key alone. A cosigner handed a PSBT for a multisig
address must therefore find which of its own K pre-shared keys is in the leaf, and today
the only way is to hold a persisted pubkey→index map, or to regenerate up to K ML-DSA
keypairs in the service worker and compare. The map is exactly the state §4 says has no
portable form and §6 says cannot go in the backup file — so a wallet that lost it, or was
restored from seed alone, has to brute-force its own pool to sign a transaction it can
otherwise fully verify.

With `0x1C` the PSBT carries the index. Signing becomes a fingerprint comparison and one
derivation, and it works on a wallet holding nothing but its seed. That is not a
performance tweak; on a chain with no descriptor language it is the difference between a
recoverable multisig wallet and one that depends on a file.

### `PSBT_IN_P2MR_DILITHIUM_PUBKEY = 0x1D`

```
key:   0x1D ‖ leaf_hash (32 bytes)                      — 33 bytes
value: threshold_m (compact size) ‖ n (compact size) ‖ pubkey[n] (1312 bytes each)
```

The n public keys of a leaf's threshold policy, in **script order** — index 0 evaluated
first, matching `P2MRDilithiumLeafPolicy::pubkeys` (`src/script/dilithium_leaf.h:38-39`).

The keys are already implicit in the leaf script that `0x19` carries. The value of stating
them separately is that it makes the policy *checkable without parsing script*, which is
what a combiner and a UI actually need:

- A **combiner** can reject a partial signature from a key that is not in the policy, and
  can report m-of-n progress, without linking a script parser.
- A **signing UI** can display "2 of 3 — you are cosigner 2, Bob has signed" from the PSBT
  alone.
- A **verifier** can check the batch pre-share invariant: every key in the policy is one of
  the keys enrolled at setup. Combined with the commit-and-reveal option in §6, this is
  checkable against a merkle root without holding all K keys.

Keyed by `leaf_hash` rather than by leaf script so it collides with nothing in a
multi-leaf tree, and so it composes with `0x1B`, which is already keyed on the same
32-byte value.

**A field like this must never be trusted over the script.** A parser must recompute
`ParseP2MRDilithiumLeaf` on the leaf from `0x19` and reject the PSBT if `0x1D` disagrees —
otherwise the field is an attack surface that lets a coordinator misrepresent the policy to
a UI while the script says something else. The field is a *cache*, and it should be
specified as one. The allocation bound comes for free: `MAX_PUBKEYS_PER_MULTISIG = 20`
(`src/script/script.h:35`) already caps n, enforced by the leaf parser itself
(`src/script/dilithium_leaf.cpp:60`), so the value can never exceed ~26 KB.

### Why propose them at all

Both fields are pure optimizations — a correct implementation works without either, because
`0x19` already carries the script and the script already carries the keys. That is exactly
what makes them safe to standardize now: they cannot change what a transaction means, only
what a wallet can do without guessing. And a reserved byte with a name in a comment is an
invitation. Two implementations that fill it in differently is the expensive outcome.

---

*Verify anything here against the sources cited. Constants and their btq-core lines:
[`docs/REFERENCE.md`](REFERENCE.md). The 95-row BTQ-vs-Bitcoin difference map:
[`docs/BTQ_CORE_MAP.md`](BTQ_CORE_MAP.md). The trust boundary this design must not weaken:
[`SECURITY.md`](../SECURITY.md).*
