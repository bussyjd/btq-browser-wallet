import { WalletError } from '../wallet/errors.js';
import type { Broadcast, ChainTip, FetchHistory, FetchUtxos, Keyring } from '../wallet/keyring.js';
import type { AddressLookup } from '../wallet/gap.js';
import { PAGE_METHOD_SET } from '../connect/permissions.js';
import { WALLET_METHOD_SET, type RpcRequest } from './protocol.js';
import type { BackendPublic } from '../network/backend.js';

export interface BackendInput {
  explorerBase?: string;
  nodeUrl?: string;
  nodeUser?: string;
  nodePassword?: string;
}

export interface BackendProbe {
  explorer: string;
  explorerTip?: number;
  node?: { chain: string; blocks: number; bestblockhash?: string };
  warning?: string;
}

export interface DispatchContext {
  /** True when the sender is a web tab/page, not an extension page. */
  fromTab: boolean;
  /** Exact page origin from the runtime sender — never from params. */
  pageOrigin?: string;
  lookup?: AddressLookup;
  fetchUtxos?: FetchUtxos;
  fetchHistory?: FetchHistory;
  /** Chain tip for confirmations; cached by the caller. Optional: null ⇒ no counts. */
  fetchTip?: () => Promise<ChainTip>;
  broadcast?: Broadcast;
  getBackend?: () => Promise<BackendPublic>;
  setBackend?: (input: BackendInput) => Promise<BackendPublic>;
  testBackend?: (input: BackendInput) => Promise<BackendProbe>;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

/** A missing parameter is a caller bug, not a wrong password. */
function str(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new WalletError('BAD_PARAMS', `Missing ${name}.`);
  return v;
}

function sats(v: unknown): bigint {
  if (typeof v === 'string' && /^\d{1,20}$/.test(v)) return BigInt(v);
  throw new WalletError('BAD_PARAMS', 'Amount must be a satoshi integer string.');
}

function nat(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new WalletError('BAD_PARAMS', `Missing ${name}.`);
  }
  return v;
}

function feeRate(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new WalletError('BAD_FEE_RATE', 'Fee rate must be a whole number of sat/kvB.');
  }
  return v;
}

function backendInput(p: Record<string, unknown>): BackendInput {
  return {
    explorerBase: typeof p.explorerBase === 'string' ? p.explorerBase : undefined,
    nodeUrl: typeof p.nodeUrl === 'string' ? p.nodeUrl : undefined,
    nodeUser: typeof p.nodeUser === 'string' ? p.nodeUser : undefined,
    nodePassword: typeof p.nodePassword === 'string' ? p.nodePassword : undefined,
  };
}

/** The tip, or null when the backend cannot give one — never a thrown refresh. */
async function tipOrNull(ctx: DispatchContext): Promise<ChainTip | null> {
  if (!ctx.fetchTip) return null;
  try {
    return await ctx.fetchTip();
  } catch {
    return null;
  }
}

