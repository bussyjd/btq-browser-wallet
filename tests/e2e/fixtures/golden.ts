/**
 * `tests/vectors/golden.json`, read as data.
 *
 * Loaded with readFileSync rather than a JSON module import so the file works
 * identically under Playwright's transform and under `tsx`. The vectors are
 * read-only here: nothing in the e2e suite may regenerate them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './extension.js';

export interface GoldenEntry {
  path: string;
  chain: 'external' | 'internal';
  index: number;
  keySeed: string;
  publicKeySha256: string;
  leafScriptSha256: string;
  tapLeafHash: string;
  merkleRoot: string;
  scriptPubKey: string;
  addresses: { mainnet: string; testnet: string; regtest: string };
}

export interface GoldenVectors {
  note: string;
  hdSeedHex: string;
  masterSeed: string;
  masterChaincode: string;
  masterExtKey: string;
  entries: GoldenEntry[];
  signature: { path: string; digest: string; length: number; sighashByte: number; sha256: string };
}

export const golden = JSON.parse(
  readFileSync(join(REPO_ROOT, 'tests/vectors/golden.json'), 'utf8'),
) as GoldenVectors;
