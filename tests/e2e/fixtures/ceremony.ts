/**
 * The multisig ceremony page, served from 127.0.0.1 with the wallet's own
 * `src/core` code bundled into it.
 *
 * Why a page rather than the popup: the multisig work is `src/core` only — no
 * screens, no `wallet.*` methods, no keyring integration — so there is nothing
 * in the extension UI to click. What there *is* to show is the claim the design
 * rests on: that parsing, signing, combining and finalizing a Dilithium P2MR
 * PSBT happens **in a browser, with no node**, and agrees with btq-core
 * byte for byte. That is what this page runs.
 *
 * The bundle is built from `src/core` at test time rather than checked in, so
 * the recording can never drift from the code it claims to demonstrate. It is
 * the real modules: `signPsbt` here is the same function the worker would call.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const HTML = readFileSync(join(HERE, 'ceremony.html'), 'utf8');

/**
 * `src/core` imports siblings as `./types.js` — correct for ESM output, but
 * esbuild resolves that literally and finds no such file on disk. Vite rewrites
 * it during the normal build; here we do the same one-line mapping rather than
 * changing a single import in `src/core` to suit a test.
 */
const resolveTsExtensions = {
  name: 'ts-ext',
  setup(b: { onResolve: (o: { filter: RegExp }, cb: (a: { path: string; resolveDir: string }) => { path: string } | undefined) => void }) {
    b.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, (args) => {
      const candidate = join(args.resolveDir, args.path.replace(/\.js$/, '.ts'));
      try {
        readFileSync(candidate);
        return { path: candidate };
      } catch {
        return undefined;
      }
    });
  },
};

/** Bundle the multisig + PSBT surface into one IIFE exposing `window.BTQ`. */
async function bundleCore(): Promise<string> {
  const entry = join(REPO, 'tests', 'e2e', 'fixtures', 'ceremony-entry.ts');
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    globalName: 'BTQ',
    platform: 'browser',
    target: 'es2022',
    write: false,
    plugins: [resolveTsExtensions as never],
  });
  const out = result.outputFiles?.[0];
  if (!out) throw new Error('ceremony: esbuild produced no output');
  return out.text;
}

export interface Ceremony {
  origin: string;
  url: string;
  close(): Promise<void>;
}

export async function startCeremony(): Promise<Ceremony> {
  const bundle = await bundleCore();
  const server: Server = createServer((req, res) => {
    const isBundle = (req.url ?? '').startsWith('/core.js');
    const body = isBundle ? bundle : HTML;
    res.writeHead(200, {
      'content-type': isBundle
        ? 'text/javascript; charset=utf-8'
        : 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('ceremony: no port');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    url: `${origin}/ceremony.html`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