export async function dispatch(keyring: Keyring, request: RpcRequest, ctx: DispatchContext): Promise<unknown> {
  const method = request.method;
  if (ctx.fromTab) {
    if (!PAGE_METHOD_SET.has(method)) {
      throw new WalletError('FORBIDDEN', 'This method is not available to pages.');
    }
    const origin = ctx.pageOrigin;
    if (!origin) throw new WalletError('FORBIDDEN', 'This method is not available to pages.');
    return dispatchPage(keyring, method, origin);
  }
  if (PAGE_METHOD_SET.has(method)) {
    throw new WalletError('FORBIDDEN', 'Page methods are not callable from the popup.');
  }
  if (!WALLET_METHOD_SET.has(method)) {
    throw new WalletError('UNKNOWN_METHOD', `Unknown method: ${method}`);
  }
  const p = asRecord(request.params);

  switch (method) {
    case 'wallet.status':
      return keyring.status();
    case 'wallet.create':
      return keyring.create(str(p.password, 'password'));
    case 'wallet.confirm': {
      const answers = p.answers;
      if (!Array.isArray(answers)) throw new WalletError('CONFIRM_MISMATCH', 'Those words do not match the seed.');
      return keyring
        .confirm(
          answers.map((a) => {
            const rec = asRecord(a);
            if (typeof rec.index !== 'number' || !Number.isInteger(rec.index) || typeof rec.word !== 'string') {
              throw new WalletError('CONFIRM_MISMATCH', 'Those words do not match the seed.');
            }
            return { index: rec.index, word: rec.word };
          }),
          str(p.password, 'password'),
        )
        .then(() => ({ ok: true as const }));
    }
    case 'wallet.importMnemonic':
      await keyring.importMnemonic(str(p.mnemonic, 'mnemonic'), str(p.password, 'password'));
      return { ok: true as const };
    case 'wallet.importSeed':
      await keyring.importSeed(str(p.seedHex, 'seedHex'), str(p.password, 'password'));
      return { ok: true as const };
    case 'wallet.unlock':
      await keyring.unlock(str(p.password, 'password'));
      return { ok: true as const };
    case 'wallet.lock':
      keyring.lock();
      return { ok: true as const };
    case 'wallet.receive':
      return keyring.receiveAddress();
    case 'wallet.scan': {
      if (!ctx.lookup) throw new WalletError('EXPLORER_UNAVAILABLE', 'Explorer is not configured.');
      const scan = await keyring.scan(ctx.lookup, ctx.fetchUtxos, await tipOrNull(ctx), {
        full: p.full === true,
      });
      return {
        externalNext: scan.external.nextIndex,
        internalNext: scan.internal.nextIndex,
        usedExternal: scan.usedExternal,
        usedInternal: scan.usedInternal,
        lastBalanceSats: scan.totalBalanceSats.toString(),
        confirmedBalanceSats: scan.confirmedBalanceSats.toString(),
        tipHeight: scan.tipHeight,
        lastScanAt: scan.lastScanAt,
      };
    }
    case 'wallet.tip': {
      if (!ctx.fetchTip) throw new WalletError('EXPLORER_UNAVAILABLE', 'Explorer is not configured.');
      return ctx.fetchTip();
    }
    case 'wallet.wipe':
      await keyring.wipe(str(p.confirmation, 'confirmation'));
      return { ok: true as const };
    case 'wallet.revealPhrase':
      // The keyring re-proves the password against the sealed vault and shares
      // the unlock back-off; a missing one is BAD_PARAMS before it is touched.
      return keyring.revealPhrase(str(p.password, 'password'));
    case 'wallet.revealSeedHex':
      // Same door, same password, same back-off — the backup for a wallet that
      // has no phrase to show. Unreachable from a page: `fromTab` was refused
      // at the top of this function, before the switch.
      return keyring.revealSeedHex(str(p.password, 'password'));
    case 'wallet.maxSpendable': {
      if (!ctx.fetchUtxos) throw new WalletError('EXPLORER_UNAVAILABLE', 'Explorer is not configured.');
      return keyring.maxSpendable({
        fetchUtxos: ctx.fetchUtxos,
        feeRateSatPerKvB: feeRate(p.feeRateSatPerKvB),
      });
    }
    case 'wallet.prepareSend': {
      if (!ctx.fetchUtxos) throw new WalletError('EXPLORER_UNAVAILABLE', 'Explorer is not configured.');
      return keyring.prepareSend({
        destination: str(p.destination, 'destination'),
        amountSats: sats(p.amountSats),
        fetchUtxos: ctx.fetchUtxos,
        feeRateSatPerKvB: feeRate(p.feeRateSatPerKvB),
      });
    }
    case 'wallet.confirmSend': {
      if (!ctx.fetchUtxos || !ctx.broadcast) {
        throw new WalletError('EXPLORER_UNAVAILABLE', 'Explorer is not configured.');
      }
      const result = await keyring.confirmSend({
        destination: str(p.destination, 'destination'),
        amountSats: sats(p.amountSats),
        password: str(p.password, 'password'),
        fetchUtxos: ctx.fetchUtxos,
        broadcast: ctx.broadcast,
        feeRateSatPerKvB: feeRate(p.feeRateSatPerKvB),
      });
      // `decoded` carries Uint8Array-free plain data but is large; the popup
      // only needs the summary fields plus the hex it may have to copy out.
      const { decoded: _decoded, ...wire } = result;
      return wire;
    }
    case 'wallet.history': {
      if (!ctx.fetchHistory) throw new WalletError('EXPLORER_UNAVAILABLE', 'Explorer is not configured.');
      const items = await keyring.listHistory(ctx.fetchHistory, await tipOrNull(ctx));
      return items.map((h) => ({
        txid: h.txid,
        blockHeight: h.blockHeight,
        valueChange: h.valueChange.toString(),
        status: h.status,
        confirmations: h.confirmations ?? null,
        ...(h.at === undefined ? {} : { at: h.at }),
      }));
    }
    case 'wallet.activity':
      return keyring.listActivity();
    case 'wallet.pendingConnect':
      return keyring.pendingConnect();
    case 'wallet.approveConnect':
      return keyring.approveConnect(str(p.origin, 'origin'));
    case 'wallet.denyConnect':
      // The origin is optional on the wire: an approval window is already bound
      // to one by its own URL, which the worker trusts over any parameter. When
      // a caller does name an origin it is validated here, and the worker
      // settles that request and no other.
      await keyring.denyConnect(typeof p.origin === 'string' ? p.origin : undefined);
      return { ok: true as const };
    case 'wallet.createAccount':
      return keyring.createAccount();
    case 'wallet.switchAccount':
      return keyring.switchAccount(nat(p.index, 'index'));
    case 'wallet.renameAccount':
      return keyring.renameAccount(nat(p.index, 'index'), str(p.name, 'name'));
    case 'wallet.connectedSites': {
      // `sites` is the real answer — one row per (origin, account) approval.
      // `origins` stays beside it as the flat list of sites with any grant at
      // all, so a popup older than this worker keeps rendering something true.
      const sites = await keyring.connectedSites();
      return { origins: [...new Set(sites.map((s) => s.origin))], sites };
    }
    case 'wallet.revokeSite':
      // No account named means the whole site, every account — what the page's
      // own `disconnect` means. Settings names one, and revokes that row only.
      await keyring.revokeSite(
        str(p.origin, 'origin'),
        p.account === undefined ? undefined : nat(p.account, 'account'),
      );
      return { ok: true as const };
    case 'wallet.getBackend':
      if (!ctx.getBackend) throw new WalletError('BAD_BACKEND', 'Backend settings are not available.');
      return ctx.getBackend();
    case 'wallet.setBackend':
      if (!ctx.setBackend) throw new WalletError('BAD_BACKEND', 'Backend settings are not available.');
      return ctx.setBackend(backendInput(p));
    case 'wallet.testBackend':
      if (!ctx.testBackend) throw new WalletError('BAD_BACKEND', 'Backend settings are not available.');
      return ctx.testBackend(backendInput(p));
    default:
      throw new WalletError('UNKNOWN_METHOD', `Unknown method: ${method}`);
  }
}

async function dispatchPage(keyring: Keyring, method: string, origin: string): Promise<unknown> {
  switch (method) {
    case 'page.requestAccounts':
      return keyring.requestAccounts(origin);
    case 'page.getAccounts':
      return keyring.getAccounts(origin);
    case 'page.disconnect':
      await keyring.revokeSite(origin);
      return { ok: true as const };
    default:
      throw new WalletError('FORBIDDEN', 'This method is not available to pages.');
  }
}
