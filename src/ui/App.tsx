import { useCallback, useEffect, useState } from 'react';
import { chunkAddress, formatSats, parseBtqAmount } from '../core/wallet/format.js';
import type { KeyringStatus } from '../core/wallet/types.js';
import { AddressQr } from './qr.js';
import { rpc, RpcError } from './rpc.js';

type Screen =
  | 'boot'
  | 'welcome'
  | 'create-password'
  | 'show-seed'
  | 'confirm-seed'
  | 'import-choice'
  | 'import-mnemonic'
  | 'import-raw'
  | 'unlock'
  | 'home';

interface ReceiveInfo {
  address: string;
  path: string;
  index: number;
}

function errMessage(e: unknown): string {
  if (e instanceof RpcError || e instanceof Error) return e.message;
  return 'Something went wrong.';
}

export function App() {
  const [screen, setScreen] = useState<Screen>('boot');
  const [status, setStatus] = useState<KeyringStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<number[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [importText, setImportText] = useState('');
  const [receive, setReceive] = useState<ReceiveInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [wipe, setWipe] = useState('');
  const [tab, setTab] = useState<'receive' | 'send' | 'activity'>('receive');
  const [sendDest, setSendDest] = useState('');
  const [sendAmt, setSendAmt] = useState('');
  const [sendPw, setSendPw] = useState('');
  const [sendPreview, setSendPreview] = useState<{ destination: string; amount: string; fee: string; change: string; inputs: number } | null>(null);
  const [sendResult, setSendResult] = useState<{ txid: string; hex: string; broadcastStatus: string; fee: string; amount: string; destination: string } | null>(null);
  const [history, setHistory] = useState<{ txid: string; status: string; valueChange: string }[]>([]);
  const [pendingSite, setPendingSite] = useState<string | null>(null);
  const [sites, setSites] = useState<string[]>([]);
  const [networkOpen, setNetworkOpen] = useState(false);
  const [explorerBase, setExplorerBase] = useState('https://explorer.bitcoinquantum.com');
  const [nodeUrl, setNodeUrl] = useState('');
  const [nodeUser, setNodeUser] = useState('');
  const [nodePassword, setNodePassword] = useState('');
  const [hasNodePassword, setHasNodePassword] = useState(false);
  const [backendNote, setBackendNote] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    return rpc<KeyringStatus>('wallet.status');
  }, []);

  const loadBackend = useCallback(async () => {
    const b = await rpc<{
      explorerBase: string;
      nodeUrl: string | null;
      nodeUser: string | null;
      hasNodePassword: boolean;
    }>('wallet.getBackend');
    setExplorerBase(b.explorerBase);
    setNodeUrl(b.nodeUrl ?? '');
    setNodeUser(b.nodeUser ?? '');
    setHasNodePassword(b.hasNodePassword);
    setNodePassword('');
  }, []);

  const goReceive = useCallback(async () => {
    const [st, rec] = await Promise.all([
      rpc<KeyringStatus>('wallet.status'),
      rpc<ReceiveInfo>('wallet.receive'),
    ]);
    setStatus(st);
    setReceive(rec);
    setScreen('home');
    setScanning(true);
    try {
      const scanned = await rpc<Pick<KeyringStatus, 'lastBalanceSats' | 'usedExternal' | 'externalNext'>>('wallet.scan');
      const next = await rpc<ReceiveInfo>('wallet.receive');
      setReceive(next);
      setStatus((s) => (s ? { ...s, ...scanned, unlocked: true, hasVault: true } : s));
      try {
        const hist = await rpc<{ txid: string; status: string; valueChange: string }[]>('wallet.history');
        setHistory(hist);
      } catch {
        /* history is best-effort */
      }
      const pending = await rpc<{ origin: string } | null>('wallet.pendingConnect');
      setPendingSite(pending?.origin ?? null);
      const connected = await rpc<{ origins: string[] }>('wallet.connectedSites');
      setSites(connected.origins);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const st = await refreshStatus();
        if (cancelled) return;
        try {
          await loadBackend();
        } catch {
          /* first paint can proceed with defaults */
        }
        setStatus(st);
        if (st.unlocked) await goReceive();
        else if (st.hasVault) setScreen('unlock');
        else if (st.pendingReveal) setScreen('welcome');
        else setScreen('welcome');
      } catch (e) {
        if (!cancelled) {
          setError(errMessage(e));
          setScreen('welcome');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [goReceive, loadBackend, refreshStatus]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function resetSecrets() {
    setPassword('');
    setPassword2('');
    setMnemonic(null);
    setChallenge([]);
    setAnswers({});
    setImportText('');
  }

  async function onCreate() {
    await run(async () => {
      if (password !== password2) throw new Error('Passwords do not match.');
      const reveal = await rpc<{ mnemonic: string; challenge: number[] }>('wallet.create', { password });
      setMnemonic(reveal.mnemonic);
      setChallenge(reveal.challenge);
      setScreen('show-seed');
    });
  }

  async function onConfirm() {
    await run(async () => {
      const payload = challenge.map((index) => ({ index, word: answers[index] ?? '' }));
      await rpc('wallet.confirm', { answers: payload, password });
      resetSecrets();
      await goReceive();
    });
  }

  async function onImportMnemonic() {
    await run(async () => {
      if (password !== password2) throw new Error('Passwords do not match.');
      await rpc('wallet.importMnemonic', { mnemonic: importText, password });
      resetSecrets();
      await goReceive();
    });
  }

  async function onImportRaw() {
    await run(async () => {
      if (password !== password2) throw new Error('Passwords do not match.');
      await rpc('wallet.importSeed', { seedHex: importText, password });
      resetSecrets();
      await goReceive();
    });
  }

  async function onUnlock() {
    await run(async () => {
      await rpc('wallet.unlock', { password });
      setPassword('');
      await goReceive();
    });
  }

  async function onLock() {
    await run(async () => {
      await rpc('wallet.lock');
      setReceive(null);
      setScreen('unlock');
    });
  }

  async function onWipe() {
    await run(async () => {
      await rpc('wallet.wipe', { confirmation: wipe });
      setWipe('');
      setReceive(null);
      setStatus(null);
      setScreen('welcome');
    });
  }

  async function copyAddress() {
    if (!receive) return;
    await navigator.clipboard.writeText(receive.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  async function onPrepareSend() {
    await run(async () => {
      const amountSats = parseBtqAmount(sendAmt).toString();
      const preview = await rpc<{ destination: string; amount: string; fee: string; change: string; inputs: number }>(
        'wallet.prepareSend',
        { destination: sendDest.trim(), amountSats },
      );
      setSendPreview(preview);
      setSendResult(null);
    });
  }

  async function onConfirmSend() {
    await run(async () => {
      if (!sendPreview) throw new Error('Review the fee before signing.');
      const result = await rpc<{
        txid: string;
        hex: string;
        broadcastStatus: string;
        fee: string;
        amount: string;
        destination: string;
      }>('wallet.confirmSend', {
        destination: sendPreview.destination,
        amountSats: sendPreview.amount,
        password: sendPw,
      });
      setSendPw('');
      setSendPreview(null);
      setSendResult(result);
      setTab('activity');
      const hist = await rpc<{ txid: string; status: string; valueChange: string }[]>('wallet.history');
      setHistory(hist);
    });
  }

  const words = mnemonic?.split(' ') ?? [];

  return (
    <div className="app">
      <header className="mast">
        <span className="wordmark">BTQ Wallet</span>
        <button
          type="button"
          className="stamp"
          onClick={() => {
            setNetworkOpen((o) => !o);
            setBackendNote(null);
            void loadBackend();
          }}
          aria-expanded={networkOpen}
          title="Network and node"
        >
          Testnet{hasNodePassword || nodeUrl ? ' · node' : ''}
        </button>
      </header>

      {networkOpen ? (
        <div className="instrument" style={{ marginBottom: 14 }}>
          <h1 style={{ fontSize: 16 }}>Testnet backend</h1>
          <p className="lede">
            Addresses stay <code>tbtq1z…</code>. Point history at an explorer and, for broadcast, a BTQ Core
            JSON-RPC (testnet default port 18332).
          </p>
          <div className="stack">
            <label htmlFor="expl">Explorer URL</label>
            <input id="expl" value={explorerBase} onChange={(e) => setExplorerBase(e.target.value)} spellCheck={false} />
            <label htmlFor="nurl">Node RPC URL (optional)</label>
            <input id="nurl" value={nodeUrl} onChange={(e) => setNodeUrl(e.target.value)} placeholder="http://127.0.0.1:18332" spellCheck={false} />
            <label htmlFor="nuser">RPC user</label>
            <input id="nuser" value={nodeUser} onChange={(e) => setNodeUser(e.target.value)} autoComplete="off" />
            <label htmlFor="npw">RPC password{hasNodePassword ? ' (saved — leave blank to keep)' : ''}</label>
            <input id="npw" type="password" value={nodePassword} onChange={(e) => setNodePassword(e.target.value)} autoComplete="off" />
            {backendNote ? <p className="meta-line">{backendNote}</p> : null}
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => void run(async () => {
                const probed = await rpc<{ explorer: string; node?: { chain: string; blocks: number } }>('wallet.testBackend', {
                  explorerBase, nodeUrl, nodeUser, nodePassword,
                });
                setBackendNote(
                  probed.node
                    ? `Node chain ${probed.node.chain} at height ${probed.node.blocks}.`
                    : `Explorer reachable at ${probed.explorer}. Add a node URL to broadcast.`,
                );
              })}>Test connection</button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => void run(async () => {
                const saved = await rpc<{ explorerBase: string; nodeUrl: string | null; hasNodePassword: boolean }>('wallet.setBackend', {
                  explorerBase, nodeUrl, nodeUser, nodePassword,
                });
                setHasNodePassword(saved.hasNodePassword);
                setNodePassword('');
                setBackendNote(saved.nodeUrl ? 'Saved. Sends will push via Core RPC.' : 'Saved. Broadcast uses the explorer.');
              })}>Save</button>
            </div>
            <button className="btn btn-ghost" onClick={() => setNetworkOpen(false)}>Close</button>
          </div>
        </div>
      ) : null}

      {error ? <div className="err" role="alert">{error}</div> : null}

      {screen === 'boot' && <p className="lede">Opening vault…</p>}

      {screen === 'welcome' && (
        <>
          <h1>Hold your own quantum-safe keys.</h1>
          <p className="lede">
            This extension is a Bitcoin Quantum testnet wallet. Coins here are not mainnet money.
            Keys never leave the extension.
          </p>
          <div className="stack">
            <button className="btn" onClick={() => { setError(null); setScreen('create-password'); }}>
              Create a wallet
            </button>
            <button className="btn btn-ghost" onClick={() => { setError(null); setScreen('import-choice'); }}>
              Import a wallet
            </button>
          </div>
          <p className="footer-note">ML-DSA-44 · P2MR · tbtq1z…</p>
        </>
      )}

      {screen === 'create-password' && (
        <>
          <h1>Set a password</h1>
          <p className="lede">The password seals the vault. The seed is not stored until you confirm it on the next screens.</p>
          <div className="stack">
            <label htmlFor="pw">Password</label>
            <input id="pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <label htmlFor="pw2">Confirm password</label>
            <input id="pw2" type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} />
            <button className="btn" disabled={busy || password.length < 8} onClick={() => void onCreate()}>
              Generate seed
            </button>
            <button className="btn btn-ghost" onClick={() => setScreen('welcome')}>Back</button>
          </div>
        </>
      )}

      {screen === 'show-seed' && mnemonic && (
        <>
          <h1>Write these words down</h1>
          <p className="warn">This is the only time this seed is shown. The wallet cannot display it again.</p>
          <ol className="seed-grid">
            {words.map((w, i) => (
              <li key={i}><span className="n">{i + 1}</span><span>{w}</span></li>
            ))}
          </ol>
          <button className="btn" onClick={() => setScreen('confirm-seed')}>I have written it down</button>
        </>
      )}

      {screen === 'confirm-seed' && (
        <>
          <h1>Confirm the seed</h1>
          <p className="lede">Enter the requested words so we know a copy exists off this device.</p>
          <div className="stack">
            {challenge.map((index) => (
              <div key={index}>
                <label htmlFor={`w${index}`}>Word {index + 1}</label>
                <input
                  id={`w${index}`}
                  autoCapitalize="off"
                  autoCorrect="off"
                  value={answers[index] ?? ''}
                  onChange={(e) => setAnswers((a) => ({ ...a, [index]: e.target.value }))}
                />
              </div>
            ))}
            <button className="btn" disabled={busy} onClick={() => void onConfirm()}>Seal the vault</button>
            <button className="btn btn-ghost" onClick={() => setScreen('show-seed')}>Back to words</button>
          </div>
        </>
      )}

      {screen === 'import-choice' && (
        <>
          <h1>Import</h1>
          <p className="lede">
            A seed phrase and a raw 32-byte hex seed are different wallets, even from the same entropy.
            Pick the form you actually have.
          </p>
          <div className="stack">
            <button className="btn" onClick={() => setScreen('import-mnemonic')}>12/24-word seed phrase</button>
            <button className="btn btn-ghost" onClick={() => setScreen('import-raw')}>Raw 32-byte BTQ seed</button>
            <button className="btn btn-ghost" onClick={() => setScreen('welcome')}>Back</button>
          </div>
        </>
      )}

      {screen === 'import-mnemonic' && (
        <>
          <h1>Seed phrase</h1>
          <div className="stack">
            <label htmlFor="mn">BIP39 words</label>
            <textarea id="mn" value={importText} onChange={(e) => setImportText(e.target.value)} spellCheck={false} />
            <label htmlFor="ipw">Password to seal the vault</label>
            <input id="ipw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <label htmlFor="ipw2">Confirm password</label>
            <input id="ipw2" type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} />
            <button className="btn" disabled={busy} onClick={() => void onImportMnemonic()}>Import</button>
            <button className="btn btn-ghost" onClick={() => setScreen('import-choice')}>Back</button>
          </div>
        </>
      )}

      {screen === 'import-raw' && (
        <>
          <h1>Raw HD seed</h1>
          <p className="lede">64 hexadecimal characters — the 32 bytes btq-core’s <code>sethdseed</code> takes.</p>
          <div className="stack">
            <label htmlFor="raw">Seed hex</label>
            <textarea id="raw" value={importText} onChange={(e) => setImportText(e.target.value)} spellCheck={false} />
            <label htmlFor="rpw">Password to seal the vault</label>
            <input id="rpw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <label htmlFor="rpw2">Confirm password</label>
            <input id="rpw2" type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} />
            <button className="btn" disabled={busy} onClick={() => void onImportRaw()}>Import</button>
            <button className="btn btn-ghost" onClick={() => setScreen('import-choice')}>Back</button>
          </div>
        </>
      )}

      {screen === 'unlock' && (
        <>
          <h1>Unlock</h1>
          <p className="lede">The vault is sealed. Keys decrypt only for this session.</p>
          <div className="stack">
            <label htmlFor="upw">Password</label>
            <input id="upw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button className="btn" disabled={busy} onClick={() => void onUnlock()}>Unlock</button>
          </div>
        </>
      )}

      {screen === 'home' && receive && (
        <>
          <p className="balance">
            {formatSats(BigInt(status?.lastBalanceSats ?? '0'))}
            <small>tBTQ</small>
          </p>
          {pendingSite ? (
            <div className="instrument" style={{ marginBottom: 12 }}>
              <p className="lede">Connect {pendingSite}?</p>
              <p className="meta-line">It will see this receive address, not your seed.</p>
              <div className="row">
                <button className="btn" onClick={() => void run(async () => {
                  await rpc('wallet.approveConnect', { origin: pendingSite });
                  setPendingSite(null);
                  const connected = await rpc<{ origins: string[] }>('wallet.connectedSites');
                  setSites(connected.origins);
                })}>Connect</button>
                <button className="btn btn-ghost" onClick={() => void run(async () => {
                  await rpc('wallet.denyConnect');
                  setPendingSite(null);
                })}>Deny</button>
              </div>
            </div>
          ) : null}
          <div className="row tabs">
            <button className={tab === 'receive' ? 'btn' : 'btn btn-ghost'} onClick={() => setTab('receive')}>Receive</button>
            <button className={tab === 'send' ? 'btn' : 'btn btn-ghost'} onClick={() => setTab('send')}>Send</button>
            <button className={tab === 'activity' ? 'btn' : 'btn btn-ghost'} onClick={() => setTab('activity')}>Activity</button>
          </div>

          {tab === 'receive' && (
            <>
              <p className="meta-line">
                {scanning
                  ? 'Scanning the explorer for used addresses…'
                  : status && status.usedExternal + status.usedInternal > 0
                    ? `Restored ${status.usedExternal} receive / ${status.usedInternal} change addresses.`
                    : 'Next unused receive address. Share it to get testnet tBTQ.'}
              </p>
              <div className="instrument">
                <div className="qr-wrap">
                  <AddressQr address={receive.address} />
                </div>
                <p className="addr" aria-label="Receive address">
                  {chunkAddress(receive.address).map((g, i) => (
                    <span key={i}>{g}</span>
                  ))}
                </p>
                <p className="path">{receive.path}</p>
              </div>
              <div className="stack" style={{ marginTop: 12 }}>
                <div className="row">
                  <button className="btn" onClick={() => void copyAddress()}>{copied ? 'Copied' : 'Copy address'}</button>
                  <button className="btn btn-ghost" onClick={() => void onLock()}>Lock</button>
                </div>
                <label htmlFor="wipe">Remove wallet from this device</label>
                <input id="wipe" placeholder="Type DELETE" value={wipe} onChange={(e) => setWipe(e.target.value)} />
                <button className="btn btn-danger" disabled={busy || wipe !== 'DELETE'} onClick={() => void onWipe()}>
                  Remove wallet
                </button>
              </div>
            </>
          )}

          {tab === 'send' && (
            <div className="stack" style={{ marginTop: 12 }}>
              <p className="lede">Sends tbtq1z… P2MR only. Fees use witness scale 16. Re-enter your password to sign.</p>
              <label htmlFor="dest">To</label>
              <textarea id="dest" value={sendDest} onChange={(e) => setSendDest(e.target.value)} spellCheck={false} placeholder="tbtq1z…" />
              <label htmlFor="amt">Amount (tBTQ)</label>
              <input id="amt" value={sendAmt} onChange={(e) => setSendAmt(e.target.value)} placeholder="0.01" />
              <button className="btn" disabled={busy} onClick={() => void onPrepareSend()}>Review fee</button>
              {sendPreview ? (
                <div className="instrument">
                  <p className="meta-line">Fee {formatSats(BigInt(sendPreview.fee))} tBTQ · {sendPreview.inputs} input{sendPreview.inputs === 1 ? '' : 's'} · change {formatSats(BigInt(sendPreview.change))}</p>
                  <label htmlFor="spw">Password</label>
                  <input id="spw" type="password" autoComplete="current-password" value={sendPw} onChange={(e) => setSendPw(e.target.value)} />
                  <button className="btn" disabled={busy} onClick={() => void onConfirmSend()}>Sign and broadcast</button>
                </div>
              ) : null}
              {sendResult ? (
                <div className="instrument">
                  <p className="meta-line">{sendResult.broadcastStatus === 'pending' ? 'Broadcast' : 'Signed (copy hex if the explorer cannot push)'}</p>
                  <p className="addr">{sendResult.txid}</p>
                  <button className="btn btn-ghost" onClick={() => void navigator.clipboard.writeText(sendResult.hex)}>Copy signed hex</button>
                </div>
              ) : null}
            </div>
          )}

          {tab === 'activity' && (
            <div className="stack" style={{ marginTop: 12 }}>
              {history.length === 0 ? <p className="lede">No transactions yet. Receive testnet coins, then send.</p> : null}
              {history.map((h) => (
                <div key={h.txid} className="instrument">
                  <p className="meta-line">{h.status}</p>
                  <p className="addr">{h.txid.slice(0, 12)}…{h.txid.slice(-8)}</p>
                  <p className="path">{formatSats(BigInt(h.valueChange))} tBTQ</p>
                </div>
              ))}
              {sites.length > 0 ? (
                <>
                  <p className="lede">Connected sites</p>
                  {sites.map((o) => (
                    <div key={o} className="row">
                      <span className="path">{o}</span>
                      <button className="btn btn-ghost" onClick={() => void run(async () => {
                        await rpc('wallet.revokeSite', { origin: o });
                        setSites((s) => s.filter((x) => x !== o));
                      })}>Revoke</button>
                    </div>
                  ))}
                </>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}
