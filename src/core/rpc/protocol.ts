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
 * Two methods carry the wallet as a *file*, and they are not a fourth and fifth
 * exception to the rule above — they are the other side of it.
 * `wallet.exportBackup` returns the `BTQ1` envelope: PBKDF2-SHA256 and
 * AES-256-GCM over the seed and the account list, sealed under the password the
 * caller just re-typed, and `wallet.importBackup` takes one back on a device
 * with no vault. What crosses the channel is ciphertext, so the line is where it
 * always was and is now easier to state: cleartext key material is *revealed*,
 * on one screen, now, and is never written anywhere; a sealed blob is
 * *exported*, because the account list is metadata no phrase can carry and a
 * user who cannot keep it cannot get their accounts back. Neither word may be
 * used for the other's job.
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
  'wallet.exportBackup',
  'wallet.importBackup',
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
