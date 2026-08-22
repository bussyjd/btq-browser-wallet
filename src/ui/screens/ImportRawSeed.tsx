import { useState, type FormEvent } from 'react';
import { Button } from '../components/Button.js';
import { Field, PasswordField } from '../components/Field.js';
import { InlineError } from '../components/InlineError.js';
import { useAction } from '../hooks/useAction.js';

export function ImportRawSeed({
  onSubmit,
  onBack,
}: {
  onSubmit: (hex: string, password: string) => Promise<void>;
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

  const trimmed = text.trim();
  const lenNote =
    trimmed.length > 0 && trimmed.length !== 64
      ? { ok: false, text: `${trimmed.length} characters — a raw HD seed is exactly 64 hex characters.` }
      : null;

  return (
    <form className="stack" onSubmit={submit} aria-busy={busy}>
      <div>
        <h1>Raw HD seed</h1>
        <p className="lede" style={{ marginBottom: 0 }}>
          64 hexadecimal characters — the 32 bytes btq-core&rsquo;s <code>sethdseed</code> takes.
        </p>
      </div>
      <Field
        id="import-text"
        data-testid="import-text"
        label="Seed hex"
        mono
        autoFocus
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        placeholder="64 hex characters"
        note={lenNote}
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
