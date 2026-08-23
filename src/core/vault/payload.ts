import { WalletError } from '../wallet/errors.js';
import { hexToBytes } from '../util/hex.js';
import type { BtqNetwork } from '../script/address.js';

export type SeedOrigin = 'bip39' | 'raw32';

/**
 * The one payload version this build reads or writes.
 *
 * It starts at 2, and stays at 2, because 1 was used during this project's own
 * development. Renumbering to 1 would make one of those old blobs decode as a
 * current payload — a vault silently opened under rules it was never written
 * to, which is the one genuinely dangerous outcome here. A number that is never
 * reused costs nothing; a number that collides costs the wallet.
 */
export const VAULT_PAYLOAD_VERSION = 2;

/** The payload that pre-2 build wrote, and the only old one there has ever been. */
const OLD_PAYLOAD_VERSION = 1;

/**
 * What a wallet sealed by that build is told.
 *
 * It is not corrupt and must not be reported as such: the blob is intact, the
 * password opened it, and the only thing wrong with it is its age. There is
 * also no export-and-reimport escape — a phrase-derived seed is 64 bytes and
 * `parseRawSeedHex` refuses those on purpose — so the copy sends the user to
 * the phrase rather than to a hex round trip that cannot work.
 */
export const OLD_VAULT_MESSAGE =
  'This wallet was created by an older build of the extension and can no longer be opened. ' +
  'Remove it from this device and import your recovery phrase — or the raw seed you imported — again. ' +
  'It cannot be exported first: a seed that came from a phrase is 64 bytes, and the raw-seed import takes 32.';

export interface VaultPayload {
  v: typeof VAULT_PAYLOAD_VERSION;
  network: BtqNetwork;
  origin: SeedOrigin;
  hdSeedHex: string;
  /**
   * BIP39 entropy, 16 or 32 bytes, lowercase hex. Present on exactly the
   * payloads whose `origin` is `bip39`, absent on exactly the `raw32` ones —
   * the decoder enforces both directions, so "sealed from a phrase" and "can
   * show its phrase" cannot come apart. A raw32 wallet genuinely has none, and
   * running the words back out of its HD seed would manufacture a phrase for a
   * different wallet.
   *
   * Optional in the type, not in the data: `seal()` builds the field by
   * conditional spread, and a required key there would have to be written as
   * `undefined` on the raw32 path — the shape that serialises to `null`.
   */
  entropyHex?: string;
}

const NETWORKS: ReadonlySet<string> = new Set(['mainnet', 'testnet', 'signet', 'regtest']);

const HEX = /^[0-9a-f]+$/;

export function encodePayload(payload: VaultPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

function notAVault(): WalletError {
  return new WalletError('NOT_A_VAULT', 'Not a BTQ vault.');
}

/**
 * Is this the payload the pre-2 build actually wrote — as opposed to a corrupt
 * or foreign blob that happens to carry a `v`?
 *
 * The distinction is the whole point of the separate error. "Your wallet is
 * older than this build" is an instruction to go and remove a wallet, and
 * saying it about a blob that is merely broken would send a user to wipe one
 * over a bit flip. So every field that build wrote is checked, and the one it
 * never wrote — `entropyHex`, which is what version 2 added — must be absent.
 */
function isOldPayload(o: Record<string, unknown>): boolean {
  return (
    o.v === OLD_PAYLOAD_VERSION &&
    typeof o.network === 'string' &&
    NETWORKS.has(o.network) &&
    (o.origin === 'bip39' || o.origin === 'raw32') &&
    typeof o.hdSeedHex === 'string' &&
    HEX.test(o.hdSeedHex) &&
    o.hdSeedHex.length % 2 === 0 &&
    o.entropyHex === undefined
  );
}

/**
 * Decode a plaintext vault payload, or refuse.
 *
 * Two refusals, and they say different things on purpose. `NOT_A_VAULT` is
 * "these bytes are not ours" — corruption, a foreign blob, a hand-edited
 * payload — and names no field, so it is never an oracle. `VAULT_TOO_OLD` is
 * "these bytes are ours and predate this build", which is something the user
 * can act on, and it is reached only once the old payload has been parsed far
 * enough to be recognised as well-formed.
 *
 * Strictness is safe — and required — because the envelope is AES-GCM
 * authenticated: only our own `seal()` can produce a decodable payload, so a
 * malformed `entropyHex`, or a `bip39` payload missing one, is always our own
 * bug and must fail loudly rather than be rounded off to "no phrase". The
 * return is a whitelist: unknown fields are dropped, never carried into the
 * keyring.
 */
export function decodePayload(bytes: Uint8Array): VaultPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw notAVault();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw notAVault();
  }
  const o = parsed as Record<string, unknown>;
  if (o.v !== VAULT_PAYLOAD_VERSION) {
    if (isOldPayload(o)) throw new WalletError('VAULT_TOO_OLD', OLD_VAULT_MESSAGE);
    throw notAVault();
  }
  if (typeof o.network !== 'string' || !NETWORKS.has(o.network)) throw notAVault();
  if (o.origin !== 'bip39' && o.origin !== 'raw32') throw notAVault();
  if (typeof o.hdSeedHex !== 'string' || !HEX.test(o.hdSeedHex) || o.hdSeedHex.length % 2 !== 0) {
    throw notAVault();
  }
  hexToBytes(o.hdSeedHex); // length-checked by hex parser
  const out: VaultPayload = {
    v: VAULT_PAYLOAD_VERSION,
    network: o.network as BtqNetwork,
    origin: o.origin,
    hdSeedHex: o.hdSeedHex,
  };
  // `origin` and `entropyHex` are two spellings of one fact, and this is where
  // they are held together. A bip39 payload with no entropy would be a wallet
  // that says it came from a phrase and cannot show one — the third state this
  // build deliberately does not have.
  if (o.origin === 'bip39') {
    if (typeof o.entropyHex !== 'string' || !HEX.test(o.entropyHex)) throw notAVault();
    if (o.entropyHex.length !== 32 && o.entropyHex.length !== 64) throw notAVault();
    out.entropyHex = o.entropyHex;
  } else if (o.entropyHex !== undefined) {
    throw notAVault();
  }
  return out;
}
