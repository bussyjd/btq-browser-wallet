import { dispatch, type DispatchContext } from '../core/rpc/dispatch.js';
import { isUntrustedSender } from '../core/rpc/origin.js';
import { canonicalOrigin } from '../core/connect/permissions.js';
import { isWalletError } from '../core/wallet/errors.js';
import { Keyring } from '../core/wallet/keyring.js';
import { ChromeWalletStorage } from './chrome-storage.js';
import { explorerBroadcast, explorerHistory, explorerLookup, explorerTip, explorerUtxos } from './explorer.js';
import { applyBackend, loadBackend, probeBackend } from './backend-store.js';
import { nodeBroadcast } from './node-rpc.js';
import { publicView } from '../core/network/backend.js';
import { ConnectBroker, type ConnectReply, type ConnectResponder } from './connect.js';
import type { RpcRequest } from '../core/rpc/protocol.js';

const keyring = new Keyring(new ChromeWalletStorage(), { network: 'testnet' });
const explorerBase = async () => (await loadBackend()).explorerBase;
const lookup = explorerLookup(explorerBase);
const fetchUtxos = explorerUtxos(explorerBase);
const fetchHistory = explorerHistory(explorerBase);
const fetchTip = explorerTip(explorerBase);
const explorerPush = explorerBroadcast(explorerBase);
const corePush = nodeBroadcast(async () => (await loadBackend()).node);

const broadcast = async (hex: string) => {
  const cfg = await loadBackend();
  if (cfg.node) return corePush(hex);
  return explorerPush(hex);
};

function context(fromTab: boolean, pageOrigin?: string): DispatchContext {
  return {
    fromTab,
    pageOrigin,
    lookup,
    fetchUtxos,
    fetchHistory,
    fetchTip,
    broadcast,
    getBackend: async () => publicView(await loadBackend()),
    setBackend: applyBackend,
    testBackend: probeBackend,
  };
}

/** Call the wallet surface from inside the worker (never on behalf of a page). */
async function callInternal(request: RpcRequest): Promise<unknown> {
  return dispatch(keyring, request, context(false));
}

// ------------------------------------------------------------ connect lifecycle

const broker = new ConnectBroker({
  onCountChanged: (count) => setPendingBadge(count),
  closeWindow: (windowId) => {
    void Promise.resolve(chrome.windows.remove(windowId)).catch(() => undefined);
  },
  onRejected: (origin, reason) => {
    // A deny arrived through `wallet.denyConnect`, which already cleared the
    // stored prompt. A timeout or a closed window did not, so clear it here.
    if (reason === 'denied') return;
    void clearStoredPendingConnect(origin);
  },
});

function setPendingBadge(count: number): void {
  try {
    void chrome.action.setBadgeBackgroundColor({ color: '#35a4ea' });
    void chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  } catch {
    /* no action API available */
  }
}

/** The origin the popup is currently prompting for, if any. */
async function storedPendingOrigin(): Promise<string | null> {
  try {
    const pending = (await callInternal({ method: 'wallet.pendingConnect' })) as { origin?: unknown } | null;
    return pending && typeof pending.origin === 'string' ? pending.origin : null;
  } catch {
    return null;
  }
}

/** Drop the stored prompt, but only when it is still the one being rejected. */
async function clearStoredPendingConnect(origin: string): Promise<void> {
  try {
    if ((await storedPendingOrigin()) !== origin) return;
    await callInternal({ method: 'wallet.denyConnect' });
  } catch {
    /* nothing left to clear */
  }
}

/**
 * Open the approval UI as a dedicated window, MetaMask-style, and return its id
 * so the broker can close it once the request settles.
 *
 * Deliberately not `chrome.action.openPopup()`: the toolbar popup has no window
 * id, so nothing can close it when the request settles, it disappears the
 * moment the user clicks elsewhere (which is not a decision), and it is
 * unreachable from an automated browser — the end-to-end suite could never
 * drive the approval it is supposed to prove. It stays as the last resort when
 * no window can be created at all.
 */
async function openApprovalUi(): Promise<number | null> {
  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL('src/ui/index.html?connect=1'),
      type: 'popup',
      width: 380,
      height: 620,
      focused: true,
    });
    if (typeof win?.id === 'number') return win.id;
  } catch {
    // No window could be created — try the toolbar popup below.
  }
  try {
    if (typeof chrome.action?.openPopup === 'function') await chrome.action.openPopup();
  } catch {
    // Nothing could be opened. The prompt is still stored, so the user sees it
    // the next time they open the popup; otherwise the request times out.
  }
  return null;
}

