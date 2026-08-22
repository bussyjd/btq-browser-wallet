/**
 * The content relay (isolated world) is the only bridge a web page has to the
 * wallet. This drives the shipped file — src/content/index.ts — with a fake
 * window and a fake chrome.*, because "a page cannot reach wallet.*" is a claim
 * about the running relay, not about a regex over its source.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeChrome, uninstallChrome } from '../helpers/fake-chrome.js';
import { PAGE_METHODS } from '../../src/core/connect/permissions.js';

const PAGE_ORIGIN = 'https://dapp.example';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const RELAY_SRC = join(ROOT, 'src/content/index.ts');

interface Posted {
  data: Record<string, unknown>;
  target: string;
}

class FakeWindow {
  readonly location = { origin: PAGE_ORIGIN };
  readonly handlers: ((event: unknown) => void)[] = [];
  readonly posted: Posted[] = [];

  addEventListener(type: string, fn: (event: unknown) => void): void {
    if (type === 'message') this.handlers.push(fn);
  }

  removeEventListener(): void {
    /* unused */
  }

  postMessage(data: Record<string, unknown>, target: string): void {
    this.posted.push({ data, target });
  }

  /** A message that really came from this page. */
  deliver(data: unknown, over: { origin?: string; source?: unknown } = {}): void {
    const event = { data, origin: over.origin ?? PAGE_ORIGIN, source: 'source' in over ? over.source : this };
    for (const fn of this.handlers) fn(event);
  }
}

let chromeFake: FakeChrome;
let win: FakeWindow;

beforeEach(async () => {
  chromeFake = new FakeChrome();
  chromeFake.install();
  win = new FakeWindow();
  (globalThis as { window?: unknown }).window = win;
  vi.resetModules();
  await import('../../src/content/index.js');
});

afterEach(() => {
  uninstallChrome();
  delete (globalThis as { window?: unknown }).window;
});

function request(method: string, params?: unknown, id = 1): void {
  win.deliver({ channel: 'btq-wallet', id, kind: 'request', method, params });
}

/** Deliver a runtime message the way the service worker broadcasts events. */
function workerEvent(message: unknown): void {
  for (const listener of chromeFake.messageListeners) listener(message, { id: chromeFake.extensionId }, () => {});
}

