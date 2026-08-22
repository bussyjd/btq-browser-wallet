/**
 * The deterministic backend the extension talks to: one HTTP server on
 * 127.0.0.1 serving the BTQ explorer API, a btq-core JSON-RPC endpoint and the
 * demo dapp page.
 *
 * Every response shape here mirrors a body recorded from the live explorer on
 * 2026-08-21 (tests/fixtures/explorer/*.json): satoshi amounts are strings,
 * `script_pub_key` is Node-Buffer JSON, a never-seen address 404s with
 * {"error":"Address not found"}, /utxos pages with offset/limit, /txs pages with
 * page/limit (max 100), and POST /api/v1/tx/send does not exist — it answers
 * with Fastify's route-miss body, exactly as the public explorer does.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger } from './ledger.js';
import { handleNodeRpc, newNodeState, type NodeState } from './mock-node.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAPP_HTML = readFileSync(join(HERE, 'dapp.html'), 'utf8');

/** The live explorer caps /txs at 100 rows per page. */
export const MAX_TX_PAGE_LIMIT = 100;

export interface MockBackend {
  port: number;
  /** http://127.0.0.1:PORT — the origin the extension is pointed at. */
  origin: string;
  /** http://localhost:PORT — a *different* origin, for the connect tests. */
  altOrigin: string;
  rpcUrl: string;
  dappUrl: string;
  altDappUrl: string;
  ledger: Ledger;
  node: NodeState;
  /** Every request the extension made, for "no RPC hit" style assertions. */
  requests: { method: string; url: string; at: number }[];
  close(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function bufferJson(hex: string): { type: 'Buffer'; data: number[] } {
  const data: number[] = [];
  for (let i = 0; i < hex.length; i += 2) data.push(parseInt(hex.slice(i, i + 2), 16));
  return { type: 'Buffer', data };
}

function send(res: ServerResponse, status: number, body: unknown, contentType = 'application/json'): void {
  const payload = contentType === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, {
    'content-type': contentType === 'application/json' ? 'application/json; charset=utf-8' : contentType,
    'content-length': Buffer.byteLength(payload),
    // The extension fetches with host permissions, so CORS is not enforced for
    // it; these headers only keep the dapp page and any manual poking working.
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** Fastify's own 404 body — how the public explorer answers an unknown route. */
function routeMiss(res: ServerResponse, method: string, path: string): void {
  send(res, 404, { message: `Route ${method}:${path} not found`, error: 'Not Found', statusCode: 404 });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startMockBackend(): Promise<MockBackend> {
  const ledger = new Ledger();
  const node = newNodeState();
  const requests: { method: string; url: string; at: number }[] = [];

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'mock backend failure' });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    requests.push({ method, url: req.url ?? '/', at: Date.now() });

    if (method === 'OPTIONS') {
      send(res, 204, '', 'text/plain');
      return;
    }

    // ------------------------------------------------------------ test hooks
    if (path.startsWith('/__test/')) {
      await testHook(req, res, path, url);
      return;
    }

    // ------------------------------------------------------------- dapp page
    if (path === '/' || path === '/dapp.html') {
      send(res, 200, DAPP_HTML, 'text/html');
      return;
    }

    // -------------------------------------------------------------- node RPC
    if (path === '/rpc') {
      if (method !== 'POST') {
        routeMiss(res, method, path);
        return;
      }
      const auth = req.headers.authorization ?? '';
      const expected = `Basic ${Buffer.from(`${node.user}:${node.password}`).toString('base64')}`;
      if (auth !== expected) {
        send(res, 401, { result: null, error: { code: -32000, message: 'Unauthorized' }, id: null });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBody(req));
      } catch {
        send(res, 400, { result: null, error: { code: -32700, message: 'Parse error' }, id: null });
        return;
      }
      const outcome = await handleNodeRpc(node, ledger, parsed);
      send(res, outcome.status, outcome.body);
      return;
    }

    // -------------------------------------------------------- explorer faults
    if (path.startsWith('/api/')) {
      if (ledger.hasFault('slow')) await sleep(ledger.slowMs);
      if (ledger.hasFault('http-500')) {
        send(res, 500, { error: 'Internal Server Error', statusCode: 500 });
        return;
      }
    }

    // ------------------------------------------------------------- explorer
    if (path === '/api/v1/blocks/tip' && method === 'GET') {
      send(res, 200, {
        hash: ledger.hashAt(ledger.tip),
        height: ledger.tip,
        canonical: true,
        prev_hash: ledger.hashAt(ledger.tip - 1),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (path === '/api/v1/mempool/summary' && method === 'GET') {
      const pending = ledger.txs.filter((t) => t.height === null);
      send(res, 200, {
        txCount: pending.length,
        totalVsize: pending.reduce((n, t) => n + t.vsize, 0),
        totalFees: pending.reduce((n, t) => n + t.fee, 0n).toString(),
        feeHistogram: [],
      });
      return;
    }

    const txMatch = /^\/api\/v1\/tx\/([0-9a-fA-F]{64})$/.exec(path);
    if (txMatch && method === 'GET') {
      const tx = ledger.getTx((txMatch[1] as string).toLowerCase());
      if (!tx) {
        send(res, 404, { error: 'Transaction not found' });
        return;
      }
      send(res, 200, {
        txid: tx.txid,
        block_height: tx.height,
        is_dilithium: true,
        fee: tx.fee.toString(),
        vsize: tx.vsize,
        weight: tx.weight,
        inputs: tx.inputs.map((i) => ({ prev_txid: i.txid, prev_vout: i.vout, value: null, address: null })),
        outputs: tx.outputs.map((o, vout) => ({
          vout,
          value: o.value.toString(),
          script_pub_key: o.script,
          script_type: 'witness_v2_p2mr',
          addresses: o.address ? [{ address: o.address, role: 'payee' }] : [],
          spent_txid: null,
        })),
      });
      return;
    }

    if (path === '/api/v1/tx/send') {
      // The public explorer has no push route at all — this 404 is the point.
      routeMiss(res, method, path);
      return;
    }

    const addr = /^\/api\/v1\/address\/([^/]+)(\/utxos|\/txs)?$/.exec(path);
    if (addr && method === 'GET') {
      const address = decodeURIComponent(addr[1] as string);
      const sub = addr[2];
      const activity = ledger.activityFor(address);

      if (sub === '/utxos') {
        // A never-seen address answers 200 with an empty list on the live API.
        const offset = Number(url.searchParams.get('offset') ?? '0') || 0;
        const limit = Math.min(Number(url.searchParams.get('limit') ?? '100') || 100, 100);
        const all = ledger.unspentFor(address);
        const items = all.slice(offset, offset + limit).map((u) => ({
          txid: u.txid,
          vout: u.vout,
          block_height: u.height,
          value: u.value.toString(),
          script_pub_key: bufferJson(ledger.hasFault('swap-address') ? swapScript(ledger, u.script) : u.script),
          script_type: 'witness_v2_p2mr',
          spent_txid: null,
          spent_vin: null,
        }));
        send(res, 200, { items });
        return;
      }

      if (sub === '/txs') {
        const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
        const limit = Number(url.searchParams.get('limit') ?? '25') || 25;
        if (limit > MAX_TX_PAGE_LIMIT) {
          send(res, 200, { items: [], total: 0, page, limit });
          return;
        }
        const all = ledger.historyFor(address);
        const items = all.slice((page - 1) * limit, page * limit).map((h) => ({
          address,
          txid: h.txid,
          block_height: h.blockHeight,
          tx_index: h.txIndex,
          value_change: h.valueChange.toString(),
        }));
        send(res, 200, { items, total: all.length, page, limit });
        return;
      }

      if (activity.txCount === 0) {
        send(res, 404, { error: 'Address not found' });
        return;
      }
      send(res, 200, {
        address,
        script_type: 'witness_v2_p2mr',
        first_seen_height: ledger.tip,
        tx_count: activity.txCount,
        total_received: activity.balance.toString(),
        total_sent: '0',
        // The live indexer reports a *negative* balance for busy addresses; the
        // wallet must ignore this field entirely and sum /utxos instead.
        balance: ledger.bogusBalance ? '-266828024798707' : activity.balance.toString(),
        unspent_count: ledger.bogusBalance ? -224 : activity.unspentCount,
        isDilithium: true,
      });
      return;
    }

    routeMiss(res, method, path);
  }

  async function testHook(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    if (path === '/__test/state') {
      send(res, 200, {
        tip: ledger.tip,
        txs: ledger.txs.length,
        utxos: [...ledger.utxos.values()].filter((u) => u.spentBy === null).length,
        nodeCalls: node.calls.length,
      });
      return;
    }
    if (path === '/__test/fund') {
      const address = url.searchParams.get('address') ?? '';
      const sats = url.searchParams.get('sats') ?? '0';
      send(res, 200, { txid: ledger.fund(address, BigInt(sats)) });
      return;
    }
    if (path === '/__test/mine') {
      send(res, 200, { tip: ledger.mine(Number(url.searchParams.get('blocks') ?? '1') || 1) });
      return;
    }
    if (path === '/__test/fault') {
      const kind = url.searchParams.get('kind');
      const on = url.searchParams.get('on') !== 'false';
      if (kind === 'wrong-txid' || kind === 'swap-address' || kind === 'http-500' || kind === 'slow') {
        ledger.setFault(kind, on);
        send(res, 200, { ok: true, kind, on });
        return;
      }
      send(res, 400, { error: 'unknown fault' });
      return;
    }
    routeMiss(res, req.method ?? 'GET', path);
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const origin = `http://127.0.0.1:${port}`;
  const altOrigin = `http://localhost:${port}`;

  return {
    port,
    origin,
    altOrigin,
    rpcUrl: `${origin}/rpc`,
    dappUrl: `${origin}/dapp.html`,
    altDappUrl: `${altOrigin}/dapp.html`,
    ledger,
    node,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Hand back somebody else's script, so the wallet must refuse the row. */
function swapScript(ledger: Ledger, script: string): string {
  for (const u of ledger.utxos.values()) if (u.script !== script) return u.script;
  return `5220${'11'.repeat(32)}`;
}
