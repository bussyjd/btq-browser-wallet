/**
 * Recording-only redaction of the recovery phrase.
 *
 * Both demo videos are real recordings of the extension, so every screen the
 * tests walk through is painted for real — including the four that put a phrase
 * on screen: the twelve-word grid during onboarding, that same grid again in the
 * Settings reveal, the three confirmation fields, and the import textarea the
 * phrase is typed back into. Three selectors cover all four, because the two
 * grids are one component. A wallet repository must not ship a legible recovery
 * phrase, so when `RECORD_VIDEO` is set those surfaces are covered *before the
 * first frame is painted*: the glyphs never reach a pixel, and the bars that
 * replace them are one fixed width, so the word lengths do not survive either
 * (per-word widths would leak all twelve).
 *
 * This changes pixels and nothing else. The DOM keeps the real words, so the
 * tests still read the phrase the wallet generated, type it back in and assert
 * on it. With `RECORD_VIDEO` unset, every function here returns immediately.
 */
import { expect, type BrowserContext, type Page } from '@playwright/test';

/** True when this run is being recorded for the demo video. */
export const RECORDING = Boolean(process.env.RECORD_VIDEO);

/** The twelve-word grid — onboarding, and the Settings → Security reveal. */
export const SEED_WORDS = '[data-testid^="seed-word-"]';
/** The three "Word N" challenge fields on the confirmation screen. */
export const SEED_CHALLENGE = '[data-word]';
/** The textarea a phrase (or a raw HD seed) is imported through. */
export const SEED_INPUT = '[data-testid="import-text"]';

/**
 * Cover the phrase in every page this context opens, for the whole of its life.
 *
 * The stylesheet goes in through an init script, which runs before the popup's
 * own scripts, and the loop that attaches it runs on the first animation frame
 * — before anything has been painted. Pages the service worker opens by itself
 * (the site-connect approval window) are covered too, because the script is
 * registered on the context rather than on a page.
 */
export async function installRedaction(context: BrowserContext): Promise<void> {
  if (!RECORDING) return;
  await context.addInitScript(() => {
    const STYLE_ID = 'btq-recording-redaction';
    const FILLED = 'btq-redacted';
    // One neutral ink that reads on both themes, at the weight the README
    // screenshot uses for the same job.
    const BAR = 'rgba(123, 135, 148, 0.5)';
    const css = `
      /* The twelve-word grid. font-size:0 means no glyph is laid out at all;
         the bar that replaces it is the same width in all twelve cells. */
      [data-testid^="seed-word-"] {
        font-size: 0 !important;
        color: transparent !important;
        -webkit-text-fill-color: transparent !important;
      }
      [data-testid^="seed-word-"]::after {
        content: '';
        display: inline-block;
        width: 62px;
        height: 10px;
        border-radius: 3px;
        background: ${BAR};
      }
      /* Form controls cannot carry a pseudo-element, so the characters are made
         invisible and the bar is painted as a background instead. Positions are
         relative to the content box, so they land on the text's own lines. */
      [data-word], [data-testid="import-text"] {
        color: transparent !important;
        caret-color: transparent !important;
        -webkit-text-fill-color: transparent !important;
        background-origin: content-box !important;
        background-repeat: no-repeat !important;
      }
      [data-word].${FILLED} {
        background-image: linear-gradient(${BAR} 0 0) !important;
        background-size: 62px 10px !important;
        background-position: 0 center !important;
      }
      [data-testid="import-text"].${FILLED} {
        background-image:
          linear-gradient(${BAR} 0 0),
          linear-gradient(${BAR} 0 0),
          linear-gradient(${BAR} 0 0) !important;
        background-size: 100% 10px, 88% 10px, 34% 10px !important;
        background-position: 0 4px, 0 23px, 0 42px !important;
      }`;

    const attach = () => {
      const root = document.head ?? document.documentElement;
      if (!root || document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = css;
      root.appendChild(style);
    };

    /**
     * The bars are cosmetic: a field's characters are invisible whether or not
     * it carries the class, so this can lag a frame without ever exposing
     * anything. It exists so an empty field looks empty rather than redacted.
     */
    const bars = () => {
      const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        '[data-word], [data-testid="import-text"]',
      );
      for (const field of fields) {
        const filled = field.value.trim().length > 0;
        if (field.classList.contains(FILLED) !== filled) field.classList.toggle(FILLED, filled);
      }
    };

    attach();
    const frame = () => {
      attach();
      bars();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

/**
 * Fail the run if a phrase surface would paint its characters.
 *
 * Without this a renamed test id would put a legible phrase back into the demo
 * video and nothing would say so — the tests would still pass, because they
 * read the DOM and the DOM is untouched. Recording-only, like everything else
 * in this file.
 */
export async function expectRedacted(page: Page, selector: string, count: number): Promise<void> {
  if (!RECORDING) return;
  const cells = await page.locator(selector).evaluateAll((els) =>
    els.map((el) => {
      const s = getComputedStyle(el);
      return {
        name: el.getAttribute('data-testid') ?? el.getAttribute('data-word') ?? el.tagName.toLowerCase(),
        covered:
          s.fontSize === '0px' ||
          s.color === 'rgba(0, 0, 0, 0)' ||
          s.webkitTextFillColor === 'rgba(0, 0, 0, 0)',
      };
    }),
  );
  expect(cells.length, `RECORD_VIDEO: "${selector}" matched nothing, so nothing was redacted`).toBe(
    count,
  );
  const leaking = cells.filter((c) => !c.covered).map((c) => c.name);
  expect(leaking, `RECORD_VIDEO: these would paint a recovery phrase into the video`).toEqual([]);
}
