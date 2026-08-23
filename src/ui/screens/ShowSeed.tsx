import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { SeedGrid } from '../components/SeedGrid.js';

/**
 * The phrase, during onboarding, before the vault exists.
 *
 * Nothing is persisted at this point: the words live in the parent's state and
 * are gone if the popup closes, so this screen is genuinely the last chance to
 * write down *this* seed. It is no longer the last chance ever to see a phrase
 * — once the vault is sealed, Settings → Security shows it again behind the
 * password. Saying so here is what stops people photographing the screen.
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
          <strong>Write them down now.</strong> Nothing is saved until you confirm — close this
          window and these words are gone, and the next attempt generates a different seed. Once
          the vault is sealed you can read the phrase back under <strong>Settings → Security</strong>,
          with your password.
        </p>
      </Card>
      <SeedGrid words={words} />
      <Button data-testid="seed-continue" onClick={onContinue}>
        I wrote it down
      </Button>
    </div>
  );
}
