/**
 * Site-connect, and what a hostile page can get out of the extension.
 *
 * A real page on a real origin asks `window.btq` for an address; the approval
 * window the service worker opens is driven like a user would drive it. Then the
 * same page tries every way there is to reach past the provider — the raw relay
 * channel, unlisted methods, the extension APIs — and the storage the worker
 * keeps is read back and searched for secrets.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  importMnemonic,
  launchDevice,
  openSettings,
  receiveAddress,
  waitForScan,
  type Device,
} from './fixtures/extension.js';
import { startMockBackend, type MockBackend } from './fixtures/mock-explorer.js';
import { videoDir } from './fixtures/video.js';
import { addressFromHdSeed } from '../../src/core/wallet/derive.js';
import { mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';
import { toHex } from './fixtures/bip341.js';

test.describe.configure({ mode: 'serial' });

const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PASSWORD = 'connect-pass-1';

let backend: MockBackend;
let device: Device;
let popup: Page;
let siteA: Page;
let siteB: Page;
let A0: string;
let originA: string;
let originB: string;

/** Post straight into the content relay's channel, the way a hostile page would. */
async function relay(page: Page, method: string, params?: unknown): Promise<Record<string, unknown>> {
  return page.evaluate(
    async ([m, p]) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = Math.floor(Math.random() * 1_000_000_000);
        const onMessage = (event: MessageEvent) => {
          const data = event.data as Record<string, unknown> | null;
          if (!data || data.channel !== 'btq-wallet' || data.kind !== 'response' || data.id !== id) return;
          window.removeEventListener('message', onMessage);
          resolve(data);
        };
        window.addEventListener('message', onMessage);
        window.postMessage({ channel: 'btq-wallet', id, kind: 'request', method: m, params: p }, '*');
        setTimeout(() => {
          window.removeEventListener('message', onMessage);
          resolve({ timedOut: true });
        }, 8000);
      }),
    [method, params] as [string, unknown],
  );
}

/**
 * Run `post`, then wait until every id in `controls` has come back, and hand
 * back every response id the page saw. The page must already be collecting into
 * `window.__btqSeen`.
 *
 * The controls are the barrier, and there are two of them on purpose. The relay
 * handles `message` events in order: a message it accepts is forwarded to the
 * worker *before* anything posted after it, so if the message under test had
 * been accepted its answer would be in flight ahead of both controls. Waiting
 * for two complete page → relay → worker → relay → page round trips is
 * therefore a real barrier, not a wall-clock wager on how fast the box is.
 */
