/**
 * Content relay. Forwards inpage messages to the service worker.
 * Never imports vault, keyring, or HD helpers.
 */
export {};

type RelayReq = { channel: 'btq-wallet'; id: number; kind: 'request'; method: string; params?: unknown };

const script = document.createElement('script');
script.src = chrome.runtime.getURL('src/inpage/btq-provider.js');
script.onload = () => script.remove();
(document.documentElement || document.head).appendChild(script);

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
