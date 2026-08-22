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

- The mnemonic and the HD seed decrypt **only** in the MV3 service worker, and **only**
  while unlocked. Locking, an auto-lock, or a service-worker restart drops them.
- The popup, the content script and `window.btq` never receive the mnemonic, the HD seed
  or a secret key. Signing happens in the worker; the popup sends intent and a password.
- The provider is installed as a **MAIN-world content script** with a frozen,
  non-configurable surface — `isBtq`, `request`, `on`, `removeListener`, nothing else. It
  holds no `chrome.*` handle, so a page that compromises it gains no extension privilege.
  The isolated-world relay forwards only allowlisted `page.*` methods, and only for
  messages whose `event.source` is this window and whose `event.origin` is this origin.
- `chrome.storage.local` holds an AES-256-GCM vault blob (PBKDF2-SHA256, 600 000
  iterations) plus public metadata: gap cursors, activity, connected origins, backend
  settings. Ciphertext must not contain the seed — a test scans the serialized blob.

## What we refuse

- **Wrong password:** one error, the wallet stays locked, and after 5 failures unlock and
  re-auth back off exponentially (in memory, capped at 5 minutes).
- **Locked state:** cannot sign, export, derive, or list history.
- **Pages:** cannot call `wallet.*` — send, unlock, confirm and export are not on the
  relay's allowlist. Site-connect is `page.requestAccounts` / `page.getAccounts` /
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
- Phishing that convinces the user to type the phrase somewhere else. The wallet shows the
  phrase once and never re-displays it, but it cannot defend a user against themselves.
- The unlock back-off is in memory only; it does not survive a service-worker restart, and
  it is not a substitute for a strong password.
- The node's RPC user and password live in `chrome.storage.local` (not the seed vault):
  they are credentials to a server the user runs, not wallet key material, and the
  end-to-end suite asserts that this is what happens. Pages cannot read or set the
  backend; only `http(s)` endpoints are accepted, credentials in the URL are not, and
  plain `http` to a non-loopback host raises a warning that the password crosses the
  network in the clear.
