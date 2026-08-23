/**
 * A vault exactly as the pre-2 development build wrote it: `{ v: 1, network,
 * origin, hdSeedHex }` and nothing else.
 *
 * These bytes are the reason `VAULT_TOO_OLD` exists, and they cannot be built
 * with `encodePayload` any more — the encoder writes one version now, which is
 * the point. So the JSON is written out by hand here, once: a helper that
 * quietly started producing a *current* payload would leave every test that
 * depends on it passing while the case it exists for stopped being covered.
 *
 * Everything else about the blob is real — the same AES-GCM envelope, the same
 * KDF, the same metadata record — so what the wallet is asked to refuse is a
 * genuine old vault and not a corrupt one.
 */
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
  const plain = new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      network: 'testnet',
      origin: 'bip39',
      hdSeedHex: bytesToHex(mnemonicToHdSeed(mnemonic)),
    }),
  );
  await store.saveVault(await encryptVault(plain, password, encrypt));
  await store.saveMeta(emptyMeta('testnet', 'bip39'));
}
