/**
 * Explorer HTTP client. All I/O lives here; `src/core` stays pure.
 *
 * Verified live shapes (tests/fixtures/explorer, recorded 2026-08-21):
 *   /api/v1/address/{a}         200 record, 404 {error:"Address not found"} for unused
 *   /api/v1/address/{a}/utxos   200 {items:[…]}, paged with ?offset=&limit= (no `total`)
 *   /api/v1/address/{a}/txs     200 {items,total,page,limit}, `page` 1-based, limit max 100
 *   /api/v1/blocks/tip          200 {hash,height,…}
 *   POST /api/v1/tx/send        404 — the public explorer has no push route at all
 */
import { parseAddressResponse, parseTipResponse } from '../core/explorer/schema.js';
import { parseUtxoResponse, type ExplorerUtxo } from '../core/explorer/utxo.js';
import { parseHistoryPage, type HistoryItem } from '../core/explorer/history.js';
import { BROADCAST_PATH, broadcastBody, parseBroadcastResponse } from '../core/explorer/broadcast.js';
import { BroadcastError, WalletError } from '../core/wallet/errors.js';
import type { AddressLookup } from '../core/wallet/gap.js';
import { scriptForAddress } from '../core/script/address.js';
import { PUBLIC_EXPLORER } from '../core/network/backend.js';

export type ExplorerBase = string | (() => string | Promise<string>);

/** The explorer caps `limit` at 100 on /txs; use the same page size everywhere. */
export const PAGE_LIMIT = 100;
/** Bound on a hostile or broken explorer that never returns a short page. */
export const MAX_PAGES = 20;
export const REQUEST_TIMEOUT_MS = 10_000;
export const RETRY_ATTEMPTS = 3;
/** How long a fetched chain tip stays good. One BTQ block is 60 s. */
export const TIP_CACHE_MS = 30_000;

async function resolveBase(base: ExplorerBase): Promise<string> {
  const b = typeof base === 'function' ? await base() : base;
  return b.replace(/\/$/, '') || PUBLIC_EXPLORER;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * One GET with a timeout and bounded retries. Transport failures and 5xx are
 * retried; a 4xx is an answer, not an outage, and the parsers decide what it
 * means. Callers must never see a swallowed failure — an empty result would
 * read as "no coins" and silently hide funds.
 */
export async function fetchJson(
  url: string,
  fetchFn: typeof fetch,
  opts: { attempts?: number; timeoutMs?: number } = {},
): Promise<{ status: number; json: unknown }> {
  const attempts = opts.attempts ?? RETRY_ATTEMPTS;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetchFn(url, {
        headers: { accept: 'application/json' },
        ...(controller ? { signal: controller.signal } : {}),
      });
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        json = undefined;
      }
      // A 5xx is the explorer being unwell, not an answer about the address.
      if (res.status >= 500 && attempt < attempts - 1) {
        last = new WalletError('EXPLORER_UNAVAILABLE', `Explorer returned HTTP ${res.status}.`);
        await sleep(150 * 2 ** attempt);
        continue;
      }
      return { status: res.status, json };
    } catch (e) {
      last = e;
      if (attempt < attempts - 1) await sleep(150 * 2 ** attempt);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
  if (last instanceof WalletError) throw last;
  throw new WalletError('EXPLORER_UNAVAILABLE', 'Could not reach the explorer.');
}

export function explorerLookup(base: ExplorerBase = PUBLIC_EXPLORER, fetchFn: typeof fetch = fetch): AddressLookup {
  return async (address) => {
    const root = await resolveBase(base);
    const { status, json } = await fetchJson(
      `${root}/api/v1/address/${encodeURIComponent(address)}`,
      fetchFn,
    );
    return parseAddressResponse(status, json, address);
  };
}

/**
 * Every unspent output of one address. The explorer pages with `offset`/`limit`
 * and does not report a total, so we walk until a short page: stopping at the
 * first page would under-report the balance and make a legitimate send fail
 * with "not enough balance".
 */
export function explorerUtxos(
  base: ExplorerBase = PUBLIC_EXPLORER,
  fetchFn: typeof fetch = fetch,
): (address: string) => Promise<ExplorerUtxo[]> {
  return async (address) => {
    const script = scriptForAddress(address, 'testnet');
    const root = await resolveBase(base);
    const out: ExplorerUtxo[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_LIMIT;
      const { status, json } = await fetchJson(
        `${root}/api/v1/address/${encodeURIComponent(address)}/utxos?offset=${offset}&limit=${PAGE_LIMIT}`,
        fetchFn,
      );
      const rows = parseUtxoResponse(status, json, address, script);
      const rawCount = rowCount(json);
      for (const row of rows) {
        // An explorer that ignores `offset` would otherwise loop forever
        // handing back page 1; de-duplicate by outpoint.
        const key = `${row.txid}:${row.vout}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(row);
      }
      if (rawCount < PAGE_LIMIT) break;
    }
    return out;
  };
}

/**
 * Full history of one address. `/txs` defaults to 25 rows and caps at 100, so
 * reading only page 1 silently truncates the ledger of any active wallet.
 */
export function explorerHistory(
  base: ExplorerBase = PUBLIC_EXPLORER,
  fetchFn: typeof fetch = fetch,
): (address: string) => Promise<HistoryItem[]> {
  return async (address) => {
    const root = await resolveBase(base);
    const out: HistoryItem[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { status, json } = await fetchJson(
        `${root}/api/v1/address/${encodeURIComponent(address)}/txs?page=${page}&limit=${PAGE_LIMIT}`,
        fetchFn,
      );
      const parsed = parseHistoryPage(status, json, address);
      for (const row of parsed.items) {
        if (seen.has(row.txid)) continue;
        seen.add(row.txid);
        out.push(row);
      }
      const rawCount = rowCount(json);
      if (rawCount < PAGE_LIMIT) break;
      if (parsed.total !== null && page * PAGE_LIMIT >= parsed.total) break;
    }
    return out;
  };
}

/** Chain tip, cached for 30 s so a refresh burst costs one request. */
export function explorerTip(
  base: ExplorerBase = PUBLIC_EXPLORER,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): () => Promise<{ height: number; hash: string }> {
  let cached: { at: number; tip: { height: number; hash: string } } | null = null;
  return async () => {
    if (cached && now() - cached.at < TIP_CACHE_MS) return cached.tip;
    const root = await resolveBase(base);
    const { status, json } = await fetchJson(`${root}/api/v1/blocks/tip`, fetchFn);
    const tip = parseTipResponse(status, json);
    cached = { at: now(), tip };
    return tip;
  };
}

export function explorerBroadcast(
  base: ExplorerBase = PUBLIC_EXPLORER,
  fetchFn: typeof fetch = fetch,
): (hex: string) => Promise<{ txid: string; via: 'explorer' }> {
  return async (hex) => {
    const root = await resolveBase(base);
    let res: Response;
    try {
      res = await fetchFn(`${root}${BROADCAST_PATH}`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: broadcastBody(hex),
      });
    } catch {
      throw new BroadcastError('Could not reach the explorer to broadcast.', 'explorer');
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return parseBroadcastResponse(res.status, json);
  };
}

function rowCount(json: unknown): number {
  if (typeof json === 'object' && json !== null && Array.isArray((json as { items?: unknown }).items)) {
    return ((json as { items: unknown[] }).items).length;
  }
  return 0;
}
