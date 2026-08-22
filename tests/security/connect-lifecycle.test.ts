/**
 * The site-connect state machine as the service worker really runs it: the
 * message listener in src/background/index.ts driven through a fake chrome.*.
 *
 * What an attacker or a careless refactor would gain if these stopped holding:
 * a page whose promise resolves without the user ever approving, one origin
 * settling another origin's request, or a locked wallet handing out addresses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeChrome, uninstallChrome, type Call } from '../helpers/fake-chrome.js';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'testnet-ok';
const DAPP = 'https://dapp.example';
const EVIL = 'https://evil.example';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let chromeFake: FakeChrome;
let address: string;

async function boot(): Promise<void> {
  chromeFake = new FakeChrome();
  chromeFake.install();
  vi.resetModules();
  await import('../../src/background/index.js');
}

async function ok(call: Call): Promise<unknown> {
  const reply = await call.promise;
  if (reply.error) throw new Error(`${reply.error} (${reply.code ?? 'no code'})`);
  return reply.result;
}

beforeEach(async () => {
  await boot();
  await ok(chromeFake.call({ method: 'wallet.importMnemonic', params: { mnemonic: MNEMONIC, password: PASSWORD } }));
  const receive = (await ok(chromeFake.call({ method: 'wallet.receive' }))) as { address: string };
  address = receive.address;
});

afterEach(() => {
  vi.useRealTimers();
  uninstallChrome();
});

describe('page.requestAccounts lifecycle', () => {
  it('holds the page response until the popup approves, then answers with the accounts', async () => {
    const request = chromeFake.callFromPage({ method: 'page.requestAccounts' }, DAPP);
    await flush();

    expect(request.settled, 'the page must not be answered before the user decides').toBe(false);
    expect(chromeFake.store.get('pendingConnect')).toEqual({ origin: DAPP });
    expect(chromeFake.windows).toHaveLength(1);
    expect(chromeFake.windows[0]?.url).toMatch(/src\/ui\/index\.html\?connect=1$/);
    expect(chromeFake.windows[0]?.type).toBe('popup');
    expect(chromeFake.badgeText).toBe('1');

    await ok(chromeFake.call({ method: 'wallet.approveConnect', params: { origin: DAPP } }));
    await expect(request.promise).resolves.toEqual({ result: { accounts: [address] } });
    expect(chromeFake.badgeText).toBe('');
    // The approval window we opened is closed for the user.
    expect(chromeFake.removedWindows).toEqual([chromeFake.windows[0]?.id]);
  });

  it('always opens a window, never the toolbar popup, even when openPopup would work', async () => {
    // What the user loses otherwise: the toolbar popup has no window id, so it
    // is never closed when the request settles and it vanishes on the next
    // click — which is not an answer. It is also invisible to the end-to-end
    // suite, so the approval flow could not be proven at all.
    chromeFake.openPopupFails = false;
    const request = chromeFake.callFromPage({ method: 'page.requestAccounts' }, DAPP);
    await flush();
    expect(chromeFake.openPopupCalls, 'the toolbar popup is a last resort only').toBe(0);
    expect(chromeFake.windows).toHaveLength(1);
    expect(chromeFake.windows[0]?.url).toMatch(/src\/ui\/index\.html\?connect=1$/);
    await ok(chromeFake.call({ method: 'wallet.approveConnect', params: { origin: DAPP } }));
    await expect(request.promise).resolves.toEqual({ result: { accounts: [address] } });
    expect(chromeFake.removedWindows).toEqual([chromeFake.windows[0]?.id]);
  });

  it('falls back to the toolbar popup when no window can be created', async () => {
    chromeFake.openPopupFails = false;
    chromeFake.windowCreateFails = true;
    const request = chromeFake.callFromPage({ method: 'page.requestAccounts' }, DAPP);
    await flush();
    expect(chromeFake.windows).toHaveLength(0);
    expect(chromeFake.openPopupCalls).toBe(1);
    // The prompt is still stored, so the request is answerable either way.
    expect(chromeFake.store.get('pendingConnect')).toEqual({ origin: DAPP });
    await ok(chromeFake.call({ method: 'wallet.approveConnect', params: { origin: DAPP } }));
    await expect(request.promise).resolves.toEqual({ result: { accounts: [address] } });
  });

  it('shares one approval between repeated requests from the same origin', async () => {
    const first = chromeFake.callFromPage({ method: 'page.requestAccounts' }, DAPP);
    await flush();
    const second = chromeFake.callFromPage({ method: 'page.requestAccounts' }, DAPP, 2);
    await flush();

    expect(chromeFake.windows, 'a second request must not open a second window').toHaveLength(1);
    expect(first.settled).toBe(false);
    expect(second.settled).toBe(false);

    await ok(chromeFake.call({ method: 'wallet.approveConnect', params: { origin: DAPP } }));
    await expect(first.promise).resolves.toEqual({ result: { accounts: [address] } });
    await expect(second.promise).resolves.toEqual({ result: { accounts: [address] } });
  });

  it('rejects with USER_REJECTED when the user denies', async () => {
    const request = chromeFake.callFromPage({ method: 'page.requestAccounts' }, DAPP);
    await flush();
    await ok(chromeFake.call({ method: 'wallet.denyConnect' }));
    await expect(request.promise).resolves.toEqual({
      error: 'User rejected the request.',
      code: 'USER_REJECTED',
    });
    expect(chromeFake.store.get('pendingConnect')).toBeUndefined();
    expect(chromeFake.badgeText).toBe('');
    const accounts = await ok(chromeFake.callFromPage({ method: 'page.getAccounts' }, DAPP));
    expect(accounts).toEqual({ accounts: [] });
  });

  it('treats closing the approval window as a deny and clears the stored prompt', async () => {
    const request = chromeFake.callFromPage({ method: 'page.requestAccounts' }, DAPP);
    await flush();
    const windowId = chromeFake.windows[0]?.id as number;
    chromeFake.closeWindow(windowId);
    await expect(request.promise).resolves.toEqual({
      error: 'User rejected the request.',
      code: 'USER_REJECTED',
    });
    await flush();
    expect(chromeFake.store.get('pendingConnect')).toBeUndefined();
    // We do not try to re-close a window the user already closed.
    expect(chromeFake.removedWindows).toEqual([]);
  });

  it('another origin cannot approve, and cannot answer, a pending request', async () => {
    const request = chromeFake.callFromPage({ method: 'page.requestAccounts' }, DAPP);
    await flush();

    // Whether the keyring accepts or refuses an approval for a different origin,
    // the dapp's parked request must not be settled by it.
    await chromeFake.call({ method: 'wallet.approveConnect', params: { origin: EVIL } }).promise;
    await flush();
    expect(request.settled).toBe(false);

    const evilAccounts = await ok(chromeFake.callFromPage({ method: 'page.getAccounts' }, DAPP));
    expect(evilAccounts).toEqual({ accounts: [] });

    await ok(chromeFake.call({ method: 'wallet.approveConnect', params: { origin: DAPP } }));
    await expect(request.promise).resolves.toEqual({ result: { accounts: [address] } });
  });

  it('rejects and clears the prompt after the five-minute timeout', async () => {
    vi.useFakeTimers();
    const request = chromeFake.callFromPage({ method: 'page.requestAccounts' }, DAPP);
    await vi.advanceTimersByTimeAsync(1);
    expect(request.settled).toBe(false);
    expect(chromeFake.store.get('pendingConnect')).toEqual({ origin: DAPP });

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    vi.useRealTimers();
    await flush();

    expect(request.reply).toEqual({ error: 'User rejected the request.', code: 'USER_REJECTED' });
    expect(chromeFake.store.get('pendingConnect'), 'a timed-out prompt must not linger').toBeUndefined();
    expect(chromeFake.badgeText).toBe('');
  });

  it('answers an already-approved origin immediately, with no window and no prompt', async () => {
    await ok(chromeFake.call({ method: 'wallet.approveConnect', params: { origin: DAPP } }));
    chromeFake.windows.length = 0;
    const accounts = await ok(chromeFake.callFromPage({ method: 'page.requestAccounts' }, DAPP));
    expect(accounts).toEqual({ accounts: [address] });
    expect(chromeFake.windows).toHaveLength(0);
    expect(chromeFake.store.get('pendingConnect')).toBeUndefined();
  });

  it('a locked wallet opens no approval window and says why', async () => {
    await ok(chromeFake.call({ method: 'wallet.lock' }));
    const reply = await chromeFake.callFromPage({ method: 'page.requestAccounts' }, DAPP).promise;
    expect(reply.code).toBe('LOCKED');
    expect(reply.error).toMatch(/locked/i);
    expect(chromeFake.windows, 'a locked wallet must not pop an approval window').toHaveLength(0);
    expect(chromeFake.store.get('pendingConnect')).toBeUndefined();
  });
});

describe('what a page can reach through the worker', () => {
  it('refuses wallet.* from a tab even when the origin is connected', async () => {
    await ok(chromeFake.call({ method: 'wallet.approveConnect', params: { origin: DAPP } }));
    for (const method of ['wallet.unlock', 'wallet.status', 'wallet.receive', 'wallet.confirmSend']) {
      const reply = await chromeFake.callFromPage({ method, params: { password: PASSWORD } }, DAPP).promise;
      expect(reply.error, method).toMatch(/not available to pages/);
      expect(reply.result, method).toBeUndefined();
    }
  });

  it('uses the sender origin, never an origin the page puts in params', async () => {
    const request = chromeFake.callFromPage({ method: 'page.requestAccounts', params: { origin: DAPP } }, EVIL);
    await flush();
    expect(request.settled).toBe(false);
    expect(chromeFake.store.get('pendingConnect')).toEqual({ origin: EVIL });

    // Approving the origin the page claimed must not answer the evil origin's request.
    await ok(chromeFake.call({ method: 'wallet.approveConnect', params: { origin: DAPP } }));
    await flush();
    expect(request.settled).toBe(false);
  });

  it('does not let the popup call page.* on a site behalf', async () => {
    const reply = await chromeFake.call({ method: 'page.requestAccounts', params: { origin: DAPP } }).promise;
    expect(reply.error).toMatch(/not callable from the popup/);
  });
});

describe('accountsChanged broadcast', () => {
  it('tells the site when it is revoked, and only that site', async () => {
    chromeFake.tabs = [{ id: 7 }, { id: 8 }];
    await ok(chromeFake.call({ method: 'wallet.approveConnect', params: { origin: DAPP } }));
    chromeFake.tabMessages.length = 0;
    await ok(chromeFake.call({ method: 'wallet.revokeSite', params: { origin: DAPP } }));
    await flush();
    expect(chromeFake.tabMessages.map((m) => m.tabId)).toEqual([7, 8]);
    expect(chromeFake.tabMessages[0]?.message).toEqual({
      channel: 'btq-wallet',
      kind: 'event',
      event: 'accountsChanged',
      origin: DAPP,
      accounts: [],
    });
  });

  it('emits accountsChanged when the page itself disconnects', async () => {
    chromeFake.tabs = [{ id: 3 }];
    await ok(chromeFake.call({ method: 'wallet.approveConnect', params: { origin: DAPP } }));
    chromeFake.tabMessages.length = 0;
    await ok(chromeFake.callFromPage({ method: 'page.disconnect' }, DAPP));
    await flush();
    expect(chromeFake.tabMessages[0]?.message).toMatchObject({ event: 'accountsChanged', origin: DAPP, accounts: [] });
  });
});
