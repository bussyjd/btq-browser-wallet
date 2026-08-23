import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';

export function ImportChoice({
  onMnemonic,
  onRaw,
  onBackupFile,
  onBack,
}: {
  onMnemonic: () => void;
  onRaw: () => void;
  onBackupFile: () => void;
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
        {/* Said here, on the screen where somebody is about to rely on it, and
            not only in the docs. A phrase is an encoding of entropy: it says
            what the master secret is and nothing about what was done with it,
            so the account list is not in there and cannot be put there. */}
        <p className="small" data-testid="import-phrase-note">
          A phrase restores <strong>Account 1</strong>, because that is all a phrase can
          carry. Accounts you added come back with <strong>Add account</strong> — the same
          seed re-derives the same addresses in the same order, so the coins reappear — but
          you have to know how many there were. A backup file knows for you.
        </p>
        <div className="mt-8">
          <Button data-testid="import-mnemonic" onClick={onMnemonic}>
            Use a seed phrase
          </Button>
        </div>
      </Card>
      <Card>
        <p className="card-title">Wallet backup file</p>
        <p className="small">
          The <code>.btqbackup</code> file from Settings &rarr; Wallet backup file, opened
          with the password that sealed it. The only restore that brings your account list
          and the names you gave your accounts back along with your keys — and it asks the
          explorer nothing to do it.
        </p>
        <div className="mt-8">
          <Button variant="secondary" data-testid="import-backup" onClick={onBackupFile}>
            Use a backup file
          </Button>
        </div>
      </Card>
      <Card>
        <p className="card-title">Raw BTQ HD seed</p>
        <p className="small">
          64 hexadecimal characters — the 32 bytes btq-core&rsquo;s <code>sethdseed</code> takes.
          Like a phrase it restores Account 1 and carries no account list.
        </p>
        <div className="mt-8">
          <Button variant="secondary" data-testid="import-raw" onClick={onRaw}>
            Use a raw seed
          </Button>
        </div>
      </Card>
      {/* The interop limit that exists whichever door is used: extra accounts
          are this wallet's own convention and no btq-core will derive them. */}
      <p className="small" data-testid="import-accounts-note">
        Whichever you use, btq-core derives <strong>Account 1 only</strong> from a BTQ seed:
        it hardcodes the account level to <code>0&rsquo;</code>{' '}
        (<code>scriptpubkeyman.cpp:1252</code>). Accounts above the first are this
        wallet&rsquo;s own convention and appear only where this wallet is installed.
      </p>
      <Button variant="secondary" onClick={onBack}>
        Back
      </Button>
    </div>
  );
}
