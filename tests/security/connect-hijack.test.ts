/**
 * Prompt *provenance* for the site-connect approval, driven through the real
 * service-worker listener with a fake `chrome.*`.
 *
 * These are the three findings the security review reproduced against this
 * exact harness:
 *
 *  - **M1** — a second origin hijacks the approval window another site opened.
 *    The window must carry the origin it was opened for, render that origin,
 *    and approve only that origin; and `wallet.approveConnect` must refuse an
 *    origin no page is actually waiting on, so the popup can never grant a site
 *    that never asked. A page must also not be able to spawn unbounded windows.
 *  - **L2** — Cancel in one approval window settles a *different* site's
 *    request, leaving the cancelled one parked until its timeout.
 *  - **L3** — a prompt that outlived the service worker is still approvable
 *    minutes or days later, granting a permanent allowlist entry with no live
 *    request behind it.
 *
 * What an attacker gains without these: the wallet's receive address and a
 * persistent allowlist entry for a site the user never meant to connect.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { FakeChrome, uninstallChrome, type Call, type FakeSender } from '../helpers/fake-chrome.js';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'testnet-ok';
const DAPP = 'https://dapp.example';
const EVIL = 'https://evil.example';
const THIRD = 'https://third.example';
const FOURTH = 'https://fourth.example';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let chromeFake: FakeChrome;

/** Boot a fresh worker, optionally over storage left behind by an older one. */
async function boot(seed: Record<string, unknown> = {}): Promise<void> {
  chromeFake = new FakeChrome();
  for (const [key, value] of Object.entries(seed)) chromeFake.store.set(key, value);
  chromeFake.install();
  vi.resetModules();
  await import('../../src/background/index.js');
}

async function bootUnlocked(seed: Record<string, unknown> = {}): Promise<string> {
  await boot(seed);
  await ok(chromeFake.call({ method: 'wallet.importMnemonic', params: { mnemonic: MNEMONIC, password: PASSWORD } }));
  const receive = (await ok(chromeFake.call({ method: 'wallet.receive' }))) as { address: string };
  return receive.address;
}

async function ok(call: Call): Promise<unknown> {
  const reply = await call.promise;
  if (reply.error) throw new Error(`${reply.error} (${reply.code ?? 'no code'})`);
  return reply.result;
}

/**
 * A message from an extension page. `sender.url` is what the *browser* reports
 * for the page that sent it — page script cannot forge it — so it is what binds
 * an approval window to the origin it was opened for.
 */
function fromApprovalWindow(origin: string): FakeSender {
  const url = `chrome-extension://${chromeFake.extensionId}/src/ui/index.html?connect=1&origin=${encodeURIComponent(origin)}`;
  return { id: chromeFake.extensionId, url } as unknown as FakeSender;
}

/** The plain toolbar popup: no connect window, no origin in its URL. */
function fromToolbarPopup(): FakeSender {
  const url = `chrome-extension://${chromeFake.extensionId}/src/ui/index.html`;
  return { id: chromeFake.extensionId, url } as unknown as FakeSender;
}

/** The origin an approval window was opened for, read out of its URL. */
function windowOrigin(url: string | undefined): string | null {
  if (!url) return null;
  return new URL(url).searchParams.get('origin');
}

async function grantedSites(): Promise<string[]> {
  const sites = (await ok(chromeFake.call({ method: 'wallet.connectedSites' }))) as { origins: string[] };
  return sites.origins;
}

afterEach(() => {
  vi.useRealTimers();
  uninstallChrome();
});

describe('M1 · an approval window belongs to the origin that opened it', () => {
  it('carries that origin in its URL, and refuses to approve any other', async () => {
    const address = await bootUnlocked();

    const dapp = chromeFake.callFromPage({ method: 'page.requestAccounts' }, DAPP, 1);
    await flush();
    const evil = chromeFake.callFromPage({ method: 'page.requestAccounts' }, EVIL, 2);
    await flush();

    expect(chromeFake.windows).toHaveLength(2);
    expect(windowOrigin(chromeFake.windows[0]?.url), "the first window is the dapp's").toBe(DAPP);
    expect(windowOrigin(chromeFake.windows[1]?.url), "the second window is evil's").toBe(EVIL);

    // The window the dapp opened cannot grant the evil origin, however the
    // popup running inside it asks.
    const stolen = await chromeFake.call(
      { method: 'wallet.approveConnect', params: { origin: EVIL } },
      fromApprovalWindow(DAPP),
    ).promise;
    expect(stolen.code).toBe('FORBIDDEN');
    expect(stolen.result).toBeUndefined();
    await flush();
    expect(evil.settled, "evil's request must not be settled from the dapp's window").toBe(false);
    expect(await grantedSites()).not.toContain(EVIL);

    // Its own origin still works, and only its own request settles.
    await ok(chromeFake.call({ method: 'wallet.approveConnect', params: { origin: DAPP } }, fromApprovalWindow(DAPP)));
    await expect(dapp.promise).resolves.toEqual({ result: { accounts: [address] } });
    expect(evil.settled).toBe(false);
    expect(await grantedSites()).toEqual([DAPP]);
  });

  it('refuses an approval for an origin no page is waiting on', async () => {
    await bootUnlocked();

    const reply = await chromeFake.call(
      { method: 'wallet.approveConnect', params: { origin: EVIL } },
      fromToolbarPopup(),
    ).promise;

    expect(reply.code, 'a grant with no live request behind it must be refused').toBe('FORBIDDEN');
    expect(reply.result).toBeUndefined();
    expect(await grantedSites()).toEqual([]);
  });

  it('caps concurrent approval windows and rejects the overflow', async () => {
    await bootUnlocked();

    const calls: Call[] = [];
    for (const [index, origin] of [DAPP, EVIL, THIRD].entries()) {
      calls.push(chromeFake.callFromPage({ method: 'page.requestAccounts' }, origin, index + 1));
      await flush();
    }
    expect(chromeFake.windows).toHaveLength(3);
    for (const call of calls) expect(call.settled).toBe(false);

    const overflow = chromeFake.callFromPage({ method: 'page.requestAccounts' }, FOURTH, 4);
    await flush();
    expect(chromeFake.windows, 'the fourth site gets no window').toHaveLength(3);
    await expect(overflow.promise).resolves.toEqual({
      error: 'User rejected the request.',
      code: 'USER_REJECTED',
    });
  });
});

