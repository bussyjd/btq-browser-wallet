export type WalletErrorCode =
  | 'WEAK_PASSWORD'
  | 'BAD_MNEMONIC'
  | 'BAD_WORD'
  | 'BAD_CHECKSUM'
  | 'BAD_SEED_HEX'
  | 'BAD_PASSWORD'
  | 'WRONG_PASSWORD'
  | 'LOCKED'
  | 'ALREADY_EXISTS'
  | 'NO_VAULT'
  | 'NO_PENDING'
  | 'CONFIRM_MISMATCH'
  | 'EXPLORER_SCHEMA'
  | 'EXPLORER_UNAVAILABLE'
  | 'FORBIDDEN'
  | 'UNKNOWN_METHOD'
  | 'NOT_A_VAULT'
  | 'BAD_ADDRESS'
  | 'WRONG_NETWORK'
  | 'LEGACY_DILITHIUM'
  | 'DUST'
  | 'INSUFFICIENT'
  | 'TOO_MANY_INPUTS'
  | 'NO_COMMITMENT'
  | 'NOT_CONNECTED'
  | 'BROADCAST_FAILED'
  | 'BAD_BACKEND';

export class WalletError extends Error {
  readonly code: WalletErrorCode;
  constructor(code: WalletErrorCode, message: string) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

export function isWalletError(e: unknown): e is WalletError {
  return e instanceof WalletError;
}
