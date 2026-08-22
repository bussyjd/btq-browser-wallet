/**
 * Launching the *built* extension in a real Chromium, and the handful of popup
 * gestures every journey repeats.
 *
 * Nothing in the extension is stubbed: `dist/` is loaded as an unpacked
 * extension into a persistent context (the only kind that can load one), and
 * the service worker, the popup, the content relay and the MAIN-world provider
 * all run for real. The only thing the test does before opening the popup is
 * point the wallet's backend at the mock server — the same thing a user does in
 * Settings, done from the service worker so the very first scan is offline.
 */
import { chromium, expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../../..');
export const DIST = join(REPO_ROOT, 'dist');

/** Popup geometry: what the toolbar popup gets, and what the demo video records. */
export const POPUP_VIEWPORT = { width: 360, height: 600 };

/** Where RECORD_VIDEO=1 leaves its clips, and the order to stitch them in. */
export const DEMO_RAW = join(REPO_ROOT, 'demo', 'raw');
export const DEMO_ORDER = join(DEMO_RAW, 'order.txt');

export interface DeviceOptions {
  /** Used for the video directory and for readable failures. */
  name: string;
  /** The mock explorer origin the wallet reads from (no https, no internet). */
  explorerBase: string;
  /** Directory for recorded video, when RECORD_VIDEO is set. */
  videoDir?: string;
}

export interface Device {
  name: string;
  context: BrowserContext;
  extensionId: string;
  userDataDir: string;
  /** The current service worker (Chrome may recycle it between calls). */
  worker(): Promise<Worker>;
  /** Open a fresh popup page. */
  popup(): Promise<Page>;
  /** Everything in chrome.storage.local, read from inside the worker. */
  storage(): Promise<Record<string, unknown>>;
  /** Call the popup's RPC surface from an extension page. */
  rpc<T = unknown>(page: Page, method: string, params?: unknown): Promise<T>;
  close(): Promise<void>;
}

interface RpcEnvelope {
  result?: unknown;
  error?: string;
  code?: string;
}

/**
 * One counter across every device in a run, so the demo can be stitched in the
 * order the pages were actually opened — devices do not close in that order.
 */
let pageSequence = 0;

export async function launchDevice(opts: DeviceOptions): Promise<Device> {
  const userDataDir = mkdtempSync(join(tmpdir(), `btq-e2e-${opts.name}-`));
  const args = [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    // Hermetic: nothing outside this machine can be reached, so a stray call to
    // the public explorer fails loudly instead of making the run non-deterministic.
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
  ];
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: POPUP_VIEWPORT,
    args,
    ...(opts.videoDir ? { recordVideo: { dir: opts.videoDir, size: POPUP_VIEWPORT } } : {}),
  });

  // Every page opened from here on, in order — the demo video's running order.
  // The context's initial about:blank predates this listener, so it never
  // reaches the manifest.
  const recorded: { seq: number; page: Page }[] = [];
  context.on('page', (page) => recorded.push({ seq: pageSequence++, page }));

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  const extensionId = new URL(sw.url()).host;

  const device: Device = {
    name: opts.name,
    context,
    extensionId,
    userDataDir,
    async worker() {
      const existing = context.serviceWorkers()[0];
      if (existing) return existing;
      return context.waitForEvent('serviceworker', { timeout: 30_000 });
    },
    async popup() {
      const page = await context.newPage();
      await page.setViewportSize(POPUP_VIEWPORT);
      await page.goto(`chrome-extension://${extensionId}/src/ui/index.html`);
      await page.waitForSelector('.app', { timeout: 30_000 });
      return page;
    },
    async storage() {
      const worker = await device.worker();
      return worker.evaluate(async () => chrome.storage.local.get(null)) as Promise<Record<string, unknown>>;
    },
    async rpc<T>(page: Page, method: string, params?: unknown) {
      const res = (await page.evaluate(
        async ([m, p]) => chrome.runtime.sendMessage({ method: m as string, params: p }),
        [method, params] as [string, unknown],
      )) as RpcEnvelope | undefined;
      if (!res) throw new Error(`no response from ${method}`);
      if (res.error) throw new Error(`${method}: ${res.error} (${res.code ?? 'no code'})`);
      return res.result as T;
    },
    async close() {
      const clips = opts.videoDir
        ? await Promise.all(
            recorded.map(async (r) => ({ seq: r.seq, path: (await r.page.video()?.path()) ?? null })),
          )
        : [];
      await context.close(); // videos are only finalised once the context closes
      if (opts.videoDir) {
        mkdirSync(DEMO_RAW, { recursive: true });
        for (const clip of clips) {
          if (clip.path) appendFileSync(DEMO_ORDER, `${String(clip.seq).padStart(4, '0')}\t${clip.path}\n`);
        }
      }
    },
  };

  // Point the wallet at the mock backend before the first popup opens, and stop
  // the first-run onboarding tab from stealing focus mid-journey.
  const worker = await device.worker();
  await worker.evaluate(async (explorerBase: string) => {
    await chrome.storage.local.set({ backend: { explorerBase, node: null } });
    try {
      await chrome.storage.session.set({ onboardTabOpened: true });
    } catch {
      /* storage.session is not available in every channel */
    }
  }, opts.explorerBase);

  // Granted context-wide: Chrome does not honour a per-origin grant for a
  // chrome-extension:// origin, and the receive journey reads the clipboard
  // back rather than trusting the popup's "copied" toast.
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  } catch {
    /* clipboard permissions are optional; the toast is asserted either way */
  }

  return device;
}

// ------------------------------------------------------------------ gestures

