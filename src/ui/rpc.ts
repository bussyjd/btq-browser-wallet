import type { RpcErr, RpcOk } from '../core/rpc/protocol.js';

export class RpcError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

export async function rpc<T>(method: string, params?: unknown): Promise<T> {
  const res = (await chrome.runtime.sendMessage({ method, params })) as RpcOk<T> | RpcErr | undefined;
  if (!res) throw new RpcError('Extension background is not responding.');
  if ('error' in res && res.error) throw new RpcError(res.error, res.code);
  return (res as RpcOk<T>).result;
}
