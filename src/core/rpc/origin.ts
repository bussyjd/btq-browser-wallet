/**
 * Classify extension-message senders. Pages and content scripts are untrusted;
 * only same-extension pages (the action popup, the site-connect approval
 * window, an onboarding tab) may call wallet.*.
 *
 * The browser fills in `sender.origin` itself — a page cannot forge it — so an
 * exact match against our own origin is the whole test. `sender.tab` is NOT a
 * proxy for "untrusted": an extension page opened in a tab or in a popup window
 * has a tab too, and both the approval window (`chrome.windows.create`) and an
 * onboarding tab need to reach wallet.*. A content script always carries the
 * *page's* origin, so it still fails the match, and `src/ui/index.html` is not
 * a web-accessible resource, so no site can host it under our origin.
 *
 * Origin matching is exact — never startsWith/includes. When the browser gives
 * no origin at all (older engines, non-Chrome ports) we fall back to the
 * conservative rule: anything attached to a tab is untrusted.
 */
export function isUntrustedSender(
  sender: { tab?: unknown; origin?: string; url?: string },
  extensionOrigin: string,
): boolean {
  const origin = senderOrigin(sender);
  if (origin !== undefined) return origin !== extensionOrigin;
  return sender.tab !== undefined;
}

/** The sender's origin: `origin` when the browser set it, else derived from `url`. */
function senderOrigin(sender: { origin?: string; url?: string }): string | undefined {
  if (typeof sender.origin === 'string') return sender.origin;
  if (typeof sender.url === 'string') {
    // chrome-extension: is not a "special scheme", so `new URL(u).origin` is
    // the string "null" for it — take scheme://authority off the front by hand.
    const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i.exec(sender.url);
    if (m?.[1] !== undefined) return m[1];
  }
  return undefined;
}
