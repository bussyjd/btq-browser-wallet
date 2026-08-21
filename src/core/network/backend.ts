/**
 * Testnet backends. The chain (tbtq HRP) does not change; only where we
 * read history and where we push signed hex.
 *
 * Default explorer: https://explorer.bitcoinquantum.com (docs/REFERENCE.md §6)
 * Default Core RPC port on testnet: 18332 (docs/REFERENCE.md §7)
 */
import { WalletError } from '../wallet/errors.js';

export const PUBLIC_EXPLORER = 'https://explorer.bitcoinquantum.com';
export const DEFAULT_NODE_URL = 'http://127.0.0.1:18332';

export interface NodeEndpoint {
  url: string;
  user: string;
  password: string;
}

export interface BackendConfig {
  explorerBase: string;
  node: NodeEndpoint | null;
}

export interface BackendPublic {
  explorerBase: string;
  nodeUrl: string | null;
  nodeUser: string | null;
  hasNodePassword: boolean;
}

export function defaultBackend(): BackendConfig {
  return { explorerBase: PUBLIC_EXPLORER, node: null };
}

export function publicView(cfg: BackendConfig): BackendPublic {
  return {
    explorerBase: cfg.explorerBase,
    nodeUrl: cfg.node?.url ?? null,
    nodeUser: cfg.node?.user ? cfg.node.user : null,
    hasNodePassword: Boolean(cfg.node?.password),
  };
}

/** http(s) origin+path, no credentials, no hash. Trailing slash stripped. */
export function parseHttpEndpoint(raw: string, kind: 'explorer' | 'node'): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new WalletError('BAD_BACKEND', kind === 'explorer' ? 'Enter an explorer URL.' : 'Enter a node RPC URL.');
  }
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new WalletError('BAD_BACKEND', 'That is not a valid URL.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new WalletError('BAD_BACKEND', 'URL must be http or https.');
  }
  if (u.username || u.password) {
    throw new WalletError('BAD_BACKEND', 'Do not put the RPC user or password in the URL. Use the user/password fields.');
  }
  if (u.hash) throw new WalletError('BAD_BACKEND', 'URL must not include a fragment.');
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  return `${u.origin}${path}`;
}

export function parseBackendInput(input: {
  explorerBase?: string;
  nodeUrl?: string;
  nodeUser?: string;
  nodePassword?: string;
}): BackendConfig {
  const explorerBase = parseHttpEndpoint(input.explorerBase?.trim() || PUBLIC_EXPLORER, 'explorer');
  const nodeUrl = (input.nodeUrl ?? '').trim();
  if (!nodeUrl) return { explorerBase, node: null };
  const url = parseHttpEndpoint(nodeUrl, 'node');
  return {
    explorerBase,
    node: {
      url,
      user: (input.nodeUser ?? '').trim(),
      password: input.nodePassword ?? '',
    },
  };
}

export function hostPermissionPattern(endpoint: string): string {
  const u = new URL(endpoint);
  const port = u.port ? `:${u.port}` : '';
  return `${u.protocol}//${u.hostname}${port}/*`;
}

export function isLoopbackHost(endpoint: string): boolean {
  const host = new URL(endpoint).hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}
