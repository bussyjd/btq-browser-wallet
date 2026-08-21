import { parseAddressResponse } from '../core/explorer/schema.js';
import { parseUtxoResponse, type ExplorerUtxo } from '../core/explorer/utxo.js';
import { parseHistoryResponse, type HistoryItem } from '../core/explorer/history.js';
import { BROADCAST_PATH, broadcastBody, parseBroadcastResponse } from '../core/explorer/broadcast.js';
import { WalletError } from '../core/wallet/errors.js';
import type { AddressLookup } from '../core/wallet/gap.js';
import { scriptForAddress } from '../core/script/address.js';
import { PUBLIC_EXPLORER } from '../core/network/backend.js';

export type ExplorerBase = string | (() => string | Promise<string>);

async function resolveBase(base: ExplorerBase): Promise<string> {
  const b = typeof base === 'function' ? await base() : base;
  return b.replace(/\/$/, '') || PUBLIC_EXPLORER;
}

async function getJson(url: string, fetchFn: typeof fetch): Promise<{ status: number; json: unknown }> {
  const res = await fetchFn(url, { headers: { accept: 'application/json' } });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

export function explorerLookup(base: ExplorerBase = PUBLIC_EXPLORER, fetchFn: typeof fetch = fetch): AddressLookup {
  return async (address) => {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const root = await resolveBase(base);
        const { status, json } = await getJson(
          `${root}/api/v1/address/${encodeURIComponent(address)}`,
          fetchFn,
        );
        return parseAddressResponse(status, json, address);
      } catch (e) {
        if (e instanceof WalletError && e.code === 'EXPLORER_SCHEMA') throw e;
        last = e;
        await new Promise((r) => setTimeout(r, 150 * 2 ** attempt));
      }
    }
    if (last instanceof WalletError) throw last;
    throw new WalletError('EXPLORER_UNAVAILABLE', 'Could not reach the explorer.');
  };
}

export function explorerUtxos(
  base: ExplorerBase = PUBLIC_EXPLORER,
  fetchFn: typeof fetch = fetch,
): (address: string) => Promise<ExplorerUtxo[]> {
  return async (address) => {
    const script = scriptForAddress(address, 'testnet');
    const root = await resolveBase(base);
    const { status, json } = await getJson(
      `${root}/api/v1/address/${encodeURIComponent(address)}/utxos`,
      fetchFn,
    );
    return parseUtxoResponse(status, json, address, script);
  };
}

export function explorerHistory(
  base: ExplorerBase = PUBLIC_EXPLORER,
  fetchFn: typeof fetch = fetch,
): (address: string) => Promise<HistoryItem[]> {
  return async (address) => {
    const root = await resolveBase(base);
    const { status, json } = await getJson(
      `${root}/api/v1/address/${encodeURIComponent(address)}/txs`,
      fetchFn,
    );
    return parseHistoryResponse(status, json, address);
  };
}

export function explorerBroadcast(
  base: ExplorerBase = PUBLIC_EXPLORER,
  fetchFn: typeof fetch = fetch,
): (hex: string) => Promise<{ txid: string }> {
  return async (hex) => {
    const root = await resolveBase(base);
    const res = await fetchFn(`${root}${BROADCAST_PATH}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: broadcastBody(hex),
    });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return parseBroadcastResponse(res.status, json);
  };
}
