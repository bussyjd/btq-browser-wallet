/**
 * Extension-page RPC. Pages and content scripts are never on this allowlist.
 *
 * Responses must not carry seed or key material, with three enumerated
 * exceptions — all by design, all only to an extension page, all gated on a
 * password. Two carry *phrase* material: `wallet.create`, the reveal during
 * onboarding, and `wallet.revealPhrase`, which re-shows the words for an
 * already-unlocked vault after the password is re-typed. The third,
 * `wallet.revealSeedHex`, carries the HD seed as hex — the backup for the one
 * wallet that has no phrase to show, a raw-32 import. It exists so Settings
 * never has to render a control that cannot do anything; it is offered instead
 * of the phrase, never as well.
 *
 * There is still deliberately no `export*` method: the wallet writes neither
 * the seed nor the phrase to a file, a download or the clipboard. `reveal`
 * means "on this screen, now, and nowhere else", and re-using the other word
 * for it would blur exactly that.
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
  'wallet.revealSeedHex',
  'wallet.maxSpendable',
  'wallet.prepareSend',
  'wallet.confirmSend',
  'wallet.history',
  'wallet.activity',
  'wallet.pendingConnect',
  'wallet.approveConnect',
  'wallet.denyConnect',
  'wallet.createAccount',
  'wallet.switchAccount',
  'wallet.renameAccount',
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
 * This is a *key* contract, not a value one: the three methods enumerated
 * above genuinely return secret material, under the keys `mnemonic`, `words`
 * and `seedHex`. `mnemonic` and `seedHex` stay on this list because no *other*
 * method may reuse either name; `words` is not on it for the same reason
 * `mnemonic` is — the methods that carry a phrase are enumerated above, and
 * every other result is checked against these names.
 */
export const SECRET_RESULT_KEYS = [
  'hdSeed',
  'hdSeedHex',
  'seed',
  'secretKey',
  'privateKey',
  'mnemonic',
  'seedHex',
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
