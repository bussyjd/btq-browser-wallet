/**
 * The transaction that gets signed is the transaction that was reviewed.
 *
 * `prepareSend` used to build a plan, flatten it into a summary for the review
 * card and throw the plan away; `confirmSend` then built a *second* plan from
 * whatever the explorer said by then and signed that one. Everything the card
 * promised — the fee, the number of inputs, the change, and (because
 * `prepareSend` previewed the active account while `confirmSend` pinned its
 * own) the account being debited at all — could differ from what went on chain.
 *
 * The fix is a handle: one plan, held in the worker, signed on presentation of
 * its id and revalidated first. These tests are the contract of that handle.
 * Several of them count ML-DSA signatures directly, because "the result was
 * refused" and "nothing was signed" are different claims and only the second
 * one is worth having: a wallet that signs and then discards has already put
 * the user's key over bytes nobody approved.
 */
import { describe, it, expect, vi } from 'vitest';

/** Hoisted so the module mock below can reach it; see the file comment. */
const signer = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../src/core/crypto/mldsa.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/crypto/mldsa.js')>();
  return {
    ...actual,
    // The real signer, counted. Nothing about signing is faked: a test that
    // asserts a signature *is* produced still exercises ML-DSA-44 end to end.
    signTransactionHash: (seed: Uint8Array, hash: Uint8Array) => {
      signer.calls += 1;
      return actual.signTransactionHash(seed, hash);
    },
  };
});

import { Keyring, SEND_PLAN_TTL_MS } from '../../src/core/wallet/keyring.js';
import { dispatch } from '../../src/core/rpc/dispatch.js';
import { scriptForAddress } from '../../src/core/script/address.js';
import { parseTx } from '../../src/core/tx/parse.js';
import { txid as txidOf } from '../../src/core/tx/sighash.js';
import { outpointKey } from '../../src/core/tx/coinselect.js';
import { MemoryWalletStorage, TEST_ENCRYPT } from '../helpers/memory-store.js';
import type { ExplorerUtxo } from '../../src/core/explorer/utxo.js';
import vectors from '../vectors/golden.json' with { type: 'json' };

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'testnet-ok';
const DEST = vectors.entries[1]!.addresses.testnet;
const RATE = 2000;

function ring(clock?: { t: number }) {
  return new Keyring(new MemoryWalletStorage(), {
    encrypt: TEST_ENCRYPT,
    network: 'testnet',
    now: clock ? () => clock.t : undefined,
    // Auto-lock is not what any of this is about; a clock-driven test would
    // otherwise lock the wallet out from under itself.
    lockAfterMs: clock ? 0 : undefined,
  });
}

interface Coin {
  address: string;
  vout: number;
  value: bigint;
  txid?: string;
  confirmed?: boolean;
}

/**
 * A UTXO set the test can move under a plan. `fetchUtxos` reads it live, so
 * mutating `coins` between the review card and the password is exactly the race
 * this file is about.
 */
function ledger(coins: Coin[]) {
  const rows = { coins };
  const fetchUtxos = async (address: string): Promise<ExplorerUtxo[]> =>
    rows.coins
      .filter((c) => c.address === address)
      .map((c) => ({
        txid: c.txid ?? 'ab'.repeat(32),
        vout: c.vout,
        value: c.value,
        script: scriptForAddress(c.address, 'testnet'),
        blockHeight: c.confirmed === false ? null : 300_000,
      }));
  return { rows, fetchUtxos };
}

const noRoute = async (): Promise<{ txid: string }> => {
  throw new Error('no route');
};

/** The txid the mock node echoes for bytes it accepted. */
function pushed(hex: string) {
  return { txid: txidOf(parseTx(hex)), via: 'node' as const };
}

