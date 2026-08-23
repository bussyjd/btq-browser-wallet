/**
 * The smallest `chrome.*` that the service worker and the content relay need.
 * Only what those two files touch: runtime messaging, storage.local, alarms,
 * action badge, windows, tabs. Nothing here talks to a real browser.
 */

export interface Reply {
  result?: unknown;
  error?: string;
  code?: string;
}

export interface FakeSender {
  tab?: { id: number };
  origin?: string;
  id?: string;
  /**
   * The extension page that sent the message, as the browser reports it. The
   * worker reads the approval window's `?connect=1&origin=…` out of this, so a
   * test that wants to speak as an approval window has to supply it.
   */
  url?: string;
}

export type MessageListener = (message: unknown, sender: FakeSender, sendResponse: (reply: Reply) => void) => unknown;

/** A message sent into the worker: `settled` says whether it has answered yet. */
export interface Call {
  readonly promise: Promise<Reply>;
  settled: boolean;
  reply: Reply | null;
}

export interface OutboundMessage {
  message: unknown;
  respond: (reply: Reply | undefined, lastError?: { message: string }) => void;
}

export interface CreatedWindow {
  id: number;
  url?: string;
  type?: string;
  width?: number;
  height?: number;
  focused?: boolean;
}

export class FakeChrome {
  readonly extensionId = 'btqfakeextensionid0000000000000000';
  /**
   * `chrome.storage.local`, which outlives any one service worker. Pass an
   * existing map to model a *restart*: the browser keeps the storage and throws
   * the worker's memory away, and a second FakeChrome over the same map plus a
   * fresh `import()` of the worker module reproduces exactly that.
   */
  readonly store: Map<string, unknown>;
  readonly messageListeners: MessageListener[] = [];
  readonly windowRemovedListeners: ((windowId: number) => void)[] = [];
  readonly alarmListeners: ((alarm: { name: string }) => void)[] = [];
  readonly installedListeners: (() => void)[] = [];
  readonly windows: CreatedWindow[] = [];
  readonly removedWindows: number[] = [];
  readonly outbox: OutboundMessage[] = [];
  readonly tabMessages: { tabId: number; message: unknown }[] = [];
  tabs: { id: number }[] = [];
  badgeText = '';
  openPopupCalls = 0;
  /** Set to make `chrome.action.openPopup` reject, as it does with no focused window. */
  openPopupFails = true;
  /** Set to false to make `chrome.action.openPopup` absent (older Chrome). */
  hasOpenPopup = true;
  /** Set to make `chrome.windows.create` reject, as it does with no UI at all. */
  windowCreateFails = false;

  constructor(store: Map<string, unknown> = new Map()) {
    this.store = store;
  }

  readonly runtime = {
    id: this.extensionId,
    lastError: undefined as { message: string } | undefined,
    getURL: (path: string) => `chrome-extension://${this.extensionId}/${path}`,
    onMessage: {
      addListener: (fn: MessageListener) => {
        this.messageListeners.push(fn);
      },
    },
    onInstalled: {
      addListener: (fn: () => void) => {
        this.installedListeners.push(fn);
      },
    },
    sendMessage: (message: unknown, callback?: (reply: Reply | undefined) => void) => {
      this.outbox.push({
        message,
        respond: (reply, lastError) => {
          this.runtime.lastError = lastError;
          try {
            callback?.(reply);
          } finally {
            this.runtime.lastError = undefined;
          }
        },
      });
      return undefined;
    },
  };

  readonly storage = {
    local: {
      get: async (key: string) => (this.store.has(key) ? { [key]: this.store.get(key) } : {}),
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) this.store.set(k, v);
      },
      remove: async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) this.store.delete(k);
      },
    },
  };

  readonly alarms = {
    create: async () => undefined,
    onAlarm: {
      addListener: (fn: (alarm: { name: string }) => void) => {
        this.alarmListeners.push(fn);
      },
    },
  };

  readonly action = {
    setBadgeText: async (details: { text: string }) => {
      this.badgeText = details.text;
    },
    setBadgeBackgroundColor: async () => undefined,
    openPopup: async () => {
      this.openPopupCalls += 1;
      if (this.openPopupFails) throw new Error('no active browser window');
    },
  };

  readonly windowsApi = {
    create: async (createData: { url?: string; type?: string; width?: number; height?: number; focused?: boolean }) => {
      if (this.windowCreateFails) throw new Error('cannot create a window');
      const win: CreatedWindow = { id: 100 + this.windows.length, ...createData };
      this.windows.push(win);
      return win;
    },
    remove: async (windowId: number) => {
      this.removedWindows.push(windowId);
    },
    onRemoved: {
      addListener: (fn: (windowId: number) => void) => {
        this.windowRemovedListeners.push(fn);
      },
    },
  };

  readonly tabsApi = {
    query: async () => this.tabs.map((t) => ({ id: t.id })),
    sendMessage: async (tabId: number, message: unknown) => {
      this.tabMessages.push({ tabId, message });
    },
  };

  /** Deliver a message to the worker's listener; the reply may arrive later. */
  call(message: unknown, sender: FakeSender = { id: this.extensionId }): Call {
    let resolve!: (reply: Reply) => void;
    const promise = new Promise<Reply>((r) => {
      resolve = r;
    });
    const call: Call = { promise, settled: false, reply: null };
    const sendResponse = (reply: Reply) => {
      if (call.settled) return;
      call.settled = true;
      call.reply = reply;
      resolve(reply);
    };
    for (const listener of this.messageListeners) listener(message, sender, sendResponse);
    return call;
  }

  /** A message from a web page (content script), the untrusted path. */
  callFromPage(message: unknown, origin: string, tabId = 1): Call {
    return this.call(message, { tab: { id: tabId }, origin });
  }

  /** Simulate the user closing a browser window. */
  closeWindow(windowId: number): void {
    for (const fn of this.windowRemovedListeners) fn(windowId);
  }

  install(): void {
    const api = {
      runtime: this.runtime,
      storage: this.storage,
      alarms: this.alarms,
      action: this.hasOpenPopup ? this.action : { ...this.action, openPopup: undefined },
      windows: this.windowsApi,
      tabs: this.tabsApi,
    };
    (globalThis as { chrome?: unknown }).chrome = api;
  }
}

export function uninstallChrome(): void {
  delete (globalThis as { chrome?: unknown }).chrome;
}
