import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PAGE_ORIGIN = 'https://dapp.example';

/** The provider is declared in the manifest as a MAIN-world content script (CSP-immune). */
function injectedPathFromManifest(): string {
  const manifest = readFileSync(join(ROOT, 'src/manifest.config.ts'), 'utf8');
  const entry = manifest.match(/\{[^{}]*js:\s*\[\s*'([^']+)'\s*\][^{}]*world:\s*'MAIN'[^{}]*\}/);
  if (!entry) throw new Error('manifest has no MAIN-world content script for the provider');
  const content = readFileSync(join(ROOT, 'src/content/index.ts'), 'utf8');
  if (/chrome\.runtime\.getURL|createElement\(\s*['"]script['"]\s*\)/.test(content)) {
    throw new Error('content relay must not inject the provider via the DOM (page CSP would block it)');
  }
  return entry[1]!;
}

interface ProviderError extends Error {
  code?: number;
  data?: { code?: string };
}

interface Provider {
  isBtq?: boolean;
  request?: (args: { method: string; params?: unknown }) => Promise<unknown>;
  on?: (event: string, handler: (payload: unknown) => void) => unknown;
  removeListener?: (event: string, handler: (payload: unknown) => void) => unknown;
}

type RelayMessage = { channel?: string; id?: number; kind?: string; method?: string; params?: unknown };

/** A window that behaves enough like a page for the provider to talk through. */
class ProviderWindow {
  readonly location = { origin: PAGE_ORIGIN };
  readonly handlers: ((event: unknown) => void)[] = [];
  readonly sent: RelayMessage[] = [];
  btq?: Provider;

  addEventListener(type: string, fn: (event: unknown) => void): void {
    if (type === 'message') this.handlers.push(fn);
  }

  postMessage(data: RelayMessage): void {
    this.sent.push(data);
    this.deliver(data);
  }

  deliver(data: unknown, over: { origin?: string; source?: unknown } = {}): void {
    const event = { data, origin: over.origin ?? PAGE_ORIGIN, source: 'source' in over ? over.source : this };
    for (const fn of this.handlers) fn(event);
  }

  /** Answer the request the provider just sent, the way the relay would. */
  answer(body: { result?: unknown; error?: string; code?: string }, id?: number): void {
    const last = this.sent[this.sent.length - 1];
    this.deliver({ channel: 'btq-wallet', id: id ?? last?.id, kind: 'response', ...body });
  }

  event(name: string, payload: { accounts?: unknown }): void {
    this.deliver({ channel: 'btq-wallet', kind: 'event', event: name, ...payload });
  }
}

function providerSource(): string {
  return readFileSync(join(ROOT, injectedPathFromManifest()), 'utf8');
}

function load(code = providerSource()): { win: ProviderWindow; btq: Provider } {
  const win = new ProviderWindow();
  // The shipped file is a classic IIFE that reads `window` from its argument list.
  new Function('window', code)(win);
  if (!win.btq) throw new Error('provider did not install window.btq');
  return { win, btq: win.btq };
}

async function rejection(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (e) {
    return e as ProviderError;
  }
  throw new Error('expected the request to reject');
}

describe('inpage inject — the exact file Chrome loads as a classic script', () => {
  it('installs window.btq.request from the injected IIFE (not TypeScript)', () => {
    const rel = injectedPathFromManifest();
    expect(rel.endsWith('.js')).toBe(true);
    expect(rel.endsWith('.ts')).toBe(false);

    const srcFile = join(ROOT, rel);
    expect(existsSync(srcFile)).toBe(true);
    const code = readFileSync(srcFile, 'utf8');
    expect(code).not.toMatch(/\bexport\s*\{/);
    expect(code).not.toMatch(/\bdeclare\s+global\b/);
    expect(code).not.toMatch(/^\s*type\s+\w+\s*=/m);

    const { btq } = load(code);
    expect(btq.isBtq).toBe(true);
    expect(typeof btq.request).toBe('function');
  });

  it('exposes nothing beyond the provider surface, and cannot be swapped out', () => {
    const { win, btq } = load();
    expect(Object.keys(btq).sort()).toEqual(['isBtq', 'on', 'removeListener', 'request']);
    expect(Object.isFrozen(btq)).toBe(true);
    // A page script that loads later must not be able to replace the provider.
    expect(() => {
      win.btq = { isBtq: true };
    }).toThrow(TypeError);
    expect(() => {
      (btq as unknown as { evil: unknown }).evil = 1;
    }).toThrow(TypeError);
    expect(win.btq).toBe(btq);
  });

  it('maps the page methods onto the relay allowlist', async () => {
    const { win, btq } = load();
    const calls: [string, string][] = [
      ['btq_requestAccounts', 'page.requestAccounts'],
      ['eth_requestAccounts', 'page.requestAccounts'],
      ['btq_accounts', 'page.getAccounts'],
      ['eth_accounts', 'page.getAccounts'],
      ['btq_disconnect', 'page.disconnect'],
    ];
    for (const [outer, inner] of calls) {
      const promise = btq.request!({ method: outer });
      expect(win.sent[win.sent.length - 1]?.method, outer).toBe(inner);
      win.answer({ result: inner === 'page.disconnect' ? { ok: true } : { accounts: [] } });
      await promise;
    }
  });

  it('resolves account requests with a plain array', async () => {
    const { win, btq } = load();
    const promise = btq.request!({ method: 'btq_requestAccounts' });
    win.answer({ result: { accounts: ['tbtq1zaddress'] } });
    await expect(promise).resolves.toEqual(['tbtq1zaddress']);
  });

  it('rejects with EIP-1193 codes: 4001 rejected, 4100 locked, 4200 unsupported, 4900 unreachable', async () => {
    const { win, btq } = load();

    const unsupported = await rejection(btq.request!({ method: 'wallet.unlock', params: { password: 'guess' } }));
    expect(unsupported.code).toBe(4200);
    expect(win.sent, 'an unsupported method never reaches the relay').toHaveLength(0);

    const denied = btq.request!({ method: 'btq_requestAccounts' });
    win.answer({ error: 'User rejected the request.', code: 'USER_REJECTED' });
    const rejected = await rejection(denied);
    expect(rejected.code).toBe(4001);
    expect(rejected.message).toBe('User rejected the request.');
    expect(rejected.data?.code).toBe('USER_REJECTED');

    const whenLocked = btq.request!({ method: 'btq_requestAccounts' });
    win.answer({ error: 'Wallet is locked.', code: 'LOCKED' });
    expect((await rejection(whenLocked)).code).toBe(4100);

    const blocked = btq.request!({ method: 'btq_accounts' });
    win.answer({ error: 'This method is not available to pages.', code: 'FORBIDDEN' });
    expect((await rejection(blocked)).code).toBe(4100);

    const gone = btq.request!({ method: 'btq_accounts' });
    win.answer({ error: 'BTQ Wallet is not available right now. Try again.', code: 'DISCONNECTED' });
    expect((await rejection(gone)).code).toBe(4900);

    const odd = btq.request!({ method: 'btq_accounts' });
    win.answer({ error: 'Explorer is unavailable.', code: 'EXPLORER_UNAVAILABLE' });
    expect((await rejection(odd)).code).toBe(-32603);
  });

  it('emits accountsChanged on connect, on a wallet event, and on disconnect', async () => {
    const { win, btq } = load();
    const seen: unknown[] = [];
    const handler = (accounts: unknown) => seen.push(accounts);
    btq.on!('accountsChanged', handler);

    const empty = btq.request!({ method: 'btq_accounts' });
    win.answer({ result: { accounts: [] } });
    await empty;
    expect(seen, 'no event for a still-empty account list').toEqual([]);

    const connect = btq.request!({ method: 'btq_requestAccounts' });
    win.answer({ result: { accounts: ['tbtq1zaddress'] } });
    await connect;
    expect(seen).toEqual([['tbtq1zaddress']]);

    // A repeat answer with the same accounts is not an event.
    const again = btq.request!({ method: 'btq_accounts' });
    win.answer({ result: { accounts: ['tbtq1zaddress'] } });
    await again;
    expect(seen).toHaveLength(1);

    // The page disconnects itself.
    const bye = btq.request!({ method: 'btq_disconnect' });
    win.answer({ result: { ok: true } });
    await bye;
    expect(seen).toEqual([['tbtq1zaddress'], []]);

    // The wallet revoked the site from the popup.
    const reconnect = btq.request!({ method: 'btq_requestAccounts' });
    win.answer({ result: { accounts: ['tbtq1zaddress'] } });
    await reconnect;
    win.event('accountsChanged', { accounts: [] });
    expect(seen).toHaveLength(4);

    btq.removeListener!('accountsChanged', handler);
    win.event('accountsChanged', { accounts: ['tbtq1zaddress'] });
    expect(seen).toHaveLength(4);
  });

  it('ignores relay traffic from another window or another origin', async () => {
    const { win, btq } = load();
    const promise = btq.request!({ method: 'btq_accounts' });
    const id = win.sent[0]?.id;
    win.deliver({ channel: 'btq-wallet', id, kind: 'response', result: { accounts: ['spoofed'] } }, { source: {} });
    win.deliver(
      { channel: 'btq-wallet', id, kind: 'response', result: { accounts: ['spoofed'] } },
      { origin: 'https://evil.example' },
    );
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    win.answer({ result: { accounts: ['tbtq1zaddress'] } });
    await expect(promise).resolves.toEqual(['tbtq1zaddress']);
  });
});

describe('the built chunk Chrome actually loads', () => {
  it('keeps the MAIN world, with no extension APIs and no imports', () => {
    const distManifestFile = join(ROOT, 'dist', 'manifest.json');
    if (!existsSync(distManifestFile)) {
      // dist/ is gitignored, so a fresh clone has not built yet. CI must build first.
      if (process.env.CI) {
        throw new Error('dist/ is missing — run `npm run build` before `npm test` so this check can run');
      }
      return;
    }
    const distManifest = JSON.parse(readFileSync(distManifestFile, 'utf8')) as {
      content_scripts: { js: string[]; world?: string }[];
    };
    const main = distManifest.content_scripts.find((c) => c.world === 'MAIN');
    expect(main, 'dist manifest keeps the MAIN-world provider').toBeTruthy();
    const distCode = readFileSync(join(ROOT, 'dist', main!.js[0]!), 'utf8');
    expect(distCode).not.toMatch(/\bchrome\./);
    expect(distCode).not.toMatch(/\bimport\s*\(/);
    const { btq } = load(distCode);
    expect(btq.isBtq).toBe(true);
    expect(typeof btq.request).toBe('function');
    expect(typeof btq.on).toBe('function');
  });
});
