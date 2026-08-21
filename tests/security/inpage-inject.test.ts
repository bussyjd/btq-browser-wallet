import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

function injectedPathFromContentScript(): string {
  const content = readFileSync(join(ROOT, 'src/content/index.ts'), 'utf8');
  const match = content.match(/chrome\.runtime\.getURL\(\s*['"]([^'"]+)['"]\s*\)/);
  if (!match) throw new Error('content script does not call chrome.runtime.getURL');
  return match[1]!;
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
    const rel = injectedPathFromContentScript();
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

    const distFile = join(ROOT, 'dist', rel);
    if (existsSync(distFile)) {
      const distCode = readFileSync(distFile, 'utf8');
      const fromDist = runInjected(distCode);
      expect(typeof fromDist.btq.request).toBe('function');
      expect(fromDist.btq.isBtq).toBe(true);
    }
  });
});
