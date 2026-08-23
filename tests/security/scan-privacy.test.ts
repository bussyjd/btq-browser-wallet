/**
 * What the wallet tells a public explorer, and how much of it.
 *
 * Be precise about the harm, because it is not the obvious one. P2MR (BIP360)
 * commits to a TapLeaf Merkle root, so an ML-DSA-44 public key stays *hashed*
 * until the output is spent: asking an explorer about an address does not put a
 * public key in front of anybody, and no assertion here should be read as
 * saying it does. The harm is linkage. A speculative scan asks one third party
 * about a batch of addresses that have no on-chain relationship to each other,
 * which binds them together in that explorer's logs before any of them has been
 * used, and the shape of the queries discloses the derivation structure — how
 * many accounts exist, how far along each chain. In a period where one wallet
 * holds both P2MR and legacy ECDSA outputs, that address graph is what tells an
 * attacker which UTXOs are worth attacking.
 *
 * So this file pins a budget and a boundary:
 *   - an idle refresh costs one gap window per chain, and does not grow with
 *     the number of accounts the user has made;
 *   - **no scan, of any kind, sends one request for one address of an account
 *     the user has not created**;
 *   - and the recovery path that replaces speculative discovery actually works:
 *     pressing "Add account" on a fresh restore re-derives the same addresses.
 *
 * The numbers here are measured, not estimated. Before this was scoped, an idle
 * refresh on a four-account wallet was 168 explorer requests (160 gap lookups +
 * 8 UTXO reads) covering 160 distinct addresses; a full rescan was 208, of which
 * 40 addresses belonged to two accounts that had never been created. After:
 * 42 and 168, and zero addresses of accounts that do not exist.
 */
