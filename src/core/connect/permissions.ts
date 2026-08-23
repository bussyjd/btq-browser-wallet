import { WalletError } from '../wallet/errors.js';
import { MAX_ACCOUNTS } from '../wallet/storage.js';

/** Exact origin only — never substring or startsWith. */
export function canonicalOrigin(origin: string): string {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    throw new WalletError('FORBIDDEN', 'Invalid origin.');
  }
  if (u.origin !== origin) throw new WalletError('FORBIDDEN', 'Invalid origin.');
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new WalletError('FORBIDDEN', 'Invalid origin.');
  return u.origin;
}

/**
 * One approval: this site may see *this* account's address, and no other.
 *
 * A grant used to be an origin alone, so the moment the user switched to a
 * second account — the account they made precisely to keep an identity away
 * from that site — the site was handed its address with no prompt. The account
 * is part of what the user approved, so it is part of what is stored.
 */
export interface SiteGrant {
  origin: string;
  account: number;
}

/**
 * Wire form of a grant. Account 0 is stored as the bare origin: it is what every
 * grant written before this feature meant (there was only one account), so an
 * old record reads correctly and an older build still understands ours. Any
 * other account is `origin#index`; `#` cannot occur in a canonical origin, so
 * the two forms can never be confused.
 */
export function grantKey(origin: string, account: number): string {
  const o = canonicalOrigin(origin);
  assertAccount(account);
  return account === 0 ? o : `${o}#${account}`;
}

function assertAccount(account: number): void {
  if (!Number.isInteger(account) || account < 0 || account >= MAX_ACCOUNTS) {
    throw new WalletError('BAD_PARAMS', 'Unknown account.');
  }
}

/** Parse one stored entry. Anything malformed is dropped, never widened. */
export function parseGrant(raw: unknown): SiteGrant | null {
  if (typeof raw !== 'string') return null;
  const hash = raw.indexOf('#');
  const originPart = hash === -1 ? raw : raw.slice(0, hash);
  const accountPart = hash === -1 ? '0' : raw.slice(hash + 1);
  if (!/^\d{1,2}$/.test(accountPart)) return null;
  const account = Number(accountPart);
  if (!Number.isInteger(account) || account < 0 || account >= MAX_ACCOUNTS) return null;
  let origin: string;
  try {
    origin = canonicalOrigin(originPart);
  } catch {
    return null;
  }
  return { origin, account };
}

export function parseGrants(stored: readonly string[]): SiteGrant[] {
  const out: SiteGrant[] = [];
  const seen = new Set<string>();
  for (const raw of stored) {
    const grant = parseGrant(raw);
    if (!grant) continue;
    const key = `${grant.origin}#${grant.account}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(grant);
  }
  return out;
}

/** Is *this* pair approved? An origin approved for another account is not. */
export function isGranted(stored: readonly string[], origin: string, account: number): boolean {
  const want = canonicalOrigin(origin);
  return parseGrants(stored).some((g) => g.origin === want && g.account === account);
}

export function grantSite(stored: readonly string[], origin: string, account: number): string[] {
  const key = grantKey(origin, account);
  return stored.includes(key) ? [...stored] : [...stored, key];
}

/**
 * Drop a grant. With `account` given it drops that one pair — the Settings row
 * the user clicked Revoke on. Without it the origin loses every account it was
 * ever granted, which is what "Disconnect" from the page itself means.
 */
export function revokeGrant(stored: readonly string[], origin: string, account?: number): string[] {
  const want = canonicalOrigin(origin);
  if (account !== undefined) assertAccount(account);
  return stored.filter((raw) => {
    const grant = parseGrant(raw);
    // A malformed entry is dropped rather than kept: it can never authorise
    // anything, and keeping it would let junk accumulate in the allowlist.
    if (!grant) return false;
    if (grant.origin !== want) return true;
    return account !== undefined && grant.account !== account;
  });
}

export const PAGE_METHODS = ['page.requestAccounts', 'page.getAccounts', 'page.disconnect'] as const;
export const PAGE_METHOD_SET: ReadonlySet<string> = new Set(PAGE_METHODS);
