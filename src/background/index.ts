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
import {
  ConnectBroker,
  CONNECT_TIMEOUT_MS,
  freshPrompts,
  parsePendingPrompts,
  USER_REJECTED_REPLY,
  type ConnectReply,
  type ConnectResponder,
  type PendingPrompt,
} from './connect.js';
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

// ------------------------------------------------------------ connect lifecycle

/** The timestamped mirror of the broker's parked requests, for the popup. */
const PROMPTS_KEY = 'pendingConnects';
/** The single-slot record older builds wrote. Migrated away on first read. */
const LEGACY_PROMPT_KEY = 'pendingConnect';

const broker = new ConnectBroker({
  onCountChanged: (count) => {
    setPendingBadge(count);
    void mirrorPrompts();
  },
  closeWindow: (windowId) => {
    void Promise.resolve(chrome.windows.remove(windowId)).catch(() => undefined);
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

async function readKey(key: string): Promise<unknown> {
  try {
    const record: Record<string, unknown> = await chrome.storage.local.get(key);
    return record?.[key];
  } catch {
    return undefined;
  }
}

/** Write the mirror; an empty list removes both it and the legacy record. */
async function writePrompts(prompts: readonly PendingPrompt[]): Promise<void> {
  try {
    if (prompts.length > 0) await chrome.storage.local.set({ [PROMPTS_KEY]: [...prompts] });
    else await chrome.storage.local.remove(PROMPTS_KEY);
    await chrome.storage.local.remove(LEGACY_PROMPT_KEY);
  } catch {
    /* storage is unavailable; the broker is still the authority */
  }
}

/** Keep the stored mirror in step with whatever the broker is really holding. */
async function mirrorPrompts(): Promise<void> {
  await writePrompts(broker.prompts());
}

/**
 * The prompts a popup may act on.
 *
 * Three filters, all of them load-bearing: the record must parse (storage is
 * writable by anything with extension access), it must be inside the 5-minute
 * timeout (**L3** — a prompt from a worker generation that is gone must not be
 * approvable days later), and the broker must still be holding it (**M1** — a
 * prompt with no parked responder is a grant nobody asked for). Anything that
 * fails is dropped from storage as it is read.
 */
async function livePrompts(): Promise<PendingPrompt[]> {
  const stored = parsePendingPrompts(await readKey(PROMPTS_KEY), await readKey(LEGACY_PROMPT_KEY));
  const held = new Set(broker.origins());
  const live = freshPrompts(stored, Date.now(), CONNECT_TIMEOUT_MS).filter((p) => held.has(p.origin));
  if (live.length !== stored.length) await writePrompts(live);
  return live;
}

/**
 * Open the approval UI as a dedicated window, MetaMask-style, and return its id
 * so the broker can close it once the request settles.
 *
 * The origin travels in the URL: the window then renders and approves *that*
 * site, not "whichever request the worker happens to hold when the popup
 * loads". Without it, a second site racing a first one takes over the first
 * one's window and gets granted from it.
 *
 * Deliberately not `chrome.action.openPopup()`: the toolbar popup has no window
 * id, so nothing can close it when the request settles, it disappears the
 * moment the user clicks elsewhere (which is not a decision), and it is
 * unreachable from an automated browser — the end-to-end suite could never
 * drive the approval it is supposed to prove. It stays as the last resort when
 * no window can be created at all.
 */
async function openApprovalUi(origin: string): Promise<number | null> {
  const url = chrome.runtime.getURL(`src/ui/index.html?connect=1&origin=${encodeURIComponent(origin)}`);
  try {
    const win = await chrome.windows.create({
      url,
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
    // Nothing could be opened. The prompt is still mirrored, so the user sees it
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
  const outcome = broker.hold(canonical, respond);
  // Too many sites are already waiting: answer this one rather than opening an
  // unbounded pile of focused popups the user has to dismiss one by one.
  if (outcome === 'refused') {
    respond({ ...USER_REJECTED_REPLY });
    return;
  }
  if (outcome === 'joined') return; // this origin already has an approval window open
  const windowId = await openApprovalUi(canonical);
  if (windowId !== null) broker.attachWindow(canonical, windowId);
}

/**
 * The origin an approval window was opened for, taken from the sender's own URL.
 *
 * `sender.url` is reported by the browser for the extension page that sent the
 * message; page script cannot set it. It is therefore a stronger binding than a
 * parameter: the window that origin A opened can only ever speak for A.
 * `undefined` for the toolbar popup, which was not opened for anyone.
 */
function approvalWindowOrigin(senderUrl: string | undefined): string | null {
  if (!senderUrl) return null;
  try {
    const url = new URL(senderUrl);
    if (url.searchParams.get('connect') !== '1') return null;
    const raw = url.searchParams.get('origin');
    return raw ? canonicalOrigin(raw) : null;
  } catch {
    return null;
  }
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

/**
 * What this origin may see right now, straight from the keyring's own rule:
 * the active account's address when that (origin, account) pair is approved,
 * `[]` otherwise. Never throws — an event the worker cannot compute must not
 * take down the RPC answer the popup is waiting for.
 */
async function accountsForOrigin(origin: string): Promise<string[]> {
  try {
    return (await keyring.getAccounts(origin)).accounts;
  } catch {
    return [];
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

/**
 * This worker generation holds nothing.
 *
 * A parked `sendResponse` cannot survive the worker that owns it, so every
 * prompt the previous generation left in storage — and every count left on the
 * toolbar badge — is describing a request that no longer exists. Reconciling at
 * startup rather than at the next popup open is what stops a badge reading "1"
 * over a site nobody is holding, and what makes a lost approval look lost
 * instead of pending. Nothing is granted either way: `approveConnect` requires
 * the broker to be holding the origin, and the broker is empty here.
 */
setPendingBadge(0);
void mirrorPrompts();

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create('autolock', { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'autolock') keyring.maybeAutoLock();
});

chrome.windows.onRemoved.addListener((windowId) => {
  broker.windowClosed(windowId);
});

/**
 * Which request a `wallet.denyConnect` settles, most trustworthy source first:
 * the approval window's own URL, then an origin the caller named, then the only
 * request outstanding. Never "everything waiting" — cancelling one prompt must
 * not reject a site the user never looked at.
 */
function denyTarget(params: unknown, windowOrigin: string | null): string | null {
  if (windowOrigin) return windowOrigin;
  const named = originParam(params);
  if (named) return named;
  const waiting = broker.origins();
  return waiting.length === 1 ? (waiting[0] ?? null) : null;
}

async function handleMessage(
  message: RpcRequest,
  fromTab: boolean,
  pageOrigin: string | undefined,
  senderUrl: string | undefined,
  sendResponse: ConnectResponder,
): Promise<void> {
  const method = message?.method;
  const windowOrigin = fromTab ? null : approvalWindowOrigin(senderUrl);

  // ---- connect gates, before the keyring is asked to grant anything ----

  if (!fromTab && method === 'wallet.pendingConnect') {
    // Answered from the broker, not from storage: only a request with a live
    // parked responder behind it is one the user can honestly act on.
    const live = await livePrompts();
    // A dedicated approval window may only ever learn about the request it was
    // opened for. Two things turn on that: it must not render a second site's
    // prompt under the origin in its own URL, and — since the window outlives
    // the worker that opened it — asking again is how it finds out that its own
    // request died in a restart. The toolbar popup, opened for nobody, still
    // sees whatever is outstanding.
    const visible = windowOrigin === null ? live : live.filter((p) => p.origin === windowOrigin);
    sendResponse({ result: visible.length > 0 ? { origin: visible[0]?.origin } : null });
    return;
  }

  if (!fromTab && method === 'wallet.approveConnect') {
    const origin = originParam(message.params);
    if (!origin) {
      sendResponse({ error: 'Missing origin.', code: 'BAD_PARAMS' });
      return;
    }
    if (windowOrigin !== null && windowOrigin !== origin) {
      sendResponse({ error: 'This approval window is for a different site.', code: 'FORBIDDEN' });
      return;
    }
    if (!broker.has(origin)) {
      // Reached when a window outlives its request: the site gave up, the
      // five-minute timeout fired, or this worker is a restart of the one that
      // parked the caller. Say which, because the user's next move — ask the
      // site to try again — is the same in all three and is not obvious from
      // "forbidden".
      sendResponse({
        error:
          'That request is no longer waiting: the site gave up, it timed out, or the wallet restarted while this window was open. Ask the site to connect again.',
        code: 'FORBIDDEN',
      });
      return;
    }
  }

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
    // Gated above: this origin is one the broker is holding, and it is the one
    // this window was opened for.
    const origin = originParam(message.params) as string;
    broker.approve(origin, result);
    broadcastAccountsChanged(origin, accountsOf(result));
  }
  if (!fromTab && method === 'wallet.denyConnect') {
    const origin = denyTarget(message.params, windowOrigin);
    if (origin) broker.deny(origin);
  }
  if (!fromTab && method === 'wallet.revokeSite') {
    const origin = originParam(message.params);
    // Revoking one account's grant does not disconnect the site outright: it
    // may still hold a grant for the account that is active. Ask, rather than
    // assuming — the answer is `[]` in every case that really was a disconnect.
    if (origin) broadcastAccountsChanged(origin, await accountsForOrigin(origin));
  }
  if (!fromTab && method === 'wallet.wipe') {
    // The vault the requests were waiting on no longer exists.
    broker.denyAll();
    await writePrompts([]);
  }
  if (fromTab && method === 'page.disconnect' && pageOrigin) {
    broadcastAccountsChanged(pageOrigin, []);
  }
  if (!fromTab && (method === 'wallet.switchAccount' || method === 'wallet.createAccount')) {
    // Never "here is the new address" to every site that was ever approved:
    // the grant is per (origin, account), so a site that has no grant for the
    // account now active is told `accountsChanged([])` and sees nothing until
    // the user approves it there too. The worker asks the keyring for each
    // site's answer rather than deciding here — one rule, in one place.
    for (const origin of new Set((await keyring.connectedSites()).map((s) => s.origin))) {
      broadcastAccountsChanged(origin, await accountsForOrigin(origin));
    }
  }
  sendResponse({ result });
}

chrome.runtime.onMessage.addListener((message: RpcRequest, sender, sendResponse) => {
  const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
  const fromTab = isUntrustedSender(sender, extensionOrigin);
  const pageOrigin = typeof sender.origin === 'string' ? sender.origin : undefined;
  const senderUrl = typeof sender.url === 'string' ? sender.url : undefined;
  void handleMessage(message, fromTab, pageOrigin, senderUrl, sendResponse).catch((e: unknown) => {
    sendResponse(errorReply(e));
  });
  return true;
});
