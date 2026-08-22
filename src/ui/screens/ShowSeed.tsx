import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';

/**
 * The one and only time the phrase is on screen. No copy button: the clipboard
 * is readable by anything else running on this machine.
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
          <strong>Shown once.</strong> The wallet cannot display this phrase again. Keep this
          window open until you have finished — closing it discards these words and the next
          attempt generates a different seed.
        </p>
      </Card>
      <ol className="seed-grid">
        {words.map((w, i) => (
          <li key={i}>
            <span className="n">{i + 1}</span>
            <span data-testid={`seed-word-${i + 1}`}>{w}</span>
          </li>
        ))}
      </ol>
      <Button data-testid="seed-continue" onClick={onContinue}>
        I wrote it down
      </Button>
    </div>
  );
}