/** Hold the page's response until the user answers in the popup. */
async function holdForApproval(origin: string, respond: ConnectResponder): Promise<void> {
  let canonical: string;
  try {
    canonical = canonicalOrigin(origin);
  } catch {
    respond({ error: 'Invalid origin.', code: 'FORBIDDEN' });
    return;
  }
  const isFirst = broker.hold(canonical, respond);
  if (!isFirst) return; // this origin already has an approval window open
  const windowId = await openApprovalUi();
  if (windowId !== null) broker.attachWindow(canonical, windowId);
}

/**
 * Tell the content relays that an origin's accounts changed. Best effort: the
 * relay drops events that are not for its own page origin, and tabs without our
 * content script have no receiver.
 */
function broadcastAccountsChanged(origin: string, accounts: string[]): void {
  try {
    void Promise.resolve(chrome.tabs.query({}))
      .then((tabs) => {
        for (const tab of tabs ?? []) {
          if (typeof tab.id !== 'number') continue;
          try {
            void Promise.resolve(
              chrome.tabs.sendMessage(tab.id, {
                channel: 'btq-wallet',
                kind: 'event',
                event: 'accountsChanged',
                origin,
                accounts,
              }),
            ).catch(() => undefined);
          } catch {
            /* the tab is gone */
          }
        }
      })
      .catch(() => undefined);
  } catch {
    /* no tabs API available */
  }
}

function accountsOf(result: unknown): string[] {
  const accounts = (result as { accounts?: unknown } | null)?.accounts;
  return Array.isArray(accounts) ? accounts.filter((a): a is string => typeof a === 'string') : [];
}

function originParam(params: unknown): string | null {
  const raw = (params as { origin?: unknown } | null | undefined)?.origin;
  if (typeof raw !== 'string') return null;
  try {
    return canonicalOrigin(raw);
  } catch {
    return null;
  }
}

function isPendingApproval(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { pending?: unknown }).pending === true;
}

function errorReply(e: unknown): ConnectReply {
  const error = e instanceof Error ? e.message : 'Request failed.';
  const code = isWalletError(e) ? e.code : undefined;
  return { error, code };
}

// ---------------------------------------------------------------------- events

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create('autolock', { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'autolock') keyring.maybeAutoLock();
});

chrome.windows.onRemoved.addListener((windowId) => {
  broker.windowClosed(windowId);
});

async function handleMessage(
  message: RpcRequest,
  fromTab: boolean,
  pageOrigin: string | undefined,
  sendResponse: ConnectResponder,
): Promise<void> {
  const method = message?.method;
  // `wallet.denyConnect` carries no origin, so read the prompt before it is cleared.
  const denyOrigin = !fromTab && method === 'wallet.denyConnect' ? await storedPendingOrigin() : null;

  let result: unknown;
  try {
    result = await dispatch(keyring, message, context(fromTab, pageOrigin));
  } catch (e) {
    sendResponse(errorReply(e));
    return;
  }

  if (fromTab && method === 'page.requestAccounts' && isPendingApproval(result) && pageOrigin) {
    await holdForApproval(pageOrigin, sendResponse);
    return;
  }
  if (!fromTab && method === 'wallet.approveConnect') {
    const origin = originParam(message.params);
    if (origin) {
      broker.approve(origin, result);
      broadcastAccountsChanged(origin, accountsOf(result));
    }
  }
  if (!fromTab && method === 'wallet.denyConnect') {
    if (denyOrigin) broker.deny(denyOrigin);
    else broker.denyAll();
  }
  if (!fromTab && method === 'wallet.revokeSite') {
    const origin = originParam(message.params);
    if (origin) broadcastAccountsChanged(origin, []);
  }
  if (fromTab && method === 'page.disconnect' && pageOrigin) {
    broadcastAccountsChanged(pageOrigin, []);
  }
  sendResponse({ result });
}

chrome.runtime.onMessage.addListener((message: RpcRequest, sender, sendResponse) => {
  const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
  const fromTab = isUntrustedSender(sender, extensionOrigin);
  const pageOrigin = typeof sender.origin === 'string' ? sender.origin : undefined;
  void handleMessage(message, fromTab, pageOrigin, sendResponse).catch((e: unknown) => {
    sendResponse(errorReply(e));
  });
  return true;
});
