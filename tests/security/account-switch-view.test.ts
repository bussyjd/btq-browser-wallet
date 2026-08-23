/**
 * The popup must never show one account's address while the wallet is another.
 *
 * The Receive tab renders `receive` — an address, a QR code and a live Copy
 * button. `switchAccount` used to clear it only *after* `wallet.switchAccount`
 * came back, so for the length of one `chrome.runtime.sendMessage` round trip
 * the screen went on offering the address of the account the user had just
 * left. Anyone who copied in that window handed it out, and was paid into an
 * account they were no longer looking at. `createAccount` had the same shape.
 *
 * `useWallet` is a plain function over `useState` / `useRef` / `useCallback`,
 * so this drives the real hook with a three-function shim in place of React and
 * a parked `rpc`, and reads the state cells between the ask and the answer.
 * Nothing about the hook is stubbed: the code under test is the one that ships.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Hoisted: the mock factories below run before any of this file's statements. */
const react = vi.hoisted(() => {
  const cells: { v: unknown }[] = [];
  return {
    cells,
    cursor: 0,
    /** Start a render: hooks are read in call order, from the same cells. */
    reset() {
      this.cursor = 0;
    },
  };
});

const wire = vi.hoisted(() => ({
  /** method → what `rpc` answers with, or a promise it parks on. */
  answer: (_method: string, _params?: unknown): Promise<unknown> => Promise.resolve(null),
  log: [] as string[],
}));

vi.mock('react', () => ({
  useState: (init: unknown) => {
    const i = react.cursor++;
    react.cells[i] ??= { v: typeof init === 'function' ? (init as () => unknown)() : init };
    const cell = react.cells[i]!;
    return [
      cell.v,
      (next: unknown) => {
        cell.v = typeof next === 'function' ? (next as (p: unknown) => unknown)(cell.v) : next;
      },
    ];
  },
  useRef: (init: unknown) => {
    const i = react.cursor++;
    react.cells[i] ??= { v: { current: init } };
    return react.cells[i]!.v;
  },
  // The hook only uses this for identity stability, which nothing here reads.
  useCallback: (fn: unknown) => fn,
}));

vi.mock('../../src/ui/rpc.js', () => ({
  rpc: (method: string, params?: unknown) => {
    wire.log.push(method);
    return wire.answer(method, params);
  },
  errorCode: (e: unknown) => (e as { code?: string } | null)?.code,
  errMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { useWallet } from '../../src/ui/hooks/useWallet.js';

const ADDRESS_0 = 'tbtq1zaccount0';
const ADDRESS_1 = 'tbtq1zaccount1';

/** Re-run the hook against the same cells — a render, in every sense that matters here. */
function render() {
  react.reset();
  return useWallet();
}

/** The canned worker: account 0 to begin with, whatever `active` says after that. */
function worker(active: { index: number; address: string }) {
  return async (method: string): Promise<unknown> => {
    switch (method) {
      case 'wallet.receive':
        return { address: active.address, index: 0, account: active.index };
      case 'wallet.status':
        return {
          state: 'unlocked',
          activeAccount: active.index,
          accounts: [
            { index: 0, name: 'Account 1', address: ADDRESS_0 },
            { index: 1, name: 'Account 2', address: ADDRESS_1 },
          ],
        };
      case 'wallet.history':
        return [{ txid: 'aa'.repeat(32), valueChange: '1', status: 'confirmed' }];
      case 'wallet.connectedSites':
        return { origins: [], sites: [] };
      case 'wallet.scan':
        return { totalBalanceSats: '0' };
      case 'wallet.tip':
        return { height: 1, hash: 'aa' };
      default:
        return null;
    }
  };
}

/** A promise the test releases by hand, standing in for a slow round trip. */
function gate() {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  return { held, release: () => release() };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  react.cells.length = 0;
  react.reset();
  wire.log = [];
});

describe('changing account blanks the screen before the worker is asked', () => {
  it('switchAccount clears the address on screen for the whole round trip', async () => {
    const active = { index: 0, address: ADDRESS_0 };
    wire.answer = worker(active);

    // Account 0 on screen, with an address, a history and a settled scan.
    await render().refresh();
    expect(render().receive).toMatchObject({ address: ADDRESS_0 });
    expect(render().history).toHaveLength(1);
    expect(render().scanned).toBe(true);

    // The user clicks Account 2. The worker takes its time answering.
    const slow = gate();
    wire.answer = async (method: string) => {
      if (method === 'wallet.switchAccount') {
        await slow.held;
        active.index = 1;
        active.address = ADDRESS_1;
        return null;
      }
      return worker(active)(method);
    };
    const switching = render().switchAccount(1);
    await tick();

    // Mid-flight: the wallet is neither account, and the screen says so. This
    // is the assertion — with the clear on the far side of the await, the QR
    // code and the Copy button were still offering ADDRESS_0 right here.
    expect(wire.log).toContain('wallet.switchAccount');
    expect(render().receive, 'the address of the account being left').toBeNull();
    expect(render().history).toEqual([]);
    expect(render().scanned).toBe(false);

    slow.release();
    await switching;

    // And afterwards it is the new account's address, not a blank left behind.
    expect(render().receive).toMatchObject({ address: ADDRESS_1 });
    expect(render().status).toMatchObject({ activeAccount: 1 });
    expect(render().scanned).toBe(true);
  });

  it('createAccount clears it too, and returns the account it made', async () => {
    // Same shape, same window: "Add account" switches to the new account, so
    // the address on screen stops being true at the click, not at the answer.
    const active = { index: 0, address: ADDRESS_0 };
    wire.answer = worker(active);
    await render().refresh();
    expect(render().receive).toMatchObject({ address: ADDRESS_0 });

    const slow = gate();
    wire.answer = async (method: string) => {
      if (method === 'wallet.createAccount') {
        await slow.held;
        active.index = 1;
        active.address = ADDRESS_1;
        return { index: 1, name: 'Account 2', address: ADDRESS_1 };
      }
      return worker(active)(method);
    };
    const creating = render().createAccount();
    await tick();

    expect(wire.log).toContain('wallet.createAccount');
    expect(render().receive).toBeNull();
    expect(render().history).toEqual([]);
    expect(render().scanned).toBe(false);

    slow.release();
    expect(await creating).toMatchObject({ index: 1, address: ADDRESS_1 });
    expect(render().receive).toMatchObject({ address: ADDRESS_1 });
  });

  it('the shim is a real render, not a snapshot that always reads blank', async () => {
    // Guard on the two assertions above: if `render()` did not re-read state,
    // "receive is null" would be true for reasons that have nothing to do with
    // the fix. It has to be able to see a value appear as well as disappear.
    const active = { index: 0, address: ADDRESS_0 };
    wire.answer = worker(active);
    expect(render().receive).toBeNull();
    await render().refresh();
    expect(render().receive).toMatchObject({ address: ADDRESS_0 });
  });
});
