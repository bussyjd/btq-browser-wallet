import { useCallback, useRef, useState } from 'react';
import { errorCode, rpc } from '../rpc.js';
import type {
  BackendInfo,
  BackendProbe,
  ConnectedSites,
  CreateReveal,
  HistoryEntry,
  MaxSpendable,
  PendingConnect,
  ReceiveInfo,
  ScanResult,
  SendPreview,
  SendResult,
  TipInfo,
  WalletStatus,
} from '../types.js';

export interface BackendDraft {
  explorerBase: string;
  nodeUrl: string;
  nodeUser: string;
  nodePassword: string;
}

/**
 * Every service-worker call the popup makes, in one place. Screens get data and
 * actions as props; none of them talk to `rpc()` directly, and none of them ever
 * sees key material — the worker only returns addresses, amounts and hex.
 */
export function useWallet() {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [receive, setReceive] = useState<ReceiveInfo | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [sites, setSites] = useState<string[]>([]);
  const [pendingOrigin, setPendingOrigin] = useState<string | null>(null);
  const [backend, setBackend] = useState<BackendInfo | null>(null);
  const [tip, setTip] = useState<TipInfo | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [addressMoved, setAddressMoved] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const refreshing = useRef(false);

  const loadStatus = useCallback(async () => {
    const st = await rpc<WalletStatus>('wallet.status');
    setStatus(st);
    return st;
  }, []);

  const loadBackend = useCallback(async () => {
    const b = await rpc<BackendInfo>('wallet.getBackend');
    setBackend(b);
    return b;
  }, []);

  const loadPending = useCallback(async () => {
    const p = await rpc<PendingConnect | null>('wallet.pendingConnect');
    const origin = p?.origin ?? null;
    setPendingOrigin(origin);
    return origin;
  }, []);

  const loadSites = useCallback(async () => {
    const c = await rpc<ConnectedSites>('wallet.connectedSites');
    setSites(c.origins);
    return c.origins;
  }, []);

  const refreshHistory = useCallback(async () => {
    const items = await rpc<HistoryEntry[]>('wallet.history');
    setHistory(items);
  }, []);

  /**
   * The single "bring everything up to date" pass: connected sites first (so a
   * waiting site is never hidden behind a slow scan), then the gap scan, then
   * history and the chain tip. `full` re-checks every address from index 0
   * instead of continuing from the stored cursor.
   */
  const refresh = useCallback(async (full = false) => {
    if (refreshing.current) return;
    refreshing.current = true;
    setScanning(true);
    setSyncError(null);
    setAddressMoved(false);
    try {
      const first = await rpc<ReceiveInfo>('wallet.receive');
      setReceive(first);
      try {
        await loadSites();
      } catch {
        /* connected sites are not worth failing a refresh over */
      }
      const scan = await rpc<ScanResult>('wallet.scan', full ? { full: true } : undefined);
      setStatus((s) => (s ? { ...s, ...scan, hasVault: true, unlocked: true } : s));
      const next = await rpc<ReceiveInfo>('wallet.receive');
      if (next.index !== first.index) {
        setReceive(next);
        setAddressMoved(true);
      }
      try {
        await refreshHistory();
      } catch {
        /* history is best-effort; the balance is the load-bearing number */
      }
      try {
        setTip(await rpc<TipInfo>('wallet.tip'));
      } catch {
        setTip(null);
      }
      setScanned(true);
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : 'Could not reach the explorer.');
      setScanned(true);
    } finally {
      setScanning(false);
      refreshing.current = false;
    }
  }, [loadSites, refreshHistory]);

  const create = useCallback(
    (password: string) => rpc<CreateReveal>('wallet.create', { password }),
    [],
  );

  const confirmSeed = useCallback(
    async (answers: { index: number; word: string }[], password: string) => {
      await rpc('wallet.confirm', { answers, password });
    },
    [],
  );

  const importMnemonic = useCallback(async (mnemonic: string, password: string) => {
    await rpc('wallet.importMnemonic', { mnemonic, password });
  }, []);

  const importSeed = useCallback(async (seedHex: string, password: string) => {
    await rpc('wallet.importSeed', { seedHex, password });
  }, []);

  const unlock = useCallback(async (password: string) => {
    await rpc('wallet.unlock', { password });
  }, []);

  const lock = useCallback(async () => {
    await rpc('wallet.lock');
    setReceive(null);
    setHistory([]);
    setScanned(false);
    setStatus((s) => (s ? { ...s, unlocked: false } : s));
  }, []);

  const wipe = useCallback(async (confirmation: string) => {
    await rpc('wallet.wipe', { confirmation });
    setStatus(null);
    setReceive(null);
    setHistory([]);
    setSites([]);
    setTip(null);
    setScanned(false);
    setPendingOrigin(null);
  }, []);

  const prepareSend = useCallback(
    (destination: string, amountSats: string, feeRateSatPerKvB: number) =>
      rpc<SendPreview>('wallet.prepareSend', { destination, amountSats, feeRateSatPerKvB }),
    [],
  );

  const confirmSend = useCallback(
    (destination: string, amountSats: string, password: string, feeRateSatPerKvB: number) =>
      rpc<SendResult>('wallet.confirmSend', {
        destination,
        amountSats,
        password,
        feeRateSatPerKvB,
      }),
    [],
  );

  const maxSpendable = useCallback(async (feeRateSatPerKvB: number) => {
    try {
      return await rpc<MaxSpendable>('wallet.maxSpendable', { feeRateSatPerKvB });
    } catch (e) {
      if (errorCode(e) === 'UNKNOWN_METHOD') {
        throw new Error('This background version cannot compute a maximum yet. Enter an amount instead.', {
          cause: e,
        });
      }
      throw e;
    }
  }, []);

  const approveConnect = useCallback(async (origin: string) => {
    await rpc('wallet.approveConnect', { origin });
    setPendingOrigin(null);
    try {
      await loadSites();
    } catch {
      /* the approval already succeeded */
    }
  }, [loadSites]);

  const denyConnect = useCallback(async () => {
    await rpc('wallet.denyConnect');
    setPendingOrigin(null);
  }, []);

  const revokeSite = useCallback(async (origin: string) => {
    await rpc('wallet.revokeSite', { origin });
    setSites((s) => s.filter((o) => o !== origin));
  }, []);

  const saveBackend = useCallback(async (draft: BackendDraft) => {
    const saved = await rpc<BackendInfo>('wallet.setBackend', draft);
    setBackend(saved);
    return saved;
  }, []);

  const testBackend = useCallback(
    (draft: BackendDraft) => rpc<BackendProbe>('wallet.testBackend', draft),
    [],
  );

  return {
    status,
    receive,
    history,
    sites,
    pendingOrigin,
    backend,
    tip,
    scanning,
    scanned,
    addressMoved,
    syncError,
    setStatus,
    setPendingOrigin,
    loadStatus,
    loadBackend,
    loadPending,
    loadSites,
    refresh,
    refreshHistory,
    create,
    confirmSeed,
    importMnemonic,
    importSeed,
    unlock,
    lock,
    wipe,
    prepareSend,
    confirmSend,
    maxSpendable,
    approveConnect,
    denyConnect,
    revokeSite,
    saveBackend,
    testBackend,
  };
}

export type Wallet = ReturnType<typeof useWallet>;
