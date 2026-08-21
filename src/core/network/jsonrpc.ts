import { WalletError } from '../wallet/errors.js';
import { isRecord, parseTxid } from '../explorer/parse.js';

export function jsonRpcRequest(method: string, params: unknown[], id = 'btq'): string {
  return JSON.stringify({ jsonrpc: '1.0', id, method, params });
}

/** Decode a Bitcoin/BTQ Core JSON-RPC body. */
export function parseJsonRpc(status: number, json: unknown): unknown {
  if (status === 401) throw new WalletError('BAD_BACKEND', 'Node rejected the RPC user or password.');
  if (status === 0 || status === 502 || status === 503 || status === 504) {
    throw new WalletError('BAD_BACKEND', `Could not reach the node (HTTP ${status || 'network error'}).`);
  }
  if (!isRecord(json)) {
    throw new WalletError('BAD_BACKEND', status ? `Node returned HTTP ${status}.` : 'Node returned an empty response.');
  }
  if (json.error != null) {
    const err = json.error;
    const msg =
      isRecord(err) && typeof err.message === 'string'
        ? err.message
        : typeof err === 'string'
          ? err
          : 'Node RPC error.';
    throw new WalletError('BAD_BACKEND', msg);
  }
  if (!('result' in json)) throw new WalletError('BAD_BACKEND', 'Node RPC response is missing a result.');
  return json.result;
}

export function parseSendRawResult(result: unknown): { txid: string } {
  return { txid: parseTxid(result) };
}

export function parseBlockchainInfo(result: unknown): { chain: string; blocks: number } {
  if (!isRecord(result) || typeof result.chain !== 'string') {
    throw new WalletError('BAD_BACKEND', 'Node did not return getblockchaininfo.chain.');
  }
  const chain = result.chain;
  // This wallet derives tbtq addresses; mainnet/regtest HRPs would silently miss coins.
  if (chain === 'main') throw new WalletError('BAD_BACKEND', 'That node is mainnet. This wallet is testnet-only.');
  if (chain === 'regtest') {
    throw new WalletError('BAD_BACKEND', 'That node is regtest (qcrt addresses). This wallet uses tbtq testnet.');
  }
  if (chain !== 'test' && chain !== 'testnet') {
    throw new WalletError('BAD_BACKEND', `Unexpected chain "${chain}". Need BTQ testnet.`);
  }
  const blocks = typeof result.blocks === 'number' && Number.isInteger(result.blocks) ? result.blocks : 0;
  return { chain, blocks };
}

export function basicAuthHeader(user: string, password: string): string | null {
  if (!user && !password) return null;
  const token = btoa(`${user}:${password}`);
  return `Basic ${token}`;
}
