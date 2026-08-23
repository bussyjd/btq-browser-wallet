/** Presentation helpers used only by the popup. No protocol logic lives here. */

export function shortAddress(address: string): string {
  if (address.length <= 20) return address;
  return `${address.slice(0, 10)}…${address.slice(-6)}`;
}

export function shortTxid(txid: string): string {
  if (txid.length <= 22) return txid;
  return `${txid.slice(0, 10)}…${txid.slice(-8)}`;
}

export function explorerTxUrl(explorerBase: string, txid: string): string {
  const base = explorerBase.replace(/\/+$/, '');
  return `${base}/tx/${txid}`;
}

/** The contract speaks sat/kvB; users read sat/vB. */
export function satPerVb(satPerKvB: number): number {
  return satPerKvB / 1000;
}

export function relativeTime(at: number, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

/**
 * Bech32 libraries throw messages written for developers ("Invalid checksum in
 * tbtq1z…: expected \"6drkeg\""). The service worker owns the user-facing copy;
 * this is the last-resort net so a raw library string never reaches the screen.
 */
export function friendlyError(message: string, code?: string): string {
  if (code === 'BAD_ADDRESS' && /invalid checksum|string must be|non-base|unknown letter|no separator/i.test(message)) {
    return 'That is not a valid BTQ testnet address. Testnet addresses start with tbtq1z — check for a missing or mistyped character.';
  }
  return message;
}

/** A cheap prefix check for instant feedback. The service worker stays the authority. */
export function destinationHint(value: string): { ok: boolean; text: string } | null {
  const v = value.trim();
  if (!v) return null;
  if (/^tbtq1z/i.test(v)) return { ok: true, text: 'Testnet P2MR address' };
  if (/^qbtc1/i.test(v)) return { ok: false, text: 'That is a mainnet address. This wallet only sends on testnet.' };
  if (/^tdbt1/i.test(v)) return { ok: false, text: 'Legacy Dilithium address. Ask the recipient for a tbtq1z… address.' };
  if (/^(bc1|tb1|[123mn2])/.test(v)) return { ok: false, text: 'That looks like a Bitcoin or legacy address. BTQ testnet addresses start with tbtq1z.' };
  return { ok: false, text: 'BTQ testnet addresses start with tbtq1z.' };
}

/** navigator.clipboard can reject (permissions, no focus). Never fail silently. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
