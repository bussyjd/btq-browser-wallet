import { useState } from 'react';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { AddressBlock } from '../../components/AddressBlock.js';
import { AddressQr } from '../../components/qr.js';
import { InlineError } from '../../components/InlineError.js';
import { useCopy } from '../../hooks/useCopy.js';
import type { ReceiveInfo } from '../../types.js';

export function Receive({
  receive,
  ready,
  addressMoved,
  onToast,
}: {
  receive: ReceiveInfo | null;
  /** The gap scan has settled, so the "next unused" index will not move again. */
  ready: boolean;
  addressMoved: boolean;
  onToast: (message: string) => void;
}) {
  const { copyError, copy } = useCopy(onToast);
  // The address is what gets used: pasted into an exchange, a faucet, another
  // wallet on the same machine. The QR is for the case where a second device is
  // involved, which is the rarer one here, so it is offered rather than imposed.
  const [showQr, setShowQr] = useState(false);

  return (
    <div className="stack">
      <Card>
        {receive ? (
          <>
            <p className="label">Your receive address</p>
            <AddressBlock address={receive.address} testId="receive-address" />
            <p className="path mt-8" data-testid="receive-path">
              {receive.path}
            </p>
          </>
        ) : (
          <>
            <div className="skeleton" style={{ height: 18, width: 140 }} />
            <div className="skeleton mt-8" style={{ height: 46 }} />
          </>
        )}
      </Card>

      <Button
        data-testid="copy-address"
        disabled={!receive || !ready}
        onClick={() => void copy(receive?.address ?? '', 'Address copied')}
      >
        Copy address
      </Button>

      <button
        type="button"
        className="disclosure"
        data-testid="toggle-qr"
        aria-expanded={showQr}
        aria-controls="receive-qr-panel"
        disabled={!receive}
        onClick={() => setShowQr((open) => !open)}
      >
        <span className="disclosure-caret" aria-hidden="true">
          {showQr ? '▾' : '▸'}
        </span>
        {showQr ? 'Hide QR code' : 'Show QR code'}
      </button>
      {showQr && receive ? (
        <div id="receive-qr-panel" className="qr-tile">
          <AddressQr address={receive.address} testId="receive-qr" />
        </div>
      ) : null}

      {!ready ? (
        <p className="hint" role="status">
          Checking the explorer for a fresh address&hellip;
        </p>
      ) : null}
      {addressMoved ? (
        <p className="note note-warn" role="status">
          Receive address updated after the restore scan.
        </p>
      ) : null}
      <InlineError message={copyError} />
      <p className="hint">
        Share this address to receive testnet tBTQ. It is a P2MR address — every BTQ testnet
        wallet can pay it.
      </p>
    </div>
  );
}
