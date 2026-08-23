import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { formatSats, parseBtqAmount } from '../../../core/wallet/format.js';
import { AddressBlock } from '../../components/AddressBlock.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { PasswordField } from '../../components/Field.js';
import { InlineError } from '../../components/InlineError.js';
import { StatusPill } from '../../components/StatusPill.js';
import { destinationHint, explorerTxUrl, satPerVb, shortTxid } from '../../format.js';
import { errMessage, errorCode } from '../../rpc.js';
import { useAction } from '../../hooks/useAction.js';
import { useCopy } from '../../hooks/useCopy.js';
import { FEE_PRESETS, type FeePresetId, type SendPreview, type SendResult } from '../../types.js';

interface Props {
  availableSats: string;
  /** The gap scan has settled: spendable UTXOs are known. */
  ready: boolean;
  hasNode: boolean;
  explorerBase: string;
  result: SendResult | null;
  onResult: (result: SendResult | null) => void;
  prepareSend: (destination: string, amountSats: string, rate: number) => Promise<SendPreview>;
  /**
   * Sign the plan the card is showing. It takes the plan's handle and the
   * password, and nothing that describes the payment — this screen displays a
   * transaction the worker built and cannot compose one of its own.
   */
  confirmSend: (planId: string, password: string) => Promise<SendResult>;
  maxSpendable: (rate: number) => Promise<{ amountSats: string }>;
  onSent: () => Promise<void>;
  onToast: (message: string) => void;
  onOpenSettings: () => void;
  onViewActivity: () => void;
}

function rateOf(id: FeePresetId): number {
  return FEE_PRESETS.find((p) => p.id === id)?.satPerKvB ?? 2000;
}

