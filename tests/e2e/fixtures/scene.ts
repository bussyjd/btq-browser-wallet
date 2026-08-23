/**
 * Pacing, captions and the secret guard — recording-only, live demo only.
 *
 * `slowMo` on the context is right for gesture *rhythm*: it puts a beat between
 * clicks and keystrokes so a viewer can follow the pointer. It is wrong for
 * *reading* time, because it also stretches every internal poll. So the two are
 * split: the context carries `slowMo`, and the handful of moments where a
 * viewer has to actually read something carry an explicit `dwell()`.
 *
 * Everything here is inert unless `RECORD_VIDEO` is set, and the captions are
 * inert unless the device was launched with `captions: true`. Between those two
 * gates and the fact that only `live.spec.ts` passes the flag, nothing in this
 * file can reach the mocked suite. `tests/unit/demo-live.test.ts` holds all
 * three of those statements down.
 *
 * `waitForTimeout` is deliberately absent: the mocked suite must never grow a
 * wall-clock sleep, so the only sleeping done here is on the Node side, in
 * `dwell()`, which returns immediately when the run is not being recorded.
 */
import { expect, type BrowserContext, type Page } from '@playwright/test';

export { RECORDING } from './redact.js';
import { RECORDING } from './redact.js';

/** The overlay root, and the handle the Node side calls into. */
const ROOT_ID = 'btq-scene';

/**
 * Password inputs the popup can render, by the ids the testid contract pins.
 * Each one is asserted to still be `type="password"` — that is what catches a
 * stray click on the Show/Hide toggle in `components/Field.tsx`.
 */
export const PASSWORD_FIELDS = ['pw', 'pw2', 'unlock-pw', 'node-pw', 'send-pw', 'reveal-pw'];

/** A value that must never reach a frame, with a name that is safe to print. */
export interface Secret {
  /** Named in failures — e.g. "BTQ_DEMO_RPC_PASSWORD". Never the value itself. */
  label: string;
  value: string;
}

/**
 * Install the caption overlay in every page this context opens.
 *
 * Same mechanism as `redact.ts`: an init script, so a page the service worker
 * opens by itself (the site-connect approval window) is covered too. The root
 * is `pointer-events: none`, which is load-bearing — a full-viewport element
 * that swallowed clicks would break every gesture underneath it.
 */
export async function installCaptions(context: BrowserContext): Promise<void> {
  if (!RECORDING) return;
  await context.addInitScript((rootId: string) => {
    const FADE_MS = 300;

    const css = `
      #${rootId} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        pointer-events: none;
        font: 500 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      #${rootId} .btq-scene-card {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 10px;
        padding: 0 28px;
        text-align: center;
        background: rgba(6, 10, 16, 0.86);
        color: #f2f6fa;
        opacity: 1;
        transition: opacity ${FADE_MS}ms ease-out;
      }
      #${rootId} .btq-scene-card.btq-out { opacity: 0; }
      #${rootId} .btq-scene-title { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; }
      #${rootId} .btq-scene-sub { font-size: 14px; font-weight: 400; color: #aebac7; max-width: 30em; }
      #${rootId} .btq-scene-chip {
        position: absolute;
        left: 10px;
        bottom: 10px;
        padding: 3px 9px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.04em;
        color: #cfd8e2;
        background: rgba(6, 10, 16, 0.62);
      }
      #${rootId} .btq-scene-note {
        position: absolute;
        left: 0;
        right: 0;
        top: 0;
        padding: 6px 12px;
        font-size: 13px;
        font-weight: 500;
        text-align: center;
        color: #f2f6fa;
        background: rgba(6, 10, 16, 0.82);
        opacity: 1;
        transition: opacity ${FADE_MS}ms ease-out;
      }
      #${rootId} .btq-scene-note.btq-out { opacity: 0; }`;

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    function root(): HTMLElement {
      let el = document.getElementById(rootId);
      if (!el) {
        el = document.createElement('div');
        el.id = rootId;
        const style = document.createElement('style');
        style.textContent = css;
        el.appendChild(style);
        (document.body ?? document.documentElement).appendChild(el);
      }
      return el;
    }

    const api = {
      /** Dim, name the scene, hold, fade, and leave a numbered corner chip. */
      async card(n: number, title: string, sub: string | null, hold: number): Promise<void> {
        const host = root();
        const card = document.createElement('div');
        card.className = 'btq-scene-card';
        const h = document.createElement('div');
        h.className = 'btq-scene-title';
        h.textContent = `${n} — ${title}`;
        card.appendChild(h);
        if (sub) {
          const p = document.createElement('div');
          p.className = 'btq-scene-sub';
          p.textContent = sub;
          card.appendChild(p);
        }
        host.appendChild(card);
        await sleep(hold);
        card.classList.add('btq-out');
        await sleep(FADE_MS);
        card.remove();
        api.chip(n, title);
      },
      /** The small persistent marker, so a viewer never loses their place. */
      chip(n: number, title: string): void {
        const host = root();
        host.querySelector('.btq-scene-chip')?.remove();
        const chip = document.createElement('div');
        chip.className = 'btq-scene-chip';
        chip.textContent = `${n} · ${title}`;
        host.appendChild(chip);
      },
      /** A thin line over the header, for a remark inside a scene. */
      async note(text: string, ms: number): Promise<void> {
        const host = root();
        host.querySelector('.btq-scene-note')?.remove();
        const line = document.createElement('div');
        line.className = 'btq-scene-note';
        line.textContent = text;
        host.appendChild(line);
        await sleep(ms);
        line.classList.add('btq-out');
        await sleep(FADE_MS);
        line.remove();
      },
    };

    (window as unknown as Record<string, unknown>).__btqScene = api;

    // The root is created lazily by the first call, but attach it up front too
    // so `expectCaptions` can see the overlay before any caption is drawn.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => root(), { once: true });
    } else {
      root();
    }
  }, ROOT_ID);
}

