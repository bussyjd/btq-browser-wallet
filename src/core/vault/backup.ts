/**
 * The wallet backup file — everything a recovery phrase cannot carry.
 *
 * ## Why this exists at all
 *
 * A phrase carries keys. It cannot carry metadata. Twelve words are an entropy
 * encoding: they say what the master secret is and nothing about what was done
 * with it, so the account list — how many accounts exist, what the user called
 * them, which one was in front — is not in there and no amount of cleverness
 * puts it there. That is also why the sealed vault payload cannot help: a fresh
 * device authors its *own* payload out of the phrase just typed, so a count
 * recorded in it would always read back as 1.
 *
 * The model that does work is the one Sparrow and Electrum have used for years,
 * and the one this project's own author works in daily: **the phrase is the key
 * material, a wallet file is everything else.** This module is that file.
 *
 * ## What is inside, and what is not
 *
 * The seed (and the BIP39 entropy, when there is one) travels with the account
 * list, because a backup that restores the accounts but not the keys restores
 * nothing, and one that needs the phrase *as well* is a second thing to keep.
 * The whole payload is sealed by `encryptVault` — the same `BTQ1` envelope,
 * PBKDF2-SHA256 and AES-256-GCM the on-disk vault uses. There is no second
 * crypto path here: this file adds a plaintext *schema*, not an algorithm.
 *
 * Not inside: balances, cursors and cached addresses. All three are re-derived
 * or re-scanned in seconds, and all three go stale the moment the file is
 * written. A backup that carries a balance is a backup that lies about one.
 *
 * ## The plaintext is padded, and that hides a count rather than the file
 *
 * Ciphertext length tracks plaintext length, so an unpadded backup of a
 * twelve-account wallet is visibly bigger than a one-account wallet's. Padding
 * to a fixed `BACKUP_PLAINTEXT_BYTES` makes every backup this build writes the
 * same size, so the account count is not readable off the file. It does not
 * make the file unrecognisable: an 8 KB blob whose first four bytes are `BTQ1`
 * is plainly a BTQ wallet backup, and the copy beside the export button says
 * so rather than pretending otherwise.
 *
 * ## A backup file is untrusted input
 *
 * AES-GCM authentication proves the bytes were sealed by somebody who knew the
 * password — and on an import that somebody may be whoever handed the user the
 * file. So this decoder is exactly as strict as `parseMeta`: indices bounded,
 * the list capped, names put through the same control-character strip that the
 * chrome relies on, every hex field checked. Authenticated is not trusted.
 */
import { WalletError } from '../wallet/errors.js';
import { MAX_ACCOUNTS, defaultAccountName, parseAccountName } from '../wallet/storage.js';
import type { BtqNetwork } from '../script/address.js';
import type { SeedOrigin } from './payload.js';

/**
 * The one backup schema version. It is `b`, not `v`, so a backup plaintext can
 * never be mistaken for a vault payload by either decoder: `decodePayload` sees
 * no `v` and refuses, `decodeBackup` sees no `b` and refuses. Two shapes that
 * open under the same envelope must not be able to pass for each other.
 */
export const BACKUP_VERSION = 1;

/**
 * Fixed plaintext length, so the sealed file's size does not count the
 * accounts. Comfortably above the largest payload this build can produce —
 * twenty accounts, each with a 32-code-point name that JSON may escape to six
 * bytes a character, plus a 128-character seed and its entropy is under 5 KB —
 * and `encodeBackup` throws rather than emit a short one, because a backup that
 * silently stopped padding would leak the count without anything failing.
 */
export const BACKUP_PLAINTEXT_BYTES = 8192;

/**
 * The largest file `importBackup` will look at. Our own is
 * `BACKUP_PLAINTEXT_BYTES` plus a 37-byte header and a 16-byte tag; the rest of
 * the allowance is slack for a future schema. Anything larger is not one of
 * ours and is refused before it is decoded, hexed or sent anywhere.
 */
export const MAX_BACKUP_BYTES = 64 * 1024;

/**
 * One account, as a backup records it: the derivation index and the user's own
 * name for it. Nothing else — an account *is* a path, and the path is the index.
 */
export interface BackupAccount {
  index: number;
  name: string;
}

export interface BackupPayload {
  b: typeof BACKUP_VERSION;
  network: BtqNetwork;
  origin: SeedOrigin;
  hdSeedHex: string;
  /**
   * BIP39 entropy, present on exactly the `bip39` backups and absent on exactly
   * the `raw32` ones — the same invariant `VaultPayload` holds, checked in both
   * directions here too. Without it a restored wallet would say it came from a
   * phrase and then be unable to show one.
   */
  entropyHex?: string;
  /** Every account the user created, index-ascending, always including 0. */
  accounts: BackupAccount[];
  activeAccount: number;
}

const NETWORKS: ReadonlySet<string> = new Set(['mainnet', 'testnet', 'signet', 'regtest']);
const HEX = /^[0-9a-f]+$/;

