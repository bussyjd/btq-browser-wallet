/**
 * The demo dapp, served on its own from 127.0.0.1.
 *
 * The mocked suite gets this page out of `mock-explorer.ts`, which also serves
 * a whole explorer API and a JSON-RPC node — none of which a live recording
 * wants anywhere near it. This is the page and nothing else, so the only
 * server in a live run is the one holding the HTML.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'dapp.html'), 'utf8');

export interface StaticDapp {
  /** http://127.0.0.1:PORT — the origin the wallet will be asked to approve. */
  origin: string;
  url: string;
  close(): Promise<void>;
}

export async function startStaticDapp(): Promise<StaticDapp> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(HTML),
      'cache-control': 'no-store',
    });
    res.end(HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('static dapp: no port');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    url: `${origin}/dapp.html`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
