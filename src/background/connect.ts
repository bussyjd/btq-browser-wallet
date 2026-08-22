/**
 * Site-connect lifecycle for `page.requestAccounts` (the MetaMask-style approval).
 *
 * The keyring only records *that* an origin asked (`{ pending: true }`); it never
 * blocks. This broker is the part that makes the page's promise behave: it parks
 * the page's `sendResponse` until the user decides in the popup, then answers
 * every parked caller with the same outcome.
 *
 * Rules encoded here:
 *  - one pending request per canonical origin — a second `requestAccounts` from
 *    the same origin joins the first and shares its outcome;
 *  - approve answers `{ result: { accounts: [...] } }`;
 *  - deny, closing the approval window, and the 5-minute timeout all answer
 *    `{ error: 'User rejected the request.', code: 'USER_REJECTED' }`, which the
 *    inpage provider surfaces as EIP-1193 `code === 4001`;
 *  - an origin can only ever settle its own request (the caller passes the
 *    canonical origin; the map is keyed by it).
 *
 * MV3 lifetime caveat: a parked `sendResponse` lives in the service worker, and
 * Chrome may terminate an idle worker (30 s of no events, 5 min hard cap). If
 * that happens while a request is parked, the message channel closes and the
 * content relay reports it to the page as a disconnect — the page can simply ask
 * again. The `setTimeout` below dies with the worker too, so it is a bound on a
 * *live* worker, not a durable timer; the durable half of the state is the
 * keyring's stored `pendingConnect`, which the popup reads on open and which
 * `onRejected` clears through `wallet.denyConnect`. Re-arming on wake is
 * therefore unnecessary: a worker that woke up has no responders to answer.
 */

export interface ConnectReply {
  result?: unknown;
  error?: string;
  code?: string;
}

/** The `sendResponse` handed to us by `chrome.runtime.onMessage`. */
export type ConnectResponder = (reply: ConnectReply) => void;

export type RejectReason = 'denied' | 'timeout' | 'window-closed';

export type TimerHandle = unknown;

/** Sent to the page when the user says no, closes the window, or never answers. */
export const USER_REJECTED_REPLY: Readonly<ConnectReply> = Object.freeze({
  error: 'User rejected the request.',
  code: 'USER_REJECTED',
});

export const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;

export interface ConnectBrokerOptions {
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** Called after a request is rejected, so the caller can clear stored state. */
  onRejected?: (origin: string, reason: RejectReason) => void;
  /** Called whenever the number of waiting requests changes (badge). */
  onCountChanged?: (count: number) => void;
  /** Close an approval window this broker was told about. */
  closeWindow?: (windowId: number) => void;
}

interface PendingRequest {
  readonly origin: string;
  readonly responders: ConnectResponder[];
  timer: TimerHandle;
  windowId: number | null;
}

export class ConnectBroker {
  private readonly waiting = new Map<string, PendingRequest>();
  private readonly timeoutMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly opts: ConnectBrokerOptions;

  constructor(opts: ConnectBrokerOptions = {}) {
    this.opts = opts;
    this.timeoutMs = opts.timeoutMs ?? CONNECT_TIMEOUT_MS;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /**
   * Park a responder for `origin`. Returns true when this is the first request
   * for that origin — only then should the caller open the approval UI.
   */
  hold(origin: string, responder: ConnectResponder): boolean {
    const existing = this.waiting.get(origin);
    if (existing) {
      existing.responders.push(responder);
      return false;
    }
    const entry: PendingRequest = { origin, responders: [responder], timer: null, windowId: null };
    this.waiting.set(origin, entry);
    entry.timer = this.setTimer(() => this.expire(origin), this.timeoutMs);
    this.countChanged();
    return true;
  }

  /** Remember the approval window we opened, so closing it counts as a deny. */
  attachWindow(origin: string, windowId: number): boolean {
    const entry = this.waiting.get(origin);
    if (!entry) return false;
    entry.windowId = windowId;
    return true;
  }

  has(origin: string): boolean {
    return this.waiting.has(origin);
  }

  get size(): number {
    return this.waiting.size;
  }

  origins(): string[] {
    return [...this.waiting.keys()];
  }

  /** Answer the parked callers for `origin` with the approved accounts. */
  approve(origin: string, result: unknown): number {
    return this.settle(origin, { result }, null);
  }

  /** Reject one origin's request (the popup's Cancel). */
  deny(origin: string): number {
    return this.settle(origin, USER_REJECTED_REPLY, 'denied');
  }

  /** Reject everything still waiting — used when the pending origin is unknown. */
  denyAll(): string[] {
    const settled = this.origins();
    for (const origin of settled) this.deny(origin);
    return settled;
  }

  /** A window disappeared: if it was an approval window, that is a deny. */
  windowClosed(windowId: number): string | null {
    for (const entry of this.waiting.values()) {
      if (entry.windowId !== windowId) continue;
      entry.windowId = null; // do not try to close what the user already closed
      this.settle(entry.origin, USER_REJECTED_REPLY, 'window-closed');
      return entry.origin;
    }
    return null;
  }

  private expire(origin: string): void {
    this.settle(origin, USER_REJECTED_REPLY, 'timeout');
  }

  private settle(origin: string, reply: ConnectReply, reason: RejectReason | null): number {
    const entry = this.waiting.get(origin);
    if (!entry) return 0;
    this.waiting.delete(origin);
    if (entry.timer !== null) this.clearTimer(entry.timer);
    if (entry.windowId !== null && this.opts.closeWindow) {
      const windowId = entry.windowId;
      entry.windowId = null;
      try {
        this.opts.closeWindow(windowId);
      } catch {
        /* the window is already gone */
      }
    }
    for (const respond of entry.responders) {
      try {
        respond(reply);
      } catch {
        /* the page's message channel is already closed */
      }
    }
    this.countChanged();
    if (reason && this.opts.onRejected) this.opts.onRejected(origin, reason);
    return entry.responders.length;
  }

  private countChanged(): void {
    if (this.opts.onCountChanged) this.opts.onCountChanged(this.waiting.size);
  }
}
