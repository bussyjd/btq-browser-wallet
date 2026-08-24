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
    expect(parsePendingPrompts(undefined, { origin: DAPP })).toEqual([{ origin: DAPP, at: 0, seq: 0 }]);
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
    expect(parsePendingPrompts(junk)).toEqual([{ origin: 'https://ok.example', at: 0, seq: 0 }]);
    expect(parsePendingPrompts('not an array')).toEqual([]);
    expect(parsePendingPrompts(null, null)).toEqual([]);
  });

  it('caps the list and never repeats an origin', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ origin: `https://s${i}.example`, at: 1 }));
    expect(parsePendingPrompts([...many, ...many])).toHaveLength(MAX_PENDING_PROMPTS);
    expect(parsePendingPrompts([{ origin: DAPP, at: 5, seq: 1 }, { origin: DAPP, at: 9, seq: 2 }])).toEqual([
      { origin: DAPP, at: 5, seq: 1 },
    ]);
    // A hostile or hand-edited `seq` is a count like any other field here: not
    // a whole non-negative number ⇒ 0, so it can only ever tie, never jump the
    // queue. Ordering is not an authority (`approveConnect` asks the broker),
    // but a NaN in a comparator makes a sort return an arbitrary permutation.
    expect(
      parsePendingPrompts([
        { origin: DAPP, at: 5, seq: -1 },
        { origin: EVIL, at: 5, seq: 'soon' },
        { origin: THIRD, at: 5, seq: 1.5 },
      ]).map((p) => p.seq),
    ).toEqual([0, 0, 0]);
  });
});

describe('freshPrompts', () => {
  it('keeps what is inside the timeout and drops what is not, newest first', () => {
    const now = 1_000_000_000;
    const prompts = [
      { origin: DAPP, at: now - 10, seq: 0 },
      { origin: EVIL, at: now - CONNECT_TIMEOUT_MS - 1, seq: 1 },
      { origin: THIRD, at: now - 5, seq: 2 },
    ];
    expect(freshPrompts(prompts, now)).toEqual([
      { origin: THIRD, at: now - 5, seq: 2 },
      { origin: DAPP, at: now - 10, seq: 0 },
    ]);
  });

  it('breaks a same-millisecond tie on the sequence the broker stamped, not the name', () => {
    // The mirror is read back on a code path the popup uses, so it needs the
    // same rule as `prompts()` — otherwise a restart of the popup reorders two
    // prompts that the worker had ordered correctly.
    const now = 1_000_000_000;
    const at = now - 10;
    expect(freshPrompts([{ origin: DAPP, at, seq: 0 }, { origin: EVIL, at, seq: 1 }], now)).toEqual([
      { origin: EVIL, at, seq: 1 },
      { origin: DAPP, at, seq: 0 },
    ]);
    // …and the same list in the other order sorts the same way. Under the old
    // `localeCompare` tie-break this pair disagreed with itself.
    expect(freshPrompts([{ origin: EVIL, at, seq: 1 }, { origin: DAPP, at, seq: 0 }], now)).toEqual([
      { origin: EVIL, at, seq: 1 },
      { origin: DAPP, at, seq: 0 },
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
      { origin: EVIL, at: 3_000, seq: 1 },
      { origin: DAPP, at: 2_000, seq: 0 },
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

  it('orders two prompts stamped in the same millisecond by arrival, not by name', () => {
    // The whole reason `prompts()` sorts at all is "newest first". `Date.now()`
    // has millisecond resolution and two `page.requestAccounts` calls in one
    // task routinely land on the same integer, so the tie-break *is* the
    // ordering rule in the case that matters. A tie broken by origin name is a
    // coin flip dressed up as a sort: it made the delivered suite fail on
    // roughly half of all runs, and on the other half it was passing for a
    // reason that had nothing to do with recency.
    //
    // Frozen clock, so both prompts genuinely share a timestamp on every run of
    // this test on every machine. Both directions are asserted because only the
    // pair rules out alphabetical order: 'dapp' sorts before 'evil', so the
    // second case would pass under either rule and the first would not.
    const frozen = { now: () => 1_000, setTimer: () => null, clearTimer: () => undefined };

    const dappFirst = new ConnectBroker(frozen);
    dappFirst.hold(DAPP, () => undefined);
    dappFirst.hold(EVIL, () => undefined);
    expect(dappFirst.prompts().map((p) => p.origin)).toEqual([EVIL, DAPP]);

    const evilFirst = new ConnectBroker(frozen);
    evilFirst.hold(EVIL, () => undefined);
    evilFirst.hold(DAPP, () => undefined);
    expect(evilFirst.prompts().map((p) => p.origin)).toEqual([DAPP, EVIL]);

    // Three, so the order is a real sequence and not a swapped pair.
    const three = new ConnectBroker(frozen);
    three.hold(DAPP, () => undefined);
    three.hold(THIRD, () => undefined);
    three.hold(EVIL, () => undefined);
    expect(three.prompts().map((p) => p.origin)).toEqual([EVIL, THIRD, DAPP]);
  });

  it('numbers prompts from a counter that only ever goes up within one worker', () => {
    // The sequence is what the tie-break reads, so it has to be monotonic even
    // when origins come and go: a settled prompt must not hand its number back
    // to the next site to ask.
    const broker = new ConnectBroker({ now: () => 1_000, setTimer: () => null, clearTimer: () => undefined });
    broker.hold(DAPP, () => undefined);
    broker.hold(EVIL, () => undefined);
    broker.deny(EVIL);
    broker.hold(THIRD, () => undefined);
    expect(broker.prompts().map((p) => p.origin)).toEqual([THIRD, DAPP]);
    expect(broker.prompts().map((p) => p.seq)).toEqual([2, 0]);

    // Re-asking is a new request and takes a new number, so a site cannot keep
    // an old position by settling and asking again.
    broker.deny(DAPP);
    broker.hold(DAPP, () => undefined);
    expect(broker.prompts().map((p) => p.origin)).toEqual([DAPP, THIRD]);
  });

  it('a second request from one origin joins the first and keeps its place', () => {
    // `hold` returns 'joined' without minting a number: the origin is already
    // waiting, and bumping it would let a page reorder the list by re-asking.
    const broker = new ConnectBroker({ now: () => 1_000, setTimer: () => null, clearTimer: () => undefined });
    broker.hold(DAPP, () => undefined);
    broker.hold(EVIL, () => undefined);
    expect(broker.hold(DAPP, () => undefined)).toBe('joined');
    expect(broker.prompts().map((p) => p.origin)).toEqual([EVIL, DAPP]);
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
