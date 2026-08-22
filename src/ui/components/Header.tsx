import { Mark } from './Mark.js';

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" strokeLinecap="round" />
      <path d="M13.6 2.2v3.1h-3.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="3.2" y="7" width="9.6" height="6.6" rx="1.6" />
      <path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" strokeLinecap="round" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M2.2 4.8h11.6M2.2 11.2h11.6" strokeLinecap="round" />
      <circle cx="5.9" cy="4.8" r="2" fill="var(--bg-2)" />
      <circle cx="10.4" cy="11.2" r="2" fill="var(--bg-2)" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M9.8 3.2 5 8l4.8 4.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Header({
  networkLabel,
  onBack,
  onRefresh,
  refreshing,
  onLock,
  onSettings,
}: {
  networkLabel: string;
  onBack?: (() => void) | undefined;
  onRefresh?: (() => void) | undefined;
  refreshing?: boolean;
  onLock?: (() => void) | undefined;
  onSettings?: (() => void) | undefined;
}) {
  return (
    <header className="app-header">
      {onBack ? (
        <button
          type="button"
          className="icon-btn"
          aria-label="Back"
          data-testid="settings-back"
          onClick={onBack}
        >
          <BackIcon />
        </button>
      ) : null}
      <span className="brand">
        <Mark />
        <span className="wordmark">BTQ Wallet</span>
      </span>
      <span className="header-tools">
        <span className="pill" data-testid="network-pill">
          {networkLabel}
        </span>
        {onRefresh ? (
          <button
            type="button"
            className="icon-btn"
            aria-label="Refresh balance and history"
            data-testid="refresh"
            disabled={refreshing}
            onClick={onRefresh}
          >
            <span className={refreshing ? 'spin' : undefined} style={{ display: 'flex' }}>
              <RefreshIcon />
            </span>
          </button>
        ) : null}
        {onLock ? (
          <button
            type="button"
            className="icon-btn"
            aria-label="Lock wallet"
            data-testid="header-lock"
            onClick={onLock}
          >
            <LockIcon />
          </button>
        ) : null}
        {onSettings ? (
          <button
            type="button"
            className="icon-btn"
            aria-label="Settings"
            data-testid="gear"
            onClick={onSettings}
          >
            <SettingsIcon />
          </button>
        ) : null}
      </span>
    </header>
  );
}