async function collectRelayIds(page: Page, controls: number[], post: () => Promise<void>): Promise<number[]> {
  await post();
  return page.evaluate(async (wanted: number[]) => {
    const seen = () => (window as any).__btqSeen as number[];
    const deadline = Date.now() + 15_000;
    while (!wanted.every((id) => seen().includes(id)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return [...seen()];
  }, controls);
}

/** `window.btq.request(...)`, resolved or rejected, as plain data. */
async function providerRequest(page: Page, method: string): Promise<Record<string, unknown>> {
  return page.evaluate(
    async (m) =>
      (window as any).btq.request({ method: m }).then(
        (result: unknown) => ({ result }),
        (e: { message?: string; code?: number }) => ({ error: e.message, code: e.code }),
      ) as Promise<Record<string, unknown>>,
    method,
  );
}

interface PendingRequest {
  /** Has the page's promise resolved or rejected yet? */
  settled: () => Promise<boolean>;
  /** Await it and read the outcome as plain data. */
  result: () => Promise<Record<string, unknown>>;
}

/** Start a request that will block on the approval window, and hand back a getter. */
async function startRequestAccounts(page: Page): Promise<PendingRequest> {
  await page.evaluate(() => {
    const w = window as any;
    w.__btqSettled = false;
    w.__btqPending = w.btq.request({ method: 'btq_requestAccounts' }).then(
      (result: unknown) => {
        w.__btqSettled = true;
        return { result };
      },
      (e: { message?: string; code?: number }) => {
        w.__btqSettled = true;
        return { error: e.message, code: e.code };
      },
    );
  });
  return {
    settled: () => page.evaluate(() => (window as any).__btqSettled as boolean),
    result: () => page.evaluate(async () => (window as any).__btqPending as Promise<Record<string, unknown>>),
  };
}

/**
 * The approval window opened for exactly this origin.
 *
 * The worker puts the origin in the window's URL, so with two sites waiting at
 * once each window is identifiable — and each one can only speak for its own
 * site.
 */
async function approvalWindowFor(origin: string): Promise<Page> {
  const marker = `connect=1&origin=${encodeURIComponent(origin)}`;
  let found: Page | undefined;
  await expect
    .poll(() => {
      found = device.context.pages().find((p) => p.url().includes(marker));
      return Boolean(found);
    }, { timeout: 30_000, message: `no approval window for ${origin}` })
    .toBe(true);
  const page = found as Page;
  await page.waitForSelector('[data-testid="connect-origin"]');
  return page;
}

/** Call the wallet RPC surface from inside an extension page, as the popup does. */
async function fromExtensionPage(page: Page, method: string, params?: unknown): Promise<Record<string, unknown>> {
  return page.evaluate(
    ([m, p]) =>
      new Promise<Record<string, unknown>>((resolve) => {
        (window as any).chrome.runtime.sendMessage({ method: m, params: p }, resolve);
      }),
    [method, params] as [string, unknown],
  );
}

test.beforeAll(async () => {
  backend = await startMockBackend();
  originA = backend.origin;
  originB = backend.altOrigin;
  device = await launchDevice({
    name: 'device-connect',
    explorerBase: backend.origin,
    videoDir: videoDir(4, 'device-connect'),
  });
  A0 = addressFromHdSeed(mnemonicToHdSeed(MNEMONIC), 'external', 0, 'testnet').address;

  popup = await device.popup();
  await importMnemonic(popup, MNEMONIC, PASSWORD);
  await waitForScan(popup);
  expect(await receiveAddress(popup)).toBe(A0);

  siteA = await device.context.newPage();
  await siteA.goto(`${originA}/dapp.html`);
  siteB = await device.context.newPage();
  await siteB.goto(`${originB}/dapp.html`);
});

test.afterAll(async () => {
  await device?.close();
  await backend?.close();
});

test('a site asks, the user approves, and only that origin is connected', async () => {
  await expect(siteA.getByTestId('dapp-out')).toHaveText('provider: window.btq detected');
  expect(await siteA.evaluate(() => (window as any).btq.isBtq)).toBe(true);

  // Before any approval, the page sees nothing.
  expect(await providerRequest(siteA, 'btq_accounts')).toEqual({ result: [] });

  const pending = await startRequestAccounts(siteA);
  const approval = await approvalWindowFor(originA);
  await expect(approval.getByTestId('connect-origin')).toHaveText(originA);
  await approval.getByTestId('connect-approve').click();
  expect(await pending.result()).toEqual({ result: [A0] });
  expect(await providerRequest(siteA, 'btq_accounts')).toEqual({ result: [A0] });

  // A different origin on the same host:port pair is a different site.
  expect(originB).not.toBe(originA);
  expect(await providerRequest(siteB, 'btq_accounts')).toEqual({ result: [] });

  const pendingB = await startRequestAccounts(siteB);
  const denial = await approvalWindowFor(originB);
  await expect(denial.getByTestId('connect-origin')).toHaveText(originB);
  await denial.getByTestId('connect-deny').click();
  const rejected = await pendingB.result();
  expect(rejected.code).toBe(4001);
  expect(String(rejected.error)).toContain('rejected');
  expect(await providerRequest(siteB, 'btq_accounts')).toEqual({ result: [] });

  // Settings lists exactly one connected site, and revoking it takes effect.
  await openSettings(popup);
  await expect(popup.getByTestId('site-row')).toHaveCount(1);
  await expect(popup.getByTestId('site-row')).toContainText(originA);
  await popup.getByTestId('site-revoke').click();
  await expect(popup.getByTestId('site-row')).toHaveCount(0);
  expect(await providerRequest(siteA, 'btq_accounts')).toEqual({ result: [] });
});

test('two sites race for the prompt, and each window answers only its own', async () => {
  // The attack this rules out: a page that fires `btq_requestAccounts` on a
  // timer, racing the user's click on a site they do trust. Before the window
  // carried its origin, whichever request landed last owned *every* open
  // approval window — so the honest site's window granted the racing one.
  expect(await providerRequest(siteA, 'btq_accounts')).toEqual({ result: [] });
  expect(await providerRequest(siteB, 'btq_accounts')).toEqual({ result: [] });

  const pendingA = await startRequestAccounts(siteA);
  const windowA = await approvalWindowFor(originA);
  const pendingB = await startRequestAccounts(siteB);
  const windowB = await approvalWindowFor(originB);

  // Two windows, each naming — and bound to — the site that opened it.
  expect(windowA).not.toBe(windowB);
  await expect(windowA.getByTestId('connect-origin')).toHaveText(originA);
  await expect(windowB.getByTestId('connect-origin')).toHaveText(originB);

  // A's window cannot grant B, however it asks the worker.
  const stolen = await fromExtensionPage(windowA, 'wallet.approveConnect', { origin: originB });
  expect(stolen.code).toBe('FORBIDDEN');
  expect(stolen.result).toBeUndefined();
  expect(await pendingB.settled(), "B's request must not be settled from A's window").toBe(false);
  expect(await providerRequest(siteB, 'btq_accounts')).toEqual({ result: [] });

  // Nor can any window grant a site that is not asking at all.
  const invented = await fromExtensionPage(windowA, 'wallet.approveConnect', { origin: 'https://nobody.example' });
  expect(invented.code).toBe('FORBIDDEN');

  // Cancel in A's window — over RPC, so the deny is judged on its own and not
  // on the window closing afterwards. It settles A, and only A. Settling also
  // closes A's window, which can tear the page down before the RPC answer finds
  // its way back; the outcome that matters is on the page's promise below.
  await fromExtensionPage(windowA, 'wallet.denyConnect').catch(() => undefined);
  expect(await pendingA.result()).toMatchObject({ code: 4001 });
  expect(await pendingB.settled(), "cancelling A must not settle B").toBe(false);

  // B's own window still works, and answers B.
  await windowB.getByTestId('connect-approve').click();
  expect(await pendingB.result()).toEqual({ result: [A0] });
  expect(await providerRequest(siteA, 'btq_accounts')).toEqual({ result: [] });

  // Leave no site connected, for the tests after this one.
  await providerRequest(siteB, 'btq_disconnect');
  expect(await providerRequest(siteB, 'btq_accounts')).toEqual({ result: [] });
});

test("the toolbar popup's Cancel settles the request it is showing", async () => {
  // The dedicated approval window carries its origin in its URL, so the worker
  // can tell which request a Cancel there is answering. The toolbar popup does
  // not: it renders whichever request is still live. When it sent no origin the
  // worker had two waiting and refused to guess — settling the wrong one would
  // reject a site the user never looked at — so the button settled nothing and
  // the user was left clicking a Cancel that did not cancel.
  const pendingA = await startRequestAccounts(siteA);
  await approvalWindowFor(originA);
  const pendingB = await startRequestAccounts(siteB);
  await approvalWindowFor(originB);

  const toolbar = await device.popup();
  expect(toolbar.url()).not.toContain('connect=1'); // no origin in the URL to fall back on
  await expect(toolbar.getByTestId('connect-origin')).toBeVisible({ timeout: 30_000 });
  const shown = ((await toolbar.getByTestId('connect-origin').textContent()) ?? '').trim();
  expect([originA, originB]).toContain(shown);

  const [denied, untouched] = shown === originA ? [pendingA, pendingB] : [pendingB, pendingA];
  await toolbar.getByTestId('connect-deny').click();
  await expect
    .poll(() => denied.settled(), {
      timeout: 15_000,
      message: `Cancel in the toolbar popup did not settle ${shown}`,
    })
    .toBe(true);
  expect(await denied.result()).toMatchObject({ code: 4001 });
  expect(await untouched.settled(), 'cancelling one prompt must not settle the other').toBe(false);

  // The other site is still waiting, and its own window still answers for it.
  const other = shown === originA ? originB : originA;
  const otherWindow = await approvalWindowFor(other);
  await otherWindow.getByTestId('connect-deny').click();
  expect(await untouched.result()).toMatchObject({ code: 4001 });

  await toolbar.close();
  expect(await providerRequest(siteA, 'btq_accounts')).toEqual({ result: [] });
  expect(await providerRequest(siteB, 'btq_accounts')).toEqual({ result: [] });
});

test('a page cannot reach the wallet surface, or anything in storage', async () => {
  // The relay allowlist: three page.* methods and nothing else.
  for (const method of ['wallet.unlock', 'wallet.status', 'wallet.receive', 'wallet.confirmSend']) {
    const answer = await relay(siteA, method, { password: PASSWORD });
    expect(answer.error).toBe('This method is not available to pages.');
    expect(answer.code).toBe('FORBIDDEN');
    expect(answer.result).toBeUndefined();
  }

  // The provider refuses to map anything that is not a page method.
  const viaProvider = await providerRequest(siteA, 'wallet.unlock');
  expect(viaProvider.code).toBe(4200);
  expect(String(viaProvider.error)).toContain('does not support');

  // No extension API is reachable from the page's world.
  const apis = await siteA.evaluate(() => {
    const c = (window as any).chrome;
    return {
      runtime: typeof c?.runtime,
      storage: typeof c?.storage,
      tabs: typeof c?.tabs,
      providerKeys: Object.keys((window as any).btq).sort(),
    };
  });
  expect(apis.runtime).toBe('undefined');
  expect(apis.storage).toBe('undefined');
  expect(apis.tabs).toBe('undefined');
  expect(apis.providerKeys).toEqual(['isBtq', 'on', 'removeListener', 'request']);

  // What the worker keeps, and what it must never keep.
  const storage = await device.storage();
  for (const key of ['vault', 'meta', 'origins', 'backend']) {
    expect(Object.keys(storage)).toContain(key);
  }
  const blob = JSON.stringify(storage).toLowerCase();
  const hdSeedHex = toHex(mnemonicToHdSeed(MNEMONIC));
  expect(blob).not.toContain(hdSeedHex);
  expect(blob).not.toContain(MNEMONIC);
  expect(blob).not.toContain(PASSWORD);
  expect(blob).not.toContain('secretkey');
  for (const word of MNEMONIC.split(' ')) expect(blob).not.toContain(`"${word}"`);

  const vault = storage.vault as string;
  expect(vault.startsWith('42545131')).toBe(true); // "BTQ1"
  expect(vault.length / 2).toBeLessThan(400);
});

test('another origin cannot drive this page\'s relay, forged or framed', async () => {
  // (a) A frame on a *different* origin, inside a page the wallet trusts. The
  //     content scripts are top-frame only (no `all_frames` in the manifest),
  //     so the frame gets no provider and no relay of its own …
  const frameUrl = `${originB}/dapp.html`;
  await siteA.evaluate(async (src) => {
    const frame = document.createElement('iframe');
    frame.id = 'attacker';
    frame.src = src;
    const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
    document.body.appendChild(frame);
    await loaded;
  }, frameUrl);
  const child = siteA.frames().find((f) => f.url() === frameUrl);
  expect(child, `no frame at ${frameUrl}`).toBeTruthy();
  expect(await child!.evaluate(() => typeof (window as any).btq)).toBe('undefined');
  expect(await child!.evaluate(() => typeof (window as any).chrome?.runtime)).toBe('undefined');

  // … and what it posts into the top page's relay is ignored, because that
  // message did not come from the top page (`event.source !== window`).
  await siteA.evaluate(() => {
    (window as any).__btqSeen = [] as number[];
    window.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { channel?: string; kind?: string; id?: number } | null;
      if (data && data.channel === 'btq-wallet' && data.kind === 'response' && typeof data.id === 'number') {
        ((window as any).__btqSeen as number[]).push(data.id);
      }
    });
  });
  await child!.evaluate(() => {
    window.parent.postMessage(
      { channel: 'btq-wallet', id: 9101, kind: 'request', method: 'page.getAccounts' },
      '*',
    );
  });
  // The control message goes through the whole relay round trip after it, so a
  // reply to the frame's message has had at least that long to turn up.
  const framedSeen = await collectRelayIds(siteA, [9102, 9103], () =>
    siteA.evaluate(() => {
      for (const id of [9102, 9103]) {
        window.postMessage(
          { channel: 'btq-wallet', id, kind: 'request', method: 'page.getAccounts' },
          window.location.origin,
        );
      }
    }),
  );
  expect(framedSeen).toEqual(expect.arrayContaining([9102, 9103])); // the relay is alive and answering …
  expect(framedSeen).not.toContain(9101); // … and it said nothing to the frame.
  await siteA.evaluate(() => document.getElementById('attacker')?.remove());

  // (b) A message from this very page that lies about where it came from. Page
  //     script can dispatch a MessageEvent with `source: window` and any origin
  //     it likes; the relay compares the origin it was handed with the origin
  //     it is running on, and drops anything that does not match.
  await siteA.evaluate(() => {
    (window as any).__btqSeen = [] as number[];
  });
  const forgedSeen = await collectRelayIds(siteA, [9202, 9203], () =>
    siteA.evaluate(
      ([badOrigin, goodOrigin]) => {
        const forge = (id: number, origin: string) =>
          window.dispatchEvent(
            new MessageEvent('message', {
              data: { channel: 'btq-wallet', id, kind: 'request', method: 'page.getAccounts' },
              origin,
              source: window,
            }),
          );
        forge(9201, badOrigin); // claims to be a page on another origin
        forge(9202, goodOrigin); // the controls: same event, honest origin
        forge(9203, goodOrigin);
      },
      ['http://attacker.example', originA] as [string, string],
    ),
  );
  expect(forgedSeen).toEqual(expect.arrayContaining([9202, 9203]));
  expect(forgedSeen).not.toContain(9201);
});

test('a locked wallet answers a site with nothing, and opens no window', async () => {
  // Reconnect first, so the empty answer below can only be the lock talking.
  const pending = await startRequestAccounts(siteA);
  const approval = await approvalWindowFor(originA);
  await approval.getByTestId('connect-approve').click();
  expect(await pending.result()).toEqual({ result: [A0] });

  await popup.getByTestId('lock-now').click();
  await expect(popup.getByTestId('unlock-pw')).toBeVisible();
  const pagesBefore = device.context.pages().length;

  expect(await providerRequest(siteA, 'btq_accounts')).toEqual({ result: [] });
  const locked = await providerRequest(siteA, 'btq_requestAccounts');
  expect(locked.code).toBe(4100);
  expect(String(locked.error)).toContain('locked');
  expect(device.context.pages().length).toBe(pagesBefore);
  expect(device.context.pages().some((p) => p.url().includes('connect=1'))).toBe(false);
});
