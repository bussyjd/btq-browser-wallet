/**
 * Classify extension-message senders. Pages and content scripts are untrusted;
 * only same-extension pages (popup) may call wallet.*.
 *
 * Origin matching is exact — never startsWith/includes. A sender with no
 * origin and no tab is treated as the extension (popup / service worker).
 */
export function isUntrustedSender(
  sender: { tab?: unknown; origin?: string },
  extensionOrigin: string,
): boolean {
  if (sender.tab !== undefined) return true;
  if (typeof sender.origin === 'string' && sender.origin !== extensionOrigin) return true;
  return false;
}
