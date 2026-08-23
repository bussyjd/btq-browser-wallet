import { useState, type FormEvent } from 'react';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { Field, PasswordField } from '../components/Field.js';
import { InlineError } from '../components/InlineError.js';
import { useAction } from '../hooks/useAction.js';
import { errMessage, errorCode } from '../rpc.js';

/**
 * Type DELETE, then the wallet is gone. Written once and rendered from two
 * places: the "forgot your password" escape, and the vault this build can no
 * longer open — where it is not an escape but the only way on.
 */
function RemoveWallet({
  lede,
  onWipe,
  onCancel,
}: {
  lede: string;
  onWipe: (confirmation: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const [confirmation, setConfirmation] = useState('');
  const wipeAction = useAction();

  return (
    <>
      <p className="small">{lede}</p>
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
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel}>
            Keep the wallet
          </Button>
        ) : null}
        <InlineError message={wipeAction.error} testId="wipe-error" />
      </form>
    </>
  );
}

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
  /**
   * The vault opened and turned out to predate this build's format. Kept as its
   * own state rather than as the form's error string: under the password field
   * it would read as "wrong password", which is the one thing it is not — the
   * password was right, and typing it again will do exactly this again.
   */
  const [tooOld, setTooOld] = useState<string | null>(null);
  const unlockAction = useAction();

  function submit(e: FormEvent) {
    e.preventDefault();
    void unlockAction.run(async () => {
      try {
        await onUnlock(pw);
        setPw('');
      } catch (e) {
        if (errorCode(e) !== 'VAULT_TOO_OLD') throw e;
        // The worker's own copy, not a second version of it written here.
        setTooOld(errMessage(e));
        setPw('');
      }
    });
  }

  if (tooOld) {
    return (
      <div className="stack">
        <div>
          <h1>Wallet from an older build</h1>
          <p className="lede" style={{ marginBottom: 0 }}>
            Your password was correct. The vault behind it was written by a build of this
            extension that this one cannot read.
          </p>
        </div>
        <Card tone="warn">
          <p className="card-title">Remove this wallet and import it again</p>
          <p className="small" role="alert" data-testid="unlock-too-old">
            {tooOld}
          </p>
          <RemoveWallet
            lede="Removing the vault deletes it from this device. Your coins are on the chain, not in it: the phrase or seed you wrote down brings them back on the import screen."
            onWipe={onWipe}
          />
        </Card>
      </div>
    );
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
            <RemoveWallet
              lede="There is no password recovery. Removing the vault deletes it from this device — you can only get the coins back by importing the seed phrase again."
              onWipe={onWipe}
              onCancel={() => setShowWipe(false)}
            />
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
