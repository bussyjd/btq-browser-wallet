import { useCallback, useEffect, useRef, useState } from 'react';
import { AccountSwitcher } from './components/AccountSwitcher.js';
import { Button } from './components/Button.js';
import { Header } from './components/Header.js';
import { InlineError } from './components/InlineError.js';
import { Toast } from './components/Toast.js';
import type { HomeTab } from './components/TabBar.js';
import { useWallet } from './hooks/useWallet.js';
import { errMessage, onAutoLock } from './rpc.js';
import type { SendResult, WalletStatus } from './types.js';
import { ConfirmSeed } from './screens/ConfirmSeed.js';
import { ConnectApproval } from './screens/ConnectApproval.js';
import { Home } from './screens/Home.js';
import { Onboarding } from './screens/Onboarding.js';
import { Settings } from './screens/Settings.js';
import { Unlock } from './screens/Unlock.js';

type Screen =
  | 'boot'
  | 'onboard-tab'
  | 'onboarding'
  | 'unlock'
  /**
   * The phrase-confirmation gate, reached when the popup comes back to a wallet
   * that is sealed but not yet confirmed — the user closed the window mid-setup,
   * or the browser restarted. `onboarding` covers the same step while the words
   * are still on screen; this one has to ask for the password, because it has
   * neither the words nor the password any more.
   */
  | 'confirm'
  | 'home'
  | 'settings'
  | 'connect';

const params = new URLSearchParams(window.location.search);
const WANT_CONNECT = params.get('connect') === '1';
const IS_ONBOARD_TAB = params.get('onboard') === '1';
const ONBOARD_TAB_FLAG = 'onboardTabOpened';

/**
 * The site this window was opened to answer for.
 *
 * The worker puts the origin in the URL when it opens an approval window, so
 * the window renders and approves the site that actually asked — never
 * "whichever request is outstanding by the time the popup has loaded". Two
 * sites racing each other get one window each, each bound to its own origin.
 */
const WINDOW_ORIGIN = ((raw: string | null) =>
  raw !== null && /^https?:\/\/[^/\s]+$/.test(raw) ? raw : null)(params.get('origin'));

/**
 * Does this wallet still owe a phrase confirmation?
 *
 * Optional in the status because an older worker never sends it, and absent has
 * to read as "no" rather than "maybe": the gate is a screen of empty word
 * fields, and showing it over a wallet with nothing outstanding would strand the
 * user behind three boxes nothing can satisfy. Both halves are required for the
 * same reason — a flag with no positions behind it is not a challenge.
 */
function awaitingConfirm(status: WalletStatus | null): boolean {
  return status?.awaitingConfirm === true && (status.confirmChallenge?.length ?? 0) > 0;
}

/** The action popup closes on any outside click, which would discard a shown seed. */
async function isActionPopup(): Promise<boolean> {
  try {
    if (typeof chrome?.tabs?.getCurrent !== 'function') return false;
    const tab = await chrome.tabs.getCurrent();
    return !tab;
  } catch {
    return false;
  }
}

/**
 * Move a fresh setup into a full tab, at most once per browser session — if
 * anything about that is unavailable we stay in the popup rather than risk
 * spawning a tab on every open.
 */
async function claimOnboardingTab(): Promise<boolean> {
  if (IS_ONBOARD_TAB || WANT_CONNECT) return false;
  if (!(await isActionPopup())) return false;
  try {
    const seen = await chrome.storage.session.get(ONBOARD_TAB_FLAG);
    if (seen[ONBOARD_TAB_FLAG]) return false;
    await chrome.storage.session.set({ [ONBOARD_TAB_FLAG]: true });
    return true;
  } catch {
    return false;
  }
}

