import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Some checks assert against the *built* extension — the chunk Chrome actually
 * loads, not the TypeScript it came from. `dist/` is gitignored, so build it
 * once if it is absent. That keeps `npm test` self-sufficient in a fresh clone
 * and keeps those assertions hard rather than conditional.
 */
export default function setup(): void {
  if (existsSync(join(ROOT, 'dist', 'manifest.json'))) return;
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
}
