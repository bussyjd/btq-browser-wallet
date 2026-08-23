import { useState, type FormEvent } from 'react';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { Field, PasswordField } from '../components/Field.js';
import { InlineError } from '../components/InlineError.js';
import { useAction } from '../hooks/useAction.js';

/**
 * The phrase-confirmation gate, in front of a wallet that already exists.
 *
 * `challenge` holds 0-based positions in the phrase. The label and the
 * `confirm-word-N` test id both use the 1-based word number the user sees.
 *
 * Two ways onto this screen, and `password` is the difference. Straight out of
 * create, the onboarding flow still holds the password the user just chose, so
 * the screen asks for words alone. Reopened later — the popup closed on a blur,
 * the browser restarted, the background worker recycled — it holds nothing, and
 * asks for the password too: the answers are checked by regenerating the words
 * from the sealed vault, and only the password opens that.
 *
 * The reopened case is also the one that gets a way out. The wallet is already
 * the user's — sealed, spendable, and readable at Settings → Security — and a
 * gate with no exit is how people end up photographing their phrase to get past
 * it.
 */
export function ConfirmSeed({
  challenge,
  password,
  onSubmit,
  onBack,
  onLeave,
}: {
  challenge: number[];
  /** The password from this session's create, or null when it must be re-typed. */
  password: string | null;
  onSubmit: (answers: { index: number; word: string }[], password: string) => Promise<void>;
  /** Back to the words — offered only while they are still on screen. */
  onBack?: () => void;
  /** Leave without confirming. Offered only once the words are gone. */
  onLeave?: () => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [typedPassword, setTypedPassword] = useState('');
  const seal = useAction();
  const leave = useAction();
  const resumed = password === null;
  const busy = seal.busy || leave.busy;

  function submit(e: FormEvent) {
    e.preventDefault();
    void seal.run(() =>
      onSubmit(
        challenge.map((index) => ({ index, word: answers[index] ?? '' })),
        password ?? typedPassword,
      ),
    );
  }

  return (
    <form className="stack" onSubmit={submit} aria-busy={busy}>
      <div>
        <h1>Confirm the phrase</h1>
        <p className="lede" style={{ marginBottom: 0 }}>
          Type the words we ask for to prove you wrote the phrase down.
        </p>
      </div>
      {resumed ? (
        <Card tone="quiet" data-testid="confirm-resumed">
          <p className="small">
            Your wallet is already created and sealed — this only checks your copy of the phrase.
            If it is not in front of you, finish later: <strong>Settings → Security</strong> shows
            the phrase again with your password.
          </p>
        </Card>
      ) : null}
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
      {resumed ? (
        <PasswordField
          id="confirm-pw"
          data-testid="confirm-pw"
          label="Password"
          hint="The words are read back out of your vault, and only your password opens it."
          autoComplete="current-password"
          value={typedPassword}
          onChange={(e) => setTypedPassword(e.target.value)}
        />
      ) : null}
      <div className="stack-sm">
        <Button type="submit" data-testid="confirm-seal" disabled={busy}>
          {seal.busy ? 'Checking…' : 'Confirm the phrase'}
        </Button>
        {onBack ? (
          <Button variant="secondary" onClick={onBack} disabled={busy}>
            Back to the words
          </Button>
        ) : null}
        {onLeave ? (
          <Button
            variant="secondary"
            data-testid="confirm-leave"
            disabled={busy}
            onClick={() => void leave.run(onLeave)}
          >
            {leave.busy ? 'Leaving…' : 'Finish this later'}
          </Button>
        ) : null}
      </div>
      <InlineError message={seal.error ?? leave.error} />
    </form>
  );
}
