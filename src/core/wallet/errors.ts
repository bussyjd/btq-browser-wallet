export type WalletErrorCode =
  | 'WEAK_PASSWORD'
  | 'BAD_MNEMONIC'
  | 'BAD_WORD'
  | 'BAD_CHECKSUM'
  | 'BAD_SEED_HEX'
  /** A required RPC parameter is missing or the wrong shape. Never a password problem. */
  | 'BAD_PARAMS'
  /**
   * A PSBT is malformed, exceeds one of btq-core's parser bounds, or carries a
   * Dilithium partial signature that does not verify. One code for all three
   * because they land the user in the same place: this PSBT cannot be used, and
   * no amount of retrying or re-typing a password changes that. btq-core zeroes
   * the whole PSBT on the same failures (src/psbt_dilithium.h:64-68) rather than
   * hand back something partly trusted, and neither do we.
   */
  | 'BAD_PSBT'
  | 'WRONG_PASSWORD'
  | 'TOO_MANY_ATTEMPTS'
  | 'LOCKED'
  | 'ALREADY_EXISTS'
  | 'NO_VAULT'
  | 'NO_PENDING'
  /**
   * The wallet was imported from a raw 32-byte seed, so it holds no BIP39
   * entropy and has no phrase to show. Never a password problem, and never a
   * reason to run words back out of an HD seed.
   */
  | 'NO_PHRASE'
  | 'CONFIRM_MISMATCH'
  | 'EXPLORER_SCHEMA'
  | 'EXPLORER_UNAVAILABLE'
  | 'FORBIDDEN'
  | 'UNKNOWN_METHOD'
  /** The blob is not one of ours: corrupt, foreign, or hand-edited. */
  | 'NOT_A_VAULT'
  /**
   * The blob *is* one of ours and predates this build's vault format. Distinct
   * from `NOT_A_VAULT` because it is not damage and reads nothing like it: the
   * ciphertext opened, the password was right, and the only way on is to remove
   * the wallet and import its phrase or seed again.
   */
  | 'VAULT_TOO_OLD'
  /**
   * The file handed to `importBackup` is not a wallet backup: too big, not the
   * `BTQ1` envelope, or an envelope that opened onto something that is not a
   * backup payload. Distinct from `WRONG_PASSWORD`, the only other thing that
   * import can say, so "you picked the wrong file" never reads as "you typed
   * the wrong password" — the two send a user to opposite corners of the room.
   */
  | 'NOT_A_BACKUP'
  | 'BAD_ADDRESS'
  | 'WRONG_NETWORK'
  | 'LEGACY_DILITHIUM'
  | 'DUST'
  | 'BAD_FEE_RATE'
  | 'INSUFFICIENT'
  | 'TOO_MANY_INPUTS'
  | 'NO_COMMITMENT'
  /**
   * The plan the review card described is not the plan that would be signed
   * now: the handle is unknown or already spent, the active account moved under
   * it, one of its inputs is no longer ours to spend, or it simply sat there
   * too long. Never a password problem and never a reason to rebuild silently —
   * the whole point is that nothing is signed until the user has read the
   * numbers that will actually go on chain.
   */
  | 'PLAN_STALE'
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

