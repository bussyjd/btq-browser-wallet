import { useState } from 'react';
import { formatSats } from '../../core/wallet/format.js';
import { MAX_ACCOUNTS } from '../../core/wallet/storage.js';
import { shortAddress } from '../format.js';
import type { AccountInfo } from '../types.js';
import { Button } from './Button.js';
import { Field } from './Field.js';
import { InlineError } from './InlineError.js';
import { useAction } from '../hooks/useAction.js';

export function AccountSwitcher({
  accounts,
  activeAccount,
  onSwitch,
  onCreate,
  onRename,
  onClose,
}: {
  accounts: AccountInfo[];
  activeAccount: number;
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
                    <span className="account-row-bal">{formatSats(BigInt(a.lastBalanceSats || '0'))} tBTQ</span>
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
        </div>
        <InlineError message={create.error ?? switchTo.error ?? rename.error} />
      </div>
    </div>
  );
}
