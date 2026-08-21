import {
  basicAuthHeader,
  jsonRpcRequest,
  parseBlockchainInfo,
  parseJsonRpc,
  parseSendRawResult,
} from '../core/network/jsonrpc.js';
import type { NodeEndpoint } from '../core/network/backend.js';
import { WalletError } from '../core/wallet/errors.js';

async function call(node: NodeEndpoint, method: string, params: unknown[], fetchFn: typeof fetch): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  const auth = basicAuthHeader(node.user, node.password);
  if (auth) headers.authorization = auth;
  let res: Response;
  try {
    res = await fetchFn(node.url, { method: 'POST', headers, body: jsonRpcRequest(method, params) });
  } catch {
    throw new WalletError('BAD_BACKEND', 'Could not reach the node. Check the URL and that btqd is running.');
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return parseJsonRpc(res.status, json);
}

export async function testNode(node: NodeEndpoint, fetchFn: typeof fetch = fetch): Promise<{ chain: string; blocks: number }> {
  const result = await call(node, 'getblockchaininfo', [], fetchFn);
  return parseBlockchainInfo(result);
}

export function nodeBroadcast(
  getNode: () => Promise<NodeEndpoint | null>,
  fetchFn: typeof fetch = fetch,
): (hex: string) => Promise<{ txid: string }> {
  return async (hex) => {
    const node = await getNode();
    if (!node) throw new WalletError('BROADCAST_FAILED', 'No node RPC configured.');
    const accepted = await call(node, 'testmempoolaccept', [[hex]], fetchFn);
    if (Array.isArray(accepted) && accepted[0] && typeof accepted[0] === 'object') {
      const row = accepted[0] as { allowed?: boolean; 'reject-reason'?: string };
      if (row.allowed === false) {
        throw new WalletError('BROADCAST_FAILED', row['reject-reason'] ?? 'Node rejected the transaction.');
      }
    }
    const result = await call(node, 'sendrawtransaction', [hex], fetchFn);
    return parseSendRawResult(result);
  };
}