describe('L2 · Cancel settles the request its own window is for', () => {
  it('denies the window origin, and leaves the other site parked', async () => {
    await bootUnlocked();

    const dapp = chromeFake.callFromPage({ method: 'page.requestAccounts' }, DAPP, 1);
    await flush();
    const evil = chromeFake.callFromPage({ method: 'page.requestAccounts' }, EVIL, 2);
    await flush();

    await ok(chromeFake.call({ method: 'wallet.denyConnect' }, fromApprovalWindow(DAPP)));
    await expect(dapp.promise).resolves.toEqual({
      error: 'User rejected the request.',
      code: 'USER_REJECTED',
    });
    expect(evil.settled, "cancelling the dapp's prompt must not settle evil's").toBe(false);
  });

  it('accepts an explicit origin from a caller that can send one', async () => {
    await bootUnlocked();

    const dapp = chromeFake.callFromPage({ method: 'page.requestAccounts' }, DAPP, 1);
    await flush();
    const evil = chromeFake.callFromPage({ method: 'page.requestAccounts' }, EVIL, 2);
    await flush();

    await ok(chromeFake.call({ method: 'wallet.denyConnect', params: { origin: EVIL } }, fromToolbarPopup()));
    await expect(evil.promise).resolves.toEqual({
      error: 'User rejected the request.',
      code: 'USER_REJECTED',
    });
    expect(dapp.settled).toBe(false);
  });
});

describe('L3 · a prompt cannot outlive the worker that parked it', () => {
  it('migrates the old single-slot record and refuses to grant it', async () => {
    // What the previous version left on disk: one prompt, no timestamp, and no
    // live request anywhere — the worker that parked it is long gone.
    await bootUnlocked({ pendingConnect: { origin: EVIL } });

    expect(await ok(chromeFake.call({ method: 'wallet.pendingConnect' }, fromToolbarPopup()))).toBeNull();
    expect(chromeFake.store.get('pendingConnect'), 'the legacy slot is migrated away on read').toBeUndefined();

    const reply = await chromeFake.call(
      { method: 'wallet.approveConnect', params: { origin: EVIL } },
      fromToolbarPopup(),
    ).promise;
    expect(reply.code).toBe('FORBIDDEN');
    expect(await grantedSites()).toEqual([]);
  });

  it('drops a stored prompt older than the five-minute timeout', async () => {
    const stale = Date.now() - 6 * 60 * 1000;
    await bootUnlocked({ pendingConnects: [{ origin: EVIL, at: stale }] });

    expect(await ok(chromeFake.call({ method: 'wallet.pendingConnect' }, fromToolbarPopup()))).toBeNull();
    expect(chromeFake.store.get('pendingConnects')).toBeUndefined();

    const reply = await chromeFake.call(
      { method: 'wallet.approveConnect', params: { origin: EVIL } },
      fromToolbarPopup(),
    ).promise;
    expect(reply.code).toBe('FORBIDDEN');
  });

  it('keeps a live prompt visible to the popup, with its timestamp', async () => {
    await bootUnlocked();
    const before = Date.now();
    const dapp = chromeFake.callFromPage({ method: 'page.requestAccounts' }, DAPP, 1);
    await flush();

    expect(await ok(chromeFake.call({ method: 'wallet.pendingConnect' }, fromToolbarPopup()))).toEqual({
      origin: DAPP,
    });
    const stored = chromeFake.store.get('pendingConnects') as { origin: string; at: number }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.origin).toBe(DAPP);
    expect(stored[0]?.at).toBeGreaterThanOrEqual(before);
    expect(dapp.settled).toBe(false);
  });
});
