import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { Field, PasswordField } from '../components/Field.js';
import { InlineError } from '../components/InlineError.js';
import { SeedGrid } from '../components/SeedGrid.js';
import { useAction } from '../hooks/useAction.js';
import type { Wallet } from '../hooks/useWallet.js';

type BackendField = 'explorerBase' | 'nodeUrl' | 'nodeUser';

export function Settings({
  wallet,
  onLocked,
  onWiped,
  onToast,
}: {
  wallet: Wallet;
  onLocked: () => void;
  onWiped: () => void;
  onToast: (message: string) => void;
}) {
  const { backend, loadSites } = wallet;
  // The connected-sites list is loaded by a refresh, so it can be older than
  // this panel: a site may have been approved in the connect window while this
  // popup was already open. You cannot revoke a connection you cannot see, so
  // re-read it whenever Settings opens.
  useEffect(() => {
    void loadSites().catch(() => undefined);
  }, [loadSites]);
  // The three network fields show whatever the worker has saved until the user
  // types over them; from then on the edit wins. Deriving them beats copying
  // `backend` into state inside an effect, which races a slow first load and
  // costs an extra render on every settings visit.
  const [edits, setEdits] = useState<Partial<Record<BackendField, string>>>({});
  const explorerBase = edits.explorerBase ?? backend?.explorerBase ?? '';
  const nodeUrl = edits.nodeUrl ?? backend?.nodeUrl ?? '';
  const nodeUser = edits.nodeUser ?? backend?.nodeUser ?? '';
  const edit = (field: BackendField) => (e: { target: { value: string } }) =>
    setEdits((prev) => ({ ...prev, [field]: e.target.value }));
  // Never prefilled: the saved RPC password stays in the service worker.
  const [nodePassword, setNodePassword] = useState('');
  const [note, setNote] = useState<{ text: string; warn: boolean } | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [showWipe, setShowWipe] = useState(false);
  // The reveal, in component state only — no ref, no module variable, no
  // sessionStorage, and deliberately not in `useWallet`. App.tsx renders
  // <Settings> only while the screen is 'settings', so leaving, "Lock now" and
  // auto-lock all unmount this component and take the words with them. That is
  // the mechanism; a useEffect cleanup would be theatre on top of it. The
  // property is asserted end to end instead (reveal → lock-now → no grid).
  const [askingPhrase, setAskingPhrase] = useState(false);
  const [revealPassword, setRevealPassword] = useState('');
  const [phrase, setPhrase] = useState<string[] | null>(null);

  const test = useAction();
  const rescan = useAction();
  const save = useAction();
  const lock = useAction();
  const wipe = useAction();
  const revoke = useAction();
  const reveal = useAction();

  // `=== true`, never `!== false`: an older service worker omits the field
  // entirely, and "unknown" must read as "no" rather than offering a button
  // that can only fail.
  const canReveal = wallet.status?.canRevealPhrase === true;
  // Why not, in the wallet's own words. The same two sentences the worker
  // throws with (keyring.ts noPhraseMessage), so the disabled state and the
  // refusal cannot drift into saying different things.
  const noPhraseReason =
    wallet.status?.origin === 'raw32'
      ? 'This wallet was imported from a raw 32-byte seed. It has no recovery phrase — the seed hex you imported is its backup.'
      : 'This wallet was sealed before the wallet could read a phrase back. The phrase you wrote down still restores it; the vault cannot produce it.';

  function closeReveal() {
    setAskingPhrase(false);
    setRevealPassword('');
    setPhrase(null);
    reveal.setError(null);
  }

  function draft() {
    return { explorerBase, nodeUrl, nodeUser, nodePassword };
  }

  function onTest(e: FormEvent) {
    e.preventDefault();
    void test.run(async () => {
      const probe = await wallet.testBackend(draft());
      const parts: string[] = [];
      parts.push(
        probe.explorerTip != null
          ? `Explorer reachable · tip ${probe.explorerTip}`
          : `Explorer reachable at ${probe.explorer}`,
      );
      if (probe.node) parts.push(`node chain ${probe.node.chain} · height ${probe.node.blocks}`);
      else parts.push('no node configured — the wallet can sign but not broadcast');
      if (probe.warning) parts.push(probe.warning);
      setNote({ text: parts.join(' · '), warn: Boolean(probe.warning) });
    });
  }

  function onSave() {
    void save.run(async () => {
      const saved = await wallet.saveBackend(draft());
      // The worker normalises the URLs it stored; show those, not the raw text.
      setEdits({});
      setNodePassword('');
      setNote({
        text: saved.nodeUrl
          ? 'Saved. Signed transactions are pushed through your node.'
          : 'Saved. Without a node the wallet signs only — the public explorer has no broadcast API.',
        warn: !saved.nodeUrl,
      });
      onToast('Settings saved');
    });
  }

  return (
    <main className="app-body">
      <h1>Settings</h1>

      <Card>
        <p className="section-label">Network</p>
        <form className="stack-sm" onSubmit={onTest} aria-busy={test.busy}>
          <Field
            id="explorer-url"
            data-testid="explorer-url"
            label="Explorer URL"
            mono
            spellCheck={false}
            autoComplete="off"
            value={explorerBase}
            onChange={edit('explorerBase')}
          />
          <Field
            id="node-url"
            data-testid="node-url"
            label="Node RPC URL (optional)"
            mono
            spellCheck={false}
            autoComplete="off"
            placeholder="http://127.0.0.1:18332"
            value={nodeUrl}
            onChange={edit('nodeUrl')}
          />
          <Field
            id="node-user"
            data-testid="node-user"
            label="RPC user"
            autoComplete="off"
            value={nodeUser}
            onChange={edit('nodeUser')}
          />
          <PasswordField
            id="node-pw"
            data-testid="node-pw"
            label={
              backend?.hasNodePassword ? 'RPC password (saved — blank keeps it)' : 'RPC password'
            }
            autoComplete="off"
            value={nodePassword}
            onChange={(e) => setNodePassword(e.target.value)}
          />
          {note ? (
            <p
              className={note.warn ? 'note note-warn' : 'note'}
              role="status"
              data-testid="backend-note"
            >
              {note.text}
            </p>
          ) : null}
          <div className="row">
            <Button type="submit" variant="secondary" data-testid="backend-test" disabled={test.busy}>
              {test.busy ? 'Testing…' : 'Test connection'}
            </Button>
            <Button data-testid="backend-save" disabled={save.busy} onClick={onSave}>
              {save.busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
          <InlineError message={test.error ?? save.error} />
        </form>
      </Card>

      <Card>
        <p className="section-label">Connected sites</p>
        {wallet.sites.length === 0 ? (
          <p className="small">No site can see your address.</p>
        ) : (
          wallet.sites.map((origin) => (
            <div key={origin} className="site-row" data-testid="site-row">
              <span className="origin">{origin}</span>
              <Button
                variant="secondary"
                small
                data-testid="site-revoke"
                disabled={revoke.busy}
                onClick={() => void revoke.run(() => wallet.revokeSite(origin))}
              >
                Revoke
              </Button>
            </div>
          ))
        )}
        <InlineError message={revoke.error} testId="revoke-error" />
      </Card>

      <Card>
        <p className="section-label">Wallet</p>
        <p className="small">
          A refresh only checks addresses past the last one it scanned. A full rescan re-reads
          every address from the first — use it after restoring a seed if a balance looks wrong.
        </p>
        <div className="mt-8">
          <Button
            variant="secondary"
            data-testid="rescan"
            disabled={rescan.busy || wallet.scanning}
            onClick={() =>
              void rescan.run(async () => {
                await wallet.refresh(true);
                onToast('Rescan finished');
              })
            }
          >
            {rescan.busy || wallet.scanning ? 'Rescanning…' : 'Rescan all addresses'}
          </Button>
        </div>
        <InlineError message={rescan.error} testId="rescan-error" />
      </Card>

      <Card>
        <p className="section-label">Security</p>
        <p className="small">
          The vault locks itself after 5 minutes of inactivity, and whenever the browser restarts.
        </p>
        <div className="mt-8">
          <Button
            variant="secondary"
            data-testid="lock-now"
            disabled={lock.busy}
            onClick={() =>
              void lock.run(async () => {
                await wallet.lock();
                onLocked();
              })
            }
          >
            Lock now
          </Button>
        </div>
        <InlineError message={lock.error} testId="lock-error" />

        <div className="mt-8">
          {phrase ? (
            <div className="stack-sm">
              <p className="note note-warn" role="status">
                Anyone who reads these words owns this wallet. Nobody legitimate will ever ask
                you for them.
              </p>
              <SeedGrid words={phrase} />
              <Button variant="secondary" data-testid="reveal-hide" onClick={closeReveal}>
                Hide phrase
              </Button>
            </div>
          ) : askingPhrase ? (
            <form
              className="stack-sm"
              onSubmit={(e) => {
                e.preventDefault();
                void reveal.run(async () => {
                  const result = await wallet.revealPhrase(revealPassword);
                  // Spent — clear it the instant it has been used. A failure
                  // keeps it, so a typo can be fixed without retyping.
                  setRevealPassword('');
                  setPhrase(result.words);
                });
              }}
            >
              {/* The warning goes before the field, so it is read before the
                  password is typed rather than after the words are on screen. */}
              <p className="note note-warn" role="status">
                Your recovery phrase will be shown on this screen. Make sure nobody is watching
                and nothing is recording.
              </p>
              <PasswordField
                id="reveal-pw"
                data-testid="reveal-pw"
                label="Password"
                autoComplete="off"
                value={revealPassword}
                onChange={(e) => setRevealPassword(e.target.value)}
              />
              <Button type="submit" data-testid="reveal-submit" disabled={reveal.busy}>
                {reveal.busy ? 'Checking…' : 'Show phrase'}
              </Button>
              <Button variant="secondary" onClick={closeReveal}>
                Cancel
              </Button>
              <InlineError message={reveal.error} testId="reveal-error" />
            </form>
          ) : (
            <div className="stack-sm">
              <p className="small">
                {canReveal
                  ? 'Your recovery phrase can be shown again with your password. Anyone who reads those words owns this wallet.'
                  : noPhraseReason}
              </p>
              <Button
                variant="secondary"
                data-testid="reveal-phrase"
                disabled={!canReveal}
                onClick={() => {
                  reveal.setError(null);
                  setAskingPhrase(true);
                }}
              >
                Show recovery phrase
              </Button>
            </div>
          )}
        </div>
      </Card>

      <Card tone={showWipe ? 'warn' : 'default'}>
        <p className="section-label">Danger zone</p>
        {showWipe ? (
          <form
            className="stack-sm"
            onSubmit={(e) => {
              e.preventDefault();
              void wipe.run(async () => {
                await wallet.wipe(confirmation);
                onWiped();
              });
            }}
          >
            <p className="small">
              This deletes the encrypted vault from this device. Without your seed phrase the coins
              are gone.
            </p>
            <Field
              id="wipe-input"
              data-testid="wipe-input"
              label="Type DELETE to confirm"
              placeholder="DELETE"
              autoComplete="off"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
            <Button
              type="submit"
              variant="danger"
              data-testid="wipe-confirm"
              disabled={wipe.busy || confirmation !== 'DELETE'}
            >
              Remove wallet
            </Button>
            <Button variant="secondary" onClick={() => setShowWipe(false)}>
              Cancel
            </Button>
            <InlineError message={wipe.error} testId="wipe-error" />
          </form>
        ) : (
          <Button variant="danger" onClick={() => setShowWipe(true)}>
            Remove wallet from this device
          </Button>
        )}
      </Card>
    </main>
  );
}
