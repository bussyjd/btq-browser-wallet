import { describe, it, expect } from 'vitest';
import { nodeBlockHashAt, nodeBroadcast, testNode } from '../../src/background/node-rpc.js';
import { basicAuthHeader } from '../../src/core/network/jsonrpc.js';
import { BroadcastError, WalletError } from '../../src/core/wallet/errors.js';
import { fakeFetch } from '../helpers/fake-fetch.js';

const NODE = { url: 'http://127.0.0.1:18332', user: 'm0', password: 'm0pass' };
const HEX = 'deadbeef';
const TXID = 'ab'.repeat(32);

function rpc(answers: Record<string, unknown | ((params: unknown[]) => unknown)>) {
  const seen: string[] = [];
  const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    seen.push(body.method);
    const answer = answers[body.method];
    if (answer === undefined) throw new Error(`unexpected RPC ${body.method}`);
    const result = typeof answer === 'function' ? (answer as (p: unknown[]) => unknown)(body.params) : answer;
    return {
      status: 200,
      ok: true,
      json: async () => ({ result, error: null, id: 'btq' }),
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, seen };
}

describe('node broadcast — the only route that can actually push a BTQ transaction', () => {
  it('surfaces testmempoolaccept reject-reason and never calls sendrawtransaction', async () => {
    // User loss: swallowing "min relay fee not met" leaves the user believing a
    // payment went out. Calling sendrawtransaction anyway would also hand the
    // node a transaction it already told us it will not relay.
    const { fetchFn, seen } = rpc({
      testmempoolaccept: [{ allowed: false, 'reject-reason': 'min relay fee not met' }],
      sendrawtransaction: TXID,
    });
    const push = nodeBroadcast(async () => NODE, fetchFn);
    await expect(push(HEX)).rejects.toThrow('min relay fee not met');
    expect(seen).toEqual(['testmempoolaccept']);
    try {
      await push(HEX);
    } catch (e) {
      expect(e).toBeInstanceOf(BroadcastError);
      expect((e as BroadcastError).via).toBe('node');
      expect((e as BroadcastError).noRoute).toBe(false);
    }
  });

  it('a policy rejection at sendrawtransaction is reported, not swallowed', async () => {
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === 'testmempoolaccept') {
        return { status: 200, ok: true, json: async () => ({ result: [{ allowed: true }], error: null }) } as Response;
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({ result: null, error: { code: -26, message: 'bad-txns-inputs-missingorspent' } }),
      } as Response;
    }) as unknown as typeof fetch;
    await expect(nodeBroadcast(async () => NODE, fetchFn)(HEX)).rejects.toThrow('bad-txns-inputs-missingorspent');
  });

  it('accepts and returns the node txid tagged with the route', async () => {
    const { fetchFn, seen } = rpc({ testmempoolaccept: [{ allowed: true }], sendrawtransaction: TXID });
    expect(await nodeBroadcast(async () => NODE, fetchFn)(HEX)).toEqual({ txid: TXID, via: 'node' });
    expect(seen).toEqual(['testmempoolaccept', 'sendrawtransaction']);
  });

  it('a missing node configuration is a no-route failure, not a rejection', async () => {
    const { fetchFn } = rpc({});
    try {
      await nodeBroadcast(async () => null, fetchFn)(HEX);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BroadcastError);
      expect((e as BroadcastError).noRoute).toBe(true);
    }
  });

  it('a 401 is reported as a credential problem, not a rejected transaction', async () => {
    const fetchFn = (async () =>
      ({ status: 401, ok: false, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    await expect(testNode(NODE, fetchFn)).rejects.toThrow(/RPC user or password/);
  });

  it('refuses a mainnet or regtest node before it can be used', async () => {
    // User loss: a mainnet node paired with tbtq addresses would report a zero
    // balance for a funded testnet wallet and accept nothing we sign.
    const main = rpc({ getblockchaininfo: { chain: 'main', blocks: 1 } });
    await expect(testNode(NODE, main.fetchFn)).rejects.toThrow(/mainnet/);
    const reg = rpc({ getblockchaininfo: { chain: 'regtest', blocks: 1 } });
    await expect(testNode(NODE, reg.fetchFn)).rejects.toThrow(/regtest/);
  });

  it('reads the node block hash at a height, and treats "out of range" as behind', async () => {
    const ok = rpc({ getblockhash: (p: unknown[]) => (p[0] === 300741 ? 'cc'.repeat(32) : undefined) });
    expect(await nodeBlockHashAt(NODE, 300741, ok.fetchFn)).toBe('cc'.repeat(32));

    const behind = (async () =>
      ({
        status: 200,
        ok: true,
        json: async () => ({ result: null, error: { code: -8, message: 'Block height out of range' } }),
      }) as Response) as unknown as typeof fetch;
    expect(await nodeBlockHashAt(NODE, 300741, behind)).toBeNull();
  });

  it('sends UTF-8 Basic credentials instead of throwing on a non-Latin-1 password', () => {
    // User loss: btoa() throws on any character above U+00FF, so a node
    // password with an accent would break every RPC call including broadcast.
    expect(() => basicAuthHeader('m0', 'pässwörd–ü')).not.toThrow();
    const header = basicAuthHeader('m0', 'pässwörd')!;
    expect(header.startsWith('Basic ')).toBe(true);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe('m0:pässwörd');
    expect(basicAuthHeader('', '')).toBeNull();
  });

  it('does not leak the RPC password into an error message', async () => {
    const fetchFn = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    try {
      await testNode({ ...NODE, password: 'super-secret' }, fetchFn);
    } catch (e) {
      expect((e as WalletError).message).not.toContain('super-secret');
    }
  });
});

describe('fake fetch helper', () => {
  it('records the request it was given', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { ok: true } }));
    await fetch('https://example.test/x', { method: 'POST', body: 'hi' });
    expect(calls[0]).toMatchObject({ url: 'https://example.test/x', method: 'POST', body: 'hi' });
  });
});
