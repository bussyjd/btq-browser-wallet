import {
  basicAuthHeader,
  jsonRpcRequest,
  parseBlockHash,
  parseBlockchainInfo,
  parseJsonRpc,
  parseSendRawResult,
} from '../core/network/jsonrpc.js';
import type { NodeEndpoint } from '../core/network/backend.js';
import { BroadcastError, WalletError } from '../core/wallet/errors.js';

export async function nodeCall(
  node: NodeEndpoint,
  method: string,
  params: unknown[],
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
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

export async function testNode(
  node: NodeEndpoint,
  fetchFn: typeof fetch = fetch,
): Promise<{ chain: string; blocks: number; bestblockhash?: string }> {
  const result = await nodeCall(node, 'getblockchaininfo', [], fetchFn);
  return parseBlockchainInfo(result);
}

/** The node's hash at a height — how we prove it is on the explorer's chain. */
export async function nodeBlockHashAt(
  node: NodeEndpoint,
  height: number,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  try {
    return parseBlockHash(await nodeCall(node, 'getblockhash', [height], fetchFn));
  } catch (e) {
    // "Block height out of range" just means the node is behind; that is a
    // different (and reportable) condition from a fork, so do not throw.
    if (e instanceof WalletError && /out of range/i.test(e.message)) return null;
    throw e;
  }
}

export function nodeBroadcast(
  getNode: () => Promise<NodeEndpoint | null>,
  fetchFn: typeof fetch = fetch,
): (hex: string) => Promise<{ txid: string; via: 'node' }> {
  return async (hex) => {
    const node = await getNode();
    if (!node) throw new BroadcastError('No node RPC configured.', null, true);
    let accepted: unknown;
    try {
      accepted = await nodeCall(node, 'testmempoolaccept', [[hex]], fetchFn);
    } catch (e) {
      throw new BroadcastError(e instanceof Error ? e.message : 'Node rejected the transaction.', 'node');
    }
    if (Array.isArray(accepted) && accepted[0] && typeof accepted[0] === 'object') {
      const row = accepted[0] as { allowed?: boolean; 'reject-reason'?: string };
      if (row.allowed === false) {
        // btq-core's policy text ("min relay fee not met",
        // "bad-txns-inputs-missingorspent", "txn-mempool-conflict") is the only
        // signal a user has about why the payment did not go out.
        throw new BroadcastError(row['reject-reason'] ?? 'Node rejected the transaction.', 'node');
      }
    }
    try {
      const result = await nodeCall(node, 'sendrawtransaction', [hex], fetchFn);
      return { ...parseSendRawResult(result), via: 'node' as const };
    } catch (e) {
      throw new BroadcastError(e instanceof Error ? e.message : 'Node rejected the transaction.', 'node');
    }
  };
}
