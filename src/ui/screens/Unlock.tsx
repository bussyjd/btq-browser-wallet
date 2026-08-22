import { useState, type FormEvent } from 'react';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { Field, PasswordField } from '../components/Field.js';
import { InlineError } from '../components/InlineError.js';
import { useAction } from '../hooks/useAction.js';

export function Unlock({
  note,
  onUnlock,
  onWipe,
}: {
  note?: string | null;
  onUnlock: (password: string) => Promise<void>;
  onWipe: (confirmation: string) => Promise<void>;
}) {
  const [pw, setPw] = useState('');
  const [showWipe, setShowWipe] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const unlockAction = useAction();
  const wipeAction = useAction();

  function submit(e: FormEvent) {
    e.preventDefault();
    void unlockAction.run(async () => {
      await onUnlock(pw);
      setPw('');
    });
  }

  return (
    <div className="stack">
      <form className="stack" onSubmit={submit} aria-busy={unlockAction.busy}>
        <div>
          <h1>Unlock</h1>
          <p className="lede" style={{ marginBottom: 0 }}>
            The vault is sealed. Keys decrypt only for this session, only inside the extension.
          </p>
        </div>
        {note ? (
          <p className="note" role="status">
            {note}
          </p>
        ) : null}
        <PasswordField
          id="unlock-pw"
          data-testid="unlock-pw"
          label="Password"
          autoComplete="current-password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        <Button type="submit" data-testid="unlock-submit" disabled={unlockAction.busy}>
          {unlockAction.busy ? 'Unlocking…' : 'Unlock'}
        </Button>
        <InlineError message={unlockAction.error} />
      </form>

      <div className="mt-8">
        {showWipe ? (
          <Card tone="warn">
            <p className="card-title">Remove this wallet</p>
            <p className="small">
              There is no password recovery. Removing the vault deletes it from this device — you
              can only get the coins back by importing the seed phrase again.
            </p>
            <form
              className="stack-sm mt-8"
              onSubmit={(e) => {
                e.preventDefault();
                void wipeAction.run(() => onWipe(confirmation));
              }}
            >
              <Field
                id="wipe-input"
                data-testid="wipe-input"
                label="Type DELETE to confirm"
                placeholder="DELETE"
                autoComplete="off"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
              />
              <Button
                type="submit"
                variant="danger"
                data-testid="wipe-confirm"
                disabled={wipeAction.busy || confirmation !== 'DELETE'}
              >
                Remove wallet
              </Button>
              <Button variant="secondary" onClick={() => setShowWipe(false)}>
                Keep the wallet
              </Button>
              <InlineError message={wipeAction.error} testId="wipe-error" />
            </form>
          </Card>
        ) : (
          <button type="button" className="btn btn-link" onClick={() => setShowWipe(true)}>
            Forgot your password?
          </button>
        )}
      </div>
    </div>
  );
}
