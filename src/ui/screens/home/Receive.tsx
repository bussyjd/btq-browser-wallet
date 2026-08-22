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

  return (
    <div className="stack">
      <Card>
        {receive ? (
          <>
            <div className="qr-tile">
              <AddressQr address={receive.address} testId="receive-qr" />
            </div>
            <div className="mt-16">
              <p className="label">Your receive address</p>
              <AddressBlock address={receive.address} testId="receive-address" />
              <p className="path mt-8" data-testid="receive-path">
                {receive.path}
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="qr-tile skeleton" />
            <div className="skeleton mt-16" style={{ height: 46 }} />
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
