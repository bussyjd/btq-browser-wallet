/**
 * The site-connect state machine as the service worker really runs it: the
 * message listener in src/background/index.ts driven through a fake chrome.*.
 *
 * What an attacker or a careless refactor would gain if these stopped holding:
 * a page whose promise resolves without the user ever approving, one origin
 * settling another origin's request, or a locked wallet handing out addresses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeChrome, uninstallChrome, type Call, type FakeSender } from '../helpers/fake-chrome.js';

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

/**
 * A service-worker restart, modelled rather than waited for.
 *
 * `chrome.storage.local` outlives the worker (the same Map is handed to the new
 * FakeChrome); the worker's memory does not (a fresh module, so a fresh broker,
 * a fresh keyring and no parked responders at all). That is the whole of what
 * Chrome does after about thirty idle seconds, and it is the state every
 * assertion below is about.
 */
async function restartWorker(): Promise<void> {
  const store = chromeFake.store;
  uninstallChrome();
  chromeFake = new FakeChrome(store);
  chromeFake.install();
  vi.resetModules();
  await import('../../src/background/index.js');
  await flush();
}

/** Speak as the approval window the worker opened for `origin`. */
function approvalWindow(origin: string): FakeSender {
  const url = `chrome-extension://${chromeFake.extensionId}/src/ui/index.html?connect=1&origin=${encodeURIComponent(origin)}`;
  return { id: chromeFake.extensionId, url };
}

async function ok(call: Call): Promise<unknown> {
  const reply = await call.promise;
  if (reply.error) throw new Error(`${reply.error} (${reply.code ?? 'no code'})`);
  return reply.result;
}

/**
 * Connect a site the way a user really does: the page asks, the worker parks
 * the request and opens a window for it, the user approves. There is no other
 * way in — `wallet.approveConnect` refuses any origin the broker is not holding,
 * so the popup cannot grant a site that never asked.
 */
async function connectSite(origin: string, tabId = 1): Promise<void> {
  const request = chromeFake.callFromPage({ method: 'page.requestAccounts' }, origin, tabId);
  await flush();
  await ok(chromeFake.call({ method: 'wallet.approveConnect', params: { origin } }));
  await request.promise;
}

/** The prompt mirror the popup reads, as stored. */
function storedPrompts(): { origin: string; at: number; seq: number }[] | undefined {
  return chromeFake.store.get('pendingConnects') as
    | { origin: string; at: number; seq: number }[]
    | undefined;
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
    expect(storedPrompts()).toEqual([{ origin: DAPP, at: expect.any(Number), seq: expect.any(Number) }]);
    expect(chromeFake.windows).toHaveLength(1);
    // The window carries the origin it was opened for, so it can only ever
    // render and approve that site.
    expect(chromeFake.windows[0]?.url).toMatch(
      /src\/ui\/index\.html\?connect=1&origin=https%3A%2F%2Fdapp\.example$/,
    );
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
    expect(chromeFake.windows[0]?.url).toMatch(/src\/ui\/index\.html\?connect=1&origin=/);
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
    // The prompt is still mirrored, so the request is answerable either way.
    expect(storedPrompts()).toEqual([{ origin: DAPP, at: expect.any(Number), seq: expect.any(Number) }]);
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
    expect(storedPrompts()).toBeUndefined();
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
    expect(storedPrompts()).toBeUndefined();
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
    expect(storedPrompts()).toEqual([{ origin: DAPP, at: expect.any(Number), seq: expect.any(Number) }]);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    vi.useRealTimers();
    await flush();

    expect(request.reply).toEqual({ error: 'User rejected the request.', code: 'USER_REJECTED' });
    expect(storedPrompts(), 'a timed-out prompt must not linger').toBeUndefined();
    expect(chromeFake.badgeText).toBe('');
  });

  it('answers an already-approved origin immediately, with no window and no prompt', async () => {
    await connectSite(DAPP);
    chromeFake.windows.length = 0;
    const accounts = await ok(chromeFake.callFromPage({ method: 'page.requestAccounts' }, DAPP));
    expect(accounts).toEqual({ accounts: [address] });
    expect(chromeFake.windows).toHaveLength(0);
    expect(storedPrompts()).toBeUndefined();
  });

  it('a locked wallet opens no approval window and says why', async () => {
    await ok(chromeFake.call({ method: 'wallet.lock' }));
    const reply = await chromeFake.callFromPage({ method: 'page.requestAccounts' }, DAPP).promise;
    expect(reply.code).toBe('LOCKED');
    expect(reply.error).toMatch(/locked/i);
    expect(chromeFake.windows, 'a locked wallet must not pop an approval window').toHaveLength(0);
    expect(storedPrompts()).toBeUndefined();
  });
});

