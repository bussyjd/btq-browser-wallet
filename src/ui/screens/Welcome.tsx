import { Button } from '../components/Button.js';
import { Mark } from '../components/Mark.js';

export function Welcome({
  onCreate,
  onImport,
  notice,
}: {
  onCreate: () => void;
  onImport: () => void;
  notice?: string | null;
}) {
  return (
    <div className="stack">
      <Mark size={44} />
      <div>
        <h1>Hold your own quantum-safe keys.</h1>
        <p className="lede" style={{ marginBottom: 0 }}>
          A Bitcoin Quantum testnet wallet. Your seed and keys stay inside this extension —
          coins here are not mainnet money.
        </p>
      </div>
      {notice ? (
        <p className="note note-warn" role="status">
          {notice}
        </p>
      ) : null}
      <div className="stack-sm mt-8">
        <Button data-testid="welcome-create" onClick={onCreate}>
          Create a wallet
        </Button>
        <Button variant="secondary" data-testid="welcome-import" onClick={onImport}>
          I already have a seed
        </Button>
      </div>
      <p className="hint mt-16">Bitcoin Quantum testnet · ML-DSA-44 · P2MR</p>
    </div>
  );
}