import { describe, it, expect } from 'vitest';
import { Keyring } from '../../src/core/wallet/keyring.js';
import { GAP_LIMIT } from '../../src/core/wallet/gap.js';
import { addressFromHdSeed } from '../../src/core/wallet/derive.js';
import { mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';
import { scriptForAddress } from '../../src/core/script/address.js';
import { MemoryWalletStorage, TEST_ENCRYPT } from '../helpers/memory-store.js';
import type { ExplorerUtxo } from '../../src/core/explorer/utxo.js';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'testnet-ok';
const HD = mnemonicToHdSeed(MNEMONIC);

function ring(store = new MemoryWalletStorage()) {
  return new Keyring(store, { encrypt: TEST_ENCRYPT, network: 'testnet' });
}

/**
 * Counts what would be HTTP requests to the explorer in the real build:
 * `lookup` is `GET /address/{a}`, `fetchUtxos` is `GET /address/{a}/utxos`
 * (src/background/explorer.ts). Both are counted, because both are a third
 * party being told this address belongs to somebody.
 */
class ExplorerSpy {
  lookups = 0;
  utxoReads = 0;
  addresses = new Set<string>();
  used = new Set<string>();
  utxos = new Map<string, ExplorerUtxo[]>();

  lookup = async (address: string) => {
    this.lookups += 1;
    this.addresses.add(address);
    const used = this.used.has(address);
    return { used, txCount: used ? 1 : 0, reportedBalanceSats: 0n };
  };

  fetchUtxos = async (address: string) => {
    this.utxoReads += 1;
    this.addresses.add(address);
    return this.utxos.get(address) ?? [];
  };

  get requests(): number {
    return this.lookups + this.utxoReads;
  }

  reset(): void {
    this.lookups = 0;
    this.utxoReads = 0;
    this.addresses = new Set();
  }
}

function utxo(address: string, value: bigint): ExplorerUtxo {
  return {
    txid: 'cd'.repeat(32),
    vout: 0,
    value,
    script: scriptForAddress(address, 'testnet'),
    blockHeight: 300_000,
  };
}

/** Every address a gap scan of `account` could legitimately reach. */
function windowOf(k: Keyring, account: number): Set<string> {
  const out = new Set<string>();
  for (const chain of ['external', 'internal'] as const) {
    for (let i = 0; i <= GAP_LIMIT; i++) out.add(k.addressAt(chain, i, account).address);
  }
  return out;
}

describe('a scan is quiet, and it stays quiet', () => {
  it('an idle refresh costs one gap window per chain, and does not grow with the account list', async () => {
    // The regression this stops: `scan` used to walk every known account on
    // every refresh. Measured at 168 requests for four accounts with nothing to
    // find — four times the cost of a wallet with one account, paid on every
    // popup open, to learn nothing.
    const spy = new ExplorerSpy();
    const one = ring();
    await one.importMnemonic(MNEMONIC, PASSWORD);
    await one.scan(spy.lookup, spy.fetchUtxos);
    spy.reset();
    await one.scan(spy.lookup, spy.fetchUtxos);
    const idleWithOneAccount = spy.requests;

    const many = ring();
    await many.importMnemonic(MNEMONIC, PASSWORD);
    for (let i = 1; i < 4; i++) await many.createAccount();
    await many.switchAccount(0);
    await many.scan(spy.lookup, spy.fetchUtxos, null, { accounts: 'all' });
    spy.reset();
    const scan = await many.scan(spy.lookup, spy.fetchUtxos);

    // The budget, stated structurally: one gap window on each chain, plus the
    // UTXO read for the next unused address of each chain. Nothing per account.
    expect(spy.requests).toBeLessThanOrEqual(2 * GAP_LIMIT + 2);
    expect(spy.requests).toBe(idleWithOneAccount);
    expect(scan.scannedAccounts).toEqual([0]);
    // And the addresses it asked about are the active account's, only.
    const mine = windowOf(many, 0);
    for (const address of spy.addresses) expect(mine.has(address), address).toBe(true);
  });

  it('no scan sends one request for one address of an account the user has not created', async () => {
    // The deleted feature, pinned shut: speculative account discovery probed
    // ~20 addresses per guessed account, which is a batch of addresses with no
    // on-chain relationship handed to one third party in one breath.
    const spy = new ExplorerSpy();
    const k = ring();
    await k.importMnemonic(MNEMONIC, PASSWORD);
    await k.createAccount(); // the user made exactly two: 0 and 1
    await k.switchAccount(0);

    // The chain is not shy: accounts 2 and 3 are funded and would answer.
    for (const account of [2, 3]) {
      for (let i = 0; i < 3; i++) {
        const a = addressFromHdSeed(HD, 'external', i, 'testnet', account).address;
        spy.used.add(a);
        spy.utxos.set(a, [utxo(a, 99_000n)]);
      }
    }

    for (const opts of [{}, { accounts: 'all' as const }, { full: true }]) {
      spy.reset();
      const scan = await k.scan(spy.lookup, spy.fetchUtxos, null, opts);
      expect(scan.scannedAccounts.every((i) => i === 0 || i === 1)).toBe(true);
      const allowed = new Set([...windowOf(k, 0), ...windowOf(k, 1)]);
      for (const address of spy.addresses) {
        expect(allowed.has(address), `${address} belongs to an account the user never created`).toBe(true);
      }
      expect((await k.status()).accounts.map((a) => a.index)).toEqual([0, 1]);
    }
    // Zero, stated as zero.
    const strangers = [2, 3].map((n) => addressFromHdSeed(HD, 'external', 0, 'testnet', n).address);
    for (const address of strangers) expect(spy.addresses.has(address)).toBe(false);
  });

  it('a first-ever scan after a restore is no chattier than any other refresh', async () => {
    // The first scan used to be a discovery scan even though the user never
    // asked for one, so the noisiest pass this wallet ever made was the one it
    // made without being told to, on a device that had just been restored.
    const spy = new ExplorerSpy();
    const restored = ring();
    await restored.importMnemonic(MNEMONIC, PASSWORD);
    await restored.scan(spy.lookup, spy.fetchUtxos);
    expect(spy.requests).toBeLessThanOrEqual(2 * GAP_LIMIT + 2);
    const mine = windowOf(restored, 0);
    for (const address of spy.addresses) expect(mine.has(address), address).toBe(true);
  });
});

describe('the recovery path that replaces discovery', () => {
  it('pressing Add account on a fresh restore re-derives the identical addresses, and the coins come back', async () => {
    // This is the whole argument for deleting speculative discovery, so it is
    // asserted rather than asserted-about: the account list is metadata the
    // user writes down, and re-creating it from the same seed is exact.
    const first = ring();
    await first.importMnemonic(MNEMONIC, PASSWORD);
    const made: { index: number; address: string }[] = [];
    for (let i = 1; i <= 3; i++) {
      const created = await first.createAccount();
      made.push({ index: created.index, address: created.address });
    }
    expect(made.map((m) => m.index)).toEqual([1, 2, 3]);

    // A new device: the same phrase, and nothing else.
    const store = new MemoryWalletStorage();
    const restored = ring(store);
    await restored.importMnemonic(MNEMONIC, PASSWORD);
    expect((await restored.status()).accounts.map((a) => a.index)).toEqual([0]);

    for (const want of made) {
      const again = await restored.createAccount();
      expect(again.index).toBe(want.index);
      expect(again.address).toBe(want.address);
    }
    expect((await restored.status()).accounts.map((a) => a.index)).toEqual([0, 1, 2, 3]);

    // Not just the same strings: the coins on the re-derived account are
    // reachable from it, which is the thing the user actually wanted back.
    const funded = made[1]!;
    const spy = new ExplorerSpy();
    spy.used.add(funded.address);
    spy.utxos.set(funded.address, [utxo(funded.address, 41_000n)]);
    await restored.switchAccount(funded.index);
    await restored.scan(spy.lookup, spy.fetchUtxos);
    expect((await restored.balances(spy.fetchUtxos)).totalSats).toBe(41_000n);
    expect((await restored.status()).lastBalanceSats).toBe('41000');
  });
});
