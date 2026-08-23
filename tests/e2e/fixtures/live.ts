/**
 * The live recording's configuration, its chain reads, its preflight and its
 * waiters. Nothing here is mocked: the explorer is the public one and the node
 * is a real btqd on this machine.
 *
 * Two rules shape the whole file.
 *
 * **A live run that cannot prove what it is showing must throw, not degrade.**
 * The mocked suite can trust `waitForScan`; a live one cannot. `useWallet.refresh`
 * catches a scan failure, sets `syncError` and *still* sets `scanned = true`, and
 * `Home.tsx` gates readiness on `scanned && !scanning` — so against a flaky
 * explorer `copy-address` enables with a stale balance and the video records a
 * number the wallet does not stand behind. `waitForLiveScan` is `waitForScan`
 * plus the one assertion that closes that hole.
 *
 * **The preflight sees the chain exactly as the wallet will.** Alice's funding is
 * read through `scriptForAddress` + `parseUtxoResponse` from `src/core/explorer`,
 * so if the preflight and the extension disagree the disagreement surfaces in
 * Node, before the camera is rolling, instead of halfway through a take.
 *
 * Secrets arrive through the environment and nowhere else: no default, no
 * literal, no fallback, and `liveFromEnv()` is their only reader.
 */
import { expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForScan, REPO_ROOT, DIST } from './extension.js';
// The wallet's own parsers and derivation, run here only to work out what the
// extension is going to see. They never touch the extension's runtime.
import { parseUtxoResponse, type ExplorerUtxo } from '../../../src/core/explorer/utxo.js';
import { parseTipResponse } from '../../../src/core/explorer/schema.js';
import { scriptForAddress } from '../../../src/core/script/address.js';
import { addressFromHdSeed } from '../../../src/core/wallet/derive.js';
import { mnemonicToHdSeed } from '../../../src/core/crypto/mnemonic.js';
import { parseBtqAmount, formatSats } from '../../../src/core/wallet/format.js';
import { dustThreshold, feeForP2mrTx, MIN_RELAY_SAT_PER_KVB } from '../../../src/core/tx/fee.js';
import { GAP_LIMIT } from '../../../src/core/wallet/gap.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIR = resolve(HERE, '../../../src/ui');

/** The file every missing variable points the operator at. */
export const ENV_FILE = '.env.demo';
/** The control the reveal scene needs. Absent from the build until it lands. */
export const REVEAL_TESTID = 'reveal-phrase';
/** Priority is the dearest preset the popup offers; budget Alice at that rate. */
const PRIORITY_SAT_PER_KVB = 5000;
/** How far the node may trail the explorer before it cannot confirm our send. */
const NODE_LAG_LIMIT = 3;

export interface LiveNode {
  url: string;
  user: string;
  password: string;
}

export interface LiveWallet {
  mnemonic: string;
  password: string;
}

