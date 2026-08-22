import { useState, type FormEvent } from 'react';
import { Button } from '../components/Button.js';
import { PasswordField } from '../components/Field.js';
import { InlineError } from '../components/InlineError.js';
import { useAction } from '../hooks/useAction.js';

export function CreatePassword({
  onSubmit,
  onBack,
}: {
  onSubmit: (password: string) => Promise<void>;
  onBack: () => void;
}) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const { busy, error, setError, run } = useAction();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (pw !== pw2) {
      setError('Passwords do not match.');
      return;
    }
    void run(() => onSubmit(pw));
  }

  return (
    <form className="stack" onSubmit={submit} aria-busy={busy}>
      <div>
        <h1>Set a password</h1>
        <p className="lede" style={{ marginBottom: 0 }}>
          The password seals the vault on this device. Nothing is stored until you confirm the
          seed on the next screens.
        </p>
      </div>
      <PasswordField
        id="pw"
        data-testid="pw"
        label="Password"
        autoComplete="new-password"
        autoFocus
        hint="At least 8 characters, no leading or trailing spaces."
        value={pw}
        onChange={(e) => setPw(e.target.value)}
      />
      <PasswordField
        id="pw2"
        data-testid="pw2"
        label="Confirm password"
        autoComplete="new-password"
        value={pw2}
        onChange={(e) => setPw2(e.target.value)}
      />
      <div className="stack-sm">
        <Button type="submit" data-testid="pw-continue" disabled={busy || pw.length < 8}>
          {busy ? 'Generating…' : 'Continue'}
        </Button>
        <Button variant="secondary" onClick={onBack} disabled={busy}>
          Back
        </Button>
      </div>
      <InlineError message={error} />
    </form>
  );
}
