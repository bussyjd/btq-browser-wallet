/**
 * Site-connect lifecycle for `page.requestAccounts` (the MetaMask-style approval).
 *
 * The keyring only reports *that* an origin asked (`{ pending: true }`); it never
 * blocks and it keeps no record. This broker is the part that makes the page's
 * promise behave: it parks the page's `sendResponse` until the user decides in
 * the popup, then answers every parked caller with the same outcome.
 *
 * Rules encoded here:
 *  - one pending request per canonical origin — a second `requestAccounts` from
 *    the same origin joins the first and shares its outcome;
 *  - at most `MAX_PENDING_PROMPTS` origins wait at once. The next one is
 *    answered `USER_REJECTED` instead of being given a window of its own, so a
 *    page that controls many subdomains cannot bury the screen in popups;
 *  - approve answers `{ result: { accounts: [...] } }`;
 *  - deny, closing the approval window, and the 5-minute timeout all answer
 *    `{ error: 'User rejected the request.', code: 'USER_REJECTED' }`, which the
 *    inpage provider surfaces as EIP-1193 `code === 4001`;
 *  - an origin can only ever settle its own request (the caller passes the
 *    canonical origin; the map is keyed by it).
 *
 * **This broker is the only authority on what is pending.** `wallet.approveConnect`
 * is refused for any origin it is not holding, so the popup cannot grant a site
 * that is not, right now, waiting for an answer. Storage carries a timestamped
 * mirror of `prompts()` so the popup can render them; nothing is ever granted
 * out of that mirror, and `parsePendingPrompts` / `freshPrompts` throw away
 * anything stale or malformed when it is read back. Both orderings — the
 * broker's and the mirror's — are decided by an arrival counter rather than by
 * the clock alone, because `Date.now()` cannot separate two prompts that land
 * in the same millisecond and a name-based tie-break is not recency at all.
 *
 * MV3 lifetime caveat: a parked `sendResponse` lives in the service worker, and
 * Chrome may terminate an idle worker (30 s of no events, 5 min hard cap). If
 * that happens while a request is parked, the message channel closes and the
 * content relay reports it to the page as a disconnect — the page can simply ask
 * again. The `setTimeout` below dies with the worker too, so it is a bound on a
 * *live* worker, not a durable timer. That is precisely why a worker that woke
 * up refuses every prompt it finds on disk: no responder survived, so approving
 * one would grant a permanent allowlist entry that no page ever asked for.
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

/** What `hold` did with a request: opened a window, joined one, or refused. */
export type HoldOutcome = 'opened' | 'joined' | 'refused';

/** A parked request as the popup sees it: which origin, and when it asked. */
export interface PendingPrompt {
  readonly origin: string;
  /** ms epoch when the request was parked, so a stale one can be recognised. */
  readonly at: number;
  /**
   * Arrival order within one worker generation, from a counter that only goes
   * up. `at` alone cannot order these: `Date.now()` is a millisecond integer
   * and two `page.requestAccounts` calls in the same task share it routinely,
   * so "newest first" needs a key that a tie cannot erase.
   *
   * Deliberately **not** a global identity. The counter is worker memory: it
   * starts again at 0 every time MV3 respawns the worker, so a number from a
   * dead generation is not comparable with a number from this one. Nothing has
   * to compare them, and three separate things keep it that way:
   *
   *  - the stored mirror is rewritten *whole* from `broker.prompts()` every
   *    time the waiting set changes, so one array never mixes two generations;
   *  - a new worker holds nothing, and `livePrompts()` drops every stored
   *    prompt the broker is not holding — a prompt from a dead generation is
   *    never in a list that gets sorted, it is discarded before that;
   *  - `at` is real epoch time and stays the primary key, so even if a
   *    cross-generation comparison somehow happened it would order by wall
   *    clock, and `seq` would only decide a tie inside one millisecond — which
   *    two generations cannot land in, a restart being orders of magnitude
   *    slower than that.
   *
   * And the consequence if all of that were wrong is display order in the
   * toolbar popup. It is not an authority: `approveConnect` grants only what
   * the broker is holding right now, and an approval window answers only for
   * the origin in its own URL.
   */
  readonly seq: number;
}

/** Sent to the page when the user says no, closes the window, or never answers. */
export const USER_REJECTED_REPLY: Readonly<ConnectReply> = Object.freeze({
  error: 'User rejected the request.',
  code: 'USER_REJECTED',
});

export const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How many approval windows may be open at once. Three is enough for an honest
 * pile-up (a page reloading, two tabs, a redirect) and small enough that the
 * user can close them; the fourth site is rejected rather than queued, because a
 * queue is a place for a hostile page to park work the user has to dismiss.
 */
export const MAX_PENDING_PROMPTS = 3;

export interface ConnectBrokerOptions {
  timeoutMs?: number;
  /** How many origins may wait at once (default `MAX_PENDING_PROMPTS`). */
  maxPending?: number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** Clock, injectable so tests can age a prompt without waiting. */
  now?: () => number;
  /** Called after a request is rejected, so the caller can clear stored state. */
  onRejected?: (origin: string, reason: RejectReason) => void;
  /** Called whenever the set of waiting requests changes (badge + mirror). */
  onCountChanged?: (count: number) => void;
  /** Close an approval window this broker was told about. */
  closeWindow?: (windowId: number) => void;
}

