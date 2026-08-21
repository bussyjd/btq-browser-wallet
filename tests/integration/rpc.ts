/** Minimal BTQ Core JSON-RPC client for integration tests. */
export interface RpcConfig { url: string; user: string; pass: string; wallet?: string }

export function rpcConfigFromEnv(): RpcConfig | null {
  if (!process.env.BTQ_REGTEST) return null;
  return {
    url: process.env.BTQ_RPC_URL ?? 'http://127.0.0.1:18999',
    user: process.env.BTQ_RPC_USER ?? 'm0',
    pass: process.env.BTQ_RPC_PASS ?? 'm0pass',
    wallet: process.env.BTQ_RPC_WALLET ?? 'm0d',
  };
}

export async function rpc<T = any>(cfg: RpcConfig, method: string, params: unknown[] = [], useWallet = true): Promise<T> {
  const url = useWallet && cfg.wallet ? `${cfg.url}/wallet/${cfg.wallet}` : cfg.url;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Basic ' + Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64'),
    },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'm0', method, params }),
  });
  const body = (await res.json()) as { result: T; error: { code: number; message: string } | null };
  if (body.error) throw new Error(`${method}: ${body.error.message} (code ${body.error.code})`);
  return body.result;
}

export const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