/** Create a wallet through the real onboarding flow; returns the 12 words. */
export async function createWallet(page: Page, password: string): Promise<string[]> {
  await page.getByTestId('welcome-create').click();
  await page.getByTestId('pw').fill(password);
  await page.getByTestId('pw2').fill(password);
  await page.getByTestId('pw-continue').click();

  await expect(page.getByTestId('seed-word-1')).toBeVisible({ timeout: 30_000 });
  const words: string[] = [];
  for (let i = 1; i <= 12; i++) {
    words.push(((await page.getByTestId(`seed-word-${i}`).textContent()) ?? '').trim());
  }
  await page.getByTestId('seed-continue').click();

  await confirmSeed(page, words);
  return words;
}

/** Fill the three challenge words the wallet asks for and seal the vault. */
export async function confirmSeed(page: Page, words: string[]): Promise<void> {
  await expect(page.getByTestId('confirm-seal')).toBeVisible();
  const fields = page.locator('input[data-word]');
  const count = await fields.count();
  for (let i = 0; i < count; i++) {
    const field = fields.nth(i);
    const position = Number(await field.getAttribute('data-word'));
    await field.fill(words[position - 1] ?? '');
  }
  await page.getByTestId('confirm-seal').click();
  await expect(page.getByTestId('balance')).toBeVisible({ timeout: 30_000 });
}

export async function importMnemonic(page: Page, mnemonic: string, password: string): Promise<void> {
  await page.getByTestId('welcome-import').click();
  await page.getByTestId('import-mnemonic').click();
  await page.getByTestId('import-text').fill(mnemonic);
  await page.getByTestId('pw').fill(password);
  await page.getByTestId('pw2').fill(password);
  await page.getByTestId('import-submit').click();
}

export async function importRawSeed(page: Page, seedHex: string, password: string): Promise<void> {
  await page.getByTestId('welcome-import').click();
  await page.getByTestId('import-raw').click();
  await page.getByTestId('import-text').fill(seedHex);
  await page.getByTestId('pw').fill(password);
  await page.getByTestId('pw2').fill(password);
  await page.getByTestId('import-submit').click();
}

export async function unlock(page: Page, password: string): Promise<void> {
  await page.getByTestId('unlock-pw').fill(password);
  await page.getByTestId('unlock-submit').click();
}

/**
 * Wait for the gap scan to settle. `copy-address` is enabled exactly when the
 * popup considers the scan finished and the receive address final, so it is the
 * one signal that means "the numbers on this screen are the final ones".
 */
export async function waitForScan(page: Page, timeout = 60_000): Promise<void> {
  // `receive-address` only exists on the Receive tab, which is where a scan is
  // observable; make sure that is the tab we are looking at.
  if ((await page.getByTestId('receive-address').count()) === 0) {
    const tab = page.getByTestId('tab-receive');
    if ((await tab.count()) > 0) await tab.click();
  }
  await expect(page.getByTestId('receive-address')).toBeVisible({ timeout });
  await expect(page.getByTestId('copy-address')).toBeEnabled({ timeout });
}

/** Click the header refresh and wait for the scan it starts. */
export async function refresh(page: Page): Promise<void> {
  await page.getByTestId('refresh').click();
  await waitForScan(page);
}

/**
 * Wait for the outcome of a send, whichever way it went.
 *
 * The popup shows a result card when it managed to sign, and an inline `error`
 * when it did not — `signPlan` refuses to hand back a witness that is not a
 * 2421-byte SIGHASH_ALL signature, and then there is no result card to wait for
 * at all. Racing the two turns "the wallet can no longer sign" from a 60 s
 * element-not-found into a one-line failure that names the reason.
 */
export async function waitForSendResult(page: Page, timeout = 60_000): Promise<void> {
  const status = page.getByTestId('result-status');
  const failure = page.getByTestId('error');
  await expect
    .poll(
      async () => {
        if ((await status.count()) > 0) return 'result';
        if ((await failure.count()) > 0) return 'error';
        return 'waiting';
      },
      { timeout, message: 'the popup produced neither a send result nor an error' },
    )
    .not.toBe('waiting');
  if ((await status.count()) === 0) {
    throw new Error(`the wallet refused to sign: ${(await failure.first().innerText()).trim()}`);
  }
}

/** The dark modules of a rendered QR, as "x,y" pairs in document order. */
export async function qrCells(page: Page, testId: string): Promise<string> {
  return page
    .getByTestId(testId)
    .evaluate((svg) =>
      [...svg.querySelectorAll('rect')].map((r) => `${r.getAttribute('x')},${r.getAttribute('y')}`).join(' '),
    );
}

export async function openSettings(page: Page): Promise<void> {
  await page.getByTestId('gear').click();
  await expect(page.getByTestId('explorer-url')).toBeVisible();
}

export async function leaveSettings(page: Page): Promise<void> {
  await page.getByTestId('settings-back').click();
  await expect(page.getByTestId('balance')).toBeVisible();
}

/** The address the wallet is currently showing, read from its data attribute. */
export async function receiveAddress(page: Page): Promise<string> {
  return (await page.getByTestId('receive-address').getAttribute('data-address')) ?? '';
}

/** Wait for the site-connect approval window the service worker opens. */
export async function waitForApprovalPage(context: BrowserContext, timeout = 30_000): Promise<Page> {
  const existing = context.pages().find((p) => p.url().includes('connect=1'));
  if (existing) return existing;
  const page = await context.waitForEvent('page', {
    predicate: (p) => p.url().includes('connect=1'),
    timeout,
  });
  await page.waitForSelector('[data-testid="connect-origin"]', { timeout });
  return page;
}
