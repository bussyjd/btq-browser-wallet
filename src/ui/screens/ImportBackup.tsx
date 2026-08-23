import { useState, type FormEvent } from 'react';
import { Button } from '../components/Button.js';
import { PasswordField } from '../components/Field.js';
import { InlineError } from '../components/InlineError.js';
import { useAction } from '../hooks/useAction.js';
import { bytesToHex } from '../../core/util/hex.js';
import { MAX_BACKUP_BYTES } from '../../core/vault/backup.js';

/**
 * Restore from a wallet backup file.
 *
 * The third door, and the only one that brings the account list with it. The
 * other two take a secret the user typed; this one takes a file plus the
 * password that sealed it, which is why there is one password box here and not
 * the two the other import screens have — the wallet is not being given a new
 * password, it is being opened with the one it already had.
 *
 * The file never leaves this device and nothing here asks the network anything:
 * the bytes go to the service worker, which opens them, and the accounts come
 * out of the file rather than out of a public explorer's answers.
 */
export function ImportBackup({
  onSubmit,
  onBack,
}: {
  onSubmit: (backupHex: string, password: string) => Promise<void>;
  onBack: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [pw, setPw] = useState('');
  const { busy, error, setError, run } = useAction();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) {
      setError('Choose your backup file first.');
      return;
    }
    void run(async () => {
      // Bounded before it is read, let alone hexed and put on the message
      // channel. A backup this build writes is a little over 8 KB; anything
      // that large is not one, and reading it would be the only expensive part
      // of finding that out.
      if (file.size > MAX_BACKUP_BYTES) {
        throw new Error('That file is too large to be a BTQ wallet backup.');
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      await onSubmit(bytesToHex(bytes), pw);
    });
  }

  return (
    <form className="stack" onSubmit={submit} aria-busy={busy}>
      <div>
        <h1>Wallet backup file</h1>
        <p className="lede" style={{ marginBottom: 0 }}>
          The file you saved from Settings, and the password that sealed it. This is the
          only restore that brings your account list back with your keys.
        </p>
      </div>
      <div className="field">
        <label htmlFor="import-backup-file">Backup file</label>
        <input
          id="import-backup-file"
          data-testid="import-backup-file"
          className="input input-file"
          type="file"
          accept=".btqbackup,application/octet-stream"
          onChange={(e) => {
            setError(null);
            setFile(e.target.files?.[0] ?? null);
          }}
        />
        <p className="hint">Named btq-wallet-backup-…, about 8 KB. It stays on this device.</p>
      </div>
      <PasswordField
        id="import-backup-pw"
        data-testid="import-backup-pw"
        label="Password that sealed the backup"
        autoComplete="off"
        hint="The password of the wallet this file came from — not a new one."
        value={pw}
        onChange={(e) => setPw(e.target.value)}
      />
      <div className="stack-sm">
        <Button type="submit" data-testid="import-backup-submit" disabled={busy || !file || pw.length < 8}>
          {busy ? 'Restoring…' : 'Restore wallet'}
        </Button>
        <Button variant="secondary" onClick={onBack} disabled={busy}>
          Back
        </Button>
      </div>
      <InlineError message={error} testId="import-backup-error" />
    </form>
  );
}