describe('what a page can reach through the worker', () => {
  it('refuses wallet.* from a tab even when the origin is connected', async () => {
    await connectSite(DAPP);
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
    expect(storedPrompts()).toEqual([{ origin: EVIL, at: expect.any(Number), seq: expect.any(Number) }]);

    // Approving the origin the page claimed must not answer the evil origin's
    // request — and with nobody waiting on that origin, it is refused outright.
    const claimed = await chromeFake.call({ method: 'wallet.approveConnect', params: { origin: DAPP } }).promise;
    expect(claimed.code).toBe('FORBIDDEN');
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
    await connectSite(DAPP, 7);
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
    await connectSite(DAPP, 3);
    chromeFake.tabMessages.length = 0;
    await ok(chromeFake.callFromPage({ method: 'page.disconnect' }, DAPP));
    await flush();
    expect(chromeFake.tabMessages[0]?.message).toMatchObject({ event: 'accountsChanged', origin: DAPP, accounts: [] });
  });

  it('a switch to an unapproved account tells the site it sees nothing', async () => {
    // Attacker / user gain: the user makes a second account precisely to keep
    // an identity away from a site. Before this, pressing "Add account" — which
    // switches — pushed that brand-new address to every site ever approved,
    // with no prompt. The grant is per (origin, account): the site is told it
    // has nothing, and gets an address back only when the user approves it
    // there too.
    chromeFake.tabs = [{ id: 4 }];
    await connectSite(DAPP, 4);
    chromeFake.tabMessages.length = 0;

    const created = (await ok(chromeFake.call({ method: 'wallet.createAccount' }))) as { address: string };
    await flush();
    expect(chromeFake.tabMessages).toEqual([
      expect.objectContaining({
        tabId: 4,
        message: {
          channel: 'btq-wallet',
          kind: 'event',
          event: 'accountsChanged',
          origin: DAPP,
          accounts: [],
        },
      }),
    ]);
    expect(await ok(chromeFake.callFromPage({ method: 'page.getAccounts' }, DAPP))).toEqual({ accounts: [] });
    // And the new account's address is nowhere in what the site was told.
    expect(JSON.stringify(chromeFake.tabMessages)).not.toContain(created.address);

    // Switching back to the account the site *was* approved for restores it.
    chromeFake.tabMessages.length = 0;
    const switched = (await ok(chromeFake.call({ method: 'wallet.switchAccount', params: { index: 0 } }))) as {
      address: string;
    };
    await flush();
    expect(switched.address).not.toBe(created.address);
    expect(chromeFake.tabMessages[0]?.message).toMatchObject({
      event: 'accountsChanged',
      origin: DAPP,
      accounts: [switched.address],
    });
    expect(await ok(chromeFake.callFromPage({ method: 'page.getAccounts' }, DAPP))).toEqual({
      accounts: [switched.address],
    });
  });

  it('the site can be approved on the second account, through the normal prompt', async () => {
    chromeFake.tabs = [{ id: 6 }];
    await connectSite(DAPP, 6);
    const created = (await ok(chromeFake.call({ method: 'wallet.createAccount' }))) as { address: string };

    // Asking again from the same page is a *new* request: it parks and opens a
    // window, exactly like a site nobody has ever approved.
    const request = chromeFake.callFromPage({ method: 'page.requestAccounts' }, DAPP, 6);
    await flush();
    expect(request.settled).toBe(false);
    expect(chromeFake.windows.length).toBeGreaterThan(0);
    await ok(chromeFake.call({ method: 'wallet.approveConnect', params: { origin: DAPP } }));
    expect(await request.promise).toMatchObject({ result: { accounts: [created.address] } });

    // Two grants now, one per account, and both answer on their own account.
    const sites = (await ok(chromeFake.call({ method: 'wallet.connectedSites' }))) as {
      origins: string[];
      sites: { origin: string; account: number }[];
    };
    expect(sites.origins).toEqual([DAPP]);
    expect(sites.sites).toEqual([
      { origin: DAPP, account: 0 },
      { origin: DAPP, account: 1 },
    ]);
    expect(await ok(chromeFake.callFromPage({ method: 'page.getAccounts' }, DAPP))).toEqual({
      accounts: [created.address],
    });
    await ok(chromeFake.call({ method: 'wallet.switchAccount', params: { index: 0 } }));
    expect(await ok(chromeFake.callFromPage({ method: 'page.getAccounts' }, DAPP))).toEqual({ accounts: [address] });

    // Revoking one row leaves the other standing.
    await ok(chromeFake.call({ method: 'wallet.revokeSite', params: { origin: DAPP, account: 0 } }));
    expect(await ok(chromeFake.callFromPage({ method: 'page.getAccounts' }, DAPP))).toEqual({ accounts: [] });
    await ok(chromeFake.call({ method: 'wallet.switchAccount', params: { index: 1 } }));
    expect(await ok(chromeFake.callFromPage({ method: 'page.getAccounts' }, DAPP))).toEqual({
      accounts: [created.address],
    });
  });

  it('a page cannot create or switch accounts through the worker', async () => {
    // Attacker gain: a connected site that could switch accounts would change
    // which coins a later user-approved send spends, without a prompt.
    chromeFake.tabs = [{ id: 5 }];
    await connectSite(DAPP, 5);
    const reply = await chromeFake.callFromPage(
      { method: 'wallet.switchAccount', params: { index: 0 } },
      DAPP,
    ).promise;
    expect(reply.code).toBe('FORBIDDEN');
    const created = await chromeFake.callFromPage({ method: 'wallet.createAccount' }, DAPP).promise;
    expect(created.code).toBe('FORBIDDEN');
  });
});

