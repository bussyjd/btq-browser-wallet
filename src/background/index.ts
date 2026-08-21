import { dispatch } from '../core/rpc/dispatch.js';
import { isUntrustedSender } from '../core/rpc/origin.js';
import { isWalletError } from '../core/wallet/errors.js';
import { Keyring } from '../core/wallet/keyring.js';
import { ChromeWalletStorage } from './chrome-storage.js';
import { explorerBroadcast, explorerHistory, explorerLookup, explorerUtxos } from './explorer.js';
import { applyBackend, loadBackend, probeBackend } from './backend-store.js';
import { nodeBroadcast } from './node-rpc.js';
import { publicView } from '../core/network/backend.js';
import type { RpcRequest } from '../core/rpc/protocol.js';

const keyring = new Keyring(new ChromeWalletStorage(), { network: 'testnet' });
const explorerBase = async () => (await loadBackend()).explorerBase;
const lookup = explorerLookup(explorerBase);
const fetchUtxos = explorerUtxos(explorerBase);
const fetchHistory = explorerHistory(explorerBase);
const explorerPush = explorerBroadcast(explorerBase);
const corePush = nodeBroadcast(async () => (await loadBackend()).node);

const broadcast = async (hex: string) => {
  const cfg = await loadBackend();
  if (cfg.node) return corePush(hex);
  return explorerPush(hex);
};

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create('autolock', { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'autolock') keyring.maybeAutoLock();
});

chrome.runtime.onMessage.addListener((message: RpcRequest, sender, sendResponse) => {
  const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
  const fromTab = isUntrustedSender(sender, extensionOrigin);
  const pageOrigin = typeof sender.origin === 'string' ? sender.origin : undefined;
  dispatch(keyring, message, {
    fromTab,
    pageOrigin,
    lookup,
    fetchUtxos,
    fetchHistory,
    broadcast,
    getBackend: async () => publicView(await loadBackend()),
    setBackend: applyBackend,
    testBackend: probeBackend,
  })
    .then((result) => sendResponse({ result }))
    .catch((e: unknown) => {
      const error = e instanceof Error ? e.message : 'Request failed.';
      const code = isWalletError(e) ? e.code : undefined;
      sendResponse({ error, code });
    });
  return true;
});
