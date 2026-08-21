import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** The provider is declared in the manifest as a MAIN-world content script (CSP-immune). */
function injectedPathFromManifest(): string {
  const manifest = readFileSync(join(ROOT, 'src/manifest.config.ts'), 'utf8');
  const entry = manifest.match(/\{[^{}]*js:\s*\[\s*'([^']+)'\s*\][^{}]*world:\s*'MAIN'[^{}]*\}/);
  if (!entry) throw new Error('manifest has no MAIN-world content script for the provider');
  const content = readFileSync(join(ROOT, 'src/content/index.ts'), 'utf8');
  if (/chrome\.runtime\.getURL|createElement\(\s*['"]script['"]\s*\)/.test(content)) {
    throw new Error('content relay must not inject the provider via the DOM (page CSP would block it)');
  }
  return entry[1]!;
}

function runInjected(code: string): { btq: { isBtq?: boolean; request?: unknown } } {
  const fakeWindow: {
    btq?: { isBtq?: boolean; request?: unknown };
    location: { origin: string };
    addEventListener: () => void;
    postMessage: () => void;
  } = {
    location: { origin: 'https://dapp.example' },
    addEventListener() {},
    postMessage() {},
  };
  // The shipped file is a classic IIFE that reads `window` from its argument list.
  const run = new Function('window', `${code}\nreturn window.btq;`);
  const btq = run(fakeWindow) as { isBtq?: boolean; request?: unknown };
  return { btq };
}

describe('inpage inject — the exact file Chrome loads as a classic script', () => {
  it('installs window.btq.request from the injected IIFE (not TypeScript)', () => {
    const rel = injectedPathFromManifest();
    expect(rel.endsWith('.js')).toBe(true);
    expect(rel.endsWith('.ts')).toBe(false);

    const srcFile = join(ROOT, rel);
    expect(existsSync(srcFile)).toBe(true);
    const code = readFileSync(srcFile, 'utf8');
    expect(code).not.toMatch(/\bexport\s*\{/);
    expect(code).not.toMatch(/\bdeclare\s+global\b/);
    expect(code).not.toMatch(/^\s*type\s+\w+\s*=/m);

    const { btq } = runInjected(code);
    expect(btq).toBeTruthy();
    expect(btq.isBtq).toBe(true);
    expect(typeof btq.request).toBe('function');

    // The built chunk must stand alone in the MAIN world: no chrome.* calls, no imports.
    const distManifestFile = join(ROOT, 'dist', 'manifest.json');
    if (existsSync(distManifestFile)) {
      const distManifest = JSON.parse(readFileSync(distManifestFile, 'utf8')) as {
        content_scripts: { js: string[]; world?: string }[];
      };
      const main = distManifest.content_scripts.find((c) => c.world === 'MAIN');
      expect(main, 'dist manifest keeps the MAIN-world provider').toBeTruthy();
      const distCode = readFileSync(join(ROOT, 'dist', main!.js[0]!), 'utf8');
      expect(distCode).not.toMatch(/\bchrome\./);
      expect(distCode).not.toMatch(/\bimport\s*\(/);
      const fromDist = runInjected(distCode);
      expect(typeof fromDist.btq.request).toBe('function');
      expect(fromDist.btq.isBtq).toBe(true);
    }
  });
});
