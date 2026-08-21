# Security model

This wallet holds ML-DSA-44 seeds. Treat it like a key-custody program, not a demo.

## Trust boundary

- The HD seed decrypts **only** in the MV3 service worker, and **only** while unlocked.
- Popup, content script, and `window.btq` never receive the mnemonic, HD seed, or secret key.
- `chrome.storage.local` stores an AES-256-GCM vault blob plus public metadata (gap cursors, connected origins). Ciphertext must not contain the seed.

## What we refuse

- Wrong password: one error, wallet stays locked.
- Locked state: cannot sign, export, or derive.
- Pages: cannot call `wallet.*` (send, unlock, confirm). Site-connect is `page.requestAccounts` / `page.getAccounts` / `page.disconnect` with **exact origin** matching.
- Destinations: testnet `tbtq1z…` only. Mainnet `qbtc` and legacy `tdbt`/`dbtc` are rejected before signing.
- Dust, over-balance, and >90 P2MR inputs are rejected before signing.
- A leaf that does not `commitsToProgram()` is refused (btq-core `ValidateP2MRDilithiumInput`).
- Explorer JSON is schema-validated. A mismatched `address` or `scriptPubKey` is a hard error. Sighash amounts come from UTXOs whose scripts we re-derived, not from the address-balance field.

## Out of scope

- Mainnet, Dilithium multisig, hardware signers, and defending a compromised OS/extension-store attacker who can read process memory.
- The public explorer currently has **no broadcast POST**. Configure a Core JSON-RPC under
  Testnet (top right) for `sendrawtransaction`, or copy the signed hex.
- Node RPC user/password live in `chrome.storage.local` (not the seed vault). Pages cannot
  read or set the backend. Only http(s) endpoints; RPC credentials are not accepted in the URL.
