/**
 * Extension-page RPC. Pages and content scripts are never on this allowlist.
 * Responses must not carry seed, mnemonic (except the one-shot create reveal),
 * or key material.
 */
export const WALLET_METHODS = [
  'wallet.status',
  'wallet.create',
  'wallet.confirm',
  'wallet.importMnemonic',
  'wallet.importSeed',
  'wallet.unlock',
  'wallet.lock',
  'wallet.receive',
  'wallet.scan',
  'wallet.tip',
  'wallet.wipe',
  'wallet.maxSpendable',
  'wallet.prepareSend',
  'wallet.confirmSend',
  'wallet.history',
  'wallet.activity',
  'wallet.pendingConnect',
  'wallet.approveConnect',
  'wallet.denyConnect',
  'wallet.connectedSites',
  'wallet.revokeSite',
  'wallet.getBackend',
  'wallet.setBackend',
  'wallet.testBackend',
] as const;

export const WALLET_METHOD_SET: ReadonlySet<string> = new Set(WALLET_METHODS);

/** Fields that must never appear in an RPC result after the one-shot reveal. */
export const SECRET_RESULT_KEYS = [
  'hdSeed',
  'hdSeedHex',
  'seed',
  'secretKey',
  'privateKey',
  'mnemonic',
  'password',
  'plain',
] as const;

export interface RpcRequest {
  method: string;
  params?: unknown;
}

export interface RpcOk<T = unknown> {
  result: T;
}

export interface RpcErr {
  error: string;
  code?: string;
}

export type RpcResponse<T = unknown> = RpcOk<T> | RpcErr;
