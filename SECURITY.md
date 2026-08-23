# Security model

> **Unofficial, unaudited, testnet only.** An independent project, not affiliated with or
> endorsed by Bitcoin Quantum. No third-party audit has been done.
> Use it with testnet keys and testnet coins only — never a mainnet seed, never real funds.

This wallet holds ML-DSA-44 seeds. Treat it like key-handling software, not a demo.

## Reporting a vulnerability

Report privately on GitHub: **Security → Advisories → Report a vulnerability** on this
repository. If private advisories are not available to you, open an issue saying only that
you have found something and asking for a private channel — no details in the issue.

There is no monitored email address for this project, and no bug bounty. Responses are
best-effort. A vulnerability in btq-core itself belongs with
[btq-ag/btq-core](https://github.com/btq-ag/btq-core), not here.

## Trust boundary

- The HD seed — and the BIP39 entropy it was derived from, which the vault seals in the
  same ciphertext — decrypt **only** in the MV3 service worker, and **only** while
  unlocked. Locking, an auto-lock, or a service-worker restart drops them. The phrase is
  regenerated from that entropy when it is asked for and let go again; it is never cached,
  in the worker or anywhere else, because a JavaScript string cannot be zeroed.
- The content script and `window.btq` never receive phrase or key material at all. The
  popup receives the twelve words exactly twice — from `wallet.create` during onboarding,
  and from `wallet.revealPhrase` once the password has been re-typed — and never receives
  the entropy or a secret key. Both times the words live in one screen's component state
  and die with the screen. Signing happens in the worker; the popup sends intent and a
  password.
- It receives the **HD seed** on one method and one only: `wallet.revealSeedHex`, behind
  the same re-typed password, for the one wallet that has no phrase to show — a raw
  32-byte import. Offering it a greyed-out button instead would have left a wallet whose
  backup cannot be got at,
  which is not a security property but a lost-coins one. It is offered *instead of* the
  phrase control, never as well — `wallet.status.backup` names the one control the popup
  may render — and the hex is checked against the seed the worker is actually deriving
  from before it reaches the screen. It lives in one screen's state, like the words.
- The provider is installed as a **MAIN-world content script** with a frozen,
  non-configurable surface — `isBtq`, `request`, `on`, `removeListener`, nothing else. It
  holds no `chrome.*` handle, so a page that compromises it gains no extension privilege.
  The isolated-world relay forwards only allowlisted `page.*` methods, and only for
  messages whose `event.source` is this window and whose `event.origin` is this origin.
- `chrome.storage.local` holds an AES-256-GCM vault blob (PBKDF2-SHA256, 600 000
  iterations) plus public metadata: gap cursors, activity, connected origins, backend
  settings. That blob is the only place the seed and the entropy exist at rest, and only
  sealed: tests scan the serialized blob for the seed bytes, for the entropy hex, and for
  the words a reveal just returned.

## What we refuse

- **Wrong password:** one error, the wallet stays locked, and after 5 failures unlock and
  re-auth back off exponentially (in memory, capped at 5 minutes).
- **The phrase without the password:** `wallet.revealPhrase` needs a wallet that is
  already unlocked **and** the password re-typed against the sealed vault. A wrong one
  counts against the same back-off as a wrong unlock and names nothing but the password.
  There is no copy button on that screen, or on any screen that shows a phrase or a seed.
  A wallet imported from a raw 32-byte seed refuses with `NO_PHRASE` rather than
  manufacture words for a different wallet — and words that are shown are checked to
  re-derive *this* vault's HD seed before they reach the screen. That wallet is shown its
  HD seed instead, under the same conditions. There are only ever these two, because the
  vault payload holds `origin` and the sealed entropy together: a wallet that says it came
  from a phrase can always produce one.
- **A vault this build cannot read:** one payload version exists, and a payload from the
  pre-2 development build is refused with `VAULT_TOO_OLD` — its own code and its own copy,
  reached only after the password has opened the ciphertext, and only once the payload has
  been parsed far enough to be recognised as ours and intact. Corrupt or foreign bytes
  still get the one non-oracle `NOT_A_VAULT`, because "remove this wallet and import it
  again" is the wrong instruction to give somebody whose vault is merely damaged. The
  wallet is never deleted on the wallet's initiative: the refusal explains, and the DELETE
  confirmation on that same screen stays the user's to type.
- **Locked state:** cannot sign, derive, list history, or show the phrase or the seed.
  Either reveal refuses a locked wallet even with the right password, and never unlocks
  one as a side effect. `wallet.status.backup` is `null` whenever locked, so a locked
  popup learns nothing about what the vault could show. There is still no export method:
  the wallet will not write the seed or the phrase to a file, the clipboard or anything
  else — `reveal` means on the screen, now, and nowhere else.
- **Pages:** cannot call `wallet.*` — send, unlock, confirm, `revealPhrase` and
  `revealSeedHex` are not on the relay's allowlist. Site-connect is `page.requestAccounts` / `page.getAccounts` /
  `page.disconnect`, matched on the **exact** origin the browser reports for the sender,
  never on an origin the page supplies.
- **Connect without consent:** an unapproved origin's `requestAccounts` is held, not
  answered. Approval requires a click in the extension's own window; deny, closing that
  window, or a 5-minute timeout rejects with `USER_REJECTED` (EIP-1193 `4001`). One
  pending request per origin; a second call joins the first. A locked wallet answers the
  page with `LOCKED` and opens nothing.
- **Destinations:** testnet `tbtq1z…` only. Mainnet `qbtc`, other bech32 chains, and
  legacy base58 Dilithium (`n…`) are named and rejected before signing.
- Amounts below the node's **270-sat** P2MR dust threshold, amounts above the balance, and
  transactions over 90 P2MR inputs are rejected before signing.
- A leaf that does not `commitsToProgram()` is refused, and every input's derived key and
  script must equal the one being signed (btq-core `ValidateP2MRDilithiumInput`).
- The outpoints of a pending send are reserved, so a second send cannot silently build a
  replacement for a payment already in flight. The reservation expires after 24 h.

## The explorer is untrusted input

- Every response is schema-validated; a mismatched `address` or `scriptPubKey` is a hard
  error, not a warning. Sighash amounts come from UTXOs whose scripts we re-derived
  ourselves.
- **Balance is the sum of `/utxos`**, never the address record's `balance` field — the
  live indexer returns a negative balance and a negative `unspent_count` for busy
  addresses while `/utxos` lists the real coins.
- Only `404 {"error":"Address not found"}` means "unused". A Fastify route-miss body or a
  non-JSON 404 is `EXPLORER_UNAVAILABLE` on all three address routes, so a moved or broken
  API can never be read as an empty wallet. Fetches retry transport errors and 5xx with
  backoff; a schema error is never retried.
- The transaction preview is decoded back out of the **signed bytes** — txid, weight,
  output values, output addresses, change — and refuses to display if any of it disagrees
  with the plan the user approved.

## Broadcast failures are surfaced, never swallowed

The transaction is signed before any network call. If the node rejects it or is
unreachable, the wallet keeps the signed hex in the result and in activity, shows the
node's reason verbatim, and records the status as **signed — not broadcast**, distinct
from pending. Nothing is ever reported as sent because a request happened to return 200.

The public explorer has **no broadcast route** (`POST /api/v1/tx/send` → 404). Broadcast
requires a BTQ Core JSON-RPC configured under Settings, built from `v0.5.0-testnet` and on
the explorer's chain — `Test connection` compares the node's block hash at the explorer's
tip height and refuses a fork.

## Out of scope

- Mainnet, Dilithium multisig, hardware signers, and an attacker who already runs code as
  you: a compromised OS, a malicious extension with `debugger`/`management` rights, or
  anything that can read another process's memory.
- Phishing that talks the user into revealing the phrase. This wallet used to be able to
  answer "it cannot show you your words"; since Settings → Security grew a reveal, it
  cannot. What it can say is that the reveal crosses no boundary the password did not
  already cross: the same vault, under the same password, already hands over full and
  unrevocable spend authority through the send screen. Refusing to display the words would
  have protected the coins from nobody. The one thing that genuinely got worse is
  portability — twelve English words can be photographed, read down a phone line or typed
  into another machine, and a 32-byte HD seed hex is not carried off that easily. What the
  wallet still does is **never ask for the phrase**, and never accept one outside the
  import screen, so anything prompting you to "confirm your recovery phrase" is somebody
  else talking.
- The back-off shared by unlock, re-authentication and both reveals is in memory
  only; it does not survive a service-worker restart, and it is not a substitute for a
  strong password.
- **Removing the wallet** asks for the word `DELETE` and not for the password, so the
  phrase reveal is now better guarded than the vault's deletion. The asymmetry is stated
  rather than papered over: a wipe destroys one device's copy and cannot move a coin, and
  the phrase restores the wallet afterwards — but nobody should read the reveal's password
  gate as this project's floor when the floor next to it is a typed word.
- The node's RPC user and password live in `chrome.storage.local` (not the seed vault):
  they are credentials to a server the user runs, not wallet key material, and the
  end-to-end suite asserts that this is what happens. Pages cannot read or set the
  backend; only `http(s)` endpoints are accepted, credentials in the URL are not, and
  plain `http` to a non-loopback host raises a warning that the password crosses the
  network in the clear.
