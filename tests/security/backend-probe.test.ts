/**
 * probeBackend is the "Test connection" button. It is the last chance to catch
 * a wrong explorer URL or a node on the dead fork before the user trusts a
 * balance or pushes a payment.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { probeBackend } from '../../src/background/backend-store.js';
import { isInsecureRemote } from '../../src/core/network/backend.js';
import { WalletError } from '../../src/core/wallet/errors.js';
import { FakeChrome, uninstallChrome } from '../helpers/fake-chrome.js';
import blocksTip from '../fixtures/explorer/blocks-tip.json' with { type: 'json' };

const EXPLORER = 'https://explorer.example';
const NODE_URL = 'http://127.0.0.1:18332';
const TIP = blocksTip.body;

let realFetch: typeof fetch;

beforeEach(() => {
  new FakeChrome().install();
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  uninstallChrome();
});

interface Stub {
  tip?: { status: number; body: unknown };
  rpc?: Record<string, unknown>;
}

function stubNetwork(s: Stub): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/v1/blocks/tip')) {
      const answer = s.tip ?? { status: 200, body: TIP };
      return {
        status: answer.status,
        ok: answer.status >= 200 && answer.status < 300,
        json: async () => {
          if (answer.body === undefined) throw new Error('not json');
          return answer.body;
        },
      } as Response;
    }
    const body = JSON.parse(String(init?.body)) as { method: string };
    const result = (s.rpc ?? {})[body.method];
    if (result === undefined) throw new Error(`unexpected RPC ${body.method}`);
    return { status: 200, ok: true, json: async () => ({ result, error: null }) } as Response;
  }) as unknown as typeof fetch;
}

describe('backend probe', () => {
  it('reports the explorer tip height for a healthy explorer', async () => {
    stubNetwork({});
    const out = await probeBackend({ explorerBase: EXPLORER });
    expect(out).toMatchObject({ explorer: EXPLORER, explorerTip: TIP.height });
    expect(out.warning).toBeUndefined();
  });

  it('fails on a route-miss 404 instead of accepting a wrong explorer URL', async () => {
    // User loss: accepting a 404 leaves the wallet pointed at a host with no
    // BTQ API, so every address reads as unused and the balance shows 0.
    stubNetwork({
      tip: {
        status: 404,
        body: { message: 'Route GET:/api/v1/blocks/tip not found', error: 'Not Found', statusCode: 404 },
      },
    });
    await expect(probeBackend({ explorerBase: EXPLORER })).rejects.toThrow(/No BTQ explorer API/);
  });

  it('fails on a 404 with no JSON body at all', async () => {
    stubNetwork({ tip: { status: 404, body: undefined } });
    await expect(probeBackend({ explorerBase: EXPLORER })).rejects.toThrow(/No BTQ explorer API/);
  });

  it('accepts a node that agrees with the explorer at the tip height', async () => {
    stubNetwork({
      rpc: {
        getblockchaininfo: { chain: 'test', blocks: TIP.height, bestblockhash: TIP.hash },
        getblockhash: TIP.hash,
      },
    });
    const out = await probeBackend({ explorerBase: EXPLORER, nodeUrl: NODE_URL, nodeUser: 'm0', nodePassword: 'p' });
    expect(out.node).toMatchObject({ chain: 'test', blocks: TIP.height });
    expect(out.warning).toBeUndefined();
  });

  it('refuses a node whose hash at the explorer tip differs (the v0.5.0 fork)', async () => {
    // User loss: the public testnet forked around height 300000. A node on the
    // dead fork accepts a broadcast that the explorer's chain never sees, so
    // the payment sits "pending" forever and the payee is never paid.
    stubNetwork({
      rpc: {
        getblockchaininfo: { chain: 'test', blocks: TIP.height + 5 },
        getblockhash: 'ff'.repeat(32),
      },
    });
    const attempt = probeBackend({ explorerBase: EXPLORER, nodeUrl: NODE_URL });
    await expect(attempt).rejects.toThrow(/different chain/);
    try {
      await attempt;
    } catch (e) {
      expect((e as WalletError).code).toBe('BAD_BACKEND');
      expect((e as WalletError).message).toContain(String(TIP.height));
    }
  });

  it('warns rather than fails when the node is merely behind', async () => {
    stubNetwork({ rpc: { getblockchaininfo: { chain: 'test', blocks: TIP.height - 50 } } });
    const out = await probeBackend({ explorerBase: EXPLORER, nodeUrl: NODE_URL });
    expect(out.warning).toMatch(/50 blocks behind/);
  });

  it('a node that cannot answer for the tip height is behind, not forked', async () => {
    stubNetwork({
      rpc: {
        getblockchaininfo: { chain: 'test', blocks: TIP.height },
        getblockhash: undefined,
      },
    });
    // getblockhash returning an out-of-range error is treated as "behind".
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/v1/blocks/tip')) {
        return { status: 200, ok: true, json: async () => TIP } as Response;
      }
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === 'getblockchaininfo') {
        return {
          status: 200,
          ok: true,
          json: async () => ({ result: { chain: 'test', blocks: TIP.height }, error: null }),
        } as Response;
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({ result: null, error: { code: -8, message: 'Block height out of range' } }),
      } as Response;
    }) as unknown as typeof fetch;
    const out = await probeBackend({ explorerBase: EXPLORER, nodeUrl: NODE_URL });
    expect(out.node?.blocks).toBe(TIP.height);
  });

  it('warns that a remote http node sends its RPC password in the clear', async () => {
    // Attacker gain: anyone on the path reads the Basic-auth header and can
    // then drive the node's wallet RPC directly.
    stubNetwork({ rpc: { getblockchaininfo: { chain: 'test', blocks: TIP.height }, getblockhash: TIP.hash } });
    const out = await probeBackend({
      explorerBase: EXPLORER,
      nodeUrl: 'http://node.example:18332',
      nodeUser: 'm0',
      nodePassword: 'node-secret-9x',
    });
    expect(out.warning).toMatch(/unencrypted/);
    expect(JSON.stringify(out)).not.toContain('node-secret-9x');
  });

  it('isInsecureRemote is false for loopback and https', () => {
    expect(isInsecureRemote('http://127.0.0.1:18332')).toBe(false);
    expect(isInsecureRemote('http://localhost:18332')).toBe(false);
    expect(isInsecureRemote('https://explorer.bitcoinquantum.com')).toBe(false);
    expect(isInsecureRemote('http://192.168.1.10:18332')).toBe(true);
  });
});
