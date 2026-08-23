import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { SeedGrid } from '../components/SeedGrid.js';

/**
 * The phrase, during onboarding, on a vault that is already sealed.
 *
 * The wallet exists by the time this paints — `create` seals it with the
 * password the user has just chosen, precisely so that this screen can be read
 * at human speed. Writing twelve words down takes longer than Chrome leaves an
 * idle background worker alive, and the old flow held the phrase in that worker
 * until the confirmation came back: the careful user was the one who lost it.
 *
 * So the copy here says what is now true. Closing the window does not discard
 * anything, this is not the last chance ever to see these words, and Settings →
 * Security shows them again behind the password. Saying that plainly is what
 * stops people photographing the screen.
 */
export function ShowSeed({ words, onContinue }: { words: string[]; onContinue: () => void }) {
  return (
    <div className="stack">
      <div>
        <h1>Write these words down</h1>
        <p className="lede" style={{ marginBottom: 0 }}>
          Twelve words, in this order. Anyone who has them owns the wallet.
        </p>
      </div>
      <Card tone="warn">
        <p className="small">
          <strong>Write them down now, on paper.</strong> Your wallet is already sealed under the
          password you chose, and these twelve words are the only thing that restores it on
          another device. Nobody can send them to you again — not us, not anyone. If you are
          interrupted, they are waiting under <strong>Settings → Security</strong>, behind your
          password.
        </p>
      </Card>
      <SeedGrid words={words} />
      <Button data-testid="seed-continue" onClick={onContinue}>
        I wrote it down
      </Button>
    </div>
  );
}