describe('confirmSend signs the plan the user reviewed, or nothing at all', () => {
  it('the signature counter is wired to the real signer', async () => {
    // Every "signed nothing" assertion below is `signer.calls` not moving, and
    // a counter that never moves at all would make all of them vacuous. So:
    // one send that is supposed to sign, and the counter has to notice.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    const { fetchUtxos } = ledger([{ address: a0, vout: 0, value: 90_000_000n }]);
    const plan = await k.prepareSend({ destination: DEST, amountSats: 10_000_000n, fetchUtxos });
    const before = signer.calls;
    await k.confirmSend({
      planId: plan.planId,
      password: PASSWORD,
      fetchUtxos,
      broadcast: async (hex) => pushed(hex),
    });
    expect(signer.calls).toBe(before + 1);
  });

  it('a handle is opaque, unguessable and different every time', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    const { fetchUtxos } = ledger([{ address: a0, vout: 0, value: 100_000_000n }]);
    const first = await k.prepareSend({ destination: DEST, amountSats: 10_000_000n, fetchUtxos });
    const second = await k.prepareSend({ destination: DEST, amountSats: 10_000_000n, fetchUtxos });
    expect(first.planId).toMatch(/^[0-9a-f]{32}$/);
    expect(second.planId).not.toBe(first.planId);
    // It carries nothing about the payment: not the destination, not the
    // amount, not an outpoint. A popup holding it cannot read a plan out of it.
    for (const leak of [DEST, '10000000', 'ab'.repeat(32), a0]) {
      expect(first.planId).not.toContain(leak.slice(0, 12));
    }
  });

  it('a coin that moves between the review card and the password signs nothing', async () => {
    // User loss: the coin has been spent by another device sharing the seed (or
    // by an earlier send of ours). Rebuilding silently swaps in a different
    // input and a different fee behind a password the user typed against the
    // old numbers.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    const { rows, fetchUtxos } = ledger([
      { address: a0, vout: 0, value: 60_000_000n, txid: 'aa'.repeat(32) },
      { address: a0, vout: 0, value: 90_000_000n, txid: 'bb'.repeat(32) },
    ]);
    const plan = await k.prepareSend({
      destination: DEST,
      amountSats: 50_000_000n,
      fetchUtxos,
      feeRateSatPerKvB: RATE,
    });
    expect(plan.inputs).toBe(1);

    // The coin the plan spends is gone; a different one is still there, so a
    // rebuild would happily succeed — which is the whole danger.
    rows.coins = rows.coins.filter((c) => c.txid !== 'bb'.repeat(32));
    const before = signer.calls;
    let broadcasts = 0;
    await expect(
      k.confirmSend({
        planId: plan.planId,
        password: PASSWORD,
        fetchUtxos,
        broadcast: async () => {
          broadcasts += 1;
          return { txid: '00'.repeat(32) };
        },
      }),
    ).rejects.toMatchObject({ code: 'PLAN_STALE' });
    expect(signer.calls, 'no signature was produced').toBe(before);
    expect(broadcasts).toBe(0);
    expect(await k.listActivity()).toHaveLength(0);
  });

  it('a coin whose value changed under the plan signs nothing either', async () => {
    // The sighash commits to the input value, so a plan priced against 90 tBTQ
    // and signed against 89 is a signature over a transaction that can never
    // confirm — the payee waits for a payment that will never arrive.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    const { rows, fetchUtxos } = ledger([{ address: a0, vout: 0, value: 90_000_000n }]);
    const plan = await k.prepareSend({ destination: DEST, amountSats: 50_000_000n, fetchUtxos });
    rows.coins = [{ address: a0, vout: 0, value: 89_000_000n }];
    const before = signer.calls;
    await expect(
      k.confirmSend({ planId: plan.planId, password: PASSWORD, fetchUtxos, broadcast: noRoute }),
    ).rejects.toMatchObject({ code: 'PLAN_STALE' });
    expect(signer.calls).toBe(before);
  });

  it('a better coin arriving between review and password does not change what is signed', async () => {
    // The other direction, and the one a rebuild gets wrong most quietly: the
    // UTXO set improves, so `confirmSend` used to sign a cheaper, differently
    // shaped transaction than the card described. Nothing here is *wrong* on
    // chain — it is simply not what the user approved.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    const { rows, fetchUtxos } = ledger([
      { address: a0, vout: 0, value: 6_000_000n, txid: 'aa'.repeat(32) },
      { address: a0, vout: 1, value: 6_000_000n, txid: 'aa'.repeat(32) },
    ]);
    const plan = await k.prepareSend({
      destination: DEST,
      amountSats: 10_000_000n,
      fetchUtxos,
      feeRateSatPerKvB: RATE,
    });
    expect(plan.inputs).toBe(2);

    const arrival: Coin = { address: a0, vout: 2, value: 50_000_000n, txid: 'cc'.repeat(32) };
    rows.coins = [...rows.coins, arrival];

    // Not a vacuous assertion: a plan built *now* really would look different.
    const twin = ring();
    await twin.importMnemonic(MNEMONIC, PASSWORD);
    const rebuilt = await twin.prepareSend({
      destination: DEST,
      amountSats: 10_000_000n,
      fetchUtxos,
      feeRateSatPerKvB: RATE,
    });
    expect(rebuilt.inputs).toBe(1);
    expect(rebuilt.fee).not.toBe(plan.fee);

    const signed = await k.confirmSend({
      planId: plan.planId,
      password: PASSWORD,
      fetchUtxos,
      broadcast: async (hex) => pushed(hex),
    });
    // Field for field, the card and the bytes.
    expect(signed.fee).toBe(plan.fee);
    expect(signed.change).toBe(plan.change);
    expect(signed.destination).toBe(plan.destination);
    expect(signed.amount).toBe(plan.amount);
    expect(signed.vsize).toBe(plan.vsize);
    expect(signed.inputs).toHaveLength(plan.inputs);
    // …and the outpoints are the two the card counted, not the newcomer.
    expect(signed.inputs.map(outpointKey).sort()).toEqual([
      `${'aa'.repeat(32)}:0`,
      `${'aa'.repeat(32)}:1`,
    ]);
    expect(signed.inputs.map(outpointKey)).not.toContain(outpointKey({ txid: 'cc'.repeat(32), vout: 2 }));
    // The bytes agree with the summary too, decoded back out of the hex.
    const tx = parseTx(signed.hex);
    expect(tx.inputs).toHaveLength(2);
    expect(tx.outputs[1]!.value.toString()).toBe(plan.change);
  });

  it('a preview of one account cannot be confirmed while another is active', async () => {
    // The sharpest case. `prepareSend` previewed `activeRecord(meta)` and
    // `confirmSend` pinned `this.activeIndex`, so a switch between the two
    // screens showed Account 0's fee and coins and debited Account 1 — the very
    // thing the pin inside confirmSend exists to stop, leaking in one door
    // upstream of it.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    const a1 = (await k.createAccount()).address;
    await k.switchAccount(0);
    const { fetchUtxos } = ledger([
      { address: a0, vout: 0, value: 80_000_000n, txid: 'aa'.repeat(32) },
      { address: a1, vout: 0, value: 80_000_000n, txid: 'bb'.repeat(32) },
    ]);

    const plan = await k.prepareSend({ destination: DEST, amountSats: 10_000_000n, fetchUtxos });
    await k.switchAccount(1);

    const before = signer.calls;
    await expect(
      k.confirmSend({ planId: plan.planId, password: PASSWORD, fetchUtxos, broadcast: noRoute }),
    ).rejects.toMatchObject({ code: 'PLAN_STALE' });
    expect(signer.calls, 'no signature was produced').toBe(before);
    expect(await k.listActivity()).toHaveLength(0);
    // Neither account was touched: account 1's coin is not committed, and
    // account 0 was not quietly debited on its behalf either.
    expect(await k.gatherUtxos(fetchUtxos, 0)).toHaveLength(1);
    expect(await k.gatherUtxos(fetchUtxos, 1)).toHaveLength(1);
  });

  it('an unknown handle is refused and never falls back to rebuilding', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    const { fetchUtxos } = ledger([{ address: a0, vout: 0, value: 90_000_000n }]);
    // A live, confirmable plan is sitting right there — so the refusal below
    // has to come from the handle not matching *it*, not from there being
    // nothing to confirm. A wallet with coins, a correct password and a
    // plausible-looking id: the only thing missing is the id of the plan the
    // user actually read.
    const real = await k.prepareSend({ destination: DEST, amountSats: 10_000_000n, fetchUtxos });
    for (const planId of ['', 'no-such-plan', '0'.repeat(32), 'ff'.repeat(16)]) {
      expect(planId).not.toBe(real.planId);
      const before = signer.calls;
      await expect(
        k.confirmSend({ planId, password: PASSWORD, fetchUtxos, broadcast: noRoute }),
        planId || '(empty)',
      ).rejects.toMatchObject({ code: 'PLAN_STALE' });
      expect(signer.calls, planId || '(empty)').toBe(before);
    }
    expect(await k.listActivity()).toHaveLength(0);
    // …and the real handle still works: none of that consumed it.
    const signed = await k.confirmSend({
      planId: real.planId,
      password: PASSWORD,
      fetchUtxos,
      broadcast: async (hex) => pushed(hex),
    });
    expect(signed.fee).toBe(real.fee);
  });

  it('a handle is good for one send, and the second attempt signs nothing', async () => {
    // User loss: replaying a handle re-signs the same outpoints, which is a
    // conflicting replacement of a payment already in flight — the first payee
    // can end up with nothing.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    const { fetchUtxos } = ledger([{ address: a0, vout: 0, value: 90_000_000n }]);
    const plan = await k.prepareSend({ destination: DEST, amountSats: 10_000_000n, fetchUtxos });
    const first = await k.confirmSend({
      planId: plan.planId,
      password: PASSWORD,
      fetchUtxos,
      broadcast: async (hex) => pushed(hex),
    });
    expect(first.broadcastStatus).toBe('pending');

    const before = signer.calls;
    await expect(
      k.confirmSend({ planId: plan.planId, password: PASSWORD, fetchUtxos, broadcast: noRoute }),
    ).rejects.toMatchObject({ code: 'PLAN_STALE' });
    expect(signer.calls).toBe(before);
    expect(await k.listActivity()).toHaveLength(1);
  });

  it('locking the wallet drops the plan on the review card', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    const { fetchUtxos } = ledger([{ address: a0, vout: 0, value: 90_000_000n }]);
    const plan = await k.prepareSend({ destination: DEST, amountSats: 10_000_000n, fetchUtxos });
    k.lock();
    await k.unlock(PASSWORD);
    const before = signer.calls;
    // Unlocked again, right password, same handle — and still refused: whoever
    // unlocks next does not inherit a transaction somebody else approved.
    await expect(
      k.confirmSend({ planId: plan.planId, password: PASSWORD, fetchUtxos, broadcast: noRoute }),
    ).rejects.toMatchObject({ code: 'PLAN_STALE' });
    expect(signer.calls).toBe(before);
  });

  it('a plan left on screen too long is refused rather than signed at a stale fee', async () => {
    const clock = { t: 1_000_000 };
    const k = ring(clock);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    const { fetchUtxos } = ledger([{ address: a0, vout: 0, value: 90_000_000n }]);
    const plan = await k.prepareSend({ destination: DEST, amountSats: 10_000_000n, fetchUtxos });
    clock.t += SEND_PLAN_TTL_MS + 1;
    const before = signer.calls;
    await expect(
      k.confirmSend({ planId: plan.planId, password: PASSWORD, fetchUtxos, broadcast: noRoute }),
    ).rejects.toMatchObject({ code: 'PLAN_STALE' });
    expect(signer.calls).toBe(before);
  });

  it('a wrong password neither signs nor throws the reviewed plan away', async () => {
    // Re-auth is checked before the plan is consumed: a typo must not cost the
    // user their review card, and it must not be a second signing oracle.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    const { fetchUtxos } = ledger([{ address: a0, vout: 0, value: 90_000_000n }]);
    const plan = await k.prepareSend({ destination: DEST, amountSats: 10_000_000n, fetchUtxos });
    const before = signer.calls;
    await expect(
      k.confirmSend({ planId: plan.planId, password: 'wrong-pass', fetchUtxos, broadcast: noRoute }),
    ).rejects.toMatchObject({ code: 'WRONG_PASSWORD' });
    expect(signer.calls).toBe(before);
    const signed = await k.confirmSend({
      planId: plan.planId,
      password: PASSWORD,
      fetchUtxos,
      broadcast: async (hex) => pushed(hex),
    });
    expect(signed.fee).toBe(plan.fee);
  });

  it('the plan never crosses the worker boundary, and no page can ask it to', async () => {
    // The id is a handle into worker state precisely so the plan is not a
    // parameter. A page that guessed one would still be refused at the door.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    const { fetchUtxos } = ledger([{ address: a0, vout: 0, value: 90_000_000n }]);
    const prepared = (await dispatch(
      k,
      { method: 'wallet.prepareSend', params: { destination: DEST, amountSats: '10000000' } },
      { fromTab: false, fetchUtxos },
    )) as Record<string, unknown>;
    // The summary is numbers and a handle — never inputs, scripts or a tx.
    expect(Object.keys(prepared).sort()).toEqual(
      ['amount', 'change', 'destination', 'fee', 'feeRateSatPerKvB', 'inputs', 'planId', 'vsize', 'weight'].sort(),
    );
    expect(typeof prepared.inputs).toBe('number');

    for (const method of ['wallet.prepareSend', 'wallet.confirmSend']) {
      await expect(
        dispatch(
          k,
          { method, params: { planId: prepared.planId, password: PASSWORD, destination: DEST, amountSats: '1' } },
          { fromTab: true, pageOrigin: 'https://evil.example', fetchUtxos, broadcast: noRoute },
        ),
        method,
      ).rejects.toThrow(/not available to pages/);
    }

    // And over the popup's own channel a missing handle is a caller bug, not a
    // silent rebuild of something nobody reviewed.
    await expect(
      dispatch(
        k,
        { method: 'wallet.confirmSend', params: { password: PASSWORD } },
        { fromTab: false, fetchUtxos, broadcast: noRoute },
      ),
    ).rejects.toMatchObject({ code: 'BAD_PARAMS' });
  });

  it('the wire call carries nothing that could redescribe the payment', async () => {
    // The popup names a plan, not a payment. A destination, an amount or a fee
    // rate sent alongside the handle changes nothing at all.
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    const a0 = (await k.receiveAddress()).address;
    const { fetchUtxos } = ledger([{ address: a0, vout: 0, value: 90_000_000n }]);
    const prepared = (await dispatch(
      k,
      { method: 'wallet.prepareSend', params: { destination: DEST, amountSats: '10000000', feeRateSatPerKvB: RATE } },
      { fromTab: false, fetchUtxos },
    )) as Record<string, unknown>;
    const attacker = vectors.entries[2]!.addresses.testnet;
    const result = (await dispatch(
      k,
      {
        method: 'wallet.confirmSend',
        params: {
          planId: prepared.planId,
          password: PASSWORD,
          destination: attacker,
          amountSats: '89000000',
          feeRateSatPerKvB: 100_000,
        },
      },
      { fromTab: false, fetchUtxos, broadcast: async (hex: string) => pushed(hex) },
    )) as Record<string, unknown>;
    expect(result.destination).toBe(DEST);
    expect(result.destination).not.toBe(attacker);
    expect(result.amount).toBe('10000000');
    expect(result.fee).toBe(prepared.fee);
  });
});