export interface LiveConfig {
  explorer: string;
  node: LiveNode;
  alice: LiveWallet;
  bob: LiveWallet;
  /** The amount typed into Send, as the popup would take it, e.g. "0.02". */
  amountBtq: string;
  amountSats: bigint;
  /** Pinned expectation for Bob's first address, when the operator set one. */
  bobAddress: string | null;
  reveal: boolean;
  confirmTimeoutMs: number;
  /** Scene numbers to record; null records all of them. */
  scenes: Set<number> | null;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `demo:live — ${name} is not set. Put it in ${ENV_FILE} (git-ignored) or export it, then run the command again.`,
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

/**
 * The live configuration, or null when this is an ordinary run.
 *
 * Returning null (rather than throwing) with `BTQ_LIVE` unset is what lets the
 * spec file load and skip in CI. With `BTQ_LIVE=1` and something missing it
 * throws instead: an operator who asked for a live run has earned a reason, not
 * a silent skip.
 */
export function liveFromEnv(): LiveConfig | null {
  if (!process.env.BTQ_LIVE) return null;
  const amountBtq = optional('BTQ_DEMO_AMOUNT', '0.02');
  let amountSats: bigint;
  try {
    amountSats = parseBtqAmount(amountBtq);
  } catch {
    throw new Error(`demo:live — BTQ_DEMO_AMOUNT is "${amountBtq}"; it has to look like 0.02.`);
  }
  const scenesRaw = optional('BTQ_DEMO_SCENES', '');
  return {
    explorer: optional('BTQ_DEMO_EXPLORER', 'https://explorer.bitcoinquantum.com').replace(/\/$/, ''),
    node: {
      url: optional('BTQ_DEMO_NODE_URL', 'http://127.0.0.1:18432').replace(/\/$/, ''),
      user: optional('BTQ_DEMO_NODE_USER', 'btqwallet'),
      password: required('BTQ_DEMO_RPC_PASSWORD'),
    },
    alice: {
      mnemonic: required('BTQ_DEMO_ALICE_MNEMONIC'),
      password: optional('BTQ_DEMO_ALICE_PASSWORD', 'demo-alice-pass'),
    },
    bob: {
      mnemonic: required('BTQ_DEMO_BOB_MNEMONIC'),
      password: optional('BTQ_DEMO_BOB_PASSWORD', 'demo-bob-pass'),
    },
    amountBtq,
    amountSats,
    bobAddress: process.env.BTQ_DEMO_BOB_ADDRESS?.trim() || null,
    reveal: optional('BTQ_DEMO_REVEAL', '1') !== '0',
    confirmTimeoutMs: Number(optional('BTQ_DEMO_CONFIRM_TIMEOUT_MS', '420000')),
    scenes: scenesRaw ? new Set(scenesRaw.split(',').map((s) => Number(s.trim()))) : null,
  };
}

/** Head and tail of an address — enough to identify it, too little to mistype. */
export function shortAddress(address: string): string {
  return address.length > 20 ? `${address.slice(0, 12)}…${address.slice(-6)}` : address;
}

/**
 * What `beforeAll` is allowed to log. No phrase, no password, not even their
 * lengths — only where the run is pointed and what it intends to move.
 */
export function redactedSummary(cfg: LiveConfig): string {
  // A phrase that does not parse is the preflight's business to report, not a
  // reason for the one line the run is allowed to print to blow up first.
  const shortOr = (mnemonic: string) => {
    try {
      return shortAddress(firstAddress(mnemonic));
    } catch {
      return '<phrase does not parse>';
    }
  };
  const alice = shortOr(cfg.alice.mnemonic);
  const bob = shortOr(cfg.bob.mnemonic);
  return [
    `explorer ${cfg.explorer}`,
    `node ${cfg.node.url} as "${cfg.node.user}" (password from BTQ_DEMO_RPC_PASSWORD)`,
    `sending ${cfg.amountBtq} tBTQ`,
    `${alice} -> ${bob}`,
    `reveal scene ${cfg.reveal ? 'on' : 'off'}`,
  ].join(' · ');
}

/** m/0'/0'/0' for a phrase, on testnet. */
export function firstAddress(mnemonic: string): string {
  return addressFromHdSeed(mnemonicToHdSeed(mnemonic), 'external', 0, 'testnet').address;
}

// -------------------------------------------------------------------- node RPC

interface JsonRpcBody {
  result?: unknown;
  error?: { code: number; message: string } | null;
}

/**
 * One JSON-RPC call against the real node.
 *
 * The 401 branch exists because it is the single most likely way a run fails,
 * and "Could not reach the node" would be a lie: the node answered, it just did
 * not accept the credential.
 */
export async function nodeRpc<T = unknown>(
  cfg: LiveConfig,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const auth = Buffer.from(`${cfg.node.user}:${cfg.node.password}`).toString('base64');
  let res: Response;
  try {
    res = await fetch(cfg.node.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'btq-demo', method, params }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error(
      `the node at ${cfg.node.url} did not answer ${method} — is btqd running, and is BTQ_DEMO_NODE_URL right?`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `the node at ${cfg.node.url} refused the RPC credentials (HTTP ${res.status}) — check BTQ_DEMO_NODE_USER and BTQ_DEMO_RPC_PASSWORD against the node's rpcauth/rpcuser.`,
    );
  }
  let body: JsonRpcBody | undefined;
  try {
    body = (await res.json()) as JsonRpcBody;
  } catch {
    body = undefined;
  }
  if (body?.error) throw new Error(`${method}: ${body.error.message} (code ${body.error.code})`);
  if (!body || !('result' in body)) {
    throw new Error(`${method}: the node answered HTTP ${res.status} with no JSON-RPC result.`);
  }
  return body.result as T;
}

// -------------------------------------------------------------------- explorer

export async function explorerGet(
  cfg: LiveConfig,
  path: string,
): Promise<{ status: number; json: unknown }> {
  const url = `${cfg.explorer}${path}`;
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        json = undefined;
      }
      // A 5xx is worth another go; a 4xx is an answer and the caller decides.
      if (res.status >= 500 && attempt < 2) {
        last = new Error(`HTTP ${res.status}`);
        continue;
      }
      return { status: res.status, json };
    } catch (e) {
      last = e;
    }
  }
  throw new Error(
    `the explorer at ${url} did not answer: ${last instanceof Error ? last.message : String(last)}`,
  );
}

