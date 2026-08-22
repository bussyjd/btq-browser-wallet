import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|js|css|html)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Comments explain the boundary — they must not be mistaken for crossing it.
 * A doc comment naming `chrome.windows.create`, or "no Node Buffer here", is
 * prose; only code counts. Strips block comments, whole-line `//` comments and
 * trailing `//` comments (skipping `://` so URLs in strings survive).
 */
export function stripComments(src: string): string {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return noBlocks
    .split('\n')
    .map((line) => {
      if (line.trimStart().startsWith('//')) return '';
      for (let i = line.indexOf('//'); i !== -1; i = line.indexOf('//', i + 1)) {
        const before = i === 0 ? '' : line[i - 1];
        if (before === ':' || before === '/' || before === '\\') continue;
        return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

describe('trust boundary in source', () => {
  it('src/core does not import chrome, fetch, or node builtins', () => {
    const files = walk(join(ROOT, 'src/core'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'));
      expect(src, relative(ROOT, f)).not.toMatch(/\bchrome\./);
      expect(src, relative(ROOT, f)).not.toMatch(/\bfetch\s*\(/);
      expect(src, relative(ROOT, f)).not.toMatch(/from ['"]node:/);
      expect(src, relative(ROOT, f)).not.toMatch(/\bBuffer\.from\b|\bnew Buffer\b|from ['"]buffer['"]/);
    }
  });

  it('the comment stripper keeps code and drops prose', () => {
    // If this ever stopped stripping, the boundary check above would pass on
    // prose; if it stripped too much, it would pass on real violations.
    expect(stripComments("const a = 1; // chrome.runtime.id")).not.toMatch(/chrome\./);
    expect(stripComments('/** talks to chrome.storage */\nconst a = 1;')).not.toMatch(/chrome\./);
    expect(stripComments('chrome.runtime.sendMessage({});')).toMatch(/\bchrome\./);
    expect(stripComments("const u = 'http://x'; // note")).toMatch(/http:\/\/x/);
  });

  it('background rejects page senders with exact origin matching', () => {
    const src = readFileSync(join(ROOT, 'src/background/index.ts'), 'utf8');
    expect(src).toMatch(/isUntrustedSender/);
    expect(src).not.toMatch(/sender\.origin\s*\.(includes|startsWith)/);
    expect(src).not.toMatch(/sender\.url\s*\.(includes|startsWith)/);
  });

  it('UI never imports the keyring, vault, or HD seed helpers', () => {
    const ui = join(ROOT, 'src/ui');
    if (!existsSync(ui)) return;
    const files = walk(ui);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, relative(ROOT, f)).not.toMatch(/wallet\/keyring\.js/);
      expect(src, relative(ROOT, f)).not.toMatch(/vault\/encrypt/);
      expect(src, relative(ROOT, f)).not.toMatch(/mnemonicToHdSeed/);
      expect(src, relative(ROOT, f)).not.toMatch(/deriveKeySeed/);
      expect(src, relative(ROOT, f)).not.toMatch(/encryptVault/);
    }
  });

  it('page provider and content relay never import vault/keyring/HD-seed helpers', () => {
    for (const dir of ['src/content', 'src/inpage']) {
      const p = join(ROOT, dir);
      if (!existsSync(p)) continue;
      for (const f of walk(p)) {
        const src = readFileSync(f, 'utf8');
        expect(src, relative(ROOT, f)).not.toMatch(/wallet\/keyring/);
        expect(src, relative(ROOT, f)).not.toMatch(/vault\/encrypt/);
        expect(src, relative(ROOT, f)).not.toMatch(/mnemonicToHdSeed/);
        expect(src, relative(ROOT, f)).not.toMatch(/deriveKeySeed/);
        expect(src, relative(ROOT, f)).not.toMatch(/encryptVault/);
        expect(src, relative(ROOT, f)).not.toMatch(/ml_dsa44/);
      }
    }
  });
});
