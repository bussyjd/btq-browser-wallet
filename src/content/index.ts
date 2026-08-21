/**
 * Content relay (isolated world). Forwards allowlisted inpage messages to the
 * service worker. The page-facing provider (src/inpage/btq-provider.js) is
 * injected by the manifest into the MAIN world, so this file never touches the
 * page DOM. Never imports vault, keyring, or HD helpers.
 */
export {};

type RelayReq = { channel: 'btq-wallet'; id: number; kind: 'request'; method: string; params?: unknown };

window.addEventListener('message', (event: MessageEvent<RelayReq>) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || data.channel !== 'btq-wallet' || data.kind !== 'request') return;
  const allowed = new Set(['page.requestAccounts', 'page.getAccounts', 'page.disconnect']);
  if (typeof data.method !== 'string' || !allowed.has(data.method)) {
    window.postMessage(
      { channel: 'btq-wallet', id: data.id, kind: 'response', error: 'This method is not available to pages.' },
      window.location.origin,
    );
    return;
  }
  void chrome.runtime.sendMessage({ method: data.method, params: data.params }, (res: { result?: unknown; error?: string }) => {
    window.postMessage(
      {
        channel: 'btq-wallet',
        id: data.id,
        kind: 'response',
        result: res?.result,
        error: res?.error,
      },
      window.location.origin,
    );
  });
});