export function Send({
  availableSats,
  ready,
  hasNode,
  explorerBase,
  result,
  onResult,
  prepareSend,
  confirmSend,
  maxSpendable,
  onSent,
  onToast,
  onOpenSettings,
  onViewActivity,
}: Props) {
  const [dest, setDest] = useState('');
  const [destTouched, setDestTouched] = useState(false);
  const [amount, setAmount] = useState('');
  const [feeId, setFeeId] = useState<FeePresetId>('normal');
  const [preview, setPreview] = useState<SendPreview | null>(null);
  // The password only exists while the review card is on screen.
  const [password, setPassword] = useState('');
  const review = useAction();
  const sign = useAction();
  const max = useAction();
  const { copyError, copy } = useCopy(onToast);
  const resultRef = useRef<HTMLDivElement>(null);

  // The result lands under the form; in a 560 px popup that is below the fold.
  useEffect(() => {
    if (result) resultRef.current?.scrollIntoView({ block: 'nearest' });
  }, [result]);

  // The review card replaces the form, so the values on screen when the password
  // is typed are always the values that get signed. "Edit" is the only way back,
  // and it drops both the preview and the password.

  function onReview(e: FormEvent) {
    e.preventDefault();
    void review.run(async () => {
      const amountSats = parseBtqAmount(amount).toString();
      const p = await prepareSend(dest.trim(), amountSats, rateOf(feeId));
      setPreview(p);
      onResult(null);
    });
  }

  /**
   * The plan the card describes has moved on and the worker signed nothing.
   * Re-price the same payment so the user reads the numbers that would really
   * go on chain, and stay on the review step — a password box that can only
   * fail is worse than a fee that changed. If it cannot be re-priced at all any
   * more, go back to the form, where the amount is editable, carrying the
   * reason with us.
   */
  async function reprice(stale: SendPreview): Promise<void> {
    try {
      setPreview(
        await prepareSend(stale.destination, stale.amount, stale.feeRateSatPerKvB ?? rateOf(feeId)),
      );
    } catch (e) {
      setPreview(null);
      review.setError(errMessage(e));
    }
  }

  function onSign(e: FormEvent) {
    e.preventDefault();
    if (!preview) return;
    void sign.run(async () => {
      try {
        let r: SendResult;
        try {
          r = await confirmSend(preview.planId, password);
        } catch (e) {
          if (errorCode(e) !== 'PLAN_STALE') throw e;
          await reprice(preview);
          throw e;
        }
        onResult(r);
        setPreview(null);
        setDest('');
        setAmount('');
        setDestTouched(false);
        try {
          await onSent();
        } catch {
          /* the send already happened; a stale history list is not an error */
        }
      } finally {
        setPassword('');
      }
    });
  }

  const hint = destTouched ? destinationHint(dest) : null;
  const rate = rateOf(feeId);

  return (
    <div className="stack">
      {!hasNode ? (
        <p className="note" data-testid="no-node-note">
          Broadcasting needs a BTQ Core node — the public explorer has no send API. You can still
          sign here and copy the signed transaction.{' '}
          <button type="button" className="btn btn-link" onClick={onOpenSettings}>
            Configure a node
          </button>
        </p>
      ) : null}

      {preview ? (
        <Card>
          <div className="spread">
            <p className="card-title" style={{ margin: 0 }}>
              Review
            </p>
            <StatusPill tone="accent">Not signed yet</StatusPill>
          </div>
          <dl className="mt-8">
            <div className="kv">
              <dt>To</dt>
              <dd>
                <AddressBlock address={preview.destination} small testId="review-to" />
              </dd>
            </div>
            <div className="kv">
              <dt>Amount</dt>
              <dd data-testid="review-amount">{formatSats(BigInt(preview.amount))} tBTQ</dd>
            </div>
            <div className="kv">
              <dt>Fee</dt>
              <dd>
                <span data-testid="review-fee">{formatSats(BigInt(preview.fee))} tBTQ</span>
                <span className="hint" style={{ display: 'block', marginTop: 2 }}>
                  {satPerVb(preview.feeRateSatPerKvB ?? rate)} sat/vB
                  {preview.vsize ? ` · ${preview.vsize} vB` : ''}
                </span>
              </dd>
            </div>
            <div className="kv">
              <dt>Change</dt>
              <dd data-testid="review-change">
                {BigInt(preview.change) === 0n
                  ? 'none — folded into the fee'
                  : `${formatSats(BigInt(preview.change))} tBTQ`}
              </dd>
            </div>
            <div className="kv">
              <dt>Inputs</dt>
              <dd data-testid="review-inputs">{preview.inputs}</dd>
            </div>
            <div className="kv">
              <dt>Total debited</dt>
              <dd data-testid="review-total">
                {formatSats(BigInt(preview.amount) + BigInt(preview.fee))} tBTQ
              </dd>
            </div>
          </dl>
          <form className="stack-sm mt-16" onSubmit={onSign} aria-busy={sign.busy}>
            <PasswordField
              id="send-pw"
              data-testid="send-pw"
              label="Password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button type="submit" data-testid="send-confirm" disabled={sign.busy}>
              {sign.busy ? 'Signing…' : 'Sign and broadcast'}
            </Button>
            <Button
              variant="secondary"
              data-testid="send-edit"
              disabled={sign.busy}
              onClick={() => {
                setPreview(null);
                setPassword('');
              }}
            >
              Edit
            </Button>
            <InlineError message={sign.error} />
          </form>
        </Card>
      ) : (
        <form className="stack" onSubmit={onReview} aria-busy={review.busy}>
          <div className="field">
            <label htmlFor="send-to">To</label>
            <input
              id="send-to"
              data-testid="send-to"
              className="input input-mono"
              placeholder="tbtq1z…"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              value={dest}
              onChange={(e) => setDest(e.target.value)}
              onBlur={() => setDestTouched(true)}
            />
            {hint ? (
              <p className={hint.ok ? 'hint note-ok' : 'hint note-warn'}>{hint.text}</p>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor="send-amount">Amount</label>
            <div className="suffix-wrap">
              <input
                id="send-amount"
                data-testid="send-amount"
                className="input"
                inputMode="decimal"
                pattern="[0-9]*[.,]?[0-9]*"
                placeholder="0.01"
                autoComplete="off"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <span className="suffix">
                <span>tBTQ</span>
                <button
                  type="button"
                  className="btn btn-link"
                  data-testid="send-max"
                  disabled={!ready || max.busy}
                  onClick={() =>
                    void max.run(async () => {
                      const m = await maxSpendable(rate);
                      setAmount(formatSats(BigInt(m.amountSats)));
                    })
                  }
                >
                  Max
                </button>
              </span>
            </div>
            <p className="hint">Available {formatSats(BigInt(availableSats))} tBTQ</p>
            <InlineError message={max.error} testId="max-error" />
          </div>

          <div className="field">
            <span className="label" id="fee-label">
              Fee
            </span>
            <div className="chips" role="radiogroup" aria-labelledby="fee-label">
              {FEE_PRESETS.map((p) => (
                <label key={p.id} className="chip" data-testid={`fee-${p.id}`}>
                  <input
                    className="chip-input"
                    type="radio"
                    name="fee"
                    value={p.id}
                    checked={feeId === p.id}
                    onChange={() => setFeeId(p.id)}
                  />
                  <span className="chip-face">
                    {p.label}
                    <span className="chip-sub">{satPerVb(p.satPerKvB)} sat/vB</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <Button type="submit" data-testid="send-review" disabled={review.busy || !ready}>
            {review.busy ? 'Reviewing…' : 'Review'}
          </Button>
          <InlineError message={review.error} />
          {!ready ? <p className="hint">Waiting for the balance scan to settle&hellip;</p> : null}
        </form>
      )}

      {result ? (
        <Card ref={resultRef}>
          <div className="spread">
            <p className="card-title" style={{ margin: 0 }}>
              {result.broadcastStatus === 'pending' ? 'Sent' : 'Signed'}
            </p>
            <StatusPill
              tone={result.broadcastStatus === 'pending' ? 'ok' : 'warn'}
              testId="result-status"
            >
              {result.broadcastStatus === 'pending'
                ? `Broadcast${result.broadcastVia ? ` via ${result.broadcastVia}` : ''}`
                : 'Signed, not broadcast'}
            </StatusPill>
          </div>
          <dl className="mt-8">
            <div className="kv">
              <dt>Amount</dt>
              <dd>{formatSats(BigInt(result.amount))} tBTQ</dd>
            </div>
            <div className="kv">
              <dt>Fee</dt>
              <dd>
                {formatSats(BigInt(result.fee))} tBTQ
                {result.vsize ? ` · ${result.vsize} vB` : ''}
              </dd>
            </div>
            <div className="kv">
              <dt>Txid</dt>
              <dd>
                <a
                  href={explorerTxUrl(explorerBase, result.txid)}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="result-txid"
                  data-txid={result.txid}
                  title={result.txid}
                >
                  {shortTxid(result.txid)}
                </a>
              </dd>
            </div>
          </dl>
          {result.broadcastStatus === 'signed' ? (
            <>
              <p className="error mt-8" role="alert" data-testid="result-error">
                {result.broadcastError ??
                  'The transaction was signed but not broadcast. Configure a BTQ Core node, or copy the hex and push it yourself.'}
              </p>
              <div className="stack-sm mt-8">
                <Button
                  variant="secondary"
                  data-testid="copy-hex"
                  onClick={() => void copy(result.hex, 'Signed hex copied')}
                >
                  Copy signed hex
                </Button>
                <button type="button" className="btn btn-link" onClick={onOpenSettings}>
                  Configure a node
                </button>
              </div>
            </>
          ) : null}
          <div className="stack-sm mt-16">
            <Button variant="secondary" onClick={() => void copy(result.txid, 'Txid copied')}>
              Copy txid
            </Button>
            <div className="spread">
              <button type="button" className="btn btn-link" onClick={onViewActivity}>
                View in Activity
              </button>
              <button type="button" className="btn btn-link" onClick={() => onResult(null)}>
                Dismiss
              </button>
            </div>
          </div>
          <InlineError message={copyError} testId="copy-error" />
        </Card>
      ) : null}
    </div>
  );
}
