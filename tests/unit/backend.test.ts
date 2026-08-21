import { describe, it, expect } from 'vitest';
import {
  DEFAULT_NODE_URL,
  PUBLIC_EXPLORER,
  parseBackendInput,
  parseHttpEndpoint,
  publicView,
  hostPermissionPattern,
  isLoopbackHost,
} from '../../src/core/network/backend.js';
import { jsonRpcRequest, parseJsonRpc, parseBlockchainInfo, parseSendRawResult } from '../../src/core/network/jsonrpc.js';
import { WalletError } from '../../src/core/wallet/errors.js';

describe('backend URL parsing (shipped)', () => {
  it('defaults to the public testnet explorer and local Core port 18332', () => {
    expect(PUBLIC_EXPLORER).toBe('https://explorer.bitcoinquantum.com');
    expect(DEFAULT_NODE_URL).toBe('http://127.0.0.1:18332');
  });

  it('rejects credentials in the URL and non-http schemes', () => {
    expect(() => parseHttpEndpoint('http://user:pass@127.0.0.1:18332', 'node')).toThrow(/password/);
    expect(() => parseHttpEndpoint('file:///etc/passwd', 'node')).toThrow(/http or https/);
    expect(() => parseHttpEndpoint('javascript:alert(1)', 'explorer')).toThrow();
  });

  it('strips a trailing slash and keeps an explicit port', () => {
    expect(parseHttpEndpoint('http://127.0.0.1:18332/', 'node')).toBe('http://127.0.0.1:18332');
    expect(isLoopbackHost('http://127.0.0.1:18332')).toBe(true);
    expect(hostPermissionPattern('http://127.0.0.1:18332')).toBe('http://127.0.0.1:18332/*');
  });

  it('publicView never includes the node password', () => {
    const pub = publicView(
      parseBackendInput({
        explorerBase: PUBLIC_EXPLORER,
        nodeUrl: DEFAULT_NODE_URL,
        nodeUser: 'm0',
        nodePassword: 'super-secret',
      }),
    );
    expect(JSON.stringify(pub)).not.toContain('super-secret');
    expect(pub.hasNodePassword).toBe(true);
    expect(pub.nodeUser).toBe('m0');
  });
});

describe('Core JSON-RPC parse (shipped)', () => {
  it('builds a Bitcoin-style 1.0 request and reads sendrawtransaction txid', () => {
    const body = JSON.parse(jsonRpcRequest('sendrawtransaction', ['abcd'])) as { method: string; params: unknown[] };
    expect(body.method).toBe('sendrawtransaction');
    expect(body.params[0]).toBe('abcd');
    const txid = 'ab'.repeat(32);
    expect(parseSendRawResult(txid)).toEqual({ txid });
  });

  it('401 is a credential error; mainnet/regtest nodes are refused', () => {
    expect(() => parseJsonRpc(401, { result: null, error: null })).toThrow(/password/);
    expect(() => parseBlockchainInfo({ chain: 'main', blocks: 1 })).toThrow(/mainnet/);
    expect(() => parseBlockchainInfo({ chain: 'regtest', blocks: 1 })).toThrow(/regtest/);
    expect(parseBlockchainInfo({ chain: 'test', blocks: 303704 })).toEqual({ chain: 'test', blocks: 303704 });
  });

  it('surfaces a reject-reason shaped RPC error', () => {
    try {
      parseJsonRpc(200, { result: null, error: { code: -26, message: 'min relay fee not met' } });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(WalletError);
      expect((e as WalletError).message).toContain('min relay fee');
    }
  });
});