/**
 * The other half of the same MV3 lifetime problem as onboarding, and the half
 * that cannot be designed away: a parked `sendResponse` is a live callback into
 * a page, and no amount of writing to disk makes one survive its worker. So the
 * requirement here is not "keep it" but "lose it loudly" — the page is told
 * (Chrome closes the channel and the relay turns the `lastError` into
 * DISCONNECTED; see connect-relay.test.ts), and the wallet must stop pretending
 * a request is still pending on every surface the user can see.
 */
describe('an approval window that outlives the worker holding its request', () => {
  it('finds the request gone, not pending: badge, mirror and pendingConnect all agree', async () => {
    const request = chromeFake.callFromPage({ method: 'page.requestAccounts' }, DAPP);
    await flush();
    expect(request.settled).toBe(false);
    expect(chromeFake.badgeText).toBe('1');
    expect(storedPrompts()).toEqual([{ origin: DAPP, at: expect.any(Number), seq: expect.any(Number) }]);

    await restartWorker();

    // Reconciled at startup rather than at the next popup open: a toolbar badge
    // reading "1" over a request nobody is holding is the wallet telling the
    // user something is waiting for them when nothing is.
    expect(chromeFake.badgeText).toBe('');
    expect(storedPrompts(), 'a prompt from a dead worker generation').toBeUndefined();
    expect(
      await ok(chromeFake.call({ method: 'wallet.pendingConnect' }, approvalWindow(DAPP))),
    ).toBeNull();
  });

  it('is refused if it approves anyway, and told what to do instead', async () => {
    // The race the polling cannot close: the worker dies between the window's
    // last check and the click. The refusal is the backstop, and it has to be
    // readable — "forbidden" tells a user nothing about asking the site again.
    chromeFake.callFromPage({ method: 'page.requestAccounts' }, DAPP);
    await flush();
    await restartWorker();
    await ok(chromeFake.call({ method: 'wallet.unlock', params: { password: PASSWORD } }));

    const reply = await chromeFake.call(
      { method: 'wallet.approveConnect', params: { origin: DAPP } },
      approvalWindow(DAPP),
    ).promise;
    expect(reply.code).toBe('FORBIDDEN');
    expect(reply.error).toMatch(/no longer waiting/i);
    expect(reply.error).toMatch(/connect again/i);

    // Attacker gain if this ever passed: a permanent allowlist entry for a site
    // that is not, right now, asking for one — granted out of a stale record by
    // a user who thought they were answering a live prompt.
    const sites = (await ok(chromeFake.call({ method: 'wallet.connectedSites' }))) as {
      sites: { origin: string }[];
    };
    expect(sites.sites).toEqual([]);
  });

  it('never inherits another site\'s request to fill the gap', async () => {
    // Two sites waiting. The window opened for the first must learn that *its*
    // request is the one outstanding — never render the newest prompt under the
    // origin printed in its own URL, which is how one site gets approved on
    // another's screen.
    //
    // The clock is frozen for the whole test — `Date` only, so `flush()` still
    // runs on real timers — which pins the case this test used to decide by
    // race. Both prompts are stamped with the same millisecond every run, so
    // "newest first" is settled entirely by the broker's arrival counter. Left
    // on the real clock, the two `Date.now()` readings landed on the same
    // integer perhaps half the time and on different ones the rest, and the
    // final assertion below flipped with them: this file failed roughly one run
    // in two, which is what a delivered `npm test` did to whoever ran it first.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_770_000_000_000);
    chromeFake.callFromPage({ method: 'page.requestAccounts' }, DAPP, 1);
    await flush();
    chromeFake.callFromPage({ method: 'page.requestAccounts' }, EVIL, 2);
    await flush();
    expect(chromeFake.windows).toHaveLength(2);

    expect(await ok(chromeFake.call({ method: 'wallet.pendingConnect' }, approvalWindow(DAPP)))).toEqual({
      origin: DAPP,
    });
    expect(await ok(chromeFake.call({ method: 'wallet.pendingConnect' }, approvalWindow(EVIL)))).toEqual({
      origin: EVIL,
    });
    // The toolbar popup was opened for nobody and still sees whatever is
    // outstanding — that is the surface a user reaches for when a window was
    // closed by accident.
    expect(storedPrompts()?.map((p) => p.at), 'both prompts share a millisecond').toEqual([
      1_770_000_000_000,
      1_770_000_000_000,
    ]);
    expect(await ok(chromeFake.call({ method: 'wallet.pendingConnect' }))).toEqual({ origin: EVIL });

    // And after the restart neither window is offered the other one's site.
    await restartWorker();
    expect(await ok(chromeFake.call({ method: 'wallet.pendingConnect' }, approvalWindow(DAPP)))).toBeNull();
    expect(await ok(chromeFake.call({ method: 'wallet.pendingConnect' }, approvalWindow(EVIL)))).toBeNull();
  });
});
