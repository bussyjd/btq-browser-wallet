import {
  defaultBackend,
  hostPermissionPattern,
  isInsecureRemote,
  isLoopbackHost,
  parseBackendInput,
  publicView,
  type BackendConfig,
  type BackendPublic,
  PUBLIC_EXPLORER,
} from '../core/network/backend.js';
import { parseTipResponse } from '../core/explorer/schema.js';
import { isRouteMiss } from '../core/explorer/parse.js';
import { WalletError } from '../core/wallet/errors.js';
import type { BackendProbe } from '../core/rpc/dispatch.js';
import { nodeBlockHashAt, testNode } from './node-rpc.js';

const BACKEND_KEY = 'backend';
/** A node this far behind the explorer cannot confirm anything we send. */
export const NODE_LAG_WARN_BLOCKS = 3;

export async function loadBackend(): Promise<BackendConfig> {
  const r = await chrome.storage.local.get(BACKEND_KEY);
  const v = r[BACKEND_KEY];
  if (!v || typeof v !== 'object') return defaultBackend();
  const o = v as Record<string, unknown>;
  try {
    return parseBackendInput({
      explorerBase: typeof o.explorerBase === 'string' ? o.explorerBase : PUBLIC_EXPLORER,
      nodeUrl: o.node && typeof o.node === 'object' ? String((o.node as { url?: string }).url ?? '') : '',
      nodeUser: o.node && typeof o.node === 'object' ? String((o.node as { user?: string }).user ?? '') : '',
      nodePassword: o.node && typeof o.node === 'object' ? String((o.node as { password?: string }).password ?? '') : '',
    });
  } catch {
    return defaultBackend();
  }
}

export async function saveBackend(cfg: BackendConfig): Promise<void> {
  await chrome.storage.local.set({ [BACKEND_KEY]: cfg });
}

async function ensureHostAccess(endpoint: string): Promise<void> {
  if (isLoopbackHost(endpoint)) return;
  const pattern = hostPermissionPattern(endpoint);
  if (!chrome.permissions?.request) return;
  const have = await chrome.permissions.contains({ origins: [pattern] });
  if (have) return;
  const ok = await chrome.permissions.request({ origins: [pattern] });
  if (!ok) {
    throw new Error(`Permission denied for ${pattern}. Allow the host when Chrome prompts.`);
  }
}

export async function applyBackend(input: {
  explorerBase?: string;
  nodeUrl?: string;
  nodeUser?: string;
  nodePassword?: string;
}): Promise<BackendPublic> {
  const cfg = parseBackendInput(input);
  const existing = await loadBackend();
  if (cfg.node && !cfg.node.password && existing.node && existing.node.url === cfg.node.url) {
    cfg.node.password = existing.node.password;
  }
  await ensureHostAccess(cfg.explorerBase);
  if (cfg.node) await ensureHostAccess(cfg.node.url);
  await saveBackend(cfg);
  return publicView(cfg);
}

/**
 * Prove the backend is usable before the user relies on it.
 *
 *  1. The explorer must answer `/api/v1/blocks/tip` with a real tip. A 404 or a
 *     route-miss body means the base URL is wrong — accepting it would leave
 *     the wallet reading an empty chain and reporting a zero balance.
 *  2. A configured node must be on the *same chain* as the explorer, not just
 *     "testnet": the public testnet forked around height 300000 and a node on
 *     the dead fork accepts and then never confirms anything.
 */
export async function probeBackend(input: {
  explorerBase?: string;
  nodeUrl?: string;
  nodeUser?: string;
  nodePassword?: string;
}): Promise<BackendProbe> {
  const cfg = parseBackendInput(input);
  await ensureHostAccess(cfg.explorerBase);

  let res: Response;
  try {
    res = await fetch(`${cfg.explorerBase}/api/v1/blocks/tip`, { headers: { accept: 'application/json' } });
  } catch {
    throw new WalletError('BAD_BACKEND', 'Could not reach that explorer. Check the URL.');
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (res.status === 404 || isRouteMiss(body)) {
    throw new WalletError(
      'BAD_BACKEND',
      `No BTQ explorer API at ${cfg.explorerBase} — /api/v1/blocks/tip returned HTTP ${res.status}.`,
    );
  }
  const tip = parseTipResponse(res.status, body);

  const out: BackendProbe = { explorer: cfg.explorerBase, explorerTip: tip.height };
  const warnings: string[] = [];
  if (isInsecureRemote(cfg.explorerBase)) {
    warnings.push('The explorer URL is plain http — requests and your addresses are visible on the network.');
  }

  if (cfg.node) {
    await ensureHostAccess(cfg.node.url);
    const info = await testNode(cfg.node);
    out.node = info;
    if (isInsecureRemote(cfg.node.url)) {
      warnings.push('The node URL is plain http to a remote host — the RPC password is sent unencrypted.');
    }
    if (info.blocks < tip.height - NODE_LAG_WARN_BLOCKS) {
      warnings.push(
        `Node is ${tip.height - info.blocks} blocks behind the explorer (node ${info.blocks}, explorer ${tip.height}). It may still be syncing.`,
      );
    } else {
      // At or past the explorer tip the node must agree on the hash there.
      const hash = await nodeBlockHashAt(cfg.node, tip.height);
      if (hash !== null && hash !== tip.hash) {
        throw new WalletError(
          'BAD_BACKEND',
          `Node is on a different chain than the explorer (v0.5.0-testnet?). At height ${tip.height} the explorer has ${tip.hash.slice(0, 12)}… and the node has ${hash.slice(0, 12)}….`,
        );
      }
    }
  }

  if (warnings.length > 0) out.warning = warnings.join(' ');
  return out;
}
