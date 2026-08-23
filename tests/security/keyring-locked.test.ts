/**
 * Everything that must refuse to run while the wallet is locked, and the
 * back-off that stops an open popup from being a free password oracle.
 */
import { describe, it, expect } from 'vitest';
import { Keyring, UNLOCK_ATTEMPTS_BEFORE_BACKOFF } from '../../src/core/wallet/keyring.js';
import { dispatch } from '../../src/core/rpc/dispatch.js';
import { WalletError } from '../../src/core/wallet/errors.js';
import { MemoryWalletStorage, TEST_ENCRYPT } from '../helpers/memory-store.js';
import vectors from '../vectors/golden.json' with { type: 'json' };

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'testnet-ok';
const DEST = vectors.entries[1]!.addresses.testnet;

function ring(store = new MemoryWalletStorage(), clock?: { t: number }) {
  return new Keyring(store, {
    encrypt: TEST_ENCRYPT,
    network: 'testnet',
    now: clock ? () => clock.t : undefined,
  });
}

describe('a locked wallet refuses every path that touches the seed', () => {
  const cases: { name: string; run: (k: Keyring) => Promise<unknown> }[] = [
    { name: 'receiveAddress', run: (k) => k.receiveAddress() },
    { name: 'addressAt', run: async () => undefined },
    { name: 'scan', run: (k) => k.scan(async () => ({ used: false, txCount: 0, reportedBalanceSats: 0n })) },
    { name: 'gatherUtxos', run: (k) => k.gatherUtxos(async () => []) },
    { name: 'balances', run: (k) => k.balances(async () => []) },
    { name: 'listHistory', run: (k) => k.listHistory(async () => []) },
    { name: 'maxSpendable', run: (k) => k.maxSpendable({ fetchUtxos: async () => [] }) },
    {
      name: 'prepareSend',
      run: (k) => k.prepareSend({ destination: DEST, amountSats: 1000n, fetchUtxos: async () => [] }),
    },
    {
      name: 'confirmSend',
      run: (k) =>
        k.confirmSend({
          planId: 'no-such-plan',
          password: PASSWORD,
          fetchUtxos: async () => [],
          broadcast: async () => ({ txid: '00'.repeat(32) }),
        }),
    },
    { name: 'approveConnect', run: (k) => k.approveConnect('https://dapp.example') },
    { name: 'reauth', run: (k) => k.reauth(PASSWORD) },
    { name: 'revealPhrase', run: (k) => k.revealPhrase(PASSWORD) },
  ];

  for (const c of cases) {
    it(`${c.name} rejects while locked`, async () => {
      // Attacker gain: any of these running while locked derives keys from a
      // seed that is supposed to be gone from memory.
      const k = ring();
      await k.importMnemonic(MNEMONIC, PASSWORD);
      k.lock();
      if (c.name === 'addressAt') {
        expect(() => k.addressAt('external', 0)).toThrow(/locked/i);
        return;
      }
      await expect(c.run(k)).rejects.toThrow(/locked/i);
    });
  }

  it('wallet.lock through dispatch makes wallet.receive refuse', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    await dispatch(k, { method: 'wallet.lock' }, { fromTab: false });
    await expect(dispatch(k, { method: 'wallet.receive' }, { fromTab: false })).rejects.toThrow(/locked/i);
  });

  it('wipe without the exact confirmation leaves the vault in place', async () => {
    // User loss: a loose confirmation check turns a mistyped word into the
    // deletion of the only copy of the encrypted seed.
    const store = new MemoryWalletStorage();
    const k = ring(store);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    for (const bad of ['delete', 'DELETE ', '', 'DELET']) {
      await expect(k.wipe(bad)).rejects.toThrow(/Type DELETE/);
    }
    expect(await store.loadVault()).not.toBeNull();
    await k.wipe('DELETE');
    expect(await store.loadVault()).toBeNull();
  });

  it('a missing parameter is BAD_PARAMS, not a password error', async () => {
    // A password-shaped error code on a missing `origin` sends the user to the
    // unlock screen for a bug that has nothing to do with their password.
    const k = ring();
    for (const [method, params] of [
      ['wallet.unlock', {}],
      ['wallet.revokeSite', {}],
      ['wallet.wipe', {}],
      ['wallet.revealPhrase', {}],
    ] as const) {
      try {
        await dispatch(k, { method, params }, { fromTab: false });
        throw new Error(`${method} should have thrown`);
      } catch (e) {
        expect((e as WalletError).code, method).toBe('BAD_PARAMS');
      }
    }
  });

  it('a bad amount is BAD_PARAMS, not DUST', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    try {
      await dispatch(
        k,
        { method: 'wallet.prepareSend', params: { destination: DEST, amountSats: 'abc' } },
        { fromTab: false, fetchUtxos: async () => [] },
      );
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WalletError).code).toBe('BAD_PARAMS');
    }
  });

  it('a non-integer fee rate is BAD_FEE_RATE', async () => {
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    try {
      await dispatch(
        k,
        { method: 'wallet.prepareSend', params: { destination: DEST, amountSats: '1000', feeRateSatPerKvB: 'fast' } },
        { fromTab: false, fetchUtxos: async () => [] },
      );
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WalletError).code).toBe('BAD_FEE_RATE');
    }
  });
});