export interface Funding {
  index: number;
  path: string;
  address: string;
  confirmed: bigint;
  mempool: bigint;
  utxos: ExplorerUtxo[];
}

/**
 * Read one wallet's first `GAP_LIMIT` receive addresses through the extension's
 * own parser, so what the preflight believes is what the popup will believe.
 */
export async function confirmedFunding(cfg: LiveConfig, mnemonic: string): Promise<Funding[]> {
  const hdSeed = mnemonicToHdSeed(mnemonic);
  const derived = Array.from({ length: GAP_LIMIT }, (_, i) =>
    addressFromHdSeed(hdSeed, 'external', i, 'testnet'),
  );
  const out: Funding[] = new Array<Funding>(derived.length);
  // The same width the wallet scans at, so the public indexer sees the same
  // shape of load from the preflight as it does from a real gap scan.
  const width = 5;
  let next = 0;
  const workers = Array.from({ length: Math.min(width, derived.length) }, async () => {
    for (let i = next++; i < derived.length; i = next++) {
      const d = derived[i]!;
      const { status, json } = await explorerGet(cfg, `/api/v1/address/${d.address}/utxos`);
      const utxos = parseUtxoResponse(status, json, d.address, scriptForAddress(d.address, 'testnet'));
      let confirmed = 0n;
      let mempool = 0n;
      for (const u of utxos) {
        if (u.blockHeight === null) mempool += u.value;
        else confirmed += u.value;
      }
      out[i] = { index: d.index, path: d.path, address: d.address, confirmed, mempool, utxos };
    }
  });
  await Promise.all(workers);
  return out;
}

// ------------------------------------------------------------------- freshness

/** Newest mtime under a directory, ignoring nothing — a build input is a build input. */
function newestMtime(dir: string): { path: string; ms: number } {
  let newest = { path: dir, ms: 0 };
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    const child = s.isDirectory() ? newestMtime(p) : { path: p, ms: s.mtimeMs };
    if (child.ms > newest.ms) newest = child;
  }
  return newest;
}

/**
 * Refuse to record yesterday's build.
 *
 * `demo-live.sh` never sets `SKIP_BUILD`, so this only fires when somebody runs
 * the spec by hand — which is exactly when a stale `dist/` is plausible.
 */
export function assertDistFresh(): void {
  const manifest = join(DIST, 'manifest.json');
  if (!existsSync(manifest)) {
    throw new Error('dist/manifest.json is missing — run `npm run build` before recording.');
  }
  const built = statSync(manifest).mtimeMs;
  const newest = newestMtime(join(REPO_ROOT, 'src'));
  if (newest.ms > built) {
    throw new Error(
      `dist/ is older than ${newest.path.replace(`${REPO_ROOT}/`, '')} — the video would show a stale build. Run \`npm run build\`.`,
    );
  }
}

/**
 * True when the popup in this working tree can reveal the phrase from Settings.
 *
 * The directory is a parameter so both answers can be proved in a unit test:
 * a check that has only ever been observed saying "yes" is not a check.
 */
