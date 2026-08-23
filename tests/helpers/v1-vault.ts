/**
 * A vault exactly as a pre-reveal build wrote it: v1, no entropy anywhere.
 *
 * The wallets this repository has to keep working are not only the ones it can
 * create today. A build that predates the reveal sealed `{ v: 1, network,
 * origin, hdSeedHex }` and nothing else, and `mnemonicToHdSeed` is one-way, so
 * that vault's BIP39 entropy is gone for good — no unlock, no re-seal and no
 * migration can bring it back. Every test about "the wallet that cannot show
 * its phrase" needs one of these, so it is built in one place: two hand-built
 * copies drift, and the day one of them starts writing `v: 2` the tests keep
 * passing while the case they exist for stops being covered.
 */
import { encodePayload } from '../../src/core/vault/payload.js';
import { encryptVault, type EncryptOptions } from '../../src/core/vault/encrypt.js';
import { mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';
import { emptyMeta, type WalletStorage } from '../../src/core/wallet/storage.js';
import { bytesToHex } from '../../src/core/util/hex.js';
import { TEST_ENCRYPT } from './memory-store.js';

export async function sealV1(
  store: WalletStorage,
  mnemonic: string,
  password: string,
  encrypt: EncryptOptions = TEST_ENCRYPT,
): Promise<void> {
  const plain = encodePayload({
    v: 1,
    network: 'testnet',
    origin: 'bip39',
    hdSeedHex: bytesToHex(mnemonicToHdSeed(mnemonic)),
  });
  await store.saveVault(await encryptVault(plain, password, encrypt));
  await store.saveMeta(emptyMeta('testnet', 'bip39'));
}