describe('unlock attempt throttling', () => {
  it('makes a guesser wait after repeated wrong passwords', async () => {
    // Attacker gain: an open popup is otherwise an unlimited offline-speed
    // password oracle against the vault.
    const clock = { t: 1_000 };
    const store = new MemoryWalletStorage();
    const k = ring(store, clock);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    k.lock();

    for (let i = 0; i < UNLOCK_ATTEMPTS_BEFORE_BACKOFF; i++) {
      await expect(k.unlock('wrong-password')).rejects.toThrow('Incorrect password.');
    }
    const blocked = k.unlock(PASSWORD);
    await expect(blocked).rejects.toThrow(/Too many wrong passwords/);
    try {
      await blocked;
    } catch (e) {
      expect((e as WalletError).code).toBe('TOO_MANY_ATTEMPTS');
    }
    expect((await k.status()).unlocked).toBe(false);

    // Waiting clears it, and the correct password then works.
    clock.t += 60_000;
    await k.unlock(PASSWORD);
    expect((await k.status()).unlocked).toBe(true);
  });

  it('a successful unlock resets the counter', async () => {
    const clock = { t: 1_000 };
    const k = ring(new MemoryWalletStorage(), clock);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    k.lock();
    for (let i = 0; i < UNLOCK_ATTEMPTS_BEFORE_BACKOFF - 1; i++) {
      await expect(k.unlock('wrong-password')).rejects.toThrow('Incorrect password.');
    }
    await k.unlock(PASSWORD);
    k.lock();
    for (let i = 0; i < UNLOCK_ATTEMPTS_BEFORE_BACKOFF - 1; i++) {
      await expect(k.unlock('wrong-password')).rejects.toThrow('Incorrect password.');
    }
    await k.unlock(PASSWORD); // still allowed: the counter restarted
    expect((await k.status()).unlocked).toBe(true);
  });

  it('the throttle also covers re-auth on the send path', async () => {
    // Attacker gain: without this, confirmSend is a second unlimited oracle.
    const clock = { t: 1_000 };
    const k = ring(new MemoryWalletStorage(), clock);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    for (let i = 0; i < UNLOCK_ATTEMPTS_BEFORE_BACKOFF; i++) {
      await expect(k.reauth('wrong-password')).rejects.toThrow('Incorrect password.');
    }
    await expect(k.reauth(PASSWORD)).rejects.toThrow(/Too many wrong passwords/);
  });

  it('re-auth and the phrase reveal share one counter, in both directions', async () => {
    // Attacker gain: two password-checking entry points with independent
    // counters give twice the guesses, and alternating between them gives
    // unlimited ones.
    const clock = { t: 1_000 };
    const k = ring(new MemoryWalletStorage(), clock);
    await k.importMnemonic(MNEMONIC, PASSWORD);
    for (let i = 0; i < UNLOCK_ATTEMPTS_BEFORE_BACKOFF; i++) {
      // Alternate the two entry points; neither resets what the other counted.
      const attempt = i % 2 === 0 ? k.reauth('wrong-password') : k.revealPhrase('wrong-password');
      await expect(attempt).rejects.toThrow('Incorrect password.');
    }
    await expect(k.revealPhrase(PASSWORD)).rejects.toThrow(/Too many wrong passwords/);
    await expect(k.reauth(PASSWORD)).rejects.toThrow(/Too many wrong passwords/);
  });
});
