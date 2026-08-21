import { WalletError } from '../wallet/errors.js';

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

export function isOriginAllowed(allowed: readonly string[], origin: string): boolean {
  const want = canonicalOrigin(origin);
  return allowed.some((a) => a === want);
}

export function grantOrigin(allowed: readonly string[], origin: string): string[] {
  const want = canonicalOrigin(origin);
  return allowed.includes(want) ? [...allowed] : [...allowed, want];
}

export function revokeOrigin(allowed: readonly string[], origin: string): string[] {
  const want = canonicalOrigin(origin);
  return allowed.filter((a) => a !== want);
}

export const PAGE_METHODS = ['page.requestAccounts', 'page.getAccounts', 'page.disconnect'] as const;
export type PageMethod = (typeof PAGE_METHODS)[number];
export const PAGE_METHOD_SET: ReadonlySet<string> = new Set(PAGE_METHODS);
