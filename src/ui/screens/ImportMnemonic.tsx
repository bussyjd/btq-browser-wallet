import { useState, type FormEvent } from 'react';
import { Button } from '../components/Button.js';
import { PasswordField, TextAreaField } from '../components/Field.js';
import { InlineError } from '../components/InlineError.js';
import { useAction } from '../hooks/useAction.js';

export function ImportMnemonic({
  onSubmit,
  onBack,
}: {
  onSubmit: (text: string, password: string) => Promise<void>;
  onBack: () => void;
}) {
  const [text, setText] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const { busy, error, setError, run } = useAction();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (pw !== pw2) {
      setError('Passwords do not match.');
      return;
    }
    void run(() => onSubmit(text, pw));
  }

  return (
    <form className="stack" onSubmit={submit} aria-busy={busy}>
      <div>
        <h1>Seed phrase</h1>
        <p className="lede" style={{ marginBottom: 0 }}>
          Paste or type the words separated by spaces. They never leave this device.
        </p>
      </div>
      <TextAreaField
        id="import-text"
        data-testid="import-text"
        label="BIP39 words"
        rows={4}
        mono
        autoFocus
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder="word one word two …"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <PasswordField
        id="pw"
        data-testid="pw"
        label="Password to seal the vault"
        autoComplete="new-password"
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
        <Button type="submit" data-testid="import-submit" disabled={busy || pw.length < 8}>
          {busy ? 'Importing…' : 'Import'}
        </Button>
        <Button variant="secondary" onClick={onBack} disabled={busy}>
          Back
        </Button>
      </div>
      <InlineError message={error} />
    </form>
  );
}
