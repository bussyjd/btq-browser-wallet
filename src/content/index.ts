/**
 * Content relay (isolated world). Forwards allowlisted inpage messages to the
 * service worker and forwards wallet events back to the page. The page-facing
 * provider (src/inpage/btq-provider.js) is injected by the manifest into the
 * MAIN world, so this file never touches the page DOM. Never imports vault,
 * keyring, or HD helpers.
 *
 * This file has NO imports, on purpose. With one, the bundler ships the content
 * script as a loader that dynamic-imports the real chunk, so the message
 * listener below registers a few milliseconds after document_start — and a page
 * that calls `window.btq.request()` from an inline script at the top of the
 * document posts into a void and waits forever. Import-free, the listener is
 * live the moment the document starts.
 *
 * The price is that the allowlist is spelled out twice; the service worker
 * gates on `PAGE_METHODS` in src/core/connect/permissions.ts and
 * tests/security/connect-relay.test.ts fails if the two ever drift.
 */
const PAGE_METHOD_SET: ReadonlySet<string> = new Set([
  'page.requestAccounts',
  'page.getAccounts',
  'page.disconnect',
]);

type RelayReq = { channel: 'btq-wallet'; id: number; kind: 'request'; method: string; params?: unknown };
type WalletEvent = { channel?: unknown; kind?: unknown; event?: unknown; origin?: unknown; accounts?: unknown };

const CHANNEL = 'btq-wallet';

function reply(id: number, body: { result?: unknown; error?: string; code?: string }): void {
  window.postMessage({ channel: CHANNEL, id, kind: 'response', ...body }, window.location.origin);
}

window.addEventListener('message', (event: MessageEvent<RelayReq>) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || data.channel !== CHANNEL || data.kind !== 'request') return;
  if (typeof data.id !== 'number') return;
  if (typeof data.method !== 'string' || !PAGE_METHOD_SET.has(data.method)) {
    reply(data.id, { error: 'This method is not available to pages.', code: 'FORBIDDEN' });
    return;
  }
  void chrome.runtime.sendMessage(
    { method: data.method, params: data.params },
    (res: { result?: unknown; error?: string; code?: string } | undefined) => {
      // The worker can be torn down while it holds a connect request; Chrome then
      // closes the channel and leaves the reason in lastError instead of a reply.
      const lost = chrome.runtime.lastError;
      if (lost || !res) {
        reply(data.id, { error: 'BTQ Wallet is not available right now. Try again.', code: 'DISCONNECTED' });
        return;
      }
      reply(data.id, { result: res.result, error: res.error, code: res.code });
    },
  );
});

// Wallet → page events (accountsChanged). Only events addressed to this page's
// own origin are forwarded, so one site's revocation is never visible to another.
chrome.runtime.onMessage.addListener((message: WalletEvent) => {
  if (!message || message.channel !== CHANNEL || message.kind !== 'event') return;
  if (message.origin !== window.location.origin) return;
  if (message.event !== 'accountsChanged') return;
  const accounts = Array.isArray(message.accounts) ? message.accounts.filter((a) => typeof a === 'string') : [];
  window.postMessage(
    { channel: CHANNEL, kind: 'event', event: 'accountsChanged', accounts },
    window.location.origin,
  );
});

// Marks the file as an ES module so the test suite can import it. No runtime
// import is added, so the bundler still emits it as a standalone content script.
export {};
