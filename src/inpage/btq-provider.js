/**
 * Page-facing provider. Classic-script IIFE (no modules, no TypeScript).
 * Injected into the page MAIN world. No key material.
 */
(function (window) {
  'use strict';

  var pending = new Map();
  var nextId = 1;

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    var data = event.data;
    if (!data || data.channel !== 'btq-wallet' || data.kind !== 'response') return;
    var wait = pending.get(data.id);
    if (!wait) return;
    pending.delete(data.id);
    if (data.error) wait.reject(new Error(data.error));
    else wait.resolve(data.result);
  });

  function call(method, params) {
    var id = nextId++;
    var msg = { channel: 'btq-wallet', id: id, kind: 'request', method: method, params: params };
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
      window.postMessage(msg, window.location.origin);
    });
  }

  function mapMethod(method) {
    if (method === 'btq_requestAccounts' || method === 'eth_requestAccounts') return 'page.requestAccounts';
    if (method === 'btq_accounts' || method === 'eth_accounts') return 'page.getAccounts';
    if (method === 'btq_disconnect') return 'page.disconnect';
    throw new Error('BTQ Wallet does not support ' + method);
  }

  if (!window.btq) {
    window.btq = {
      isBtq: true,
      request: function (args) {
        return call(mapMethod(args.method), args.params);
      },
    };
  }
})(window);
