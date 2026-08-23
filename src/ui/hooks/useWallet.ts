import { useCallback, useRef, useState } from 'react';
import { errorCode, rpc } from '../rpc.js';
import type {
  BackendInfo,
  BackendProbe,
  BackupFile,
  BackupRestore,
  ConnectedSites,
  CreateReveal,
  HistoryEntry,
  MaxSpendable,
  PendingConnect,
  PhraseReveal,
  ReceiveInfo,
  ScanResult,
  SeedReveal,
  SendPreview,
  SendResult,
  SiteGrant,
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
 * actions as props and none of them talk to `rpc()` directly.
 *
 * Three calls return secret material and only those three: `create`, the
 * onboarding reveal, `revealPhrase`, the re-display behind the password, and
 * `revealSeedHex`, the same re-display for a wallet that has no phrase. All
 * three hand the result straight back to the caller and put nothing into this
 * hook's state, so the secret lives in one screen's component state and dies
 * when it unmounts. Every other call returns addresses, amounts and hex.
 *
 * `exportBackup` is deliberately not a fourth: what it returns is the sealed
 * `BTQ1` envelope, not key material, which is the whole reason it may become a
 * file. It follows the same hand-it-back rule anyway — it is the entire wallet
 * in one object, and one copy in one screen beats a copy that outlives it.
 */
export function useWallet() {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [receive, setReceive] = useState<ReceiveInfo | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [sites, setSites] = useState<SiteGrant[]>([]);
  const [pendingOrigin, setPendingOrigin] = useState<string | null>(null);
  const [backend, setBackend] = useState<BackendInfo | null>(null);
  const [tip, setTip] = useState<TipInfo | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [addressMoved, setAddressMoved] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [accountsScanning, setAccountsScanning] = useState(false);
  const refreshing = useRef(false);
  const accountsRefreshing = useRef(false);

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
    // A worker that predates per-account grants sends origins only; every one
    // of its grants was account 0, because that was the only account there was.
    const rows = c.sites ?? c.origins.map((origin) => ({ origin, account: 0 }));
    setSites(rows);
    return rows;
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
      await rpc<ScanResult>('wallet.scan', full ? { full: true } : undefined);
      // Full status after scan — not a field-wise merge. Spreading the scan
      // onto the last status left `canRevealPhrase` however it happened to
      // be before the refresh, and Settings gates the phrase button on it.
      await loadStatus();
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
  }, [loadSites, refreshHistory, loadStatus]);

  /**
   * Bring the *other* accounts up to date — the switcher opening is the moment
   * their balances go on screen, and the only routine moment they do.
   *
   * `refresh` deliberately scans the active account alone: walking every known
   * account on every refresh sent one gap window per chain per account to a
   * public explorer whether or not anything had changed. This is the explicit,
   * user-initiated pass that fills the rest in; while it is in flight the panel
   * says "Checking…", and if it fails the stored balances stay on screen with
   * their age next to them, which is the honest thing to show.
   */
  const refreshAccounts = useCallback(async () => {
    if (accountsRefreshing.current) return;
    accountsRefreshing.current = true;
    setAccountsScanning(true);
    try {
      await rpc<ScanResult>('wallet.scan', { accounts: 'all' });
      await loadStatus();
    } catch {
      /* the rows keep the balances they had, dated — never a blank or a zero */
    } finally {
      setAccountsScanning(false);
      accountsRefreshing.current = false;
    }
  }, [loadStatus]);

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

  /**
   * Leave the confirmation challenge without passing it. Clears the outstanding
   * challenge and claims nothing about whether the phrase was written down — the
   * vault was sealed at create time and is unaffected either way.
   */
  const dismissConfirm = useCallback(async () => {
    await rpc('wallet.dismissConfirm');
  }, []);

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
    // Drop the account rows with it: they carry an address and the user's own
    // name for it, and the worker stops answering with them the moment it
    // locks. The popup must not go on rendering what the worker withdrew.
    setStatus((s) => (s ? { ...s, unlocked: false, accounts: [] } : s));
  }, []);

  /**
   * The recovery phrase for the open vault, after the password is re-typed.
   *
   * The one call in this file that deliberately does not `setState` its result:
   * putting the words in hook state would keep them alive across every screen
   * for as long as the popup is open, and survive leaving Settings. The caller
   * owns them and drops them on unmount.
   */
  const revealPhrase = useCallback(
    (password: string) => rpc<PhraseReveal>('wallet.revealPhrase', { password }),
    [],
  );

  /**
   * The HD seed hex, for the wallets that have no phrase to show. Same rule as
   * `revealPhrase` and for the same reason: the result is key material, so it
   * is handed straight back to the caller and never lands in this hook's state.
   */
  const revealSeedHex = useCallback(
    (password: string) => rpc<SeedReveal>('wallet.revealSeedHex', { password }),
    [],
  );

  /**
   * The wallet backup file, after the password is re-typed on an open vault.
   *
   * Handed straight back to the caller and never put in this hook's state, for
   * the same reason the two reveals are — one screen owns it and it dies with
   * that screen. The reason is different in kind, though, and worth being exact
   * about: this is *not* key material. It is the `BTQ1` envelope, sealed under
   * the password, which is precisely why it is allowed to become a file when
   * the phrase and the seed are not. It is still the whole wallet in one
   * object, so fewer copies of it is better than more.
   */
  const exportBackup = useCallback(
    (password: string) => rpc<BackupFile>('wallet.exportBackup', { password }),
    [],
  );

  /**
   * Restore from a backup file, on a device with no wallet yet.
   *
   * The one restore that costs the explorer nothing: the accounts and their
   * names come out of the file, so nothing here asks a third party anything.
   * The refresh that follows is the ordinary one, over the active account.
   */
  const importBackup = useCallback(
    (backupHex: string, password: string) =>
      rpc<BackupRestore>('wallet.importBackup', { backupHex, password }),
    [],
  );

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

  /**
   * Cancel one waiting request — the one the screen is showing, named.
   *
   * A dedicated approval window is bound to its own origin by its URL, so the
   * worker could infer the target there. The toolbar popup is not: it renders
   * whichever request is still live, and with two sites waiting the worker
   * refuses to guess (settling the wrong one would reject a site the user never
   * looked at). Sending no origin from there made Cancel settle nothing at all.
   */
  const denyConnect = useCallback(async (origin?: string) => {
    await rpc('wallet.denyConnect', origin ? { origin } : undefined);
    setPendingOrigin(null);
  }, []);

  /**
   * Revoke one row — one site's grant on one account. Without an account it is
   * the whole site, which is what the page's own disconnect does.
   */
  const revokeSite = useCallback(async (origin: string, account?: number) => {
    await rpc('wallet.revokeSite', account === undefined ? { origin } : { origin, account });
    setSites((s) =>
      s.filter((g) => g.origin !== origin || (account !== undefined && g.account !== account)),
    );
  }, []);

  const createAccount = useCallback(async () => {
    const created = await rpc<{ index: number; name: string; address: string }>('wallet.createAccount');
    setReceive(null);
    setHistory([]);
    setScanned(false);
    await loadStatus();
    await refresh();
    return created;
  }, [loadStatus, refresh]);

  const switchAccount = useCallback(
    async (index: number) => {
      await rpc('wallet.switchAccount', { index });
      setReceive(null);
      setHistory([]);
      setScanned(false);
      await loadStatus();
      await refresh();
    },
    [loadStatus, refresh],
  );

  const renameAccount = useCallback(
    async (index: number, name: string) => {
      await rpc('wallet.renameAccount', { index, name });
      await loadStatus();
    },
    [loadStatus],
  );

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
    accountsScanning,
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
    refreshAccounts,
    refreshHistory,
    create,
    confirmSeed,
    dismissConfirm,
    importMnemonic,
    importSeed,
    importBackup,
    unlock,
    lock,
    revealPhrase,
    revealSeedHex,
    exportBackup,
    wipe,
    prepareSend,
    confirmSend,
    maxSpendable,
    approveConnect,
    denyConnect,
    revokeSite,
    saveBackend,
    testBackend,
    createAccount,
    switchAccount,
    renameAccount,
  };
}

export type Wallet = ReturnType<typeof useWallet>;
