import { useState, type FormEvent } from 'react';
import { Button } from '../components/Button.js';
import { Field } from '../components/Field.js';
import { InlineError } from '../components/InlineError.js';
import { useAction } from '../hooks/useAction.js';

/**
 * `challenge` holds 0-based positions in the phrase. The label and the
 * `confirm-word-N` test id both use the 1-based word number the user sees.
 */
export function ConfirmSeed({
  challenge,
  onSubmit,
  onBack,
}: {
  challenge: number[];
  onSubmit: (answers: { index: number; word: string }[]) => Promise<void>;
  onBack: () => void;
}) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const { busy, error, run } = useAction();

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(() => onSubmit(challenge.map((index) => ({ index, word: answers[index] ?? '' }))));
  }

  return (
    <form className="stack" onSubmit={submit} aria-busy={busy}>
      <div>
        <h1>Confirm the phrase</h1>
        <p className="lede" style={{ marginBottom: 0 }}>
          Type the words we ask for to prove you wrote the phrase down.
        </p>
      </div>
      {challenge.map((index, i) => (
        <Field
          key={index}
          id={`confirm-word-${index + 1}`}
          data-testid={`confirm-word-${index + 1}`}
          data-word={index + 1}
          label={`Word ${index + 1}`}
          mono
          autoFocus={i === 0}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          value={answers[index] ?? ''}
          onChange={(e) => setAnswers((a) => ({ ...a, [index]: e.target.value }))}
        />
      ))}
      <div className="stack-sm">
        <Button type="submit" data-testid="confirm-seal" disabled={busy}>
          {busy ? 'Sealing…' : 'Seal the vault'}
        </Button>
        <Button variant="secondary" onClick={onBack} disabled={busy}>
          Back to the words
        </Button>
      </div>
      <InlineError message={error} />
    </form>
  );
}