describe('content relay: what the page may ask for', () => {
  it('forwards only the three page.* methods', () => {
    for (const method of PAGE_METHODS) {
      chromeFake.outbox.length = 0;
      request(method);
      expect(chromeFake.outbox, method).toHaveLength(1);
      expect(chromeFake.outbox[0]?.message).toEqual({ method, params: undefined });
    }
  });

  it('spells out the same allowlist as the worker, and stays import-free', () => {
    // What the user loses otherwise: with any import, the bundler ships the
    // content script as a loader that dynamic-imports the real chunk, so the
    // message listener registers milliseconds after document_start. A page that
    // calls window.btq.request() from an inline script at the top of the
    // document posts into a void and the promise never settles.
    const src = readFileSync(RELAY_SRC, 'utf8');
    expect(src, 'the relay must not import anything').not.toMatch(/^\s*import\s/m);
    const listed = [...src.matchAll(/'(page\.[a-zA-Z]+)'/g)].map((m) => m[1]);
    expect(new Set(listed)).toEqual(new Set(PAGE_METHODS));
  });

  it('ships as a standalone content script, not a dynamic-import loader', () => {
    const manifestFile = join(ROOT, 'dist', 'manifest.json');
    if (!existsSync(manifestFile)) {
      // dist/ is gitignored, so a fresh clone has not built yet. CI must build first.
      if (process.env.CI) {
        throw new Error('dist/ is missing — run `npm run build` before `npm test` so this check can run');
      }
      return;
    }
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
      content_scripts: { js: string[]; world?: string }[];
    };
    const isolated = manifest.content_scripts.find((c) => c.world === undefined);
    expect(isolated, 'dist manifest keeps the isolated-world relay').toBeTruthy();
    const code = readFileSync(join(ROOT, 'dist', isolated!.js[0]!), 'utf8');
    expect(code, 'a loader would register the listener after document_start').not.toMatch(/\bimport\s*\(/);
    expect(code).toMatch(/addEventListener\("message"/);
    expect(code).toMatch(/page\.requestAccounts/);
  });

  it('refuses wallet.* and anything else without touching the worker', () => {
    for (const method of ['wallet.unlock', 'wallet.confirmSend', 'wallet.status', 'page.evil', '__proto__']) {
      win.posted.length = 0;
      chromeFake.outbox.length = 0;
      request(method, { password: 'guess' });
      expect(chromeFake.outbox, `${method} must never reach the worker`).toHaveLength(0);
      expect(win.posted[0]?.data).toEqual({
        channel: 'btq-wallet',
        id: 1,
        kind: 'response',
        error: 'This method is not available to pages.',
        code: 'FORBIDDEN',
      });
    }
  });

  it('ignores messages from another window, another origin, or a forged response', () => {
    win.deliver({ channel: 'btq-wallet', id: 1, kind: 'request', method: 'page.getAccounts' }, { source: {} });
    win.deliver(
      { channel: 'btq-wallet', id: 2, kind: 'request', method: 'page.getAccounts' },
      { origin: 'https://evil.example' },
    );
    win.deliver({ channel: 'btq-wallet', id: 3, kind: 'response', result: { accounts: ['forged'] } });
    win.deliver({ channel: 'other-wallet', id: 4, kind: 'request', method: 'page.getAccounts' });
    expect(chromeFake.outbox).toHaveLength(0);
    expect(win.posted).toHaveLength(0);
  });

  it('passes the worker result and the error code back to the page', () => {
    request('page.getAccounts');
    chromeFake.outbox[0]?.respond({ result: { accounts: ['tbtq1zexample'] } });
    expect(win.posted[0]).toEqual({
      data: { channel: 'btq-wallet', id: 1, kind: 'response', result: { accounts: ['tbtq1zexample'] }, error: undefined, code: undefined },
      target: PAGE_ORIGIN,
    });

    win.posted.length = 0;
    request('page.requestAccounts', undefined, 2);
    chromeFake.outbox[1]?.respond({ error: 'User rejected the request.', code: 'USER_REJECTED' });
    expect(win.posted[0]?.data).toEqual({
      channel: 'btq-wallet',
      id: 2,
      kind: 'response',
      result: undefined,
      error: 'User rejected the request.',
      code: 'USER_REJECTED',
    });
  });

  it('reports a dead worker instead of resolving with nothing', () => {
    request('page.requestAccounts');
    chromeFake.outbox[0]?.respond(undefined, { message: 'The message port closed before a response was received.' });
    expect(win.posted[0]?.data).toMatchObject({ code: 'DISCONNECTED' });
    expect(win.posted[0]?.data.result).toBeUndefined();
  });
});

describe('content relay: wallet events', () => {
  it('forwards accountsChanged for this page origin only', () => {
    workerEvent({ channel: 'btq-wallet', kind: 'event', event: 'accountsChanged', origin: PAGE_ORIGIN, accounts: [] });
    expect(win.posted).toHaveLength(1);
    expect(win.posted[0]?.data).toEqual({
      channel: 'btq-wallet',
      kind: 'event',
      event: 'accountsChanged',
      accounts: [],
    });

    win.posted.length = 0;
    workerEvent({
      channel: 'btq-wallet',
      kind: 'event',
      event: 'accountsChanged',
      origin: 'https://other.example',
      accounts: ['tbtq1zsomebodyelse'],
    });
    workerEvent({ channel: 'btq-wallet', kind: 'event', event: 'somethingElse', origin: PAGE_ORIGIN });
    workerEvent({ channel: 'other', kind: 'event', event: 'accountsChanged', origin: PAGE_ORIGIN });
    expect(win.posted, 'another site’s revocation is not this page’s business').toHaveLength(0);
  });
});
