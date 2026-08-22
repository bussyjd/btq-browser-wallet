import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';

export function ImportChoice({
  onMnemonic,
  onRaw,
  onBack,
}: {
  onMnemonic: () => void;
  onRaw: () => void;
  onBack: () => void;
}) {
  return (
    <div className="stack">
      <div>
        <h1>Import a wallet</h1>
        <p className="lede" style={{ marginBottom: 0 }}>
          A seed phrase and a raw BTQ HD seed are different wallets, even from the same entropy.
          Pick the form you actually have.
        </p>
      </div>
      <Card>
        <p className="card-title">Seed phrase</p>
        <p className="small">12 or 24 BIP39 words, from this wallet or another BTQ HD wallet.</p>
        <div className="mt-8">
          <Button data-testid="import-mnemonic" onClick={onMnemonic}>
            Use a seed phrase
          </Button>
        </div>
      </Card>
      <Card>
        <p className="card-title">Raw BTQ HD seed</p>
        <p className="small">
          64 hexadecimal characters — the 32 bytes btq-core&rsquo;s <code>sethdseed</code> takes.
        </p>
        <div className="mt-8">
          <Button variant="secondary" data-testid="import-raw" onClick={onRaw}>
            Use a raw seed
          </Button>
        </div>
      </Card>
      <Button variant="secondary" onClick={onBack}>
        Back
      </Button>
    </div>
  );
}
