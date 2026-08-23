import type { Broadcast, ConfirmSendResult, FetchUtxos, Keyring } from '../../src/core/wallet/keyring.js';

/**
 * Review, then confirm — the two calls the Send screen makes, in order.
 *
 * `confirmSend` signs the plan `prepareSend` built and nothing else, so every
 * send is two calls now. Tests that are about something *other* than that
 * binding — the witness bytes, the broadcast route, the activity row, the
 * reservation — go through here so the sequence is written down once and their
 * own assertions stay in view. Tests that are about the binding itself (a plan
 * that went stale, an account that moved, a handle used twice) drive the two
 * calls by hand, because the gap between them is the thing under test.
 */
export async function reviewAndSend(
  k: Keyring,
  opts: {
    destination: string;
    amountSats: bigint;
    password: string;
    fetchUtxos: FetchUtxos;
    broadcast: Broadcast;
    feeRateSatPerKvB?: number;
    now?: number;
  },
): Promise<ConfirmSendResult> {
  const { planId } = await k.prepareSend({
    destination: opts.destination,
    amountSats: opts.amountSats,
    fetchUtxos: opts.fetchUtxos,
    feeRateSatPerKvB: opts.feeRateSatPerKvB,
  });
  return k.confirmSend({
    planId,
    password: opts.password,
    fetchUtxos: opts.fetchUtxos,
    broadcast: opts.broadcast,
    now: opts.now,
  });
}
