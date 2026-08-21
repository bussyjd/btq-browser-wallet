import {
  defaultBackend,
  hostPermissionPattern,
  isLoopbackHost,
  parseBackendInput,
  publicView,
  type BackendConfig,
  type BackendPublic,
  PUBLIC_EXPLORER,
} from '../core/network/backend.js';
import { testNode } from './node-rpc.js';

const BACKEND_KEY = 'backend';

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

export async function probeBackend(input: {
  explorerBase?: string;
  nodeUrl?: string;
  nodeUser?: string;
  nodePassword?: string;
}): Promise<{ explorer: string; node?: { chain: string; blocks: number } }> {
  const cfg = parseBackendInput(input);
  await ensureHostAccess(cfg.explorerBase);
  const expl = await fetch(`${cfg.explorerBase}/api/v1/blocks?limit=1`, { headers: { accept: 'application/json' } });
  if (!expl.ok && expl.status !== 404) {
    throw new Error(`Explorer returned HTTP ${expl.status}.`);
  }
  const out: { explorer: string; node?: { chain: string; blocks: number } } = { explorer: cfg.explorerBase };
  if (cfg.node) {
    await ensureHostAccess(cfg.node.url);
    out.node = await testNode(cfg.node);
  }
  return out;
}