export function App() {
  const wallet = useWallet();
  const [screen, setScreen] = useState<Screen>('boot');
  const [tab, setTab] = useState<HomeTab>('receive');
  const [sendResult, setSendResult] = useState<SendResult | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [lockNote, setLockNote] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [returnTo, setReturnTo] = useState<Screen | null>(null);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const screenRef = useRef<Screen>('boot');
  // The auto-lock handler below is registered once and fires from an RPC
  // response, always after a commit — so tracking the screen in an effect is
  // enough, and writing a ref during render is not allowed.
  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((t) => (t === message ? null : t)), 1600);
  }, []);

  // Auto-lock can fire while the popup is open; move to Unlock instead of
  // leaving a dead screen behind, and remember where to come back to.
  useEffect(() => {
    onAutoLock(() => {
      const from = screenRef.current;
      if (from === 'unlock' || from === 'onboarding' || from === 'boot') return;
      // Close the switcher on the way out, exactly as the Lock button does.
      // The overlay is only *hidden* while the screen is 'unlock' (the render
      // guard below reads `screen === 'home'`), and `afterAuth` puts the screen
      // back to 'home' — so without this the first thing on screen after
      // re-typing the password is a modal listing every account and address.
      setAccountsOpen(false);
      setReturnTo(from === 'settings' ? 'settings' : 'home');
      setLockNote('Locked after inactivity.');
      setScreen('unlock');
    });
    return () => onAutoLock(null);
  }, []);

  /**
   * Where the popup goes once the vault is open: a waiting site first — it is
   * on a five-minute clock and the user is not — then an unconfirmed phrase,
   * then wherever they were.
   */
  const afterAuth = useCallback(async (status: WalletStatus | null) => {
    let pending: string | null = null;
    try {
      pending = await wallet.loadPending();
    } catch {
      /* no pending request is the normal case */
    }
    // The status is passed in, never read off `wallet` here: this callback was
    // created in the render *before* the unlock, so the hook state it closes
    // over is the locked one — and a locked status carries no challenge, which
    // would route every unlock straight past the confirmation gate.
    const awaiting = awaitingConfirm(status);
    setScreen(
      WANT_CONNECT || pending
        ? 'connect'
        : awaiting
          ? 'confirm'
          : returnTo === 'settings'
            ? 'settings'
            : 'home',
    );
    setReturnTo(null);
    if (!awaiting) void wallet.refresh();
  }, [returnTo, wallet]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const st = await wallet.loadStatus();
        if (cancelled) return;
        try {
          await wallet.loadBackend();
        } catch {
          /* first paint can proceed with the worker's defaults */
        }
        if (cancelled) return;
        if (!st.hasVault) {
          if (await claimOnboardingTab()) {
            try {
              await chrome.tabs.create({
                url: chrome.runtime.getURL('src/ui/index.html?onboard=1'),
              });
              if (!cancelled) setScreen('onboard-tab');
              return;
            } catch {
              /* no tab? finish setup in the popup instead */
            }
          }
          if (!cancelled) setScreen('onboarding');
          return;
        }
        if (!st.unlocked) {
          if (!cancelled) setScreen('unlock');
          return;
        }
        let pending: string | null = null;
        try {
          pending = await wallet.loadPending();
        } catch {
          /* ignore */
        }
        if (cancelled) return;
        // A sealed-but-unconfirmed wallet lands here whenever setup was
        // interrupted: the popup closed while the words were on screen, or the
        // browser restarted before the challenge was answered. The wallet is
        // real and the coins are safe; what is missing is the proof that the
        // phrase was written down, so ask for it rather than opening Home over
        // the top of it.
        if (awaitingConfirm(st) && !WANT_CONNECT && !pending) {
          setScreen('confirm');
          return;
        }
        setScreen(WANT_CONNECT || pending ? 'connect' : 'home');
        void wallet.refresh();
      } catch (e) {
        if (!cancelled) {
          setBootError(errMessage(e));
          setScreen('onboarding');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Runs once on mount; the wallet hook's callbacks are stable.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A parked connect request lives in the service worker's memory, and Chrome
  // ends an idle worker after roughly thirty seconds — so an approval window can
  // outlive the very request it was opened for. Re-asking while this screen is
  // up is how the window finds out: the moment the worker stops holding it,
  // `connectOrigin` goes null and the screen says the request is gone instead of
  // offering a Connect button that can only fail. The call is also what keeps a
  // worker awake while the user is reading the prompt, but the screen does not
  // depend on that — losing the request is handled, not prevented.
  const loadPending = wallet.loadPending;
  useEffect(() => {
    if (screen !== 'connect') return;
    const id = window.setInterval(() => {
      void loadPending().catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(id);
  }, [screen, loadPending]);

  /** The approval window exists only to answer one request. */
  function finishConnect() {
    if (WANT_CONNECT) {
      window.close();
      return;
    }
    setScreen('home');
  }

  const confirmChallenge = wallet.status?.confirmChallenge ?? [];
  const unlocked = Boolean(wallet.status?.unlocked);
  const showHeaderTools = unlocked && (screen === 'home' || screen === 'connect');
  // The account everything on screen is about — the header's name, and the one
  // a connect approval is granted for. Empty while locked: `status.accounts`
  // carries names and addresses and is empty then, deliberately.
  const activeAccountName =
    (wallet.status?.accounts ?? []).find((a) => a.index === (wallet.status?.activeAccount ?? 0))?.name ??
    'Account 1';
  // A dedicated approval window answers for its own site and nothing else — and
  // only while the worker is still holding that request. The URL alone is not
  // enough: this window outlives the worker that opened it, and a parked
  // response does not, so rendering from `?origin=` would offer a Connect button
  // for a request that no longer exists. The worker's answer is the authority in
  // both windows; the URL only narrows it.
  const connectOrigin =
    WANT_CONNECT && WINDOW_ORIGIN
      ? wallet.pendingOrigin === WINDOW_ORIGIN
        ? WINDOW_ORIGIN
        : null
      : wallet.pendingOrigin;

  function screenBody() {
    switch (screen) {
      case 'boot':
        return <p className="lede">Opening the vault…</p>;

      case 'onboard-tab':
        return (
          <div className="stack">
            <h1>Setup opened in a tab</h1>
            <p className="lede">
              This popup closes as soon as you click anywhere else, which would discard a seed
              phrase mid-way. Finish setup in the tab that just opened.
            </p>
            <Button variant="secondary" onClick={() => setScreen('onboarding')}>
              Continue here instead
            </Button>
          </div>
        );

      case 'onboarding':
        return (
          <Onboarding
            wallet={wallet}
            onDone={async () => {
              await wallet.loadStatus();
              setTab('receive');
              setScreen('home');
              void wallet.refresh();
            }}
          />
        );

      case 'unlock':
        return (
          <Unlock
            note={lockNote}
            onUnlock={async (password) => {
              await wallet.unlock(password);
              const st = await wallet.loadStatus();
              setLockNote(null);
              await afterAuth(st);
            }}
            onWipe={async (confirmation) => {
              await wallet.wipe(confirmation);
              setAccountsOpen(false);
              setSendResult(null);
              setLockNote(null);
              setScreen('onboarding');
            }}
          />
        );

      case 'confirm':
        return confirmChallenge.length > 0 ? (
          <ConfirmSeed
            challenge={confirmChallenge}
            password={null}
            onSubmit={async (answers, password) => {
              await wallet.confirmSeed(answers, password);
              await wallet.loadStatus();
              setTab('receive');
              setScreen('home');
              void wallet.refresh();
            }}
            onLeave={async () => {
              await wallet.dismissConfirm();
              await wallet.loadStatus();
              setTab('receive');
              setScreen('home');
              void wallet.refresh();
            }}
          />
        ) : null;

      case 'connect':
        return connectOrigin ? (
          <ConnectApproval
            origin={connectOrigin}
            address={wallet.receive?.address ?? null}
            accountName={activeAccountName}
            onApprove={async () => {
              await wallet.approveConnect(connectOrigin);
              finishConnect();
            }}
            onDeny={async () => {
              await wallet.denyConnect(connectOrigin);
              finishConnect();
            }}
          />
        ) : (
          <div className="stack">
            <h1>Nothing left to approve</h1>
            <p className="lede" data-testid="connect-gone">
              The site gave up, the request timed out, or the wallet's background worker restarted
              while this window was open — it holds a waiting request in memory and nothing else,
              so a restart loses it rather than granting it. Nothing was approved; ask the site to
              connect again.
            </p>
            <Button variant="secondary" onClick={finishConnect}>
              {WANT_CONNECT ? 'Close this window' : 'Go to the wallet'}
            </Button>
          </div>
        );

      default:
        return null;
    }
  }

  return (
    <div className="app">
      <Header
        networkLabel={`Testnet${wallet.backend?.nodeUrl ? ' · node' : ''}`}
        accountName={showHeaderTools ? activeAccountName : undefined}
        onOpenAccounts={
          screen === 'home'
            ? () => {
                setAccountsOpen(true);
                // Opening the panel is what refreshes the accounts that are not
                // active: a routine refresh scans only the account on screen,
                // so this is the moment the other rows stop being historical.
                void wallet.refreshAccounts();
              }
            : undefined
        }
        onBack={screen === 'settings' ? () => setScreen('home') : undefined}
        onRefresh={showHeaderTools ? () => void wallet.refresh() : undefined}
        refreshing={wallet.scanning}
        onLock={
          showHeaderTools
            ? () =>
                void (async () => {
                  setAccountsOpen(false);
                  await wallet.lock();
                  setSendResult(null);
                  setScreen('unlock');
                })()
            : undefined
        }
        onSettings={
          showHeaderTools
            ? () => {
                setAccountsOpen(false);
                setScreen('settings');
              }
            : undefined
        }
      />

      {screen === 'home' ? (
        <Home
          key={wallet.status?.activeAccount ?? 0}
          wallet={wallet}
          tab={tab}
          onTab={setTab}
          sendResult={sendResult}
          onSendResult={setSendResult}
          onToast={showToast}
          onOpenSettings={() => setScreen('settings')}
        />
      ) : screen === 'settings' ? (
        <Settings
          wallet={wallet}
          onToast={showToast}
          onLocked={() => {
            setAccountsOpen(false);
            setSendResult(null);
            setScreen('unlock');
          }}
          onWiped={() => {
            // A new wallet's switcher must not open onto the old wallet's list.
            setAccountsOpen(false);
            setSendResult(null);
            setScreen('onboarding');
          }}
        />
      ) : (
        <main className="app-body">
          <InlineError message={bootError} testId="boot-error" />
          {screenBody()}
        </main>
      )}

      {accountsOpen && screen === 'home' ? (
        <AccountSwitcher
          accounts={wallet.status?.accounts ?? []}
          activeAccount={wallet.status?.activeAccount ?? 0}
          checking={wallet.accountsScanning}
          onSwitch={async (index) => {
            setSendResult(null);
            await wallet.switchAccount(index);
          }}
          onCreate={async () => {
            setSendResult(null);
            await wallet.createAccount();
          }}
          onRename={(index, name) => wallet.renameAccount(index, name)}
          onClose={() => setAccountsOpen(false)}
        />
      ) : null}

      <Toast message={toast} />
    </div>
  );
}
