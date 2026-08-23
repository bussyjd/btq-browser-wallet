import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { InlineError } from '../components/InlineError.js';
import { useAction } from '../hooks/useAction.js';

export function ConnectApproval({
  origin,
  address,
  accountName,
  onApprove,
  onDeny,
}: {
  origin: string;
  address: string | null;
  /** The account this approval is for — a grant covers one account, not the wallet. */
  accountName?: string;
  onApprove: () => Promise<void>;
  onDeny: () => Promise<void>;
}) {
  const approve = useAction();
  const deny = useAction();

  return (
    <div className="stack">
      <h1>Connection request</h1>
      <Card>
        <p className="label">Site</p>
        <p className="addr" data-testid="connect-origin" title={origin}>
          {origin}
        </p>
        <p className="small mt-8">wants to see your receive address.</p>
      </Card>
      <Card tone="quiet">
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            It will see: the receive address of {accountName ?? 'this account'}
            {address ? <span className="mono"> ({address.slice(0, 12)}…)</span> : null}
          </li>
          {/* The grant is per (site, account). Switching to another account
              tells the site `accountsChanged([])`; it sees an address there
              only if the user approves it there too, through this same
              window. Promised here because this is where the promise is made. */}
          <li>Your other accounts stay hidden — approving here approves this account only</li>
          <li>It will never see: your seed phrase or any key</li>
          <li>It cannot move funds — every send needs your password here</li>
        </ul>
      </Card>
      <div className="stack-sm">
        <Button
          data-testid="connect-approve"
          disabled={approve.busy || deny.busy}
          onClick={() => void approve.run(onApprove)}
        >
          {approve.busy ? 'Connecting…' : 'Connect'}
        </Button>
        <Button
          variant="secondary"
          data-testid="connect-deny"
          disabled={approve.busy || deny.busy}
          onClick={() => void deny.run(onDeny)}
        >
          Cancel
        </Button>
      </div>
      <InlineError message={approve.error ?? deny.error} />
      <p className="hint">You can revoke this from Settings → Connected sites at any time.</p>
    </div>
  );
}
