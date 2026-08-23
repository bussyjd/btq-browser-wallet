import { useCallback, useEffect, useRef, useState } from 'react';
import { AccountSwitcher } from './components/AccountSwitcher.js';
import { Button } from './components/Button.js';
import { Header } from './components/Header.js';
import { InlineError } from './components/InlineError.js';
import { Toast } from './components/Toast.js';
import type { HomeTab } from './components/TabBar.js';
import { useWallet } from './hooks/useWallet.js';
import { errMessage, onAutoLock } from './rpc.js';
import type { SendResult } from './types.js';
import { ConnectApproval } from './screens/ConnectApproval.js';
import { Home } from './screens/Home.js';
import { Onboarding } from './screens/Onboarding.js';
import { Settings } from './screens/Settings.js';
import { Unlock } from './screens/Unlock.js';

type Screen = 'boot' | 'onboard-tab' | 'onboarding' | 'unlock' | 'home' | 'settings' | 'connect';

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
  const [seedNotice, setSeedNotice] = useState<string | null>(null);
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
      setReturnTo(from === 'settings' ? 'settings' : 'home');
      setLockNote('Locked after inactivity.');
      setScreen('unlock');
    });
    return () => onAutoLock(null);
  }, []);

  /** Where the popup goes once the vault is open: a waiting site first, else back. */
  const afterAuth = useCallback(async () => {
    let pending: string | null = null;
    try {
      pending = await wallet.loadPending();
    } catch {
      /* no pending request is the normal case */
    }
    setScreen(WANT_CONNECT || pending ? 'connect' : returnTo === 'settings' ? 'settings' : 'home');
    setReturnTo(null);
    void wallet.refresh();
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
          if (st.pendingReveal) setSeedNotice('The previous seed was discarded — start again.');
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

  /** The approval window exists only to answer one request. */
  function finishConnect() {
    if (WANT_CONNECT) {
      window.close();
      return;
    }
    setScreen('home');
  }

  const unlocked = Boolean(wallet.status?.unlocked);
  const showHeaderTools = unlocked && (screen === 'home' || screen === 'connect');
  // A dedicated approval window answers for its own site and nothing else; the
  // toolbar popup shows whatever the worker still has a live caller for.
  const connectOrigin = WANT_CONNECT ? (WINDOW_ORIGIN ?? wallet.pendingOrigin) : wallet.pendingOrigin;

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
            notice={seedNotice}
            onDone={async () => {
              setSeedNotice(null);
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
              await wallet.loadStatus();
              setLockNote(null);
              await afterAuth();
            }}
            onWipe={async (confirmation) => {
              await wallet.wipe(confirmation);
              setSendResult(null);
              setLockNote(null);
              setScreen('onboarding');
            }}
          />
        );

      case 'connect':
        return connectOrigin ? (
          <ConnectApproval
            origin={connectOrigin}
            address={wallet.receive?.address ?? null}
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
            <h1>No request waiting</h1>
            <p className="lede">The site either cancelled or the request already timed out.</p>
            <Button variant="secondary" onClick={() => setScreen('home')}>
              Go to the wallet
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
        accountName={
          showHeaderTools
            ? (wallet.status?.accounts ?? []).find((a) => a.index === (wallet.status?.activeAccount ?? 0))?.name ??
              'Account 1'
            : undefined
        }
        onOpenAccounts={screen === 'home' ? () => setAccountsOpen(true) : undefined}
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
            setSendResult(null);
            setScreen('unlock');
          }}
          onWiped={() => {
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