export function revealScreenExists(uiDir: string = UI_DIR): boolean {
  const stack: string[] = [uiDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!/\.(tsx?|html)$/.test(name)) continue;
      if (readFileSync(p, 'utf8').includes(REVEAL_TESTID)) return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------- preflight

export interface PreflightCheck {
  name: string;
  ok: boolean;
  /** Not run, because something it depends on already failed. */
  skipped?: boolean;
  detail: string;
}

export interface PreflightReport {
  ok: boolean;
  checks: PreflightCheck[];
  /** One operator-facing sentence per failure, in the order they were found. */
  refusals: string[];
}

function have(command: string): boolean {
  try {
    execFileSync('/bin/sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Everything that has to be true before a camera is worth pointing at this.
 *
 * Every check is run that can be run: a node that refuses its credential does
 * not stop the operator from being told whether Alice is funded. A check whose
 * inputs are unavailable is reported `skipped`, never guessed — in particular a
 * node we could not talk to is *not* reported as forked.
 */
export async function preflight(
  cfg: LiveConfig,
  opts: { checkDist?: boolean } = {},
): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];
  const refusals: string[] = [];
  const add = (name: string, ok: boolean, detail: string, refusal?: string) => {
    checks.push({ name, ok, detail });
    if (!ok && refusal) refusals.push(refusal);
  };
  const skip = (name: string, detail: string) => checks.push({ name, ok: false, skipped: true, detail });

  add(
    'rpc password',
    cfg.node.password.length > 0,
    cfg.node.password.length > 0 ? 'supplied through BTQ_DEMO_RPC_PASSWORD' : 'missing',
    `demo:live — BTQ_DEMO_RPC_PASSWORD is empty. Put the node's RPC password in ${ENV_FILE} and run npm run demo:live again.`,
  );

  const ffmpeg = have('ffmpeg');
  add(
    'ffmpeg',
    ffmpeg,
    ffmpeg ? 'on PATH' : 'not found',
    'demo:live — ffmpeg is not on PATH, so the clips could not be stitched. Install ffmpeg (brew install ffmpeg) and run npm run demo:live again.',
  );

  // ---------------------------------------------------------------- explorer
  let tip: { height: number; hash: string } | null = null;
  try {
    const { status, json } = await explorerGet(cfg, '/api/v1/blocks/tip');
    tip = parseTipResponse(status, json);
    add('explorer', true, `${cfg.explorer} · tip ${tip.height} · ${tip.hash.slice(0, 12)}…`);
  } catch (e) {
    add(
      'explorer',
      false,
      e instanceof Error ? e.message : String(e),
      `demo:live — the explorer at ${cfg.explorer} did not return a chain tip. Check the network and BTQ_DEMO_EXPLORER, then run npm run demo:live again.`,
    );
  }

  // -------------------------------------------------------------------- node
  let chainInfo: { chain?: string; blocks?: number; initialblockdownload?: boolean } | null = null;
  try {
    chainInfo = await nodeRpc(cfg, 'getblockchaininfo');
  } catch (e) {
    add(
      'node reachable',
      false,
      e instanceof Error ? e.message : String(e),
      `demo:live — ${e instanceof Error ? e.message : String(e)} Fix that and run npm run demo:live again.`,
    );
  }

  if (chainInfo) {
    const chain = String(chainInfo.chain ?? '');
    add(
      'node chain',
      chain === 'test',
      `chain ${chain || 'unknown'} · height ${chainInfo.blocks ?? '?'}`,
      `demo:live — the node at ${cfg.node.url} is on chain "${chain || 'unknown'}", and this wallet is testnet-only. Point BTQ_DEMO_NODE_URL at a testnet btqd and run npm run demo:live again.`,
    );
    const ibd = chainInfo.initialblockdownload === true;
    add(
      'node synced',
      !ibd,
      ibd ? 'still in initial block download' : 'out of initial block download',
      `demo:live — the node at ${cfg.node.url} is still in initial block download, so it cannot confirm anything you send. Wait for it to finish, then run npm run demo:live again.`,
    );

    try {
      const net = await nodeRpc<{ connections?: number }>(cfg, 'getnetworkinfo');
      const peers = Number(net.connections ?? 0);
      add(
        'node peers',
        peers > 0,
        `${peers} connection${peers === 1 ? '' : 's'}`,
        `demo:live — the node at ${cfg.node.url} has 0 peers, so a broadcast would never relay and the transaction would never confirm. Give it peers (addnode / -connect) and run npm run demo:live again.`,
      );
    } catch (e) {
      add('node peers', false, e instanceof Error ? e.message : String(e), `demo:live — could not read the node's peer count: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (tip) {
      const blocks = Number(chainInfo.blocks ?? 0);
      const behind = tip.height - blocks;
      add(
        'node vs explorer height',
        behind <= NODE_LAG_LIMIT,
        `node ${blocks}, explorer ${tip.height} (${behind >= 0 ? `${behind} behind` : `${-behind} ahead`})`,
        `demo:live — the node is ${behind} blocks behind the explorer (node ${blocks}, explorer ${tip.height}). Let it catch up, then run npm run demo:live again.`,
      );
      if (blocks >= tip.height) {
        // The same comparison probeBackend makes before the popup will accept
        // the node at all (src/background/backend-store.ts). A mismatch here is
        // the dead pre-0.5.0 fork, and the wallet would refuse the node on camera.
        try {
          const hash = await nodeRpc<string>(cfg, 'getblockhash', [tip.height]);
          add(
            'node on the explorer chain',
            hash === tip.hash,
            hash === tip.hash
              ? `both have ${hash.slice(0, 12)}… at ${tip.height}`
              : `explorer ${tip.hash.slice(0, 12)}…, node ${String(hash).slice(0, 12)}… at ${tip.height}`,
            `demo:live — at height ${tip.height} the explorer has ${tip.hash.slice(0, 12)}… and the node has ${String(hash).slice(0, 12)}…, so they are on different chains (the testnet forked between 299000 and 300000; build btq-core at v0.5.0-testnet or later). Fix the node and run npm run demo:live again.`,
          );
        } catch (e) {
          add('node on the explorer chain', false, e instanceof Error ? e.message : String(e), `demo:live — could not compare the node's block hash with the explorer's: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        skip('node on the explorer chain', `not compared — the node is below the explorer tip (node ${blocks}, explorer ${tip.height})`);
      }
    } else {
      skip('node vs explorer height', 'not compared — the explorer tip is unknown');
      skip('node on the explorer chain', 'not compared — the explorer tip is unknown');
    }

    try {
      const mem = await nodeRpc<{ minrelaytxfee?: number }>(cfg, 'getmempoolinfo');
      // getmempoolinfo reports BTQ/kvB; the popup's presets are sat/kvB.
      const satPerKvB = Math.round(Number(mem.minrelaytxfee ?? 0) * 1e8);
      add(
        'node relay floor',
        satPerKvB <= MIN_RELAY_SAT_PER_KVB,
        `minrelaytxfee ${satPerKvB} sat/kvB (cheapest preset ${MIN_RELAY_SAT_PER_KVB})`,
        `demo:live — the node relays nothing below ${satPerKvB} sat/kvB, and the popup's cheapest preset is ${MIN_RELAY_SAT_PER_KVB} sat/kvB, so Economy would be rejected on camera. Lower -minrelaytxfee and run npm run demo:live again.`,
      );
    } catch (e) {
      add('node relay floor', false, e instanceof Error ? e.message : String(e), `demo:live — could not read the node's relay floor: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    for (const name of [
      'node chain',
      'node synced',
      'node peers',
      'node vs explorer height',
      'node on the explorer chain',
      'node relay floor',
    ]) {
      skip(name, 'not checked — the node did not answer getblockchaininfo');
    }
  }

  // ------------------------------------------------------------------- Alice
  try {
    const funding = await confirmedFunding(cfg, cfg.alice.mnemonic);
    const confirmed = funding.reduce((sum, f) => sum + f.confirmed, 0n);
    const mempool = funding.reduce((sum, f) => sum + f.mempool, 0n);
    const utxoCount = funding.reduce((n, f) => n + f.utxos.length, 0);
    const confirmedUtxos = funding.reduce(
      (n, f) => n + f.utxos.filter((u) => u.blockHeight !== null).length,
      0,
    );
    // Budget the dearest preset the popup offers, plus a change output that has
    // to clear the node's own dust floor, so a pass here cannot become an
    // "insufficient funds" on camera at any fee chip the operator clicks.
    const needed =
      cfg.amountSats + feeForP2mrTx(Math.max(confirmedUtxos, 1), 2, PRIORITY_SAT_PER_KVB) + dustThreshold();
    const fundTarget = funding[0]!.address;
    add(
      'Alice funded',
      confirmed >= needed,
      `${formatSats(confirmed)} tBTQ confirmed across m/0'/0'/0..${GAP_LIMIT - 1} (${utxoCount} utxo${utxoCount === 1 ? '' : 's'}, ${confirmedUtxos} confirmed${mempool > 0n ? `, ${formatSats(mempool)} tBTQ still in the mempool` : ''}) · needs ${formatSats(needed)}`,
      `demo:live — Alice has ${formatSats(confirmed)} tBTQ confirmed across m/0'/0'/0..${GAP_LIMIT - 1} (${utxoCount} utxo${utxoCount === 1 ? '' : 's'}${mempool > 0n ? `, ${formatSats(mempool)} tBTQ still in the mempool` : ''}), and this take needs ${formatSats(needed)}. Fund ${shortAddress(fundTarget)} with at least ${formatSats(needed)} tBTQ and wait for one block, then run npm run demo:live again.`,
    );
  } catch (e) {
    add(
      'Alice funded',
      false,
      e instanceof Error ? e.message : String(e),
      `demo:live — could not read Alice's coins from the explorer: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // --------------------------------------------------------------------- Bob
  try {
    const bob = firstAddress(cfg.bob.mnemonic);
    const pinned = cfg.bobAddress;
    const ok = pinned === null || pinned === bob;
    add(
      'Bob derives',
      ok,
      pinned === null ? `${shortAddress(bob)} at m/0'/0'/0'` : `${shortAddress(bob)} matches BTQ_DEMO_BOB_ADDRESS`,
      `demo:live — BTQ_DEMO_BOB_MNEMONIC derives ${shortAddress(bob)} at m/0'/0'/0', but BTQ_DEMO_BOB_ADDRESS pins ${shortAddress(pinned ?? '')}. One of the two is wrong; fix ${ENV_FILE} and run npm run demo:live again.`,
    );
  } catch (e) {
    add(
      'Bob derives',
      false,
      e instanceof Error ? e.message : String(e),
      `demo:live — BTQ_DEMO_BOB_MNEMONIC is not a phrase this wallet can import: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // ------------------------------------------------------------------ reveal
  if (cfg.reveal) {
    const present = revealScreenExists();
    add(
      'reveal screen',
      present,
      present ? `"${REVEAL_TESTID}" is in src/ui` : `"${REVEAL_TESTID}" is not in src/ui yet`,
      `demo:live — the recovery-phrase reveal is switched on (BTQ_DEMO_REVEAL is not 0) but this build has no "${REVEAL_TESTID}" control in src/ui, so scene 9 has nothing to record. Land the reveal screen, or record the rest with BTQ_DEMO_REVEAL=0 npm run demo:live.`,
    );
  } else {
    checks.push({ name: 'reveal screen', ok: true, detail: 'scene 9 is off (BTQ_DEMO_REVEAL=0)' });
  }

  // -------------------------------------------------------------------- dist
  if (opts.checkDist) {
    try {
      assertDistFresh();
      checks.push({ name: 'dist fresh', ok: true, detail: 'dist/ is newer than src/' });
    } catch (e) {
      add(
        'dist fresh',
        false,
        e instanceof Error ? e.message : String(e),
        `demo:live — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return { ok: refusals.length === 0, checks, refusals };
}

/** The report as an operator reads it: one line per check, refusals last. */
export function formatPreflight(cfg: LiveConfig, report: PreflightReport): string {
  const lines = [`demo:live preflight — ${redactedSummary(cfg)}`, ''];
  for (const c of report.checks) {
    const mark = c.skipped ? '  ~' : c.ok ? '  ✓' : '  ✗';
    lines.push(`${mark} ${c.name.padEnd(26)} ${c.detail}`);
  }
  if (report.refusals.length > 0) {
    lines.push('', 'Refusing to record:');
    for (const r of report.refusals) lines.push(`  • ${r}`);
  } else {
    lines.push('', 'Ready to record.');
  }
  return lines.join('\n');
}

// --------------------------------------------------------------------- waiters

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * One confirmation, watched from both sides.
 *
 * The node is asked first, because it is the thing that will actually mine or
 * relay it. A node without `-txindex` forgets a transaction the moment it
 * leaves the mempool, so the explorer is the second opinion — either source
 * reporting a block is proof enough, and neither being able to answer is a
 * failure that names the txid and the URL a human can open.
 */
export async function waitForConfirmation(
  cfg: LiveConfig,
  txid: string,
  timeoutMs?: number,
): Promise<number> {
  const deadline = Date.now() + (timeoutMs ?? cfg.confirmTimeoutMs);
  let lastNote = 'no answer yet';
  while (Date.now() < deadline) {
    try {
      const tx = await nodeRpc<{ confirmations?: number }>(cfg, 'getrawtransaction', [txid, true]);
      const confirmations = Number(tx.confirmations ?? 0);
      if (confirmations >= 1) return confirmations;
      lastNote = 'in the mempool, not in a block yet';
    } catch (e) {
      lastNote = e instanceof Error ? e.message : String(e);
    }
    try {
      const { status, json } = await explorerGet(cfg, `/api/v1/tx/${txid}`);
      if (status === 200 && json && typeof json === 'object') {
        const height = (json as { block_height?: number | null }).block_height;
        if (typeof height === 'number') return 1;
      }
    } catch {
      /* the explorer is the second opinion; the node's answer already stands */
    }
    await sleep(5_000);
  }
  throw new Error(
    `${txid} did not reach one confirmation within ${Math.round((timeoutMs ?? cfg.confirmTimeoutMs) / 1000)}s (last: ${lastNote}). Open ${cfg.explorer}/tx/${txid} to see where it is.`,
  );
}

/** Wait until the public indexer has the transaction at all. */
export async function waitForExplorerTx(cfg: LiveConfig, txid: string, timeoutMs = 300_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let status = 0;
  while (Date.now() < deadline) {
    ({ status } = await explorerGet(cfg, `/api/v1/tx/${txid}`));
    if (status === 200) return;
    await sleep(5_000);
  }
  throw new Error(
    `the explorer has still not indexed ${txid} (last HTTP ${status}). Open ${cfg.explorer}/tx/${txid}.`,
  );
}

/**
 * Wait until the indexer shows the coin at an address.
 *
 * This runs with every page closed and *before* the receiving device launches,
 * so that device's scan can only ever find the right number — a clip of a
 * wallet showing zero because the indexer was a minute behind is a clip that
 * says the wallet is broken.
 */
export async function waitForExplorerUtxo(
  cfg: LiveConfig,
  address: string,
  txid: string,
  timeoutMs = 300_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const script = scriptForAddress(address, 'testnet');
  let seen = 'nothing';
  while (Date.now() < deadline) {
    const { status, json } = await explorerGet(cfg, `/api/v1/address/${address}/utxos`);
    const utxos = parseUtxoResponse(status, json, address, script);
    if (utxos.some((u) => u.txid === txid)) return;
    seen = `${utxos.length} unrelated utxo${utxos.length === 1 ? '' : 's'}`;
    await sleep(5_000);
  }
  throw new Error(
    `the explorer still does not list ${txid} among the coins at ${shortAddress(address)} (${seen}). Open ${cfg.explorer}/address/${address}.`,
  );
}

/**
 * The scan finished **and** the wallet stands behind the numbers.
 *
 * `waitForScan` alone is not enough live: a failed scan still flips `scanned`,
 * which enables `copy-address`, so the mocked suite's readiness signal is
 * satisfied by a wallet that is showing a stale balance next to a sync error.
 */
export async function waitForLiveScan(page: Page, timeout = 90_000): Promise<void> {
  await waitForScan(page, timeout);
  const sync = page.getByTestId('sync-error');
  if ((await sync.count()) > 0) {
    throw new Error(`the live scan did not finish: ${(await sync.first().innerText()).trim()}`);
  }
}

/**
 * The review card, or the reason there is not one.
 *
 * Mirrors `waitForSendResult`'s race: "not enough balance" arrives as an inline
 * error and no review card is ever built, so without this the failure is a
 * 20-second element-not-found instead of the sentence the popup already wrote.
 */
export async function waitForReview(page: Page, timeout = 30_000): Promise<void> {
  const review = page.getByTestId('review-fee');
  const failure = page.getByTestId('error');
  await expect
    .poll(
      async () => {
        if ((await review.count()) > 0) return 'review';
        if ((await failure.count()) > 0) return 'error';
        return 'waiting';
      },
      { timeout, message: 'the popup produced neither a review card nor an error' },
    )
    .not.toBe('waiting');
  if ((await review.count()) === 0) {
    throw new Error(`the wallet would not build this payment: ${(await failure.first().innerText()).trim()}`);
  }
}
