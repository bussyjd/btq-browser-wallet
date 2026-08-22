import { formatSats } from '../../core/wallet/format.js';
import { relativeTime } from '../format.js';
import { Button } from '../components/Button.js';
import { Card } from '../components/Card.js';
import { InlineError } from '../components/InlineError.js';
import { TabBar, type HomeTab } from '../components/TabBar.js';
import type { Wallet } from '../hooks/useWallet.js';
import type { SendResult } from '../types.js';
import { Activity } from './home/Activity.js';
import { Receive } from './home/Receive.js';
import { Send } from './home/Send.js';

export function Home({
  wallet,
  tab,
  onTab,
  sendResult,
  onSendResult,
  onToast,
  onOpenSettings,
}: {
  wallet: Wallet;
  tab: HomeTab;
  onTab: (t: HomeTab) => void;
  sendResult: SendResult | null;
  onSendResult: (r: SendResult | null) => void;
  onToast: (message: string) => void;
  onOpenSettings: () => void;
}) {
  const { status, scanning, scanned, syncError } = wallet;
  const total = BigInt(status?.lastBalanceSats ?? '0');
  const confirmedRaw = status?.confirmedBalanceSats;
  const confirmed = confirmedRaw != null ? BigInt(confirmedRaw) : null;
  const waiting = confirmed !== null ? total - confirmed : null;
  const tipHeight = status?.tipHeight ?? wallet.tip?.height ?? null;
  const explorerBase = wallet.backend?.explorerBase ?? 'https://explorer.bitcoinquantum.com';
  const firstScan = scanning && !scanned;

  return (
    <>
      <main
        className="app-body"
        id={`panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
      >
        <Card>
          <p className="label">Balance</p>
          <p className="balance-row">
            <span className="balance" data-testid="balance">
              {firstScan ? 'Updating…' : formatSats(total)}
            </span>
            {firstScan ? null : <span className="balance-unit">tBTQ</span>}
          </p>
          <p className="small mt-8">
            {scanning ? (
              <>
                <span className="spinner" aria-hidden="true" /> Scanning the explorer…
              </>
            ) : status && status.usedExternal + status.usedInternal > 0 ? (
              `${status.usedExternal} receive · ${status.usedInternal} change addresses in use`
            ) : status?.lastScanAt ? (
              `Checked ${relativeTime(status.lastScanAt)}`
            ) : (
              'No addresses used yet.'
            )}
          </p>
          {waiting !== null && waiting > 0n ? (
            <p className="hint">
              {formatSats(confirmed ?? 0n)} tBTQ confirmed · {formatSats(waiting)} tBTQ waiting for
              a block
            </p>
          ) : null}
          {tipHeight !== null ? <p className="hint">Explorer tip {tipHeight}</p> : null}
          {syncError ? (
            <>
              <InlineError message={syncError} testId="sync-error" />
              <div className="mt-8">
                <Button variant="secondary" small onClick={() => void wallet.refresh()}>
                  Try again
                </Button>
              </div>
            </>
          ) : null}
        </Card>

        <div className="mt-16">
          {tab === 'receive' ? (
            <Receive
              receive={wallet.receive}
              ready={scanned && !scanning}
              addressMoved={wallet.addressMoved}
              onToast={onToast}
            />
          ) : null}
          {tab === 'send' ? (
            <Send
              availableSats={status?.lastBalanceSats ?? '0'}
              ready={scanned && !scanning}
              hasNode={Boolean(wallet.backend?.nodeUrl)}
              explorerBase={explorerBase}
              result={sendResult}
              onResult={onSendResult}
              prepareSend={wallet.prepareSend}
              confirmSend={wallet.confirmSend}
              maxSpendable={wallet.maxSpendable}
              onSent={wallet.refreshHistory}
              onToast={onToast}
              onOpenSettings={onOpenSettings}
              onViewActivity={() => onTab('activity')}
            />
          ) : null}
          {tab === 'activity' ? (
            <Activity history={wallet.history} explorerBase={explorerBase} onToast={onToast} />
          ) : null}
        </div>
      </main>
      <div className="app-foot">
        <TabBar tab={tab} onTab={onTab} />
      </div>
    </>
  );
}
