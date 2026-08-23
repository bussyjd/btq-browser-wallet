/**
 * Extension-page RPC. Pages and content scripts are never on this allowlist.
 *
 * Responses must not carry seed or key material. Exactly two carry phrase
 * material, both by design and both only to an extension page: `wallet.create`,
 * the reveal during onboarding, and `wallet.revealPhrase`, which re-shows the
 * words for an already-unlocked vault after the password is re-typed. There is
 * deliberately no `export*` method — the wallet refuses to write the seed or
 * the phrase to anything, and re-using that word for a screen would blur it.
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
  'wallet.revealPhrase',
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

/**
 * Key names that must never appear in an RPC result.
 *
 * This is a *key* contract, not a value one: `wallet.create` and
 * `wallet.revealPhrase` genuinely return phrase material, under the keys
 * `mnemonic` and `words` respectively. `mnemonic` stays on this list because no
 * other method may reuse the name; `words` is not on it for the same reason
 * `mnemonic` is — the two methods that carry a phrase are enumerated above, and
 * every other result is checked against these names.
 */
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