interface PendingRequest {
  readonly origin: string;
  readonly at: number;
  readonly seq: number;
  readonly responders: ConnectResponder[];
  timer: TimerHandle;
  windowId: number | null;
}

export class ConnectBroker {
  private readonly waiting = new Map<string, PendingRequest>();
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly now: () => number;
  private readonly opts: ConnectBrokerOptions;
  /** Next arrival number. Worker-lifetime state; see `PendingPrompt.seq`. */
  private nextSeq = 0;

  constructor(opts: ConnectBrokerOptions = {}) {
    this.opts = opts;
    this.timeoutMs = opts.timeoutMs ?? CONNECT_TIMEOUT_MS;
    this.maxPending = opts.maxPending ?? MAX_PENDING_PROMPTS;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Park a responder for `origin`.
   *
   * `'opened'` — first request for that origin: open an approval window for it.
   * `'joined'` — that origin is already waiting; it shares the first outcome.
   * `'refused'` — too many origins are already waiting. Nothing was parked, so
   * the caller must answer this request itself (with `USER_REJECTED_REPLY`).
   */
  hold(origin: string, responder: ConnectResponder): HoldOutcome {
    const existing = this.waiting.get(origin);
    if (existing) {
      existing.responders.push(responder);
      return 'joined';
    }
    if (this.waiting.size >= this.maxPending) return 'refused';
    const entry: PendingRequest = {
      origin,
      at: this.now(),
      // Minted only for a request that is actually parked. A 'joined' second
      // ask keeps the first one's number, so a page cannot walk itself to the
      // top of the list by calling `requestAccounts` again, and a 'refused'
      // one takes no number at all.
      seq: this.nextSeq++,
      responders: [responder],
      timer: null,
      windowId: null,
    };
    this.waiting.set(origin, entry);
    entry.timer = this.setTimer(() => this.expire(origin), this.timeoutMs);
    this.countChanged();
    return 'opened';
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

  /**
   * Everything waiting, newest first — the popup shows the most recent ask.
   *
   * Ties on `at` break on arrival order, never on the origin string. Sorting
   * two same-millisecond prompts by name would not be a weaker rule than
   * recency, it would be a *different* one, silently: 'dapp.example' would beat
   * 'evil.example' no matter which of them asked second.
   */
  prompts(): PendingPrompt[] {
    return [...this.waiting.values()]
      .map((entry) => ({ origin: entry.origin, at: entry.at, seq: entry.seq }))
      .sort((a, b) => b.at - a.at || b.seq - a.seq);
  }

  /** Answer the parked callers for `origin` with the approved accounts. */
  approve(origin: string, result: unknown): number {
    return this.settle(origin, { result }, null);
  }

  /** Reject one origin's request (the popup's Cancel). */
  deny(origin: string): number {
    return this.settle(origin, USER_REJECTED_REPLY, 'denied');
  }

  /** Reject everything still waiting — used when the vault itself goes away. */
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

// ---------------------------------------------------------------- the mirror

/**
 * Read the stored prompt mirror, migrating the single-slot `pendingConnect`
 * record older builds wrote.
 *
 * Storage is attacker-adjacent — anything with extension access can write it —
 * so every field is validated and the list is capped. The legacy record has no
 * timestamp, which is exactly the L3 case: it was written by a worker that no
 * longer exists, so it is dated `0` and `freshPrompts` throws it away. Nothing
 * here can widen the allowlist by itself: `approveConnect` still requires the
 * broker to be holding the origin.
 */
export function parsePendingPrompts(raw: unknown, legacy?: unknown): PendingPrompt[] {
  const out: PendingPrompt[] = [];
  const seen = new Set<string>();
  /** A count, so anything that is not a whole non-negative number is 0. */
  const nat = (v: unknown): number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
  const push = (origin: unknown, at: unknown, seq: unknown): void => {
    if (typeof origin !== 'string' || !/^https?:\/\/[^/\s]+$/.test(origin)) return;
    if (seen.has(origin)) return;
    seen.add(origin);
    out.push({
      origin,
      at: typeof at === 'number' && Number.isFinite(at) && at >= 0 ? at : 0,
      // A record with no `seq` — the shape older builds wrote — reads as 0.
      // Every such record ties, and a stable sort then leaves them in the
      // order they were stored, which is the order the broker wrote them in.
      seq: nat(seq),
    });
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as { origin?: unknown; at?: unknown; seq?: unknown };
      push(record.origin, record.at, record.seq);
      if (out.length >= MAX_PENDING_PROMPTS) break;
    }
  }
  if (typeof legacy === 'object' && legacy !== null) {
    push((legacy as { origin?: unknown }).origin, 0, 0);
  }
  return out.slice(0, MAX_PENDING_PROMPTS);
}

/**
 * Prompts still inside the timeout window, newest first.
 *
 * Same ordering rule as `ConnectBroker.prompts()`, and for the same reason: the
 * popup reads this list, so if the two disagreed a prompt would change position
 * simply by being written to storage and read back. Ties fall through to the
 * order the records were stored in — `Array.prototype.sort` is stable — which
 * is the order the broker wrote them in.
 */
export function freshPrompts(prompts: readonly PendingPrompt[], now: number, maxAgeMs = CONNECT_TIMEOUT_MS): PendingPrompt[] {
  return prompts
    .filter((p) => p.at > 0 && now - p.at < maxAgeMs)
    .sort((a, b) => b.at - a.at || b.seq - a.seq);
}