/**
 * Run something against the overlay.
 *
 * A missing overlay is a *failure* while recording — a video that quietly lost
 * its captions is worse than a run that stopped and said so. Off camera it is a
 * no-op, so the same spec can be run without `RECORD_VIDEO` to check its logic.
 */
async function withOverlay(page: Page, what: string, run: () => Promise<void>): Promise<void> {
  if (!RECORDING) return;
  const installed = await page.evaluate(
    () => typeof (window as unknown as Record<string, unknown>).__btqScene === 'object',
  );
  if (!installed) {
    throw new Error(
      `${what}: no caption overlay on ${page.url()} — launch the device with captions: true`,
    );
  }
  await run();
}

/** Assert the overlay is installed on this page. Recording-only. */
export async function expectCaptions(page: Page): Promise<void> {
  if (!RECORDING) return;
  await expect
    .poll(
      () =>
        page.evaluate(
          () => typeof (window as unknown as Record<string, unknown>).__btqScene === 'object',
        ),
      { timeout: 10_000, message: 'the caption overlay was never installed on this page' },
    )
    .toBe(true);
}

/** Title card: dim, "N — title", hold, fade, leave the numbered chip. */
export async function scene(
  page: Page,
  n: number,
  title: string,
  opts: { sub?: string; hold?: number } = {},
): Promise<void> {
  const hold = opts.hold ?? 2200;
  const sub = opts.sub ?? null;
  await withOverlay(page, `scene ${n}`, () =>
    page.evaluate(
      async ([num, text, subtitle, ms]) => {
        const api = (window as unknown as Record<string, any>).__btqScene;
        await api.card(num as number, text as string, subtitle as string | null, ms as number);
      },
      [n, title, sub, hold] as [number, string, string | null, number],
    ),
  );
}

/** A remark inside a scene, on a thin line over the header. */
export async function note(page: Page, text: string, ms = 2600): Promise<void> {
  await withOverlay(page, 'note', () =>
    page.evaluate(
      async ([message, hold]) => {
        const api = (window as unknown as Record<string, any>).__btqScene;
        await api.note(message as string, hold as number);
      },
      [text, ms] as [string, number],
    ),
  );
}

/**
 * Reading time, and the only thing in the suite that buys any.
 *
 * The wait is on the Node side rather than `page.waitForTimeout` so that no
 * spec — mocked or live — ever grows a wall-clock sleep against a page.
 */
export async function dwell(_page: Page, ms = 1800): Promise<void> {
  if (!RECORDING) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Type into a field the way a person does. `fill()` looks like a paste, which
 * reads as a trick in a recording of a wallet.
 */
export async function typeInto(
  page: Page,
  testId: string,
  text: string,
  opts: { delay?: number } = {},
): Promise<void> {
  const field = page.getByTestId(testId);
  await field.click();
  await field.fill('');
  await field.pressSequentially(text, { delay: RECORDING ? (opts.delay ?? 45) : 0 });
}

/**
 * Prove nothing on this page shows a value that must not reach a frame.
 *
 * Two independent checks, because there are two ways a credential gets into a
 * video: the Show/Hide toggle flipping a password field to `type="text"`, and
 * an error string quoting what it was given. So every password field the popup
 * can render is asserted to still be masked, and the visible text plus every
 * non-password field value is searched for each secret.
 *
 * Failures name the field and the *label* of the secret, never its value: an
 * assertion that prints the RPC password into the terminal and into the HTML
 * report is a worse leak than the one it was guarding against.
 */
export async function expectNoSecret(
  page: Page,
  secrets: Secret[],
  { expectsPasswordField = false }: { expectsPasswordField?: boolean } = {},
): Promise<void> {
  const wanted = secrets.filter((s) => s.value.length > 0);

  const masking = await page.evaluate((ids: string[]) => {
    const bad: string[] = [];
    let checked = 0;
    for (const id of ids) {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el) continue;
      checked += 1;
      if ((el as HTMLInputElement).type !== 'password') bad.push(id);
    }
    return { bad, checked };
  }, PASSWORD_FIELDS);
  expect(masking.bad, 'these password fields are showing their characters on camera').toEqual([]);
  // Skipping every field silently would disarm half this guard the day a testid
  // is renamed: a screen with a password on it must have had one field checked.
  if (expectsPasswordField) {
    expect(masking.checked, 'no password field was found to check for masking').toBeGreaterThan(0);
  }

  if (wanted.length === 0) return;

  const surfaces = await page.evaluate(() => {
    const fields: { name: string; value: string }[] = [];
    const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input, textarea',
    );
    for (const input of inputs) {
      if ((input as HTMLInputElement).type === 'password') continue;
      fields.push({
        name: input.getAttribute('data-testid') ?? (input.id || input.tagName.toLowerCase()),
        value: input.value,
      });
    }
    return { text: document.body?.innerText ?? '', fields };
  });

  const found: string[] = [];
  for (const secret of wanted) {
    if (surfaces.text.includes(secret.value)) found.push(`${secret.label} in the page text`);
    for (const field of surfaces.fields) {
      if (field.value.includes(secret.value)) found.push(`${secret.label} in field "${field.name}"`);
    }
  }
  expect(found, 'a value that must never be recorded is visible on this page').toEqual([]);
}
