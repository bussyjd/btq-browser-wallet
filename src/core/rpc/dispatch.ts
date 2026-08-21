import { WalletError } from '../wallet/errors.js';
import type { Keyring } from '../wallet/keyring.js';
import type { AddressLookup } from '../wallet/gap.js';
import type { ExplorerUtxo } from '../explorer/utxo.js';
import type { HistoryItem } from '../explorer/history.js';
import { PAGE_METHOD_SET } from '../connect/permissions.js';
import { WALLET_METHOD_SET, type RpcRequest } from './protocol.js';
import type { BackendPublic } from '../network/backend.js';

export interface DispatchContext {
  /** True when the sender is a web tab/page, not an extension page. */
  fromTab: boolean;
  /** Exact page origin from the runtime sender — never from params. */
  pageOrigin?: string;
  lookup?: AddressLookup;
  fetchUtxos?: (address: string) => Promise<ExplorerUtxo[]>;
  fetchHistory?: (address: string) => Promise<HistoryItem[]>;
  broadcast?: (hex: string) => Promise<{ txid: string }>;
  getBackend?: () => Promise<BackendPublic>;
  setBackend?: (input: {
    explorerBase?: string;
    nodeUrl?: string;
    nodeUser?: string;
    nodePassword?: string;
  }) => Promise<BackendPublic>;
  testBackend?: (input: {
    explorerBase?: string;
    nodeUrl?: string;
    nodeUser?: string;
    nodePassword?: string;
  }) => Promise<{ explorer: string; node?: { chain: string; blocks: number } }>;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new WalletError('BAD_PASSWORD', `Missing ${name}.`);
  return v;
}

function sats(v: unknown): bigint {
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw new WalletError('DUST', 'Amount must be a satoshi integer string.');
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
      const scan = await keyring.scan(ctx.lookup);
      return {
        externalNext: scan.external.nextIndex,
        internalNext: scan.internal.nextIndex,
        usedExternal: scan.external.used.length,
        usedInternal: scan.internal.used.length,
        lastBalanceSats: scan.totalBalanceSats.toString(),
      };
    }
    case 'wallet.wipe':
      await keyring.wipe(str(p.confirmation, 'confirmation'));
      return { ok: true as const };
    case 'wallet.prepareSend': {
      if (!ctx.fetchUtxos) throw new WalletError('EXPLORER_UNAVAILABLE', 'Explorer is not configured.');
      return keyring.prepareSend({
        destination: str(p.destination, 'destination'),
        amountSats: sats(p.amountSats),
        fetchUtxos: ctx.fetchUtxos,
        feeRateSatPerKvB: typeof p.feeRateSatPerKvB === 'number' ? p.feeRateSatPerKvB : undefined,
      });
    }
    case 'wallet.confirmSend': {
      if (!ctx.fetchUtxos || !ctx.broadcast) throw new WalletError('EXPLORER_UNAVAILABLE', 'Explorer is not configured.');
      return keyring.confirmSend({
        destination: str(p.destination, 'destination'),
        amountSats: sats(p.amountSats),
        password: str(p.password, 'password'),
        fetchUtxos: ctx.fetchUtxos,
        broadcast: ctx.broadcast,
        feeRateSatPerKvB: typeof p.feeRateSatPerKvB === 'number' ? p.feeRateSatPerKvB : undefined,
      });
    }
    case 'wallet.history': {
      if (!ctx.fetchHistory) throw new WalletError('EXPLORER_UNAVAILABLE', 'Explorer is not configured.');
      const items = await keyring.listHistory(ctx.fetchHistory);
      return items.map((h) => ({
        txid: h.txid,
        blockHeight: h.blockHeight,
        valueChange: h.valueChange.toString(),
        status: h.status,
      }));
    }
    case 'wallet.activity':
      return keyring.listActivity();
    case 'wallet.pendingConnect':
      return keyring.pendingConnect();
    case 'wallet.approveConnect':
      return keyring.approveConnect(str(p.origin, 'origin'));
    case 'wallet.denyConnect':
      await keyring.denyConnect();
      return { ok: true as const };
    case 'wallet.connectedSites':
      return { origins: await keyring.connectedSites() };
    case 'wallet.revokeSite':
      await keyring.revokeSite(str(p.origin, 'origin'));
      return { ok: true as const };
    case 'wallet.getBackend':
      if (!ctx.getBackend) throw new WalletError('BAD_BACKEND', 'Backend settings are not available.');
      return ctx.getBackend();
    case 'wallet.setBackend':
      if (!ctx.setBackend) throw new WalletError('BAD_BACKEND', 'Backend settings are not available.');
      return ctx.setBackend({
        explorerBase: typeof p.explorerBase === 'string' ? p.explorerBase : undefined,
        nodeUrl: typeof p.nodeUrl === 'string' ? p.nodeUrl : undefined,
        nodeUser: typeof p.nodeUser === 'string' ? p.nodeUser : undefined,
        nodePassword: typeof p.nodePassword === 'string' ? p.nodePassword : undefined,
      });
    case 'wallet.testBackend':
      if (!ctx.testBackend) throw new WalletError('BAD_BACKEND', 'Backend settings are not available.');
      return ctx.testBackend({
        explorerBase: typeof p.explorerBase === 'string' ? p.explorerBase : undefined,
        nodeUrl: typeof p.nodeUrl === 'string' ? p.nodeUrl : undefined,
        nodeUser: typeof p.nodeUser === 'string' ? p.nodeUser : undefined,
        nodePassword: typeof p.nodePassword === 'string' ? p.nodePassword : undefined,
      });
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
      await keyring.disconnectOrigin(origin);
      return { ok: true as const };
    default:
      throw new WalletError('FORBIDDEN', 'This method is not available to pages.');
  }
}
