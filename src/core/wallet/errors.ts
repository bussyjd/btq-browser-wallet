export type WalletErrorCode =
  | 'WEAK_PASSWORD'
  | 'BAD_MNEMONIC'
  | 'BAD_WORD'
  | 'BAD_CHECKSUM'
  | 'BAD_SEED_HEX'
  /** A required RPC parameter is missing or the wrong shape. Never a password problem. */
  | 'BAD_PARAMS'
  | 'WRONG_PASSWORD'
  | 'TOO_MANY_ATTEMPTS'
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
  | 'BAD_FEE_RATE'
  | 'INSUFFICIENT'
  | 'TOO_MANY_INPUTS'
  | 'NO_COMMITMENT'
  | 'NOT_CONNECTED'
  | 'USER_REJECTED'
  | 'REQUEST_TIMEOUT'
  | 'BROADCAST_FAILED'
  | 'BAD_BACKEND';

export type BroadcastVia = 'node' | 'explorer' | null;

export class WalletError extends Error {
  readonly code: WalletErrorCode;
  constructor(code: WalletErrorCode, message: string) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

/**
 * A broadcast that failed, tagged with the route that was tried. The route is
 * what tells the user what to do next: the public explorer has no push route
 * at all (copy the hex out), while a node answers with btq-core policy text
 * ("min relay fee not met", "bad-txns-inputs-missingorspent", …).
 */
export class BroadcastError extends WalletError {
  readonly via: BroadcastVia;
  /** True for "this backend cannot push at all", as opposed to "it refused this tx". */
  readonly noRoute: boolean;
  constructor(message: string, via: BroadcastVia, noRoute = false) {
    super('BROADCAST_FAILED', message);
    this.name = 'BroadcastError';
    this.via = via;
    this.noRoute = noRoute;
  }
}

export function isWalletError(e: unknown): e is WalletError {
  return e instanceof WalletError;
}