/** The two seed lengths this wallet seals: a raw 32-byte import, or a BIP39 seed. */
const SEED_HEX_LENGTHS: ReadonlySet<number> = new Set([64, 128]);

function notABackup(): WalletError {
  return new WalletError('NOT_A_BACKUP', 'That file is not a BTQ wallet backup.');
}

/**
 * Serialise and pad. The padding is trailing spaces on the JSON text, which
 * `JSON.parse` already ignores, so the decoder needs no knowledge of it.
 */
export function encodeBackup(payload: BackupPayload): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  if (json.length > BACKUP_PLAINTEXT_BYTES) {
    // Unreachable for any wallet this build can hold (MAX_ACCOUNTS accounts of
    // ACCOUNT_NAME_MAX code points each), and a loud failure rather than a
    // short file, which would publish the account count in the file's length.
    throw new Error('backup payload exceeds the fixed plaintext length');
  }
  const out = new Uint8Array(BACKUP_PLAINTEXT_BYTES).fill(0x20);
  out.set(json, 0);
  return out;
}

/**
 * Decode a decrypted backup plaintext, or refuse with one message.
 *
 * `NOT_A_BACKUP` names no field, for the same reason `NOT_A_VAULT` does not:
 * a decoder that says *which* check failed is a decoder that can be asked
 * questions. Everything it returns is a whitelist — unknown fields are dropped
 * and never reach the keyring.
 */
export function decodeBackup(bytes: Uint8Array): BackupPayload {
  if (bytes.length > MAX_BACKUP_BYTES) throw notABackup();
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw notABackup();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw notABackup();
  const o = parsed as Record<string, unknown>;
  if (o.b !== BACKUP_VERSION) throw notABackup();
  if (typeof o.network !== 'string' || !NETWORKS.has(o.network)) throw notABackup();
  if (o.origin !== 'bip39' && o.origin !== 'raw32') throw notABackup();
  if (typeof o.hdSeedHex !== 'string' || !HEX.test(o.hdSeedHex) || !SEED_HEX_LENGTHS.has(o.hdSeedHex.length)) {
    throw notABackup();
  }

  const out: BackupPayload = {
    b: BACKUP_VERSION,
    network: o.network as BtqNetwork,
    origin: o.origin,
    hdSeedHex: o.hdSeedHex,
    accounts: [],
    activeAccount: 0,
  };
  // `origin` and `entropyHex` are two spellings of one fact and are held
  // together here exactly as `decodePayload` holds them: a bip39 backup with no
  // entropy would restore a wallet that claims a phrase it cannot produce.
  if (o.origin === 'bip39') {
    if (typeof o.entropyHex !== 'string' || !HEX.test(o.entropyHex)) throw notABackup();
    if (o.entropyHex.length !== 32 && o.entropyHex.length !== 64) throw notABackup();
    out.entropyHex = o.entropyHex;
  } else if (o.entropyHex !== undefined) {
    throw notABackup();
  }

  // No separate length cap, and none is missing: every index must be an integer
  // in [0, MAX_ACCOUNTS) and no index may repeat, so a list cannot exceed
  // MAX_ACCOUNTS entries or run past the twenty-first before it throws. An empty
  // list fails the account-0 requirement below. A cap here would be a line no
  // input can reach — and a guard nothing can trip is a guard nobody can tell
  // is still working.
  if (!Array.isArray(o.accounts)) throw notABackup();
  const seen = new Set<number>();
  for (const raw of o.accounts) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw notABackup();
    const rec = raw as Record<string, unknown>;
    const index = rec.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= MAX_ACCOUNTS) {
      throw notABackup();
    }
    if (seen.has(index)) throw notABackup();
    seen.add(index);
    // The one attacker-writable string the chrome renders, through the same
    // strip the storage layer uses: bidi overrides, zero-widths, line
    // separators and half a surrogate pair do not survive a backup either.
    out.accounts.push({ index, name: parseAccountName(rec.name, defaultAccountName(index)) });
  }
  // Account 0 is btq-core's path and the golden-vector account. A list without
  // it would hide those coins from the restored wallet and — with the next
  // index already at the top — leave no way to add it back.
  if (!seen.has(0)) throw notABackup();
  out.accounts.sort((a, b) => a.index - b.index);

  out.activeAccount =
    typeof o.activeAccount === 'number' && Number.isInteger(o.activeAccount) && seen.has(o.activeAccount)
      ? o.activeAccount
      : 0;
  return out;
}

/**
 * The default name the download is offered under.
 *
 * It says what the file is and when it was written, and nothing about *whose*
 * wallet it is: no address, no account name, no network, no wallet label. A
 * file lands in a downloads folder that other software indexes and other people
 * borrow laptops from, and a name is the one part of it that is never encrypted.
 * The date is the export moment, which the file's own timestamp carries anyway.
 */
export function backupFileName(now: number): string {
  const day = new Date(now).toISOString().slice(0, 10);
  return `btq-wallet-backup-${day}.btqbackup`;
}
