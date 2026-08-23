import { useState } from 'react';
import { formatSats } from '../../core/wallet/format.js';
import { MAX_ACCOUNTS } from '../../core/wallet/storage.js';
import { relativeTime, shortAddress } from '../format.js';
import type { AccountInfo } from '../types.js';
import { Button } from './Button.js';
import { Field } from './Field.js';
import { InlineError } from './InlineError.js';
import { useAction } from '../hooks/useAction.js';

/**
 * The account list.
 *
 * The balances here are not all equally fresh, and the panel says so. A routine
 * refresh scans the *active* account only — walking every account on every
 * refresh meant ~40 explorer lookups per account whether or not anything had
 * changed — so opening this panel is what brings the others up to date
 * (`checking`), and until that lands each inactive row carries the age of the
 * number it is showing. A figure with no date on it reads as current; that is
 * the one thing a balance must never do when it is not.
 */
export function AccountSwitcher({
  accounts,
  activeAccount,
  checking = false,
  onSwitch,
  onCreate,
  onRename,
  onClose,
}: {
  accounts: AccountInfo[];
  activeAccount: number;
  /** True while the open-the-panel refresh of the other accounts is in flight. */
  checking?: boolean;
  onSwitch: (index: number) => Promise<void>;
  onCreate: () => Promise<void>;
  onRename: (index: number, name: string) => Promise<void>;
  onClose: () => void;
}) {
  const create = useAction();
  const switchTo = useAction();
  const rename = useAction();
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  // The panel says the one thing a user has to act on; the reasoning behind it
  // is real and stays available, but it is not made compulsory reading for
  // somebody who opened this to switch account. See CLAUDE.md, "Copy budget".
  const [showWhy, setShowWhy] = useState(false);
  const busy = create.busy || switchTo.busy || rename.busy;

  return (
    <div className="account-overlay" role="dialog" aria-label="Accounts" data-testid="account-list">
      <button type="button" className="account-overlay-dismiss" aria-label="Close accounts" onClick={onClose} />
      <div className="account-panel">
        <p className="label" style={{ padding: '12px 12px 8px' }}>
          Accounts
        </p>
        <ul className="account-rows">
          {accounts.map((a) => {
            const active = a.index === activeAccount;
            return (
              <li key={a.index}>
                {editing === a.index ? (
                  <form
                    className="account-rename"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void rename.run(async () => {
                        await onRename(a.index, draft);
                        setEditing(null);
                      });
                    }}
                  >
                    <Field
                      label="Name"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      data-testid="account-name"
                      autoFocus
                      maxLength={32}
                    />
                    <div className="account-rename-actions">
                      <Button small type="submit" disabled={busy || !draft.trim()}>
                        Save
                      </Button>
                      <Button
                        small
                        variant="secondary"
                        disabled={busy}
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : (
                  <button
                    type="button"
                    className={active ? 'account-row is-active' : 'account-row'}
                    data-testid={`account-row-${a.index}`}
                    disabled={busy}
                    onClick={() => {
                      if (active) return;
                      void switchTo.run(async () => {
                        await onSwitch(a.index);
                        onClose();
                      });
                    }}
                  >
                    <span className="account-row-main">
                      <span className="account-row-name">{a.name}</span>
                      <span className="account-row-addr">
                        {a.address ? shortAddress(a.address) : 'Deriving…'}
                      </span>
                    </span>
                    <span className="account-row-bal">
                      <span className={active ? undefined : 'is-stale'}>
                        {formatSats(BigInt(a.lastBalanceSats || '0'))} tBTQ
                      </span>
                      {/* The active row is the one the refresh just scanned, so
                          it needs no date. Every other row is showing whatever
                          the last pass that included it found, and has to say
                          when that was. */}
                      {active ? null : (
                        <span className="account-row-age" data-testid={`account-age-${a.index}`}>
                          {checking
                            ? 'Checking…'
                            : a.balanceAt
                              ? `Checked ${relativeTime(a.balanceAt)}`
                              : 'Not checked yet'}
                        </span>
                      )}
                    </span>
                  </button>
                )}
                {active && editing !== a.index ? (
                  <button
                    type="button"
                    className="account-rename-btn"
                    data-testid="account-rename"
                    disabled={busy}
                    onClick={() => {
                      setEditing(a.index);
                      setDraft(a.name);
                    }}
                  >
                    Rename
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
        <div className="account-add">
          <Button
            variant="secondary"
            data-testid="account-add"
            disabled={busy || accounts.length >= MAX_ACCOUNTS}
            onClick={() =>
              void create.run(async () => {
                await onCreate();
                onClose();
              })
            }
          >
            Add account
          </Button>
          {/* Said here, where the decision is made, and not only in the docs —
              but as the one sentence that changes what the user does next. Why
              it is true (btq-core's hardcoded `0'`, what a phrase can and
              cannot carry, and why this wallet will not ask an explorer) is a
              paragraph, and a paragraph belongs behind the disclosure. */}
          <p className="small" data-testid="account-note">
            Only Account 1 restores from your recovery phrase. Back up your wallet file to keep
            the others.
          </p>
          <button
            type="button"
            className="disclosure"
            data-testid="toggle-account-why"
            aria-expanded={showWhy}
            aria-controls="account-why-panel"
            onClick={() => setShowWhy((open) => !open)}
          >
            <span className="disclosure-caret" aria-hidden="true">
              {showWhy ? '▾' : '▸'}
            </span>
            Why?
          </button>
          {showWhy ? (
            <p id="account-why-panel" className="small" data-testid="account-why">
              btq-core hardcodes the account level to 0&rsquo; (scriptpubkeyman.cpp:1252), so
              Account 1 is the only account it can derive from this seed. The others are this
              wallet&rsquo;s own convention, and the seed does not record how many you made — a
              phrase carries entropy and says nothing about what was done with it. The backup
              file carries the list, and restores your accounts and their names exactly. Without
              one, restoring is exact but manual: press Add account the same number of times, in
              order, and the same seed re-derives the same addresses, so the coins reappear.
              Write down how many you made. This wallet will not ask a public explorer to guess,
              because that hands a third party a batch of your unused addresses and ties them
              together in its logs.
            </p>
          ) : null}
        </div>
        <InlineError message={create.error ?? switchTo.error ?? rename.error} />
      </div>
    </div>
  );
}
