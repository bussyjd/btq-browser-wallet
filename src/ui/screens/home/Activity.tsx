import { formatSats } from '../../../core/wallet/format.js';
import { Card } from '../../components/Card.js';
import { InlineError } from '../../components/InlineError.js';
import { StatusPill, type PillTone } from '../../components/StatusPill.js';
import { explorerTxUrl, relativeTime, shortTxid } from '../../format.js';
import { useCopy } from '../../hooks/useCopy.js';
import type { HistoryEntry } from '../../types.js';

function statusPill(entry: HistoryEntry): { label: string; tone: PillTone } {
  if (entry.status === 'signed') return { label: 'Not broadcast', tone: 'warn' };
  if (entry.status === 'pending') return { label: 'Pending', tone: 'accent' };
  if (typeof entry.confirmations === 'number' && entry.confirmations > 0) {
    return { label: `${entry.confirmations} conf`, tone: 'ok' };
  }
  return { label: 'Confirmed', tone: 'ok' };
}

export function Activity({
  history,
  explorerBase,
  onToast,
}: {
  history: HistoryEntry[];
  explorerBase: string;
  onToast: (message: string) => void;
}) {
  const { copyError, copy } = useCopy(onToast);

  if (history.length === 0) {
    return (
      <Card tone="quiet">
        <p className="small" data-testid="activity-empty">
          No transactions yet. Share your receive address to get testnet coins.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <InlineError message={copyError} testId="copy-error" />
      {history.map((h) => {
        const delta = BigInt(h.valueChange);
        const incoming = delta > 0n;
        const pill = statusPill(h);
        return (
          <div key={h.txid} className="list-row" data-testid="activity-row" data-txid={h.txid}>
            <span className={incoming ? 'dir is-in' : 'dir'} aria-hidden="true">
              {incoming ? '↓' : '↑'}
            </span>
            <span className="body">
              <span className="spread">
                <span className={incoming ? 'amount is-in' : 'amount'}>
                  {incoming ? '+' : ''}
                  {formatSats(delta)} tBTQ
                </span>
                <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
              </span>
              <span className="spread mt-8">
                <a
                  className="mono"
                  href={explorerTxUrl(explorerBase, h.txid)}
                  target="_blank"
                  rel="noreferrer"
                  title={h.txid}
                >
                  {shortTxid(h.txid)}
                </a>
                <button
                  type="button"
                  className="btn btn-link"
                  onClick={() => void copy(h.txid, 'Txid copied')}
                >
                  Copy
                </button>
              </span>
              <span className="hint" style={{ display: 'block' }}>
                {incoming ? 'Received' : 'Sent'}
                {h.blockHeight ? ` · block ${h.blockHeight}` : ''}
                {h.at ? ` · ${relativeTime(h.at)}` : ''}
              </span>
            </span>
          </div>
        );
      })}
    </Card>
  );
}
