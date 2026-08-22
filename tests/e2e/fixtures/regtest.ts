/**
 * Tier 2 plumbing: a real regtest btqd behind the mock node.
 *
 * The extension is testnet-only — `parseBlockchainInfo` refuses a node that
 * reports chain "regtest" — so the extension keeps talking to the mock, and the
 * mock forwards `testmempoolaccept` / `sendrawtransaction` to btqd. Funding is
 * real: the same 32-byte witness program is re-encoded under the regtest HRP
 * (`qcrt1z…`), paid with `sendtoaddress`, and the resulting outpoint is adopted
 * into the mock ledger under its `tbtq1z…` name. The scriptPubKey is identical
 * either way, so what the wallet signs is exactly what btq-core verifies.
 *
 * Everything here is inert unless BTQ_REGTEST=1 and the node answers.
 */
import { encodeP2mr, decodeP2mr } from './btq-address.js';
import { toHex } from './bip341.js';
import type { Ledger } from './ledger.js';

export interface RegtestConfig {
  url: string;
  user: string;
  pass: string;
  wallet: string;
}

/** Same environment contract as tests/integration/rpc.ts. */
export function regtestFromEnv(): RegtestConfig | null {
  if (!process.env.BTQ_REGTEST) return null;
  return {
    url: process.env.BTQ_RPC_URL ?? 'http://127.0.0.1:18999',
    user: process.env.BTQ_RPC_USER ?? 'm0',
    pass: process.env.BTQ_RPC_PASS ?? 'm0pass',
    wallet: process.env.BTQ_RPC_WALLET ?? 'm0d',
  };
}

export async function regtestRpc<T = any>(
  cfg: RegtestConfig,
  method: string,
  params: unknown[] = [],
  useWallet = true,
): Promise<T> {
  const url = useWallet && cfg.wallet ? `${cfg.url}/wallet/${cfg.wallet}` : cfg.url;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64')}`,
    },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'btq-e2e', method, params }),
  });
  const body = (await res.json()) as { result: T; error: { code: number; message: string } | null };
  if (body.error) throw new Error(`${method}: ${body.error.message} (code ${body.error.code})`);
  return body.result;
}

/** True when a regtest node is configured *and* reachable. */
export async function regtestReachable(cfg: RegtestConfig | null): Promise<boolean> {
  if (!cfg) return false;
  try {
    await regtestRpc(cfg, 'getblockchaininfo', [], false);
    return true;
  } catch {
    return false;
  }
}

/** Forward the two broadcast methods to btqd, unchanged. */
export function regtestProxy(cfg: RegtestConfig) {
  return (method: string, params: unknown[]) => regtestRpc(cfg, method, params, false);
}

/**
 * Pay a real coin to the wallet's own witness program and adopt the outpoint
 * into the mock ledger. Returns the outpoint that was created.
 */
export async function fundOnRegtest(
  cfg: RegtestConfig,
  ledger: Ledger,
  testnetAddress: string,
  sats: bigint,
): Promise<{ txid: string; vout: number; value: bigint }> {
  const program = decodeP2mr(testnetAddress).program;
  const regtestAddress = encodeP2mr(program, 'regtest');
  const scriptHex = `5220${toHex(program)}`;

  const miner = await regtestRpc<string>(cfg, 'getnewaddress', []);
  const height = await regtestRpc<number>(cfg, 'getblockcount', [], false);
  if (height < 101) await regtestRpc(cfg, 'generatetoaddress', [101, miner], false);

  const txid = await regtestRpc<string>(cfg, 'sendtoaddress', [
    regtestAddress,
    Number(sats) / 1e8,
  ]);
  await regtestRpc(cfg, 'generatetoaddress', [1, miner], false);

  const walletTx = await regtestRpc<{ hex: string }>(cfg, 'gettransaction', [txid, true]);
  const raw = await regtestRpc<any>(cfg, 'decoderawtransaction', [walletTx.hex], false);
  for (const out of raw.vout as any[]) {
    if (String(out.scriptPubKey.hex).toLowerCase() !== scriptHex) continue;
    const value = BigInt(Math.round(Number(out.value) * 1e8));
    ledger.adopt({
      txid,
      vout: out.n as number,
      address: testnetAddress,
      script: scriptHex,
      value,
      height: ledger.tip,
    });
    return { txid, vout: out.n as number, value };
  }
  throw new Error(`regtest funding output for ${regtestAddress} was not found by scriptPubKey`);
}

/** Confirm whatever is in the regtest mempool, and keep the mock tip in step. */
export async function confirmOnRegtest(cfg: RegtestConfig, ledger: Ledger, blocks = 1): Promise<void> {
  const miner = await regtestRpc<string>(cfg, 'getnewaddress', []);
  await regtestRpc(cfg, 'generatetoaddress', [blocks, miner], false);
  ledger.mine(blocks);
}
