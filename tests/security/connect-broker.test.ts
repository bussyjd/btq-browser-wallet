/**
 * The connect broker and its storage mirror, on their own.
 *
 * `chrome.storage.local` is writable by anything with extension access, so the
 * mirror of pending prompts is treated as hostile input: a junk record must not
 * become a prompt, and a record with no timestamp — the shape older builds
 * wrote — must not survive a read, because the worker that parked it is gone
 * and nothing is waiting on it any more.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ConnectBroker,
  CONNECT_TIMEOUT_MS,
  MAX_PENDING_PROMPTS,
  freshPrompts,
  parsePendingPrompts,
  type ConnectReply,
} from '../../src/background/connect.js';

const DAPP = 'https://dapp.example';
const EVIL = 'https://evil.example';
const THIRD = 'https://third.example';

function sink(): { replies: ConnectReply[]; respond: (reply: ConnectReply) => void } {
  const replies: ConnectReply[] = [];
  return { replies, respond: (reply) => replies.push(reply) };
}

describe('parsePendingPrompts', () => {
  it('migrates the legacy single-slot record with no timestamp', () => {
    expect(parsePendingPrompts(undefined, { origin: DAPP })).toEqual([{ origin: DAPP, at: 0 }]);
    // …and `at: 0` is older than any timeout, so it never survives a read.
    expect(freshPrompts(parsePendingPrompts(undefined, { origin: DAPP }), Date.now())).toEqual([]);
  });

  it('drops anything that is not a plain http(s) origin', () => {
    const junk = [
      { origin: 'https://dapp.example/path', at: 1 },
      { origin: 'javascript:alert(1)', at: 1 },
      { origin: 'chrome-extension://abc', at: 1 },
      { origin: 42, at: 1 },
      { origin: 'https://ok.example', at: 'soon' },
      null,
      'https://string.example',
    ];
    expect(parsePendingPrompts(junk)).toEqual([{ origin: 'https://ok.example', at: 0 }]);
    expect(parsePendingPrompts('not an array')).toEqual([]);
    expect(parsePendingPrompts(null, null)).toEqual([]);
  });

  it('caps the list and never repeats an origin', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ origin: `https://s${i}.example`, at: 1 }));
    expect(parsePendingPrompts([...many, ...many])).toHaveLength(MAX_PENDING_PROMPTS);
    expect(parsePendingPrompts([{ origin: DAPP, at: 5 }, { origin: DAPP, at: 9 }])).toEqual([
      { origin: DAPP, at: 5 },
    ]);
  });
});

describe('freshPrompts', () => {
  it('keeps what is inside the timeout and drops what is not, newest first', () => {
    const now = 1_000_000_000;
    const prompts = [
      { origin: DAPP, at: now - 10 },
      { origin: EVIL, at: now - CONNECT_TIMEOUT_MS - 1 },
      { origin: THIRD, at: now - 5 },
    ];
    expect(freshPrompts(prompts, now)).toEqual([
      { origin: THIRD, at: now - 5 },
      { origin: DAPP, at: now - 10 },
    ]);
  });
});

describe('ConnectBroker', () => {
  it('caps concurrent prompts and refuses the overflow without parking it', () => {
    const broker = new ConnectBroker({ maxPending: 2, setTimer: () => null, clearTimer: () => undefined });
    const a = sink();
    const b = sink();
    const c = sink();

    expect(broker.hold(DAPP, a.respond)).toBe('opened');
    expect(broker.hold(DAPP, b.respond)).toBe('joined');
    expect(broker.hold(EVIL, b.respond)).toBe('opened');
    expect(broker.hold(THIRD, c.respond)).toBe('refused');

    expect(broker.size, 'a refused request must not be parked').toBe(2);
    expect(broker.has(THIRD)).toBe(false);
    // Nothing was answered by the refusal itself — the caller does that, so the
    // page gets exactly one reply.
    expect(c.replies).toEqual([]);
  });

  it('timestamps each prompt and reports them newest first', () => {
    let clock = 1_000;
    const broker = new ConnectBroker({
      now: () => (clock += 1_000),
      setTimer: () => null,
      clearTimer: () => undefined,
    });
    broker.hold(DAPP, () => undefined);
    broker.hold(EVIL, () => undefined);

    expect(broker.prompts()).toEqual([
      { origin: EVIL, at: 3_000 },
      { origin: DAPP, at: 2_000 },
    ]);
  });

  it('settles one origin and leaves every other request parked', () => {
    const dapp = sink();
    const evil = sink();
    const closed: number[] = [];
    const broker = new ConnectBroker({
      setTimer: () => null,
      clearTimer: () => undefined,
      closeWindow: (id) => closed.push(id),
    });
    broker.hold(DAPP, dapp.respond);
    broker.attachWindow(DAPP, 11);
    broker.hold(EVIL, evil.respond);
    broker.attachWindow(EVIL, 12);

    broker.deny(DAPP);
    expect(dapp.replies).toEqual([{ error: 'User rejected the request.', code: 'USER_REJECTED' }]);
    expect(evil.replies, "the other site's request stays parked").toEqual([]);
    expect(closed, "only the denied site's window is closed").toEqual([11]);
    expect(broker.origins()).toEqual([EVIL]);
  });

  it('runs its own timer on real time, so a live worker expires a prompt', () => {
    vi.useFakeTimers();
    try {
      const broker = new ConnectBroker({ timeoutMs: 1_000 });
      const page = sink();
      broker.hold(DAPP, page.respond);
      vi.advanceTimersByTime(999);
      expect(page.replies).toEqual([]);
      vi.advanceTimersByTime(2);
      expect(page.replies).toEqual([{ error: 'User rejected the request.', code: 'USER_REJECTED' }]);
      expect(broker.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
