# Recorded explorer responses (2026-08-21)

Captured from `https://explorer.bitcoinquantum.com` with plain GETs. Each file is
`{ status, body, _recorded, _source }`. They pin the wire shapes our parsers accept:

| File | Route | Notes |
|---|---|---|
| `address-used.json` | `/api/v1/address/{a}` | string sats; `balance` can be **negative** on the live indexer — never trust it, sum `/utxos` instead |
| `address-utxos.json` | `/api/v1/address/{a}/utxos?limit=3` | `script_pub_key` is Node-Buffer JSON; `spent_txid` null = unspent; paging is `offset`/`limit` (no `page`, no `total`) |
| `address-txs-page1.json` | `/api/v1/address/{a}/txs?limit=5` | paged `page`/`limit` (max 100), `total` present; `value_change` is signed |
| `address-unused.json` | `/api/v1/address/{a}` | **404** `{error:"Address not found"}` for a never-seen address |
| `address-unused-utxos.json` / `-txs.json` | | 200 with empty `items` |
| `blocks-tip.json` | `/api/v1/blocks/tip` | tip height for confirmations |
| `tx.json` | `/api/v1/tx/{txid}` | outputs carry hex `script_pub_key` + `addresses[]`; inputs may have null value/address |
| `tx-unknown.json` | `/api/v1/tx/{txid}` | 404 for unknown/unindexed |
| `mempool-summary.json` | `/api/v1/mempool/summary` | |

There is **no broadcast route**: `POST /api/v1/tx/send` → 404 `Route POST:/api/v1/tx/send not found`
(GET returns 400 only because it matches `/tx/:txid`). Broadcast goes through a BTQ Core node.
