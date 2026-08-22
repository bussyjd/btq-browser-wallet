import type { RpcOk, RpcResponse } from '../core/rpc/protocol.js';
import { friendlyError } from './format.js';

export class RpcError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

/**
 * The service worker auto-locks on a timer. Whichever screen is open when that
 * happens must move to Unlock instead of leaving a dead banner behind, so the
 * router registers one handler here rather than every call site checking.
 */
let lockedHandler: (() => void) | null = null;

export function onAutoLock(handler: (() => void) | null): void {
  lockedHandler = handler;
}

export async function rpc<T>(method: string, params?: unknown): Promise<T> {
  const res: RpcResponse<T> | undefined = await chrome.runtime.sendMessage({ method, params });
  if (!res) throw new RpcError('Extension background is not responding.');
  if ('error' in res && res.error) {
    if (res.code === 'LOCKED') lockedHandler?.();
    throw new RpcError(friendlyError(res.error, res.code), res.code);
  }
  return (res as RpcOk<T>).result;
}

export function errorCode(e: unknown): string | undefined {
  return e instanceof RpcError ? e.code : undefined;
}

export function errMessage(e: unknown): string {
  if (e instanceof RpcError || e instanceof Error) return e.message;
  return 'Something went wrong.';
}
